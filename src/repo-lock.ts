import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Serializes Git metadata changes per repository. The queue key is the repository's *common* Git
 * directory (`repoLockKey`), so the main checkout and every linked worktree, which share refs,
 * config, packed objects and the index-lock-adjacent metadata, take the same lock. Worktree
 * management (src/worktrees.ts) and Git workflow actions (src/git-workflow.ts, staging/commit in
 * src/workspaces.ts) all use this one queue.
 */
const repoQueues = new Map<string, Promise<unknown>>();
export async function withRepoLock<T>(
  repo: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = repoQueues.get(repo) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tail = next.catch(() => {});
  repoQueues.set(repo, tail);
  try {
    return await next;
  } finally {
    if (repoQueues.get(repo) === tail) repoQueues.delete(repo);
  }
}
/** Number of repositories with Git work queued or running (test and diagnostics aid). */
export const activeRepoLocks = () => repoQueues.size;

/** Canonical lock key for any folder inside a repository or linked worktree; falls back to the folder. */
export async function repoLockKey(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 10_000 },
    );
    return await realpath(resolve(cwd, stdout.trim()));
  } catch {
    return await realpath(cwd).catch(() => resolve(cwd));
  }
}
/** Run `fn` under the shared per-repository lock, keyed by the common Git directory of `cwd`. */
export async function withRepoLockFor<T>(
  cwd: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withRepoLock(await repoLockKey(cwd), fn);
}
