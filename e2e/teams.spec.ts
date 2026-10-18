import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// Active-team switcher (src/team-spaces.ts, ui/team-view.ts). Temp AGENTTEAM_DATA_DIR, fixture
// data through the API, no provider is ever invoked (AGENTTEAM_TEST=1, execution stays off).
async function launch(directory: string) {
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(
    page.getByText("Workspace connected", { exact: true }),
  ).toBeVisible();
  return { app, page, errors };
}
async function withApp(
  fn: (ctx: { start: () => ReturnType<typeof launch> }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-teams-"));
  const apps: ElectronApplication[] = [];
  try {
    await fn({
      start: async () => {
        const ctx = await launch(directory);
        apps.push(ctx.app);
        return ctx;
      },
    });
  } finally {
    for (const a of apps) await a.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );
const switcher = (page: Page) => page.getByTestId("team-switcher");
const activeName = (page: Page) => page.getByTestId("active-team-name");
// The team's agents on the canvas (Canvas tab), without the global Team Assistant.
const agentList = (page: Page) => ({
  getByRole: (_role: "button") =>
    page
      .locator(".canvas .react-flow__node-agent")
      .filter({ hasNotText: "Team coordinator" }),
});

test("team switcher: names the active team, filters canvas, conversations and workflows, persists across relaunch", async () => {
  await withApp(async ({ start }) => {
    let { page, app, errors } = await start();
    await expect(switcher(page)).toBeVisible();
    await expect(activeName(page)).toHaveText("Main team");
    await expect(switcher(page)).toHaveAccessibleName(
      /Active team: Main team, idle/,
    );
    const alpha = await api(page, "POST", "/agents", {
      name: "Alpha",
      environment: "codex",
    });
    await api(page, "POST", "/workflows", {
      name: "Main workflow",
      goal: "G",
      ownerId: alpha.id,
      completionCriteria: "D",
    });
    await expect(agentList(page).getByRole("button")).toHaveText([/Alpha/]);

    // New team from the switcher: it becomes active, starts empty, with a visible notice.
    await switcher(page).click();
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team name").fill("Research");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(activeName(page)).toHaveText("Research");
    await expect(page.getByTestId("team-notice")).toContainText("Research");
    await expect(page.getByTestId("canvas-empty")).toContainText(
      "No agents in Research",
    );
    await expect(agentList(page).getByRole("button")).toHaveCount(0);

    // A new agent from the editor joins the active team.
    const teams = await api(page, "GET", "/team-spaces");
    const research = teams.teams.find((t: any) => t.name === "Research").id;
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Beta");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(agentList(page).getByRole("button")).toHaveText([/Beta/]);
    const snap = await api(page, "GET", "/snapshot");
    const beta = snap.agents.find((a: any) => a.name === "Beta");
    expect(beta.teamId).toBe(research);
    await api(page, "POST", "/workflows", {
      name: "Research workflow",
      goal: "G",
      ownerId: beta.id,
      completionCriteria: "D",
    });
    // Canvas shows only this team's agent.
    const canvas = page.locator(".canvas");
    await expect(canvas.locator(".agent-card")).toHaveCount(2); // + Team Assistant
    await expect(canvas).toContainText("Beta");
    await expect(canvas).not.toContainText("Alpha");
    // Workflows: only this team's.
    await openFeature(page, "Projects");
    await expect(page.locator(".workflow")).toHaveCount(1);
    await expect(page.locator(".workflow")).toContainText("Research workflow");
    // Conversation agent picker: only this team's agents.
    await page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("tab", { name: "Chat" })
      .click();
    await expect(
      page
        .locator(".right-pane")
        .getByRole("combobox", { name: "Agent", exact: true })
        .locator("option"),
    ).toHaveText(["Team Assistant", "Beta"]);

    // Keyboard: open with Enter, arrow to Main, Enter switches; Escape returns focus.
    await switcher(page).focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("group", { name: "Teams" });
    await expect(menu).toBeVisible();
    await expect(
      menu.getByRole("button", { name: /Research.*\(active\)/ }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(switcher(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      menu.getByRole("button", { name: /Research.*\(active\)/ }),
    ).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(
      menu.getByRole("button", { name: /^Main team: 1 agent/ }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(activeName(page)).toHaveText("Main team");
    // Open tabs are per team: Main never opened Projects, so it shows only the canvas.
    await expect(page.getByRole("tab", { name: "Projects" })).toHaveCount(0);
    await expect(agentList(page).getByRole("button")).toHaveText([/Alpha/]);
    await openFeature(page, "Projects");
    await expect(page.locator(".workflow")).toHaveCount(1);
    await expect(page.locator(".workflow")).toContainText("Main workflow");

    // Switch back to Research and relaunch on the same data directory: it is still active.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+T" : "Control+Shift+T",
    );
    await page
      .getByRole("group", { name: "Teams" })
      .getByRole("button", { name: /^Research:/ })
      .click();
    await expect(activeName(page)).toHaveText("Research");
    expect(errors).toEqual([]);
    await app.close();
    ({ page, app, errors } = await start());
    await expect(activeName(page)).toHaveText("Research");
    // Research's Projects tab survived the relaunch; the canvas is one tab away.
    await expect(page.getByRole("tab", { name: "Projects" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openFeature(page, "Canvas");
    await expect(agentList(page).getByRole("button")).toHaveText([/Beta/]);
    expect(errors).toEqual([]);
  });
});

test("example teams create their own team; other teams' running work and inbox items stay visible and switch the team", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    const alpha = await api(page, "POST", "/agents", {
      name: "Alpha",
      environment: "codex",
    });
    const wf = await api(page, "POST", "/workflows", {
      name: "Main work",
      goal: "G",
      ownerId: alpha.id,
      completionCriteria: "D",
    });
    const failing = await api(page, "POST", "/tasks", {
      workflowId: wf.id,
      agentId: alpha.id,
      title: "Main task that fails",
      completionCriteria: "D",
    });
    // An example team from the library becomes its own (active) team with a notice. It is a team
    // only: no project until one is assigned.
    await openFeature(page, "Team library");
    await page
      .getByRole("list", { name: "Example teams" })
      .getByRole("button", { name: /Wolfram-validated reasoning team/ })
      .click();
    await page.getByRole("button", { name: "Insert…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /Insert “/ });
    await dialog.getByLabel("Insert with unverified models").check();
    await dialog
      .getByRole("button", { name: "Insert as new team", exact: true })
      .click();
    await expect(activeName(page)).toHaveText(
      "Wolfram-validated reasoning team",
    );
    await expect(page.getByTestId("team-notice")).toContainText(
      "Wolfram-validated reasoning",
    );
    await openFeature(page, "Projects");
    await expect(page.locator(".workflow")).toHaveCount(0);
    await expect(
      page.getByText(/^No projects in Wolfram-validated/),
    ).toBeVisible();
    await openFeature(page, "Canvas");
    await expect(agentList(page).getByRole("button")).toHaveCount(3);

    // Work runs in the Main team while the sample team is shown: the switcher says so.
    await expect(page.getByTestId("other-teams-indicator")).toHaveCount(0);
    await api(page, "POST", `/tasks/${failing.id}/status`, {
      status: "running",
    });
    await expect(page.getByTestId("other-teams-indicator")).toContainText(
      "+1 elsewhere",
    );
    await expect(switcher(page)).toHaveAccessibleName(/Other teams: 1 running/);
    await switcher(page).click();
    await expect(
      page
        .getByRole("group", { name: "Teams" })
        .getByRole("button", { name: /^Main team: .*1 running/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // A failed task in Main appears under "Other teams" in the inbox; opening it switches.
    await api(page, "POST", `/tasks/${failing.id}/status`, {
      status: "failed",
      result: "broke",
    });
    await page.getByRole("button", { name: /^Attention inbox, / }).click();
    const inbox = page.getByRole("region", { name: "Attention inbox" });
    await expect(
      inbox
        .getByTestId("inbox-item")
        .filter({ hasText: "Main task that fails" }),
    ).toHaveCount(0);
    const other = inbox.getByTestId("inbox-other-item").filter({
      hasText: "Main task that fails",
    });
    await expect(other).toContainText("Main team");
    await other
      .getByRole("button", { name: /^Switch to Main team and open/ })
      .click();
    await expect(activeName(page)).toHaveText("Main team");
    await expect(page.getByTestId("team-notice")).toContainText(
      "to show: Main task that fails failed",
    );
    // The item's target (Projects) opened in the Main team; the inbox is one tab away.
    await expect(
      page.getByRole("tab", { name: "Projects", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await openFeature(page, "Inbox");
    await expect(
      inbox.getByTestId("inbox-item").filter({
        hasText: "Main task that fails",
      }),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test("cross-team links, team delete moves agents to Main, and screenshots of the switcher", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    const alpha = await api(page, "POST", "/agents", {
      name: "Alpha",
      environment: "codex",
    });
    const ops = await api(page, "POST", "/team-spaces", {
      name: "Operations",
    });
    const gamma = await api(page, "POST", "/agents", {
      name: "Gamma",
      environment: "claude",
      teamId: ops.id,
    });
    await api(page, "POST", "/agents", {
      name: "Delta",
      environment: "wolfram",
      teamId: ops.id,
    });
    // Without the explicit flag a cross-team edge is refused by the backend.
    const refused = await page.evaluate(
      async ([from, to]) => {
        try {
          await window.agentteam.request("POST", "/edges", {
            from,
            to,
            kind: "delegate",
          });
          return "created";
        } catch (e) {
          return String(e);
        }
      },
      [alpha.id, gamma.id],
    );
    expect(refused).toContain("different teams");
    // Created explicitly from the canvas context menu.
    const alphaCard = page.locator(".react-flow__node", { hasText: "Alpha" });
    await alphaCard.click({ button: "right" });
    await page
      .getByRole("button", { name: "Link to an agent in another team…" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Connection settings" });
    await expect(dialog.getByTestId("cross-team-note")).toBeVisible();
    await dialog
      .getByLabel("Agent in another team")
      .selectOption({ label: "Gamma (Operations)" });
    await dialog
      .getByRole("button", { name: "Create cross-team link" })
      .click();
    await expect(page.getByTestId("cross-team-links")).toContainText(
      "Alpha → Gamma (Operations)",
    );
    const edges = await api(page, "GET", "/edges");
    expect(edges).toHaveLength(1);
    expect(edges[0].crossTeam).toBe(true);

    // Switch to Operations; screenshot the open switcher and the filtered canvas.
    await switcher(page).click();
    await page
      .getByRole("group", { name: "Teams" })
      .getByRole("button", { name: /^Operations:/ })
      .click();
    await expect(activeName(page)).toHaveText("Operations");
    await expect(page.locator(".canvas .agent-card")).toHaveCount(3); // + Team Assistant
    await expect(page.getByTestId("cross-team-links")).toContainText(
      "Alpha → Gamma (Main team)",
    );
    await page.waitForTimeout(400);
    await page.screenshot({
      path: test.info().outputPath("filtered-canvas.png"),
    });
    await switcher(page).click();
    await expect(page.getByRole("group", { name: "Teams" })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("team-switcher-open.png"),
    });

    // Delete Operations: agents move to Main by default; Main cannot be deleted.
    await page.getByRole("button", { name: "Delete Operations" }).click();
    const form = page.getByRole("form", { name: "Delete Operations" });
    await expect(form.getByLabel("Move them (recommended)")).toBeChecked();
    await form.getByRole("button", { name: "Delete team" }).click();
    await expect(activeName(page)).toHaveText("Main team");
    await expect(page.getByTestId("team-notice")).toContainText(
      "Deleted team “Operations”",
    );
    await expect(agentList(page).getByRole("button")).toHaveCount(3);
    await expect(page.getByTestId("cross-team-links")).toHaveCount(0);
    await switcher(page).click();
    await expect(
      page.getByRole("button", { name: "Delete Main team" }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  });
});
