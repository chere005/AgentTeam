import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("failed sandbox startup names the blocked prerequisite and opens safe recovery", async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-blocked-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const work = await page.evaluate(async () => {
      const request = window.agentteam.request;
      const manager = await request("POST", "/agents", {
        name: "Roll-call Planner",
        environment: "codex",
        roleType: "coordinator",
        maxConcurrentInvocations: 1,
      });
      const writer = await request("POST", "/agents", {
        name: "Roll-call Integrator",
        environment: "claude",
        roleType: "implementer",
      });
      const reporter = await request("POST", "/agents", {
        name: "Roll-call Reporter",
        environment: "claude",
        roleType: "implementer",
      });
      for (const child of [writer, reporter])
        await request("POST", "/edges", {
          from: manager.id,
          to: child.id,
          kind: "delegate",
        });
      const workflow = await request("POST", "/workflows", {
        name: "Blocked roll call",
        goal: "Create roll-call files",
        ownerId: manager.id,
        completionCriteria: "Files verified",
      });
      const parent = await request("POST", "/tasks", {
        workflowId: workflow.id,
        agentId: manager.id,
        title: "Coordinate roll call",
        completionCriteria: "Files verified",
      });
      await request("POST", `/tasks/${parent.id}/status`, {
        status: "running",
      });
      const first = await request("POST", "/orchestration/invoke", {
        fromAgentId: manager.id,
        taskId: parent.id,
        recipient: writer.id,
        title: "Create Integrator.txt",
        completionCriteria: "File verified",
      });
      const second = await request("POST", "/orchestration/invoke", {
        fromAgentId: manager.id,
        taskId: parent.id,
        recipient: reporter.id,
        title: "Create Reporter.txt",
        dependsOn: [first.childTaskId],
        completionCriteria: "File verified",
      });
      await request("POST", `/tasks/${first.childTaskId}/status`, {
        status: "running",
      });
      await request("POST", `/tasks/${first.childTaskId}/status`, {
        status: "failed",
        result:
          "[process-failure] Claude request failed: Sandbox required but unavailable: Windows feature gate off. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.",
      });
      await request("POST", `/tasks/${parent.id}/status`, {
        status: "blocked",
        result: "Waiting for required child assignments.",
      });
      return {
        managerId: manager.id,
        parentId: parent.id,
        failedId: first.childTaskId,
        waitingId: second.childTaskId,
      };
    });
    await page
      .getByLabel("Agent", { exact: true })
      .selectOption(work.managerId);
    const panel = page.getByTestId("invocation-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("0 of 1 slots in use.");
    await expect(page.getByTestId("readiness-strip")).toContainText(
      "Roll-call Integrator: required sandbox unavailable (1 assignment)",
    );
    await expect(
      panel.locator(`[data-task-id="${work.parentId}"]`),
    ).toContainText("Needs attention");
    const managerCard = page
      .locator(".agent-card")
      .filter({ hasText: "Roll-call Planner" });
    await expect(managerCard.locator(".card-basics .badge")).toHaveText(
      "blocked",
    );
    await expect(managerCard).toContainText("1 task needs attention");
    await expect(managerCard).not.toContainText("interrupted task");
    const failed = panel.locator(`[data-task-id="${work.failedId}"]`);
    await expect(failed).toContainText("Blocked: sandbox unavailable");
    await expect(failed).toContainText("Retry after fixing the configuration");
    await expect(failed).not.toContainText("failIfUnavailable=false");
    const waiting = panel.locator(`[data-task-id="${work.waitingId}"]`);
    await expect(waiting).toContainText("Blocked by failed prerequisite");
    await expect(waiting).toContainText(
      "Roll-call Integrator · Create Integrator.txt: sandbox unavailable",
    );
    await page.screenshot({
      path: testInfo.outputPath("blocked-assignments.png"),
      fullPage: true,
    });
    await waiting
      .getByRole("button", { name: "Open Recovery", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Recovery", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Recovery", exact: true }),
    ).toContainText("Create Integrator.txt");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
