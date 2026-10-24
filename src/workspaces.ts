import { readdir, realpath, stat, open } from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  extname,
  join,
} from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { openCommand } from "./native.ts";
import { attachedRepoGitConfig, SAFE_GIT_CONFIG } from "./git-config.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { applyStaging } from "./git-stage.ts";
import { createHash, randomUUID } from "node:crypto";
import { ResourceCoordinator, overlaps, type Lease } from "./resources.ts";
import {
  decideBoth,
  filterDiff,
  hasRestrictions,
  lexicalRelative,
  repoPathFilter,
  traversable,
  type AccessLevel,
} from "./access.ts";
import { withRepoLockFor } from "./repo-lock.ts";
import { Store } from "./store.ts";
import { AppError, assert, type Agent, type Task } from "./model.ts";
import {
  DIFF_MAX_BYTES,
  type DiffMeta,
  REVIEW_MAX_FILES,
  capDiff,
  parseDiffMeta,
  parseNameStatus,
  revisionProblem,
} from "./diff.ts";
import {
  resetWorkspaceBaseline,
  workspaceChanges,
} from "./workspace-changes.ts";
import { loadSublimeEditorConfig } from "./sublime-config.ts";
const exec = promisify(execFile);
export const TEXT_EDITOR_MAX_BYTES = 256_000;
const FILE_SEARCH_MAX_RESULTS = 300;
const FILE_SEARCH_MAX_VISITS = 8_000;
const subsequenceScore = (query: string, candidate: string) => {
  const text = candidate.toLowerCase();
  let total = 0;
  for (const q of query.toLowerCase().trim().split(/\s+/).filter(Boolean)) {
    let at = 0,
      gaps = 0,
      last = -2;
    for (const char of q) {
      const found = text.indexOf(char, at);
      if (found < 0) return 0;
      if (last >= 0) gaps += found - last - 1;
      last = found;
      at = found + 1;
    }
    total += Math.max(1, 100 - gaps - (text.includes(q) ? 0 : at));
  }
  return total;
};
const textFileSchema = z
  .object({ workspace: z.string(), path: z.string() })
  .strict();
const saveTextSchema = textFileSchema
  .extend({
    content: z.string().max(TEXT_EDITOR_MAX_BYTES),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const createTextSchema = textFileSchema
  .extend({ content: z.string().max(TEXT_EDITOR_MAX_BYTES) })
  .strict();
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const lexicalRel = lexicalRelative;
const requestSchema = z
  .object({ workspace: z.string(), path: z.string().default(".") })
  .strict();
export class WorkspaceService {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async location(
    agentId: string,
    input: unknown,
    write = false,
    opts: { traverse?: boolean } = {},
  ) {
    const data = requestSchema.parse(input);
    filesystemPolicy(this.store).assertPath(data.workspace);
    const agent = this.store.get<Agent>("agent", agentId);
    const ws = agent.workspaces.find((w) => w.path === data.workspace);
    assert(
      ws,
      "workspace_denied",
      "Directory is not attached to this agent",
      403,
    );
    assert(
      !write ||
        ws.access === "write" ||
        (ws.rules ?? []).some((r) => r.access === "write"),
      "read_only",
      "Agent has read-only access",
      403,
    );
    assert(
      !isAbsolute(data.path) && !data.path.includes("\0"),
      "invalid_path",
      "Use a relative path",
      400,
    );
    assert(
      !data.path.split(/[\\/]/).includes(".git"),
      "git_internal",
      "Direct access to Git internals is not supported",
      403,
    );
    const root = await realpath(ws.path);
    assert(
      root === ws.path,
      "workspace_changed",
      "Workspace target changed; reattach it",
      409,
    );
    const target = await realpath(resolve(root, data.path));
    const rel = relative(root, target);
    assert(
      !/^\.\.[\\/]/.test(rel) && rel !== ".." && !isAbsolute(rel),
      "path_escape",
      "Path escapes the attached workspace",
      403,
    );
    assert(
      !rel.split(/[\\/]/).includes(".git"),
      "git_internal",
      "Direct access to Git internals is not supported",
      403,
    );
    // Rules and exclusions: stricter of the lexical request path and the real path.
    const lexical = lexicalRel(data.path);
    const decision = decideBoth(ws, lexical, rel.split("\\").join("/"));
    let access: AccessLevel = decision.access;
    if (access === "none") {
      const onlyListing =
        opts.traverse &&
        !write &&
        traversable(ws, rel.split("\\").join("/")) &&
        decision.source !== "exclusion";
      assert(
        onlyListing,
        "access_denied",
        `Access denied: ${decision.reason}`,
        403,
      );
    } else
      assert(
        !write || access === "write",
        "read_only",
        decision.source === "inherited"
          ? "Agent has read-only access"
          : `Read-only here: ${decision.reason}`,
        403,
      );
    return {
      root,
      target,
      relative: rel || ".",
      access: access as "none" | "read" | "write",
      /** True when exclusions/explicit-only rules apply: whole-tree Git changes are refused. */
      restricted: hasRestrictions(ws),
    };
  }
  /** Staging/resolving names paths directly: each must be writable under the attachment's rules. */
  async assertPathsWritable(agentId: string, root: string, paths: string[]) {
    filesystemPolicy(this.store).assertPath(root);
    const agent = this.store.get<Agent>("agent", agentId);
    const ws = agent.workspaces.find((w) => w.path === root);
    if (!ws || !hasRestrictions(ws)) return;
    for (const p of paths) {
      const rel = lexicalRel(p);
      const d = decideBoth(ws, rel, rel);
      assert(
        d.access === "write",
        d.access === "none" ? "access_denied" : "read_only",
        `${p}: ${d.reason}`,
        403,
      );
    }
  }
  /** Predicate hiding repository-relative paths the agent's rules exclude (status, diffs, commit files). */
  async visibleInRepo(agentId: string, root: string, repoTop: string) {
    const agent = this.store.get<Agent>("agent", agentId);
    const ws = agent.workspaces.find((w) => w.path === root);
    if (!ws || !hasRestrictions(ws)) return () => true;
    return repoPathFilter(ws, repoTop, root);
  }
  async browse(agentId: string, input: unknown) {
    const loc = await this.location(agentId, input, false, {
      traverse: true,
    });
    assert(
      (await stat(loc.target)).isDirectory(),
      "not_directory",
      "Path is not a directory",
      400,
    );
    const entries = await readdir(loc.target, { withFileTypes: true });
    const ws = this.store
      .get<Agent>("agent", agentId)
      .workspaces.find((w) => w.path === loc.root)!;
    const shown = (name: string, dir: boolean) => {
      if (!ws.rules?.length && !ws.explicitOnly) return true;
      const rel = join(loc.relative === "." ? "" : loc.relative, name)
        .split("\\")
        .join("/");
      const d = decideBoth(ws, rel, rel);
      return d.access !== "none" || (dir && traversable(ws, rel));
    };
    return {
      ...loc,
      entries: entries
        .filter((e) => e.name !== ".git")
        .filter((e) => shown(e.name, e.isDirectory()))
        .map((e) => ({
          name: e.name,
          path: join(loc.relative, e.name),
          type: e.isDirectory()
            ? "directory"
            : e.isSymbolicLink()
              ? "symlink"
              : "file",
        }))
        .sort((a, b) =>
          a.type === b.type
            ? a.name.localeCompare(b.name)
            : a.type === "directory"
              ? -1
              : 1,
        ),
    };
  }
  async searchFiles(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        query: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(input);
    const loc = await this.location(
      agentId,
      { workspace: data.workspace, path: "." },
      false,
      { traverse: true },
    );
    assert(
      (await stat(loc.target)).isDirectory(),
      "not_directory",
      "Workspace is not a directory",
      400,
    );
    const ws = this.store
      .get<Agent>("agent", agentId)
      .workspaces.find((workspace) => workspace.path === loc.root)!;
    const found: { path: string; score: number }[] = [];
    let visits = 0;
    const walk = async (
      directory: string,
      relativePath: string,
      depth: number,
    ) => {
      if (depth > 16 || visits >= FILE_SEARCH_MAX_VISITS) return;
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (visits++ >= FILE_SEARCH_MAX_VISITS) return;
        if ([".git", "node_modules", "vendor"].includes(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        const path = join(relativePath, entry.name).split("\\").join("/");
        const access = decideBoth(ws, path, path).access;
        if (entry.isDirectory()) {
          if (access !== "none" || traversable(ws, path))
            await walk(resolve(directory, entry.name), path, depth + 1);
        } else if (entry.isFile() && access !== "none") {
          const score = subsequenceScore(data.query, path);
          if (score) found.push({ path, score });
        }
      }
    };
    await walk(loc.target, ".", 0);
    return found
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, FILE_SEARCH_MAX_RESULTS)
      .map(({ path }) => ({ path, name: basename(path), workspace: loc.root }));
  }
  async preview(agentId: string, input: unknown) {
    const loc = await this.location(agentId, input),
      info = await stat(loc.target);
    assert(info.isFile(), "not_file", "Path is not a regular file", 400);
    const file = await open(loc.target, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, 256_000));
      await file.read(buffer, 0, buffer.length, 0);
      const binary = buffer.includes(0);
      return {
        path: loc.relative,
        name: basename(loc.target),
        extension: extname(loc.target),
        size: info.size,
        truncated: info.size > buffer.length,
        binary,
        content: binary ? null : buffer.toString("utf8"),
      };
    } finally {
      await file.close();
    }
  }
  /** Read a bounded UTF-8 source file for the in-app editor, under folder access rules. */
  async readText(agentId: string, input: unknown) {
    const data = textFileSchema.parse(input);
    const loc = await this.location(agentId, data);
    const info = await stat(loc.target);
    assert(info.isFile(), "not_file", "Path is not a regular file", 400);
    assert(
      info.size <= TEXT_EDITOR_MAX_BYTES,
      "file_too_large",
      `Files over ${TEXT_EDITOR_MAX_BYTES / 1000} KB open read-only; use an external editor`,
      413,
    );
    const handle = await open(loc.target, "r");
    try {
      const bytes = await handle.readFile();
      assert(
        bytes.length <= TEXT_EDITOR_MAX_BYTES,
        "file_too_large",
        `Files over ${TEXT_EDITOR_MAX_BYTES / 1000} KB open read-only; use an external editor`,
        413,
      );
      assert(
        !bytes.includes(0),
        "binary_file",
        "Binary files cannot be edited",
        415,
      );
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AppError(
          415,
          "not_utf8",
          "This file is not valid UTF-8 text",
        );
      }
      return {
        path: loc.relative,
        content,
        hash: sha256(bytes),
        access: loc.access,
      };
    } finally {
      await handle.close();
    }
  }
  /**
   * Save a human editor change. Agent folder grants do not restrict the owner; workspace roots,
   * global filesystem denials, path safety, and the loaded-content hash are still enforced.
   */
  async saveText(agentId: string, input: unknown) {
    const data = saveTextSchema.parse(input);
    const loc = await this.location(
      agentId,
      { workspace: data.workspace, path: data.path },
      false,
    );
    const bytes = Buffer.from(data.content, "utf8");
    assert(
      bytes.length <= TEXT_EDITOR_MAX_BYTES && !bytes.includes(0),
      "invalid_text",
      "Text must be UTF-8 without NUL bytes and at most 256 KB",
      413,
    );
    const info = await stat(loc.target);
    assert(info.isFile(), "not_file", "Path is not a regular file", 400);
    assert(
      info.size <= TEXT_EDITOR_MAX_BYTES,
      "file_too_large",
      "Files over 256 KB cannot be saved in the in-app editor",
      413,
    );
    const handle = await open(loc.target, "r+");
    try {
      const previous = await handle.readFile();
      assert(
        !previous.includes(0),
        "binary_file",
        "Binary files cannot be edited",
        415,
      );
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(previous);
      } catch {
        throw new AppError(
          415,
          "not_utf8",
          "This file is not valid UTF-8 text",
        );
      }
      assert(
        sha256(previous) === data.expectedHash,
        "file_changed",
        "The file changed since it was opened. Reload it before saving.",
        409,
      );
      await handle.truncate(0);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        offset += result.bytesWritten;
      }
      await handle.truncate(bytes.length);
      return { path: loc.relative, hash: sha256(bytes), bytes: bytes.length };
    } finally {
      await handle.close();
    }
  }
  /** Create a new text file as the owner inside an attached workspace directory. */
  async createText(agentId: string, input: unknown) {
    const data = createTextSchema.parse(input);
    const requestedPath = data.path.split("\\").join("/");
    const name = basename(requestedPath);
    assert(
      name !== "." && name !== ".." && !name.includes("\0") && name !== ".git",
      "invalid_path",
      "Choose a file name inside the workspace",
      400,
    );
    const parentPath = dirname(requestedPath) || ".";
    const parent = await this.location(
      agentId,
      { workspace: data.workspace, path: parentPath },
      false,
    );
    assert(
      (await stat(parent.target)).isDirectory(),
      "not_directory",
      "The file's folder does not exist",
      400,
    );
    const target = resolve(parent.target, name);
    const relativePath = relative(parent.root, target).split("\\").join("/");
    filesystemPolicy(this.store).assertPath(target);
    const bytes = Buffer.from(data.content, "utf8");
    assert(
      bytes.length <= TEXT_EDITOR_MAX_BYTES,
      "invalid_text",
      "Text must be at most 256 KB",
      413,
    );
    assert(
      !bytes.includes(0),
      "invalid_text",
      "Text cannot contain NUL bytes",
      400,
    );
    const handle = await open(target, "wx", 0o666).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST")
          throw new AppError(
            409,
            "file_exists",
            "A file with that name already exists",
          );
        throw error;
      },
    );
    try {
      await handle.writeFile(bytes);
      return {
        path: relativePath,
        hash: sha256(bytes),
        bytes: bytes.length,
      };
    } finally {
      await handle.close();
    }
  }
  /**
   * Report AgentTeam work that currently reserves or is queued for this file. Paths on queued
   * work are conservative: tasks without declared paths are assumed to use the agent's folders.
   */
  async fileActivity(agentId: string, input: unknown) {
    const data = textFileSchema
      .extend({ create: z.boolean().optional() })
      .strict()
      .parse(input);
    let target: string;
    if (data.create) {
      const requestedPath = data.path.split("\\").join("/");
      const name = basename(requestedPath);
      assert(
        name !== "." &&
          name !== ".." &&
          !name.includes("\0") &&
          name !== ".git",
        "invalid_path",
        "Choose a file name inside the workspace",
        400,
      );
      const parentPath = dirname(requestedPath) || ".";
      const parent = await this.location(agentId, {
        workspace: data.workspace,
        path: parentPath,
      });
      assert(
        (await stat(parent.target)).isDirectory(),
        "not_directory",
        "The file's folder does not exist",
        400,
      );
      target = resolve(parent.target, name);
      filesystemPolicy(this.store).assertPath(target);
      const rel = relative(parent.root, target);
      assert(
        !/^\.\.[\\/]/.test(rel) && rel !== ".." && !isAbsolute(rel),
        "path_escape",
        "Path escapes the attached workspace",
        403,
      );
      assert(
        !rel.split(/[\\/]/).includes(".git"),
        "git_internal",
        "Direct access to Git internals is not supported",
        403,
      );
    } else {
      target = (
        await this.location(agentId, {
          workspace: data.workspace,
          path: data.path,
        })
      ).target;
    }

    const agents = new Map(
      this.store.list<Agent>("agent").map((a) => [a.id, a]),
    );
    const tasks = this.store.list<Task>("task");
    const seen = new Set<string>();
    const activities: {
      agentId: string;
      agentName: string;
      state: "active" | "queued";
      title: string;
    }[] = [];
    const add = (
      id: string,
      ownerId: string,
      state: "active" | "queued",
      title: string,
    ) => {
      const agent = agents.get(ownerId);
      if (!agent) return;
      const key = `${id}:${state}`;
      if (seen.has(key)) return;
      seen.add(key);
      activities.push({
        agentId: ownerId,
        agentName: agent.name,
        state,
        title,
      });
    };
    const taskPaths = (task: Task) =>
      task.resourcePaths?.length
        ? task.resourcePaths
        : (agents.get(task.agentId)?.workspaces.map((w) => w.path) ?? []);
    const overlapsTarget = (paths: string[]) =>
      paths.some((path) => overlaps(path, target));

    for (const lease of this.store.list<Lease>("lease")) {
      if (!overlapsTarget(lease.paths)) continue;
      const task = tasks.find((item) => item.id === lease.id);
      add(
        lease.id,
        lease.agentId,
        "active",
        task?.title ?? "Agent chat or file operation",
      );
    }
    for (const task of tasks) {
      if (task.status === "running" && overlapsTarget(taskPaths(task)))
        add(task.id, task.agentId, "active", task.title);
      if (task.status === "queued" && overlapsTarget(taskPaths(task)))
        add(task.id, task.agentId, "queued", task.title);
    }
    for (const request of this.store.list<{ id: string; agentId: string }>(
      "run-request",
    )) {
      const owner = agents.get(request.agentId);
      if (owner && overlapsTarget(owner.workspaces.map((w) => w.path)))
        add(request.id, request.agentId, "queued", "Queued chat");
    }
    activities.sort(
      (a, b) =>
        a.state.localeCompare(b.state) ||
        a.agentName.localeCompare(b.agentName),
    );
    return { path: data.path, activities: activities.slice(0, 20) };
  }
  private async git(root: string, args: string[]) {
    filesystemPolicy(this.store).assertConfinedExecution();
    try {
      return (
        await exec(
          "git",
          [
            "-C",
            root,
            ...SAFE_GIT_CONFIG,
            ...(await attachedRepoGitConfig(root)),
            ...args,
          ],
          {
            encoding: "utf8",
            maxBuffer: 2_000_000,
            timeout: 15_000,
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              GIT_LITERAL_PATHSPECS: "1",
              GIT_OPTIONAL_LOCKS: "0",
            },
          },
        )
      ).stdout;
    } catch (e) {
      const stderr = (e as { stderr?: string }).stderr?.trim() ?? "";
      if (/not a git repository/i.test(stderr))
        throw new AppError(
          400,
          "not_git_repository",
          "This folder is not inside a Git repository. Choose a repository folder or initialize Git from the Git view.",
        );
      throw new AppError(
        400,
        "git_error",
        stderr.slice(0, 1000) || "Git command failed",
      );
    }
  }
  private gitEnv() {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    };
  }
  /** Run Git but stop reading (and kill it) once `cap` bytes were produced. */
  private async gitCapped(root: string, args: string[], cap: number) {
    const repoConfig = await attachedRepoGitConfig(root);
    return new Promise<{ text: string; capped: boolean }>((done, fail) => {
      const child = spawn(
        "git",
        ["-C", root, ...SAFE_GIT_CONFIG, ...repoConfig, ...args],
        {
          env: this.gitEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const chunks: Buffer[] = [];
      let size = 0,
        capped = false,
        err = "";
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.on("data", (c: Buffer) => {
        if (capped) return;
        chunks.push(c);
        size += c.length;
        if (size > cap) {
          capped = true;
          child.kill();
        }
      });
      child.stderr.on("data", (c: Buffer) => (err = (err + c).slice(0, 1000)));
      child.on("error", () => {
        clearTimeout(timer);
        fail(new AppError(400, "git_error", "Git command failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (capped || code === 0)
          done({
            text: Buffer.concat(chunks).subarray(0, cap).toString("utf8"),
            capped,
          });
        else
          fail(
            new AppError(400, "git_error", err.trim() || "Git command failed"),
          );
      });
    });
  }
  /** Resolve a user-supplied revision to a commit id; never passes option-like input to Git. */
  async resolveRevision(root: string, rev: string, label: string) {
    const problem = revisionProblem(rev);
    assert(!problem, "invalid_revision", `${label}: ${problem}`, 400);
    try {
      return (
        await this.git(root, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${rev}^{commit}`,
        ])
      ).trim();
    } catch {
      throw new AppError(
        400,
        "invalid_revision",
        `${label}: "${rev}" is not a known branch, tag or commit`,
      );
    }
  }
  private async compareSpec(
    root: string,
    d: { base: string; head?: string; mergeBase: boolean },
  ) {
    const head = d.head?.trim() || "HEAD";
    const baseSha = await this.resolveRevision(root, d.base.trim(), "Base");
    const headSha = await this.resolveRevision(root, head, "Head");
    let from = baseSha,
      mergeBaseSha: string | null = null;
    if (d.mergeBase) {
      try {
        mergeBaseSha = (
          await this.git(root, ["merge-base", baseSha, headSha])
        ).trim();
      } catch {
        throw new AppError(
          400,
          "no_merge_base",
          `"${d.base}" and "${head}" share no common ancestor; compare directly instead`,
        );
      }
      from = mergeBaseSha;
    }
    return {
      base: d.base.trim(),
      head,
      mergeBase: d.mergeBase,
      baseSha,
      headSha,
      mergeBaseSha,
      from,
      to: headSha,
    };
  }
  async gitInfo(
    agentId: string,
    input: unknown,
    opts: { untrackedAll?: boolean } = {},
  ) {
    const loc = await this.location(agentId, input);
    const cwd = (await stat(loc.target)).isDirectory()
      ? loc.target
      : dirname(loc.target);
    const repo = (await this.git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const visible = await this.visibleInRepo(agentId, loc.root, repo);
    const [status, branch, branches, worktrees] = await Promise.all([
      this.git(cwd, [
        "status",
        "--porcelain=v1",
        "-z",
        ...(opts.untrackedAll ? ["--untracked-files=all"] : []),
        "--",
        loc.target,
      ]),
      this.git(cwd, ["branch", "--show-current"]),
      this.git(cwd, ["branch", "--format=%(refname:short)"]),
      this.git(cwd, ["worktree", "list", "--porcelain"]),
    ]);
    return {
      repository: repo,
      branch: branch.trim() || "(detached HEAD)",
      status: parseStatus(status).filter(
        (f) => visible(f.path) && (!f.from || visible(f.from)),
      ),
      branches: branches.trim().split("\n").filter(Boolean),
      worktrees: parseWorktrees(worktrees),
      canMutate:
        loc.access === "write" &&
        !loc.restricted &&
        (await realpath(repo)) === loc.root,
    };
  }
  async diff(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        path: z.string().default("."),
        staged: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    const loc = await this.location(agentId, {
      workspace: data.workspace,
      path: data.path,
    });
    const text = await this.git(loc.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      ...(data.staged ? ["--cached"] : []),
      "--",
      loc.relative,
    ]);
    // `git diff` prints repository-relative paths: resolve them against the repository top, not the
    // attachment (a subfolder attachment would otherwise match its rules against the wrong path).
    const repoTop = (
      await this.git(loc.root, ["rev-parse", "--show-toplevel"])
    ).trim();
    const visible = await this.visibleInRepo(agentId, loc.root, repoTop);
    return {
      diff: filterDiff(text, visible),
      staged: data.staged,
      path: loc.relative,
    };
  }
  /** Who else could have produced changes in this checkout; never claims more than the evidence. */
  private attribution(
    agentId: string,
    root: string,
    info: {
      repository: string;
      branch: string;
      worktrees: Record<string, string | boolean>[];
    },
  ) {
    const others = this.store
      .list<Agent>("agent")
      .filter(
        (a) =>
          a.id !== agentId &&
          a.workspaces.some(
            (w) => w.path === root || w.path === info.repository,
          ),
      )
      .map((a) => a.name);
    const main = info.worktrees[0]?.worktree;
    const linked = !!main && main !== info.repository;
    if (linked && !others.length)
      return {
        kind: "worktree" as const,
        linked,
        others,
        note: `Linked worktree on ${info.branch}, attached only to this agent in AgentTeam. Changes here are most likely this agent's, though editors or other tools outside AgentTeam may also write to it.`,
      };
    return {
      kind: "shared" as const,
      linked,
      others,
      note: others.length
        ? `Shared checkout also attached to ${others.join(", ")}. Changes cannot be attributed to one agent.`
        : "Main checkout. Changes may come from any agent, editor or command; they are not attributed to this agent.",
    };
  }
  private async reviewRefs(root: string, current: string) {
    let refs: string[] = [];
    try {
      refs = (
        await this.git(root, [
          "for-each-ref",
          "--format=%(refname:short)",
          "--sort=-committerdate",
          "refs/heads",
          "refs/remotes",
          "refs/tags",
        ])
      )
        .split("\n")
        .filter((r) => r && !/(^|\/)HEAD$/.test(r))
        .slice(0, 400);
    } catch {
      /* repository without commits has no refs */
    }
    const defaultBase =
      ["origin/main", "origin/master", "main", "master", "develop"].find(
        (c) => refs.includes(c) && c !== current,
      ) ?? "";
    return { refs, defaultBase };
  }
  async review(agentId: string, input: unknown): Promise<ReviewResult> {
    const data = z
      .object({
        workspace: z.string(),
        path: z.string().optional(),
        staged: z.boolean().default(false),
        base: z.string().max(200).optional(),
        head: z.string().max(200).optional(),
        mergeBase: z.boolean().default(true),
      })
      .strict()
      .parse(input);
    assert(
      !(data.base && data.staged),
      "invalid_scope",
      "Branch comparison cannot be combined with the staged view",
      400,
    );
    const loc = await this.location(agentId, { workspace: data.workspace });
    let info: Awaited<ReturnType<WorkspaceService["gitInfo"]>>;
    try {
      info = await this.gitInfo(
        agentId,
        { workspace: data.workspace },
        { untrackedAll: !data.base },
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "not_git_repository")
        throw error;
      return (await workspaceChanges(
        this.store,
        this.store.get<Agent>("agent", agentId),
        loc.root,
        data.path,
      )) as unknown as ReviewResult;
    }
    const attribution = this.attribution(agentId, loc.root, info);
    const compare = data.base
      ? await this.compareSpec(loc.root, { ...data, base: data.base })
      : null;
    let files: {
      status: string;
      path: string;
      from?: string;
      similarity?: number;
    }[];
    if (compare) {
      const names = await this.gitCapped(
        loc.root,
        [
          "-c",
          "core.quotePath=false",
          "diff",
          "--name-status",
          "-z",
          "-M",
          "--no-ext-diff",
          "--no-textconv",
          compare.from,
          compare.to,
          "--",
          loc.target,
        ],
        4_000_000,
      );
      const visible = await this.visibleInRepo(
        agentId,
        loc.root,
        info.repository,
      );
      files = parseNameStatus(names.text).filter(
        (f) => visible(f.path) && (!f.from || visible(f.from)),
      );
    } else
      files = info.status.filter((f) =>
        data.staged
          ? f.status[0] !== " " && f.status[0] !== "?"
          : f.status[1] !== " ",
      );
    const filesTruncated = files.length > REVIEW_MAX_FILES;
    if (filesTruncated) files = files.slice(0, REVIEW_MAX_FILES);
    const common = {
      ...info,
      files,
      filesTruncated,
      compare,
      attribution,
      staged: data.staged,
    };
    if (data.path === undefined)
      return {
        ...common,
        diff: "",
        meta: null,
        ...(await this.reviewRefs(loc.root, info.branch)),
      };
    const file = files.find((f) => f.path === data.path);
    assert(
      file,
      "change_missing",
      "This change is no longer in this view; refresh the review",
      409,
    );
    const target = resolve(info.repository, file.path);
    const rel = relative(loc.root, target);
    assert(
      rel !== ".." && !/^\.\.[\\/]/.test(rel) && !isAbsolute(rel),
      "path_escape",
      "Change is outside the attached workspace",
      403,
    );
    if (file.status === "??") {
      let preview;
      try {
        preview = await this.preview(agentId, {
          workspace: loc.root,
          path: rel,
        });
      } catch (e) {
        const msg =
          e instanceof AppError ? e.message : "The file could not be read";
        return {
          ...common,
          binary: false,
          truncated: false,
          diff: "",
          unreadable: `Untracked path cannot be previewed: ${msg}`,
          meta: null,
        };
      }
      const content = preview.content ?? "";
      const lines = content ? content.replace(/\n$/, "").split("\n") : [];
      const raw = preview.binary
        ? "Binary file (untracked)"
        : lines.length
          ? `@@ -0,0 +1,${lines.length} @@\n` +
            lines.map((line) => "+" + line).join("\n")
          : "Empty untracked file";
      const capped = preview.binary
        ? { text: raw, truncated: false, reason: undefined }
        : capDiff(raw, false);
      return {
        ...common,
        binary: preview.binary,
        truncated: preview.truncated || capped.truncated,
        truncatedReason: preview.truncated
          ? "Large file: showing only the first 256 KB"
          : capped.reason,
        diff: capped.text,
        meta: {
          kind: "added",
          binary: preview.binary,
          submodule: false,
          noHunks: !lines.length,
        } as DiffMeta,
      };
    }
    // Use validated entries as literal pathspecs: deleted paths need not exist. Renames need both sides.
    const specs = [
      target,
      ...(file.from ? [resolve(info.repository, file.from)] : []),
    ];
    const out = await this.gitCapped(
      loc.root,
      [
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--unified=3",
        "-M",
        ...(compare
          ? [compare.from, compare.to]
          : data.staged
            ? ["--cached"]
            : []),
        "--",
        ...specs,
      ],
      DIFF_MAX_BYTES,
    );
    const capped = capDiff(out.text, out.capped);
    const meta = parseDiffMeta(capped.text);
    return {
      ...common,
      diff: capped.text,
      binary: meta.binary,
      truncated: capped.truncated,
      truncatedReason: capped.reason,
      meta,
    };
  }
  async resetChanges(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const loc = await this.location(agentId, { workspace });
    return resetWorkspaceBaseline(
      this.store,
      this.store.get<Agent>("agent", agentId),
      loc.root,
    );
  }
  async mutateGit(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        action: z.enum(["stage", "unstage", "commit"]),
        paths: z.array(z.string()).default([]),
        renames: z
          .array(z.object({ from: z.string(), to: z.string() }).strict())
          .optional(),
        message: z.string().trim().min(1).max(10000).optional(),
      })
      .strict()
      .parse(input);
    const loc = await this.location(
      agentId,
      { workspace: data.workspace, path: "." },
      true,
    );
    const repo = await realpath(
      (await this.git(loc.root, ["rev-parse", "--show-toplevel"])).trim(),
    );
    assert(
      repo === loc.root,
      "repo_root_required",
      "Attach the repository root with write access for Git mutations",
      403,
    );
    // Commit rewrites whatever is staged, including paths the rules exclude; staging checks each path.
    assert(
      !(loc.restricted && data.action === "commit"),
      "access_rules_git",
      "This attachment has exclusions or explicit-only rules, so committing the whole index is refused",
      403,
    );
    if (data.action !== "commit")
      await this.assertPathsWritable(agentId, loc.root, [
        ...data.paths,
        ...(data.renames ?? []).flatMap((r) => [r.from, r.to]),
      ]);
    return withRepoLockFor(repo, () =>
      this.mutateLocked(agentId, data, loc, repo),
    );
  }
  private async mutateLocked(
    agentId: string,
    data: {
      action: "stage" | "unstage" | "commit";
      paths: string[];
      renames?: { from: string; to: string }[];
      message?: string;
    },
    loc: { root: string },
    repo: string,
  ) {
    const coordinator = new ResourceCoordinator(this.store),
      leaseId = "git:" + randomUUID();
    coordinator.acquire(leaseId, agentId, null);
    try {
      if (data.action === "commit") {
        assert(
          data.message,
          "message_required",
          "Commit message required",
          400,
        );
        await this.git(repo, ["commit", "-m", data.message]);
      } else {
        await applyStaging((args) => this.git(repo, args), repo, {
          action: data.action,
          paths: data.paths,
          renames: data.renames,
        });
      }
      this.store.emit("workspace.git", agentId, {
        action: data.action,
        workspace: loc.root,
        paths: data.paths,
      });
      return { status: "ok", action: data.action };
    } finally {
      coordinator.release(leaseId);
    }
  }
  settings() {
    try {
      return this.store.get<{
        id: string;
        defaultEditor: "sublime" | "vscode" | "system";
      }>("settings", "user");
    } catch {
      return { id: "user", defaultEditor: "sublime" as const };
    }
  }
  async sublimeEditorConfig(agentId: string, input: unknown) {
    const data = z.object({ workspace: z.string() }).strict().parse(input);
    const loc = await this.location(
      agentId,
      { workspace: data.workspace, path: "." },
      false,
      { traverse: true },
    );
    return loadSublimeEditorConfig(loc.root);
  }
  setEditor(input: unknown) {
    const data = z
      .object({ defaultEditor: z.enum(["sublime", "vscode", "system"]) })
      .strict()
      .parse(input);
    return this.store.put("settings", { id: "user", ...data });
  }
  async openExternal(agentId: string, input: unknown, execute = false) {
    if (execute) filesystemPolicy(this.store).assertConfinedExecution();
    const data = z
      .object({
        workspace: z.string(),
        path: z.string().default("."),
        application: z
          .enum(["sublime", "vscode", "system", "finder"])
          .optional(),
      })
      .strict()
      .parse(input);
    const loc = await this.location(agentId, {
      workspace: data.workspace,
      path: data.path,
    });
    const app = data.application ?? this.settings().defaultEditor;
    const { executable, args } = openCommand(process.platform, app, loc.target);
    if (execute) {
      try {
        await exec(executable, args, { timeout: 10_000 });
      } catch {
        throw new AppError(
          400,
          "app_unavailable",
          "The selected application could not be opened",
        );
      }
      this.store.emit("workspace.opened", agentId, {
        application: app,
        path: loc.target,
      });
    }
    return { executable, args, executed: execute, application: app };
  }
}
type ReviewResult = Awaited<ReturnType<WorkspaceService["gitInfo"]>> & {
  source?: "git" | "folder";
  baselineAt?: string;
  files: { status: string; path: string; from?: string; similarity?: number }[];
  filesTruncated: boolean;
  compare: {
    base: string;
    head: string;
    mergeBase: boolean;
    baseSha: string;
    headSha: string;
    mergeBaseSha: string | null;
  } | null;
  attribution: {
    kind: "worktree" | "shared";
    linked: boolean;
    others: string[];
    note: string;
  };
  staged: boolean;
  diff: string;
  meta: DiffMeta | null;
  binary?: boolean;
  truncated?: boolean;
  truncatedReason?: string;
  unreadable?: string;
  refs?: string[];
  defaultBase?: string;
};
export function parseStatus(raw: string) {
  const records = raw.split("\0");
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    const status = line.slice(0, 2),
      path = line.slice(3);
    const from = /[RC]/.test(status) ? records[++i] : undefined;
    files.push({ status, path, ...(from ? { from } : {}) });
  }
  return files;
}
export function parseWorktrees(raw: string) {
  return raw
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) =>
      Object.fromEntries(
        block.split("\n").map((line) => {
          const i = line.indexOf(" ");
          return i === -1
            ? [line, true]
            : [line.slice(0, i), line.slice(i + 1)];
        }),
      ),
    );
}
