import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dividerIndex,
  liveActivity,
  markSeen,
  nearBottom,
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
