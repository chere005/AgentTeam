import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

test("run inspector: timeline, wait explainer, transfers, previews, playground compare and redacted export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-inspector-"));
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
    // Fixture data only: AGENTTEAM_TEST keeps live execution off; states are driven through the API.
    await page.evaluate(async () => {
      const r = window.agentteam.request;
      const planner = await r("POST", "/agents", {
        name: "Planner",
        environment: "codex",
        model: "model-a",
      });
      const builder = await r("POST", "/agents", {
        name: "Builder",
        environment: "codex",
      });
      await r("POST", "/edges", {
        from: planner.id,
        to: builder.id,
        kind: "delegate",
      });
      const wf = await r("POST", "/workflows", {
        name: "Inspected run",
        goal: "Exercise the inspector",
        ownerId: planner.id,
        completionCriteria: "done",
      });
      const done = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: builder.id,
        invokedBy: planner.id,
        title: "Write the parser",
        instructions: "Parse the input file",
        completionCriteria: "d",
      });
      await r("POST", `/tasks/${done.id}/status`, { status: "running" });
      await r("POST", `/tasks/${done.id}/status`, {
        status: "completed",
        result: "Parser written",
      });
      const blocker = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: planner.id,
        title: "Unfinished prerequisite",
        completionCriteria: "d",
      });
      await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: builder.id,
        title: "Wait for prerequisite",
        completionCriteria: "d",
        dependsOn: [blocker.id],
      });
    });
    await openFeature(page, "Timeline & inspector");
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toBeVisible();

    // ---- timeline: correlated entries, filters, no matches ----------------------------------
    await expect(page.getByTestId("timeline-entry").first()).toBeVisible();
    await expect(page.getByTestId("timeline-count")).toContainText(
      "correlation group",
    );
    await expect(
      page.getByTestId("timeline-entry").filter({ hasText: "Task completed" }),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("timeline-entry")
        .filter({ hasText: "Run settings: codex / default" }),
    ).toHaveCount(1);
    await inspector.getByLabel("Event type").fill("lock");
    await expect(page.getByTestId("timeline-entry")).toHaveCount(2);
    await inspector.getByLabel("Severity").selectOption("error");
    await expect(
      page.getByText("No events match these filters."),
    ).toBeVisible();
    await inspector.getByLabel("Severity").selectOption("info");
    await inspector.getByLabel("Event type").fill("");
    await inspector.getByLabel("Agent").selectOption({ label: "Builder" });
    await expect(page.getByTestId("timeline-entry").first()).toBeVisible();

    // ---- why is this waiting? ---------------------------------------------------------------
    await page.getByRole("tab", { name: "Why waiting" }).click();
    const waiting = page
      .getByTestId("waiting-task")
      .filter({ hasText: "Wait for prerequisite" });
    await expect(waiting).toContainText("Waiting for 1 dependency");
    await waiting.getByRole("button", { name: "Why is this waiting?" }).click();
    await expect(page.getByTestId("reason-dependencies")).toContainText(
      "Unfinished prerequisite",
    );
    await expect(page.getByTestId("reason-live-disabled")).toContainText(
      "Live execution is paused",
    );
    await expect(page.getByTestId("reason-queue-position")).toBeVisible();

    // ---- transfers ----------------------------------------------------------------------------
    await page.getByRole("tab", { name: "Transfers" }).click();
    const transfer = page.getByTestId("transfer-detail");
    await expect(transfer.getByTestId("transfer-request")).toContainText(
      "Write the parser",
    );
    await expect(transfer.getByTestId("transfer-response")).toContainText(
      "Parser written",
    );
    await expect(transfer.getByTestId("transfer-duration")).toContainText(" s");
    await expect(transfer.getByTestId("transfer-rule")).toContainText(
      "Delegation edge",
    );
    // The routing decision was recorded when the task was created, not inferred.
    await expect(transfer.getByTestId("transfer-rule")).toContainText(
      "Recorded when the task was created",
    );

    // ---- routing + access preview -------------------------------------------------------------
    await page.getByRole("tab", { name: "Preview" }).click();
    await page.getByLabel("Request text").fill("please build it");
    await page
      .getByLabel("Explicit recipient")
      .selectOption({ label: "Builder" });
    await page
      .getByLabel(/Paths to check/)
      .fill("write /definitely/outside/file.txt");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByTestId("preview-routing")).toContainText("selected");
    await expect(page.getByTestId("access-decisions")).toContainText(
      "Outside every folder attached to this agent",
    );
    await expect(page.getByTestId("preview")).toContainText(
      "sandbox enforcement is not implemented",
    );

    // ---- playground: fixture-only runs and comparison -------------------------------------------
    await page.getByRole("tab", { name: "Playground" }).click();
    await expect(page.getByTestId("playground-notice")).toContainText(
      "scripted fixture output only",
    );
    await page.getByText("Create or edit an example").click();
    await page.getByLabel("Example definition").fill(
      JSON.stringify({
        name: "Plan then build",
        tasks: [
          { key: "plan", title: "Plan", agent: "Planner" },
          {
            key: "build",
            title: "Build",
            agent: "Builder",
            dependsOn: ["plan"],
          },
        ],
        fixture: {
          Planner: { text: "PLAN: one step" },
          Builder: { text: "BUILT" },
        },
        expected: {
          workflowStatus: "completed",
          tasks: { plan: { status: "completed", resultIncludes: ["PLAN"] } },
        },
      }),
    );
    await page.getByRole("button", { name: "Save example" }).click();
    const example = page
      .getByTestId("example")
      .filter({ hasText: "Plan then build" });
    await expect(example).toBeVisible();
    await example.getByRole("button", { name: "Run (fixture)" }).click();
    await expect(page.getByTestId("run-expectations").first()).toHaveText(
      "expectations met",
    );
    await expect(page.getByTestId("run-outcome").first()).toContainText(
      "PLAN: one step",
    );
    await page.getByLabel("Run overrides").fill(
      JSON.stringify({
        agents: { Planner: { model: "model-b" } },
        fixture: {
          Planner: { text: "changed plan" },
          Builder: { text: "BUILT" },
        },
      }),
    );
    await example.getByRole("button", { name: "Run (fixture)" }).click();
    await expect(page.getByTestId("run-row")).toHaveCount(2);
    await expect(page.getByTestId("run-expectations").first()).toHaveText(
      "expectations missed",
    );
    for (const row of await page.getByTestId("run-row").all())
      await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Compare selected runs" }).click();
    await expect(page.getByTestId("diff-summary")).toContainText(
      "Configuration changed",
    );
    await expect(page.getByTestId("run-diff")).toContainText("model-b");
    await expect(page.getByTestId("run-diff")).toContainText("changed plan");

    // ---- redacted export ------------------------------------------------------------------------
    await page.evaluate(() => {
      // The desktop app saves through the main process; a blob download must not happen.
      (window as any).__downloads = [];
      HTMLAnchorElement.prototype.click = function () {
        (window as any).__downloads.push(this.download);
      };
    });
    await page.getByRole("tab", { name: "Export" }).click();
    await page.getByRole("button", { name: "Export redacted bundle" }).click();
    await expect(page.getByTestId("export-name")).toContainText(".zip");
    await expect(page.getByTestId("export-result")).toContainText(
      "timeline.json",
    );
    await expect(page.getByTestId("export-result")).toContainText("Redacted:");
    // Test mode: the main-process Save as… recorded the save instead of opening a dialog.
    await expect(page.getByTestId("export-result")).toContainText(
      "test mode: recorded, not written",
    );
    expect(await page.evaluate(() => (window as any).__downloads.length)).toBe(
      0,
    );
    const saves = await page.evaluate(async () => {
      const r = await window.agentteam.request("GET", "/test/launches");
      return r.launches.filter((l: { kind: string }) => l.kind === "save-as");
    });
    expect(saves).toHaveLength(1);
    expect(saves[0].filename).toMatch(/^agentteam-diagnostics-.*\.zip$/);
    expect(saves[0].bytes).toBeGreaterThan(100);
    // The renderer may only name a format; it cannot pass content or a path.
    await expect(
      page.evaluate(() =>
        window.agentteam.saveDiagnostics!({
          format: "zip",
          path: "/tmp/x",
        } as never),
      ),
    ).rejects.toThrow();
    await expect(
      page.evaluate(() => window.agentteam.saveDiagnostics!("exe" as never)),
    ).rejects.toThrow();

    // ---- canvas: open a connection to see its transfers -------------------------------------------
    await openFeature(page, "Canvas");
    // Dispatch the click on the edge element itself rather than at its bounding-box centre. A
    // coordinate click was flaky in full-suite runs (2 of 3 runs once): the canvas keeps moving the
    // edge after it looked stable (initial fitView once nodes are measured, cards growing as their
    // data loads), so the centre could land on the empty pane. The React Flow onEdgeClick handler
    // still runs; what this test checks is the dialog's transfer history.
    const edge = page.locator(".react-flow__edge").first();
    await expect(edge).toBeVisible();
    await edge.dispatchEvent("click");
    const dialog = page.getByRole("dialog", { name: "Connection settings" });
    await expect(
      dialog.getByText("Transfers on this connection"),
    ).toBeVisible();
    await expect(dialog.getByTestId("transfer-request")).toContainText(
      "Write the parser",
    );
    await expect(dialog.getByTestId("transfer-response")).toContainText(
      "Parser written",
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("playground: per-run routing-rule overrides show up in the run comparison", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-rules-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const ruleId = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const lead = await r("POST", "/agents", {
        name: "Lead",
        environment: "codex",
      });
      const builder = await r("POST", "/agents", {
        name: "Builder",
        environment: "codex",
      });
      await r("POST", "/edges", {
        from: lead.id,
        to: builder.id,
        kind: "delegate",
      });
      const rule = await r("POST", "/rules", {
        agentId: lead.id,
        scope: "action",
        targetId: builder.id,
        priority: 50,
        kind: "delegate",
        match: { textIncludes: ["compile"] },
      });
      await r("POST", "/inspector/examples", {
        name: "Delegate build",
        tasks: [
          { key: "plan", title: "Plan", agent: "Lead" },
          {
            key: "build",
            title: "compile the project",
            agent: "Builder",
            invokedBy: "Lead",
          },
        ],
        fixture: {},
        expected: { workflowStatus: "completed" },
      });
      return rule.id as string;
    });
    await openFeature(page, "Timeline & inspector");
    await page.getByRole("tab", { name: "Playground" }).click();
    const example = page
      .getByTestId("example")
      .filter({ hasText: "Delegate build" });
    await example.getByRole("button", { name: "Run (fixture)" }).click();
    await expect(page.getByTestId("run-row")).toHaveCount(1);
    await page
      .getByLabel("Run overrides")
      .fill(JSON.stringify({ rules: { disable: [ruleId] } }));
    await example.getByRole("button", { name: "Run (fixture)" }).click();
    await expect(page.getByTestId("run-row")).toHaveCount(2);
    for (const row of await page.getByTestId("run-row").all())
      await row.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Compare selected runs" }).click();
    await expect(page.getByTestId("diff-summary")).toContainText(
      "routing decisions differ for 1 task",
    );
    await expect(page.getByTestId("rule-overrides")).toContainText(
      "disabled action rule on Lead -> Builder",
    );
    await expect(page.getByTestId("routing-changed")).toContainText(
      /(selected → unmatched|unmatched → selected)/,
    );
    // A bad override is explained, not silently ignored.
    await page
      .getByLabel("Run overrides")
      .fill(JSON.stringify({ rules: { disable: ["no-such-rule"] } }));
    await example.getByRole("button", { name: "Run (fixture)" }).click();
    await expect(page.getByRole("alert").first()).toContainText("unknown rule");
    await expect(page.getByTestId("run-row")).toHaveCount(2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
