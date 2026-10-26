// Must precede config imports; these tests never use a live profile or provider.
import "./fixtures/temp-data-dir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { AssistantProposals, type ProposalOptions } from "../src/assistant.ts";
import { assistantContext } from "../src/assistant-context.ts";
import { defaults } from "../src/discovery.ts";
import { resumeProject } from "../src/readiness.ts";
import {
  AppError,
  type Agent,
  type Task,
  type Workflow,
} from "../src/model.ts";

const user = { type: "user" } as const;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const workspace = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-assistant-start-")),
  );
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const lead = await service.saveAgent({
    name: "Lead",
    environment: "claude",
    model: "default",
    roleType: "implementer",
  });
  const worker = await service.saveAgent({
    name: "Writer",
    environment: "claude",
    model: "default",
    roleType: "implementer",
    parentId: lead.id,
  });
  const discovery = {
    settled: true,
    runtimes: structuredClone(defaults).map((runtime) => ({
      ...runtime,
      installed: true,
      authenticated: true,
    })),
  };
  t.after(async () => {
    store.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const input = () => ({
    title: "Report for duty",
    ops: [
      {
        op: "project.start",
        teamId: "main",
        name: "Duty files",
        goal: "Each agent writes its own duty file",
        workspace,
        tasks: [lead, worker].map((agent) => ({
          agentId: agent.id,
          title: `Write ${agent.name}.txt`,
          instructions: `Write ${agent.name}.txt containing exactly: reporting for duty`,
          completionChecks: [
            { type: "artifact-exists", path: `${agent.name}.txt` },
            {
              type: "artifact-matches",
              path: `${agent.name}.txt`,
              pattern: "^reporting for duty$",
            },
          ],
        })),
      },
    ],
  });
  return { workspace, store, service, lead, worker, discovery, input };
}

test("assistant Start tasks saves explicit independent tasks before invoking the normal readiness gate", async (t) => {
  const f = await fixture(t);
  let starts = 0;
  const proposals = new AssistantProposals(f.service, {
    startProject: async (id) => {
      starts++;
      assert.equal(f.store.get<Workflow>("workflow", id).paused, true);
      const tasks = f.store.list<Task>("task");
      assert.equal(tasks.length, 2);
      assert.ok(
        tasks.every(
          (task) =>
            task.executionMode === "file-only" &&
            task.status === "queued" &&
            task.dependsOn.length === 0,
        ),
      );
      assert.ok(tasks.every((task) => task.completionChecks?.length === 2));
      return resumeProject(f.service, f.discovery, id);
    },
  });
  const proposal = await proposals.create(f.input(), {
    type: "assistant",
    agentId: "assistant",
  });
  assert.equal(starts, 0, "preview never starts providers");
  assert.equal(f.store.list("workflow").length, 0);
  assert.equal(f.store.list("task").length, 0);
  assert.equal(
    proposals.detail(proposal.id).diff[0].label,
    "Start 2 independent tasks",
  );
  await assert.rejects(proposals.apply(proposal.id, user), {
    code: "approval_required",
  });
  proposals.approve(proposal.id, user);
  const applied = await proposals.apply(proposal.id, user);
  assert.equal(applied.status, "applied");
  assert.equal(applied.execution?.state, "started");
  assert.equal(
    f.store.get<Workflow>("workflow", applied.result![0].id).paused,
    false,
  );
  assert.equal(starts, 1);
  assert.deepEqual(await proposals.apply(proposal.id, user), applied);
  assert.equal(
    starts,
    1,
    "duplicate click does not restart a successfully started assignment",
  );
  assert.equal(f.store.list("workflow").length, 1);
  assert.equal(f.store.list("effect").length, 0);
  assert.equal(f.store.list("pipeline").length, 0);
});

test("assistant setup errors keep the saved tasks and retry the same project, including after restart", async (t) => {
  const f = await fixture(t);
  const ids: string[] = [];
  let unavailable = true;
  const options: ProposalOptions = {
    startProject: async (id) => {
      ids.push(id);
      if (unavailable)
        throw new AppError(
          424,
          "runtime_unavailable",
          "Writer: Sign in to Claude",
        );
      return resumeProject(f.service, f.discovery, id);
    },
  };
  let proposals = new AssistantProposals(f.service, options);
  const p = await proposals.create(f.input(), user);
  proposals.approve(p.id, user);
  const blocked = await proposals.apply(p.id, user);
  assert.equal(blocked.status, "applied");
  assert.deepEqual(blocked.execution, {
    state: "blocked",
    reason: "runtime_unavailable: Writer: Sign in to Claude",
  });
  assert.equal(
    f.store.get<Workflow>("workflow", blocked.result![0].id).paused,
    true,
  );
  // Reconstructing the controller simulates an app restart; execution state is persisted.
  proposals = new AssistantProposals(f.service, options);
  await proposals.apply(p.id, user);
  unavailable = false;
  const started = await proposals.apply(p.id, user);
  assert.equal(started.execution?.state, "started");
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.store.list("workflow").length, 1);
  assert.equal(f.store.list("task").length, 2);
  assert.equal(f.store.list("effect").length, 0);
});

test("assistant assignment rollback restores attachments and removes every unstarted task", async (t) => {
  const f = await fixture(t);
  const before = f.store.list<Agent>("agent");
  let starts = 0;
  const proposals = new AssistantProposals(f.service, {
    afterOp: () => {
      throw new Error("interrupted apply");
    },
    startProject: async () => {
      starts++;
    },
  });
  const p = await proposals.create(f.input(), user);
  proposals.approve(p.id, user);
  await assert.rejects(proposals.apply(p.id, user), /interrupted apply/);
  assert.equal(starts, 0);
  assert.equal(proposals.get(p.id).status, "failed");
  assert.equal(f.store.list("workflow").length, 0);
  assert.equal(f.store.list("task").length, 0);
  assert.equal(f.store.list("workflow-limits").length, 0);
  assert.equal(f.store.list("specialist-trigger").length, 0);
  assert.deepEqual(f.store.list<Agent>("agent"), before);
});

test("assistant cannot start empty, mixed, duplicate or out-of-scope file assignments", async (t) => {
  const f = await fixture(t);
  const proposals = new AssistantProposals(f.service);
  const invalid: unknown[] = [];
  const empty = f.input();
  empty.ops[0].tasks = [];
  invalid.push(empty);
  const duplicate = f.input();
  duplicate.ops[0].tasks[1].agentId = f.lead.id;
  invalid.push(duplicate);
  const sameFile = f.input();
  sameFile.ops[0].tasks[1].completionChecks[0].path = "./Lead.txt";
  invalid.push(sameFile);
  const outside = f.input();
  outside.ops[0].tasks[0].completionChecks[0].path = "../outside.txt";
  invalid.push(outside);
  const absolute = f.input();
  absolute.ops[0].tasks[0].completionChecks[0].path = join(
    f.workspace,
    "Lead.txt",
  );
  invalid.push(absolute);
  invalid.push({
    ...f.input(),
    ops: [
      ...f.input().ops,
      { op: "agent.update", id: f.lead.id, changes: { name: "Changed" } },
    ],
  });
  if (process.platform === "win32")
    for (const path of [
      "CON.txt",
      "Writer?.txt",
      "Writer.txt ",
      "Writer.txt:stream",
    ]) {
      const invalidName = f.input();
      invalidName.ops[0].tasks[0].completionChecks[0].path = path;
      invalid.push(invalidName);
    }
  for (const input of invalid)
    await assert.rejects(proposals.create(input, user));
  const foreign = f.input();
  foreign.ops[0].teamId = "other-team";
  await assert.rejects(proposals.create(foreign, user), /active team/);
  assert.equal(f.store.list("workflow").length, 0);
  assert.equal(f.store.list("task").length, 0);
});

test("assistant context reports simple-task compatibility and distinguishes a blank project from work", async (t) => {
  const f = await fixture(t);
  const context = assistantContext(f.service, { liveEnabled: () => false });
  assert.ok(context.body.agents.items.every((agent) => "simpleTask" in agent));
  assert.match(context.text, /workflow\.create.*EMPTY DRAFT/);
  assert.match(context.text, /project\.start.*create AND start/);
  assert.match(context.text, /creates NO tasks and starts NO agents/);
});

test("assistant previews preserve adapter settings and become stale when connection capabilities change", async (t) => {
  const f = await fixture(t);
  const proposals = new AssistantProposals(f.service);
  const connections = (transport: "direct" | "acp") =>
    f.store.put("settings", {
      id: "connections",
      providers: {
        claude: { transport, executable: "fixture-only", args: [] },
      },
    });
  connections("acp");
  await assert.rejects(
    proposals.create(f.input(), user),
    /simple_task_unsupported.*adapter cannot disable terminal tools/,
  );
  assert.equal(f.store.list("workflow").length, 0);
  connections("direct");
  const proposal = await proposals.create(f.input(), user);
  connections("acp");
  assert.equal(proposals.get(proposal.id).status, "stale");
  await assert.rejects(proposals.apply(proposal.id, user), {
    code: "proposal_stale",
  });
  assert.equal(f.store.list("task").length, 0);
});

test("assistant previews preserve a team's lead and retirement constraints", async (t) => {
  const f = await fixture(t);
  f.store.put("team-profile", {
    id: "main",
    leadId: f.worker.id,
    retired: [
      { agentId: f.lead.id, role: "worker", at: new Date().toISOString() },
    ],
  });
  const proposals = new AssistantProposals(f.service);
  await assert.rejects(proposals.create(f.input(), user), /agent_retired/);
  assert.equal(f.store.list("workflow").length, 0);
  assert.equal(f.store.list("task").length, 0);
});
