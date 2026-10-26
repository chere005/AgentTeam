import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ago,
  checkedText,
  linesSignature,
  readinessLines,
  taskReadinessLines,
  type RuntimeLike,
} from "../ui/readiness.ts";

const rt = (id: string, over: Partial<RuntimeLike> = {}): RuntimeLike => ({
  id,
  installed: true,
  authenticated: true,
  ...over,
});

test("installed and authenticated runtimes still show task-specific sandbox blockers", () => {
  assert.deepEqual(
    readinessLines(
      { settled: true, scanning: false, runtimes: [rt("claude")] },
      ["claude"],
    ),
    [],
  );
  const first = {
    id: "a",
    title: "Write file",
    agentId: "writer",
    status: "failed",
    runtimeBlocker: {
      code: "sandbox_unavailable",
      message: "Required sandbox is unavailable.",
    },
  };
  const second = { ...first, id: "b", status: "blocked" };
  const lines = taskReadinessLines(
    [first, second, { ...first, id: "old", status: "completed" }],
    { writer: "Integrator" },
  );
  assert.deepEqual(
    lines.map((line) => [line.text, line.action]),
    [["Integrator: required sandbox unavailable (2 assignments)", "recovery"]],
  );
  assert.deepEqual(
    taskReadinessLines([{ ...first, status: "queued" }], {
      writer: "Integrator",
    }),
    [],
  );
  assert.equal(
    taskReadinessLines(
      [
        {
          id: "legacy",
          title: "Write file",
          agentId: "writer",
          status: "failed",
          result:
            "[process-failure] Sandbox required but unavailable. Set sandbox.failIfUnavailable=false to allow unsandboxed execution.",
        },
      ],
      { writer: "Integrator" },
    )[0].kind,
    "sandbox-unavailable",
  );
});

test("readiness strip: one line per blocking runtime the team uses, with its action", () => {
  const status = {
    settled: true,
    scanning: false,
    runtimes: [
      rt("claude", { installed: false, authenticated: null }),
      rt("codex", { authenticated: false }),
      rt("wolfram", { authenticated: null }),
    ],
  };
  const lines = readinessLines(status, ["codex", "wolfram", "claude", "codex"]);
  assert.deepEqual(
    lines.map((l) => [l.text, l.action]),
    [
      ["Claude Code: not found", "settings"],
      ["Codex: sign in needed", "sign-in"],
    ],
  );
  // Only what the active team uses; nothing at all when those are ready.
  assert.deepEqual(readinessLines(status, ["wolfram"]), []);
  assert.deepEqual(readinessLines(status, []), []);
  // A sign-in in progress replaces the button with the waiting text.
  assert.deepEqual(
    readinessLines(status, ["codex"], (id) => id === "codex").map((l) => [
      l.text,
      l.action,
    ]),
    [["Codex: waiting for sign-in…", null]],
  );
  // Stale manual path and failed detection name the problem and point to Settings.
  assert.deepEqual(
    readinessLines(
      {
        ...status,
        runtimes: [
          rt("claude", {
            installed: false,
            staleOverride: { path: "/x/claude", reason: "missing" },
          }),
          rt("codex", {
            installed: false,
            diagnostics: [{ code: "discovery_failed" }],
          }),
        ],
      },
      ["claude", "codex"],
    ).map((l) => [l.kind, l.action]),
    [
      ["path-missing", "settings"],
      ["detection-failed", "settings"],
    ],
  );
  for (const l of lines) assert.doesNotMatch(l.text, /configuration required/i);
});

test("readiness strip: checking while the first scan runs, nothing before any scan", () => {
  const runtimes = [rt("claude", { installed: false })];
  assert.deepEqual(
    readinessLines({ settled: false, scanning: true, runtimes }, [
      "claude",
    ]).map((l) => l.text),
    ["Claude Code: checking…"],
  );
  assert.deepEqual(
    readinessLines({ settled: false, scanning: false, runtimes }, ["claude"]),
    [],
  );
  assert.deepEqual(readinessLines(null, ["claude"]), []);
});

test("a dismissal lasts until the set of blockers changes", () => {
  const status = (auth: boolean | null, installed = true) => ({
    settled: true,
    scanning: false,
    runtimes: [rt("codex", { authenticated: auth, installed })],
  });
  const a = linesSignature(readinessLines(status(false), ["codex"]));
  assert.equal(a, linesSignature(readinessLines(status(false), ["codex"])));
  assert.notEqual(
    a,
    linesSignature(readinessLines(status(null, false), ["codex"])),
  );
  assert.equal(linesSignature(readinessLines(status(true), ["codex"])), "");
});

test("automatic check wording", () => {
  const now = Date.parse("2026-10-25T12:00:00Z");
  assert.equal(ago("2026-10-25T11:59:30Z", now), "just now");
  assert.equal(ago("2026-10-25T11:55:00Z", now), "5 min ago");
  assert.equal(ago("2026-10-25T09:00:00Z", now), "3 h ago");
  assert.equal(
    checkedText(
      { verified: true, checkedAt: "2026-10-25T11:59:59Z", trigger: "auto" },
      now,
    ),
    "Checked automatically just now · verified",
  );
  assert.equal(
    checkedText(
      { verified: false, checkedAt: "2026-10-25T11:50:00Z", trigger: "manual" },
      now,
    ),
    "Checked 10 min ago · not verified",
  );
  // Records written before the trigger field existed read as a plain check.
  assert.equal(
    checkedText({ verified: true, checkedAt: "2026-10-25T11:59:59Z" }, now),
    "Checked just now · verified",
  );
  assert.equal(checkedText({ verified: false, checkedAt: null }, now), null);
});
