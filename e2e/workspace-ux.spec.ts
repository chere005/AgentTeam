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

test("workspace persistence: panes, widths, selection and canvas viewport survive a relaunch", async () => {
  await withApp(async ({ start }) => {
    const first = await start();
    let page = first.page;
    // Defaults: Canvas in the middle, Conversation on the right.
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "team",
    );
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("chat");
    await api(page, "POST", "/agents", { name: "Alpha", environment: "codex" });
    await api(page, "POST", "/agents", { name: "Beta", environment: "codex" });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    // Selecting an agent from the list shows its conversation, so do that first.
    await page.getByRole("button", { name: /Beta/ }).click();
    await page
      .getByRole("combobox", { name: "right pane" })
      .selectOption("activity");
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    const separator = page.getByRole("separator", {
      name: "Resize right pane",
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
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "team",
    );
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("activity");
    await expect(
      page.getByRole("button", { name: "Toggle navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.getByRole("separator", { name: "Resize right pane" }),
    ).toHaveAttribute("aria-valuenow", "500");
    await expect(page.locator(".statusbar")).toContainText("Beta");
    expect(await store(page, "viewport")).toBe(viewport);
    const saved = JSON.parse(viewport!);
    const transform = await page
      .locator(".react-flow__viewport")
      .evaluate((el) => (el as HTMLElement).style.transform);
    expect(transform).toContain(`scale(${saved.zoom})`);
    expect(second.errors).toEqual([]);
  });
});

test("workspace layouts: presets apply, are editable, and custom layouts persist", async () => {
  await withApp(async ({ start }) => {
    let { page, app } = await start();
    const menu = page.getByRole("button", { name: "Layouts" });
    await menu.click();
    for (const name of ["Planning", "Coding", "Review", "Monitoring"])
      await expect(
        page.getByRole("button", { name, exact: true }),
      ).toBeVisible();
    await page.getByRole("button", { name: "Monitoring", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "team",
    );
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("inbox");
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole("button", { name: "Coding", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "workspace",
    );
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("chat");
    // Edit the Coding preset: change the right pane, then update it from the current panes.
    await page
      .getByRole("combobox", { name: "right pane" })
      .selectOption("workflows");
    await menu.click();
    await page
      .getByRole("button", { name: "Update Coding from current panes" })
      .click();
    await page.getByLabel("New layout name").fill("My review");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "My review", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("combobox", { name: "main pane" })
      .selectOption("skills");
    await app.close();

    ({ page, app } = await start());
    await page.getByRole("button", { name: "Layouts" }).click();
    await expect(
      page.getByRole("button", { name: "Coding (edited)" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Planning", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("chat");
    await page.getByRole("button", { name: "Layouts" }).click();
    await page.getByRole("button", { name: "Coding (edited)" }).click();
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "workspace",
    );
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("workflows");
    await page.getByRole("button", { name: "Layouts" }).click();
    await page.getByRole("button", { name: "Delete My review" }).click();
    await page.getByRole("button", { name: "Reset Coding" }).click();
    await expect(
      page.getByRole("button", { name: "Coding", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /My review/ })).toHaveCount(
      0,
    );
  });
});

test("a layout's right pane survives agent selection; an explicit open-conversation action switches it", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await api(page, "POST", "/agents", {
      name: "Watcher",
      environment: "codex",
    });
    await page.getByRole("button", { name: "Layouts" }).click();
    await page.getByRole("button", { name: "Monitoring", exact: true }).click();
    const right = page.getByRole("combobox", { name: "right pane" });
    await expect(right).toHaveValue("inbox");
    // Monitoring hides the navigation; show it and select the agent from the list.
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page
      .getByRole("group", { name: "Agents" })
      .getByRole("button", { name: /Watcher/ })
      .click();
    await expect(right).toHaveValue("inbox");
    // Selecting the agent on the canvas keeps the layout's pane too.
    const node = page.locator(".react-flow__node", { hasText: "Watcher" });
    await node.click();
    await expect(right).toHaveValue("inbox");
    // Explicit action: "Chat in AgentTeam" from the canvas context menu opens the conversation.
    await node.click({ button: "right" });
    await page.getByRole("button", { name: "Chat in AgentTeam" }).click();
    await expect(right).toHaveValue("chat");
    // Without a pinning layout, plain selection still follows the conversation (default behavior).
    await page
      .getByRole("combobox", { name: "main pane" })
      .selectOption("workflows");
    await right.selectOption("activity");
    await page
      .getByRole("group", { name: "Agents" })
      .getByRole("button", { name: /Watcher/ })
      .click();
    await expect(right).toHaveValue("chat");
    expect(errors).toEqual([]);
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
    // Linking: the failed item opens the Workflows pane in the main area.
    await items
      .filter({ hasText: "Broken step failed" })
      .getByRole("button", { name: "Open" })
      .click();
    await expect(page.getByRole("combobox", { name: "main pane" })).toHaveValue(
      "workflows",
    );
    // Dismissing removes an item and the badge follows.
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
    await expect(page.getByRole("navigation", { name: "Panes" })).toBeVisible();
    await expect(
      page.getByRole("main", { name: "Main content" }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Side pane" }),
    ).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
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
    expect(order[1]).toBe("Layouts");
    expect(order[2]).toMatch(/^Attention inbox, \d+ item/);
    expect(order).toContain("Toggle navigation");
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
    // Shortcuts: help dialog, navigation toggle, inbox.
    await page.locator("body").click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("?");
    await expect(
      page.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+b`);
    await expect(
      page.getByRole("button", { name: "Toggle navigation" }),
    ).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${modifier}+Shift+i`);
    await expect(
      page.getByRole("combobox", { name: "right pane" }),
    ).toHaveValue("inbox");
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
    await page.getByRole("button", { name: /Alpha/ }).click();
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
    await page.getByRole("button", { name: /Beta/ }).click();
    await expect(box).toHaveValue("");
    await box.fill("draft for beta");
    await page.getByRole("button", { name: /Alpha/ }).click();
    await expect(box).toHaveValue("draft for alpha");
    await page.waitForTimeout(300);
    await app.close();
    ({ page, app } = await start());
    const again = page.getByRole("textbox", { name: "Message" });
    await expect(again).toHaveValue("draft for alpha");
    await page.getByRole("button", { name: /Beta/ }).click();
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
    await expect(page.locator(".statusbar")).toContainText("Worker");
    await page.getByRole("button", { name: "Parent" }).click();
    await expect(page.locator(".statusbar")).toContainText("Lead");
    expect(errors).toEqual([]);
  });
});
