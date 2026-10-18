import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  createWolframSample,
  isOpus55,
  verifySampleModels,
} from "../src/samples.ts";
import { defaults, type DetectedRuntime } from "../src/discovery.ts";
import type { Agent, Task } from "../src/model.ts";

const make = () => {
  const store = new Store(":memory:");
  return { store, service: new TeamService(store, new SkillCatalog([])) };
};
const runtimes = (opus: string): DetectedRuntime[] =>
  structuredClone(defaults).map((r) => ({
    ...r,
    installed: true,
    models:
      r.id === "claude"
        ? [...r.models, { id: opus, name: "Opus 5.5", efforts: ["high"] }]
        : r.models,
  }));

test("Wolfram sample is created paused and atomically with a hard cap of two", () => {
  const { store, service } = make();
  const wf = createWolframSample(service, { wolframAgents: 2 });
  assert.equal(wf.status, "paused");
  const agents = store.list<Agent>("agent");
  assert.equal(agents.filter((a) => a.environment === "wolfram").length, 2);
  assert.ok(
    agents
      .filter((a) => a.environment === "wolfram")
      .every((a) => a.maxConcurrentInvocations === 1),
  );
  assert.throws(() => createWolframSample(service, { wolframAgents: 3 }));
  const tasks = store.list<Task>("task");
  assert.ok(tasks.some((t) => t.requiresValidation));
  assert.ok(tasks.every((t) => t.status === "queued"));
  assert.equal(service.taskState(tasks[0].id).waitReason, "workflow-paused");
  // A failed creation leaves nothing behind.
  const before = store.list("agent").length;
  assert.throws(() => createWolframSample(service, { leadModel: "" }));
  assert.equal(store.list("agent").length, before);
});

test("sample cannot resume until model mapping is verified, and re-blocks on change", async () => {
  const { store, service } = make();
  const wf = createWolframSample(service, { wolframAgents: 1 });
  assert.throws(() => service.pauseWorkflow(wf.id, false), {
    code: "models_unverified",
  });
  // Undiscovered runtimes / unadvertised model: not verified.
  assert.equal(verifySampleModels(service, wf.id, undefined).verified, false);
  const bad = verifySampleModels(service, wf.id, runtimes("claude-opus-5-5"));
  assert.equal(bad.verified, false); // lead model "opus" is not advertised as 5.5
  assert.match(bad.issues.join("\n"), /Opus 5.5|not identifiably/);
  assert.throws(() => service.pauseWorkflow(wf.id, false));
  // Map the lead to the advertised id, then verification passes.
  const lead = store.get<Agent>("agent", wf.ownerId);
  const { id, createdAt, control, ...input } = lead;
  await service.saveAgent({ ...input, model: "claude-opus-5-5" }, id);
  const good = verifySampleModels(service, wf.id, runtimes("claude-opus-5-5"));
  assert.equal(good.verified, true, good.issues.join(";"));
  assert.equal(service.pauseWorkflow(wf.id, false).paused, false);
  service.pauseWorkflow(wf.id, true);
  // Changing a model after verification invalidates it.
  await service.saveAgent({ ...input, model: "opus" }, id);
  assert.throws(() => service.pauseWorkflow(wf.id, false), {
    code: "models_unverified",
  });
});

test("Opus 5.5 lead check accepts 5.5 Opus ids only", () => {
  for (const ok of [
    "claude-opus-5-5",
    "claude-opus-5-5-20261001",
    "claude-opus-5-5 Opus 5.5",
    "opus Opus 5.5",
  ])
    assert.ok(isOpus55(ok), ok);
  for (const bad of [
    "opus Opus",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-sonnet-5-5",
    "claude-opus-5-55",
    "claude-opus-15-5",
    "claude-opus-5-5.1",
  ])
    assert.ok(!isOpus55(bad), bad);
});

test("alias-only Claude discovery surfaces an explicit Opus 5.5 id instead of blocking or substituting it", async () => {
  const { store, service } = make();
  const wf = createWolframSample(service, { wolframAgents: 1 });
  const aliasOnly = structuredClone(defaults).map((r) => ({
    ...r,
    installed: true,
  }));
  const lead = store.get<Agent>("agent", wf.ownerId);
  const { id, createdAt, control, ...input } = lead;
  await service.saveAgent({ ...input, model: "claude-opus-5-5" }, id);
  const check = verifySampleModels(service, wf.id, aliasOnly);
  assert.equal(check.verified, true, check.issues.join(";"));
  assert.match(check.warnings.join("\n"), /claude-opus-5-5.*unchanged/);
  assert.equal(store.get<Agent>("agent", wf.ownerId).model, "claude-opus-5-5");
  // A non-Opus-5.5 unadvertised id is still a blocker.
  await service.saveAgent({ ...input, model: "claude-sonnet-5-5" }, id);
  assert.equal(verifySampleModels(service, wf.id, aliasOnly).verified, false);
});

test("a task for an agent outside the verified mapping blocks resume", async () => {
  const { store, service } = make();
  const wf = createWolframSample(service, { wolframAgents: 1 });
  const lead = store.get<Agent>("agent", wf.ownerId);
  const { id, createdAt, control, ...input } = lead;
  await service.saveAgent({ ...input, model: "claude-opus-5-5" }, id);
  assert.equal(
    verifySampleModels(service, wf.id, runtimes("claude-opus-5-5")).verified,
    true,
  );
  const extra = await service.saveAgent({
    ...input,
    name: "Unverified helper",
    model: "sonnet",
  });
  service.task({
    workflowId: wf.id,
    agentId: extra.id,
    title: "Extra step",
    instructions: "",
    completionCriteria: "Done",
  });
  assert.throws(() => service.pauseWorkflow(wf.id, false), {
    code: "models_unverified",
  });
});
