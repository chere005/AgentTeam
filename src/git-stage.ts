import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { AppError, assert } from "./model.ts";

/**
 * Staging/unstaging path handling for deleted files, nested deleted directories, renames and
 * repositories without commits. Everything resolves relative to the attached repository root
 * (already a realpath); nothing escapes it and `.git` is never addressable.
 */
type Run = (args: string[]) => Promise<string>;
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !/^\.\.[\\/]/.test(rel))
  );
};

/**
 * Validate a user path and return a repository-relative path that git may receive as a literal
 * pathspec. The path itself may be missing (deleted file or whole deleted directory tree): the
 * deepest existing ancestor is resolved with realpath and must stay inside the root, so a symlinked
 * parent cannot be used to reach outside files. A symlink as the final component is allowed (git
 * records the link itself and never follows it).
 */
export async function resolveGitPath(root: string, input: string) {
  assert(
    typeof input === "string" &&
      input.length > 0 &&
      !input.includes("\0") &&
      !isAbsolute(input) &&
      !/^[A-Za-z]:/.test(input),
    "invalid_path",
    "Use a relative path",
    400,
  );
  const parts = input.split(/[\\/]+/).filter((s) => s && s !== ".");
  assert(
    !parts.includes("..") && !parts.includes(".git"),
    parts.includes(".git") ? "git_internal" : "path_escape",
    parts.includes(".git")
      ? "Direct access to Git internals is not supported"
      : "Path escapes the attached workspace",
    403,
  );
  if (!parts.length) return ".";
  const leaf = parts[parts.length - 1];
  let ancestor = resolve(root, ...parts.slice(0, -1));
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      if (ancestor === root || dirname(ancestor) === ancestor)
        throw new AppError(
          400,
          "invalid_path",
          "Path is outside the workspace",
        );
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const real = await realpath(ancestor);
  assert(
    inside(root, real),
    "path_escape",
    "Path escapes the attached workspace",
    403,
  );
  const rel = join(relative(root, real), ...missing, leaf);
  assert(
    !rel.split(/[\\/]/).includes(".git"),
    "git_internal",
    "Direct access to Git internals is not supported",
    403,
  );
  return rel.split("\\").join("/");
}

export type StageInput = {
  action: "stage" | "unstage";
  paths: string[];
  /** Explicit rename pairs (old path deleted, new path present); both sides move together. */
  renames?: { from: string; to: string }[];
};

/** Files whose index entry is a rename/copy: unstaging the new name must also restore the old one. */
async function renameSources(run: Run, repo: string, paths: string[]) {
  const out = await run([
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--find-renames",
  ]);
  const records = out.split("\0"),
    wanted = new Set(paths),
    extra: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    if (/[RC]/.test(line.slice(0, 1))) {
      const from = records[++i],
        to = line.slice(3);
      if (wanted.has(to) && from && !wanted.has(from)) extra.push(from);
    }
  }
  return extra;
}

export async function applyStaging(run: Run, repo: string, input: StageInput) {
  const resolved = new Set<string>();
  for (const p of input.paths) resolved.add(await resolveGitPath(repo, p));
  for (const r of input.renames ?? []) {
    resolved.add(await resolveGitPath(repo, r.from));
    resolved.add(await resolveGitPath(repo, r.to));
  }
  assert(
    resolved.size > 0,
    "paths_required",
    "Choose paths to stage or unstage",
    400,
  );
  let paths = [...resolved];
  if (input.action === "stage") {
    await run(["add", "-A", "--", ...paths]);
    return { paths };
  }
  // A repository without commits has no HEAD to restore from.
  let unborn = false;
  try {
    await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  } catch {
    unborn = true;
  }
  if (!unborn) {
    try {
      paths = [
        ...new Set([...paths, ...(await renameSources(run, repo, paths))]),
      ];
    } catch {
      /* status failing here would also fail the restore below */
    }
    await run(["restore", "--staged", "--", ...paths]);
  } else
    await run([
      "rm",
      "--cached",
      "-r",
      "-q",
      "--ignore-unmatch",
      "--",
      ...paths,
    ]);
  return { paths };
}
