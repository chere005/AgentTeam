import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// Example TEAMS in the Saved teams library (src/example-teams.ts), inserted as teams only, then
// auto-arranged as a top-down org chart (ui/org-layout.ts); a project is assigned afterwards.
// Temp AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1: no runtime scan, no provider is ever invoked.

type Box = { x: number; y: number; width: number; height: number };
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );

/** Card boxes on screen for the given agents (same zoom for all, so comparable). */
async function boxes(page: Page, ids: string[]) {
  const out: Record<string, Box> = {};
  for (const id of ids) {
    const b = await page
      .locator(`.react-flow__node[data-id="${id}"]`)
      .boundingBox();
    expect(b, `card for ${id}`).not.toBeNull();
    out[id] = b!;
  }
  return out;
}

/**
 * Org-chart invariants: parents above children, siblings on one row (or, for leaf reports of a
 * team too wide for the canvas, lines of the compact layout), centered, no overlaps.
 */
function assertOrgChart(
  agents: { id: string; name: string; parentId: string | null }[],
  b: Record<string, Box>,
) {
  const ids = agents.map((a) => a.id);
  const tol = 2;
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const p = b[ids[i]],
        q = b[ids[j]];
      const overlaps =
        p.x < q.x + q.width - tol &&
        q.x < p.x + p.width - tol &&
        p.y < q.y + q.height - tol &&
        q.y < p.y + p.height - tol;
      expect(overlaps, `${agents[i].name} overlaps ${agents[j].name}`).toBe(
        false,
      );
    }
  const cx = (id: string) => b[id].x + b[id].width / 2;
  for (const parent of agents) {
    const kids = agents.filter((a) => a.parentId === parent.id);
    if (!kids.length) continue;
    for (const k of kids)
      expect(
        b[parent.id].y + b[parent.id].height,
        `${parent.name} above ${k.name}`,
      ).toBeLessThanOrEqual(b[k.id].y + tol);
    // Siblings share one row, or (compact layout for a wide team of leaf reports, deliberately:
    // ui/org-layout.ts `wrap`) several lines; the parent is centered over the first line.
    const ys = kids.map((k) => b[k.id].y);
    const top = Math.min(...ys);
    const leaves = kids.every((k) => !agents.some((a) => a.parentId === k.id));
    if (!leaves || new Set(ys).size === 1)
      expect(Math.max(...ys) - top, `${parent.name}'s row`).toBe(0);
    const first = kids.filter((k) => b[k.id].y === top);
    const centers = first.map((k) => cx(k.id));
    const mid = (Math.min(...centers) + Math.max(...centers)) / 2;
    expect(
      Math.abs(cx(parent.id) - mid),
      `${parent.name} centered over its reports`,
    ).toBeLessThanOrEqual(tol);
  }
}

async function teamAgents(page: Page) {
  const snap = await api(page, "GET", "/snapshot");
  return (
    snap.agents as {
      id: string;
      name: string;
      teamId?: string | null;
      kind: string;
      parentId: string | null;
    }[]
  ).filter(
    (a) => a.teamId === snap.activeTeamId && a.kind !== "team-assistant",
  );
}

/** Waits until every agent has a stored (arranged) position and the fit animation settled. */
async function arranged(page: Page, ids: string[]) {
  await expect
    .poll(async () =>
      page.evaluate((list) => {
        const p = JSON.parse(
          localStorage.getItem("agentteam.positions") ?? "{}",
        );
        return list.every((id) => p[id]);
      }, ids),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("agentteam.arrangeRequest")),
    )
    .toBeNull();
  await page.waitForTimeout(500);
}

test("example teams: listed with shape and org preview, inserted as teams (no project), arranged as an org chart; then a project is assigned", async () => {
  test.setTimeout(120_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-examples-")),
  );
  const workspace = join(directory, "product");
  await mkdir(workspace);
  const shots = join("test-results", "example-teams");
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1500, height: 950 }).catch(() => {});
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const openLibrary = () => openFeature(page, "Team library");
    await openLibrary();
    const list = page.getByRole("list", { name: "Example teams" });
    await expect(list.getByRole("button")).toHaveCount(3);
    await expect(list.getByTestId("example-shape")).toHaveCount(3);
    await expect(list).toContainText("Plan → implement → review pipeline team");
    await expect(list).toContainText("Wolfram-validated reasoning team");
    await expect(list).toContainText("Product feature team");
    await expect(list).toContainText("Engineering Manager →");

    const examples = [
      {
        name: "Product feature team",
        file: "product",
        agents: 7,
        configure: async () => {},
      },
      {
        name: "Plan → implement → review pipeline team",
        file: "pipeline",
        agents: 1 + 1 + 3 + 2 + 4 + 1 + 1,
        configure: async (dialog: ReturnType<Page["getByRole"]>) => {
          await dialog.getByLabel("Implementation workers").selectOption("3");
          await dialog.getByLabel("Fix workers").selectOption("2");
          await expect(
            dialog.getByLabel("Implementation workers").locator("option"),
          ).toHaveCount(5);
        },
      },
      {
        name: "Wolfram-validated reasoning team",
        file: "wolfram",
        agents: 3,
        configure: async () => {},
      },
    ];
    for (const ex of examples) {
      await openLibrary();
      await list.getByRole("button", { name: new RegExp(ex.name) }).click();
      const preview = page.getByTestId("org-tree-preview").first();
      await expect(preview).toBeVisible();
      await expect(page.getByTestId("example-projects")).toContainText(
        "Takes projects",
      );
      if (ex.file === "product")
        await page.screenshot({ path: join(shots, "library-product.png") });
      await page.getByRole("button", { name: "Insert…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /Insert “/ });
      await ex.configure(dialog);
      // No runtimes are discovered in test mode: insertion needs the explicit opt-in.
      await expect(dialog.getByTestId("example-model-check")).toContainText(
        "Not verified",
      );
      const insert = dialog.getByRole("button", {
        name: "Insert as new team",
        exact: true,
      });
      await expect(insert).toBeDisabled();
      if (ex.file === "pipeline")
        await page.screenshot({ path: join(shots, "insert-pipeline.png") });
      await dialog.getByLabel("Insert with unverified models").check();
      await insert.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByTestId("active-team-name")).toHaveText(ex.name);
      // A team, not a project: agents only.
      const agents = await teamAgents(page);
      expect(agents).toHaveLength(ex.agents);
      const snap = await api(page, "GET", "/snapshot");
      expect(
        snap.workflows.filter(
          (w: { teamId?: string }) => w.teamId === snap.activeTeamId,
        ),
      ).toHaveLength(0);
      await arranged(
        page,
        agents.map((a) => a.id),
      );
      assertOrgChart(
        agents,
        await boxes(
          page,
          agents.map((a) => a.id),
        ),
      );
      await page.screenshot({ path: join(shots, `canvas-${ex.file}.png`) });
    }

    // Detailed cards are taller: Arrange measures them and keeps the invariants. The Wolfram team
    // (active now) is small enough to stay at full zoom, so the detailed cards themselves render.
    const wolframAgents = await teamAgents(page);
    const compactHeights = Object.values(
      await boxes(
        page,
        wolframAgents.map((a) => a.id),
      ),
    ).map((x) => Math.round(x.height));
    await page.getByRole("button", { name: "Detailed cards" }).click();
    await page.getByRole("button", { name: "Arrange", exact: true }).click();
    await page.waitForTimeout(700);
    const detailed = await boxes(
      page,
      wolframAgents.map((a) => a.id),
    );
    console.log(
      "card heights on screen: compact",
      compactHeights,
      "detailed",
      Object.values(detailed).map((x) => Math.round(x.height)),
      "zoom",
      await page
        .locator(".react-flow__viewport")
        .evaluate((el) => (el as HTMLElement).style.transform),
    );
    assertOrgChart(wolframAgents, detailed);
    await page.screenshot({ path: join(shots, "canvas-wolfram-detailed.png") });
    await page.getByRole("button", { name: "Simple cards" }).click();

    // Assign a project to the product team from the team menu.
    await page.getByTestId("team-switcher").click();
    await page
      .getByRole("group", { name: "Teams" })
      .getByRole("button", { name: /^Product feature team:/ })
      .click();
    await page.getByTestId("team-switcher").click();
    await page
      .getByRole("button", { name: "Assign a project to Product feature team" })
      .click();
    const form = page.getByRole("form", { name: "Assign project" });
    await expect(form.getByTestId("assign-project-type")).toContainText(
      "existing 7 agents",
    );
    await form
      .getByLabel("Project goal")
      .fill("Add a dark mode toggle to the settings page");
    await form.getByLabel("Project workspace").fill(workspace);
    await form.getByRole("button", { name: "Add task" }).click();
    await form.getByLabel("Task 1 title").fill("Toggle UI");
    await form
      .getByLabel("Task 1 agent")
      .selectOption({ label: "Frontend Engineer" });
    await form.getByRole("button", { name: "Create paused project" }).click();
    await expect(form).toHaveCount(0);
    const project = page.locator(".workflow").first();
    await expect(project).toContainText("Add a dark mode toggle");
    await expect(project.locator(".badge").first()).toHaveText("paused");
    await expect(project.getByLabel("Model mapping")).toContainText(
      "not verified",
    );
    await page.screenshot({ path: join(shots, "projects-product.png") });
    // A second project for the same team: the team persists, projects accumulate.
    await page
      .getByRole("button", { name: "Assign project", exact: true })
      .first()
      .click();
    await form
      .getByLabel("Project goal")
      .fill("Add CSV export to the reports page");
    await form.getByLabel("Project workspace").fill(workspace);
    await form.getByRole("button", { name: "Create paused project" }).click();
    await expect(page.locator(".workflow")).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
