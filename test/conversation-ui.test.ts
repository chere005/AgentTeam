import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dividerIndex,
  liveActivity,
  markSeen,
  nearBottom,
  sessionFailureMessage,
  unreadCounts,
} from "../ui/conversation.ts";

const ev = (seq: number, type: string, entityId: string, data: any = {}) => ({
  seq,
  type,
  entityId,
  data,
});

test("live activity folds the runtime events that exist and ends with the run", () => {
  const s = "s1";
  const events = [
    ev(1, "session.started", s, { transport: "acp" }),
    ev(2, "runtime.text", s, "Hel"),
    ev(3, "runtime.tool", s, {
      toolCallId: "a",
      title: "Read file",
      kind: "read",
      status: "pending",
    }),
    ev(4, "runtime.text", s, "lo"),
    ev(5, "runtime.tool", s, { toolCallId: "a", status: "completed" }),
    ev(6, "runtime.text", "other", "ignored"),
  ];
  const live = liveActivity(events, s);
  assert.equal(live.active, true);
  assert.equal(live.text, "Hello");
  assert.deepEqual(live.tools, [
    { id: "a", title: "Read file", kind: "read", status: "completed" },
  ]);
  assert.equal(
    liveActivity([...events, ev(7, "session.completed", s)], s).active,
    false,
  );
  // Direct adapters emit whole messages: kept apart, and a new run resets the view.
  const direct = liveActivity(
    [
      ev(1, "session.started", s, {}),
      ev(2, "runtime.text", s, "one"),
      ev(3, "runtime.text", s, "two"),
    ],
    s,
  );
  assert.equal(direct.text, "one\ntwo");
  assert.equal(
    liveActivity([...events, ev(8, "session.started", s, {})], s).text,
    "",
  );
  assert.equal(liveActivity([], s).active, false);
});

test("conversation shows the latest run failure until retry starts", () => {
  const session = "session-a";
  const failure = ev(1, "session.failed", session, {
    message: "Claude Code needs you to sign in again.",
  });
  assert.equal(
    sessionFailureMessage([failure], session),
    "Claude Code needs you to sign in again.",
  );
  assert.equal(
    sessionFailureMessage(
      [failure, ev(2, "session.started", session)],
      session,
    ),
    null,
  );
  assert.equal(sessionFailureMessage([failure], "other-session"), null);
});

test("unread counts, first-sight baseline, divider position and scroll rule", () => {
  const rows = [
    { agentId: "a", assistantCount: 3 },
    { agentId: "b", assistantCount: 5 },
  ];
  assert.deepEqual(unreadCounts(rows, {}), { a: 0, b: 0 });
  assert.deepEqual(unreadCounts(rows, { a: 1, b: 5 }), { a: 2, b: 0 });
  assert.deepEqual(unreadCounts(rows, { a: 1, b: 1 }, "a"), { a: 0, b: 4 });
  assert.deepEqual(markSeen(rows, { a: 1 }, "b"), { a: 1, b: 5 });
  const msgs = [
    { role: "user" },
    { role: "assistant" },
    { role: "user" },
    { role: "assistant" },
    { role: "assistant" },
  ];
  assert.equal(dividerIndex(msgs, 0), -1);
  assert.equal(dividerIndex(msgs, 2), 3);
  assert.equal(dividerIndex(msgs, 3), 1);
  assert.equal(dividerIndex(msgs, 9), -1);
  assert.equal(
    nearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }),
    true,
  );
  assert.equal(
    nearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 400 }),
    false,
  );
});

test("Team Assistant replies: proposal blocks are split out of the prose (raw JSON hidden by default)", async () => {
  const { splitProposalBlocks, hasProposalBlock } =
    await import("../ui/conversation.ts");
  const text =
    'Plan: add skills.\n\n```agentteam-proposal\n{"title":"x","ops":[]}\n```\nTell me if that works.';
  assert.equal(hasProposalBlock(text), true);
  assert.deepEqual(splitProposalBlocks(text), [
    { kind: "text", text: "Plan: add skills." },
    { kind: "proposal", json: '{"title":"x","ops":[]}', index: 0 },
    { kind: "text", text: "Tell me if that works." },
  ]);
  assert.deepEqual(splitProposalBlocks("just text"), [
    { kind: "text", text: "just text" },
  ]);
  // Other fences stay in the prose.
  const code = "```json\n{}\n```";
  assert.equal(hasProposalBlock(code), false);
  assert.deepEqual(splitProposalBlocks(code), [{ kind: "text", text: code }]);
  const two = splitProposalBlocks(
    "```agentteam-proposal\n{}\n```\n```agentteam-proposal \n[]\n```",
  );
  assert.deepEqual(
    two.map((p) => (p.kind === "proposal" ? p.index : -1)),
    [0, 1],
  );
});

test("chat status label follows the session events: processing vs queued", async () => {
  const { messageStatusLabel, processingMessageIds } =
    await import("../ui/conversation.ts");
  const a = { id: "a", role: "user", status: "queued" };
  const b = { id: "b", role: "user", status: "queued" };
  const c = { id: "c", role: "user", status: "queued" };
  const r = { id: "r", role: "assistant", status: "delivered" };
  const ev = (seq: number, type: string, data: any = {}, entityId = "s1") => ({
    seq,
    type,
    entityId,
    data,
  });
  // Queued, nothing running.
  assert.deepEqual(
    processingMessageIds([ev(1, "session.run_queued")], "s1"),
    [],
  );
  assert.equal(messageStatusLabel(a, []), "queued");
  // The run took a and b (a backlog is answered together) while the fetched copies still say
  // queued: both read processing; c, sent after the start, stays queued for the next run.
  const started = [
    ev(1, "session.run_queued"),
    ev(2, "session.started", { messageId: "b", messageIds: ["a", "b"] }),
  ];
  const ids = processingMessageIds(started, "s1");
  assert.deepEqual(ids, ["a", "b"]);
  assert.equal(messageStatusLabel(a, ids), "processing");
  assert.equal(messageStatusLabel(b, ids), "processing");
  assert.equal(messageStatusLabel(c, ids), "queued");
  // Older backends sent only messageId.
  assert.deepEqual(
    processingMessageIds([ev(2, "session.started", { messageId: "a" })], "s1"),
    ["a"],
  );
  // Other sessions' events do not count; an end event closes the run.
  assert.deepEqual(
    processingMessageIds(
      [ev(3, "session.started", { messageIds: ["x"] }, "s2")],
      "s1",
    ),
    [],
  );
  assert.deepEqual(
    processingMessageIds([...started, ev(3, "session.completed")], "s1"),
    [],
  );
  // A refetched final status wins over the start event; replies keep theirs.
  assert.equal(
    messageStatusLabel({ ...a, status: "delivered" }, ids),
    "delivered",
  );
  assert.equal(
    messageStatusLabel({ ...a, status: "processing" }, []),
    "processing",
  );
  assert.equal(messageStatusLabel(r, ["r"]), "delivered");
});
