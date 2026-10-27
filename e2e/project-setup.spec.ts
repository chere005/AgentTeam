import { test, expect, _electron as electron } from "@playwright/test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

test.skip(
  process.platform === "win32",
  "The scripted shell fixtures use POSIX executable files",
);

test("a fresh pipeline chat offers one folder setup, then starts the saved request once", async ({}, info) => {
  test.setTimeout(90_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-setup-")),
  );
  const workspace = join(directory, "pi-project");
  const bin = join(directory, "bin");
  await mkdir(workspace);
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
  console.log(JSON.stringify({ type: "system", session_id: "setup-fixture-session" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{type: "text", text: "This fixture leaves implementation to the saved assignment. Choose the project folder to continue."}] } }));
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
        return { teamId: team.teamId, plannerId: planner.id };
      },
      { claude, codex },
    );
    const side = page.getByRole("complementary", { name: "Side panel" });
    await side.getByLabel("Agent", { exact: true }).selectOption(ids.plannerId);
    await expect(side.getByTestId("delegation-setup-notice")).toContainText(
      "This team runs projects",
    );
    const request =
      "Have the developers make a Python program that computes pi to 500 significant digits, run it, and have the reviewers pass it back until approved.";
    await side.getByLabel("Message", { exact: true }).fill(request);
    await side.getByLabel("Message", { exact: true }).press("Enter");
    const card = side.getByTestId("project-setup-card").first();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("setup-blockers")).toContainText(
      "Pipeline Integrator",
    );
    const workflowId = await card.getAttribute("data-workflow-id");
    const before = await page.evaluate(
      async ({ workflowId, plannerId }) => {
        const r = window.agentteam.request;
        const snapshot = await r("GET", "/snapshot");
        const events = await r("GET", "/events");
        const workflow = snapshot.workflows.find(
          (w: { id: string }) => w.id === workflowId,
        );
        return {
          workerTasks: workflow.tasks.filter(
            (t: { agentId: string }) => t.agentId !== plannerId,
          ),
          workerStarts: events.filter(
            (e: { type: string; data?: { agentId?: string } }) =>
              e.type === "task.settings" && e.data?.agentId !== plannerId,
          ),
        };
      },
      { workflowId, plannerId: ids.plannerId },
    );
    expect(before.workerTasks).toEqual([]);
    expect(before.workerStarts).toEqual([]);
    expect(await readFile(calls, "utf8")).toBe("");
    await card.getByLabel("Project folder", { exact: true }).fill(workspace);
    await card.getByTestId("setup-apply").click();
    await expect(card).toContainText("Ready");
    const start = card.getByTestId("setup-start");
    await expect(start).toBeEnabled();
    await page.screenshot({ path: info.outputPath("project-setup-ready.png") });
    await start.click({ clickCount: 2 });
    await expect(start).toBeDisabled();
    await expect(card).toContainText("Request started");
    const starts = await page.evaluate(
      async (workflowId) =>
        (await window.agentteam.request("GET", "/events")).filter(
          (e: { type: string; entityId: string }) =>
            e.type === "execution.project_started" && e.entityId === workflowId,
        ).length,
      workflowId,
    );
    expect(starts).toBe(1);
    const prepared = await page.evaluate(
      (workflowId) =>
        window.agentteam.request("GET", `/projects/${workflowId}/setup`),
      workflowId,
    );
    expect(prepared.executionProject.outputs).toHaveLength(1);
    expect(
      new Set(
        prepared.executionProject.outputs.map(
          (output: { taskId: string }) => output.taskId,
        ),
      ).size,
    ).toBe(1);
    await expect
      .poll(
        async () =>
          (await readFile(calls, "utf8")).split("\n").filter(Boolean).length,
      )
      .toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
