import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeReadRoots } from "../src/node-runtime.ts";
import { codexTaskPermissions } from "../src/provider-filesystem.ts";
import { CODEX_TASK_SANDBOX_NOTE, commandFor } from "../src/runtime.ts";

const fake = (files: Record<string, string>) => ({
  exists: (p: string) => p in files || Object.values(files).includes(p),
  realpath: (p: string) => files[p] ?? p,
});

test("Homebrew node: the whole prefix read-only (dylibs and openssl.cnf live in sibling formulae)", () => {
  const fs = fake({
    "/opt/homebrew/bin/node": "/opt/homebrew/Cellar/node/26.9.0/bin/node",
    "/opt/homebrew/Cellar": "/opt/homebrew/Cellar",
  });
  assert.deepEqual(
    nodeReadRoots({
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      platform: "darwin",
      ...fs,
    }),
    ["/opt/homebrew"],
  );
});
test("version-manager node: only its own install prefix, never the home folder", () => {
  const fs = fake({
    "/Users/u/.nvm/versions/node/v22.1.0/bin/node":
      "/Users/u/.nvm/versions/node/v22.1.0/bin/node",
  });
  assert.deepEqual(
    nodeReadRoots({
      pathEnv: "/Users/u/.nvm/versions/node/v22.1.0/bin",
      platform: "darwin",
      ...fs,
    }),
    ["/Users/u/.nvm/versions/node/v22.1.0"],
  );
});
test("system node, missing node and Windows need no extra root", () => {
  assert.deepEqual(
    nodeReadRoots({
      pathEnv: "/usr/bin",
      ...fake({ "/usr/bin/node": "/usr/bin/node" }),
    }),
    [],
  );
  assert.deepEqual(nodeReadRoots({ pathEnv: "/nope", ...fake({}) }), []);
  assert.deepEqual(nodeReadRoots({ platform: "win32" }), []);
});
test("Codex task permissions add node roots read-only, no network, no task-root override", () => {
  const ws = [{ path: "/work/a", access: "write" as const, active: true }];
  const settings = codexTaskPermissions(
    ws,
    ["read", "write", "shell"],
    "darwin",
    ["/opt/homebrew", "/work/a"],
  );
  const table = settings.find((s) => s.startsWith("permissions."))!;
  assert.ok(table.includes('"/opt/homebrew"="read"'));
  assert.ok(table.includes('"/work/a"="write"'), "task root keeps write");
  assert.ok(!table.includes("/Users"));
  assert.ok(
    settings.includes("permissions.agentteam-task.network.enabled=false"),
  );
  assert.ok(
    !codexTaskPermissions(ws, [], "darwin", ["/opt/homebrew"])
      .join()
      .includes("/opt/homebrew"),
    "no read tool, no extra roots",
  );
});
test("a task-scoped Codex launch with shell states the loopback/network limit; file-only does not", () => {
  const plan: any = {
    environment: "codex",
    taskScoped: true,
    tools: ["read", "write", "shell"],
    workspaces: [{ path: "/work/a", access: "write", active: true }],
    instructions: "Do it",
    model: "default",
    cwd: "/work/a",
  };
  const shell = commandFor(plan, null, "go", "/work/a");
  assert.ok(shell.stdin.includes(CODEX_TASK_SANDBOX_NOTE));
  assert.deepEqual(shell.limitations, [CODEX_TASK_SANDBOX_NOTE]);
  assert.ok(!shell.args.join(" ").includes("danger-full-access"));
  assert.ok(
    shell.args.includes("permissions.agentteam-task.network.enabled=false"),
  );
  const fileOnly = commandFor(
    { ...plan, executionMode: "file-only" },
    null,
    "go",
    "/work/a",
  );
  assert.ok(!fileOnly.stdin.includes(CODEX_TASK_SANDBOX_NOTE));
  assert.equal(fileOnly.limitations, undefined);
});
