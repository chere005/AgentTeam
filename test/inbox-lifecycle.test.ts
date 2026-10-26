import test from "node:test";
import assert from "node:assert/strict";
import { buildInbox } from "../ui/inbox.ts";

test("archived and finished projects stop asking to resume, without hiding real outstanding effects", () => {
  const data = {
    agents: [{ id: "a", name: "Writer" }],
    edges: [],
    activity: [
      {
        agentId: "a",
        queuedTasks: [{ id: "t", waitReason: "validation-required" }],
      },
    ],
    workflows: [
      {
        id: "w",
        name: "Old roll call",
        paused: true,
        lifecycle: { state: "archived" },
        tasks: [{ id: "t", agentId: "a", title: "Report", status: "blocked" }],
      },
    ],
  };
  assert.deepEqual(
    buildInbox({ data, trips: { w: { reason: "Old limit" } } }),
    [],
  );
  const unresolved = buildInbox({
    data,
    recovery: [
      {
        task: { id: "t" },
        uncertainEffects: [
          { id: "e", description: "File write may have happened" },
        ],
      },
    ],
  });
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].kind, "blocked");
  assert.match(unresolved[0].detail, /may have happened/);
  data.workflows[0].lifecycle.state = "completed";
  data.workflows[0].tasks[0].status = "completed";
  assert.deepEqual(buildInbox({ data }), []);
});

test("ordinary delegation waits and setup blockers are distinct from uncertain effects", () => {
  const base = {
    agents: [{ id: "a", name: "Writer" }],
    edges: [],
    activity: [],
  };
  const task = { id: "t", agentId: "a", title: "Report", status: "blocked" };
  const workflow = { id: "w", name: "Roll call", paused: false };
  const waiting = buildInbox({
    data: {
      ...base,
      workflows: [
        {
          ...workflow,
          tasks: [
            {
              ...task,
              delegation: { state: "waiting", message: "Waiting for children" },
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(waiting, []);
  const blocked = buildInbox({
    data: {
      ...base,
      workflows: [
        {
          ...workflow,
          tasks: [
            {
              ...task,
              runtimeBlocker: {
                message: "Required sandbox unavailable. Fix setup first.",
              },
            },
          ],
        },
      ],
    },
  });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0].detail, /Fix setup first/);
  assert.doesNotMatch(blocked[0].detail, /uncertain/);
});
