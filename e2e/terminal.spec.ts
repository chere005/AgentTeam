import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// Terminal tab: a real PTY in the main process (src/terminal.ts) rendered by xterm.js. Temp
// AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1, hidden window; SHELL=/bin/sh keeps the user's own
// shell startup files out of the run.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );
const mod = process.platform === "darwin" ? "Meta" : "Control";
/** Counts matches of `text` in the active terminal's buffer through the search bar. */
async function matches(page: Page, text: string) {
  const search = page.getByRole("textbox", { name: "Search terminal output" });
  if (!(await search.count()))
    await page.getByRole("button", { name: "Find in terminal" }).click();
  await search.fill("");
  await search.fill(text);
  return page.locator(".terminal-count");
}

test("terminal tab: real shell, output, search, sub-tabs, folder rules and no orphaned PTYs", async () => {
  test.setTimeout(90_000);
  const directory = realpathSync(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-terminal-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
    },
  });
  const pids: number[] = [];
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    await api(page, "POST", "/agents", {
      name: "Builder",
      environment: "codex",
      workspaces: [{ path: project, access: "write", active: true }],
    });

    await openFeature(page, "Terminal");
    const pane = page.getByTestId("terminal-pane");
    await expect(pane).toContainText("your own shell");
    const sessions = pane.getByRole("tablist", { name: "Terminal sessions" });
    await expect(sessions.getByRole("tab")).toHaveCount(1);
    await expect(sessions.getByRole("tab").first()).toHaveText("~");
    await expect(pane.locator(".terminal-host .xterm")).toHaveCount(1);
    await pane.locator(".terminal-host:not([hidden]) .xterm").click();
    await page.keyboard.type("echo agentteam-ok");
    await page.keyboard.press("Enter");
    // The typed command line is one match; the shell's output line is the second.
    await expect(await matches(page, "agentteam-ok")).toHaveText(/of 2$/, {
      timeout: 15_000,
    });

    // Cmd/Ctrl+F from inside the terminal opens (focuses) the search box.
    await page.getByRole("button", { name: "Close search" }).click();
    await pane.locator(".terminal-host:not([hidden]) .xterm").click();
    await page.keyboard.press(`${mod}+f`);
    await expect(
      page.getByRole("textbox", { name: "Search terminal output" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");

    // A second session in the agent's folder; the shell really starts there.
    await pane
      .getByRole("combobox", { name: "Folder for new terminals" })
      .selectOption({ label: "Builder: project" });
    await pane.getByRole("button", { name: "New terminal" }).click();
    await expect(sessions.getByRole("tab")).toHaveCount(2);
    await expect(sessions.getByRole("tab").nth(1)).toHaveText("project");
    await expect(sessions.getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await pane.locator(".terminal-host:not([hidden]) .xterm").click();
    await page.keyboard.type(
      process.platform === "win32" ? "(Get-Location).Path" : "pwd",
    );
    await page.keyboard.press("Enter");
    await expect(await matches(page, project)).toHaveText(/of [1-9]/, {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Close search" }).click();

    // Switching feature tabs keeps the sessions and their scrollback.
    await openFeature(page, "Layout");
    await openFeature(page, "Terminal");
    await expect(sessions.getByRole("tab")).toHaveCount(2);
    await sessions.getByRole("tab").first().click();
    await expect(await matches(page, "agentteam-ok")).toHaveText(/of 2$/);
    await page.getByRole("button", { name: "Close search" }).click();

    // The bridge refuses folders that are neither home nor attached, and bad sizes.
    const refused = await page.evaluate(async () => {
      const t = window.agentteam.terminal!;
      const out: string[] = [];
      for (const options of [
        { cwd: "/", cols: 80, rows: 24 },
        { cwd: null, cols: 0, rows: 24 },
        { cwd: null, cols: 80, rows: 24, shell: "/bin/bash" } as never,
      ])
        await t.create(options).then(
          () => out.push("created"),
          (e) => out.push(String(e.message)),
        );
      return out;
    });
    expect(refused).toHaveLength(3);
    expect(refused.join("\n")).not.toContain("created");
    expect(refused[0]).toContain("home folder or a folder attached");

    // Closing a sub-tab ends its shell.
    const extra = await page.evaluate(() =>
      window.agentteam.terminal!.create({ cwd: null, cols: 80, rows: 24 }),
    );
    pids.push(extra.pid);
    await sessions
      .getByRole("button", { name: /^Close terminal project/ })
      .click();
    await expect(sessions.getByRole("tab")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    // Quitting the app ends every PTY it started (including one the UI never showed).
    for (const pid of pids)
      await expect
        .poll(
          () => {
            try {
              process.kill(pid, 0);
              return "alive";
            } catch {
              return "gone";
            }
          },
          { timeout: 10_000 },
        )
        .toBe("gone");
    await rm(directory, { recursive: true, force: true });
  }
});
