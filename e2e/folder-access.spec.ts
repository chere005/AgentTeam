import { test, expect, _electron as electron } from "@playwright/test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

test.skip(
  process.platform === "win32",
  "The scripted shell fixtures use POSIX executable files",
);

// The installed 0.6.0 app applied ~/Desktop to twelve roles and started three workers that could
// not write one byte, because macOS folder privacy refuses the app and every process it starts
// there until the person allows it. The setup card now asks the system: the denial is injected
// here (AGENTTEAM_TEST_FOLDER_DENY, honoured only under AGENTTEAM_TEST=1) so the card's blocker
// text with the macOS fix can be checked on any platform, with temporary folders only.
test("a folder the system refuses is explained on the setup card with the macOS fix, Start waits, and another folder makes it ready", async ({}, info) => {
  test.setTimeout(120_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-folder-")),
  );
  const denied = join(directory, "desktop-like");
  const chosen = join(directory, "chosen-with-the-native-picker");
  const bin = join(directory, "bin");
  const projects = join(directory, "AgentTeam Projects");
  await mkdir(denied);
  await mkdir(chosen);
  await mkdir(bin);
  const claude = join(bin, "claude-fixture");
  const codex = join(bin, "codex-fixture");
  const calls = join(directory, "provider-calls.txt");
  await writeFile(calls, "");
  await writeFile(
    claude,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("2.1.41 (Claude Code)"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
appendFileSync(${JSON.stringify(calls)}, "run\\n");
let input = "";
process.stdin.on("data", (data) => input += data);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "system", session_id: "folder-fixture-session" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{type: "text", text: "Choose the project folder to continue."}] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", usage: {} }));
});
`,
  );
  await copyFile(join(process.cwd(), "test/fixtures/codex-fixture.mjs"), codex);
  await chmod(claude, 0o755);
  await chmod(codex, 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^path$/i.test(key)) env[key] = value;
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...env,
      PATH: dirname(process.execPath),
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_DISCOVERY_PATH_ONLY: "1",
      AGENTTEAM_TEST_FOLDER_DENY: denied,
      AGENTTEAM_PROJECTS_DIR: projects,
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const ids = await page.evaluate(
      async ({ claude, codex }) => {
        const r = window.agentteam.request;
        await r("PUT", "/runtimes/claude", { path: claude });
        await r("PUT", "/runtimes/codex", { path: codex });
        const team = await r(
          "POST",
          "/teams/examples/pipeline-review-team/insert",
          {
            options: { implementationWorkers: 1, fixWorkers: 1 },
            acceptUnverifiedModels: true,
          },
        );
        const snapshot = await r("GET", "/snapshot");
        const planner = snapshot.agents.find(
          (a: { teamId?: string; name: string }) =>
            a.teamId === team.teamId && a.name.startsWith("Pipeline Planner"),
        );
        await r("PUT", "/execution", { enabled: true });
        return { plannerId: planner.id };
      },
      { claude, codex },
    );
    const side = page.getByRole("complementary", { name: "Side panel" });
    await side.getByLabel("Agent", { exact: true }).selectOption(ids.plannerId);
    const message = side.getByLabel("Message", { exact: true });
    await message.fill(
      "Have the developers make a Python program that computes pi to 500 significant digits, run it, and have the reviewers pass it back until approved.",
    );
    await message.press("Enter");
    const card = side.getByTestId("project-setup-card").first();
    await expect(card).toBeVisible();
    const folderField = card.getByLabel("Project folder", { exact: true });
    // AgentTeam proposes a new folder of its own, never one inside Desktop, Documents or Downloads.
    await expect(folderField).toHaveValue(
      join(projects, "have-the-developers-make-a-python"),
    );
    await expect(card).toContainText(
      "AgentTeam creates this folder when you apply",
    );

    // A typed path stays possible: the system is asked when the field is left.
    await folderField.fill(denied);
    await folderField.blur();
    const problem = card.getByTestId("setup-folder-check");
    await expect(problem).toBeVisible();
    await expect(problem).toContainText(
      "macOS has not allowed AgentTeam to access this folder",
    );
    await expect(problem).toContainText(
      "System Settings → Privacy & Security → Files and Folders → AgentTeam",
    );
    await expect(problem).toContainText(denied);
    await expect(problem).toContainText("EPERM");
    await page.screenshot({ path: info.outputPath("folder-denied.png") });

    // Apply is refused by the same answer; nothing was granted and Start stays disabled.
    await card.getByTestId("setup-apply").click();
    await expect(problem).toBeVisible();
    await expect(card.getByTestId("setup-start")).toBeDisabled();
    await expect(card).toContainText("Setup required");
    const granted = await page.evaluate(async () =>
      (await window.agentteam.request("GET", "/snapshot")).agents.flatMap(
        (a: { workspaces: unknown[] }) => a.workspaces,
      ),
    );
    expect(granted).toEqual([]);
    expect(
      (
        await page.evaluate(() => window.agentteam.request("GET", "/events"))
      ).filter((e: { type: string }) => e.type === "project.setup_applied")
        .length,
    ).toBe(0);

    // "Check again" asks the system anew: allowed in System Settings, it passes (the injected
    // refusal is lifted in the app's process, as the person would lift the real one).
    await app.evaluate(() => {
      process.env.AGENTTEAM_TEST_FOLDER_DENY = "";
    });
    await problem.getByRole("button", { name: "Check again" }).click();
    await expect(problem).toHaveCount(0);
    await expect(
      card
        .getByRole("status")
        .filter({ hasText: "AgentTeam can use this folder" }),
    ).toBeVisible();
    await app.evaluate((_electron, folder) => {
      process.env.AGENTTEAM_TEST_FOLDER_DENY = folder;
    }, denied);

    // The blocker's "Choose project folder" opens the native picker (stubbed in the main
    // process), so a folder the person picks in the system dialog is the one used.
    await app.evaluate(({ dialog }, folder) => {
      const g = globalThis as { pickerCalls?: number };
      g.pickerCalls = 0;
      dialog.showOpenDialog = (async () => {
        g.pickerCalls = (g.pickerCalls ?? 0) + 1;
        return { canceled: false, filePaths: [folder] };
      }) as typeof dialog.showOpenDialog;
    }, chosen);
    await card.getByText(/participants need setup/).click();
    await card
      .getByTestId("setup-blockers")
      .getByRole("button", { name: "Choose project folder" })
      .first()
      .click();
    await expect(folderField).toHaveValue(chosen);
    expect(
      await app.evaluate(
        () => (globalThis as { pickerCalls?: number }).pickerCalls,
      ),
    ).toBe(1);
    await expect(
      card
        .getByRole("status")
        .filter({ hasText: "AgentTeam can use this folder" }),
    ).toBeVisible();
    await card.getByTestId("setup-apply").click();
    await expect(card).toContainText("Ready");
    await expect(card.getByTestId("setup-start")).toBeEnabled();
    await page.screenshot({ path: info.outputPath("folder-ready.png") });

    // Nothing started: no provider call was spent on any of it.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(calls, "utf8")).toBe("");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
