import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { contractObjects, EMPTY_LIST_FIELDS } from "../src/limits.ts";
import { parseVerdict } from "../src/orchestration.ts";
import { REVIEW_CONTRACT } from "../src/roles.ts";
import {
  CODEX_READ_ONLY_SHELL_NOTE,
  CODEX_TASK_SANDBOX_NOTE,
  commandFor,
} from "../src/runtime.ts";
import { codexShellMode } from "../src/launch-capability.ts";
import { codexTaskPermissions } from "../src/provider-filesystem.ts";

// ---- (b) an empty `findings` list is a real answer; nothing else empty is --------------------------

test("a review with no findings satisfies the review contract; other empties still do not", () => {
  const f = REVIEW_CONTRACT.fields;
  const clean = JSON.stringify({
    verdict: "approve",
    findings: [],
    evidence: "read src/a.py",
  });
  assert.equal(contractObjects(clean, f).length, 1);
  assert.equal(parseVerdict(clean), "approve");
  // The verdict, not the findings, decides: an inconclusive review with no findings completes the
  // contract but is never an approval.
  const inconclusive = JSON.stringify({
    verdict: "inconclusive",
    findings: [],
    evidence: "could not read",
  });
  assert.equal(contractObjects(inconclusive, f).length, 1);
  assert.equal(parseVerdict(inconclusive), "inconclusive");
  // Still missing: empty evidence list/string, null/empty findings, an absent key.
  for (const bad of [
    { verdict: "approve", findings: [], evidence: [] },
    { verdict: "approve", findings: [], evidence: "" },
    { verdict: "approve", findings: null, evidence: "x" },
    { verdict: "approve", findings: "", evidence: "x" },
    { verdict: "approve", evidence: "x" },
    { verdict: "", findings: [], evidence: "x" },
  ])
    assert.equal(
      contractObjects(JSON.stringify(bad), f).length,
      0,
      JSON.stringify(bad),
    );
  // Only `findings` gets the allowance: other empty lists stay missing.
  assert.deepEqual([...EMPTY_LIST_FIELDS], ["findings"]);
  assert.equal(contractObjects('{"tests":[]}', ["tests"]).length, 0);
  assert.equal(
    contractObjects('{"changedFiles":[]}', ["changedFiles"]).length,
    0,
  );
});

// ---- (a) a Codex reader needs a shell; it must be read-only and scoped ------------------------------

const reviewer = (over: Record<string, unknown> = {}): any => ({
  environment: "codex",
  taskScoped: true,
  tools: ["read", "grep", "glob"],
  workspaces: [{ path: "/work/a", access: "read", active: true }],
  instructions: "You are read-only.",
  model: "default",
  cwd: "/work/a",
  ...over,
});
const table = (args: string[]) =>
  args.find((a) => a.startsWith("permissions.agentteam-task.filesystem="))!;
const hasShellOff = (args: string[]) =>
  args.includes("features.shell_tool=false");

test("a task-scoped Codex reviewer keeps a shell, but a read-only one with no network", () => {
  const plan = reviewer();
  assert.equal(codexShellMode(plan), "read-only");
  const c = commandFor(plan, null, "review", "/work/a");
  assert.equal(
    hasShellOff(c.args),
    false,
    "the shell is the only way Codex reads files",
  );
  const fs = table(c.args);
  assert.ok(fs.includes('"/work/a"="read"'));
  assert.ok(!fs.includes('"write"'), "no root is writable");
  assert.ok(fs.includes(`${JSON.stringify(join("/work/a", ".git"))}="deny"`));
  const windows = codexTaskPermissions(plan.workspaces, plan.tools, "win32").join(
    " ",
  );
  assert.ok(windows.includes(JSON.stringify("\\work\\a\\.git") + '="deny"'));
  assert.ok(!fs.includes("/Users"), "no node or home roots");
  assert.ok(
    c.args.includes("permissions.agentteam-task.network.enabled=false"),
    "no loopback for a reader",
  );
  assert.ok(!c.args.some((a) => a.includes("danger-full-access")));
  assert.ok(
    !c.args.some((a) => a.startsWith("sandbox_mode=")),
    "the profile, not the whole-disk read-only mode",
  );
  assert.ok(c.stdin.includes(CODEX_READ_ONLY_SHELL_NOTE));
  assert.ok(!c.stdin.includes(CODEX_TASK_SANDBOX_NOTE));
  assert.deepEqual(c.limitations, [CODEX_READ_ONLY_SHELL_NOTE]);
});

test("a Codex reader on a writable folder without a shell grant stays shell-less; so do file-only and unscoped launches", () => {
  const writableFolder = reviewer({
    tools: ["read", "edit"],
    workspaces: [{ path: "/work/a", access: "write", active: true }],
  });
  assert.equal(codexShellMode(writableFolder), "off");
  assert.ok(
    hasShellOff(commandFor(writableFolder, null, "go", "/work/a").args),
  );
  // Mixed roots (one read, one write) with a write tool: a writable root must never get an ungranted shell.
  for (const tools of [
    ["read", "edit"],
    ["read", "write"],
  ])
    for (const cwd of ["/work/a", "/work/b"]) {
      const mixed = reviewer({
        tools,
        cwd,
        workspaces: [
          { path: "/work/a", access: "read", active: cwd === "/work/a" },
          { path: "/work/b", access: "write", active: cwd === "/work/b" },
        ],
      });
      assert.equal(codexShellMode(mixed), "off", `${tools} ${cwd}`);
      assert.ok(hasShellOff(commandFor(mixed, null, "go", cwd).args));
    }
  // File-only withholds the shell by design.
  const fileOnly = reviewer({ executionMode: "file-only" });
  assert.equal(codexShellMode(fileOnly), "off");
  assert.ok(hasShellOff(commandFor(fileOnly, null, "go", "/work/a").args));
  // Not task-scoped: the plain read-only sandbox reads the whole disk, so no shell is offered.
  const unscoped = reviewer({ taskScoped: false });
  assert.equal(codexShellMode(unscoped), "off");
  assert.ok(hasShellOff(commandFor(unscoped, null, "go", "/work/a").args));
  // No read grant, or a restricted folder: nothing to read, no shell.
  assert.equal(codexShellMode(reviewer({ tools: ["grep"] })), "off");
  assert.equal(
    codexShellMode(
      reviewer({
        workspaces: [
          { path: "/work/a", access: "read", active: true, explicitOnly: true },
        ],
      }),
    ),
    "off",
  );
  // An explicit shell grant is unchanged.
  assert.equal(codexShellMode(reviewer({ tools: ["read", "shell"] })), "full");
});
