import { test } from "node:test";
import assert from "node:assert/strict";
import {
  taskRunStatus,
  agentRunStatus,
  projectRunStatus,
  runStatusLabel,
} from "../ui/run-status.ts";

test("task statuses map to one vocabulary", () => {
  const s = (t: Parameters<typeof taskRunStatus>[0]) => taskRunStatus(t);
  assert.equal(s({ status: "completed" }), "done");
  assert.equal(s({ status: "completed", problem: true }), "failed");
  assert.equal(s({ status: "completed", supersededBy: "x" }), "superseded");
  assert.equal(s({ status: "failed" }), "failed");
  assert.equal(s({ status: "running" }), "running");
  assert.equal(s({ status: "interrupted" }), "waiting-you");
  assert.equal(s({ status: "blocked" }), "blocked");
  assert.equal(s({ status: "blocked", delegationWaiting: true }), "queued");
  assert.equal(s({ status: "queued" }), "queued");
  assert.equal(s({ status: "queued", waitReason: "resource-busy" }), "queued");
  assert.equal(
    s({ status: "queued", waitReason: "workflow-paused" }),
    "waiting-you",
  );
  assert.equal(
    s({ status: "queued", waitReason: "dependency-failed" }),
    "blocked",
  );
  assert.equal(s({ status: "cancelled" }), "cancelled");
});

test("agent and project states reuse the same kinds and labels", () => {
  assert.equal(agentRunStatus("processing"), "running");
  assert.equal(agentRunStatus("waiting"), "queued");
  assert.equal(agentRunStatus("human-control"), "waiting-you");
  assert.equal(agentRunStatus("idle", true), "failed");
  assert.equal(agentRunStatus("idle"), "idle");
  assert.equal(projectRunStatus("needs-attention"), "waiting-you");
  assert.equal(projectRunStatus("paused"), "waiting-you");
  assert.equal(projectRunStatus("completed"), "done");
  assert.equal(runStatusLabel("waiting-you"), "waiting for you");
});
