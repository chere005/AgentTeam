import { execFile } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { devNull } from "node:os";
import { relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Session,
  type Task,
} from "./model.ts";
import { ResourceCoordinator, overlaps } from "./resources.ts";
import type { Store } from "./store.ts";
import type { WorkspaceService } from "./workspaces.ts";
import { withRepoLockFor as withRepoLock } from "./repo-lock.ts";
import { launch, type OpenPlan } from "./editors.ts";
import { applyStaging, resolveGitPath } from "./git-stage.ts";
import {
  LOG_FORMAT,
  classifyGitFailure,
  compareUrl,
  describeConflict,
  isBrowserUrl,
  isConflictStatus,
  parseConflictMarkers,
  parseLog,
  parseRemoteUrl,
  repositoryUrl,
  type GitFailure,
} from "./git-remote.ts";
import { parseStatus } from "./workspaces.ts";

/**
 * Branch, remote, history, pull-request-link and conflict workflows.
 *
 * Safety rules that this module enforces (callers cannot opt out):
 * - every Git invocation runs with hooks disabled (`core.hooksPath` = null device), signing off,
 *   fsmonitor off and no askpass/interactive credential prompts; network operations use the
 *   user's own SSH command (environment, global or system config), never a repository-local
 *   `core.sshCommand`;
 * - no force push: pushes use an explicit `refs/heads/x:refs/heads/<target>` refspec and never
 *   `--force`; a target branch whose name differs from the local branch needs explicit
 *   confirmation naming that target;
 * - pull is fast-forward-only (`--ff-only --no-rebase`) unless the caller names merge/rebase and
 *   confirms;
 * - an attachment that is a subfolder of the repository only sees that subfolder: status, log,
 *   commit details and conflicts are limited to it, and branch subjects are hidden;
 * - switching branches (and other working-tree changes) needs explicit confirmation when a run is
 *   active or tracked files are dirty, and never uses `--force`/`--discard-changes`;
 * - nothing here reads or writes `.git` through the file API and no network API is called: the PR
 *   link is a URL the user opens in a browser;
 * - no automatic conflict resolution: "resolve" only stages what the user already edited.
 */
const exec = promisify(execFile);
const NETWORK_TIMEOUT = 120_000;
type Result = { ok: boolean; out: string; err: string };

/** Quote one argument for the POSIX shell Git uses to run GIT_SSH_COMMAND. */
const shQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
/**
 * The SSH command for network operations. GIT_SSH_COMMAND outranks every `core.sshCommand`, so
 * setting it means a repository-local value (attacker-controlled in a cloned repo) is never run.
 * The user's own choice is kept: their environment, then global/system config, then GIT_SSH;
 * otherwise plain ssh in BatchMode so it can never wait for a password prompt.
 */
async function sshCommand(cwd: string) {
  if (process.env.GIT_SSH_COMMAND) return process.env.GIT_SSH_COMMAND;
  for (const scope of ["--global", "--system"]) {
    try {
      const { stdout } = await exec(
        "git",
        ["-C", cwd, "config", scope, "--includes", "--get", "core.sshCommand"],
        { encoding: "utf8", timeout: 10_000, env: baseEnv() },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* not set in this scope */
    }
  }
  if (process.env.GIT_SSH) return shQuote(process.env.GIT_SSH);
  return "ssh -o BatchMode=yes";
}
function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
    // Read-only commands (status after a watched file change) must not take the optional
    // index.lock refresh: it made the user's own concurrent `git switch`/`commit` fail with
    // "index.lock: File exists". Mutating commands still take their required locks.
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "never",
    // No askpass helper (Git's or ssh's) may pop up or run.
    GIT_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    // Stable English messages so failures can be classified.
    LC_ALL: "C",
    LANGUAGE: "C",
  };
}
/** Environment for every Git invocation (exported for tests). */
export async function gitEnvironment(cwd: string, network: boolean) {
  const env = baseEnv();
  if (network) env.GIT_SSH_COMMAND = await sshCommand(cwd);
  return env;
}
/** Options every invocation carries: no hooks, signing, fsmonitor or interactive credentials. */
export const SAFE_GIT_CONFIG = [
  "-c",
  "protocol.ext.allow=never",
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.askPass=",
  "-c",
  "credential.interactive=never",
];
async function git(
  cwd: string,
  args: string[],
  o: { network?: boolean; timeout?: number } = {},
): Promise<Result> {
  const prefix = ["-C", cwd, ...SAFE_GIT_CONFIG];
  try {
    const r = await exec("git", [...prefix, ...args], {
      encoding: "utf8",
      maxBuffer: 8_000_000,
      timeout: o.timeout ?? (o.network ? NETWORK_TIMEOUT : 30_000),
      env: await gitEnvironment(cwd, !!o.network),
    });
    return { ok: true, out: r.stdout, err: r.stderr };
  } catch (e: any) {
    if (e.code === "ENOENT")
      throw new AppError(400, "git_unavailable", "Git is not installed");
    return {
      ok: false,
      out: String(e.stdout ?? ""),
      err: e.killed
        ? "Timed out waiting for Git (the remote may be unreachable)"
        : String(e.stderr || e.message || ""),
    };
  }
}
async function must(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (!r.ok)
    throw new AppError(
      400,
      "git_error",
      r.err.trim().slice(0, 1000) || "Git command failed",
    );
  return r.out;
}

const branchName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) => !v.startsWith("-") && !v.startsWith("@") && !/[\0\s]/.test(v),
    {
      message: "Invalid branch name",
    },
  );
const common = { workspace: z.string() };
/** Repository-relative POSIX path of the attached folder ("" when it is the repository root). */
export function attachmentScope(repo: string, root: string) {
  const rel = relative(repo, root);
  return rel.split(sep).join("/");
}
/** Pathspec arguments limiting a command to the attachment (none for the repository root). */
const scoped = (scope: string) => (scope ? [scope] : []);
const inScope = (scope: string, path: string) =>
  !scope || path === scope || path.startsWith(scope + "/");
const flag = (v?: boolean) => v === true;

export type FailureResult = GitFailure & { raw: string };
export type ActionResult = {
  action: string;
  ok: boolean;
  summary: string;
  failure?: FailureResult;
  [key: string]: unknown;
};

export class GitWorkflow {
  store: Store;
  ws: WorkspaceService;
  openUrl: (url: string) => Promise<void>;
  constructor(
    store: Store,
    ws: WorkspaceService,
    options: { openUrl?: (url: string) => Promise<void> } = {},
  ) {
    this.store = store;
    this.ws = ws;
    this.openUrl = options.openUrl ?? systemOpenUrl;
  }

  // ---- shared plumbing ----------------------------------------------------
  private async context(
    agentId: string,
    workspace: string,
    write: boolean,
    allowRestricted = false,
  ) {
    const loc = await this.ws.location(
      agentId,
      { workspace, path: "." },
      write,
    );
    // Whole-tree Git changes would touch paths the attachment's rules exclude or make read-only.
    if (write && loc.restricted && !allowRestricted)
      throw new AppError(
        403,
        "access_rules_git",
        "This attachment has exclusions or explicit-only rules, so Git actions that change the whole working tree are refused. Stage individual allowed paths instead, or remove the rules.",
      );
    let top: string;
    try {
      top = await realpath(
        (await must(loc.root, ["rev-parse", "--show-toplevel"])).trim(),
      );
    } catch (e) {
      throw new AppError(
        400,
        "not_a_repository",
        "This folder is not a Git repository",
      );
    }
    if (write)
      assert(
        top === loc.root,
        "repo_root_required",
        "Attach the repository root with write access for Git mutations",
        403,
      );
    return { loc, repo: top, scope: attachmentScope(top, loc.root) };
  }
  /** Why working-tree changes would race with AgentTeam work, or null. */
  activeRun(agentId: string, root: string): string | null {
    const agents = this.store
      .list<Agent>("agent")
      .filter((a) => a.workspaces.some((w) => overlaps(w.path, root)));
    const ids = new Set([agentId, ...agents.map((a) => a.id)]);
    const task = this.store
      .list<Task>("task")
      .find((t) => ids.has(t.agentId) && t.status === "running");
    const session = this.store
      .list<Session>("session")
      .find((s) => ids.has(s.agentId) && s.state === "running");
    if (task) {
      const name = this.store
        .list<Agent>("agent")
        .find((a) => a.id === task.agentId)?.name;
      return `${name ?? "An agent"} is running "${task.title}" in this folder`;
    }
    if (session) {
      const name = this.store
        .list<Agent>("agent")
        .find((a) => a.id === session.agentId)?.name;
      return `${name ?? "An agent"} has an active conversation run in this folder`;
    }
    return null;
  }
  private requireIdle(agentId: string, root: string, confirm: boolean) {
    const busy = this.activeRun(agentId, root);
    assert(
      !busy || confirm,
      "run_active",
      `${busy}. Wait for it to finish, or confirm to change the working tree under it.`,
      409,
    );
  }
  /** Serialize with other Git metadata work and hold the same folder lease as commit/stage. */
  private async mutate<T>(
    agentId: string,
    repo: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return withRepoLock(repo, async () => {
      const coordinator = new ResourceCoordinator(this.store),
        leaseId = "git:" + randomUUID();
      coordinator.acquire(leaseId, agentId, null);
      try {
        return await fn();
      } finally {
        coordinator.release(leaseId);
      }
    });
  }
  private emit(agentId: string, action: string, root: string, extra = {}) {
    this.store.emit("workspace.git", agentId, {
      action,
      workspace: root,
      ...extra,
    });
  }
  private fail(action: string, r: Result, extra = {}): ActionResult {
    const raw = (r.err || r.out).trim().slice(0, 2000);
    const failure = classifyGitFailure(raw);
    return {
      action,
      ok: false,
      summary: failure.message,
      failure: { ...failure, raw },
      ...extra,
    };
  }
  private async operation(repo: string) {
    for (const [name, op] of [
      ["MERGE_HEAD", "merge"],
      ["rebase-merge", "rebase"],
      ["rebase-apply", "rebase"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      const p = (await git(repo, ["rev-parse", "--git-path", name])).out.trim();
      if (!p) continue;
      try {
        await access(resolve(repo, p));
        return op;
      } catch {
        /* not in progress */
      }
    }
    return "none" as const;
  }
  /** The configured upstream of `branch` as {remote, ref, branch}, or null when it is not pushable. */
  private async pushTarget(repo: string, branch: string, remotes: string[]) {
    const remote = (
      await git(repo, ["config", "--get", `branch.${branch}.remote`])
    ).out.trim();
    const ref = (
      await git(repo, ["config", "--get", `branch.${branch}.merge`])
    ).out.trim();
    // A merge ref that is not a branch (or a '.' local remote) is not pushed blindly.
    if (!ref.startsWith("refs/heads/") || !remotes.includes(remote))
      return null;
    return { remote, ref, branch: ref.slice("refs/heads/".length) };
  }
  private async remotes(repo: string) {
    const names = (await must(repo, ["remote"])).split("\n").filter(Boolean);
    const out = [];
    for (const name of names) {
      const r = await git(repo, ["remote", "get-url", "--", name]);
      const url = r.ok ? r.out.trim() : "";
      const info = parseRemoteUrl(url);
      out.push({
        name,
        // Credentials embedded in a URL are never returned.
        display: info?.display ?? (url ? "(local or custom remote)" : ""),
        provider: info?.provider ?? "unknown",
        info,
      });
    }
    return out;
  }

  // ---- state & branches ---------------------------------------------------
  /** Public state: also answers for folders that are not repositories (offering init). */
  async state(
    agentId: string,
    input: unknown,
  ): Promise<
    Awaited<ReturnType<GitWorkflow["repoState"]>> & {
      repository: string | null;
    }
  > {
    const data = z.object(common).strict().parse(input);
    const loc = await this.ws.location(agentId, {
      workspace: data.workspace,
      path: ".",
    });
    const probe = await git(loc.root, ["rev-parse", "--show-toplevel"]);
    if (!probe.ok)
      // Not a repository: only these fields are meaningful (the UI offers git init).
      return {
        repository: null,
        canInit: loc.access === "write",
        message: "This folder is not a Git repository.",
      } as never;
    return this.repoState(agentId, loc, await realpath(probe.out.trim()));
  }
  private async repoState(
    agentId: string,
    loc: { root: string; access: string },
    repo: string,
  ) {
    const branchRaw = await git(repo, [
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    const head = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
    const upstream = await git(repo, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    let ahead: number | null = null,
      behind: number | null = null;
    if (upstream.ok) {
      const c = await git(repo, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{u}",
      ]);
      if (c.ok) {
        const [a, b] = c.out.trim().split(/\s+/).map(Number);
        ahead = a;
        behind = b;
      }
    }
    const scope = attachmentScope(repo, loc.root);
    // A subfolder attachment only counts its own files; excluded paths are not counted or named.
    const visible = await this.ws.visibleInRepo(agentId, loc.root, repo);
    const status = parseStatus(
      (
        await git(repo, [
          "status",
          "--porcelain=v1",
          "-z",
          "--",
          ...scoped(scope),
        ])
      ).out,
    ).filter((f) => visible(f.path));
    const conflicted = status.filter((f) => isConflictStatus(f.status)).length;
    const operation = await this.operation(repo);
    const remotesFull = await this.remotes(repo);
    const remotes = remotesFull.map(({ info, ...r }) => r);
    const branchName_ = branchRaw.ok ? branchRaw.out.trim() : null;
    const target =
      upstream.ok && branchName_
        ? await this.pushTarget(
            repo,
            branchName_,
            remotesFull.map((r) => r.name),
          )
        : null;
    return {
      repository: repo,
      branch: branchName_,
      detached: !branchRaw.ok,
      head: head.ok ? head.out.trim() : null,
      unborn: !head.ok,
      upstream: upstream.ok ? upstream.out.trim() : null,
      /** Where a plain push goes; `matches` is false when the remote branch has another name. */
      pushTarget: target
        ? {
            remote: target.remote,
            branch: target.branch,
            matches: target.branch === branchName_,
          }
        : null,
      /** Repository-relative folder this attachment is limited to ("" for the whole repository). */
      scope,
      ahead,
      behind,
      tracked: status.filter(
        (f) => f.status !== "??" && !isConflictStatus(f.status),
      ).length,
      untracked: status.filter((f) => f.status === "??").length,
      conflicted,
      operation,
      remotes,
      activeRun: this.activeRun(agentId, loc.root),
      canMutate: loc.access === "write" && repo === loc.root,
      canInit: false,
      message: undefined as string | undefined,
    };
  }

  async branches(agentId: string, input: unknown) {
    const data = z.object(common).strict().parse(input);
    const { repo, scope } = await this.context(agentId, data.workspace, false);
    const fmt = [
      "%(refname)",
      "%(refname:short)",
      "%(objectname:short)",
      "%(upstream:short)",
      "%(upstream:track)",
      "%(HEAD)",
      "%(committerdate:iso-strict)",
      "%(subject)",
    ].join("%00");
    const list = async (ref: string) =>
      (
        await git(repo, [
          "for-each-ref",
          "--count=300",
          "--sort=-committerdate",
          `--format=${fmt}%1e`,
          ref,
        ])
      ).out
        .split("\x1e")
        .map((r) => r.replace(/^\n/, ""))
        .filter((r) => r)
        .map((r) => {
          const [ref, name, sha, upstream, track, head, date, subject] =
            r.split("\0");
          const ahead = /ahead (\d+)/.exec(track)?.[1],
            behind = /behind (\d+)/.exec(track)?.[1];
          return {
            ref,
            name,
            sha,
            upstream: upstream || null,
            gone: /gone/.test(track),
            ahead: ahead ? +ahead : 0,
            behind: behind ? +behind : 0,
            current: head === "*",
            date,
            // Tip commit subjects describe history outside a subfolder attachment.
            subject: scope ? "" : subject,
          };
        });
    const local = await list("refs/heads");
    const remote = (await list("refs/remotes")).filter(
      (b) => !/\/HEAD$/.test(b.name),
    );
    return {
      local,
      remote,
      current: local.find((b) => b.current)?.name ?? null,
      defaultBase: await this.defaultBase(
        repo,
        local.map((b) => b.name),
        remote.map((b) => b.name),
      ),
    };
  }
  private async defaultBase(repo: string, local: string[], remote: string[]) {
    const head = await git(repo, [
      "symbolic-ref",
      "-q",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    if (head.ok && remote.includes(head.out.trim())) return head.out.trim();
    return (
      ["origin/main", "origin/master", "main", "master", "develop"].find(
        (c) => remote.includes(c) || local.includes(c),
      ) ?? null
    );
  }

  async switchBranch(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        branch: branchName,
        create: z.boolean().optional(),
        base: z.string().max(200).optional(),
        confirmDirty: z.boolean().optional(),
        confirmActiveRun: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, true);
    return this.mutate(agentId, repo, async () => {
      const st = await this.repoState(agentId, loc, repo);
      assert(
        st.operation === "none",
        "operation_in_progress",
        `A ${st.operation} is in progress. Finish or abort it before switching branches.`,
        409,
      );
      this.requireIdle(agentId, loc.root, flag(data.confirmActiveRun));
      assert(
        !st.tracked || flag(data.confirmDirty),
        "dirty_tree",
        `${st.tracked} tracked file(s) have uncommitted changes${st.untracked ? ` (and ${st.untracked} untracked)` : ""}. Confirm to carry them to the new branch; Git will refuse if they would be overwritten.`,
        409,
      );
      const exists = (
        await git(repo, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${data.branch}`,
        ])
      ).ok;
      let args: string[];
      let created = false;
      if (data.create) {
        assert(
          !exists,
          "branch_exists",
          `Branch "${data.branch}" already exists`,
          409,
        );
        const valid = await git(repo, [
          "check-ref-format",
          "--branch",
          data.branch,
        ]);
        assert(valid.ok, "invalid_branch", "Invalid branch name", 400);
        const start = data.base?.trim()
          ? await this.ws.resolveRevision(repo, data.base.trim(), "Base")
          : "HEAD";
        args = ["switch", "-c", data.branch, start];
        created = true;
      } else if (exists) args = ["switch", data.branch];
      else {
        const remote = (
          await git(repo, [
            "for-each-ref",
            "--format=%(refname:short)",
            `refs/remotes/*/${data.branch}`,
          ])
        ).out
          .split("\n")
          .filter(Boolean);
        assert(
          remote.length > 0,
          "branch_not_found",
          `No branch named "${data.branch}"`,
          404,
        );
        assert(
          remote.length === 1,
          "branch_ambiguous",
          `"${data.branch}" exists on several remotes (${remote.join(", ")}); choose one`,
          409,
        );
        args = ["switch", "--track", "-c", data.branch, remote[0]];
        created = true;
      }
      const r = await git(repo, args);
      if (!r.ok) return this.fail("switch", r, { branch: data.branch });
      this.emit(agentId, "switch", loc.root, { branch: data.branch });
      return {
        action: "switch",
        ok: true,
        summary: created
          ? `Created and switched to ${data.branch}`
          : `Switched to ${data.branch}`,
        branch: data.branch,
        created,
        state: await this.repoState(agentId, loc, repo),
      };
    });
  }

  // ---- network actions ----------------------------------------------------
  async fetch(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({ ...common, remote: z.string().max(200).optional() })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, false);
    const remotes = (await this.remotes(repo)).map((r) => r.name);
    if (!remotes.length)
      return this.fail("fetch", {
        ok: false,
        out: "",
        err: "No remote repository specified",
      });
    if (data.remote)
      assert(
        remotes.includes(data.remote),
        "unknown_remote",
        `Unknown remote "${data.remote}"`,
        400,
      );
    // Fetch only updates remote-tracking refs, never the working tree.
    return withRepoLock(repo, async () => {
      const r = await git(
        repo,
        [
          "fetch",
          "--prune",
          ...(data.remote ? ["--", data.remote] : ["--all"]),
        ],
        { network: true },
      );
      if (!r.ok) return this.fail("fetch", r, { remote: data.remote ?? "all" });
      const text = r.err.trim();
      this.emit(agentId, "fetch", loc.root, { remote: data.remote ?? "all" });
      return {
        action: "fetch",
        ok: true,
        summary: text
          ? "Fetched new data from " + (data.remote ?? "all remotes")
          : "Already up to date",
        detail: text.slice(0, 2000),
        state: await this.repoState(agentId, loc, repo),
      };
    });
  }

  async pull(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        mode: z.enum(["ff-only", "merge", "rebase"]).default("ff-only"),
        /** Required for merge/rebase: the caller has deliberately chosen to create merge/rebased commits. */
        confirmMode: z.boolean().optional(),
        confirmActiveRun: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, true);
    assert(
      data.mode === "ff-only" || flag(data.confirmMode),
      "mode_confirmation_required",
      `Pulling with ${data.mode} can create merge commits or rewrite local commits. Confirm the mode to continue.`,
      409,
    );
    return this.mutate(agentId, repo, async () => {
      const st = await this.repoState(agentId, loc, repo);
      assert(
        st.operation === "none",
        "operation_in_progress",
        `A ${st.operation} is in progress. Finish or abort it first.`,
        409,
      );
      if (st.detached || st.unborn)
        return this.fail("pull", {
          ok: false,
          out: "",
          err: "You are not on a branch with commits",
        });
      if (!st.upstream)
        return this.fail("pull", {
          ok: false,
          out: "",
          err: "There is no tracking information for the current branch",
        });
      this.requireIdle(agentId, loc.root, flag(data.confirmActiveRun));
      const before = st.head;
      const r = await git(
        repo,
        [
          "pull",
          "--no-edit",
          // --no-rebase with --ff-only: a user/repo `pull.rebase` setting cannot turn it into a rebase.
          ...(data.mode === "ff-only"
            ? ["--ff-only", "--no-rebase"]
            : data.mode === "rebase"
              ? ["--rebase"]
              : ["--no-rebase"]),
        ],
        { network: true },
      );
      const after = await this.repoState(agentId, loc, repo);
      if (!r.ok) return this.fail("pull", r, { mode: data.mode, state: after });
      this.emit(agentId, "pull", loc.root, { mode: data.mode });
      return {
        action: "pull",
        ok: true,
        mode: data.mode,
        summary:
          before === after.head
            ? "Already up to date"
            : `Updated ${st.branch} from ${st.upstream} (${data.mode})`,
        state: after,
      };
    });
  }

  async push(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        remote: z.string().max(200).optional(),
        setUpstream: z.boolean().optional(),
        /** Required when the upstream branch name differs from the local one: that target's name. */
        confirmTarget: z.string().max(200).optional(),
      })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, true);
    return withRepoLock(repo, async () => {
      const st = await this.repoState(agentId, loc, repo);
      if (st.detached || st.unborn || !st.branch)
        return this.fail("push", {
          ok: false,
          out: "",
          err: "You are not on a branch with commits",
        });
      const remotes = (await this.remotes(repo)).map((r) => r.name);
      if (!remotes.length)
        return this.fail("push", {
          ok: false,
          out: "",
          err: "No configured push destination",
        });
      const branch = st.branch;
      let remote: string,
        ref: string,
        setUpstream = false;
      if (st.upstream) {
        const target = await this.pushTarget(repo, branch, remotes);
        if (!target)
          return this.fail("push", {
            ok: false,
            out: "",
            err: "No configured push destination",
          });
        remote = target.remote;
        ref = target.ref;
        // e.g. a feature branch created from origin/main tracks main: a plain push would publish
        // the feature commits onto the remote main. Only an explicit confirmation naming the
        // target branch allows that.
        assert(
          target.branch === branch || data.confirmTarget === target.branch,
          "push_target_confirmation",
          `"${branch}" tracks "${remote}/${target.branch}", so pushing would update ${target.branch} on ${remote}. Confirm the target branch "${target.branch}" to push there, or publish ${branch} under its own name.`,
          409,
        );
      } else {
        if (!data.setUpstream)
          return this.fail("push", {
            ok: false,
            out: "",
            err: "The current branch has no upstream branch",
          });
        remote =
          data.remote ??
          (remotes.length === 1
            ? remotes[0]
            : remotes.includes("origin")
              ? "origin"
              : "");
        assert(
          remote && remotes.includes(remote),
          "remote_required",
          "Choose which remote to publish this branch to",
          400,
        );
        ref = `refs/heads/${branch}`;
        setUpstream = true;
      }
      // No '+' prefix and no --force flags exist anywhere in this code path.
      const r = await git(
        repo,
        [
          "push",
          ...(setUpstream ? ["--set-upstream"] : []),
          "--",
          remote,
          `refs/heads/${branch}:${ref}`,
        ],
        { network: true },
      );
      const targetBranch = ref.slice("refs/heads/".length);
      if (!r.ok)
        return this.fail("push", r, { remote, branch, target: targetBranch });
      this.emit(agentId, "push", loc.root, {
        remote,
        branch,
        target: targetBranch,
      });
      return {
        action: "push",
        ok: true,
        remote,
        branch,
        target: targetBranch,
        summary: `Pushed ${branch} to ${remote}/${targetBranch}${setUpstream ? " and set it as upstream" : ""}`,
        detail: r.err.trim().slice(0, 2000),
        state: await this.repoState(agentId, loc, repo),
      };
    });
  }

  // ---- history ------------------------------------------------------------
  async log(agentId: string, input: unknown) {
    const data = z
      .object({
        ...common,
        ref: z.string().max(200).optional(),
        path: z.string().max(1000).optional(),
        limit: z.number().int().min(1).max(100).default(30),
        skip: z.number().int().min(0).max(100_000).default(0),
      })
      .strict()
      .parse(input);
    const { repo, loc, scope } = await this.context(
      agentId,
      data.workspace,
      false,
    );
    const head = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (!head.ok && !data.ref)
      return { commits: [], hasMore: false, nextSkip: null, empty: true };
    const rev = data.ref
      ? await this.ws.resolveRevision(repo, data.ref, "Revision")
      : "HEAD";
    // The path is relative to the attached folder; history is limited to that folder.
    const inner = data.path ? await resolveGitPath(loc.root, data.path) : ".";
    const pathspec =
      inner === "." ? scope || null : scope ? `${scope}/${inner}` : inner;
    const out = await must(repo, [
      "-c",
      "core.quotePath=false",
      "log",
      "--no-color",
      "--no-ext-diff",
      `--max-count=${data.limit + 1}`,
      `--skip=${data.skip}`,
      `--format=${LOG_FORMAT}`,
      rev,
      "--",
      ...(pathspec ? [pathspec] : []),
    ]);
    const all = parseLog(out);
    const commits = all.slice(0, data.limit);
    return {
      commits,
      hasMore: all.length > data.limit,
      nextSkip: all.length > data.limit ? data.skip + data.limit : null,
      empty: false,
    };
  }
  async commit(agentId: string, input: unknown) {
    const data = z
      .object({ ...common, sha: z.string().min(4).max(64) })
      .strict()
      .parse(input);
    const { loc, repo, scope } = await this.context(
      agentId,
      data.workspace,
      false,
    );
    const visible = await this.ws.visibleInRepo(agentId, loc.root, repo);
    const sha = await this.ws.resolveRevision(repo, data.sha, "Commit");
    if (scope) {
      // A subfolder attachment only sees commits that touch it.
      const touches = await must(repo, [
        "log",
        "-1",
        "--format=%H",
        sha,
        "--",
        scope,
      ]);
      assert(
        touches.trim() === sha,
        "commit_out_of_scope",
        "This commit does not change the attached folder",
        404,
      );
    }
    const body = await must(repo, ["show", "--no-patch", "--format=%B", sha]);
    const names = await must(repo, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      "-M",
      "-z",
      "--root",
      sha,
      "--",
      ...scoped(scope),
    ]);
    const parts = names.split("\0").filter(Boolean);
    const files: { status: string; path: string; from?: string }[] = [];
    for (let i = 0; i < parts.length && files.length < 500;) {
      const status = parts[i++];
      if (/^[RC]/.test(status))
        files.push({ status: status[0], from: parts[i++], path: parts[i++] });
      else files.push({ status: status[0], path: parts[i++] });
    }
    const shown = files.filter(
      (f) => visible(f.path) && (!f.from || visible(f.from)),
    );
    return {
      sha,
      message: body.trim().slice(0, 20_000),
      hiddenFiles: files.length - shown.length,
      files: shown,
      filesTruncated: parts.length > files.length * 2 && files.length >= 500,
    };
  }

  // ---- pull request links -------------------------------------------------
  async pullRequest(agentId: string, input: unknown) {
    const data = z
      .object({ ...common, base: z.string().max(200).optional() })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, false);
    const st = await this.repoState(agentId, loc, repo);
    const notes: string[] = [];
    const remotes = await this.remotes(repo);
    const upstreamRemote = st.upstream?.split("/")[0];
    const remote =
      remotes.find((r) => r.name === upstreamRemote) ??
      remotes.find((r) => r.name === "origin") ??
      remotes[0] ??
      null;
    const branch = st.branch ?? null;
    const lists = await this.branches(agentId, { workspace: data.workspace });
    const stripRemote = (value: string) => {
      const r = remotes.find((x) => value.startsWith(x.name + "/"));
      return r ? value.slice(r.name.length + 1) : value;
    };
    let base = stripRemote(lists.defaultBase ?? "");
    if (data.base?.trim()) {
      const parsed = branchName.safeParse(data.base);
      assert(parsed.success, "invalid_branch", "Invalid base branch name", 400);
      base = stripRemote(parsed.data);
    }
    let url: string | null = null;
    let published = false,
      ahead: number | null = null;
    if (!branch) notes.push("Switch to a branch to prepare a pull request.");
    else if (!remote) notes.push("This repository has no remote.");
    else if (!remote.info)
      notes.push(
        "The remote is a local path or uses an unsupported URL, so no web link can be built.",
      );
    else if (!base) notes.push("Choose a base branch.");
    else if (base === branch)
      notes.push("The base branch is the same as the current branch.");
    else {
      url = compareUrl(remote.info, branch, base);
      if (!url)
        notes.push(
          `Pull request links are not known for ${remote.info.host}. Open the repository page instead.`,
        );
    }
    if (branch && remote) {
      published = (
        await git(repo, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/remotes/${remote.name}/${branch}`,
        ])
      ).ok;
      if (!published && url)
        notes.push(
          "This branch is not on the remote yet. Push it first so the PR page can find it.",
        );
      if (st.ahead) notes.push(`${st.ahead} commit(s) not pushed yet.`);
      const c = await git(repo, [
        "rev-list",
        "--count",
        `${remote.name}/${base}..HEAD`,
      ]);
      if (c.ok) ahead = Number(c.out.trim());
    }
    const records = this.store.list<any>("worktree");
    const taskIds = new Set<string>();
    for (const w of records)
      if (w.branch === branch && w.taskId && w.repo === repo)
        taskIds.add(w.taskId);
    const tasks = [...taskIds].flatMap((id) => {
      try {
        const t = this.store.get<Task>("task", id);
        return [
          { id: t.id, title: t.title, status: t.status, agentId: t.agentId },
        ];
      } catch {
        return [];
      }
    });
    const reviews = this.store
      .list<any>("review-decision")
      .filter((d) => d.agentId === agentId && d.workspace === loc.root)
      .map((d) => ({
        id: d.id,
        decision: d.decision,
        compare: d.compare,
        staged: d.staged,
        at: d.at,
      }));
    const pullRequests = branch
      ? this.store
          .list<any>("pr-link")
          .filter((p) => p.repo === repo && p.branch === branch)
          .map(({ repo: _r, ...p }) => p)
      : [];
    return {
      branch,
      base: base || null,
      remote: remote
        ? {
            name: remote.name,
            display: remote.display,
            provider: remote.provider,
          }
        : null,
      url,
      repositoryUrl: remote?.info ? repositoryUrl(remote.info) : null,
      published,
      commitsAhead: ahead,
      notes,
      links: { tasks, reviews, pullRequests },
      /** Statuses of recorded PRs are entered by the user: no hosting API is called. */
      statusSource: "manual" as const,
    };
  }
  /** User action: open the compare page in the system browser. The URL is rebuilt here, never trusted from the UI. */
  async openPullRequest(agentId: string, input: unknown) {
    const info = await this.pullRequest(agentId, input);
    const target = info.url ?? null;
    assert(
      target && isBrowserUrl(target),
      "no_pr_url",
      info.notes[0] ?? "No pull request link is available",
      400,
    );
    try {
      await this.openUrl(target);
    } catch (e) {
      throw e instanceof AppError
        ? e
        : new AppError(
            400,
            "app_unavailable",
            "The browser could not be opened",
          );
    }
    this.store.emit("workspace.git", agentId, {
      action: "pr-open",
      branch: info.branch,
      url: target,
    });
    return { ok: true, url: target, opened: true };
  }
  /** Record a PR the user created, so work items, branch, review and PR stay linked. */
  async recordPullRequest(agentId: string, input: unknown) {
    const data = z
      .object({
        ...common,
        url: z.string().max(2000),
        number: z.number().int().positive().optional(),
        status: z.enum(["open", "draft", "merged", "closed"]).default("open"),
      })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(agentId, data.workspace, false);
    const st = await this.repoState(agentId, loc, repo);
    assert(st.branch, "no_branch", "Switch to a branch first", 400);
    assert(
      isBrowserUrl(data.url),
      "invalid_url",
      "Use an https:// pull request URL",
      400,
    );
    const remotes = await this.remotes(repo);
    assert(
      remotes.some(
        (r) =>
          r.info && r.info.host === new URL(data.url).hostname.toLowerCase(),
      ),
      "url_host_mismatch",
      "The pull request URL must be on the same host as one of this repository's remotes",
      400,
    );
    const id = createHash("sha256")
      .update(repo + "\0" + st.branch + "\0" + data.url)
      .digest("hex")
      .slice(0, 24);
    const record = {
      id,
      repo,
      branch: st.branch,
      url: data.url,
      number: data.number,
      status: data.status,
      source: "manual",
      updatedAt: new Date().toISOString(),
    };
    this.store.put("pr-link", record);
    this.store.emit("workspace.git", agentId, {
      action: "pr-record",
      branch: st.branch,
    });
    const { repo: _repo, ...out } = record;
    return out;
  }

  // ---- conflicts ------------------------------------------------------------
  async conflicts(agentId: string, input: unknown) {
    const data = z.object(common).strict().parse(input);
    const { loc, repo, scope } = await this.context(
      agentId,
      data.workspace,
      false,
    );
    const operation = await this.operation(repo);
    const visible = await this.ws.visibleInRepo(agentId, loc.root, repo);
    const files = (await this.conflictList(repo, scope)).filter((f) =>
      visible(f.path),
    );
    return {
      operation,
      files,
      resolved: operation !== "none" && files.length === 0,
      next:
        operation === "none"
          ? "No merge, rebase, cherry-pick or revert is in progress."
          : files.length
            ? `Resolve ${files.length} conflicted file(s) in your editor, mark each resolved (stages it), then continue — or abort to return to the state before the ${operation}.`
            : `All conflicts are staged. Continue the ${operation} or abort it.`,
    };
  }
  /** Conflicted files (repository-relative paths) inside the attachment scope. */
  private async conflictList(repo: string, scope: string) {
    const status = parseStatus(
      await must(repo, [
        "-c",
        "core.quotePath=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=no",
        "--",
        ...scoped(scope),
      ]),
    );
    return status
      .filter((f) => isConflictStatus(f.status))
      .map((f) => ({
        path: f.path,
        code: f.status,
        description: describeConflict(f.status as any),
      }));
  }
  async conflictFile(agentId: string, input: unknown) {
    const data = z
      .object({ ...common, path: z.string().max(1000) })
      .strict()
      .parse(input);
    const { repo, loc, scope } = await this.context(
      agentId,
      data.workspace,
      false,
    );
    const entry = (await this.conflictList(repo, scope)).find(
      (f) => f.path === data.path && inScope(scope, f.path),
    );
    assert(
      entry,
      "not_conflicted",
      "This file is not in a conflicted state",
      409,
    );
    const stages = (await must(repo, ["ls-files", "-u", "-z", "--", data.path]))
      .split("\0")
      .filter(Boolean)
      .map((l) => /^\d+ \S+ (\d)\t/.exec(l)?.[1]);
    const base = {
      ...entry,
      stages: {
        base: stages.includes("1"),
        ours: stages.includes("2"),
        theirs: stages.includes("3"),
      },
    };
    let abs: string;
    try {
      abs = (
        await this.ws.location(agentId, {
          workspace: loc.root,
          // Conflict paths are repository-relative; the file API is attachment-relative.
          path: scope ? data.path.slice(scope.length + 1) : data.path,
        })
      ).target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return {
          ...base,
          exists: false,
          sections: [],
          sectionCount: 0,
          malformed: false,
          truncated: false,
          note: "The file is deleted in the working tree. Mark it resolved to accept the deletion, or restore it first.",
        };
      throw e;
    }
    const info = await stat(abs);
    assert(info.isFile(), "not_file", "Path is not a regular file", 400);
    const LIMIT = 512_000;
    const buf = (await readFile(abs)).subarray(0, LIMIT);
    if (buf.includes(0))
      return {
        ...base,
        exists: true,
        binary: true,
        sections: [],
        sectionCount: 0,
        malformed: false,
        truncated: false,
        note: "Binary file: resolve it outside AgentTeam, then mark it resolved.",
      };
    const parsed = parseConflictMarkers(buf.toString("utf8"));
    return {
      ...base,
      exists: true,
      ...parsed,
      truncated: info.size > LIMIT,
      note: parsed.hasMarkers
        ? undefined
        : "No conflict markers remain in this file. Mark it resolved if the content is what you want.",
    };
  }
  async resolveConflicts(
    agentId: string,
    input: unknown,
  ): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        paths: z.array(z.string().max(1000)).min(1).max(500),
        /** The user knowingly stages a file that still contains marker lines. */
        acknowledgeMarkers: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    const { loc, repo } = await this.context(
      agentId,
      data.workspace,
      true,
      true,
    );
    await this.ws.assertPathsWritable(agentId, loc.root, data.paths);
    return this.mutate(agentId, repo, async () => {
      const list = await this.conflictList(repo, "");
      for (const p of data.paths)
        assert(
          list.some((f) => f.path === p),
          "not_conflicted",
          `"${p}" is not in a conflicted state`,
          409,
        );
      if (!data.acknowledgeMarkers) {
        const withMarkers: string[] = [];
        for (const p of data.paths) {
          try {
            const abs = (
              await this.ws.location(agentId, { workspace: loc.root, path: p })
            ).target;
            const text = (await readFile(abs)).subarray(0, 2_000_000);
            if (
              !text.includes(0) &&
              parseConflictMarkers(text.toString("utf8")).hasMarkers
            )
              withMarkers.push(p);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
        }
        assert(
          !withMarkers.length,
          "markers_present",
          `Conflict markers are still present in: ${withMarkers.join(", ")}. Edit the file first, or acknowledge to stage it as is.`,
          409,
        );
      }
      await applyStaging((args) => must(repo, args), repo, {
        action: "stage",
        paths: data.paths,
      });
      this.emit(agentId, "conflict-resolve", loc.root, { paths: data.paths });
      const after = await this.conflicts(agentId, {
        workspace: data.workspace,
      });
      return {
        action: "resolve",
        ok: true,
        summary: `Marked ${data.paths.length} file(s) resolved (staged)`,
        conflicts: after,
      };
    });
  }
  private async opCommand(
    agentId: string,
    input: unknown,
    verb: "abort" | "continue",
  ): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        confirm: z.boolean().optional(),
        confirmActiveRun: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    assert(
      flag(data.confirm),
      "confirmation_required",
      verb === "abort"
        ? "Aborting discards the merge/rebase progress. Confirm to continue."
        : "Confirm to continue the operation.",
      409,
    );
    const { loc, repo } = await this.context(agentId, data.workspace, true);
    return this.mutate(agentId, repo, async () => {
      const operation = await this.operation(repo);
      assert(
        operation !== "none",
        "no_operation",
        "No merge, rebase, cherry-pick or revert is in progress",
        409,
      );
      this.requireIdle(agentId, loc.root, flag(data.confirmActiveRun));
      if (verb === "continue") {
        const left = await this.conflictList(repo, "");
        assert(
          !left.length,
          "conflicts_remaining",
          `${left.length} file(s) still conflicted: ${left
            .map((f) => f.path)
            .slice(0, 5)
            .join(", ")}`,
          409,
        );
      }
      const r = await git(repo, [operation, `--${verb}`]);
      const state = await this.conflicts(agentId, {
        workspace: data.workspace,
      });
      if (!r.ok) return this.fail(verb, r, { operation, conflicts: state });
      this.emit(agentId, `operation-${verb}`, loc.root, { operation });
      return {
        action: verb,
        ok: true,
        operation,
        summary:
          verb === "abort"
            ? `Aborted the ${operation}`
            : state.operation === "none"
              ? `Completed the ${operation}`
              : `Continued the ${operation}; more conflicts need attention`,
        conflicts: state,
      };
    });
  }
  abort(agentId: string, input: unknown) {
    return this.opCommand(agentId, input, "abort");
  }
  continue(agentId: string, input: unknown) {
    return this.opCommand(agentId, input, "continue");
  }

  /**
   * Start a merge or rebase of the current branch with a chosen branch. Never forced: a clean
   * tracked tree, an explicit `confirmMode`, no operation in progress and (for a rebase that would
   * rewrite commits already on the upstream) `confirmRewrite` are required. Conflicts leave the
   * repository in the in-progress state that the conflict workflow (resolve/continue/abort) handles.
   */
  async integrate(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({
        ...common,
        mode: z.enum(["merge", "rebase"]),
        /** Short branch name: a local branch, or `remote/name` for a remote-tracking branch. */
        source: branchName,
        confirmMode: z.boolean().optional(),
        confirmRewrite: z.boolean().optional(),
        confirmActiveRun: z.boolean().optional(),
      })
      .strict()
      .parse(input);
    assert(
      flag(data.confirmMode),
      "mode_confirmation_required",
      data.mode === "merge"
        ? `Merging ${data.source} can create a merge commit and stop with conflicts. Confirm to continue.`
        : `Rebasing onto ${data.source} replays your local commits on top of it and rewrites them. Confirm to continue.`,
      409,
    );
    const { loc, repo } = await this.context(agentId, data.workspace, true);
    return this.mutate(agentId, repo, async () => {
      const st = await this.repoState(agentId, loc, repo);
      assert(
        st.operation === "none",
        "operation_in_progress",
        `A ${st.operation} is in progress. Finish or abort it first.`,
        409,
      );
      assert(
        !st.detached && !st.unborn && st.branch,
        "not_on_branch",
        "Switch to a branch with commits first",
        409,
      );
      assert(
        !st.tracked,
        "dirty_tree",
        `${st.tracked} tracked file(s) have uncommitted changes. Commit or discard them before a ${data.mode}.`,
        409,
      );
      let ref = "";
      for (const prefix of ["refs/heads/", "refs/remotes/"]) {
        if (
          (
            await git(repo, [
              "show-ref",
              "--verify",
              "--quiet",
              prefix + data.source,
            ])
          ).ok
        ) {
          ref = prefix + data.source;
          break;
        }
      }
      assert(
        ref && !/\/HEAD$/.test(ref),
        "branch_not_found",
        `No branch named "${data.source}"`,
        404,
      );
      assert(
        ref !== `refs/heads/${st.branch}`,
        "same_branch",
        "Choose a different branch than the current one",
        400,
      );
      this.requireIdle(agentId, loc.root, flag(data.confirmActiveRun));
      if (data.mode === "rebase") {
        const count = async (...args: string[]) =>
          Number(
            (await git(repo, ["rev-list", "--count", ...args])).out.trim() || 0,
          );
        const replayed = await count(`${ref}..HEAD`);
        const unpushed = st.upstream
          ? await count(`${ref}..HEAD`, "^@{u}")
          : replayed;
        assert(
          replayed - unpushed === 0 || flag(data.confirmRewrite),
          "rewrite_confirmation_required",
          `${replayed - unpushed} commit(s) to replay are already on ${st.upstream}; rebasing rewrites them and a later push would need force, which AgentTeam does not offer. Confirm the rewrite to continue.`,
          409,
        );
      }
      const before = st.head;
      const r = await git(
        repo,
        data.mode === "merge"
          ? ["merge", "--no-edit", "--no-verify", ref]
          : ["rebase", ref],
      );
      const state = await this.conflicts(agentId, {
        workspace: data.workspace,
      });
      const after = await this.repoState(agentId, loc, repo);
      if (!r.ok)
        // Merge/rebase report conflicts on stdout; stderr only holds the exit message.
        return this.fail(
          data.mode,
          { ...r, err: `${r.out}\n${r.err}` },
          {
            source: data.source,
            conflicts: state,
            state: after,
          },
        );
      this.emit(agentId, data.mode, loc.root, { source: data.source });
      return {
        action: data.mode,
        ok: true,
        source: data.source,
        summary:
          before === after.head
            ? `Already up to date with ${data.source}`
            : data.mode === "merge"
              ? `Merged ${data.source} into ${st.branch}`
              : `Rebased ${st.branch} onto ${data.source}`,
        conflicts: state,
        state: after,
      };
    });
  }

  // ---- new repositories -----------------------------------------------------
  async init(agentId: string, input: unknown): Promise<ActionResult> {
    const data = z
      .object({ ...common, branch: branchName.default("main") })
      .strict()
      .parse(input);
    const loc = await this.ws.location(
      agentId,
      { workspace: data.workspace, path: "." },
      true,
    );
    const probe = await git(loc.root, ["rev-parse", "--show-toplevel"]);
    assert(
      !probe.ok,
      "already_repository",
      `This folder is already inside a Git repository (${probe.out.trim()})`,
      409,
    );
    const r = await git(loc.root, [
      "init",
      "-q",
      `--initial-branch=${data.branch}`,
    ]);
    if (!r.ok) {
      const plain = await git(loc.root, ["init", "-q"]);
      if (!plain.ok) return this.fail("init", plain);
    }
    this.emit(agentId, "init", loc.root);
    return {
      action: "init",
      ok: true,
      summary: "Initialized an empty Git repository",
      state: await this.state(agentId, { workspace: data.workspace }),
    };
  }
}

/** Open a web URL with the platform handler, without a shell. */
export async function systemOpenUrl(url: string) {
  assert(
    isBrowserUrl(url),
    "invalid_url",
    "Only http(s) links can be opened",
    400,
  );
  const plan: OpenPlan =
    process.platform === "darwin"
      ? {
          executable: "/usr/bin/open",
          args: [url],
          application: "system",
          source: "system",
        }
      : process.platform === "win32"
        ? {
            executable: "rundll32.exe",
            args: ["url.dll,FileProtocolHandler", url],
            application: "system",
            source: "system",
          }
        : {
            executable: "xdg-open",
            args: [url],
            application: "system",
            source: "system",
          };
  await launch(plan);
}
