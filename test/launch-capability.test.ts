import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { commandFor } from "../src/runtime.ts";
import { effectiveCapabilities } from "../src/launch-capability.ts";
import { requiredFor } from "../src/launch-readiness.ts";

// The effective capabilities are derived from the same helpers `commandFor` builds the provider
// command from. These cases compare the two on real launch plans, so the readiness decision, the
// generated line and the manifest cannot claim a tool the command does not name.

async function plans(t: { after: (fn: () => unknown) => void }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "agentteam-caps-")));
  const store = new Store(":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const make = async (extra: object) => {
    const agent = await service.saveAgent({
      name: `A${store.list("agent").length}`,
      environment: "claude",
      ...extra,
    });
    const plan = await service.launchPlan(agent.id);
    return { agent, plan, command: commandFor(plan, null, "p", dir) };
  };
  return { dir, service, make };
}
const toolsOf = (args: string[]) =>
  (args[args.indexOf("--tools") + 1] ?? "").split(",").filter(Boolean);

test("Claude capabilities match the --tools the command names", async (t) => {
  const { dir, make } = await plans(t);
  const folder = (access: string, extra: object = {}) => [
    { path: dir, access, active: true, ...extra },
  ];
  const cases = [
    ["no folder", { tools: ["read", "write", "shell"] }],
    [
      "read-only folder",
      { tools: ["read", "grep", "write", "shell"], workspaces: folder("read") },
    ],
    [
      "write folder, no shell grant",
      { tools: ["read", "edit", "write"], workspaces: folder("write") },
    ],
    [
      "write folder with shell",
      {
        tools: ["read", "grep", "glob", "edit", "write", "shell"],
        workspaces: folder("write"),
      },
    ],
    [
      "no read grant",
      { tools: ["write", "shell"], workspaces: folder("write") },
    ],
    [
      "access rules",
      {
        tools: ["read", "write", "shell"],
        workspaces: folder("write", { rules: [{ path: "x", access: "none" }] }),
      },
    ],
  ] as const;
  for (const [name, extra] of cases) {
    const { plan, command } = await make(extra);
    const named = toolsOf(command.args);
    const effective = effectiveCapabilities(plan, { platform: "linux" });
    assert.deepEqual(effective.toolNames, named, name);
    assert.equal(effective.available.read, named.includes("Read"), name);
    assert.equal(
      effective.available.write,
      named.includes("Edit") || named.includes("Write"),
      name,
    );
    assert.equal(effective.available.shell, named.includes("Bash"), name);
    // Every missing capability a role asked for has a typed, human reason.
    for (const capability of ["read", "write", "shell"] as const)
      if (!effective.available[capability])
        assert.ok(
          effective.gaps[capability]?.message.length,
          `${name}: ${capability}`,
        );
  }
});

test("Codex capabilities follow the sandbox the command selects; the shell is not tied to a folder", async (t) => {
  const { dir, make } = await plans(t);
  const writable = await make({
    environment: "codex",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: dir, access: "write", active: true }],
  });
  assert.ok(writable.command.args.includes('sandbox_mode="workspace-write"'));
  const w = effectiveCapabilities(writable.plan);
  assert.deepEqual(
    [w.available.read, w.available.write, w.available.shell, w.sandbox],
    [true, true, true, "codex-workspace-write"],
  );
  const readOnly = await make({
    environment: "codex",
    tools: ["read", "write", "shell"],
    workspaces: [{ path: dir, access: "read", active: true }],
  });
  assert.ok(readOnly.command.args.includes('sandbox_mode="read-only"'));
  const r = effectiveCapabilities(readOnly.plan);
  assert.deepEqual(
    [r.available.read, r.available.write, r.available.shell, r.sandbox],
    [true, false, true, "codex-read-only"],
  );
  assert.equal(r.gaps.write?.code, "folder-read-only");
  const folderless = await make({ environment: "codex", tools: ["shell"] });
  const f = effectiveCapabilities(folderless.plan);
  assert.deepEqual(
    [f.available.read, f.available.write, f.available.shell],
    [false, false, true],
  );
});

test("Wolfram and ACP expose nothing AgentTeam can establish; native Windows has no sandbox for Claude's shell", async (t) => {
  const { dir, make, service } = await plans(t);
  const wolfram = await make({
    environment: "wolfram",
    tools: ["write", "shell"],
  });
  const w = effectiveCapabilities(wolfram.plan);
  assert.deepEqual(Object.values(w.available), [false, false, false]);
  assert.equal(w.gaps.write?.code, "adapter-unsupported");
  service.store.put("settings", {
    id: "connections",
    providers: {
      claude: { transport: "acp", executable: "/bin/true", args: [] },
    },
  });
  const acp = await make({
    tools: ["read", "write", "shell"],
    workspaces: [{ path: dir, access: "write", active: true }],
  });
  const a = effectiveCapabilities(acp.plan);
  assert.equal(a.adapter, "acp");
  assert.equal(a.sandbox, "adapter-managed");
  assert.deepEqual(Object.values(a.available), [false, false, false]);
  service.store.put("settings", { id: "connections", providers: {} });
  const claude = await make({
    tools: ["read", "write", "shell"],
    workspaces: [{ path: dir, access: "write", active: true }],
  });
  assert.equal(
    effectiveCapabilities(claude.plan, { platform: "linux" }).available.shell,
    true,
  );
  const win = effectiveCapabilities(claude.plan, { platform: "win32" });
  assert.equal(win.available.shell, false);
  assert.equal(win.gaps.shell?.code, "sandbox-unavailable");
  assert.equal(win.available.write, true, "only the shell is lost");
});

test("what a role must do: the contract's work kind, plus the grants it holds unless the user said response-only", () => {
  const task = (
    workKind: "response-only" | "file-edit" | "executable-implementation",
    workKindSource: "request" | "user" = "request",
  ) => ({
    scope: "task" as const,
    workKind,
    workKindSource,
    roles: [],
  });
  const read = (
    roleClass: any,
    contract: any,
    tools: string[],
    adapter: any = "claude",
  ) => requiredFor({ contract, roleClass, tools, adapter }).required;
  assert.deepEqual(read("custom", null, ["read", "grep"]), []);
  assert.deepEqual(read("custom", null, ["read", "write"]), ["read", "write"]);
  assert.deepEqual(read("custom", null, ["shell"]), ["shell"]);
  assert.deepEqual(
    read("custom", null, ["write", "shell"], "acp"),
    [],
    "an ACP adapter manages its own tools",
  );
  assert.deepEqual(
    read("reviewer", null, ["read", "write", "shell"]),
    [],
    "a read-only role's leftover write grant is not a requirement",
  );
  assert.deepEqual(read("implementer", null, ["read", "write", "shell"]), [
    "read",
    "write",
    "shell",
  ]);
  assert.deepEqual(
    read("custom", task("response-only", "user"), ["write", "shell"]),
    [],
  );
  assert.deepEqual(read("custom", task("response-only"), ["write"]), [
    "read",
    "write",
  ]);
  assert.deepEqual(read("custom", task("file-edit"), []), ["read", "write"]);
  assert.deepEqual(read("custom", task("executable-implementation"), []), [
    "read",
    "write",
    "shell",
  ]);
  const project = (workKind: any) => ({
    scope: "project" as const,
    workKind,
    workKindSource: "request" as const,
    roles: [
      {
        role: "implementer" as const,
        capabilities: ["read" as const, "write" as const, "shell" as const],
      },
      { role: "reviewer" as const, capabilities: ["read" as const] },
    ],
  });
  assert.deepEqual(
    read("implementer", project("executable-implementation"), []),
    ["read", "write", "shell"],
  );
  assert.deepEqual(
    read("reviewer", project("executable-implementation"), ["read"]),
    ["read"],
  );
  assert.deepEqual(
    read("coordinator", project("executable-implementation"), [
      "read",
      "invoke_teammate",
    ]),
    [],
  );
});
