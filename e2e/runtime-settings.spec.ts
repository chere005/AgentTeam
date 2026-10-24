import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, copyFile, chmod, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentPanel, openFeature } from "./helpers";

// Fixture installation only: scans are limited to an empty PATH so the developer's real
// Codex/Claude/Wolfram installs (and accounts) are never touched.
test.skip(process.platform === "win32", "fixture executable is a POSIX script");
test("runtime diagnostics, validated model/effort choices, invocation limits and capability table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-runtime-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const fixture = join(bin, "codex-fixture");
  await copyFile(
    join(process.cwd(), "test", "fixtures", "codex-fixture.mjs"),
    fixture,
  );
  await chmod(fixture, 0o755);
  const empty = join(directory, "empty-path");
  await mkdir(empty);
  // The fixture's `#!/usr/bin/env node` shebang needs node on PATH; nothing else is there.
  await symlink(process.execPath, join(empty, "node"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_DISCOVERY_PATH_ONLY: "1",
      PATH: empty,
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const request = (method: string, path: string, body?: unknown) =>
      page.evaluate(
        ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
        [method, path, body] as const,
      );

    // Seed: a retired saved model with an effort, plus a lead whose limit of 1 is full.
    const retired = await request("POST", "/agents", {
      name: "Retired Model Agent",
      environment: "codex",
      model: "gpt-retired",
      effort: "high",
    });
    const lead = await request("POST", "/agents", {
      name: "Lead",
      environment: "codex",
      maxConcurrentInvocations: 1,
    });
    const children = [] as any[];
    for (const name of ["Builder", "Reviewer"]) {
      const child = await request("POST", "/agents", {
        name,
        environment: "codex",
      });
      await request("POST", "/edges", {
        from: lead.id,
        to: child.id,
        kind: "delegate",
      });
      children.push(child);
    }
    const workflow = await request("POST", "/workflows", {
      name: "Limits",
      goal: "Show limits",
      ownerId: lead.id,
      completionCriteria: "Shown",
    });
    const tasks = [] as any[];
    for (const [i, child] of children.entries())
      tasks.push(
        await request("POST", "/tasks", {
          workflowId: workflow.id,
          agentId: child.id,
          invokedBy: lead.id,
          title: i === 0 ? "Build feature" : "Review feature",
          completionCriteria: "Done",
        }),
      );
    await request("POST", `/tasks/${tasks[0].id}/status`, {
      status: "running",
    });
    // Agents were seeded through the API, so lay out their cards before selecting them.
    await page.getByRole("button", { name: "Arrange", exact: true }).click();

    // Settings: stale manual path, then the fixture installation.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await request("PUT", "/runtimes/codex", {
      path: join(directory, "missing-codex"),
    });
    await page
      .getByRole("button", { name: "Detect installations again" })
      .click();
    await expect(
      page.getByText("Manual path unavailable", { exact: true }),
    ).toBeVisible();
    const codexDiagnostics = page.getByRole("list", {
      name: "codex diagnostics",
    });
    await expect(codexDiagnostics).toContainText("no longer exists");
    await page
      .getByRole("button", { name: "Reset to auto-detect" })
      .first()
      .click();
    await expect(codexDiagnostics).toContainText(
      "No codex installation was found",
    );

    await page.getByLabel("codex executable path").fill(fixture);
    await page
      .getByRole("button", { name: "Use this executable" })
      .first()
      .click();
    await expect(
      page.getByText("Installed · signed in", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Manual override · codex-fixture 1.2.3"),
    ).toBeVisible();

    // Capability table reflects code truth.
    const row = page.getByTestId("capability-claude-cli");
    await expect(row).toContainText("Claude Code");
    await expect(page.getByTestId("capability-codex-cli")).toContainText(
      "Native subagents are not constrained",
    );
    await expect(
      page.getByRole("columnheader", { name: "Session resume" }),
    ).toBeVisible();

    // Editor: unavailable saved model is kept, warned, never switched.
    // Agent setup panel (select the agent on the canvas); effort lives under Advanced.
    const dialog = await openAgentPanel(page, "Retired Model Agent");
    await dialog.getByTestId("agent-advanced").locator("> summary").click();
    const model = dialog.getByLabel("Model", { exact: true });
    await expect(dialog.getByTestId("model-warning")).toContainText(
      "gpt-retired",
    );
    await expect(dialog.getByTestId("model-warning")).toContainText(
      "not switched",
    );
    await expect(model).toHaveValue("gpt-retired");
    await expect(model.locator("option")).toContainText([
      "Codex default",
      "GPT Fixture",
      "GPT Mini",
      "gpt-retired (unavailable in this installation)",
      "Custom model ID (not validated)…",
    ]);
    await expect(dialog.getByTestId("effort-warning")).toContainText("high");

    // Picking an advertised model validates effort choices; default model has choices too.
    await model.selectOption("gpt-mini");
    await expect(dialog.getByTestId("model-warning")).toHaveCount(0);
    await expect(dialog.getByLabel("Effort", { exact: true })).toBeDisabled();
    await model.selectOption("default");
    const effort = dialog.getByLabel("Effort", { exact: true });
    await expect(effort.locator("option")).toHaveText([
      "Provider default",
      "low",
      "high",
    ]);
    await model.selectOption("custom");
    await expect(dialog.getByLabel("Custom model ID")).toBeVisible();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await dialog.getByRole("button", { name: "Close agent panel" }).click();
    await expect(page.getByTestId("agent-panel")).toHaveCount(0);

    // Invocation limit: running child counts, second waits with the reason.
    await openFeature(page, "Canvas");
    const side = page.getByRole("complementary", { name: "Side panel" });
    await side.getByRole("tab", { name: "Chat" }).click();
    await side
      .getByRole("combobox", { name: "Agent", exact: true })
      .selectOption({
        label: "Lead",
      });
    await side.getByRole("tab", { name: "Agent setup" }).click();
    const leadPanel = page.getByTestId("agent-panel");
    await expect(leadPanel.getByTestId("agent-panel-name")).toHaveText("Lead");
    await leadPanel.getByTestId("agent-advanced").locator("> summary").click();
    const limits = page.getByTestId("invocation-panel");
    await expect(limits).toContainText("running 1 / 1");
    await expect(
      limits.getByRole("list", { name: "Running children" }),
    ).toContainText("Builder: Build feature");
    await expect(
      limits.getByRole("list", { name: "Waiting invocations" }),
    ).toContainText(
      "Reviewer: Review feature (the invoking agent is at its concurrent invocation limit)",
    );
    await expect(limits).toContainText("1 more invocation waits");
    void retired;
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
