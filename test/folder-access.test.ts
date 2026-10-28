import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import {
  FolderAccess,
  MACOS_FOLDER_FIX,
  createProjectsFolder,
  insideProjectsRoot,
  probeFolderAccess,
  projectsRoot,
  isPending,
  protectedFolderName,
  reportsDeniedPath,
  slugify,
  suggestProjectFolder,
  withInjectedDenials,
  type ChildRunner,
  type FolderProbeFailure,
  type FolderProbeResult,
  type ProbeFn,
} from "../src/folder-access.ts";

// The folder-access probe (reliable-execution fix F1): the system's own answer about a folder,
// from this process and from a child shell. Temporary folders only; nothing under the home
// folder's Desktop, Documents or Downloads is touched (macOS behaviour is exercised with
// injected errors and an injected platform and home).

async function scratch(t: { after: (fn: () => unknown) => void }) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-folder-access-")),
  );
  t.after(async () => {
    // Permission changes made by a test must not block the cleanup.
    for (const name of await readdir(base).catch(() => [] as string[]))
      await chmod(join(base, name), 0o755).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  return base;
}
const posix = process.platform !== "win32";
const notRoot = posix && process.getuid?.() !== 0;
const failure = (result: FolderProbeResult): FolderProbeFailure => {
  assert.equal(result.ok, false, "expected a refusal");
  return result as FolderProbeFailure;
};
const errno = (code: string, syscall = "mkdir") =>
  Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
const okChild: ChildRunner = async () => ({ code: 0, stderr: "" });

test("a usable folder passes read and write checks from the app process and a child shell, leaving nothing behind", async (t) => {
  const base = await scratch(t);
  const read = await probeFolderAccess(base, { write: false });
  assert.equal(read.ok, true);
  assert.deepEqual((read as { steps: string[] }).steps, [
    "realpath",
    "stat",
    "readdir",
    "child",
  ]);
  const write = await probeFolderAccess(base, { write: true });
  assert.equal(write.ok, true);
  assert.equal(write.path, base);
  assert.deepEqual((write as { steps: string[] }).steps, [
    "realpath",
    "stat",
    "readdir",
    "mkdir",
    "write",
    "read",
    "remove",
    "child",
  ]);
  assert.deepEqual(await readdir(base), [], "probe directories are removed");
});

test("each probe uses its own uniquely named probe directory", async (t) => {
  const base = await scratch(t);
  const seen: string[] = [];
  const run: ChildRunner = async (_program, args) => {
    seen.push(args.join(" "));
    return { code: 0, stderr: "" };
  };
  await probeFolderAccess(base, { write: true, runChild: run });
  await probeFolderAccess(base, { write: true, runChild: run });
  const names = seen.map(
    (line) => line.match(/\.agentteam-probe-[0-9a-f]+/)![0],
  );
  assert.equal(new Set(names).size, 2);
});

test("a missing folder, a file and a relative path are classified without side effects", async (t) => {
  const base = await scratch(t);
  const missing = failure(
    await probeFolderAccess(join(base, "nope"), { write: true }),
  );
  assert.equal(missing.code, "folder-missing");
  assert.equal(missing.errno, "ENOENT");
  assert.equal(missing.operation, "realpath");
  assert.match(missing.message, /nope/);
  assert.match(missing.message, /ENOENT/);
  const file = join(base, "file.txt");
  await writeFile(file, "x");
  const notDirectory = failure(await probeFolderAccess(file, { write: false }));
  assert.equal(notDirectory.code, "folder-not-directory");
  assert.equal(notDirectory.errno, "ENOTDIR");
  assert.match(notDirectory.fix, /not a file/i);
  assert.equal(
    failure(await probeFolderAccess("relative/path")).code,
    "folder-missing",
    "a relative path is not a folder to probe",
  );
  assert.deepEqual(await readdir(base), ["file.txt"]);
});

test(
  "POSIX permissions: an unreadable folder fails to list, a read-only one fails to write, both as EACCES folder-denied",
  { skip: !notRoot && "needs POSIX permissions and a non-root user" },
  async (t) => {
    const base = await scratch(t);
    const locked = join(base, "locked");
    const readOnly = join(base, "read-only");
    await mkdir(locked);
    await mkdir(readOnly);
    await chmod(locked, 0o000);
    await chmod(readOnly, 0o555);
    const unreadable = failure(
      await probeFolderAccess(locked, { write: false }),
    );
    assert.equal(unreadable.code, "folder-denied");
    assert.equal(unreadable.errno, "EACCES");
    assert.equal(unreadable.operation, "readdir");
    assert.equal(unreadable.actor, "app");
    assert.match(unreadable.message, new RegExp(locked.replace(/\//g, "\\/")));
    assert.match(unreadable.message, /readdir/);
    assert.match(unreadable.message, /EACCES/);
    assert.match(
      unreadable.fix,
      /^AgentTeam cannot read .*\(EACCES on readdir\)\. Check the folder's permissions or choose another folder\.$/,
    );
    // Reading a read-only folder is fine; writing is not.
    assert.equal(
      (await probeFolderAccess(readOnly, { write: false })).ok,
      true,
    );
    const unwritable = failure(
      await probeFolderAccess(readOnly, { write: true }),
    );
    assert.equal(unwritable.code, "folder-denied");
    assert.equal(unwritable.errno, "EACCES");
    assert.equal(unwritable.operation, "mkdir");
    assert.match(
      unwritable.fix,
      /^AgentTeam cannot write in .*\(EACCES on mkdir\)\. Check the folder's permissions or choose another folder\.$/,
    );
    assert.deepEqual((await readdir(readOnly)).length, 0);
  },
);

test(
  "EPERM in a macOS-protected folder says macOS has not allowed AgentTeam; elsewhere it is a permissions problem",
  {
    skip:
      process.platform === "win32" && "simulated macOS paths are POSIX paths",
  },
  async (t) => {
    const base = await scratch(t);
    const home = join(base, "home");
    const desktop = join(home, "Desktop", "pi");
    await mkdir(desktop, { recursive: true });
    const refuse = {
      mkdir: async () => {
        throw errno("EPERM");
      },
    };
    const protectedFolder = failure(
      await probeFolderAccess(desktop, {
        write: true,
        platform: "darwin",
        home,
        fs: refuse,
        runChild: okChild,
      }),
    );
    assert.equal(protectedFolder.code, "folder-denied");
    assert.equal(protectedFolder.errno, "EPERM");
    assert.equal(protectedFolder.protectedFolder, "Desktop");
    assert.equal(protectedFolder.fix, MACOS_FOLDER_FIX);
    assert.match(
      MACOS_FOLDER_FIX,
      /System Settings → Privacy & Security → Files and Folders → AgentTeam/,
    );
    assert.match(MACOS_FOLDER_FIX, /outside Desktop, Documents and Downloads/);
    // The same refusal outside a protected location, and on another platform, gets the generic text.
    const elsewhere = failure(
      await probeFolderAccess(desktop, {
        write: true,
        platform: "darwin",
        home: join(base, "other-home"),
        fs: refuse,
        runChild: okChild,
      }),
    );
    assert.equal(elsewhere.protectedFolder, null);
    assert.match(
      elsewhere.fix,
      /^AgentTeam cannot write in .*\(EPERM on mkdir\)/,
    );
    const linux = failure(
      await probeFolderAccess(desktop, {
        write: true,
        platform: "linux",
        home,
        fs: refuse,
        runChild: okChild,
      }),
    );
    assert.equal(linux.protectedFolder, null);
    assert.notEqual(linux.fix, MACOS_FOLDER_FIX);
  },
);

test("a read-only file system is folder-read-only and a half-failed probe still cleans up", async (t) => {
  const base = await scratch(t);
  const removed: string[] = [];
  const readOnly = failure(
    await probeFolderAccess(base, {
      write: true,
      fs: {
        mkdir: async () => {
          throw errno("EROFS");
        },
      },
      runChild: okChild,
    }),
  );
  assert.equal(readOnly.code, "folder-read-only");
  assert.equal(readOnly.errno, "EROFS");
  // The directory exists and the write fails: the probe directory is removed anyway.
  const halfway = failure(
    await probeFolderAccess(base, {
      write: true,
      fs: {
        writeFile: async () => {
          throw errno("EPERM", "open");
        },
        rm: async (path: Parameters<typeof rm>[0]) => {
          removed.push(String(path));
        },
      },
      runChild: okChild,
    }),
  );
  assert.equal(halfway.operation, "write");
  assert.equal(removed.length, 1);
  assert.match(removed[0], /\.agentteam-probe-/);
  await rm(removed[0], { recursive: true, force: true });
  // A directory that could be made but not removed is reported, not ignored.
  const stuck = failure(
    await probeFolderAccess(base, {
      write: true,
      fs: {
        rm: async () => {
          throw errno("EPERM", "rmdir");
        },
      },
      runChild: okChild,
    }),
  );
  assert.equal(stuck.operation, "remove");
  assert.equal(stuck.code, "folder-denied");
  for (const name of await readdir(base))
    await rm(join(base, name), { recursive: true, force: true });
});

test("the programs AgentTeam starts are checked too: a refusal that only the child sees is reported as the child's", async (t) => {
  const base = await scratch(t);
  const refused = failure(
    await probeFolderAccess(base, {
      write: true,
      runChild: async () => ({
        code: 1,
        stderr: "mkdir: /x/.agentteam-probe-1: Operation not permitted\n",
      }),
    }),
  );
  assert.equal(refused.actor, "child");
  assert.equal(refused.code, "folder-denied");
  assert.equal(refused.errno, "EPERM");
  assert.equal(refused.operation, "mkdir");
  assert.match(refused.message, /A program AgentTeam starts \(/);
  assert.deepEqual(
    await readdir(base),
    [],
    "the app process cleaned up its own probe",
  );
  // A child that made its directory but could not remove it does not leave it behind.
  if (posix) {
    const messy = failure(
      await probeFolderAccess(base, {
        write: true,
        runChild: async (_program, args) => {
          await mkdir(args[4]);
          return {
            code: 1,
            stderr: "rm: probe.txt: Operation not permitted\n",
          };
        },
      }),
    );
    assert.equal(messy.actor, "child");
    assert.deepEqual(
      await readdir(base),
      [],
      "the leftover directory was removed",
    );
  }
  // A child that cannot even start is neither a refusal nor a pass: the folder itself passed, the
  // result is usable and carries a warning that the programs AgentTeam starts were not confirmed.
  const noChild = await probeFolderAccess(base, {
    write: false,
    runChild: async () => ({
      code: null,
      stderr: "",
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
    }),
  });
  assert.equal(noChild.ok, true);
  assert.equal(noChild.ok && noChild.warning?.code, "probe-inconclusive");
  assert.equal(noChild.ok && noChild.warning?.errno, "ENOENT");
  assert.ok(noChild.ok && !noChild.steps.includes("child"));
  const hung = failure(
    await probeFolderAccess(base, {
      write: true,
      runChild: async () => ({ code: null, stderr: "", timedOut: true }),
    }),
  );
  assert.equal(hung.errno, "ETIMEDOUT");
  // The child is this app's own executable run as Node, with no shell on any platform: the folder
  // is an argument after `--`, never part of the program text.
  const calls: { program: string; args: string[] }[] = [];
  await probeFolderAccess(base, {
    write: true,
    platform: "linux",
    runChild: async (program, args) => {
      calls.push({ program, args });
      return { code: 0, stderr: "" };
    },
  });
  assert.equal(calls[0].program, process.execPath);
  assert.equal(calls[0].args[0], "-e");
  assert.ok(!calls[0].args[1].includes(base));
  assert.equal(calls[0].args[2], "--");
  assert.equal(calls[0].args[3], "write");
  assert.ok(calls[0].args[4].startsWith(base));
});

test("macOS-protected locations: Desktop, Documents, Downloads, iCloud Drive and volumes, on macOS only", () => {
  const home = "/Users/s";
  const at = (path: string, platform: NodeJS.Platform = "darwin") =>
    protectedFolderName(path, { platform, home });
  assert.equal(at("/Users/s/Desktop"), "Desktop");
  assert.equal(at("/Users/s/Desktop/python/pi.py"), "Desktop");
  assert.equal(
    at("/Users/s/desktop/x"),
    "Desktop",
    "case-insensitive file system",
  );
  assert.equal(at("/Users/s/Documents/work"), "Documents");
  assert.equal(at("/Users/s/Downloads"), "Downloads");
  assert.equal(
    at("/Users/s/Library/Mobile Documents/com~apple~CloudDocs/x"),
    "iCloud Drive",
  );
  assert.equal(at("/Users/s/Library/CloudStorage/Dropbox/x"), "cloud storage");
  assert.equal(at("/Volumes/Backup/project"), "an external or network volume");
  assert.equal(at("/Users/s/GIT/AgentTeam"), null);
  assert.equal(at("/Users/s/AgentTeam Projects/pi"), null);
  assert.equal(at("/Users/s/DesktopOld"), null, "a sibling is not inside");
  assert.equal(at("/Users/other/Desktop"), null);
  assert.equal(at("/Users/s/Desktop", "linux"), null);
  assert.equal(at("/Users/s/Desktop", "win32"), null);
});

test("an output that reports the system's refusal for a path under the task folder is recognised", () => {
  const root = "/Users/s/Desktop";
  assert.equal(
    reportsDeniedPath(
      'Both attempts to write under `/Users/s/Desktop` failed with "Operation not permitted": Bash `mkdir -p /Users/s/Desktop/python` was refused; the Write tool failed with `EPERM`.',
      root,
    ),
    true,
  );
  assert.equal(
    reportsDeniedPath("open /Users/s/Desktop/x: Permission denied", root),
    true,
  );
  assert.equal(
    reportsDeniedPath(
      "EACCES: permission denied, mkdir '/Users/s/Desktop/a'",
      root,
    ),
    true,
  );
  // A refusal elsewhere, or a path that only starts with the folder's name, is not this folder's.
  assert.equal(
    reportsDeniedPath("mkdir /etc/x: Operation not permitted", root),
    false,
  );
  assert.equal(
    reportsDeniedPath("EPERM on /Users/s/DesktopOld/x", root),
    false,
  );
  assert.equal(
    reportsDeniedPath("Created /Users/s/Desktop/python/pi.py", root),
    false,
  );
  assert.equal(
    reportsDeniedPath("EPERM C:\\Work\\proj\\out.txt", "C:/Work/proj"),
    true,
    "either separator matches",
  );
  assert.equal(reportsDeniedPath("EPERM in /a/my.dir/x", "/a/my.dir"), true);
  assert.equal(
    reportsDeniedPath("EPERM in /a/myXdir/x", "/a/my.dir"),
    false,
    "dots are literal",
  );
});

// ---- the cache -----------------------------------------------------------------------------

function fakeProbe(
  answers: Record<string, boolean>,
  log: string[] = [],
  operation = "readdir",
): ProbeFn {
  return async (path, { write }) => {
    log.push(`${write ? "w" : "r"}:${path}`);
    const ok = answers[path] ?? true;
    const base = {
      path,
      write,
      checkedAt: new Date().toISOString(),
      protectedFolder: null,
      steps: [],
    };
    return ok
      ? { ok: true, ...base }
      : {
          ok: false,
          code: "folder-denied",
          errno: "EPERM",
          operation,
          actor: "app",
          message: `denied ${path}`,
          fix: "fix it",
          ...base,
        };
  };
}

test("answers are cached for the TTL, shared while a probe runs, and refreshed by force or invalidation", async (t) => {
  const base = await scratch(t);
  const log: string[] = [];
  let clock = 1_000;
  const access = new FolderAccess({
    probe: fakeProbe({}, log),
    ttlMs: 30_000,
    now: () => clock,
  });
  // Five requests at once ask the system once.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => access.probe(base, { write: true })),
  );
  assert.equal(log.length, 1);
  assert.ok(results.every((r) => r.ok));
  // Fresh within the TTL; a write answer also answers a read question.
  clock += 29_000;
  await access.probe(base, { write: true });
  await access.probe(base, { write: false });
  assert.equal(log.length, 1);
  // Expired: asked again. Forced: asked again at once.
  clock += 2_000;
  await access.probe(base, { write: true });
  assert.equal(log.length, 2);
  await access.probe(base, { write: true, force: true });
  assert.equal(log.length, 3);
  access.invalidate(base);
  assert.equal(access.cached(base, true), undefined);
  await access.probe(base, { write: true });
  assert.equal(log.length, 4);
  // Invalidating a folder forgets the folders inside it as well.
  const inner = join(base, "inner");
  await mkdir(inner);
  await access.probe(inner, { write: false });
  access.invalidate(base);
  assert.equal(access.cached(inner, false), undefined);
});

test("a refusal stays known until the folder is asked about again; a success decays to unknown", async (t) => {
  const base = await scratch(t);
  const answers: Record<string, boolean> = { [base]: false };
  let clock = 0;
  // The write is refused at the mkdir, after the folder was listed: reading is a question of its own.
  const access = new FolderAccess({
    probe: fakeProbe(answers, [], "mkdir"),
    ttlMs: 30_000,
    now: () => clock,
  });
  await access.probe(base, { write: true });
  clock += 10 * 60_000;
  assert.equal(
    access.cached(base, true)?.ok,
    false,
    "a preview must not offer what would fail again",
  );
  assert.equal(
    access.cached(base, false),
    undefined,
    "a refused write says nothing about reading",
  );
  // A failed read answers a write question (nothing can be written where nothing can be read).
  const unreadable = join(base, "unreadable");
  answers[unreadable] = false;
  await access.probe(unreadable, { write: false });
  assert.equal(access.cached(unreadable, true)?.ok, false);
  answers[base] = true;
  const again = await access.probe(base, { write: true });
  assert.equal(again.ok, true, "the next probe sees the folder opened");
  assert.equal(access.cached(base, true)?.ok, true);
  clock += 31_000;
  assert.equal(
    access.cached(base, true),
    undefined,
    "an old success is not trusted",
  );
  assert.equal(access.cached(join(base, "never-asked"), true), undefined);
});

test(
  "only a change of answer is announced, and a probe stuck on a system prompt is pending (not refused) and does not hold callers for ever",
  {
    skip:
      process.platform === "win32" && "simulated macOS paths are POSIX paths",
  },
  async (t) => {
    const scratchFolder = await scratch(t);
    // A simulated Mac whose home folder is a temporary one: the "Desktop" below is ours.
    const home = join(scratchFolder, "home");
    const base = join(home, "Desktop", "pi");
    await mkdir(base, { recursive: true });
    const store = new Store(":memory:");
    t.after(() => store.close());
    let release: (() => void) | undefined;
    let open = false;
    const stuck: ProbeFn = (path, { write }) =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            open
              ? {
                  ok: true,
                  path,
                  write,
                  checkedAt: "now",
                  protectedFolder: "Desktop",
                  steps: [],
                }
              : {
                  ok: false,
                  code: "folder-denied",
                  errno: "EPERM",
                  operation: "readdir",
                  actor: "app",
                  message: "m",
                  fix: "f",
                  path,
                  write,
                  checkedAt: "now",
                  protectedFolder: "Desktop",
                  steps: [],
                },
          );
      });
    const access = new FolderAccess({
      store,
      probe: stuck,
      promptWaitMs: 20,
      platform: "darwin",
      home,
    });
    const announced = (type: string) =>
      store.history(0, 100).filter((e) => e.type === type);
    const first = await access.probe(base, { write: true });
    // After the wait the caller is told the answer is pending: nothing was refused, so nothing
    // says "not allowed", and readiness sees the same thing.
    const waiting = failure(first);
    assert.equal(waiting.code, "folder-probe-pending");
    assert.match(
      waiting.message,
      /^Waiting for macOS to allow access to .*pi…$/,
    );
    assert.equal(isPending(first), true);
    assert.equal(isPending(access.cached(base, true)), true);
    assert.equal(announced("folder.access_refused").length, 0);
    assert.equal(announced("folder.access_allowed").length, 0);
    assert.equal(
      store.list("folder-access").length,
      0,
      "pending is not stored",
    );
    // The person answers the prompt later: the late result replaces the pending one, once.
    open = true;
    release!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(access.cached(base, true)?.ok, true);
    const events = announced("folder.access_allowed");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, {
      path: base,
      write: true,
      ok: true,
      source: "unknown",
    });
    // Asking again with the same answer announces nothing new.
    const refresh = access.probe(base, { write: true, force: true });
    release!();
    await refresh;
    assert.equal(announced("folder.access_allowed").length, 1);
    // A stuck probe in a folder macOS does not protect is a wait for "the system", not for macOS.
    const elsewhere = failure(
      await new FolderAccess({
        probe: stuck,
        promptWaitMs: 20,
        platform: "darwin",
        home,
      }).probe(scratchFolder, { write: true }),
    );
    assert.equal(elsewhere.code, "folder-probe-pending");
    assert.doesNotMatch(elsewhere.message, /macOS/);
  },
);

test("returning to the app asks again about every refused folder and announces the ones that opened", async (t) => {
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const answers: Record<string, boolean> = { [base]: false };
  const access = new FolderAccess({ store, probe: fakeProbe(answers) });
  await access.probe(base, { write: true });
  answers[base] = true;
  assert.equal(await access.recheckFailed(), 1);
  assert.equal(access.cached(base, true)?.ok, true);
  assert.equal(
    store.history(0, 100).filter((e) => e.type === "folder.access_allowed")
      .length,
    1,
  );
  assert.equal(
    await access.recheckFailed(),
    0,
    "nothing refused is left to ask about",
  );
});

test("the test seam denies listed folders as macOS would, only under AGENTTEAM_TEST=1", async (t) => {
  const base = await scratch(t);
  const denied = join(base, "denied");
  const fine = join(base, "fine");
  await mkdir(denied);
  await mkdir(fine);
  await mkdir(join(denied, "inner"));
  const seen: string[] = [];
  const probe = withInjectedDenials(fakeProbe({}, seen));
  const saved = { ...process.env };
  t.after(() => {
    for (const key of [
      "AGENTTEAM_TEST",
      "AGENTTEAM_TEST_FOLDER_DENY",
      "AGENTTEAM_TEST_FOLDER_PENDING",
    ])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
  });
  process.env.AGENTTEAM_TEST_FOLDER_DENY = denied;
  delete process.env.AGENTTEAM_TEST;
  assert.equal(
    (await probe(denied, { write: true })).ok,
    true,
    "ignored without AGENTTEAM_TEST",
  );
  process.env.AGENTTEAM_TEST = "1";
  const refused = failure(await probe(denied, { write: true }));
  assert.equal(refused.errno, "EPERM");
  assert.equal(refused.fix, MACOS_FOLDER_FIX);
  assert.equal(
    failure(await probe(join(denied, "inner"), { write: false })).code,
    "folder-denied",
  );
  assert.equal((await probe(fine, { write: true })).ok, true);
  // Refused folders never reach the real probe; the first call passed through with the seam off.
  assert.deepEqual(seen, [`w:${denied}`, `w:${fine}`]);
  // A listed "pending" folder waits, like the real listing waits for an unanswered system prompt,
  // until the variable no longer names it; then it is probed for real.
  process.env.AGENTTEAM_TEST_FOLDER_DENY = "";
  process.env.AGENTTEAM_TEST_FOLDER_PENDING = fine;
  let done = false;
  const waiting = probe(fine, { write: true }).then((result) => {
    done = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(done, false, "still waiting for the person");
  process.env.AGENTTEAM_TEST_FOLDER_PENDING = "";
  assert.equal((await waiting).ok, true);
  assert.equal(seen.length, 3);
});

// ---- default project folders ---------------------------------------------------------------

test("project folders AgentTeam proposes live in its own projects folder, named for the request", async (t) => {
  const base = await scratch(t);
  const saved = process.env.AGENTTEAM_PROJECTS_DIR;
  process.env.AGENTTEAM_PROJECTS_DIR = join(base, "AgentTeam Projects");
  t.after(() => {
    if (saved === undefined) delete process.env.AGENTTEAM_PROJECTS_DIR;
    else process.env.AGENTTEAM_PROJECTS_DIR = saved;
  });
  assert.equal(projectsRoot(), join(base, "AgentTeam Projects"));
  assert.equal(
    slugify("Make a program in Python, C++ and TypeScript!"),
    "make-a-program-in-python-c",
  );
  assert.equal(slugify("  ../../etc/passwd  "), "etc-passwd");
  assert.equal(slugify("???"), "");
  const first = suggestProjectFolder("Compute pi to 500 digits");
  assert.equal(first, join(projectsRoot(), "compute-pi-to-500-digits"));
  assert.equal(insideProjectsRoot(first), true);
  assert.equal(insideProjectsRoot(base), false);
  assert.equal(insideProjectsRoot(join(projectsRoot(), "..", "x")), false);
  assert.equal(
    insideProjectsRoot(projectsRoot()),
    false,
    "the root itself is not a project",
  );
  // Created only on request, and only inside the projects folder.
  assert.equal(await createProjectsFolder(first), true);
  assert.deepEqual(await readdir(first), []);
  assert.equal(await createProjectsFolder(join(base, "elsewhere")), false);
  await assert.rejects(readdir(join(base, "elsewhere")), { code: "ENOENT" });
  // An existing empty folder is reused; a used one gets the next free name.
  assert.equal(suggestProjectFolder("Compute pi to 500 digits"), first);
  await writeFile(join(first, "pi.py"), "x");
  assert.equal(suggestProjectFolder("Compute pi to 500 digits"), `${first}-2`);
  // A folder that cannot be made is a typed refusal that names the error, not an unexpected failure.
  await assert.rejects(createProjectsFolder(join(first, "pi.py", "inside")), {
    code: "invalid_path",
    message: /ENOTDIR on mkdir/,
  });
  assert.equal(
    suggestProjectFolder("???", "Pipeline team"),
    join(projectsRoot(), "pipeline-team"),
  );
  const home = "/Users/s";
  for (const path of [
    first,
    suggestProjectFolder("x"),
    suggestProjectFolder(""),
  ])
    assert.equal(protectedFolderName(path, { platform: "darwin", home }), null);
});

// ---- the diagnostic command ----------------------------------------------------------------

test("`node src/cli.ts folder-probe <path> [--write]` prints the probe result as JSON and sets the exit status", async (t) => {
  const base = await scratch(t);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "folder-probe", ...args], {
      encoding: "utf8",
    });
  const ok = run(base, "--write");
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.write, true);
  assert.equal(parsed.path, base);
  assert.deepEqual(parsed.steps.slice(-2), ["remove", "child"]);
  const missing = run(join(base, "nope"));
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).code, "folder-missing");
  assert.equal(run().status, 2);
  assert.match(
    run().stderr,
    /Usage: node src\/cli\.ts folder-probe <path> \[--write\]/,
  );
  assert.equal(run(base, "--bogus").status, 2);
  assert.deepEqual(await readdir(base), []);
});

test("changing an agent's attachments forgets what the system said about those folders; other edits keep it", async (t) => {
  const { SkillCatalog } = await import("../src/skills.ts");
  const { TeamService } = await import("../src/service.ts");
  const base = await scratch(t);
  const store = new Store(":memory:");
  t.after(() => store.close());
  const service = new TeamService(store, new SkillCatalog([]));
  const folder = join(base, "project");
  const other = join(base, "other");
  await mkdir(folder);
  await mkdir(other);
  const agent = await service.saveAgent({
    name: "Writer",
    environment: "claude",
    workspaces: [{ path: folder, access: "write", active: true }],
  });
  await service.folderAccess.probe(folder, { write: true });
  assert.equal(service.folderAccess.cached(folder, true)?.ok, true);
  // A change that leaves the attachments alone keeps the answer.
  await service.saveAgent(
    {
      name: "Writer",
      environment: "claude",
      role: "Writes",
      workspaces: [{ path: folder, access: "write", active: true }],
    },
    agent.id,
  );
  assert.equal(service.folderAccess.cached(folder, true)?.ok, true);
  // Detaching, attaching or changing the access asks again.
  await service.saveAgent(
    {
      name: "Writer",
      environment: "claude",
      workspaces: [{ path: other, access: "read", active: true }],
    },
    agent.id,
  );
  assert.equal(service.folderAccess.cached(folder, true), undefined);
});
