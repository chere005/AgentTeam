import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

const launch = (directory: string) =>
  electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });

test("recovery: interrupted task shows its checkpoint, pending approval survives restart, resume from checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-recovery-"));
  // Fixture data only: no provider is invoked; the "crash" is closing the app with a task running.
  let app = await launch(directory);
  let taskId = "";
  let agentId = "";
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const ids = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const a = await r("POST", "/agents", {
        name: "Builder",
        environment: "codex",
      });
      const wf = await r("POST", "/workflows", {
        name: "Crash demo",
        goal: "Exercise recovery",
        ownerId: a.id,
        completionCriteria: "done",
      });
      const t = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: a.id,
        title: "Write notes",
        completionCriteria: "d",
      });
      await r("POST", `/tasks/${t.id}/status`, { status: "running" });
      return { agentId: a.id, taskId: t.id };
    });
    taskId = ids.taskId;
    agentId = ids.agentId;
  } finally {
    await app.close();
  }
  // A permission request that was pending when the process died.
  const db = new DatabaseSync(join(directory, "agentteam.sqlite"));
  const approval = {
    id: "approval-fixture",
    agentId,
    taskId,
    createdAt: new Date().toISOString(),
    fingerprint: "fixture",
    status: "pending",
    request: {
      sessionId: "s",
      toolCall: { toolCallId: "t1", title: "Write notes.txt", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  };
  db.prepare("INSERT INTO entities(kind,id,data) VALUES('approval',?,?)").run(
    approval.id,
    JSON.stringify(approval),
  );
  db.close();

  app = await launch(directory);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await openFeature(page, "Recovery");
    const wf = page.locator(".workflow", { hasText: "Crash demo" });
    const panel = wf.getByTestId("recovery-panel");
    await expect(panel).toContainText("Write notes");
    await expect(panel.locator(".badge")).toHaveText("interrupted");
    await expect(panel.getByTestId("recovery-checkpoint")).toContainText(
      "task.interrupted",
    );
    await expect(panel.getByTestId("recovery-approval")).toContainText(
      "Pending approval: Write notes.txt (kept across restart)",
    );
    await expect(panel.getByTestId("recovery-next")).toContainText(
      "Answer pending approval: Write notes.txt",
    );
    const resume = panel.getByRole("button", {
      name: "Resume from checkpoint",
    });
    await expect(resume).toBeDisabled();
    // The approval is answerable after the restart and the decision is recorded.
    await panel.getByRole("button", { name: "Allow once" }).click();
    await expect(panel.getByTestId("recovery-approval")).toHaveCount(0);
    await expect(panel.getByTestId("recovery-next")).toContainText(
      "Re-run attempt 1 from the beginning",
    );
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(panel).toHaveCount(0); // queued again: nothing left to recover
    const status = await page.evaluate(
      async (id) =>
        (await window.agentteam.request("GET", `/tasks/${id}`)).status,
      taskId,
    );
    expect(status).toBe("queued");
    const boundaries = await page.evaluate(
      async (id) =>
        (await window.agentteam.request("GET", `/tasks/${id}/checkpoints`)).map(
          (c: { boundary: string }) => c.boundary,
        ),
      taskId,
    );
    expect(boundaries).toEqual([
      "task.started",
      "task.interrupted",
      "approval.resolved",
      "task.requeued",
    ]);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
