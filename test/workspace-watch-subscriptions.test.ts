import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceWatchSubscriptions } from "../ui/workspace-watches.ts";

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("workspace views share a watcher until the last view closes", async () => {
  const calls: string[] = [];
  const subscriptions = new WorkspaceWatchSubscriptions(async (path) => {
    calls.push(path);
  });
  const closeFiles = subscriptions.subscribe("writer", "workspace");
  const closeDiff = subscriptions.subscribe("writer", "workspace");
  try {
    await settled();
    assert.deepEqual(calls, ["/agents/writer/watch/start"]);
    closeFiles();
    await settled();
    assert.equal(calls.length, 1, "Diff retains the shared lease");
    closeDiff();
    closeDiff();
    await settled();
    assert.deepEqual(calls, [
      "/agents/writer/watch/start",
      "/agents/writer/watch/stop",
    ]);
  } finally {
    closeFiles();
    closeDiff();
  }
});

test("switching Files to Diff serializes a slow old stop before the new start", async () => {
  const calls: string[] = [];
  let finishStop: (() => void) | undefined;
  const subscriptions = new WorkspaceWatchSubscriptions(async (path) => {
    calls.push(path);
    if (path.endsWith("/stop") && calls.length === 2)
      await new Promise<void>((resolve) => {
        finishStop = resolve;
      });
  });
  const closeFiles = subscriptions.subscribe("writer", "workspace");
  await settled();
  closeFiles();
  await settled();
  const closeDiff = subscriptions.subscribe("writer", "workspace");
  try {
    await settled();
    assert.deepEqual(calls, [
      "/agents/writer/watch/start",
      "/agents/writer/watch/stop",
    ]);
    finishStop!();
    await settled();
    assert.deepEqual(calls, [
      "/agents/writer/watch/start",
      "/agents/writer/watch/stop",
      "/agents/writer/watch/start",
    ]);
  } finally {
    finishStop?.();
    closeDiff();
    await settled();
  }
  assert.equal(calls.at(-1), "/agents/writer/watch/stop");
});
