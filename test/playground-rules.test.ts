// Must stay the first import: points AGENTTEAM_DATA_DIR at a temp folder before config.ts loads.
import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { transfers } from "../src/inspector.ts";
import { Playground } from "../src/playground.ts";
import { Redactor } from "../src/redact.ts";
import type { Rule, Task } from "../src/model.ts";

async function team() {
  const store = new Store(":memory:"),
    service = new TeamService(store, new SkillCatalog([]));
  const lead = await service.saveAgent({ name: "Lead", environment: "codex" });
  const builder = await service.saveAgent({
    name: "Builder",
    environment: "codex",
  });
  const other = await service.saveAgent({
    name: "Other",
    environment: "codex",
  });
  for (const to of [builder, other])
    service.saveEdge({ from: lead.id, to: to.id, kind: "delegate" });
  const rule = service.saveRule({
    agentId: lead.id,
    scope: "action",
    targetId: builder.id,
    priority: 50,
    kind: "delegate",
    match: { textIncludes: ["compile"] },
  }) as Rule;
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: lead.id,
    completionCriteria: "D",
  });
  return { store, service, lead, builder, other, rule, wf };
}

test("the routing decision is recorded when a delegated task is created", async () => {
  const { store, service, lead, builder, other, rule, wf } = await team();
  const mk = (agentId: string, title: string, extra: object = {}) =>
    service.task({
      workflowId: wf.id,
      agentId,
      title,
      completionCriteria: "D",
      ...extra,
    }) as Task;
  const hit = mk(builder.id, "compile the project", { invokedBy: lead.id });
  assert.equal(hit.routing!.status, "selected");
  assert.equal(hit.routing!.selectedAgentId, builder.id);
  assert.equal(hit.routing!.assigneeMatched, true);
  assert.deepEqual(
    hit.routing!.matches.map((m) => m.ruleId),
    [rule.id],
  );
  // The assignee differs from what the rules would pick: recorded, not hidden.
  const diverged = mk(other.id, "compile the project", { invokedBy: lead.id });
  assert.equal(diverged.routing!.assigneeMatched, false);
  assert.equal(diverged.routing!.selectedAgentId, builder.id);
  const none = mk(builder.id, "write docs", { invokedBy: lead.id });
  assert.equal(none.routing!.status, "unmatched");
  assert.equal(mk(builder.id, "no invoker").routing, undefined);
  assert.equal(store.get<Task>("task", hit.id).routing!.at, hit.routing!.at);

  // Later rule changes do not rewrite history: the transfer reports the recorded decision.
  service.saveRule(
    {
      agentId: lead.id,
      scope: "action",
      targetId: builder.id,
      priority: 50,
      kind: "delegate",
      enabled: false,
      match: { textIncludes: ["compile"] },
    },
    rule.id,
  );
  const t = transfers(service, { taskId: hit.id })[0];
  assert.equal(t.rule.recorded, true);
  assert.deepEqual(
    t.rule.matchedRules.map((m) => m.ruleId),
    [rule.id],
  );
  assert.match(t.rule.note, /Recorded when the task was created/);
  const miss = transfers(service, { taskId: none.id })[0];
  assert.equal(miss.rule.recorded, true);
  assert.deepEqual(miss.rule.matchedRules, []);
  // A task from before this field existed still gets the inferred wording.
  const legacy = mk(builder.id, "compile again", { invokedBy: lead.id });
  const { routing: _routing, ...bare } = store.get<Task>("task", legacy.id);
  void _routing;
  store.put("task", bare);
  assert.equal(
    transfers(service, { taskId: legacy.id })[0].rule.recorded,
    undefined,
  );
  store.close();
});

test("playground runs take per-run routing-rule overrides and the comparison shows them", async () => {
  const { store, service, rule } = await team();
  const playground = new Playground(
    service,
    () => new Redactor({ secretFiles: [] }),
  );
  const example = playground.saveExample({
    name: "Delegate",
    tasks: [
      { key: "plan", title: "Plan", agent: "Lead" },
      {
        key: "build",
        title: "compile the project",
        agent: "Builder",
        invokedBy: "Lead",
      },
    ],
    fixture: {},
    expected: { workflowStatus: "completed" },
  });
  const liveRules = JSON.stringify(store.list("rule"));
  const base = await playground.execute({
    exampleId: example.id,
    label: "live",
  });
  assert.equal(base.config.ruleOverrides!.length, 0);
  const baseRouting = base.outcomes.find((o) => o.key === "build")!.routing!;
  assert.equal(baseRouting.status, "selected");
  assert.equal(baseRouting.assigneeMatched, true);

  const off = await playground.execute({
    exampleId: example.id,
    label: "rule off",
    overrides: { rules: { disable: [rule.id] } },
  });
  assert.equal(off.config.ruleOverrides!.length, 1);
  assert.match(
    off.config.ruleOverrides![0],
    /disabled action rule on Lead -> Builder/,
  );
  assert.equal(
    off.outcomes.find((o) => o.key === "build")!.routing!.status,
    "unmatched",
  );

  const added = await playground.execute({
    exampleId: example.id,
    label: "other wins",
    overrides: {
      rules: {
        priority: { [rule.id]: 10 },
        add: [
          {
            agent: "Lead",
            target: "Other",
            scope: "action",
            priority: 90,
            match: { textIncludes: ["compile"] },
          },
        ],
      },
    },
  });
  const r = added.outcomes.find((o) => o.key === "build")!.routing!;
  assert.equal(r.selectedAgent, "Other");
  assert.equal(r.assigneeMatched, true, "the live rule still targets Builder");
  assert.equal(added.config.ruleOverrides!.length, 2);

  const diff = playground.compare(base.id, off.id);
  assert.equal(diff.config.changed, true);
  assert.equal(diff.config.ruleOverrides.changed, true);
  assert.equal(diff.outcomes.routingChanged, 1);
  assert.equal(
    diff.outcomes.tasks.find((o) => o.key === "build")!.routingChanged,
    true,
  );
  assert.match(diff.summary, /routing decisions differ for 1 task/);
  assert.equal(playground.compare(base.id, base.id).outcomes.routingChanged, 0);

  // Bad overrides are refused before anything runs; the live rules are never touched.
  await assert.rejects(
    playground.execute({
      exampleId: example.id,
      overrides: { rules: { disable: ["nope"] } },
    }),
    (e: any) => e.code === "unknown_rule",
  );
  await assert.rejects(
    playground.execute({
      exampleId: example.id,
      overrides: {
        rules: {
          add: [
            {
              agent: "Ghost",
              scope: "intake",
              priority: 1,
              match: { catchAll: true },
            },
          ],
        },
      },
    }),
    (e: any) => e.code === "unknown_agent",
  );
  await assert.rejects(
    playground.execute({
      exampleId: example.id,
      overrides: {
        rules: {
          add: [{ agent: "Lead", scope: "intake", priority: 1, match: {} }],
        },
      },
    }),
    /Specify a match/,
  );
  assert.equal(playground.running, false);
  assert.equal(JSON.stringify(store.list("rule")), liveRules);
  store.close();
});
