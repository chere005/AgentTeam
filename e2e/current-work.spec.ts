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
      .getByRole("complementary", { name: "Project files" })
      .getByRole("button", { name: "sample.ts", exact: true })
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
    await editor.press("Escape");
    await editor.press(
      process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home",
    );
    await editor.press(`${mod}+Shift+D`);
    await editor.press(`${mod}+s`);
    await expect(page.getByText(/Saved \d/)).toBeVisible();
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
    await page.getByRole("button", { name: "Word wrap", exact: true }).click();
    await expect(page.locator(".cm-content")).toHaveClass(/cm-lineWrapping/);
    await editor.press(`${mod}+s`);
    await expect(page.getByText(/Saved \d/)).toBeVisible();
    await page.screenshot({ path: join(directory, "editor.png") });
  });
});

test("team Chat makes every person a root and global pause controls remain available", async () => {
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
    ).toHaveAttribute("aria-level", "1");
    await expect(
      tree.getByRole("treeitem", { name: "Child", exact: true }),
    ).toHaveAttribute("aria-level", "1");
    const leadX = (await tree
      .getByRole("treeitem", { name: "Lead", exact: true })
      .locator(":scope > .team-chat-tree-row .team-chat-picker-avatar")
      .boundingBox())!.x;
    const childX = (await tree
      .getByRole("treeitem", { name: "Child", exact: true })
      .locator(":scope > .team-chat-tree-row .team-chat-picker-avatar")
      .boundingBox())!.x;
    expect(childX).toBe(leadX);
    await tree.getByRole("treeitem", { name: "Worker", exact: true }).click();
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
