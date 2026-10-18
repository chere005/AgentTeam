// Must stay the first import: points AGENTTEAM_DATA_DIR at a temp folder before config.ts loads.
import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { prepareRunContext } from "../src/run-context.ts";
import { contextCost } from "../src/context-cost.ts";
import { capabilityRoute } from "../src/capability-routes.ts";

test("context cost lists recent runs of one agent from run.context events", async (t) => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "agentteam-cc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "s"));
  await writeFile(
    join(root, "s", "SKILL.md"),
    "---\nname: always-skill\ndescription: Always on\n---\n\nALWAYS-BODY " +
      "x".repeat(400) +
      "\n",
  );
  const catalog = new SkillCatalog([
    { path: root, environment: "codex", origin: "installed", label: "T" },
  ]);
  await catalog.scan();
  const store = new Store(":memory:"),
    service = new TeamService(store, catalog);
  t.after(() => store.close());
  const skill = [...catalog.items.values()][0];
  const make = (name: string, instructions: string) =>
    service.saveAgent({
      name,
      environment: "codex",
      role: "Dev",
      instructions,
      skills: [{ id: skill.id, mode: "always" }],
    });
  const a = await make("A", "short");
  const b = await make("B", "other");
  const wf = service.workflow({
    name: "W",
    goal: "G",
    ownerId: a.id,
    completionCriteria: "D",
  });
  const task = service.task({
    workflowId: wf.id,
    agentId: a.id,
    title: "Build the parser",
    completionCriteria: "D",
  });
  const run = async (agentId: string, subject: string, extra = "") => {
    const plan = await service.launchPlan(agentId);
    plan.instructions += extra;
    await prepareRunContext(service, plan, "do it", subject);
  };
  await run(a.id, task.id);
  await run(b.id, "session-b");
  await run(a.id, "session-a");

  const cost = contextCost(service, a.id);
  assert.equal(cost.runs.length, 2, "only this agent's runs");
  assert.deepEqual(
    cost.runs.map((r) => [r.kind, r.label]),
    [
      ["task", "Build the parser"],
      ["conversation", "Conversation"],
    ],
    "oldest first; task title resolved",
  );
  const [first] = cost.runs;
  assert.ok(first.total > 0);
  assert.ok(first.skills > 0 && first.skills <= first.total);
  assert.equal(first.skillsLoaded, 1);
  assert.equal(cost.summary.count, 2);
  assert.equal(cost.summary.max, Math.max(...cost.runs.map((r) => r.total)));
  assert.equal(cost.summary.latest, cost.runs[1].total);
  assert.ok(!JSON.stringify(cost).includes("ALWAYS-BODY"), "no skill text");
  assert.equal(contextCost(service, a.id, 1).runs.length, 1);
  assert.equal(contextCost(service, a.id, 1).runs[0].label, "Conversation");
  assert.equal(contextCost(service, "nobody").summary.count, 0);

  const route = (path: string) =>
    capabilityRoute(
      service,
      "GET",
      new URL("http://x" + path),
      async () => ({}),
    );
  const r = await route(`/agents/${a.id}/context-cost?limit=1`);
  assert.equal((r!.data as any).runs.length, 1);
  await assert.rejects(route(`/agents/${a.id}/context-cost?limit=0`));
  await assert.rejects(
    route(`/agents/nope/context-cost`),
    (e: any) => e.code === "not_found",
  );
});
