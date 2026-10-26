import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openFeature } from "./helpers";

// Readiness strip and Sign in (src/readiness.ts, ui/components/ReadinessStrip.tsx). Fixture
// installation only: the Codex fixture (test/fixtures/codex-fixture.mjs) is the manual override,
// discovery searches only a PATH holding node, so the developer's real Claude/Codex installs and
// accounts are never touched. AGENTTEAM_AUTO_RESCAN=1 opts this test-mode app into the automatic
// rescans; the fixture reports signed out until its `login` (typed into the Terminal tab by Sign
// in) creates CODEX_FIXTURE_AUTH_FILE.
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );

async function setup(signedOut: boolean) {
  const directory = realpathSync(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-ready-")),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  const source = join(process.cwd(), "test", "fixtures", "codex-fixture.mjs");
  let codex: string;
  let path: string;
  if (process.platform === "win32") {
    // An npm-style shim: AgentTeam runs the Node script it wraps; PowerShell runs it via cmd.
    await copyFile(source, join(bin, "codex-fixture.mjs"));
    codex = join(bin, "codex.cmd");
    await writeFile(codex, '@node "%~dp0\\codex-fixture.mjs" %*\r\n');
    const root = process.env.SystemRoot ?? "C:\\Windows";
    path = [dirname(process.execPath), join(root, "System32"), root].join(";");
  } else {
    codex = join(bin, "codex-fixture");
    await copyFile(source, codex);
    await chmod(codex, 0o755);
    const nodeOnly = join(directory, "node-only");
    await mkdir(nodeOnly);
    // The fixture's `#!/usr/bin/env node` shebang needs node on PATH; nothing else is there.
    await symlink(process.execPath, join(nodeOnly, "node"));
    path = nodeOnly;
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^path$/i.test(k)) env[k] = v;
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...env,
      PATH: path,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_DISCOVERY_PATH_ONLY: "1",
      AGENTTEAM_AUTO_RESCAN: "1",
      CODEX_FIXTURE_AUTH_FILE: join(directory, "codex-auth"),
      ...(signedOut ? { CODEX_FIXTURE_SIGNED_OUT: "1" } : {}),
      ...(process.platform === "win32" ? {} : { SHELL: "/bin/sh" }),
    },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("workspace-ready")).toBeVisible();
  return {
    app,
    page,
    errors,
    codex,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    },
  };
}

test("a signed-out runtime shows in the readiness strip; Sign in opens a terminal and the strip clears by itself", async () => {
  test.setTimeout(120_000);
  const { page, errors, codex, cleanup } = await setup(true);
  try {
    const strip = page.getByTestId("readiness-strip");
    // Test mode never scans by itself before the first scan: nothing is claimed yet.
    await expect(strip).toHaveCount(0);
    // The Team Assistant uses Codex; the fixture is installed but signed out.
    await api(page, "PUT", "/runtimes/codex", { path: codex });
    await expect(strip).toContainText("Codex: sign in needed");
    // Claude Code is not found, but no agent of this team uses it.
    await expect(strip).not.toContainText("Claude Code");
    const signIn = strip.getByRole("button", { name: "Sign in" });
    await expect(signIn).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("readiness-strip.png"),
    });
    await signIn.click();

    await expect(
      page
        .getByRole("tablist", { name: "Main views and open features" })
        .getByRole("tab", { name: "Terminal" }),
    ).toHaveAttribute("aria-selected", "true");
    const pane = page.getByTestId("terminal-pane");
    if (!(await page.evaluate(() => !!window.agentteam.terminal))) {
      await expect(pane).toContainText("only available in the desktop app");
      return;
    }
    // A new shell in the home folder; the backend's command line is typed into it.
    const sessions = pane.getByRole("tablist", { name: "Terminal sessions" });
    await expect(sessions.getByRole("tab")).toHaveCount(1);
    await expect(sessions.getByRole("tab").first()).toHaveText("~");
    await expect(strip).toContainText("Codex: waiting for sign-in…");
    // The fixture's `login` ran in the shell; the 5 s rescan notices without Rescan.
    await expect(strip).toHaveCount(0, { timeout: 45_000 });
    await openFeature(page, "Settings");
    await expect(page.getByTestId("runtime-badge-codex")).toHaveText(
      "Installed · signed in",
    );
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("a signed-in runtime shows no readiness strip", async () => {
  const { page, errors, codex, cleanup } = await setup(false);
  try {
    await api(page, "PUT", "/runtimes/codex", { path: codex });
    await openFeature(page, "Settings");
    await expect(page.getByTestId("runtime-badge-codex")).toHaveText(
      "Installed · signed in",
    );
    await expect(page.getByTestId("readiness-strip")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await cleanup();
  }
});
