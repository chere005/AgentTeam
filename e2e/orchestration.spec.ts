import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("orchestration: role presets, advisory vs required rules, ties and blocked dependents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-orch-"));
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
    // Fixture data only: no provider is invoked; task states are driven through the API.
    const ids = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const dev = await r("POST", "/agents", {
        name: "Dev",
        environment: "codex",
      });
      const dba = await r("POST", "/agents", {
        name: "DBA",
        environment: "codex",
        roleType: "reviewer",
      });
      const dba2 = await r("POST", "/agents", {
        name: "DBA Two",
        environment: "codex",
        roleType: "reviewer",
      });
      const next = await r("POST", "/agents", {
        name: "Deployer",
        environment: "codex",
      });
      for (const to of [dba, dba2])
        await r("POST", "/edges", { from: dev.id, to: to.id, kind: "review" });
      const rule = (agentId: string, priority: number, extra: object = {}) =>
        r("POST", "/rules", {
          agentId,
          scope: "intake",
          priority,
          specialty: "database",
          kind: "review",
          match: { changedFilesAny: ["**/migrations/**"] },
          ...extra,
        });
      await rule(dba.id, 10, { mode: "mandatory" });
      await rule(dba2.id, 10, { mode: "mandatory" });
      const wf = await r("POST", "/workflows", {
        name: "Schema change",
        goal: "Migrate",
        ownerId: dev.id,
        completionCriteria: "done",
      });
      const subject = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: dev.id,
        title: "Add column",
        completionCriteria: "d",
        changedFiles: ["db/migrations/002.sql"],
      });
      const dependent = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: next.id,
        title: "Deploy",
        completionCriteria: "d",
        dependsOn: [subject.id],
      });
      await r("POST", `/tasks/${subject.id}/status`, { status: "running" });
      await r("POST", `/tasks/${subject.id}/status`, {
        status: "completed",
        result: "migration written",
      });
      return {
        dev: dev.id,
        dba: dba.id,
        subject: subject.id,
        dependent: dependent.id,
      };
    });
    // Role type comes first and applies preset defaults and the output contract.
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(page.locator(".form-grid label").first()).toContainText(
      "Role type",
    );
    const roleType = page.locator(".form-grid label").first().locator("select");
    await expect(roleType.locator("option")).toHaveText([
      "Specialist agent",
      "Coordinator",
      "Implementer",
      "Reviewer",
      "Adjudicator",
      "Team Assistant",
    ]);
    await roleType.selectOption("reviewer");
    await expect(page.getByTestId("role-preset-note")).toContainText(
      "verdict, findings, evidence",
    );
    await expect(page.getByTestId("role-preset-note")).toContainText(
      "Default access: read",
    );
    await expect(page.getByLabel("Role / specialty")).toHaveValue(
      /inspect the work read-only/,
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    // Backend: the tie leaves the required review unresolved and the dependent blocked.
    const state = await page.evaluate(async (i) => {
      const r = window.agentteam.request;
      return {
        dependent: await r("GET", `/tasks/${i.dependent}`),
        explain: await r("GET", `/tasks/${i.subject}/orchestration`),
      };
    }, ids);
    expect(state.dependent.waitReason).toBe("review-required");
    expect(state.explain.gate.open).toBe(false);
    expect(state.explain.triggers[0].status).toBe("tie");
    // Rule editor: advisory vs mandatory is explicit; ties and the winner are visible.
    await page.getByRole("button", { name: /^Projects/ }).click();
    await page.getByRole("button", { name: "Rule", exact: true }).click();
    await expect(page.getByTestId("rule-mode-hint")).toContainText(
      "nothing waits",
    );
    await page.getByTestId("rule-mode").selectOption("mandatory");
    await expect(page.getByTestId("rule-mode-hint")).toContainText(
      "cannot satisfy it",
    );
    await expect(page.getByTestId("rule-badge").first()).toContainText(
      "Required review",
    );
    await page.getByText("Test task routing").click();
    await page
      .getByTestId("routing-explain")
      .getByLabel("Changed files (comma-separated)")
      .fill("db/migrations/003.sql");
    await page.getByRole("button", { name: "Explain routing" }).click();
    const plan = page.getByTestId("specialist-plan");
    await expect(plan).toContainText("Tie");
    await expect(plan).toContainText("DBA");
    await expect(plan).toContainText("DBA Two");
    await expect(plan).toContainText("Required review");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
