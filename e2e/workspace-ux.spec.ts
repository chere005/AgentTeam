import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatWith, openFeature, openSetup } from "./helpers";

// All tests use a temp AGENTTEAM_DATA_DIR (also Electron's userData, so localStorage is isolated)
// and fixture data created through the API; no provider is ever invoked.
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
  fn: (ctx: {
    directory: string;
    start: () => ReturnType<typeof launch>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-ux-"));
  const apps: ElectronApplication[] = [];
  try {
    await fn({
      directory,
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
const store = (page: Page, key: string) =>
  page.evaluate((k) => localStorage.getItem("agentteam." + k), key);

const side = (page: Page) =>
  page.getByRole("complementary", { name: "Side panel" });
const tab = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "Main views and open features" })
    .getByRole("tab", { name });

test("workspace persistence: open tabs, side panel width, selection and canvas viewport survive a relaunch", async () => {
  await withApp(async ({ start }) => {
    const first = await start();
    let page = first.page;
    // Main views are permanent; direct agent chat remains in the side panel.
    await expect(tab(page, "Layout")).toBeVisible();
    await expect(tab(page, "Chat")).toBeVisible();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Diff")).toBeVisible();
    await expect(side(page).getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await api(page, "POST", "/agents", { name: "Alpha", environment: "codex" });
    await api(page, "POST", "/agents", { name: "Beta", environment: "codex" });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await openChatWith(page, "Beta");
    await openFeature(page, "Inbox");
    await openFeature(page, "Activity log");
    await openFeature(page, "Canvas");
    const separator = page.getByRole("separator", {
      name: "Resize side panel",
    });
    await separator.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await expect(separator).toHaveAttribute("aria-valuenow", "500");
    // Zoom the canvas, then wait for the viewport to be stored.
    const canvas = page.locator(".react-flow");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -500);
    await expect.poll(() => store(page, "viewport")).not.toBeNull();
    await page.waitForTimeout(400);
    const viewport = await store(page, "viewport");
    await first.app.close();

    const second = await start();
    page = second.page;
    await expect(tab(page, "Inbox")).toBeVisible();
    await expect(tab(page, "Activity log")).toBeVisible();
    await expect(tab(page, "Layout")).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("separator", { name: "Resize side panel" }),
    ).toHaveAttribute("aria-valuenow", "500");
    await expect(
      side(page).getByRole("combobox", { name: "Agent", exact: true }),
    ).toHaveValue(
      (await api(page, "GET", "/agents")).find((a: any) => a.name === "Beta")
        .id,
    );
    expect(await store(page, "viewport")).toBe(viewport);
    const saved = JSON.parse(viewport!);
    const transform = await page
      .locator(".react-flow__viewport")
      .evaluate((el) => (el as HTMLElement).style.transform);
    // Compare numerically: the browser serialises the inline transform with ~6 significant digits,
    // and the stored zoom is arbitrary when the wheel interrupts a running fit animation (e.g. the
    // debounced re-fit after the side panel resize), so "scale(1.8847736625514404)" reads back as
    // "scale(1.88477)".
    const m = transform.match(
      /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/,
    );
    expect(m, transform).not.toBeNull();
    expect(Number(m![3])).toBeCloseTo(saved.zoom, 4);
    expect(Math.abs(Number(m![1]) - saved.x)).toBeLessThan(0.5);
    expect(Math.abs(Number(m![2]) - saved.y)).toBeLessThan(0.5);
    // Closing a tab persists too.
    await page.getByRole("button", { name: "Close Activity log" }).click();
    await expect(tab(page, "Activity log")).toHaveCount(0);
    expect(second.errors).toEqual([]);
  });
});

test("main view shortcuts keep the current project and Files can edit a text file", async () => {
  await withApp(async ({ directory, start }) => {
    const { page, errors } = await start();
    const root = join(directory, "pi-demo");
    await mkdir(root);
    await writeFile(join(root, "README.md"), "# Pi demo\n");
    const agent = await api(page, "POST", "/agents", {
      name: "Pi builder",
      environment: "codex",
      workspaces: [{ path: root, access: "write", active: true }],
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Pi demo",
      goal: "Create a small Pi example",
      ownerId: agent.id,
      completionCriteria: "README is saved",
    });
    await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Create the example",
      completionCriteria: "The example is ready",
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const projectPicker = page.getByLabel("Current project");
    await projectPicker.selectOption(project.id);
    await expect(projectPicker).toHaveValue(project.id);

    const views = ["Layout", "Chat", "Files", "Diff"];
    for (let index = 0; index < views.length; index++) {
      await page.keyboard.press(
        `${process.platform === "darwin" ? "Meta" : "Control"}+${index + 1}`,
      );
      await expect(tab(page, views[index])).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(projectPicker).toHaveValue(project.id);
    }

    // Opening Diff captures a local baseline even for a folder without Git.
    await tab(page, "Diff").click();
    await expect(page.getByText("no Git required")).toBeVisible();
    await tab(page, "Files").click();
    const files = page.getByRole("complementary", { name: "Project files" });
    await files.getByRole("button", { name: "README.md" }).click();
    await page.getByRole("button", { name: "Edit file" }).click();
    const editor = page.getByRole("textbox", { name: "File contents" });
    await expect(editor).toHaveText("# Pi demo");
    await editor.fill("# Pi demo\n\nEdited in AgentTeam.\n");
    await page.getByRole("button", { name: /Save/ }).click();
    await expect(page.getByText(/Saved /)).toBeVisible();
    expect(await readFile(join(root, "README.md"), "utf8")).toBe(
      "# Pi demo\n\nEdited in AgentTeam.\n",
    );
    await page.getByRole("button", { name: "New file" }).click();
    await page
      .getByRole("textbox", { name: "New file name" })
      .fill("example.py");
    await page
      .getByRole("textbox", { name: "File contents" })
      .fill("print('ready')\n");
    await page.getByRole("button", { name: "Save in workspace" }).click();
    await expect(
      page.getByText("example.py", { exact: true }).first(),
    ).toBeVisible();
    expect(await readFile(join(root, "example.py"), "utf8")).toBe(
      "print('ready')\n",
    );
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+4`,
    );
    await expect(tab(page, "Diff")).toHaveAttribute("aria-selected", "true");
    const changed = page.getByRole("navigation", { name: "Changed files" });
    await expect(changed).toContainText("README.md");
    await expect(changed).toContainText("example.py");
    await expect(page.getByText("Current project: Pi demo")).toBeVisible();
    await expect(projectPicker).toHaveValue(project.id);
    expect(errors).toEqual([]);
  });
});

test("Cmd+P finds chats and project files; Cmd+Shift+P stays the command palette", async () => {
  await withApp(async ({ directory, start }) => {
    const { page, errors } = await start();
    const root = join(directory, "workspace");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "quickWidget.ts"),
      "export const widget = true;\n",
    );
    const agent = await api(page, "POST", "/agents", {
      name: "Search builder",
      environment: "codex",
      workspaces: [{ path: root, access: "write", active: true }],
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Search project",
      goal: "Find a file and chat",
      ownerId: agent.id,
      completionCriteria: "Search works",
    });
    await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Search test",
      completionCriteria: "Search works",
    });
    const session = await api(page, "POST", `/agents/${agent.id}/session`, {});
    await api(page, "POST", `/sessions/${session.id}/messages`, {
      text: "Find the green widget in this project",
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const projectPicker = page.getByLabel("Current project");
    await projectPicker.selectOption(project.id);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+p" : "Control+p",
    );
    const search = page.getByRole("dialog", { name: "Quick search" });
    await search
      .getByRole("combobox", { name: "Search files and chats" })
      .fill("f: quick widget");
    const fileResult = search.getByRole("option", { name: /quickWidget\.ts/ });
    await expect(fileResult).toBeVisible();
    await fileResult.click();
    await expect(tab(page, "Files")).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("button", { name: "quickWidget.ts", exact: true }),
    ).toBeVisible();
    await expect(projectPicker).toHaveValue(project.id);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+p" : "Control+p",
    );
    const chatSearch = page.getByRole("dialog", { name: "Quick search" });
    await chatSearch
      .getByRole("combobox", { name: "Search files and chats" })
      .fill("chats: green widget");
    await chatSearch
      .getByRole("option", { name: /Find the green widget/ })
      .click();
    await expect(tab(page, "Chat")).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByText("Find the green widget in this project"),
    ).toBeVisible();
    await expect(projectPicker).toHaveValue(project.id);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Shift+p" : "Control+Shift+p",
    );
    await expect(
      page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Quick search" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test("workspace layouts (Settings): presets open sets of tabs, are editable, and custom layouts persist", async () => {
  await withApp(async ({ start }) => {
    let { page, app } = await start();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    // A function: `page` changes after the relaunch.
    const list = () => page.getByRole("list", { name: "Workspace layouts" });
    for (const name of ["Layout & chat", "Coding", "Review", "Monitoring"])
      await expect(
        list().getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await list()
      .getByRole("button", { name: "Monitoring", exact: true })
      .click();
    await expect(tab(page, "Inbox")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Timeline & inspector")).toBeVisible();
    // Applied from Settings: the Settings tab stays open.
    await tab(page, "Settings").click();
    await list().getByRole("button", { name: "Coding", exact: true }).click();
    await expect(tab(page, "Files")).toHaveAttribute("aria-selected", "true");
    await expect(tab(page, "Git")).toBeVisible();
    await expect(tab(page, "Inbox")).toHaveCount(0);
    // Edit the Coding preset: swap Git for Projects, then update it from the current tabs.
    await page.getByRole("button", { name: "Close Git" }).click();
    await openFeature(page, "Projects");
    await tab(page, "Settings").click();
    await page
      .getByRole("button", { name: "Update Coding from current tabs" })
      .click();
    await page.getByLabel("New layout name").fill("My review");
    await page
      .getByRole("button", { name: "Save layout", exact: true })
      .click();
    await expect(
      list().getByRole("button", { name: "My review", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(300); // let localStorage flush before quitting
    await app.close();

    ({ page, app } = await start());
    await tab(page, "Settings").click();
    await expect(
      list().getByRole("button", { name: "Coding (edited)" }),
    ).toBeVisible();
    await list()
      .getByRole("button", { name: "Layout & chat", exact: true })
      .click();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Layout")).toHaveAttribute("aria-selected", "true");
    await tab(page, "Settings").click();
    await list().getByRole("button", { name: "Coding (edited)" }).click();
    await expect(tab(page, "Files")).toBeVisible();
    await expect(tab(page, "Projects")).toBeVisible();
    await expect(tab(page, "Git")).toHaveCount(0);
    await tab(page, "Settings").click();
    await page.getByRole("button", { name: "Delete My review" }).click();
    await page.getByRole("button", { name: "Reset Coding" }).click();
    await expect(
      list().getByRole("button", { name: "Coding", exact: true }),
    ).toBeVisible();
    await expect(list().getByRole("button", { name: /My review/ })).toHaveCount(
      0,
    );
  });
});

test("canvas cards follow the selected side pane, explicit setup and chat actions switch views, beside-chat placement, Esc closes", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await api(page, "POST", "/agents", {
      name: "Watcher",
      environment: "codex",
    });
    await api(page, "POST", "/agents", {
      name: "Other agent",
      environment: "codex",
    });
    const chatTab = side(page).getByRole("tab", { name: "Chat" });
    const setupTab = side(page).getByRole("tab", { name: "Agent setup" });
    // With Chat selected, clicking a card changes the conversation recipient and keeps Chat open.
    await chatTab.click();
    const node = page.locator(".react-flow__node", { hasText: "Watcher" });
    await node.click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(
      side(page).getByRole("combobox", { name: "Agent", exact: true }),
    ).toHaveValue(
      (await api(page, "GET", "/agents")).find((a: any) => a.name === "Watcher")
        .id,
    );
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    // Setup remains available explicitly, and card clicks follow it once selected.
    await page.getByRole("button", { name: "Set up Watcher" }).click();
    await expect(setupTab).toHaveAttribute("aria-selected", "true");
    const otherNode = page.locator(".react-flow__node", {
      hasText: "Other agent",
    });
    await otherNode.click();
    await expect(page.getByTestId("agent-panel-name")).toHaveText(
      "Other agent",
    );
    await expect(setupTab).toHaveAttribute("aria-selected", "true");
    // Explicit action: "Chat in AgentTeam" from the canvas context menu opens that conversation.
    await otherNode.click({ button: "right" });
    await page.getByRole("button", { name: "Chat in AgentTeam" }).click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    await expect(
      side(page).getByRole("combobox", { name: "Agent", exact: true }),
    ).toHaveValue(
      (await api(page, "GET", "/agents")).find(
        (a: any) => a.name === "Other agent",
      ).id,
    );
    // Header actions switch back to setup and then to chat.
    await page.getByRole("button", { name: "Set up Other agent" }).click();
    await expect(setupTab).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Chat with Other agent" }).click();
    await expect(chatTab).toHaveAttribute("aria-selected", "true");
    // Beside the chat: both are visible at once; the choice persists.
    await setupTab.click();
    await page
      .getByRole("button", { name: "Show agent panel beside chat" })
      .click();
    const column = page.getByRole("complementary", { name: "Agent setup" });
    await expect(column.getByTestId("agent-panel-name")).toHaveText(
      "Other agent",
    );
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(await store(page, "agentPanel.placement")).toBe('"beside"');
    // Esc closes the panel (focus is not in a text field).
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Escape");
    await expect(column).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test("agent setup accordion state is remembered per card when switching between agents", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    const watcher = await api(page, "POST", "/agents", {
      name: "Watcher",
      environment: "codex",
    });
    await api(page, "POST", "/agents", {
      name: "Other agent",
      environment: "codex",
    });
    const panel = page.getByTestId("agent-panel");
    const selectCard = async (name: string) => {
      await page
        .locator(".react-flow__node-agent", { hasText: name })
        .first()
        .click();
      if (!(await panel.isVisible()))
        await page.getByRole("button", { name: `Set up ${name}` }).click();
      await expect(panel.getByTestId("agent-panel-name")).toHaveText(name);
    };
    await selectCard("Watcher");
    const identity = panel.locator("details").filter({
      hasText: "Identity & role",
    });
    const talksTo = panel.locator("details").filter({ hasText: "Talks to" });
    await expect(identity).toHaveAttribute("open", "");
    await identity.locator("summary").click();
    await talksTo.locator("summary").click();
    await expect(identity).not.toHaveAttribute("open", "");
    await expect(talksTo).toHaveAttribute("open", "");

    await selectCard("Other agent");
    const otherIdentity = panel.locator("details").filter({
      hasText: "Identity & role",
    });
    const otherTalksTo = panel.locator("details").filter({
      hasText: "Talks to",
    });
    await expect(otherIdentity).toHaveAttribute("open", "");
    await expect(otherTalksTo).not.toHaveAttribute("open", "");

    await selectCard("Watcher");
    await expect(identity).not.toHaveAttribute("open", "");
    await expect(talksTo).toHaveAttribute("open", "");
    expect(errors).toEqual([]);
    expect(watcher.id).toBeTruthy();
  });
});

test("attention inbox lists failed, limit-stopped, validation and ready-review items with a count badge", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await page.evaluate(async () => {
      const r = window.agentteam.request;
      const a = await r("POST", "/agents", {
        name: "Planner",
        environment: "codex",
      });
      const b = await r("POST", "/agents", {
        name: "Builder",
        environment: "codex",
      });
      await r("POST", "/edges", {
        from: b.id,
        to: a.id,
        kind: "review",
        bidirectional: false,
        enabled: true,
      });
      const wf = await r("POST", "/workflows", {
        name: "Ship it",
        goal: "g",
        ownerId: a.id,
        completionCriteria: "d",
      });
      const task = (title: string, agentId: string, extra = {}) =>
        r("POST", "/tasks", {
          workflowId: wf.id,
          agentId,
          title,
          completionCriteria: "d",
          ...extra,
        });
      const failed = await task("Broken step", b.id);
      await r("POST", `/tasks/${failed.id}/status`, { status: "running" });
      await r("POST", `/tasks/${failed.id}/status`, {
        status: "failed",
        result: "boom",
      });
      const done = await task("Finished step", b.id);
      await r("POST", `/tasks/${done.id}/status`, { status: "running" });
      await r("POST", `/tasks/${done.id}/status`, {
        status: "completed",
        result: "ok",
      });
      await task("Gated step", a.id, { requiresValidation: true });
      const wf2 = await r("POST", "/workflows", {
        name: "Bounded",
        goal: "g",
        ownerId: a.id,
        completionCriteria: "d",
      });
      await r("PUT", `/workflows/${wf2.id}/limits`, { maxAgentTurns: 1 });
      const t1 = await r("POST", "/tasks", {
        workflowId: wf2.id,
        agentId: a.id,
        title: "First",
        completionCriteria: "d",
      });
      const t2 = await r("POST", "/tasks", {
        workflowId: wf2.id,
        agentId: b.id,
        title: "Second",
        completionCriteria: "d",
      });
      await r("POST", `/tasks/${t1.id}/status`, { status: "running" });
      await r("POST", `/tasks/${t2.id}/status`, { status: "running" }).catch(
        () => undefined,
      );
    });
    await page
      .getByRole("button", { name: /^Attention inbox, \d+ item/ })
      .click();
    const inbox = page.getByRole("region", { name: "Attention inbox" });
    const items = inbox.getByTestId("inbox-item");
    await expect(
      items.filter({ hasText: "Broken step failed" }),
    ).toHaveAttribute("data-kind", "failed");
    await expect(
      items.filter({ hasText: "Finished step is ready for review" }),
    ).toHaveAttribute("data-kind", "review");
    await expect(
      items.filter({ hasText: "Gated step waits for validation" }),
    ).toHaveAttribute("data-kind", "validation");
    await expect(
      items.filter({ hasText: "Bounded stopped by a limit" }),
    ).toContainText("Maximum of 1 agent turns");
    const count = await items.count();
    await expect(inbox.getByTestId("inbox-count")).toHaveText(String(count));
    await expect(page.getByTestId("inbox-badge")).toHaveText(String(count));
    // Linking: the failed item opens the Projects tab.
    await items
      .filter({ hasText: "Broken step failed" })
      .getByRole("button", { name: "Open" })
      .click();
    await expect(tab(page, "Projects")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Dismissing removes an item and the badge follows (back on the Inbox tab).
    await tab(page, "Inbox").click();
    await items
      .filter({ hasText: "Finished step" })
      .getByRole("button", { name: /^Dismiss/ })
      .click();
    await expect(items).toHaveCount(count - 1);
    await expect(page.getByTestId("inbox-badge")).toHaveText(String(count - 1));
    expect(errors).toEqual([]);
  });
});

test("accessibility smoke: landmarks, names, tab order, dialog focus trap and return, shortcuts", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await api(page, "POST", "/agents", { name: "Alpha", environment: "codex" });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    // Landmarks.
    await expect(page.getByRole("banner")).toHaveCount(1);
    // No long pane navigation any more: views open on request (More / Ctrl+K).
    await expect(page.getByRole("navigation", { name: "Panes" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("main", { name: "Main content" }),
    ).toBeVisible();
    await expect(side(page)).toBeVisible();
    await expect(
      page.getByRole("banner").getByText("Workspace connected"),
    ).toHaveAttribute("aria-live", "polite");
    // Every visible control in the shell, canvas toolbar and chat has an accessible name.
    const unnamed = await page.evaluate(() => {
      const name = (el: Element) => {
        const h = el as HTMLElement;
        const labelled = h.getAttribute("aria-labelledby");
        return (
          h.getAttribute("aria-label") ||
          (labelled && document.getElementById(labelled)?.textContent) ||
          (h as HTMLInputElement).labels?.[0]?.textContent ||
          h.getAttribute("title") ||
          h.getAttribute("placeholder") ||
          h.textContent
        )?.trim();
      };
      return [
        ...document.querySelectorAll(
          ".app button, .app select, .app textarea, .app input",
        ),
      ]
        .filter(
          (el) =>
            (el as HTMLElement).getClientRects().length &&
            !el.closest(".react-flow__controls, .react-flow__minimap"),
        )
        .filter((el) => !name(el))
        .map((el) => el.outerHTML.slice(0, 120));
    });
    expect(unnamed).toEqual([]);
    // Tab order starts at the skip link and reaches the topbar controls before the panes.
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await skip.focus();
    await expect(skip).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("main", { name: "Main content" }),
    ).toBeFocused();
    await skip.focus();
    const order: string[] = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      order.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement;
          return (
            el.getAttribute("aria-label") ||
            el.textContent?.trim() ||
            el.tagName
          );
        }),
      );
    }
    // The active-team switcher comes first in the top bar.
    expect(order[0]).toMatch(/^Active team: Main team, idle/);
    expect(order[1]).toBe("Assign project");
    expect(order).toContain("More");
    expect(order).toContain("Settings");
    expect(order.indexOf("More")).toBeLessThan(order.indexOf("Settings"));
    // Focus is visibly ringed.
    const outline = await page.evaluate(
      () => getComputedStyle(document.activeElement!).outlineStyle,
    );
    expect(outline).not.toBe("none");
    // Dialog: focus moves in, Tab/Shift+Tab are trapped, Escape closes, focus returns to opener.
    const opener = page.getByRole("button", { name: "New agent", exact: true });
    await opener.focus();
    await opener.press("Enter");
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => dialog.evaluate((d) => d.contains(document.activeElement)))
      .toBe(true);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
      ).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    // Shortcuts: help dialog, side panel toggle, inbox, command palette.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+Backslash`);
    await expect(side(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Show side panel" }).click();
    await expect(side(page)).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+i`);
    await expect(tab(page, "Inbox")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press(`${modifier}+k`);
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(
      palette.getByRole("combobox", {
        name: "Search views, agents and actions",
      }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test("chat input: Enter sends, Shift+Enter newline, IME composition, duplicate-send guard and per-agent drafts", async () => {
  await withApp(async ({ start }) => {
    let { page, app } = await start();
    const ids = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const a = await r("POST", "/agents", {
        name: "Alpha",
        environment: "codex",
      });
      const b = await r("POST", "/agents", {
        name: "Beta",
        environment: "codex",
      });
      return [a.id, b.id];
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await openChatWith(page, "Alpha");
    const box = page.getByRole("textbox", { name: "Message" });
    const sent = async (agentId: string) =>
      page.evaluate(async (id) => {
        const r = window.agentteam.request;
        const s = await r("POST", `/agents/${id}/session`);
        return (await r("GET", `/sessions/${s.id}/messages`)).map(
          (m: any) => m.text,
        );
      }, agentId);
    // Shift+Enter inserts a newline and sends nothing.
    await box.fill("line one");
    await box.press("Shift+Enter");
    await box.pressSequentially("line two");
    await expect(box).toHaveValue("line one\nline two");
    expect(await sent(ids[0])).toEqual([]);
    // IME composition: Enter that confirms a candidate must not send.
    await box.fill("");
    await box.evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await box.fill("こんにちは");
    await box.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(await sent(ids[0])).toEqual([]);
    await box.evaluate((el) =>
      el.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      ),
    );
    await page.waitForTimeout(50);
    // Duplicate-send guard: two Enter keydowns in the same tick post one message.
    await box.evaluate((el) => {
      for (let i = 0; i < 2; i++)
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
    });
    await expect(box).toHaveValue("");
    await expect.poll(() => sent(ids[0])).toEqual(["こんにちは"]);
    // Draft recovery per agent, surviving agent switches and a relaunch.
    await box.fill("draft for alpha");
    await openChatWith(page, "Beta");
    await expect(box).toHaveValue("");
    await box.fill("draft for beta");
    await openChatWith(page, "Alpha");
    await expect(box).toHaveValue("draft for alpha");
    await page.waitForTimeout(300);
    await app.close();
    ({ page, app } = await start());
    const again = page.getByRole("textbox", { name: "Message" });
    await expect(again).toHaveValue("draft for alpha");
    await openChatWith(page, "Beta");
    await expect(again).toHaveValue("draft for beta");
  });
});

test("canvas groups: collapse hides members behind a group node, hierarchy navigation selects relatives", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    const ids = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const root = await r("POST", "/agents", {
        name: "Lead",
        environment: "codex",
      });
      const child = await r("POST", "/agents", {
        name: "Worker",
        environment: "codex",
        parentId: root.id,
      });
      const other = await r("POST", "/agents", {
        name: "Solo",
        environment: "codex",
      });
      await r("POST", "/edges", {
        from: root.id,
        to: child.id,
        kind: "delegate",
        bidirectional: false,
        enabled: true,
      });
      return [root.id, child.id, other.id];
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    // Three fixture agents plus the built-in team coordinator.
    await expect(page.locator(".react-flow__node-agent")).toHaveCount(4);
    // Select Lead and Worker with ctrl-click, group them, collapse.
    await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).click();
    await page.locator(`.react-flow__node[data-id="${ids[1]}"]`).click({
      modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
    });
    // Grouping and hierarchy navigation sit behind the canvas "Groups" toggle.
    await page.getByRole("button", { name: "Groups", exact: true }).click();
    await page.getByLabel("Group name").fill("Core");
    await page.getByRole("button", { name: "Group selected" }).click();
    await page.getByRole("button", { name: "Collapse group Core" }).click();
    await expect(page.locator(".react-flow__node-group")).toContainText("Core");
    await expect(page.locator(".react-flow__node-agent:visible")).toHaveCount(
      2,
    );
    // The delegate edge is internal to the group, so it disappears.
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Expand group Core" })
      .first()
      .click();
    await expect(page.locator(".react-flow__node-agent:visible")).toHaveCount(
      4,
    );
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    // Hierarchy navigation: Lead -> child Worker -> parent Lead.
    await page.locator(`.react-flow__node[data-id="${ids[0]}"]`).click();
    await page.getByRole("button", { name: "Child" }).click();
    await expect(side(page).getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      side(page).getByRole("combobox", { name: "Agent", exact: true }),
    ).toHaveValue(ids[1]);
    await page.getByRole("button", { name: "Parent" }).click();
    await expect(
      side(page).getByRole("combobox", { name: "Agent", exact: true }),
    ).toHaveValue(ids[0]);
    expect(errors).toEqual([]);
  });
});
