import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProviderCapabilities,
  providerCapabilityIssue,
} from "../src/provider-capabilities.ts";
import { toProviderError } from "../src/provider-errors.ts";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { ReadinessService, type DiscoveryLike } from "../src/readiness.ts";
import { noteRuntimeWait, RUNTIME_WAIT } from "../src/runtime-waits.ts";
import type { Task } from "../src/model.ts";

test("native Windows refuses only direct Claude's granted sandboxed shell profile", () => {
  const issue = providerCapabilityIssue(
    { allowedTools: ["Bash"] },
    "claude",
    "win32",
  );
  assert.equal(issue?.capability, "sandboxed-shell");
  assert.match(issue!.message, /WSL2/);
  assert.throws(
    () =>
      assertProviderCapabilities({ allowedTools: ["Bash"] }, "claude", "win32"),
    { code: "sandbox_unavailable", kind: "sandbox-unavailable", status: 409 },
  );
  for (const platform of ["darwin", "linux"] as const)
    assert.equal(
      providerCapabilityIssue({ allowedTools: ["Bash"] }, "claude", platform),
      null,
    );
  assert.equal(
    providerCapabilityIssue({ allowedTools: ["Write"] }, "claude", "win32"),
    null,
  );
  assert.equal(providerCapabilityIssue({}, "claude", "win32"), null);
  assert.equal(
    providerCapabilityIssue({ allowedTools: ["Bash"] }, "codex", "win32"),
    null,
  );
  assert.equal(
    providerCapabilityIssue(
      {
        allowedTools: ["Bash"],
        acp: { sessionId: null, prompt: "", model: "default", effort: null },
      },
      "claude",
      "win32",
    ),
    null,
  );
});

const discovery: DiscoveryLike = {
  runtimes: [],
  settled: true,
  scanning: false,
  refresh: async () => [],
  readiness: () => ({ state: "ready" }),
};

test("sandbox blocker survives restart and scans, then configuration repair resumes it exactly once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-capability-"));
  const filename = join(dir, "state.sqlite");
  let store = new Store(filename);
  let service = new TeamService(store, new SkillCatalog([]));
  let readiness: ReadinessService | undefined;
  try {
    const input = {
      name: "Writer",
      environment: "claude",
      tools: ["read", "write", "shell"],
      workspaces: [{ path: dir, access: "write", active: true }],
    };
    const agent = await service.saveAgent(input);
    const workflow = service.workflow({
      name: "Files",
      ownerId: agent.id,
      goal: "Write a file",
      completionCriteria: "The file exists",
    });
    const task = service.task({
      workflowId: workflow.id,
      agentId: agent.id,
      title: "Write file",
      completionCriteria: "The file exists",
    });
    service.transitionTask(task.id, { status: "running" });
    service.transitionTask(task.id, {
      status: "blocked",
      result: "Required sandbox unavailable",
    });
    noteRuntimeWait(store, {
      kind: "task",
      targetId: task.id,
      environment: "claude",
      reason: "sandbox-unavailable",
      capability: "sandboxed-shell",
      message: "Use a supported runtime or remove the unnecessary shell tool",
      attempt: 1,
    });
    assert.equal(store.list("lease").length, 0);
    store.close();
    store = new Store(filename);
    service = new TeamService(store, new SkillCatalog([]));
    service.recovery.recover();
    readiness = new ReadinessService({
      service,
      discovery,
      platform: "win32",
    }).start();
    for (let i = 0; i < 3; i++) {
      store.emit("runtimes.discovered", "runtimes");
      readiness.flush();
      assert.equal(store.get<Task>("task", task.id).status, "blocked");
      assert.equal(service.recovery.state(task.id).attempt, 1);
      assert.equal(store.list(RUNTIME_WAIT).length, 1);
    }
    await service.saveAgent({ ...input, tools: ["read", "write"] }, agent.id);
    readiness.flush();
    assert.equal(store.get<Task>("task", task.id).status, "queued");
    assert.equal(
      service.recovery.state(task.id).attempt,
      1,
      "a pre-process block resumes the same attempt",
    );
    assert.equal(store.list(RUNTIME_WAIT).length, 0);
    assert.deepEqual(readiness.requeueReady(), []);
    assert.equal(
      store.history(0, 1000).filter((e) => e.type === "task.runtime_requeued")
        .length,
      1,
    );
    assert.ok(
      service.recovery
        .checkpoints(task.id)
        .some((c) => c.boundary === "task.blocked"),
    );
  } finally {
    readiness?.stop();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a provider's sandbox diagnostic does not erase uncertainty after a mutating launch", async () => {
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  try {
    const agent = await service.saveAgent({
      name: "Writer",
      environment: "claude",
    });
    const workflow = service.workflow({
      name: "Files",
      ownerId: agent.id,
      goal: "Write",
      completionCriteria: "Done",
    });
    const task = service.task({
      workflowId: workflow.id,
      agentId: agent.id,
      title: "Write",
      completionCriteria: "Done",
    });
    service.transitionTask(task.id, { status: "running" });
    const run = service.recovery.startRun(task, true);
    service.recovery.failRun(
      task,
      run.effectId,
      toProviderError(new Error("Sandbox required but unavailable")),
    );
    assert.equal(service.recovery.ledger.uncertainFor(task.id).length, 1);
  } finally {
    store.close();
  }
});
