import { execFileSync } from "node:child_process";
import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// The four permanent main views (Layout, Chat, Files, Diff) and Projects on this platform, with
// the things that differ between macOS, Windows and Linux: a project folder whose name has a
// space and non-ASCII letters, a CRLF file, Git without inherited configuration, and the
// Ctrl/Cmd+1-4 shortcuts. Hidden window (AGENTTEAM_TEST=1), temporary data, no provider runs.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );
const tab = (page: Page, name: string) =>
  page
    .getByRole("tablist", { name: "Main views and open features" })
    .getByRole("tab", { name, exact: true });

test("the four main views show the current project's agent, chat, files and changes", async ({}, info) => {
  test.setTimeout(90_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-views-")),
  );
  const root = join(directory, "Pi démo project");
  await mkdir(join(root, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.autocrlf=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(directory, "empty.gitconfig"),
        },
      },
    );
  await writeFile(join(directory, "empty.gitconfig"), "");
  await writeFile(join(root, "README.md"), "# Pi demo\n");
  await writeFile(join(root, "notes.txt"), "line one\r\nline two\r\n");
  await writeFile(join(root, "src", "pi.ts"), "export const digits = 3;\n");
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "base");
  // An uncommitted change for Diff.
  await writeFile(
    join(root, "src", "pi.ts"),
    "export const digits = 3;\nexport const pi = 3.14;\n",
  );

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
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const agent = await api(page, "POST", "/agents", {
      name: "Pi builder",
      environment: "codex",
      workspaces: [{ path: root, access: "write", active: true }],
    });
    const project = await api(page, "POST", "/workflows", {
      name: "Pi demo",
      goal: "Compute pi",
      ownerId: agent.id,
      completionCriteria: "Digits are right",
    });
    await api(page, "POST", "/tasks", {
      workflowId: project.id,
      agentId: agent.id,
      title: "Write pi.ts",
      completionCriteria: "pi.ts exists",
    });
    // A queued message (execution stays paused in test mode, so nothing runs).
    const session = await api(page, "POST", `/agents/${agent.id}/session`);
    await api(page, "POST", `/sessions/${session.id}/messages`, {
      text: "Please add more digits of pi",
    });
    await page.reload();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const picker = page.getByLabel("Current project");
    await picker.selectOption(project.id);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const show = async (index: number, name: string) => {
      await page.keyboard.press(`${modifier}+${index}`);
      await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
      await expect(picker).toHaveValue(project.id);
    };

    // 1 Layout: the agent's card on the canvas.
    await show(1, "Layout");
    await expect(
      page.locator(".react-flow__node", { hasText: "Pi builder" }).first(),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("1-layout.png") });

    // 2 Chat: the agent in the conversation tree and its queued message.
    await show(2, "Chat");
    const conversations = page.getByRole("navigation", {
      name: "Team conversations",
    });
    await expect(conversations).toBeVisible();
    await conversations.getByText("Pi builder").first().click();
    const conversation = page.getByRole("region", { name: "Conversation" });
    await expect(
      conversation.getByText("Please add more digits of pi"),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("2-chat.png") });

    // 3 Files: the project folder (space, non-ASCII) with its files; a CRLF file opens.
    await show(3, "Files");
    const files = page.getByRole("complementary", {
      name: "Agent folders and files",
    });
    await expect(
      files.getByRole("treeitem", { name: "README.md", exact: true }),
    ).toBeVisible();
    await files
      .getByRole("treeitem", { name: "notes.txt", exact: true })
      .click();
    await expect(page.getByText("line two").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("3-files.png") });

    // 4 Diff: the uncommitted change, its file listed beside the patch.
    await show(4, "Diff");
    await expect(page.getByText("src/pi.ts").first()).toBeVisible();
    await expect(
      page.getByText("export const pi = 3.14;").first(),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("4-diff.png") });

    // Projects (a feature tab): the project's card with its task.
    await openFeature(page, "Projects");
    await expect(tab(page, "Projects")).toHaveAttribute("aria-selected", "true");
    const card = page
      .locator(".project-card")
      .filter({ has: page.getByRole("heading", { name: "Pi demo" }) });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Write pi.ts");
    await page.screenshot({ path: info.outputPath("5-projects.png") });

    // And back to Layout without losing the project.
    await show(1, "Layout");
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
});
