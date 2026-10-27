import "./fixtures/temp-data-dir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { filesystemPolicy } from "../src/filesystem-policy.ts";
import type { Task } from "../src/model.ts";

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  blockOutside = false,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-dispatch-artifacts-")),
  );
  const workspace = join(directory, "workspace");
  const scope = join(workspace, "assigned");
  const outside = join(directory, "outside");
  await mkdir(scope, { recursive: true });
  await mkdir(outside);
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  if (blockOutside)
    filesystemPolicy(store).add({
      paths: [outside],
      acknowledgePermanent: true,
    });
  const caller = await service.saveAgent({
    name: "Manager",
    environment: "claude",
  });
  const writer = await service.saveAgent({
    name: "Writer",
    environment: "claude",
    tools: ["read", "write"],
    workspaces: [{ path: workspace, active: true, access: "write" }],
  });
  service.saveEdge({ from: caller.id, to: writer.id, kind: "delegate" });
  const workflow = service.workflow({
    name: "Duty files",
    goal: "Write Writer.txt containing exactly reporting for duty",
    ownerId: caller.id,
    completionCriteria: "Files checked",
  });
  // The fixture user supplies the expected content; the delegated regex merely encodes it.
  service.contracts.seedProject({
    workflowId: workflow.id,
    text: workflow.goal,
    source: "request",
    owner: caller,
  });
  const parent = service.task({
    workflowId: workflow.id,
    agentId: caller.id,
    title: "Delegate writes",
    completionCriteria: "Files checked",
  });
  service.transitionTask(parent.id, { status: "running" });
  const dispatch = (path: string, extra: object = {}) =>
    service.orchestration.invokeTeammate(
      { agentId: caller.id, taskId: parent.id },
      {
        recipient: writer.id,
        title: "Write duty file",
        completionChecks: [
          { type: "artifact-exists", path },
          { type: "artifact-matches", path, pattern: "^reporting for duty$" },
        ],
        ...extra,
      },
    );
  const counts = () => ({
    tasks: store.list("task").length,
    invocations: store.list("invocation").length,
    leases: store.list("lease").length,
    limits: service.limits.state(workflow.id).counters,
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    scope,
    outside,
    store,
    service,
    caller,
    writer,
    workflow,
    parent,
    dispatch,
    counts,
  };
}

test("delegation normalizes absolute artifact paths inside the exact task folder before saving work", async (t) => {
  const f = await fixture(t);
  const absolute = join(f.scope, "Writer.txt");
  const childId = f.dispatch(absolute, {
    resourcePaths: [f.scope],
  }).childTaskId;
  const child = f.store.get<Task>("task", childId);
  assert.deepEqual(
    child.completionChecks?.map((check) =>
      "path" in check ? check.path : null,
    ),
    ["Writer.txt", "Writer.txt"],
  );
  assert.deepEqual(child.resourcePaths, [f.scope]);
  const invocation = f.store.get<{
    request: { completionChecks: { path: string }[] };
  }>("invocation", childId);
  assert.equal(
    invocation.request.completionChecks[0].path,
    absolute,
    "original submitted contract retained in the invocation audit",
  );
  await writeFile(absolute, "reporting for duty");
  const checked = await f.service.limits.evaluate(child, "Done", f.scope);
  assert.equal(checked?.passed, true);
});

test("delegation resolves the effective simple-project folder rather than the recipient's broad active folder", async (t) => {
  const f = await fixture(t);
  f.store.put("workflow", {
    ...f.workflow,
    setup: { executionMode: "file-only", workspace: f.scope },
  });
  const before = f.counts();
  assert.throws(() => f.dispatch(join(f.workspace, "sibling.txt")), {
    code: "artifact_path_escape",
  });
  assert.deepEqual(f.counts(), before);
  const id = f.dispatch(join(f.scope, "Writer.txt")).childTaskId;
  assert.deepEqual(f.store.get<Task>("task", id).resourcePaths, [f.scope]);
  assert.equal(
    f.store.get<Task>("task", id).completionChecks?.[0].type,
    "artifact-exists",
  );
});

test("invalid artifact contracts fail before tasks, invocation records or delegation counters are changed", async (t) => {
  const f = await fixture(t);
  for (const path of [
    join(f.outside, "Writer.txt"),
    join(f.workspace, "sibling.txt"),
    "../sibling.txt",
    ".git/config",
    join(f.scope, ".git", "config"),
  ]) {
    const before = f.counts();
    assert.throws(
      () => f.dispatch(path, { resourcePaths: [f.scope] }),
      /Artifact path/,
    );
    assert.deepEqual(
      f.counts(),
      before,
      `invalid contract was not persisted: ${path}`,
    );
  }
  if (process.platform === "win32") {
    for (const path of [
      "bad:stream.txt",
      "CON.txt",
      "file.txt.",
      "file.txt ",
    ]) {
      const before = f.counts();
      assert.throws(() => f.dispatch(path, { resourcePaths: [f.scope] }), {
        code: "invalid_artifact_path",
      });
      assert.deepEqual(f.counts(), before);
    }
  }
});

test("artifact contract dispatch rejects denied files and symlink escapes even when the target does not exist", async (t) => {
  const f = await fixture(t);
  const link = join(f.scope, "linked");
  await symlink(
    f.outside,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  let before = f.counts();
  assert.throws(
    () => f.dispatch(join(link, "future.txt"), { resourcePaths: [f.scope] }),
    { code: "artifact_path_escape" },
  );
  assert.deepEqual(f.counts(), before);
  f.store.put("agent", {
    ...f.writer,
    workspaces: [
      {
        path: f.workspace,
        access: "write",
        active: true,
        rules: [{ path: "assigned/private", access: "none" }],
      },
    ],
  });
  before = f.counts();
  assert.throws(() => f.dispatch("assigned/private/future.txt"), {
    code: "artifact_access_denied",
  });
  assert.deepEqual(f.counts(), before);
});

test("artifact contract dispatch checks permanent denials and an attached task folder before recording work", async (t) => {
  const f = await fixture(t, true);
  let before = f.counts();
  assert.throws(() => f.dispatch(join(f.outside, "Writer.txt")), {
    code: "filesystem_blocked",
  });
  assert.deepEqual(f.counts(), before);
  f.store.put("agent", { ...f.writer, workspaces: [] });
  before = f.counts();
  assert.throws(() => f.dispatch("Writer.txt"), {
    code: "artifact_workspace_required",
  });
  assert.deepEqual(f.counts(), before);
  const definition = f.service.orchestration
    .tools({ agentId: f.caller.id, taskId: f.parent.id })
    .find((tool) => tool.name === "invoke_teammate")!;
  assert.match(JSON.stringify(definition.inputSchema), /relative.*Worker.txt/);
});
