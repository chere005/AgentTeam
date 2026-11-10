import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SAFE_GIT_CONFIG } from "./git-config.ts";

/**
 * Changed-file evidence measured from Git rather than trusted from the task or its result JSON.
 * Synchronous on purpose: it runs inside the task-transition hooks, which are synchronous store
 * transactions. Read-only Git plumbing with the same safe options as every other invocation; a
 * repository that cannot be asked (not Git, no `git`, timeout) yields no measurement, and the
 * evidence then says it is declared, not measured.
 */
const GIT_TIMEOUT_MS = 10_000;
const MAX_HASH_BYTES = 5_000_000;
const MAX_FILES = 1_000;

/** What a repository looked like when a task started. */
export type GitBase = {
  root: string;
  /** HEAD at start; null in a repository with no commits yet. */
  head: string | null;
  /** Files already changed at start (repo-relative) with a content hash, so they are not blamed on the task. */
  dirty: Record<string, string>;
};
/** The stored outcome for a completed task (kind `task-changed-files`, id = task id). */
export type ChangedFilesEvidence = {
  id: string;
  source: "git" | "declared";
  /** The union used for routing. */
  files: string[];
  measured: string[];
  declared: string[];
  roots: string[];
  measuredAt: string;
};

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...SAFE_GIT_CONFIG, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64_000_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      LC_ALL: "C",
    },
  });
}
const lines = (out: string) => out.split("\0").filter(Boolean);

export function gitRootOf(dir: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    const top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    return top || null;
  } catch {
    return null;
  }
}
function headOf(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}
/** Paths differing from `head` in the working tree (staged, unstaged, committed since) plus untracked. */
function changedSince(root: string, head: string | null): string[] {
  const tracked = head
    ? lines(git(root, ["diff", "--name-only", "-z", "--no-renames", head]))
    : lines(git(root, ["ls-files", "-z", "--cached"]));
  const untracked = lines(
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
  );
  return [...new Set([...tracked, ...untracked])];
}
function fileHash(root: string, rel: string) {
  const path = join(root, rel);
  try {
    const info = statSync(path);
    if (!info.isFile()) return `kind:${info.isDirectory() ? "dir" : "other"}`;
    if (info.size > MAX_HASH_BYTES) return `size:${info.size}:${info.mtimeMs}`;
    return createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return "absent";
  }
}

/** Records the starting state of every distinct repository containing one of `dirs`. */
export function captureGitBases(dirs: string[]): GitBase[] {
  const bases = new Map<string, GitBase>();
  for (const dir of dirs) {
    const root = gitRootOf(dir);
    if (!root || bases.has(root)) continue;
    try {
      const head = headOf(root);
      const dirty: Record<string, string> = {};
      for (const rel of changedSince(root, head).slice(0, MAX_FILES))
        dirty[rel] = fileHash(root, rel);
      bases.set(root, { root, head, dirty });
    } catch {
      // Not measurable: the evidence will be declared-only for this repository.
    }
  }
  return [...bases.values()];
}

/** Files changed since the recorded bases, or null when no repository could be measured. */
export function measureGitChanges(bases: GitBase[]): string[] | null {
  let measured = false;
  const out = new Set<string>();
  for (const base of bases) {
    try {
      for (const rel of changedSince(base.root, base.head).slice(
        0,
        MAX_FILES,
      )) {
        // Already changed at start and still byte-identical: not this task's change.
        if (base.dirty[rel] && base.dirty[rel] === fileHash(base.root, rel))
          continue;
        out.add(rel);
      }
      measured = true;
    } catch {
      // This repository could not be asked.
    }
  }
  return measured ? [...out].slice(0, MAX_FILES) : null;
}
