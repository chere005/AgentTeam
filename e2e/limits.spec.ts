import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("workflow limits: trip reason, honest usage, rejected then extended resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-limits-"));
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
    // Fixture data only: no provider is ever invoked; task states are driven through the API.
    await page.evaluate(async () => {
      const r = window.agentteam.request;
      const a = await r("POST", "/agents", {
        name: "Planner",
        environment: "codex",
      });
      const b = await r("POST", "/agents", {
        name: "Builder",
        environment: "codex",
      });
      const wf = await r("POST", "/workflows", {
        name: "Bounded run",
        goal: "Exercise limits",
        ownerId: a.id,
        completionCriteria: "done",
      });
      await r("PUT", `/workflows/${wf.id}/limits`, { maxAgentTurns: 1 });
      const t1 = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: a.id,
        title: "First",
        completionCriteria: "d",
      });
      const t2 = await r("POST", "/tasks", {
        workflowId: wf.id,
        agentId: b.id,
        title: "Second",
        completionCriteria: "d",
      });
      await r("POST", `/tasks/${t1.id}/status`, { status: "running" });
      await r("POST", `/tasks/${t2.id}/status`, { status: "running" }).catch(
        () => undefined,
      );
    });
    await page.getByRole("button", { name: /^Projects/ }).click();
    const wf = page.locator(".workflow", { hasText: "Bounded run" });
    await wf.locator("details.limits-panel > summary").click();
    await expect(wf.getByTestId("limit-trip")).toHaveText(
      "Stopped by limit: Maximum of 1 agent turns reached.",
    );
    await expect(wf.getByTestId("used-maxAgentTurns")).toContainText("used 1");
    await expect(wf.getByTestId("usage-note")).toContainText(
      "Token usage: unavailable",
    );
    await expect(wf.getByTestId("usage-note")).toContainText(
      "Cost: unavailable",
    );
    await expect(wf.getByTestId("usage-note")).toContainText(
      "No monetary cost is estimated",
    );
    // Resuming without raising the limit is refused with a visible reason.
    await wf.getByRole("button", { name: "Extend and resume" }).click();
    await expect(wf.getByRole("alert").last()).toContainText("Raise the limit");
    await expect(wf.getByTestId("limit-trip")).toBeVisible();
    // Explicit extension resumes the workflow and clears the stop.
    await wf.getByLabel("Max agent turns").fill("3");
    await wf.getByRole("button", { name: "Extend and resume" }).click();
    await expect(wf.getByTestId("limit-trip")).toHaveCount(0);
    await expect(wf.locator(".badge", { hasText: "paused" })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
