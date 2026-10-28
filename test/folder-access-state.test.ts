import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import {
  FolderAccess,
  failureFromError,
  folderRefusal,
  isPending,
  macosRefusal,
  probeFolderAccess,
  runChild,
  type ChildRunner,
  type FolderProbeFailure,
  type FolderProbeResult,
  type ProbeFn,
} from "../src/folder-access.ts";

// The answers the app keeps about folders (src/folder-access.ts): stored per folder and access
// level, kept across a restart, shared by every caller of one probe, bounded in how many run at
// once, and independent of a shell. Temporary folders only; "macOS" is an injected probe.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const posix = process.platform !== "win32";
// The simulated Mac's folders are POSIX paths (src/folder-access.ts compares them as such).
const simulatedMac = {
  skip: posix ? false : "simulated macOS paths are POSIX paths",
};
const notRoot = posix && process.getuid?.() !== 0;
async function scratch(t: { after: (fn: () => unknown) => void }) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-folder-state-")),
  );
  t.after(async () => {
    for (const name of await readdir(base).catch(() => [] as string[]))
      await chmod(join(base, name), 0o755).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return base;
}
const failure = (result: FolderProbeResult): FolderProbeFailure => {
  assert.equal(result.ok, false, "expected a refusal");
  return result as FolderProbeFailure;
};
const okResult = (
  path: string,
  write: boolean,
  extra: Partial<Extract<FolderProbeResult, { ok: true }>> = {},
): FolderProbeResult => ({
  ok: true,
  path,
  write,
  checkedAt: new Date().toISOString(),
  protectedFolder: null,
  steps: ["realpath", "stat", "readdir"],
  ...extra,
});
const refusedResult = (
  path: string,
  write: boolean,
  operation = "readdir",
): FolderProbeResult => ({
  ...macosRefusal(path, write),
  operation,
  protectedFolder: null,
  fix: "Check the folder's permissions or choose another folder.",
});
/** A probe the test answers by hand, one folder at a time. */
function handProbe() {
  const asked: { path: string; write: boolean }[] = [];
  const open = new Map<string, (result: FolderProbeResult) => void>();
  const probe: ProbeFn = (path, { write }) => {
    asked.push({ path, write });
    return new Promise((resolve) => open.set(`${path}|${write}`, resolve));
  };
  return {
    probe,
    asked,
    answer: (path: string, write: boolean, result: FolderProbeResult) => {
      const resolve = open.get(`${path}|${write}`);
      assert.ok(resolve, `nobody asked about ${path}`);
      open.delete(`${path}|${write}`);
      resolve(result);
    },
    answered: async (path: string, write: boolean, ok = true) => {
      const resolve = open.get(`${path}|${write}`);
      assert.ok(resolve, `nobody asked about ${path}`);
      open.delete(`${path}|${write}`);
      resolve(ok ? okResult(path, write) : refusedResult(path, write));
      await sleep(5);
    },
  };
}

// ---- stored answers (P2) -------------------------------------------------------------------------------

test("the latest answer per folder and access level is stored with its cause, fix, time and source; events only on transitions", async (t) => {
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  let refuse = true;
  const access = new FolderAccess({
    store,
    ttlMs: 0,
    probe: async (path, { write }) =>
      refuse ? refusedResult(path, write, "mkdir") : okResult(path, write),
  });
  const events = (type: string) =>
    store.history(0, 100).filter((e) => e.type === type);
  await access.probe(base, { write: true, source: "scheduler" });
  const [record] = store.list<any>("folder-access");
  assert.equal(store.list("folder-access").length, 1);
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "actor",
      "at",
      "code",
      "errno",
      "fix",
      "id",
      "message",
      "ok",
      "operation",
      "path",
      "protectedFolder",
      "source",
      "write",
    ].sort(),
  );
  assert.equal(record.ok, false);
  assert.equal(record.code, "folder-denied");
  assert.equal(record.errno, "EPERM");
  assert.equal(record.operation, "mkdir");
  assert.equal(record.source, "scheduler");
  assert.equal(record.path, base);
  assert.equal(record.write, true);
  assert.match(record.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(events("folder.access_refused").length, 1);
  // The same refusal again: stored again (new time and source), announced once.
  await access.probe(base, { write: true, source: "chat", force: true });
  assert.equal(store.list<any>("folder-access")[0].source, "chat");
  assert.equal(events("folder.access_refused").length, 1);
  // Allowed: one transition event; the record now says so.
  refuse = false;
  await access.probe(base, { write: true, source: "setup", force: true });
  assert.equal(store.list<any>("folder-access")[0].ok, true);
  assert.equal(events("folder.access_allowed").length, 1);
  await access.probe(base, { write: true, force: true });
  assert.equal(events("folder.access_allowed").length, 1);
  // Refused again: a new transition.
  refuse = true;
  await access.probe(base, { write: true, force: true });
  assert.equal(events("folder.access_refused").length, 2);
  // Read and write are separate answers about one folder.
  refuse = false;
  await access.probe(base, { write: false });
  assert.equal(store.list("folder-access").length, 2);
  // A first success is no news.
  const other = join(base, "other");
  await mkdir(other);
  await access.probe(other, { write: true });
  assert.equal(events("folder.access_allowed").length, 1);
});

test("a stored refusal is read back by the next life of the app and blocks until a fresh probe succeeds; a stored success is history only", async (t) => {
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const refused = join(base, "refused");
  const fine = join(base, "fine");
  await mkdir(refused);
  await mkdir(fine);
  const first = new FolderAccess({
    store,
    probe: async (path, { write }) =>
      path === refused ? refusedResult(path, write) : okResult(path, write),
  });
  await first.probe(refused, { write: true });
  await first.probe(fine, { write: true });
  // A new FolderAccess on the same store: a restart with an empty memory.
  let answer: "refused" | "allowed" = "refused";
  const second = new FolderAccess({
    store,
    probe: async (path, { write }) =>
      answer === "refused" ? refusedResult(path, write) : okResult(path, write),
  });
  const known = failure(second.cached(refused, true)!);
  assert.equal(known.code, "folder-denied");
  assert.equal(known.errno, "EPERM");
  assert.match(known.fix, /permissions/);
  assert.equal(
    second.cached(fine, true),
    undefined,
    "a success is not trusted",
  );
  // The stored refusal is not fresh: the next launch asks again; still refused, still blocked.
  assert.equal((await second.probe(refused, { write: true })).ok, false);
  // Allowed: a fresh probe ends it, announced as a transition.
  answer = "allowed";
  assert.equal(
    (await second.probe(refused, { write: true })).ok,
    false,
    "fresh refusal is reused",
  );
  assert.equal(
    (await second.probe(refused, { write: true, force: true })).ok,
    true,
  );
  assert.equal(second.cached(refused, true)?.ok, true);
  assert.equal(
    store.history(0, 100).filter((e) => e.type === "folder.access_allowed")
      .length,
    1,
  );
});

test("a change of attachments marks answers stale: a stale refusal still blocks and is asked again, a success is forgotten, nothing is deleted", async (t) => {
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const refused = join(base, "refused");
  const fine = join(base, "fine");
  await mkdir(refused);
  await mkdir(fine);
  let calls = 0;
  const access = new FolderAccess({
    store,
    probe: async (path, { write }) => {
      calls++;
      return path === refused
        ? refusedResult(path, write, "mkdir")
        : okResult(path, write);
    },
  });
  await access.probe(refused, { write: true });
  await access.probe(fine, { write: true });
  access.invalidate();
  assert.equal(
    access.cached(refused, true)?.ok,
    false,
    "the refusal still blocks",
  );
  assert.equal(
    access.cached(fine, true),
    undefined,
    "the success is not vouched for",
  );
  const stored = store.list<any>("folder-access");
  assert.equal(stored.length, 2, "nothing was deleted");
  assert.ok(stored.every((r) => r.stale === true));
  // Stale is never fresh: the next probe asks the system again.
  const before = calls;
  await access.probe(refused, { write: true });
  assert.equal(calls, before + 1);
  assert.equal(
    !!store.list<any>("folder-access").find((r) => r.path === refused).stale,
    false,
    "an answer replaces the stale one",
  );
});

// ---- one probe per folder, one deadline (P3) --------------------------------------------------------------

test("callers of one folder share one probe and one deadline: N callers cost one wait, later callers do not wait again", async (t) => {
  const base = await scratch(t);
  const hand = handProbe();
  const access = new FolderAccess({ probe: hand.probe, promptWaitMs: 250 });
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => access.probe(base, { write: true })),
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= 200 && elapsed < 900,
    `six callers waited ${elapsed} ms in all`,
  );
  assert.equal(hand.asked.length, 1, "one probe");
  assert.ok(results.every((r) => isPending(r)));
  // After the deadline nobody waits for the same probe again.
  const later = Date.now();
  assert.equal(isPending(await access.probe(base, { write: true })), true);
  assert.equal(
    isPending(await access.probe(base, { write: true, force: true })),
    true,
  );
  assert.ok(
    Date.now() - later < 400,
    "past the deadline callers get the pending answer at once",
  );
  assert.equal(hand.asked.length, 1);
  assert.equal(access.pending().length, 1);
});

test("a caller's own budget (waitMs) and a deadline shared by several folders end the wait early, counted from the probe's request", async (t) => {
  const base = await scratch(t);
  const folders = await Promise.all(
    ["a", "b", "c"].map(async (name) => {
      const path = join(base, name);
      await mkdir(path);
      return path;
    }),
  );
  const hand = handProbe();
  const access = new FolderAccess({ probe: hand.probe, promptWaitMs: 5000 });
  let started = Date.now();
  const pending = await access.probe(folders[0], { write: true, waitMs: 80 });
  assert.equal(isPending(pending), true);
  assert.ok(Date.now() - started < 900, "waitMs 80");
  // A second caller with the same budget joins the stuck probe and does not wait again.
  started = Date.now();
  await access.probe(folders[0], { write: true, waitMs: 80 });
  assert.ok(
    Date.now() - started < 400,
    "the probe is already older than the budget",
  );
  // One deadline for three different folders: the tick pays it once, not three times.
  const deadlineAt = Date.now() + 200;
  started = Date.now();
  const all = await Promise.all(
    folders.map((folder) => access.probe(folder, { write: true, deadlineAt })),
  );
  const elapsed = Date.now() - started;
  assert.ok(all.every((r) => isPending(r)));
  assert.ok(
    elapsed >= 150 && elapsed < 560,
    `three folders waited ${elapsed} ms in all`,
  );
});

test("the answer that arrives late is stored, announced once and handed to the listener; a quick probe is not 'pending'", async (t) => {
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const hand = handProbe();
  const settled: { ok: boolean; wasPending: boolean; changed: boolean }[] = [];
  const access = new FolderAccess({
    store,
    probe: hand.probe,
    promptWaitMs: 30,
    onSettled: ({ ok, wasPending, changed }) =>
      settled.push({ ok, wasPending, changed }),
  });
  const waiting = await access.probe(base, { write: true });
  assert.equal(isPending(waiting), true);
  assert.equal(failure(waiting).errno, "ETIMEDOUT");
  assert.equal(
    store.list("folder-access").length,
    0,
    "pending is never stored",
  );
  await hand.answered(base, true, true);
  assert.deepEqual(settled, [{ ok: true, wasPending: true, changed: true }]);
  assert.equal(access.cached(base, true)?.ok, true);
  assert.equal(access.pending().length, 0);
  // An ordinary quick probe is answered, not pending, and is not "news".
  const other = join(base, "other");
  await mkdir(other);
  const quick = access.probe(other, { write: true });
  await sleep(5);
  await hand.answered(other, true);
  assert.equal((await quick).ok, true);
  assert.equal(settled.length, 1);
});

// ---- bounded concurrency (P3) -----------------------------------------------------------------------------

test("at most two probes run at once; the others queue and start as slots free", async (t) => {
  const base = await scratch(t);
  const folders = await Promise.all(
    ["a", "b", "c", "d", "e"].map(async (name) => {
      const path = join(base, name);
      await mkdir(path);
      return path;
    }),
  );
  const hand = handProbe();
  const access = new FolderAccess({ probe: hand.probe, promptWaitMs: 5000 });
  const requests = folders.map((folder) =>
    access.probe(folder, { write: true }),
  );
  await sleep(20);
  assert.deepEqual(
    hand.asked.map((a) => a.path),
    [folders[0], folders[1]],
  );
  await hand.answered(folders[0], true);
  assert.equal(hand.asked.length, 3, "a slot opened for the next");
  await hand.answered(folders[1], true);
  await hand.answered(folders[2], true);
  await hand.answered(folders[3], true);
  await hand.answered(folders[4], true);
  assert.ok((await Promise.all(requests)).every((r) => r.ok));
  assert.deepEqual(
    hand.asked.map((a) => a.path),
    folders,
  );
});

test(
  "a protected location runs one probe at a time (a second would only pin another thread), other places go on",
  simulatedMac,
  async (t) => {
    const base = await scratch(t);
    const home = join(base, "home");
    const names = ["one", "two", "three"];
    const desk = await Promise.all(
      names.map(async (name) => {
        const path = join(home, "Desktop", name);
        await mkdir(path, { recursive: true });
        return path;
      }),
    );
    const elsewhere = join(base, "elsewhere");
    await mkdir(elsewhere);
    const hand = handProbe();
    const access = new FolderAccess({
      probe: hand.probe,
      promptWaitMs: 5000,
      platform: "darwin",
      home,
    });
    const requests = [...desk, elsewhere].map((folder) =>
      access.probe(folder, { write: true }),
    );
    await sleep(20);
    assert.deepEqual(
      hand.asked.map((a) => a.path),
      [desk[0], elsewhere],
      "one Desktop probe at a time; an unrelated folder is not held up by it",
    );
    await hand.answered(desk[0], true);
    assert.equal(hand.asked.at(-1)!.path, desk[1]);
    await hand.answered(desk[1], true);
    await hand.answered(desk[2], true);
    await hand.answered(elsewhere, true);
    assert.ok((await Promise.all(requests)).every((r) => r.ok));
  },
);

test("a probe stuck for the whole wait gives its slot to unrelated folders, but threads stay in reserve", async (t) => {
  const base = await scratch(t);
  const folders = await Promise.all(
    ["a", "b", "c", "d", "e"].map(async (name) => {
      const path = join(base, name);
      await mkdir(path);
      return path;
    }),
  );
  const hand = handProbe();
  const access = new FolderAccess({ probe: hand.probe, promptWaitMs: 40 });
  for (const folder of folders) void access.probe(folder, { write: true });
  await sleep(20);
  assert.equal(hand.asked.length, 2);
  await sleep(80); // both have been stuck for the whole wait: their slots open for the others
  assert.equal(hand.asked.length, 3, "the hard cap is one above the limit");
  await hand.answered(folders[0], true);
  assert.equal(hand.asked.length, 4);
});

test("coming back to the window asks again only about refused folders something still uses", async (t) => {
  const base = await scratch(t);
  const used = join(base, "used");
  const forgotten = join(base, "forgotten");
  await mkdir(used);
  await mkdir(forgotten);
  const asked: string[] = [];
  let open = false;
  const access = new FolderAccess({
    probe: async (path, { write }) => {
      asked.push(path);
      return open ? okResult(path, write) : refusedResult(path, write, "mkdir");
    },
  });
  await access.probe(used, { write: true });
  await access.probe(forgotten, { write: true });
  asked.length = 0;
  open = true;
  assert.equal(await access.recheckFailed((path) => path === used), 1);
  assert.deepEqual(
    asked,
    [used],
    "a stored refusal nothing uses is left alone",
  );
  assert.equal(access.cached(forgotten, true)?.ok, false);
  assert.equal(
    await access.recheckFailed(),
    1,
    "without a filter it asks about all",
  );
});

// ---- read and write answers (reviewer fixture R8) -----------------------------------------------------------

test("a write probe refused while listing the folder refuses reading it the same way; one refused later says nothing about reading; an allowed write ends an old read refusal", async (t) => {
  const base = await scratch(t);
  let result: "list" | "mkdir" | "ok" = "list";
  const access = new FolderAccess({
    probe: async (path, { write }) =>
      result === "ok"
        ? okResult(path, write)
        : refusedResult(path, write, result === "list" ? "readdir" : "mkdir"),
  });
  await access.probe(base, { write: true, force: true });
  assert.equal(
    access.cached(base, false)?.ok,
    false,
    "reading is refused as well",
  );
  assert.equal(failure(access.cached(base, false)!).write, false);
  // Refused only at the mkdir: the folder was listed, reading is a separate question.
  const later = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-folder-later-")),
  );
  t.after(() => rm(later, { recursive: true, force: true }));
  result = "mkdir";
  await access.probe(later, { write: true, force: true });
  assert.equal(failure(access.cached(later, true)!).operation, "mkdir");
  assert.equal(access.cached(later, false), undefined);
  // The folder opens: the write probe succeeds and the read refusal recorded before is over.
  result = "ok";
  await access.probe(base, { write: true, force: true });
  assert.equal(access.cached(base, false)?.ok, true);
  assert.equal(access.cached(base, true)?.ok, true);
});

test("a read caller joins the running write probe; if that fails after the listing, reading is asked on its own", async (t) => {
  const base = await scratch(t);
  const hand = handProbe();
  const access = new FolderAccess({ probe: hand.probe, promptWaitMs: 5000 });
  const write = access.probe(base, { write: true });
  const read = access.probe(base, { write: false });
  await sleep(10);
  assert.equal(hand.asked.length, 1, "one probe for both questions");
  hand.answer(base, true, refusedResult(base, true, "mkdir"));
  assert.equal((await write).ok, false);
  await sleep(10);
  assert.deepEqual(hand.asked.at(-1), { path: base, write: false });
  hand.answer(base, false, okResult(base, false));
  assert.equal((await read).ok, true);
});

// ---- keys (LOW-5) ---------------------------------------------------------------------------------------------

test("answers are kept under the folder's real path: a symlink, and the other spelling of a folder name, find the same answer", async (t) => {
  const base = await scratch(t);
  const real = join(base, "Proj");
  await mkdir(real);
  const link = join(base, "link-to-proj");
  let linked = true;
  try {
    await symlink(real, link);
  } catch {
    linked = false; // creating a link needs a privilege on some Windows setups
  }
  const access = new FolderAccess({
    probe: (path, options) => probeFolderAccess(path, options),
  });
  if (linked) {
    await access.probe(link, { write: false });
    assert.equal(
      access.cached(real, false)?.ok,
      true,
      "found under the real path",
    );
  }
  // On a case-insensitive file system (macOS, Windows) the other spelling is the same folder.
  let insensitive = true;
  try {
    realpathSync.native(join(base, "PROJ"));
  } catch {
    insensitive = false;
  }
  if (insensitive) {
    const other = new FolderAccess({
      probe: (path, options) => probeFolderAccess(path, options),
    });
    await other.probe(join(base, "PROJ"), { write: false });
    assert.equal(other.cached(real, false)?.ok, true);
    assert.equal(other.cached(join(base, "proj"), false)?.ok, true);
    assert.equal(
      (other.cached(real, false) as { path: string }).path,
      real,
      "stored with the case as it is on disk",
    );
  }
});

test("a refusal of a folder applies to what is inside it until that is proven otherwise", async (t) => {
  const base = await scratch(t);
  const inner = join(base, "a", "b");
  await mkdir(inner, { recursive: true });
  const access = new FolderAccess({
    probe: async (path, { write }) =>
      path === base
        ? refusedResult(path, write, "mkdir")
        : okResult(path, write),
  });
  await access.probe(base, { write: true });
  assert.equal(
    access.cached(inner, true)?.ok,
    false,
    "judged by the folder it is in",
  );
  assert.equal(access.cached(join(base, "never", "made"), true)?.ok, false);
  await access.probe(inner, { write: true });
  assert.equal(access.cached(inner, true)?.ok, true, "its own answer wins");
});

// ---- the child check without a shell (LOW-2, LOW-4) ----------------------------------------------------

test("folder names with quotes, $(), backticks, newlines and leading dashes are data: probed, nothing run, nothing left", async (t) => {
  const base = await scratch(t);
  const names = posix
    ? [
        'a"b',
        "a'b",
        "$(touch PWNED1)",
        "`touch PWNED2`",
        "x\ny; touch PWNED3",
        "-rf",
        "; touch PWNED4 #",
        "spa ce & | > <",
        "100%",
        "a^b!c",
      ]
    : ["100%", "a^b!c", "a b", "a&b", "a'b"];
  for (const name of names) {
    const dir = join(base, name);
    await mkdir(dir);
    const write = await probeFolderAccess(dir, { write: true });
    assert.equal(
      write.ok,
      true,
      `${JSON.stringify(name)}: ${JSON.stringify(write)}`,
    );
    assert.ok(write.ok && write.steps.includes("child"), "the child check ran");
    assert.ok(write.ok && !write.warning);
    assert.deepEqual(
      await readdir(dir),
      [],
      `leftovers in ${JSON.stringify(name)}`,
    );
    const read = await probeFolderAccess(dir, { write: false });
    assert.equal(read.ok && read.steps.includes("child"), true);
  }
  assert.ok(!(await readdir(base)).some((n) => n.startsWith("PWNED")));
  for (const name of await readdir(process.cwd()))
    assert.ok(!name.startsWith("PWNED"));
});

test('on Windows a folder named with % " ^ ! is still checked through the child (no shell quoting exists)', async (t) => {
  const base = await scratch(t);
  const dir = join(base, "100%");
  await mkdir(dir);
  const calls: string[][] = [];
  const result = await probeFolderAccess(dir, {
    write: true,
    platform: "win32",
    runChild: async (_program, args) => {
      calls.push(args);
      return { code: 0, stderr: "", stdout: "AGENTTEAM_PROBE_OK\n" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "the child step ran");
  assert.ok(result.ok && result.steps.includes("child"));
  assert.ok(calls[0].some((arg) => arg.startsWith(dir)));
});

test("a child that cannot start, or ends without an answer, is inconclusive: a warning, never a refusal", async (t) => {
  const base = await scratch(t);
  const cases: [string, ChildRunner, string][] = [
    [
      "cannot start",
      async () => ({
        code: null,
        stderr: "",
        error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      }),
      "ENOENT",
    ],
    [
      "tools missing (exit 127)",
      async () => ({ code: 127, stderr: "sh: mkdir: command not found" }),
      "EXIT127",
    ],
    [
      "exits 0 but says nothing",
      async () => ({ code: 0, stderr: "", stdout: "" }),
      "NOANSWER",
    ],
    [
      "crashes",
      async () => ({ code: 1, stderr: "Segmentation fault" }),
      "EXIT1",
    ],
  ];
  for (const [label, runner, errno] of cases) {
    const result = await probeFolderAccess(base, {
      write: true,
      runChild: runner,
    });
    assert.equal(result.ok, true, label);
    assert.equal(
      result.ok && result.warning?.code,
      "probe-inconclusive",
      label,
    );
    assert.equal(result.ok && result.warning?.errno, errno, label);
    assert.ok(result.ok && !result.steps.includes("child"), label);
    assert.deepEqual(await readdir(base), [], label);
  }
  // The real runner with a program that does not exist.
  const missing = await probeFolderAccess(base, {
    write: false,
    execPath: join(base, "no-such-node"),
  });
  assert.equal(missing.ok && missing.warning?.errno, "ENOENT");
  // A refusal the child itself reports stays a refusal of the child's.
  const refused = failure(
    await probeFolderAccess(base, {
      write: true,
      runChild: async () => ({
        code: 3,
        stderr: "AGENTTEAM_PROBE EACCES mkdir\n",
        stdout: "",
      }),
    }),
  );
  assert.equal(refused.actor, "child");
  assert.equal(refused.errno, "EACCES");
  assert.equal(refused.operation, "mkdir");
  assert.equal(refused.code, "folder-denied");
});

test(
  "the real child reports the system's own error code",
  { skip: !notRoot && "needs POSIX permissions and a non-root user" },
  async (t) => {
    const base = await scratch(t);
    const locked = join(base, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    // The same program the probe runs, started the same way: the folder is refused to the child.
    const outcome = await runChild(
      process.execPath,
      [
        "-e",
        'try{require("fs").mkdirSync(process.argv[1]+"/x")}catch(e){process.stderr.write("AGENTTEAM_PROBE "+e.code+" mkdir\\n");process.exit(3)}',
        "--",
        locked,
      ],
      { timeoutMs: 10_000 },
    );
    assert.equal(outcome.code, 3);
    assert.match(outcome.stderr, /AGENTTEAM_PROBE EACCES mkdir/);
    // And through the probe itself: a folder that only the child (not the app) is refused in.
    const result = failure(await probeFolderAccess(locked, { write: true }));
    assert.equal(result.errno, "EACCES");
    assert.equal(result.operation, "mkdir");
    assert.equal(result.code, "folder-denied");
  },
);

test("the child check passes the folder as an argument to this executable run as Node, with ELECTRON_RUN_AS_NODE and no secrets", async (t) => {
  const base = await scratch(t);
  process.env.AGENTTEAM_TEST_SECRET_TOKEN = "must-not-reach-the-child";
  t.after(() => delete process.env.AGENTTEAM_TEST_SECRET_TOKEN);
  const seen = join(base, "seen.txt");
  const script = `require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE, secret: process.env.AGENTTEAM_TEST_SECRET_TOKEN ?? null}))`;
  const outcome = await runChild(
    process.execPath,
    ["-e", script, "--", seen, "a b", '"quoted"', "100%"],
    { timeoutMs: 10_000 },
  );
  assert.equal(outcome.code, 0, outcome.stderr);
  const report = JSON.parse(await readFile(seen, "utf8"));
  assert.deepEqual(report.argv, ["a b", '"quoted"', "100%"]);
  assert.equal(report.electron, "1");
  assert.equal(report.secret, null);
});

// ---- nothing left behind (LOW-3) -----------------------------------------------------------------------------

test("a child that is stopped half way leaves nothing in the folder: the runner waits for it to be gone, then the probe cleans up (20 timed-out probes)", async (t) => {
  const base = await scratch(t);
  // A program that makes its probe directory and then hangs, as a slow volume would.
  const halfway: ChildRunner = (program, args, options) =>
    runChild(
      program,
      [
        "-e",
        'require("fs").mkdirSync(process.argv[1]);require("fs").writeFileSync(process.argv[1]+"/probe.txt","");setTimeout(()=>{},60000)',
        "--",
        args[4],
      ],
      options,
    );
  for (let i = 0; i < 20; i++) {
    const result = failure(
      await probeFolderAccess(base, {
        write: true,
        runChild: halfway,
        childTimeoutMs: 120 + (i % 4) * 30,
      }),
    );
    assert.equal(result.errno, "ETIMEDOUT");
    assert.equal(result.actor, "child");
    assert.deepEqual(
      (await readdir(base)).filter((n) => n.startsWith(".agentteam-probe-")),
      [],
      `leftovers after probe ${i + 1}`,
    );
  }
  assert.deepEqual(await readdir(base), []);
});

test("the real runner reports a timed-out child only once it is gone", async (t) => {
  const base = await scratch(t);
  const beat = join(base, "beat.txt");
  const outcome = await runChild(
    process.execPath,
    [
      "-e",
      'const fs=require("fs");let n=0;setInterval(()=>fs.writeFileSync(process.argv[1],String(++n)),5)',
      "--",
      beat,
    ],
    { timeoutMs: 200 },
  );
  assert.equal(outcome.timedOut, true);
  const first = await readFile(beat, "utf8");
  await sleep(80);
  assert.equal(
    await readFile(beat, "utf8"),
    first,
    "the child had stopped when the runner returned",
  );
});

test(
  "a start-up sweep removes probe directories a crash left behind, only old ones, only where the app has probed, and never lists a protected folder before access is proven again",
  simulatedMac,
  async (t) => {
    const base = await scratch(t);
    const home = join(base, "home");
    const store = new Store(":memory:");
    t.after(() => store.close());
    const known = join(base, "known");
    const refused = join(base, "refused");
    const desktop = join(home, "Desktop", "project");
    for (const folder of [known, refused, desktop])
      await mkdir(folder, { recursive: true });
    const probe: ProbeFn = async (path, { write }) =>
      path === refused ? refusedResult(path, write) : okResult(path, write);
    const first = new FolderAccess({ store, probe, platform: "darwin", home });
    for (const folder of [known, refused, desktop])
      await first.probe(folder, { write: true });
    await sleep(50); // the first-success sweep of this process has run
    const old = join(known, ".agentteam-probe-0123456789ab");
    const fresh = join(known, ".agentteam-probe-ba9876543210");
    const keep = join(known, ".agentteam-probe-not-hex-name");
    const user = join(known, "user-folder");
    const inRefused = join(refused, ".agentteam-probe-0123456789ab");
    const inDesktop = join(desktop, ".agentteam-probe-0123456789ab");
    for (const dir of [old, fresh, keep, user, inRefused, inDesktop]) {
      await mkdir(dir);
      await writeFile(join(dir, "probe.txt"), "x");
    }
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    for (const dir of [old, keep, inRefused, inDesktop])
      await utimes(dir, twoMinutesAgo, twoMinutesAgo);
    // A new life of the app: the stored answers say where it has probed.
    const next = new FolderAccess({ store, probe, platform: "darwin", home });
    assert.equal(await next.sweepLeftovers(), 1);
    assert.deepEqual((await readdir(known)).sort(), [
      ".agentteam-probe-ba9876543210",
      ".agentteam-probe-not-hex-name",
      "user-folder",
    ]);
    assert.equal(
      (await readdir(refused)).length,
      1,
      "a refused folder is not listed",
    );
    assert.equal(
      (await readdir(desktop)).length,
      1,
      "a protected folder is not listed at start-up (that could raise a system prompt)",
    );
    // Once access to it is proven in this process, the leftover is removed.
    assert.equal((await next.probe(desktop, { write: true })).ok, true);
    for (let i = 0; i < 50 && (await readdir(desktop)).length; i++)
      await sleep(10);
    assert.deepEqual(await readdir(desktop), []);
  },
);

// ---- typed words ------------------------------------------------------------------------------------------------

test("a pending answer is the typed folder_probe_pending error, a refusal keeps its code, and an error observed outside a probe is worded like a probe's", async (t) => {
  const base = await scratch(t);
  const hand = handProbe();
  const pending = failure(
    await new FolderAccess({ probe: hand.probe, promptWaitMs: 10 }).probe(
      base,
      { write: true },
    ),
  );
  const error = folderRefusal(pending);
  assert.equal(error.code, "folder_probe_pending");
  assert.equal(error.status, 409);
  assert.match(
    error.message,
    /^Waiting for the system to answer AgentTeam's access check of /,
  );
  assert.equal(
    folderRefusal(failure(refusedResult(base, true))).code,
    "folder-denied",
  );
  // An EACCES from a mkdir the app attempted itself.
  const observed = failureFromError(
    base,
    true,
    Object.assign(new Error("EACCES: permission denied, mkdir"), {
      code: "EACCES",
      syscall: "mkdir",
    }),
    "mkdir",
  );
  assert.equal(observed.code, "folder-denied");
  assert.equal(observed.errno, "EACCES");
  assert.match(observed.message, /EACCES \(permission denied\) on mkdir/);
  assert.match(
    observed.fix,
    /Check the folder's permissions or choose another folder/,
  );
  const store = new Store(":memory:");
  t.after(() => store.close());
  const access = new FolderAccess({ store });
  access.noteFailure(observed, "prepare");
  assert.equal(access.cached(base, true)?.ok, false);
  assert.equal(store.list<any>("folder-access")[0].source, "prepare");
  assert.equal(
    store.history(0, 10).filter((e) => e.type === "folder.access_refused")
      .length,
    1,
  );
});
