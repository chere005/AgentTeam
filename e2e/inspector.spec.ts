import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    await page.getByRole("button", { name: /^Run inspector/ }).click();
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
      // Capture instead of opening a native save dialog.
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
    expect(await page.evaluate(() => (window as any).__downloads.length)).toBe(
      1,
    );

    // ---- canvas: open a connection to see its transfers -------------------------------------------
    await page.getByRole("button", { name: /^Team canvas/ }).click();
    // `force` skips Playwright's stability check, so wait until the canvas has finished its initial
    // fitView (the edge stops moving); a click on a still-moving edge can miss it under load.
    const edge = page.locator(".react-flow__edge").first();
    await expect(edge).toBeVisible();
    await expect
      .poll(async () => {
        const a = await edge.boundingBox();
        await page.waitForTimeout(120);
        const b = await edge.boundingBox();
        return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
      })
      .toBe(true);
    await edge.click({ force: true });
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
