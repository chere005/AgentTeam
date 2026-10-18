import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shared state viewer: typed field, history, stale-write conflict, artifact preview and provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-shared-"));
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-shared-ws-")),
  );
  await writeFile(join(workspace, "report.md"), "# Findings\nAll good.\n");
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
    // Fixture data only: no provider runs. The task is moved to running so the agent may write.
    const conflict = await page.evaluate(
      async ([ws]) => {
        const r = window.agentteam.request;
        const a = await r("POST", "/agents", {
          name: "Architect",
          environment: "codex",
          workspaces: [{ path: ws, access: "write", active: true }],
        });
        const wf = await r("POST", "/workflows", {
          name: "Shared demo",
          goal: "Exercise shared state",
          ownerId: a.id,
          completionCriteria: "done",
        });
        const t = await r("POST", "/tasks", {
          workflowId: wf.id,
          agentId: a.id,
          title: "Design API",
          completionCriteria: "d",
        });
        await r("PUT", `/workflows/${wf.id}/state/fields/decision-api`, {
          kind: "decision",
          description: "Which API style we use",
          writers: [a.id],
        });
        const put = (value: unknown, expectedVersion: number, extra = {}) =>
          r("POST", `/workflows/${wf.id}/state/fields/decision-api/value`, {
            value,
            expectedVersion,
            ...extra,
          });
        await put({ decision: "REST" }, 0);
        await r("POST", `/tasks/${t.id}/status`, { status: "running" });
        await put({ decision: "gRPC", rationale: "streaming" }, 1, {
          agentId: a.id,
          taskId: t.id,
          note: "revised",
        });
        await r("POST", `/workflows/${wf.id}/artifacts`, {
          taskId: t.id,
          kind: "report",
          title: "Findings",
          path: "report.md",
        });
        await r("POST", `/workflows/${wf.id}/artifacts`, {
          kind: "wolfram-result",
          title: "Symbolic sum",
          text: "n (n + 1)/2",
        });
        let message = "";
        try {
          await put({ decision: "GraphQL" }, 1); // stale: current version is 2
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        let escape = "";
        try {
          await r("POST", `/workflows/${wf.id}/artifacts`, {
            taskId: t.id,
            kind: "file",
            title: "nope",
            path: "../../etc/hosts",
          });
        } catch (e) {
          escape = e instanceof Error ? e.message : String(e);
        }
        return { message, escape };
      },
      [workspace],
    );
    expect(conflict.message).toMatch(/current version is 2/);
    expect(conflict.escape).toMatch(/escapes the attached workspace/);

    await page.getByRole("button", { name: /^Projects/ }).click();
    const panel = page
      .locator(".workflow", { hasText: "Shared demo" })
      .getByTestId("shared-panel");
    const field = panel.getByTestId("state-field");
    await expect(field).toContainText("decision-api");
    await expect(field).toContainText("version 2");
    await expect(field.getByTestId("state-value")).toContainText("gRPC");
    await expect(field).toContainText("Write: Architect");
    await field.getByRole("button", { name: "History" }).click();
    const history = field.getByTestId("state-history");
    await expect(history.locator("li")).toHaveCount(2);
    await expect(history.locator("li").first()).toContainText("v1");
    await expect(history.locator("li").nth(1)).toContainText("by Architect");
    await expect(history.locator("li").nth(1)).toContainText("revised");

    const report = panel
      .getByTestId("artifact")
      .filter({ hasText: "Findings" });
    await report.getByRole("button", { name: "Preview" }).click();
    await expect(report.getByTestId("artifact-preview")).toContainText(
      "All good.",
    );
    await report.getByRole("button", { name: "Provenance" }).click();
    await expect(report.getByTestId("artifact-provenance")).toContainText(
      "Architect",
    );
    await expect(report.getByTestId("artifact-provenance")).toContainText(
      "Content sha256",
    );
    await expect(
      panel.getByTestId("artifact").filter({ hasText: "Symbolic sum" }),
    ).toContainText("no validation record");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
