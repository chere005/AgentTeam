import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

test("workflow graph: validation, command preview, branch on a failed check, human input, executed path, retry from the failed step, navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-graph-"));
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-graph-ws-")),
  );
  const marker = join(workspace, "ready.flag");
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    // Fixture data only: deterministic commands (node -e) and no provider run. The agent task steps are
    // never reached by the paths below, and live provider execution stays unavailable in test mode.
    await page.evaluate(
      async ([ws, flag]) => {
        const r = window.agentteam.request;
        const dev = await r("POST", "/agents", {
          name: "Dev",
          environment: "codex",
          workspaces: [{ path: ws, access: "write", active: true }],
        });
        const wf = await r("POST", "/workflows", {
          name: "Release checks",
          goal: "Exercise the workflow graph",
          ownerId: dev.id,
          completionCriteria: "done",
        });
        const cmd = (id: string, script: string) => ({
          id,
          type: "command",
          agentId: dev.id,
          argv: ["node", "-e", script],
          timeoutMs: 20000,
        });
        await r("POST", "/graphs", {
          workflowId: wf.id,
          name: "Tests gate",
          nodes: [
            cmd("tests", "process.stdout.write('2 failures');process.exit(1)"),
            {
              id: "gate",
              type: "condition",
              inputs: { passed: { from: "tests.passed", type: "boolean" } },
              expr: { left: { input: "passed" }, op: "truthy" },
            },
            {
              id: "ask",
              type: "human",
              prompt: "Tests failed. Send to the Builder?",
              choices: ["fix", "stop"],
              allowText: true,
            },
            {
              id: "review",
              type: "task",
              agentId: dev.id,
              title: "Review the change",
              completionCriteria: "d",
            },
            {
              id: "fix",
              type: "task",
              agentId: dev.id,
              title: "Fix the tests",
              completionCriteria: "d",
              inputs: { log: { from: "tests.stdout" } },
            },
          ],
          edges: [
            { from: "tests", to: "gate", on: "always" },
            { from: "gate", to: "review", on: "true" },
            { from: "gate", to: "ask", on: "false" },
            { from: "ask", to: "fix" },
          ],
        });
        await r("POST", "/graphs", {
          workflowId: wf.id,
          name: "Flaky check",
          nodes: [
            cmd(
              "check",
              `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 3)`,
            ),
            {
              id: "confirm",
              type: "condition",
              expr: { left: { value: true }, op: "truthy" },
            },
          ],
          edges: [{ from: "check", to: "confirm" }],
        });
      },
      [workspace, marker],
    );

    await openFeature(page, "Workflow graphs");
    const root = page.getByTestId("workflow-graphs");
    await expect(root.getByTestId("graph-item")).toHaveCount(2);

    // Static validation shows invalid cycles before anything runs.
    await root
      .getByTestId("graph-item")
      .filter({ hasText: "Flaky check" })
      .click();
    const editor = root.getByTestId("graph-editor");
    await expect(editor.getByTestId("graph-validation")).toContainText("Valid");
    await expect(editor.getByTestId("flow-node-check")).toBeVisible();
    await editor
      .getByTestId("edge-form")
      .getByLabel("Edge from")
      .selectOption("confirm");
    await editor
      .getByTestId("edge-form")
      .getByLabel("Edge to")
      .selectOption("check");
    await editor
      .getByTestId("edge-form")
      .getByLabel("Edge outcome")
      .selectOption("true");
    await editor.getByRole("button", { name: "Connect" }).click();
    await expect(editor.locator('[data-code="invalid_cycle"]')).toContainText(
      "Cycle",
    );
    await expect(editor.locator('[data-code="no_entry"]')).toBeVisible();
    await expect(editor.getByTestId("graph-validation")).toContainText(
      "block running",
    );
    await editor
      .getByTestId("graph-edge")
      .filter({ hasText: "confirm → check" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(editor.getByTestId("graph-validation")).toContainText("Valid");

    // A command is shown before it runs and needs confirmation.
    await root
      .getByTestId("graph-item")
      .filter({ hasText: "Tests gate" })
      .click();
    const preview = editor.getByTestId("command-preview");
    await expect(preview).toContainText("process.stdout.write");
    await expect(preview).toContainText("no shell");
    await expect(
      editor.getByRole("button", { name: "Start run" }),
    ).toBeDisabled();
    await preview.getByRole("checkbox").check();
    await editor.getByRole("button", { name: "Start run" }).click();
    const view = editor.getByTestId("run-view");
    // Live execution is off in test mode, so the deterministic step waits instead of running.
    await expect(
      view.getByTestId("run-node").filter({ hasText: "tests" }).first(),
    ).toContainText("live-execution-disabled");
    await page.evaluate(() =>
      window.agentteam.request("PUT", "/execution", { enabled: true }),
    );

    // tests fail -> condition false -> ask a human; the review task is not taken.
    await expect(view.getByTestId("human-input")).toContainText(
      "Send to the Builder?",
      { timeout: 15000 },
    );
    const path = view.getByTestId("graph-path");
    await expect(path.getByTestId("path-step")).toHaveCount(3);
    await expect(path.getByTestId("path-step").first()).toContainText("tests");
    await expect(path.getByTestId("path-step").first()).toContainText("failed");
    await expect(path.getByTestId("path-step").nth(1)).toContainText("false");
    await expect(path.getByTestId("path-step").nth(2)).toContainText("review");
    await expect(path.getByTestId("path-step").nth(2)).toContainText("skipped");
    await expect(editor.getByTestId("flow-node-gate")).toHaveAttribute(
      "data-state",
      "completed",
    );
    await view.getByLabel("Your answer").fill("yes, go ahead");
    await view
      .getByTestId("human-input")
      .getByRole("button", { name: "fix", exact: true })
      .click();
    await expect(
      view.getByTestId("run-node").filter({ hasText: "review" }).first(),
    ).toContainText("skipped");
    await expect(path.locator('[data-node="ask"]')).toContainText("completed");
    // The fix task was created through the normal task path (queued, never started here).
    const tasks = await page.evaluate(() =>
      window.agentteam.request("GET", "/snapshot"),
    );
    const fix = tasks.workflows[0].tasks.find(
      (t: { title: string }) => t.title === "Fix the tests",
    );
    expect(fix.status).toBe("queued");
    expect(fix.instructions).toContain("2 failures");
    expect(fix.instructions).toContain("untrusted-data");

    // Retry from the failed step: the flaky check fails, the run needs attention, then passes.
    await root
      .getByTestId("graph-item")
      .filter({ hasText: "Flaky check" })
      .click();
    await expect(editor.getByTestId("command-preview")).toBeVisible();
    await editor.getByTestId("command-preview").getByRole("checkbox").check();
    await editor.getByRole("button", { name: "Start run" }).click();
    const flaky = editor.getByTestId("run-view");
    await expect(flaky.getByTestId("run-status")).toHaveText("failed", {
      timeout: 15000,
    });
    await expect(flaky.getByTestId("run-attention")).toContainText(
      "check failed",
    );
    await expect(
      flaky.locator('[data-testid="path-step"][data-node="check"]').first(),
    ).toContainText("failed");
    await writeFile(marker, "ready");
    await flaky.getByRole("button", { name: "Retry from this step" }).click();
    await expect(flaky.getByTestId("run-status")).toHaveText("completed", {
      timeout: 15000,
    });
    const steps = flaky.getByTestId("path-step");
    await expect(
      flaky.locator('[data-testid="path-step"][data-node="check"]'),
    ).toHaveCount(2);
    await expect(steps.filter({ hasText: "attempt 2" })).toHaveCount(1);
    await expect(
      flaky.getByRole("button", { name: "Retry from this step" }),
    ).toHaveCount(0);

    // Navigate between the executable graph and the agent communication graph.
    await root
      .getByRole("button", { name: "Agent communication graph" })
      .click();
    await expect(
      page.getByRole("tab", { name: "Canvas", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("toolbar", { name: "Canvas" })).toBeVisible();
    // The graphs view stays open as a tab next to the canvas.
    await page
      .getByRole("tab", { name: "Workflow graphs", exact: true })
      .click();
    await expect(page.getByTestId("workflow-graphs")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
