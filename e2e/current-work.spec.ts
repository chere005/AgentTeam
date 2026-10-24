import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

async function withApp(run: (page: Page, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-current-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: directory,
      AGENTTEAM_TEST: "1",
      AGENTTEAM_ENABLE_LIVE: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await run(page, directory);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ({ method, path, body }) => window.agentteam.request(method, path, body),
    { method, path, body },
  );
const mod = process.platform === "darwin" ? "Meta" : "Control";

test("Projects can resolve a failed attempt against verified work and undo it", async () => {
  await withApp(async (page) => {
    const agent = await api(page, "POST", "/agents", {
      name: "Progress tester",
      environment: "codex",
      roleType: "implementer",
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Supersede demo",
      goal: "Show accurate recovery progress",
      ownerId: agent.id,
      completionCriteria: "A verified task replaces the failed attempt",
    });
    const failed = await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "First attempt",
      completionCriteria: "Finish successfully",
    });
    const verified = await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Verified retry",
      completionCriteria: "Finish successfully",
    });
    await api(page, "POST", `/tasks/${failed.id}/status`, {
      status: "running",
    });
    await api(page, "POST", `/tasks/${failed.id}/status`, {
      status: "failed",
      result: "The first attempt failed before producing output.",
    });
    await api(page, "POST", `/tasks/${verified.id}/status`, {
      status: "running",
    });
    await api(page, "POST", `/tasks/${verified.id}/status`, {
      status: "completed",
      result: "Verified output from the successful retry.",
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await openFeature(page, "Projects");

    const card = page
      .locator(".project-card")
      .filter({ has: page.getByRole("heading", { name: "Supersede demo" }) });
    await card.getByText("needs attention", { exact: true }).waitFor();
    await card
      .locator(".task > summary")
      .filter({ hasText: "First attempt" })
      .click();
    const replacement = card.getByLabel(
      "Supersede First attempt with successful task",
    );
    await replacement.selectOption(verified.id);
    await card.getByRole("button", { name: "Mark superseded" }).click();

    await expect(card.locator(".project-heading .badge")).toHaveText(
      "completed",
    );
    await expect(card.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "2",
    );
    await expect(card).toContainText(
      "2 of 2 resolved · 1 complete · 1 superseded",
    );
    await expect(card).toContainText(
      "The first attempt failed before producing output.",
    );
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card.locator(".project-heading .badge")).toHaveText(
      "needs attention",
    );
  });
});

test("editor supports Sublime-style multiple selections, duplicate line, undo after save, find/replace and wrapping", async () => {
  await withApp(async (page, directory) => {
    const root = join(directory, "workspace");
    await mkdir(root);
    await writeFile(
      join(root, "sample.ts"),
      "const item = 1;\nconsole.log(item);\n",
    );
    const agent = await api(page, "POST", "/agents", {
      name: "Editor tester",
      environment: "codex",
      workspaces: [{ path: root, access: "write", active: true }],
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Editor project",
      goal: "Edit code",
      ownerId: agent.id,
      completionCriteria: "saved",
    });
    await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Edit",
      completionCriteria: "saved",
      resourcePaths: [root],
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Current project").selectOption(project.id);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page
      .getByRole("complementary", { name: "Agent folders and files" })
      .getByRole("treeitem", { name: "sample.ts", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "File contents",
      exact: true,
    });
    await expect(editor).toContainText("const item = 1;");
    await editor.click();
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    for (let i = 0; i < 6; i++) await editor.press("ArrowRight");
    await editor.press(`${mod}+d`);
    await editor.press(`${mod}+d`);
    await expect(page.locator(".text-editor-footer")).toContainText(
      "2 selections",
    );
    await page.keyboard.insertText("value");
    await expect(editor).toContainText("const value = 1;");
    await expect(editor).toContainText("console.log(value);");
    const acceptOverlapWarning = () => {
      let message = "";
      page.once("dialog", (dialog) => {
        message = dialog.message();
        void dialog.accept();
      });
      return () =>
        expect(message).toContain(
          "AgentTeam work overlaps this file or its folder:",
        );
    };
    await editor.press("Escape");
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await editor.press(`${mod}+Shift+D`);
    const assertFirstOverlapWarning = acceptOverlapWarning();
    await editor.press(`${mod}+s`);
    await expect(page.getByText(/Saved \d/)).toBeVisible();
    assertFirstOverlapWarning();
    const saved = await readFile(join(root, "sample.ts"), "utf8");
    expect(saved.match(/const value = 1;/g)).toHaveLength(2);
    await editor.press(`${mod}+z`);
    await expect(
      page.getByText("Unsaved changes", { exact: true }),
    ).toBeVisible();
    expect(await readFile(join(root, "sample.ts"), "utf8")).toBe(saved);
    await editor.press(`${mod}+f`);
    await page
      .getByRole("textbox", { name: "Find", exact: true })
      .fill("value");
    await page
      .getByRole("textbox", { name: "Replace", exact: true })
      .fill("entry");
    await page
      .getByRole("button", { name: "replace all", exact: true })
      .click();
    await page.getByRole("button", { name: "close", exact: true }).click();
    await expect(editor).toContainText("entry");
    const wordWrap = page.getByRole("button", {
      name: "Word wrap",
      exact: true,
    });
    await expect(wordWrap).toHaveAttribute("aria-pressed", "true");
    await wordWrap.click();
    await expect(wordWrap).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".cm-content")).not.toHaveClass(
      /cm-lineWrapping/,
    );
    await wordWrap.click();
    await expect(wordWrap).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
    const assertSecondOverlapWarning = acceptOverlapWarning();
    await editor.press(`${mod}+s`);
    await expect(page.getByText(/Saved \d/)).toBeVisible();
    assertSecondOverlapWarning();
    await page.screenshot({ path: join(directory, "editor.png") });
  });
});

test("owner edits agent-read-only files and gets a pre-save overlap warning", async () => {
  await withApp(async (page, directory) => {
    const root = join(directory, "read-only-workspace");
    await mkdir(root);
    await writeFile(join(root, "notes.md"), "Original\n");
    const agent = await api(page, "POST", "/agents", {
      name: "Read-only agent",
      environment: "codex",
      workspaces: [{ path: root, access: "read", active: true }],
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Human edit check",
      goal: "Edit a file while the agent has read-only access",
      ownerId: agent.id,
      completionCriteria: "The owner can save the edit",
    });
    await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Review notes.md",
      completionCriteria: "Review the file",
      resourcePaths: [join(root, "notes.md")],
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Current project").selectOption(project.id);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page
      .getByRole("complementary", { name: "Agent folders and files" })
      .getByRole("treeitem", { name: "notes.md", exact: true })
      .click();
    await expect(
      page.getByText("Agent: read only · you can edit", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const editor = page.getByRole("textbox", {
      name: "File contents",
      exact: true,
    });
    await expect(editor).toBeEditable();
    await editor.fill("Edited by the owner\n");
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(
        "Read-only agent · queued: Review notes.md",
      );
      expect(dialog.message()).toContain("Save your changes anyway?");
      await dialog.accept();
    });
    await page.locator(".text-editor-toolbar button.primary").click();
    await expect(page.getByText(/Saved /)).toBeVisible();
    expect(await readFile(join(root, "notes.md"), "utf8")).toBe(
      "Edited by the owner\n",
    );
  });
});

test("team Chat indents reports under their manager and global pause controls remain available", async () => {
  await withApp(async (page) => {
    const lead = await api(page, "POST", "/agents", {
      name: "Lead",
      environment: "codex",
    });
    const worker = await api(page, "POST", "/agents", {
      name: "Worker",
      environment: "codex",
      parentId: lead.id,
    });
    await api(page, "POST", "/agents", {
      name: "Child",
      environment: "codex",
      parentId: worker.id,
    });
    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.locator("#tab-team-chat").click();
    const tree = page.getByRole("tree", { name: "Agent chats" });
    await expect(
      tree.getByRole("treeitem", { name: "Lead", exact: true }),
    ).toHaveAttribute("aria-level", "1");
    await expect(
      tree.getByRole("treeitem", { name: "Worker", exact: true }),
    ).toHaveAttribute("aria-level", "2");
    await expect(
      tree.getByRole("treeitem", { name: "Child", exact: true }),
    ).toHaveAttribute("aria-level", "3");
    const leadX = (await tree
      .getByRole("treeitem", { name: "Lead", exact: true })
      .locator(":scope > .team-chat-tree-row .team-chat-picker-avatar")
      .boundingBox())!.x;
    const workerX = (await tree
      .getByRole("treeitem", { name: "Worker", exact: true })
      .locator(":scope > .team-chat-tree-row .team-chat-picker-avatar")
      .boundingBox())!.x;
    expect(workerX).toBeGreaterThan(leadX);
    const workerItem = tree.getByRole("treeitem", {
      name: "Worker",
      exact: true,
    });
    await expect(
      workerItem.getByRole("treeitem", { name: "Child", exact: true }),
    ).toBeVisible();
    await tree
      .getByRole("treeitem", { name: "Worker", exact: true })
      .locator(":scope > .team-chat-tree-row")
      .click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    await expect(
      conversation.getByRole("heading", { name: "Talk to Worker" }),
    ).toBeVisible();
    await expect(conversation.getByLabel("Agent", { exact: true })).toHaveValue(
      worker.id,
    );
    const bar = page.getByRole("banner");
    await bar
      .getByRole("button", { name: "Resume execution", exact: true })
      .click();
    await bar
      .getByRole("button", { name: "Wrap up & pause", exact: true })
      .click();
    await expect(
      bar.getByText("Paused · ready to close", { exact: true }),
    ).toBeVisible();
    await bar
      .getByRole("button", { name: "Resume execution", exact: true })
      .click();
    await bar
      .getByRole("button", { name: "Pause immediately", exact: true })
      .click();
    await page.reload();
    await expect(
      bar.getByRole("button", { name: "Resume execution", exact: true }),
    ).toBeVisible();
    expect((await api(page, "GET", "/snapshot")).execution.readyToClose).toBe(
      true,
    );
  });
});

test("global blocks require acknowledgement, persist, and cannot be approved away by the desktop user", async () => {
  await withApp(async (page, directory) => {
    const root = join(directory, "blocked");
    await mkdir(root);
    await writeFile(join(root, "private.txt"), "private");
    const agent = await api(page, "POST", "/agents", {
      name: "Writer",
      environment: "codex",
      workspaces: [{ path: root, access: "write", active: true }],
    });
    await openFeature(page, "Settings");
    const settings = page.getByRole("region", {
      name: "Global filesystem blocks",
    });
    await settings
      .getByRole("textbox", { name: "Drive or folder to block" })
      .fill(root);
    await expect(
      settings.getByRole("button", { name: "Block permanently" }),
    ).toBeDisabled();
    await settings.getByRole("checkbox").check();
    await settings.getByRole("button", { name: "Block permanently" }).click();
    await expect(settings.getByText(/blocked permanently/)).toBeVisible();
    expect((await api(page, "GET", "/filesystem-policy")).blocks).toHaveLength(
      1,
    );
    await expect(
      api(page, "POST", `/agents/${agent.id}/files/read`, {
        workspace: root,
        path: "private.txt",
      }),
    ).rejects.toThrow(/permanently blocked/);
    await page.reload();
    await expect(page.getByText(/blocked permanently/)).toBeVisible();
  });
});
