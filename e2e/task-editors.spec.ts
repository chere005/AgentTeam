import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// Fixture data only (temp AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1): no provider is ever invoked; task
// states are driven through the API.
async function withApp(fn: (page: Page, errors: string[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-editors-"));
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
    await fn(page, errors);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );
async function openWorkflows(page: Page, view = "Projects") {
  await openFeature(page, view);
}
async function reload(page: Page, view = "Projects") {
  await page.reload();
  await expect(
    page.getByText("Workspace connected", { exact: true }),
  ).toBeVisible();
  await openWorkflows(page, view);
}
async function fixture(page: Page) {
  const a = await api(page, "POST", "/agents", {
    name: "Planner",
    environment: "codex",
  });
  const b = await api(page, "POST", "/agents", {
    name: "Builder",
    environment: "codex",
  });
  const wf = await api(page, "POST", "/workflows", {
    name: "Editable flow",
    goal: "Exercise editors",
    ownerId: a.id,
    completionCriteria: "done",
  });
  const first = await api(page, "POST", "/tasks", {
    workflowId: wf.id,
    agentId: a.id,
    title: "Draft plan",
    completionCriteria: "d",
  });
  const second = await api(page, "POST", "/tasks", {
    workflowId: wf.id,
    agentId: b.id,
    title: "Build it",
    completionCriteria: "d",
    dependsOn: [first.id],
  });
  const third = await api(page, "POST", "/tasks", {
    workflowId: wf.id,
    agentId: a.id,
    title: "Standalone job",
    completionCriteria: "d",
  });
  return { a, b, wf, first, second, third };
}
const taskPanel = (page: Page, title: string) =>
  page.locator("details.task", { hasText: title }).first();
async function openTaskSettings(page: Page, title: string) {
  const task = taskPanel(page, title);
  await task.locator("summary").first().click();
  const settings = task.getByTestId("task-settings");
  await settings.getByRole("button", { name: "Task settings" }).click();
  return settings;
}

test("task completion checks and validation requirement: validate, save, persist, backend errors, locked while running", async () => {
  await withApp(async (page) => {
    const { first, third } = await fixture(page);
    await api(page, "POST", `/tasks/${third.id}/status`, {
      status: "running",
    }).catch(() => undefined);
    await openWorkflows(page);
    const settings = await openTaskSettings(page, "Draft plan");
    const checks = settings.getByTestId("completion-checks");
    await expect(checks).toContainText("Returned text alone is not success");
    // Client-side validation first.
    await checks.getByRole("button", { name: "Add check" }).click();
    await checks.getByRole("button", { name: "Save checks" }).click();
    await expect(checks.getByRole("alert")).toContainText(
      "list at least one field name",
    );
    await checks
      .getByLabel("Field names (comma separated)")
      .fill("summary, verdict");
    await checks.getByRole("button", { name: "Add check" }).click();
    await checks.getByLabel("Type").nth(1).selectOption("output-matches");
    await checks.getByLabel("Pattern (regular expression)").fill("(");
    await checks.getByRole("button", { name: "Save checks" }).click();
    await expect(checks.getByRole("alert")).toContainText(
      "not a valid regular expression",
    );
    await checks.getByLabel("Pattern (regular expression)").fill("^DONE\\b");
    await checks.getByLabel("ignore case").check();
    await checks.getByRole("button", { name: "Add check" }).click();
    await checks.getByLabel("Type").nth(2).selectOption("artifact-exists");
    await checks
      .getByLabel("File path (relative to the workspace)")
      .fill("out/report.md");
    await checks.getByRole("button", { name: "Add check" }).click();
    await checks.getByLabel("Type").nth(3).selectOption("validation-gate");
    // The gate check warns while the task does not require validation.
    await expect(
      checks.getByText(/fails until the task requires validation/),
    ).toBeVisible();
    await checks.getByRole("button", { name: "Save checks" }).click();
    await expect(checks.getByRole("status")).toContainText(
      "Saved 4 completion checks",
    );
    const saved = await api(page, "GET", `/tasks/${first.id}`);
    expect(saved.completionChecks).toEqual([
      { type: "output-fields", fields: ["summary", "verdict"] },
      { type: "output-matches", pattern: "^DONE\\b", flags: "i" },
      { type: "artifact-exists", path: "out/report.md" },
      { type: "validation-gate" },
    ]);

    // Validation requirement on an existing task, then the backend refuses turning it off
    // underneath the validation-gate check; the message is shown verbatim.
    const toggle = settings.getByTestId("requires-validation");
    await toggle.click();
    await expect(settings.getByRole("status").first()).toContainText(
      "Validation is now required",
    );
    expect(
      (await api(page, "GET", `/tasks/${first.id}`)).requiresValidation,
    ).toBe(true);
    await toggle.click();
    await expect(settings.getByRole("alert")).toContainText(
      "Remove the validation-gate completion check before turning the validation requirement off",
    );
    await expect(toggle).toBeChecked();

    // Persistence across reload.
    await reload(page);
    const again = await openTaskSettings(page, "Draft plan");
    await expect(again.getByTestId("requires-validation")).toBeChecked();
    await expect(again.getByTestId("check-row")).toHaveCount(4);
    await expect(again.getByLabel("Field names (comma separated)")).toHaveValue(
      "summary, verdict",
    );
    // Remove the gate check, then the requirement can be turned off.
    await again.getByRole("button", { name: "Remove check 4" }).click();
    await again.getByRole("button", { name: "Save checks" }).click();
    await again.getByTestId("requires-validation").click();
    await expect
      .poll(
        async () =>
          (await api(page, "GET", `/tasks/${first.id}`)).requiresValidation,
      )
      .toBeUndefined();

    // A running task cannot be edited.
    const locked = await openTaskSettings(page, "Standalone job");
    await expect(locked.getByTestId("task-locked")).toContainText("running");
    await expect(locked.getByTestId("requires-validation")).toBeDisabled();
    await expect(
      locked.getByRole("button", { name: "Save checks" }),
    ).toBeDisabled();
    await expect(
      locked.getByRole("button", { name: "Add check" }),
    ).toBeDisabled();
    await expect(
      locked.getByRole("button", { name: "Save state settings" }),
    ).toBeDisabled();
  });
});

test("task retry policy: validate, save, persist", async () => {
  await withApp(async (page) => {
    const { first } = await fixture(page);
    await openWorkflows(page);
    const settings = await openTaskSettings(page, "Draft plan");
    const policy = settings.getByTestId("retry-policy");
    await expect(policy.getByLabel("Maximum attempts")).toHaveValue("5");
    await policy.getByLabel("Maximum attempts").fill("0");
    await policy.getByRole("button", { name: "Save retry policy" }).click();
    await expect(policy.getByRole("alert")).toContainText(
      "Maximum attempts must be a whole number from 1 to 50",
    );
    await policy.getByLabel("Maximum attempts").fill("3");
    await policy.getByLabel("First backoff (ms)").fill("1000");
    await policy.getByLabel("Backoff factor").fill("1.5");
    await policy.getByLabel("Longest backoff (ms)").fill("20000");
    await policy.getByLabel("Retry automatically after the backoff").check();
    await policy.getByRole("button", { name: "Save retry policy" }).click();
    await expect(policy.getByRole("status")).toContainText(
      "Retry policy saved",
    );
    expect(
      (await api(page, "GET", `/tasks/${first.id}/recovery`)).policy,
    ).toEqual({
      maxAttempts: 3,
      backoffMs: 1000,
      backoffFactor: 1.5,
      maxBackoffMs: 20000,
      auto: true,
    });
    await reload(page);
    const again = (await openTaskSettings(page, "Draft plan")).getByTestId(
      "retry-policy",
    );
    await expect(again.getByLabel("Maximum attempts")).toHaveValue("3");
    await expect(again.getByLabel("Backoff factor")).toHaveValue("1.5");
    await expect(
      again.getByLabel("Retry automatically after the backoff"),
    ).toBeChecked();
  });
});

test("task state config: selected inputs, caps, persistence and backend refusal once running", async () => {
  await withApp(async (page) => {
    const { wf, first, second, third } = await fixture(page);
    await api(page, "PUT", `/workflows/${wf.id}/state/fields/notes`, {
      kind: "output",
    });
    await openWorkflows(page);
    const settings = await openTaskSettings(page, "Build it");
    const cfg = settings.getByTestId("state-config");
    await cfg.getByLabel("Memory").selectOption("fresh");
    await cfg.getByLabel("Only the selected dependencies").check();
    await cfg.getByLabel("Draft plan").check();
    await cfg.getByLabel("Cap (characters)").fill("100");
    await cfg.getByRole("button", { name: "Save state settings" }).click();
    await expect(cfg.getByRole("alert")).toContainText(
      "Per-input character cap must be a whole number from 200 to 50000",
    );
    await cfg.getByLabel("Cap (characters)").fill("1500");
    await cfg.getByLabel("Only the selected fields").check();
    await cfg.getByLabel("notes").first().check();
    await cfg.getByLabel("Context budget (characters)").fill("12000");
    await cfg.getByRole("button", { name: "Save state settings" }).click();
    await expect(cfg.getByRole("status")).toContainText("saved");
    expect(
      await api(page, "GET", `/tasks/${second.id}/state-config`),
    ).toMatchObject({
      memory: "fresh",
      stateKeys: ["notes"],
      inputs: [{ taskId: first.id, maxChars: 1500 }],
      maxContextChars: 12000,
    });
    await reload(page);
    const again = (await openTaskSettings(page, "Build it")).getByTestId(
      "state-config",
    );
    await expect(again.getByLabel("Memory")).toHaveValue("fresh");
    await expect(again.getByLabel("Cap (characters)")).toHaveValue("1500");
    await expect(again.getByLabel("Context budget (characters)")).toHaveValue(
      "12000",
    );
    // Race the UI refresh: the backend refuses and its message is shown unchanged.
    const standalone = (
      await openTaskSettings(page, "Standalone job")
    ).getByTestId("state-config");
    await expect(
      standalone.getByRole("button", { name: "Save state settings" }),
    ).toBeEnabled();
    await page.evaluate(
      async ([id]) => {
        await window.agentteam.request("POST", `/tasks/${id}/status`, {
          status: "running",
        });
        (
          [...document.querySelectorAll("button")]
            .filter((b) => b.textContent === "Save state settings")
            .pop() as HTMLButtonElement
        ).click();
      },
      [third.id],
    );
    await expect(standalone.getByRole("alert")).toContainText(
      "Task is running",
    );
  });
});

test("shared state editor: define field with permissions, edit, backend error, preview and guarded restore", async () => {
  await withApp(async (page) => {
    const { a, b, wf, third } = await fixture(page);
    const spare = await api(page, "POST", "/agents", {
      name: "Spare",
      environment: "codex",
    });
    await openWorkflows(page, "Shared state");
    const editor = page.getByTestId("state-editor");
    await editor.locator("summary").click();
    await editor.getByRole("button", { name: "Define field" }).click();
    const form = editor.getByTestId("field-form");
    await form.getByLabel("Key").fill("Bad Key");
    await form.getByRole("button", { name: "Save field" }).click();
    await expect(editor.getByRole("alert").first()).toContainText(
      "Field key: use lowercase",
    );
    await form.getByLabel("Key").fill("decision-api");
    await form.getByLabel("Value schema (JSON, optional)").fill("{nope");
    await form.getByRole("button", { name: "Save field" }).click();
    await expect(editor.getByRole("alert").first()).toContainText(
      "Schema is not valid JSON",
    );
    await form
      .getByLabel("Value schema (JSON, optional)")
      .fill('{"type":"string","maxLength":40}');
    await form.getByLabel("Description").fill("API style");
    await form.getByLabel("Builder can write").check();
    await form.getByLabel("Everyone can read").uncheck();
    await form.getByLabel("Planner can read").check();
    await form.getByRole("button", { name: "Save field" }).click();
    await expect(editor.getByRole("status").first()).toContainText(
      "decision-api saved",
    );
    const def = await api(
      page,
      "GET",
      `/workflows/${wf.id}/state/fields/decision-api`,
    );
    expect(def).toMatchObject({
      kind: "decision",
      description: "API style",
      readers: [a.id],
      writers: [b.id],
      schema: { type: "string", maxLength: 40 },
    });

    // Persistence: reload and edit again.
    await reload(page, "Shared state");
    const editor2 = page.getByTestId("state-editor");
    await editor2.locator("summary").click();
    await editor2
      .getByRole("button", { name: "Edit field decision-api" })
      .click();
    const form2 = editor2.getByTestId("field-form");
    await expect(form2.getByLabel("Description")).toHaveValue("API style");
    await expect(form2.getByLabel("Builder can write")).toBeChecked();
    await expect(form2.getByLabel("Everyone can read")).not.toBeChecked();
    // Backend error: grant a permission to an agent deleted meanwhile (the form still lists it).
    await form2.getByLabel("Spare can write").check();
    await api(page, "DELETE", `/agents/${spare.id}`);
    await form2.getByRole("button", { name: "Save field" }).click();
    await expect(editor2.getByRole("alert").first()).toBeVisible();
    await expect(editor2.getByRole("alert").first()).toContainText(
      /not found/i,
    );
    await form2.getByLabel("Spare can write").uncheck();
    await form2.getByRole("button", { name: "Save field" }).click();
    await expect(editor2.getByRole("status").first()).toContainText(
      "decision-api saved",
    );

    // Restore: checkpoint recorded when the task starts, a later change, preview, guarded restore.
    const put = (value: string, expectedVersion: number) =>
      api(page, "POST", `/workflows/${wf.id}/state/fields/decision-api/value`, {
        value,
        expectedVersion,
      });
    await put("REST", 0);
    await api(page, "POST", `/tasks/${third.id}/status`, {
      status: "running",
    }).catch(() => undefined);
    await put("gRPC", 1);
    await expect(editor2.getByTestId("state-restore")).toBeVisible();
    await expect
      .poll(() => editor2.getByLabel("Checkpoint").locator("option").count())
      .toBeGreaterThan(1);
    await editor2.getByLabel("Checkpoint").selectOption({ index: 1 });
    await editor2.getByRole("button", { name: "Preview restore" }).click();
    await expect(editor2.getByTestId("restore-plan")).toContainText(
      "decision-api: version 2 becomes the content of version 1",
    );
    // A change after the preview makes the restore refuse, with the backend's message.
    await put("GraphQL", 2);
    await editor2.getByRole("button", { name: /^Restore 1 field/ }).click();
    await expect(
      editor2.getByTestId("state-restore").getByRole("alert"),
    ).toContainText("Restore rejected");
    await editor2.getByRole("button", { name: "Preview restore" }).click();
    await expect(editor2.getByTestId("restore-plan")).toContainText(
      "version 3 becomes",
    );
    await editor2.getByRole("button", { name: /^Restore 1 field/ }).click();
    await expect(
      editor2.getByTestId("state-restore").getByRole("status"),
    ).toContainText("Restored decision-api");
    const now = await api(
      page,
      "GET",
      `/workflows/${wf.id}/state/fields/decision-api`,
    );
    expect(now.value).toBe("REST");
    expect(now.version).toBe(4);
    await editor2.getByRole("button", { name: "Preview restore" }).click();
    await expect(editor2.getByTestId("restore-plan")).toContainText(
      "already matches",
    );
  });
});

test("routing rule editing: mode, priority, persistence and backend error", async () => {
  await withApp(async (page) => {
    const { a } = await fixture(page);
    const target = await api(page, "POST", "/agents", {
      name: "Reviewer",
      environment: "codex",
    });
    const rule = await api(page, "POST", "/rules", {
      agentId: a.id,
      scope: "action",
      targetId: target.id,
      priority: 5,
      match: { textIncludes: ["db"], catchAll: false },
      mode: "advisory",
      kind: "delegate",
    });
    await openWorkflows(page);
    await expect(page.getByTestId("rule-badge")).toHaveText("Advisory");
    await page.getByRole("button", { name: /^Edit rule/ }).click();
    const form = page.getByTestId("rule-edit-form");
    await form.getByLabel("Priority (highest wins)").fill("20000");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(form.getByRole("alert")).toContainText(
      "Priority must be a whole number from 0 to 10000",
    );
    await form.getByLabel("Priority (highest wins)").fill("7");
    await form.getByTestId("rule-mode").selectOption("mandatory");
    await form.getByLabel("Specialty (optional)").fill("security");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("rule-badge")).toHaveText(
      "Required review · security",
    );
    const rules = await api(page, "GET", "/rules");
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: rule.id,
      priority: 7,
      mode: "mandatory",
      kind: "review",
      specialty: "security",
    });
    await reload(page);
    await expect(page.getByTestId("rule-badge")).toHaveText(
      "Required review · security",
    );
    // Backend error: the target agent disappears while the form is open.
    await page.getByRole("button", { name: /^Edit rule/ }).click();
    const again = page.getByTestId("rule-edit-form");
    await again.getByLabel("Priority (highest wins)").fill("8");
    // Deleting the agent also deletes the rule, and the next snapshot refresh (debounced) removes
    // the open form; delete and save in one step and watch for the error before that refresh.
    const shown = await page.evaluate(async (id) => {
      await window.agentteam.request("DELETE", `/agents/${id}`);
      const form = document.querySelector('[data-testid="rule-edit-form"]')!;
      const alertShown = new Promise<boolean>((resolve) => {
        const check = () =>
          !!form.querySelector('[role="alert"]')?.textContent?.trim();
        if (check()) return resolve(true);
        const observer = new MutationObserver(() => {
          if (check()) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(form, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        setTimeout(() => resolve(false), 5000);
      });
      [...form.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Save changes")!
        .click();
      return alertShown;
    }, target.id);
    expect(shown).toBe(true);
  });
});

test("usage view edits and persists every project limit", async () => {
  await withApp(async (page) => {
    const { wf } = await fixture(page);
    await openWorkflows(page, "Usage & limits");
    const w = page.locator(".usage-project", { hasText: "Editable flow" });
    await w.locator("details.limits-panel > summary").click();
    const labels: [string, string, number][] = [
      ["Max runtime (s)", "maxRuntimeSeconds", 3600],
      ["Max agent turns", "maxAgentTurns", 11],
      ["Max handoffs", "maxHandoffs", 12],
      ["Max retries", "maxRetries", 13],
      ["Max spawned agents", "maxSpawnedAgents", 14],
      ["Token budget (reported)", "maxTokens", 150000],
      ["Max children per task", "maxChildrenPerTask", 15],
      ["Max delegation depth", "maxDelegationDepth", 6],
    ];
    for (const [label, , value] of labels)
      await w.getByLabel(label).fill(String(value));
    await w.getByRole("button", { name: "Save limits" }).click();
    await expect
      .poll(
        async () =>
          (await api(page, "GET", `/workflows/${wf.id}/limits`)).limits,
      )
      .toEqual(
        Object.fromEntries(labels.map(([, key, value]) => [key, value])),
      );
    await w.getByLabel("Max handoffs").fill("0");
    await w.getByRole("button", { name: "Save limits" }).click();
    await expect(w.getByRole("alert")).toContainText(
      "Max handoffs must be a whole number of at least 1",
    );
    await reload(page, "Usage & limits");
    await page
      .locator(".usage-project", { hasText: "Editable flow" })
      .locator("details.limits-panel > summary")
      .click();
    await expect(page.getByLabel("Token budget (reported)")).toHaveValue(
      "150000",
    );
  });
});
