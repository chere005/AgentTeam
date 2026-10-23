import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelState } from "../src/model-choices.ts";
import { invocationSummary } from "../src/invocation-view.ts";
import { runtimeCapabilities, capabilityLabels } from "../src/capabilities.ts";
import { commandFor } from "../src/runtime.ts";
import { defaults } from "../src/discovery.ts";
import type { LaunchPlan } from "../src/service.ts";

const codex = {
  id: "codex",
  installed: true,
  modelSource: "installed-codex",
  models: [
    { id: "default", name: "Codex default", efforts: ["low", "high"] },
    { id: "gpt-a", name: "GPT A", efforts: ["low", "high"] },
    { id: "gpt-b", name: "GPT B", efforts: [] },
  ],
};
const claude = {
  ...defaults.find((d) => d.id === "claude")!,
  installed: true,
};

test("model dropdown validates against the installation and never substitutes a saved model", () => {
  const ok = resolveModelState(codex, "gpt-a", "low");
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.efforts, ["low", "high"]);
  assert.equal(ok.warning, null);
  assert.equal(ok.unsupportedEffort, null);

  const def = resolveModelState(codex, "default", null);
  assert.deepEqual(
    def.efforts,
    ["low", "high"],
    "default model has effort choices",
  );

  const gone = resolveModelState(codex, "gpt-retired", "high");
  assert.equal(gone.status, "unavailable");
  assert.match(gone.warning!, /gpt-retired.*not offered.*not switched/);
  assert.deepEqual(gone.efforts, []);
  assert.equal(
    gone.unsupportedEffort,
    "high",
    "saved effort is surfaced, not cleared",
  );
  assert.ok(!gone.options.some((m) => m.id === "gpt-retired"));

  const noEffort = resolveModelState(codex, "gpt-b", "low");
  assert.equal(noEffort.unsupportedEffort, "low");

  const alias = resolveModelState(claude, "claude-custom-1", null);
  assert.equal(alias.status, "unlisted");
  assert.match(alias.warning!, /cannot be verified/);

  const missing = resolveModelState(
    { ...codex, installed: false },
    "gpt-z",
    null,
  );
  assert.equal(missing.status, "unverifiable");

  const pending = resolveModelState(undefined, "gpt-z", "high");
  assert.equal(pending.status, "pending");
  assert.equal(pending.warning, null);
  assert.equal(pending.unsupportedEffort, null);
});

test("invocation summary names the running children that fill the limit and why others wait", () => {
  const tasks = [
    {
      id: "t1",
      title: "Build",
      agentId: "w1",
      invokedBy: "lead",
      status: "running",
    },
    {
      id: "t2",
      title: "Review",
      agentId: "w2",
      invokedBy: "lead",
      status: "queued",
    },
    {
      id: "t3",
      title: "Other",
      agentId: "w2",
      invokedBy: "someone",
      status: "running",
    },
    {
      id: "t4",
      title: "Done",
      agentId: "w1",
      invokedBy: "lead",
      status: "completed",
    },
  ];
  const names = { w1: "Worker 1", w2: "Worker 2" };
  const full = invocationSummary("lead", 1, tasks, names, {
    t2: "invocation-limit",
  });
  assert.equal(full.full, true);
  assert.deepEqual(
    full.running.map((r) => r.agentName),
    ["Worker 1"],
  );
  assert.equal(full.waiting[0].reason, "invocation-limit");
  assert.match(full.explanation, /1 of 1 slots.*1 more invocation waits/);
  const roomy = invocationSummary("lead", 3, tasks, names);
  assert.equal(roomy.full, false);
  assert.equal(roomy.waiting[0].reason, "scheduling");
  const free = invocationSummary("lead", null, tasks, names);
  assert.match(free.explanation, /No limit/);
});

function plan(environment: string, over: Record<string, unknown> = {}) {
  return {
    agentId: "a",
    environment,
    model: "m",
    effort: "high",
    instructions: "i",
    skills: [],
    cwd: process.cwd(),
    connection: undefined,
    ...over,
  } as unknown as LaunchPlan;
}
test("capability table claims match what the adapters build", () => {
  const rows = Object.fromEntries(runtimeCapabilities().map((r) => [r.id, r]));
  assert.deepEqual(
    Object.keys(rows[Object.keys(rows)[0]].capabilities).sort(),
    Object.keys(capabilityLabels).sort(),
  );
  for (const row of Object.values(rows))
    for (const [key, cap] of Object.entries(row.capabilities)) {
      assert.ok(cap.note.length > 10, row.id + " " + key + " needs a note");
      // Subagents are never offered while native subagents bypass AgentTeam limits.
      if (key === "subagents") assert.equal(cap.level, "no");
    }
  const resume = (env: string) =>
    commandFor(plan(env), "sess-1", "hi", process.cwd());
  const fresh = (env: string, effort: string | null) =>
    commandFor(plan(env, { effort }), null, "hi", process.cwd());
  assert.ok(resume("codex").args.includes("resume"));
  assert.ok(resume("claude").args.includes("--resume"));
  assert.notEqual(rows["codex-cli"].capabilities.sessionResume.level, "no");
  assert.notEqual(rows["claude-cli"].capabilities.sessionResume.level, "no");
  assert.ok(!resume("wolfram").args.includes("resume"));
  assert.equal(
    rows["wolfram-wolframscript"].capabilities.sessionResume.level,
    "partial",
  );
  // effort
  assert.ok(fresh("claude", "high").args.includes("--effort"));
  assert.ok(
    fresh("codex", "high").args.some((a) =>
      a.startsWith("model_reasoning_effort"),
    ),
  );
  assert.deepEqual(fresh("wolfram", "high").args, fresh("wolfram", null).args);
  assert.equal(rows["wolfram-wolframscript"].capabilities.effort.level, "no");
  // Without an attached workspace, both CLI adapters expose no filesystem tools.
  const claudeArgs = fresh("claude", null).args;
  assert.equal(claudeArgs[claudeArgs.indexOf("--tools") + 1], "");
  assert.ok(fresh("codex", null).args.includes('sandbox_mode="read-only"'));
  assert.equal(rows["claude-cli"].capabilities.tools.level, "partial");
  assert.equal(rows["codex-cli"].capabilities.tools.level, "partial");
});
