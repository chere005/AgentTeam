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

// Team settings (src/team-settings.ts, ui/components/TeamSettings.tsx), the project lifecycle
// with its detach offer (src/project-lifecycle.ts, ui/components/ProjectLifecycle.tsx) and the
// free-form task editor (instructions, assignee, dependencies). Temp AGENTTEAM_DATA_DIR,
// AGENTTEAM_TEST=1: no runtime scan, no provider is ever invoked.

const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );

async function launch(directory: string) {
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 950 }).catch(() => {});
  await expect(
    page.getByText("Workspace connected", { exact: true }),
  ).toBeVisible();
  return { app, page };
}

test("team settings: profile view, worker count change places new agents in the org tree, rename, model check", async () => {
  test.setTimeout(90_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-ts-")),
  );
  const shots = join("test-results", "team-settings");
  await mkdir(shots, { recursive: true });
  const { app, page } = await launch(directory);
  try {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const inserted = await api(
      page,
      "POST",
      "/teams/examples/pipeline-review-team/insert",
      {
        options: { implementationWorkers: 2, fixWorkers: 1 },
        acceptUnverifiedModels: true,
      },
    );
    const teamName = "Plan → implement → review pipeline team";
    await expect(page.getByTestId("active-team-name")).toHaveText(teamName);
    // From the team switcher menu
    await page.getByTestId("team-switcher").click();
    await page
      .getByRole("button", { name: `Team settings of ${teamName}` })
      .click();
    const view = page.getByTestId("team-settings");
    await expect(view.getByTestId("team-settings-type")).toHaveText(
      "Pipeline team",
    );
    await expect(view).toContainText("Pipeline Planner (Opus 5.5)");
    const roles = view.getByRole("region", { name: "Roles and workers" });
    await expect(roles).toContainText("Implementation Worker 2 (Sonnet 5.5)");
    await expect(
      view.getByRole("region", { name: "Workspace access defaults" }),
    ).toContainText("Can read and edit");
    await expect(
      view.getByRole("region", { name: "Model expectations" }),
    ).toContainText("expects Opus 5.5");
    const count = roles.getByLabel("Implementation workers count");
    await expect(count).toHaveValue("2");
    await count.selectOption("3");
    await roles.getByRole("button", { name: "Apply worker counts" }).click();
    await expect(view.getByRole("status")).toContainText("added 1");
    await expect(roles).toContainText("Implementation Worker 3 (Sonnet 5.5)");
    await page.screenshot({ path: join(shots, "team-settings.png") });
    const snap = await api(page, "GET", "/snapshot");
    const integrator = snap.agents.find(
      (a: { name: string }) => a.name === "Pipeline Integrator (Sonnet 5.5)",
    );
    const added = snap.agents.find(
      (a: { name: string }) =>
        a.name === "Implementation Worker 3 (Sonnet 5.5)",
    );
    expect(added.parentId).toBe(integrator.id);
    expect(added.teamId).toBe(inserted.teamId);
    // The canvas arranges the new agent into the org tree (below the integrator)
    await openFeature(page, "Canvas");
    const card = page.locator(`.react-flow__node[data-id="${added.id}"]`);
    await expect(card).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("agentteam.arrangeRequest")),
      )
      .toBeNull();
    await page.waitForTimeout(500);
    const parentBox = await page
      .locator(`.react-flow__node[data-id="${integrator.id}"]`)
      .boundingBox();
    const childBox = await card.boundingBox();
    expect(parentBox!.y + parentBox!.height).toBeLessThanOrEqual(
      childBox!.y + 2,
    );
    await page.screenshot({ path: join(shots, "canvas-after-workers.png") });
    // From the command palette; rename + description; model check
    await openFeature(page, "Team settings");
    await view.getByLabel("Team name").fill("Review pipeline");
    await view.getByLabel("Team description").fill("Our staged review team");
    await view
      .getByRole("button", { name: "Save name and description" })
      .click();
    await expect(page.getByTestId("active-team-name")).toHaveText(
      "Review pipeline",
    );
    await view.getByRole("button", { name: "Re-run model check" }).click();
    await expect(view.getByTestId("team-model-check")).toContainText(
      "Model check did not pass",
    );
    // A refused removal (a project uses the workers) is explained and changes nothing
    await api(page, "POST", `/team-spaces/${inserted.teamId}/projects`, {
      goal: "A paused project on all three workers",
      workspace: directory,
      isolation: "worktree",
    });
    await count.selectOption("1");
    await roles.getByRole("button", { name: "Apply worker counts" }).click();
    await expect(view.getByRole("alert")).toContainText("unfinished task");
    await expect(roles).toContainText("Implementation Worker 3 (Sonnet 5.5)");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("free-form project with per-task instructions and dependencies; archive hides it and offers to detach its folders", async () => {
  test.setTimeout(90_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-pl-")),
  );
  const workspace = join(directory, "product");
  await mkdir(workspace);
  const shots = join("test-results", "team-settings");
  await mkdir(shots, { recursive: true });
  const { app, page } = await launch(directory);
  try {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const inserted = await api(
      page,
      "POST",
      "/teams/examples/product-feature-team/insert",
      { options: {}, acceptUnverifiedModels: true },
    );
    await expect(page.getByTestId("active-team-name")).toHaveText(
      "Product feature team",
    );
    await page
      .getByRole("button", { name: "Assign project", exact: true })
      .first()
      .click();
    const form = page.getByRole("form", { name: "Assign project" });
    await form.getByLabel("Project goal").fill("Add CSV export to reports");
    await form.getByLabel("Project workspace").fill(workspace);
    await form.getByRole("button", { name: "Add task" }).click();
    await form.getByRole("button", { name: "Add task" }).click();
    await form.getByLabel("Task 1 title").fill("Export API");
    await form
      .getByLabel("Task 1 agent")
      .selectOption({ label: "Backend Engineer" });
    await form
      .getByLabel("Task 1 instructions")
      .fill("Add GET /reports.csv with streaming output");
    await form.getByLabel("Task 2 title").fill("Export button");
    await form
      .getByLabel("Task 2 agent")
      .selectOption({ label: "Frontend Engineer" });
    await form.getByLabel(/Run tasks in order/).uncheck();
    // a cycle is refused by the backend and explained
    await form.getByLabel("Task 1 waits for task 2").check();
    await form.getByLabel("Task 2 waits for task 1").check();
    await form.getByRole("button", { name: "Create paused project" }).click();
    await expect(form.getByRole("alert")).toContainText("cycle");
    await form.getByLabel("Task 1 waits for task 2").uncheck();
    await page.screenshot({ path: join(shots, "free-form-tasks.png") });
    await form.getByRole("button", { name: "Create paused project" }).click();
    await expect(form).toHaveCount(0);
    const snap = await api(page, "GET", "/snapshot");
    const wf = snap.workflows.find(
      (w: { teamId?: string }) => w.teamId === inserted.teamId,
    );
    const t1 = wf.tasks.find(
      (t: { title: string }) => t.title === "Export API",
    );
    const t2 = wf.tasks.find(
      (t: { title: string }) => t.title === "Export button",
    );
    expect(t1.instructions).toBe("Add GET /reports.csv with streaming output");
    expect(t1.dependsOn).toEqual([]);
    expect(t2.dependsOn).toEqual([t1.id]);
    const frontend = snap.agents.find(
      (a: { name: string }) => a.name === "Frontend Engineer",
    );
    expect(t2.agentId).toBe(frontend.id);
    expect(frontend.workspaces.map((w: { path: string }) => w.path)).toContain(
      workspace,
    );

    // Archive: hidden by default, "Show archived" brings it back with the detach offer
    const card = page.locator(".workflow", { hasText: "Add CSV export" });
    await card.getByRole("button", { name: "Archive" }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel(/Show archived \(1\)/).check();
    await expect(card.getByTestId("project-state")).toHaveText("Archived");
    const offer = card.getByRole("region", { name: "Detach project folders" });
    await expect(offer).toContainText("This project has ended");
    await expect(offer).toContainText("Frontend Engineer");
    await page.screenshot({ path: join(shots, "detach-offer.png") });
    await offer.getByRole("button", { name: "Detach folders" }).click();
    await expect(offer).toHaveCount(0);
    const after = await api(page, "GET", "/snapshot");
    const fe = after.agents.find(
      (a: { name: string }) => a.name === "Frontend Engineer",
    );
    expect(fe.workspaces.map((w: { path: string }) => w.path)).not.toContain(
      workspace,
    );
    // Reopen: active again (still paused) and its folders are re-attached
    await card.getByRole("button", { name: "Reopen" }).click();
    await expect(card.getByTestId("project-state")).toHaveCount(0);
    const reopened = await api(page, "GET", "/snapshot");
    expect(
      reopened.agents
        .find((a: { name: string }) => a.name === "Frontend Engineer")
        .workspaces.map((w: { path: string }) => w.path),
    ).toContain(workspace);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
