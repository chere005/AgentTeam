import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";
import { FEATURES, FEATURE_GROUPS } from "../ui/features";

// Progressive-disclosure navigation (docs/ui-design.md). Temp AGENTTEAM_DATA_DIR, fixture data
// through the API, AGENTTEAM_TEST=1; no provider is ever invoked and no real dialog/editor opens.
async function launch(directory: string) {
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("workspace-ready")).toBeVisible();
  return { app, page, errors };
}
async function withApp(
  fn: (ctx: {
    directory: string;
    start: () => ReturnType<typeof launch>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-nav-"));
  const apps: ElectronApplication[] = [];
  try {
    await fn({
      directory,
      start: async () => {
        const ctx = await launch(join(directory, "data"));
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
const tab = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "Main views and open features" })
    .getByRole("tab", { name, exact: true });

test("first run shows four main views, a useful empty state and a slim top bar", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await expect(page.getByRole("navigation", { name: "Panes" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("tablist", { name: "Main views and open features" }),
    ).toBeVisible();
    await expect(tab(page, "Layout")).toBeVisible();
    await expect(tab(page, "Chat")).toBeVisible();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Diff")).toBeVisible();
    const empty = page.getByTestId("canvas-empty");
    await expect(empty).toContainText("No agents in Main team yet");
    await expect(
      empty.getByRole("button", { name: "Add an agent" }),
    ).toBeVisible();
    await expect(
      empty.getByRole("button", { name: "Insert an example team" }),
    ).toBeVisible();
    const side = page.getByRole("complementary", { name: "Side panel" });
    await expect(side.getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      side.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
    // Top bar: team, current project, execution state, Help, More and Settings.
    const bar = page.getByRole("banner");
    await expect(bar.getByLabel("Current project")).toHaveValue("");
    await expect(bar.getByLabel("Current project")).toContainText(
      "No current project",
    );
    // The chip appears once the backend reports ready; on a slow runner that is after first paint.
    await expect(
      bar.getByRole("button", { name: "Resume execution" }),
    ).toBeVisible();
    const labels = await bar
      .getByRole("button")
      .evaluateAll((els) =>
        els
          .filter((e) => (e as HTMLElement).getClientRects().length)
          .map(
            (e) => e.getAttribute("aria-label") ?? e.textContent?.trim() ?? "",
          ),
      );
    expect(labels).toHaveLength(5);
    expect(labels[0]).toMatch(/^Active team: Main team/);
    expect(labels.slice(1)).toEqual([
      "Resume execution",
      "Help and feature guide",
      "More",
      "Settings",
    ]);
    await expect(
      bar.getByRole("button", { name: /^Attention inbox/ }),
    ).toHaveCount(0);
    await expect(
      bar.getByRole("button", { name: "Run a task" }),
    ).toHaveCount(0);
    // "Insert an example team" opens the library as a closable tab.
    await empty.getByRole("button", { name: "Insert an example team" }).click();
    await expect(tab(page, "Team library")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByRole("list", { name: "Example teams" }).getByRole("button"),
    ).toHaveCount(4);
    await page.getByRole("button", { name: "Close Team library" }).click();
    await expect(
      page.getByRole("tablist", { name: "Main views and open features" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("tablist", { name: "Main views and open features" })
        .getByRole("tab"),
    ).toHaveCount(4);
    await page.screenshot({ path: test.info().outputPath("first-run.png") });
    expect(errors).toEqual([]);
  });
});

test("Cmd+Shift+P opens commands and Cmd+P searches files and chats with scope prefixes", async () => {
  await withApp(async ({ directory, start }) => {
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "alpha-notes.md"), "sample file");
    const { page, errors } = await start();
    const agent = await api(page, "POST", "/agents", {
      name: "Alpha",
      environment: "codex",
      workspaces: [{ path: project, access: "read" }],
    });
    const session = await api(page, "POST", `/agents/${agent.id}/session`);
    await api(page, "POST", `/sessions/${session.id}/messages`, {
      text: "Deploy the alpha service",
    });

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+p" : "Control+Shift+p",
    );
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+p" : "Control+p",
    );
    const search = page.getByRole("dialog", { name: "Quick search" });
    const input = search.getByRole("combobox", {
      name: "Search files and chats",
    });
    const results = search.getByRole("listbox", { name: "Files and chats" });
    await expect(search).toContainText("Team: Main team");

    await input.fill("alpha");
    await expect(
      results.getByRole("option", { name: /alpha-notes\.md/ }),
    ).toBeVisible();
    await expect(
      results.getByRole("option", { name: /Deploy the alpha service/ }),
    ).toBeVisible();

    await input.fill("files: alpha");
    await expect(
      results.getByRole("option", { name: /alpha-notes\.md/ }),
    ).toBeVisible();
    await expect(
      results.getByRole("option", { name: /Deploy the alpha service/ }),
    ).toHaveCount(0);
    await input.fill("f: alpha");
    await expect(
      results.getByRole("option", { name: /alpha-notes\.md/ }),
    ).toBeVisible();

    await input.fill("chats: deploy");
    await expect(
      results.getByRole("option", { name: /Deploy the alpha service/ }),
    ).toBeVisible();
    await expect(
      results.getByRole("option", { name: /alpha-notes\.md/ }),
    ).toHaveCount(0);
    await input.fill("c: deploy");
    await expect(
      results.getByRole("option", { name: /Deploy the alpha service/ }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("Chat shows elapsed activity without inventing completion progress", async () => {
  await withApp(async ({ directory, start }) => {
    const { page, errors } = await start();
    const agent = await api(page, "POST", "/agents", {
      name: "Long-running Builder",
      environment: "codex",
    });
    const session = await api(page, "POST", `/agents/${agent.id}/session`);

    // Seed one in-progress session without invoking a provider or changing user data.
    const db = new DatabaseSync(join(directory, "data", "agentteam.sqlite"));
    const row = db
      .prepare("SELECT data FROM entities WHERE kind='session' AND id=?")
      .get(session.id) as { data: string };
    const seeded = JSON.parse(row.data);
    seeded.state = "running";
    seeded.startedAt = new Date(Date.now() - 65_000).toISOString();
    seeded.timeoutMs = 3_600_000;
    db.prepare("UPDATE entities SET data=? WHERE kind='session' AND id=?").run(
      JSON.stringify(seeded),
      session.id,
    );
    db.close();

    await page.reload();
    await tab(page, "Chat").click();
    await page.getByLabel("Agent", { exact: true }).selectOption(agent.id);
    const progress = page.getByTestId("run-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText("Long-running Builder is working");
    await expect(progress).toContainText(/1m \d+s elapsed/);
    await expect(progress).not.toContainText(/remaining|up to|%/);
    await expect(progress.getByRole("progressbar")).toHaveCount(0);
    await expect(
      page.getByText("Long-running Builder is working", { exact: true }),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  });
});

test("the More menu lists every feature by group with a description, and the palette opens each one", async () => {
  // This walks all feature pages in one Electron session; Windows needs more than
  // the ordinary single-workflow budget, while each locator keeps its own timeout.
  test.setTimeout(30_000 + FEATURES.length * 5_000);
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await api(page, "POST", "/agents", { name: "Alpha", environment: "codex" });
    await page.getByRole("button", { name: "More", exact: true }).click();
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const list = palette.getByRole("listbox", { name: "All views" });
    for (const g of FEATURE_GROUPS) await expect(list).toContainText(g);
    for (const f of FEATURES.filter(
      (x) => x.group && x.id !== "files" && x.id !== "review",
    )) {
      const option = list.getByRole("option", { name: f.name, exact: true });
      await expect(option).toContainText(f.description);
    }
    await expect(
      list.getByRole("option", { name: "Diff", exact: true }),
    ).toContainText(
      "Compare and review changes in the current project workspace.",
    );
    await expect(
      list.getByRole("option", { name: "Files", exact: true }),
    ).toContainText(
      "Browse, preview and edit files in the current project workspace.",
    );
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole("button", { name: "More" })).toBeFocused();
    // Feature pages open as tabs; Files and Diff select their permanent main views.
    for (const f of FEATURES) {
      await openFeature(page, f.name);
      await expect(tab(page, f.name)).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#view-panel")).not.toBeEmpty();
    }
    await expect(
      page
        .getByRole("tablist", { name: "Main views and open features" })
        .getByRole("tab"),
    ).toHaveCount(FEATURES.length + 2);
    // Searching finds agents and actions too; Enter runs the highlighted entry.
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k",
    );
    await palette.getByRole("combobox").fill("alpha");
    await expect(
      palette.getByRole("option", { name: "Alpha (agent)" }),
    ).toBeVisible();
    await palette.getByRole("combobox").fill("new agent");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "New agent" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});

test("feature tabs are remembered per team; the four main views are always available", async () => {
  await withApp(async ({ start }) => {
    let { page, app, errors } = await start();
    await openFeature(page, "Projects");
    await openFeature(page, "Git");
    // A new team starts with the four permanent main views and no feature tabs.
    await page.getByTestId("team-switcher").click();
    await page.getByRole("button", { name: "New team" }).click();
    await page.getByLabel("Team name").fill("Research");
    await page.getByRole("button", { name: "Create team" }).click();
    await expect(page.getByTestId("active-team-name")).toHaveText("Research");
    await expect(tab(page, "Layout")).toBeVisible();
    await expect(tab(page, "Chat")).toBeVisible();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Diff")).toBeVisible();
    await openFeature(page, "Inbox");
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    await app.close();

    ({ page, app, errors } = await start());
    await expect(page.getByTestId("active-team-name")).toHaveText("Research");
    await expect(tab(page, "Inbox")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Projects")).toHaveCount(0);
    await page.getByTestId("team-switcher").click();
    await page
      .getByRole("group", { name: "Teams" })
      .getByRole("button", { name: /^Main team:/ })
      .click();
    await expect(tab(page, "Projects")).toBeVisible();
    await expect(tab(page, "Git")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Inbox")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test("middle-clicking a feature tab closes it; the permanent views ignore middle click", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await openFeature(page, "Projects");
    await expect(tab(page, "Projects")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await tab(page, "Chat").click({ button: "middle" });
    await expect(tab(page, "Chat")).toHaveCount(1);
    await expect(tab(page, "Projects")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await tab(page, "Projects").click({ button: "middle" });
    await expect(tab(page, "Projects")).toHaveCount(0);
    await expect(tab(page, "Layout")).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });
});

test("agent panel: add a folder with edit access and a library skill on demand, save, and the agent is updated", async () => {
  await withApp(async ({ directory, start }) => {
    const folder = join(directory, "project");
    await mkdir(folder);
    const { app, page, errors } = await start();
    // The folder chooser is the native dialog: answer it in the main process (nothing opens).
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, folder);
    await page
      .getByTestId("canvas-empty")
      .getByRole("button", { name: "Add an agent" })
      .click();
    const create = page.getByRole("dialog", { name: "New agent" });
    await create.getByLabel("Name", { exact: true }).fill("Builder");
    await create.getByRole("button", { name: "Create agent" }).click();
    const panel = page.getByTestId("agent-panel");
    await expect(panel.getByTestId("agent-panel-name")).toHaveText("Builder");
    await expect(panel).toContainText("No folders yet");
    await panel
      .locator("details.setup-group")
      .filter({ hasText: "Folders" })
      .locator("summary")
      .click();
    await panel.getByRole("button", { name: "Add folder" }).click();
    const access = panel.getByLabel("Access for " + folder);
    await expect(access).toHaveValue("read");
    await expect(access.locator("option")).toHaveText([
      "Can read",
      "Can read and edit",
    ]);
    await access.selectOption("write");
    await panel
      .locator("details.setup-group")
      .filter({ hasText: "Skills" })
      .locator("summary")
      .click();
    await panel.getByRole("button", { name: "Add skill" }).click();
    const picker = panel.getByTestId("skill-picker");
    await picker.getByLabel("Search skills").fill("code-reviewer");
    await picker
      .getByRole("button", { name: "Add skill code-reviewer" })
      .click();
    const mode = panel.getByLabel("Load mode for code-reviewer");
    await expect(mode).toHaveValue("on-demand");
    await mode.selectOption("always");
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByTestId("agent-save")).toHaveCount(0);
    const agent = (await api(page, "GET", "/agents")).find(
      (a: any) => a.name === "Builder",
    );
    expect(agent.workspaces).toHaveLength(1);
    expect(agent.workspaces[0]).toMatchObject({
      access: "write",
      active: true,
    });
    expect(agent.skills).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/code-reviewer$/),
        mode: "always",
      }),
    ]);
    // Removing is one click away and also needs Save (Discard restores).
    await panel.getByRole("button", { name: "Remove folder project" }).click();
    await expect(panel).toContainText("No folders yet");
    await panel.getByRole("button", { name: "Discard" }).click();
    // (The saved path is the real path, e.g. /private/var on macOS.)
    await expect(panel.getByLabel(/^Access for .*project$/)).toHaveValue(
      "write",
    );
    // Advanced stays collapsed until asked for.
    const advanced = panel.getByTestId("agent-advanced");
    await expect(advanced).not.toHaveAttribute("open", "");
    await expect(panel.getByLabel("Scheduling priority")).toBeHidden();
    await advanced.locator("> summary").click();
    await expect(panel.getByLabel("Scheduling priority")).toBeVisible();
    await expect(panel.getByLabel("Max concurrent invoked agents")).toHaveValue(
      "",
    );
    // Instruction length: guidance first, a soft warning only above the threshold, never a block.
    const hint = panel.getByTestId("instruction-length");
    await expect(hint).toHaveAttribute("data-level", /none|ok/);
    const instructions = panel.getByLabel("Always-loaded instructions");
    await instructions.fill("Review the diff. Output a JSON verdict.");
    await expect(hint).toHaveAttribute("data-level", "ok");
    await instructions.fill("x".repeat(1600));
    await expect(hint).toHaveAttribute("data-level", "long");
    await expect(hint).toContainText("on-demand skill");
    await expect(panel.getByRole("button", { name: "Save" })).toBeEnabled();
    await instructions.fill("Short again.");
    await expect(hint).toHaveAttribute("data-level", "ok");
    await panel.getByRole("button", { name: "Discard" }).click();
    await page.screenshot({ path: test.info().outputPath("agent-panel.png") });
    expect(errors).toEqual([]);
  });
});

test("contextual entry: a pending approval shows the attention button and the approval opens the Inbox", async () => {
  await withApp(async ({ directory, start }) => {
    let { app, page } = await start();
    const agent = await api(page, "POST", "/agents", {
      name: "Builder",
      environment: "codex",
    });
    await app.close();
    // Fixture: a pending permission request (as the recovery test seeds it); no provider runs.
    const db = new DatabaseSync(join(directory, "data", "agentteam.sqlite"));
    db.prepare("INSERT INTO entities(kind,id,data) VALUES('approval',?,?)").run(
      "approval-nav",
      JSON.stringify({
        id: "approval-nav",
        agentId: agent.id,
        createdAt: new Date().toISOString(),
        fingerprint: "fixture",
        status: "pending",
        request: {
          sessionId: "s",
          toolCall: { toolCallId: "t1", title: "Edit notes.txt", kind: "edit" },
          options: [
            { optionId: "allow", name: "Allow once", kind: "allow_once" },
          ],
        },
      }),
    );
    db.close();
    let errors: string[];
    ({ app, page, errors } = await start());
    await expect(tab(page, "Layout")).toBeVisible();
    await expect(tab(page, "Chat")).toBeVisible();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Diff")).toBeVisible();
    const attention = page.getByRole("button", {
      name: /^Attention inbox, 1 item/,
    });
    await expect(attention).toBeVisible();
    await expect(page.getByTestId("inbox-badge")).toHaveText("1");
    const request = page.getByRole("dialog", {
      name: "Agent permission request",
    });
    await expect(request).toContainText("Edit notes.txt");
    await request.getByRole("button", { name: "Open inbox" }).click();
    await expect(tab(page, "Inbox")).toHaveAttribute("aria-selected", "true");
    const item = page
      .getByRole("region", { name: "Attention inbox" })
      .getByTestId("inbox-item");
    await expect(item).toHaveAttribute("data-kind", "approval");
    await expect(item).toContainText("Edit notes.txt");
    // Answering it removes the attention button again.
    await request.getByRole("button", { name: "Allow once" }).click();
    await expect(attention).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
