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
import { applyStaging } from "./git-stage.ts";
import { randomUUID } from "node:crypto";
import { ResourceCoordinator } from "./resources.ts";
import { Store } from "./store.ts";
import { AppError, assert, type Agent } from "./model.ts";
import {
  DIFF_MAX_BYTES,
  type DiffMeta,
  REVIEW_MAX_FILES,
  capDiff,
  parseDiffMeta,
  parseNameStatus,
  revisionProblem,
} from "./diff.ts";
const exec = promisify(execFile);
const requestSchema = z
  .object({ workspace: z.string(), path: z.string().default(".") })
  .strict();
export class WorkspaceService {
  store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async location(agentId: string, input: unknown, write = false) {
    const data = requestSchema.parse(input);
    const agent = this.store.get<Agent>("agent", agentId);
    const ws = agent.workspaces.find((w) => w.path === data.workspace);
    assert(
      ws,
      "workspace_denied",
      "Directory is not attached to this agent",
      403,
    );
    assert(
      !write || ws.access === "write",
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
    return { root, target, relative: rel || ".", access: ws.access };
  }
  async browse(agentId: string, input: unknown) {
    const loc = await this.location(agentId, input);
    assert(
      (await stat(loc.target)).isDirectory(),
      "not_directory",
      "Path is not a directory",
      400,
    );
    const entries = await readdir(loc.target, { withFileTypes: true });
    return {
      ...loc,
      entries: entries
        .filter((e) => e.name !== ".git")
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
  private async git(root: string, args: string[]) {
    try {
      return (
        await exec("git", ["-C", root, ...args], {
          encoding: "utf8",
          maxBuffer: 2_000_000,
          timeout: 15_000,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_LITERAL_PATHSPECS: "1",
            GIT_OPTIONAL_LOCKS: "0",
          },
        })
      ).stdout;
    } catch (e) {
      throw new AppError(
        400,
        "git_error",
        (e as { stderr?: string }).stderr?.trim().slice(0, 1000) ||
          "Git command failed",
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
  private gitCapped(root: string, args: string[], cap: number) {
    return new Promise<{ text: string; capped: boolean }>((done, fail) => {
      const child = spawn("git", ["-C", root, ...args], {
        env: this.gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      status: parseStatus(status),
      branches: branches.trim().split("\n").filter(Boolean),
      worktrees: parseWorktrees(worktrees),
      canMutate: loc.access === "write" && (await realpath(repo)) === loc.root,
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
    return { diff: text, staged: data.staged, path: loc.relative };
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
    const info = await this.gitInfo(
      agentId,
      { workspace: data.workspace },
      { untrackedAll: !data.base },
    );
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
      files = parseNameStatus(names.text);
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
        await this.git(repo, [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          data.message,
        ]);
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
  setEditor(input: unknown) {
    const data = z
      .object({ defaultEditor: z.enum(["sublime", "vscode", "system"]) })
      .strict()
      .parse(input);
    return this.store.put("settings", { id: "user", ...data });
  }
  async openExternal(agentId: string, input: unknown, execute = false) {
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
