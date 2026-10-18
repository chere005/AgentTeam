import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  constants,
  lstat,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { WorkspaceService, parseWorktrees } from "./workspaces.ts";
import { overlaps } from "./resources.ts";
import {
  AppError,
  assert,
  type Agent,
  type Session,
  type Task,
} from "./model.ts";

const exec = promisify(execFile);

/** Serializes Git metadata changes per repository (shared with Git workflow actions; src/repo-lock.ts). */
export { withRepoLock } from "./repo-lock.ts";
import { withRepoLock } from "./repo-lock.ts";

type GitResult = { ok: boolean; out: string; err: string };
async function run(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const r = await exec(
      "git",
      ["-C", cwd, "-c", "core.hooksPath=" + devNull, ...args],
      { timeout: 120000, maxBuffer: 8_000_000 },
    );
    return { ok: true, out: r.stdout, err: r.stderr };
  } catch (e: any) {
    return {
      ok: false,
      out: String(e.stdout ?? ""),
      err: String(e.stderr || e.message),
    };
  }
}
async function must(cwd: string, args: string[], code = "git_failed") {
  const r = await run(cwd, args);
  assert(r.ok, code, `git ${args[0]} failed: ${r.err.trim()}`, 409);
  return r.out.trim();
}

/** Splits a user-entered command into argv without a shell (quotes group words; no escapes). */
export function splitArgs(command: string) {
  const out: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g))
    out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const slug = (value: string, max = 40) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max) || "work";

export const setupSchema = z
  .object({
    command: z.string().trim().min(1).max(2000),
    /** false: argv, spawned without a shell. true: user-entered shell command line. */
    shell: z.boolean().default(false),
  })
  .strict();
export type SetupCommand = z.infer<typeof setupSchema>;
export type SetupState = SetupCommand & {
  state: "pending" | "running" | "succeeded" | "failed";
  exitCode: number | null;
  log: string;
  attempts: number;
  startedAt?: string;
  finishedAt?: string;
};
export type WorktreeRecord = {
  id: string;
  path: string;
  repo: string;
  source: string;
  branch: string;
  base: string;
  ownerId: string | null;
  taskId?: string;
  keepSource: boolean;
  status: "attached" | "unattached" | "archived" | "removed";
  attachError?: string;
  createdAt: string;
  setup?: SetupState;
};
const settingsPart = z
  .object({
    autoCreate: z.boolean().default(false),
    keepSource: z.boolean().default(false),
    setup: setupSchema.nullable().default(null),
  })
  .strict();
export const worktreeSettingsSchema = settingsPart
  .extend({
    /** Per source repository (real path of the repository root) overrides. */
    projects: z.record(z.string(), settingsPart.partial().strict()).default({}),
  })
  .strict();
export type WorktreeSettings = z.infer<typeof worktreeSettingsSchema>;

const createSchema = z
  .object({
    workspace: z.string(),
    branch: z.string().trim().min(1).max(120).optional(),
    base: z.string().trim().min(1).max(200).default("HEAD"),
    directory: z.string().min(1).max(2000).optional(),
    keepSource: z.boolean().optional(),
    attach: z.boolean().default(true),
    setup: setupSchema.extend({ run: z.boolean().default(false) }).optional(),
    taskId: z.string().optional(),
  })
  .strict();

const assertNotBusy = (reason: string | null) =>
  assert(!reason, "agent_busy", reason ?? "", 409);
const FILE_CAP = 200;
const parseStatus = (raw: string) => {
  const parts = raw.split("\0").filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i].slice(0, 2);
    files.push({ path: parts[i].slice(3), status });
    if (/[RC]/.test(status)) i++;
  }
  return {
    changed: files.filter((f) => f.status !== "??").length,
    untracked: files.filter((f) => f.status === "??").length,
    files: files.slice(0, FILE_CAP),
    truncated: files.length > FILE_CAP,
  };
};

export class WorktreeService {
  team: TeamService;
  ws: WorkspaceService;
  running = new Map<string, { child: ChildProcess; done: Promise<void> }>();
  constructor(team: TeamService, ws = new WorkspaceService(team.store)) {
    this.team = team;
    this.ws = ws;
    // A setup command recorded as running belonged to a previous backend process (one service per
    // backend); its child is gone, so show it as failed and let the user retry.
    for (const rec of this.store.list<WorktreeRecord>("worktree"))
      if (rec.setup?.state === "running")
        this.store.put("worktree", {
          ...rec,
          setup: {
            ...rec.setup,
            state: "failed",
            exitCode: null,
            log:
              rec.setup.log +
              "\n[AgentTeam] Interrupted by an application restart.",
            finishedAt: new Date().toISOString(),
          },
        });
  }
  private get store() {
    return this.team.store;
  }
  // ---- settings ---------------------------------------------------------
  settings(): WorktreeSettings {
    let raw: unknown = {};
    try {
      raw = this.store.get<any>("settings", "worktrees");
    } catch {}
    const { id, ...rest } = raw as any;
    return worktreeSettingsSchema.parse(rest ?? {});
  }
  saveSettings(input: unknown) {
    const data = worktreeSettingsSchema.parse(input);
    this.store.put("settings", { id: "worktrees", ...data });
    this.store.emit("worktree.settings_updated", "worktrees");
    return data;
  }
  effective(root: string) {
    const all = this.settings();
    const { autoCreate, keepSource, setup } = all;
    return { autoCreate, keepSource, setup, ...all.projects[root] };
  }
  // ---- helpers ----------------------------------------------------------
  /** Why the agent's folders must not switch now, or null. */
  private busy(agentId: string): string | null {
    if (
      this.store
        .list<Session>("session")
        .some((s) => s.agentId === agentId && s.state === "running") ||
      this.store
        .list<Task>("task")
        .some((t) => t.agentId === agentId && t.status === "running")
    )
      return "Finish active work before switching worktrees";
    // A resumed interrupted/blocked task continues its provider session in the original folder.
    const paused = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.agentId === agentId &&
          (t.status === "interrupted" || t.status === "blocked"),
      );
    return paused.length
      ? `Resume or cancel the interrupted task "${paused[0].title}" before switching worktrees`
      : null;
  }
  private async repo(agentId: string, workspace: string, write: boolean) {
    const loc = await this.ws.location(agentId, { workspace }, write);
    const top = await must(
      loc.root,
      ["rev-parse", "--show-toplevel"],
      "not_a_repository",
    );
    assert(
      (await realpath(top)) === loc.root,
      "repo_root_required",
      "Attach the repository root to manage its worktrees",
      400,
    );
    const common = await realpath(
      await must(loc.root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    return { root: loc.root, common };
  }
  private records() {
    return this.store.list<WorktreeRecord>("worktree");
  }
  private record(id: string) {
    return this.store.get<WorktreeRecord>("worktree", id);
  }
  private async branchExists(cwd: string, branch: string) {
    return (
      await run(cwd, [
        "show-ref",
        "--verify",
        "--quiet",
        "refs/heads/" + branch,
      ])
    ).ok;
  }
  private async exists(path: string) {
    return lstat(path).then(
      () => true,
      () => false,
    );
  }
  private async generate(root: string, agentName: string) {
    let branch = "";
    for (let i = 0; i < 20; i++) {
      branch = `agentteam/${slug(agentName, 24)}-${Date.now().toString(36)}${randomUUID().slice(0, 3)}`;
      if (!(await this.branchExists(root, branch))) break;
    }
    return {
      branch,
      directory: join(
        dirname(root),
        "AgentTeam-worktrees",
        slug(branch.replace("agentteam/", "")) + "-" + randomUUID().slice(0, 6),
      ),
    };
  }
  /** Prefill data for the create form: names are suggestions, re-validated on create. */
  async suggest(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const { root } = await this.repo(agentId, workspace, false);
    const agent = this.store.get<Agent>("agent", agentId);
    const names = await this.generate(root, agent.name);
    const hasCommits =
      (await run(root, ["rev-list", "-n", "1", "--all"])).out.trim() !== "";
    const branches = hasCommits
      ? (
          await run(root, [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
          ])
        ).out
          .split("\n")
          .filter(Boolean)
      : [];
    return {
      ...names,
      base: "HEAD",
      hasCommits,
      branches,
      source: root,
      settings: this.effective(root),
    };
  }
  private async prepareParent(root: string, target: string) {
    assert(
      !overlaps(root, target),
      "invalid_directory",
      "The destination cannot be inside, or contain, the source repository",
      400,
    );
    assert(
      !(await this.exists(target)),
      "directory_exists",
      `The destination ${target} already exists; choose another directory`,
      409,
    );
    const parent = dirname(target);
    try {
      await mkdir(parent, { recursive: true });
      await access(parent, constants.W_OK | constants.X_OK);
    } catch (e: any) {
      throw new AppError(
        403,
        "permission_denied",
        `Cannot create a worktree in ${parent}: ${e.code ?? e.message}`,
      );
    }
    assert(
      (await stat(parent)).isDirectory(),
      "invalid_directory",
      "The destination's parent is not a directory",
      400,
    );
    return join(await realpath(parent), basename(target));
  }
  // ---- create / attach ---------------------------------------------------
  async create(
    agentId: string,
    input: unknown,
    options: { auto?: boolean } = {},
  ) {
    const data = createSchema.parse(input);
    const agent = this.store.get<Agent>("agent", agentId);
    const { root, common } = await this.repo(agentId, data.workspace, true);
    const cfg = this.effective(root);
    const keepSource = data.keepSource ?? cfg.keepSource;
    if (data.attach) assertNotBusy(this.busy(agentId));
    if (data.branch) {
      assert(
        !data.branch.startsWith("-"),
        "invalid_branch",
        "Branch cannot begin with a dash",
        400,
      );
      assert(
        (await run(root, ["check-ref-format", "refs/heads/" + data.branch]))
          .ok &&
          !/[\s]/.test(data.branch) &&
          !data.branch.endsWith("/"),
        "invalid_branch",
        `"${data.branch}" is not a valid Git branch name`,
        400,
      );
    }
    assert(
      !data.directory ||
        (isAbsolute(data.directory) && !data.directory.includes("\0")),
      "invalid_directory",
      "Choose an absolute destination directory",
      400,
    );
    const requestedDir = data.directory ? resolve(data.directory) : undefined;
    // Everything that depends on repository metadata runs under the per-repository lock.
    const made = await withRepoLock(common, async () => {
      const hasCommits =
        (await run(root, ["rev-list", "-n", "1", "--all"])).out.trim() !== "";
      assert(
        hasCommits,
        "no_commits",
        "This repository has no commits yet. Make an initial commit before creating a worktree",
        409,
      );
      const base = await run(root, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        data.base + "^{commit}",
      ]);
      assert(
        base.ok && base.out.trim(),
        "missing_revision",
        `Revision "${data.base}" does not exist in this repository`,
        400,
      );
      let branch = data.branch;
      if (branch)
        assert(
          !(await this.branchExists(root, branch)),
          "branch_exists",
          `Branch "${branch}" already exists (or is checked out in another worktree); choose a different name`,
          409,
        );
      else branch = (await this.generate(root, agent.name)).branch;
      const wanted =
        requestedDir ??
        join(
          dirname(root),
          "AgentTeam-worktrees",
          slug(branch.replace("agentteam/", "")) +
            "-" +
            randomUUID().slice(0, 6),
        );
      const target = await this.prepareParent(root, wanted);
      await must(
        root,
        ["worktree", "add", "-b", branch, "--", target, base.out.trim()],
        "worktree_failed",
      );
      return { branch, base: base.out.trim(), path: await realpath(target) };
    });
    const record: WorktreeRecord = {
      id: randomUUID(),
      path: made.path,
      repo: common,
      source: root,
      branch: made.branch,
      base: made.base,
      ownerId: data.attach ? agentId : null,
      taskId: data.taskId,
      keepSource,
      status: "unattached",
      createdAt: new Date().toISOString(),
    };
    const setup =
      data.setup ?? (options.auto ? (cfg.setup ?? undefined) : undefined);
    if (setup)
      record.setup = {
        command: setup.command,
        shell: setup.shell,
        state: "pending",
        exitCode: null,
        log: "",
        attempts: 0,
      };
    this.store.put("worktree", record);
    this.store.emit("workspace.worktree_created", agentId, {
      source: root,
      path: record.path,
      branch: record.branch,
      base: record.base,
    });
    let agentAfter: Agent | undefined;
    if (data.attach) {
      try {
        agentAfter = (
          await this.attach(agentId, { worktreeId: record.id, keepSource })
        ).agent;
      } catch (e) {
        const message = (e as Error).message;
        this.store.put("worktree", {
          ...this.record(record.id),
          attachError: message,
        });
        throw new AppError(
          409,
          "worktree_attach_failed",
          `Worktree ${record.path} (branch ${record.branch}) was created but could not be attached: ${message}. It has been preserved; use "Attach to this agent" on it in Managed worktrees to retry.`,
        );
      }
    }
    // Explicitly requested setup runs now; auto-created worktrees never run it silently.
    if (data.setup?.run) this.runSetup(agentId, record.id);
    return {
      agent: agentAfter ?? agent,
      path: record.path,
      branch: record.branch,
      base: record.base,
      worktree: this.record(record.id),
    };
  }
  async attach(agentId: string, input: unknown) {
    const data = z
      .object({ worktreeId: z.string(), keepSource: z.boolean().optional() })
      .strict()
      .parse(input);
    const rec = this.record(data.worktreeId);
    assert(
      rec.status !== "removed",
      "worktree_removed",
      "This worktree has been removed",
      409,
    );
    const agent = this.store.get<Agent>("agent", agentId);
    assert(
      await stat(rec.path).then(
        (s) => s.isDirectory(),
        () => false,
      ),
      "worktree_missing",
      `${rec.path} no longer exists`,
      409,
    );
    assertNotBusy(this.busy(agentId));
    const keepSource = data.keepSource ?? rec.keepSource;
    const { id, createdAt, control, ...config } = agent;
    const updated = await this.team.saveAgent(
      {
        ...config,
        workspaces: [
          ...agent.workspaces
            .filter(
              (w) =>
                w.path !== rec.path && (keepSource || w.path !== rec.source),
            )
            .map((w) => ({ ...w, active: false })),
          { path: rec.path, access: "write", active: true },
        ],
      },
      agentId,
    );
    this.store.put("worktree", {
      ...rec,
      status: "attached",
      ownerId: agentId,
      keepSource,
      attachError: undefined,
    });
    this.store.emit("workspace.worktree_attached", agentId, { path: rec.path });
    return { agent: updated, worktree: this.record(rec.id) };
  }
  /** Used when a task is assigned. Never blocks task creation. */
  async autoForTask(agentId: string, taskId?: string) {
    try {
      const agent = this.store.get<Agent>("agent", agentId);
      const active = agent.workspaces.find(
        (w) => w.active && w.access === "write",
      );
      if (!active) return null;
      let root: string;
      try {
        root = await realpath(active.path);
      } catch {
        return null;
      }
      if (!this.effective(root).autoCreate) return null;
      const git = await run(root, [
        "rev-parse",
        "--git-dir",
        "--git-common-dir",
      ]);
      if (!git.ok) return null;
      const [dir, common] = git.out.trim().split("\n");
      // Already inside a linked worktree: reuse it.
      if (resolve(root, dir) !== resolve(root, common)) return null;
      const result = await this.create(
        agentId,
        { workspace: active.path, taskId },
        { auto: true },
      );
      return { ok: true as const, path: result.path, branch: result.branch };
    } catch (e) {
      const message = (e as Error).message;
      this.store.emit("worktree.auto_failed", agentId, { taskId, message });
      return { ok: false as const, message };
    }
  }
  // ---- setup command -----------------------------------------------------
  private authorize(agentId: string, rec: WorktreeRecord) {
    const agent = this.store.get<Agent>("agent", agentId);
    assert(
      rec.ownerId === agentId ||
        agent.workspaces.some(
          (w) => w.path === rec.path || w.path === rec.source,
        ),
      "workspace_denied",
      "This worktree is not available to this agent",
      403,
    );
    return agent;
  }
  runSetup(agentId: string, worktreeId: string, input?: unknown) {
    const rec = this.record(worktreeId);
    this.authorize(agentId, rec);
    assert(
      rec.status !== "removed",
      "worktree_removed",
      "This worktree has been removed",
      409,
    );
    assert(
      !this.running.has(worktreeId),
      "setup_running",
      "The setup command is already running",
      409,
    );
    const given = input === undefined ? undefined : setupSchema.parse(input);
    const cmd = given ?? rec.setup;
    assert(
      cmd,
      "no_setup",
      "No setup command is configured for this worktree",
      400,
    );
    const argv = cmd.shell ? [] : splitArgs(cmd.command);
    assert(cmd.shell || argv.length, "no_setup", "Enter a command", 400);
    const state: SetupState = {
      command: cmd.command,
      shell: cmd.shell,
      state: "running",
      exitCode: null,
      log: "",
      attempts: (rec.setup?.attempts ?? 0) + 1,
      startedAt: new Date().toISOString(),
    };
    const save = () =>
      this.store.put("worktree", {
        ...this.record(worktreeId),
        setup: { ...state },
      });
    save();
    this.store.emit("worktree.setup_started", worktreeId, {
      command: state.command,
    });
    const env = {
      ...process.env,
      AGENTTEAM_WORKTREE: rec.path,
      AGENTTEAM_BRANCH: rec.branch,
      FORCE_COLOR: "0",
    };
    // The command text was entered by the user and is stored/shown with its log.
    const child = cmd.shell
      ? spawn(cmd.command, {
          cwd: rec.path,
          shell: true,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(argv[0], argv.slice(1), {
          cwd: rec.path,
          shell: false,
          env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    const log = (chunk: Buffer) => {
      state.log = (state.log + chunk.toString("utf8")).slice(-64000);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    const timer = setTimeout(() => {
      state.log += "\n[AgentTeam] Timed out after 10 minutes; stopping.";
      child.kill("SIGTERM");
    }, 600000);
    const done = new Promise<void>((resolveDone) => {
      let finished = false;
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        state.exitCode = code;
        state.state = code === 0 ? "succeeded" : "failed";
        state.finishedAt = new Date().toISOString();
        this.running.delete(worktreeId);
        try {
          save();
          this.store.emit("worktree.setup_finished", worktreeId, {
            state: state.state,
            exitCode: code,
          });
        } catch {}
        resolveDone();
      };
      child.once("error", (e) => {
        state.log += "\n" + e.message;
        finish(-1);
      });
      child.once("close", (code) => finish(code ?? -1));
    });
    this.running.set(worktreeId, { child, done });
    return { setup: { ...state }, done };
  }
  // ---- inspection ---------------------------------------------------------
  private async changes(path: string) {
    const r = await run(path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    return r.ok
      ? parseStatus(r.out)
      : {
          changed: 0,
          untracked: 0,
          files: [],
          truncated: false,
          error: r.err.trim(),
        };
  }
  private users(path: string) {
    const agents = this.store
      .list<Agent>("agent")
      .filter((a) => a.workspaces.some((w) => w.path === path));
    const ids = new Set(agents.map((a) => a.id));
    const tasks = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          ids.has(t.agentId) &&
          ["running", "queued", "interrupted", "blocked"].includes(t.status),
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        agentId: t.agentId,
      }));
    const sessions = this.store
      .list<Session>("session")
      .filter((s) => ids.has(s.agentId) && s.state === "running");
    return {
      owners: agents.map((a) => ({
        id: a.id,
        name: a.name,
        active: !!a.workspaces.find((w) => w.path === path)?.active,
      })),
      tasks,
      running: tasks.some((t) => t.status === "running") || sessions.length > 0,
    };
  }
  async list(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const { root, common } = await this.repo(agentId, workspace, false);
    const entries = parseWorktrees(
      (await must(root, ["worktree", "list", "--porcelain"])).concat("\n\n"),
    );
    const records = this.records().filter(
      (r) => r.repo === common && r.status !== "removed",
    );
    const seen = new Set<string>();
    const out = [];
    for (const [index, e] of entries.entries()) {
      const raw = String(e.worktree ?? "");
      if (!raw) continue;
      const path = await realpath(raw).catch(() => raw);
      seen.add(path);
      const rec = records.find((r) => r.path === path);
      const missing = !(await stat(path).then(
        () => true,
        () => false,
      ));
      const head = String(e.HEAD ?? "");
      let ahead: number | null = null;
      if (rec && !missing) {
        const r = await run(path, ["rev-list", "--count", `${rec.base}..HEAD`]);
        if (r.ok) ahead = Number(r.out.trim());
      }
      out.push({
        path,
        main: index === 0,
        current: path === root,
        branch: e.branch ? String(e.branch).replace("refs/heads/", "") : null,
        head,
        base: rec?.base ?? null,
        ahead,
        managed: !!rec,
        record: rec ?? null,
        archived: rec?.status === "archived",
        missing,
        locked: !!e.locked,
        changes: missing ? null : await this.changes(path),
        ...this.users(path),
      });
    }
    // Preserved/unattached records that Git no longer lists.
    for (const rec of records)
      if (!seen.has(rec.path))
        out.push({
          path: rec.path,
          main: false,
          current: false,
          branch: rec.branch,
          head: "",
          base: rec.base,
          ahead: null,
          managed: true,
          record: rec,
          archived: rec.status === "archived",
          missing: true,
          locked: false,
          changes: null,
          ...this.users(rec.path),
        });
    return { root, worktrees: out };
  }
  // ---- archive / remove ---------------------------------------------------
  async remove(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        path: z.string(),
        mode: z.enum(["archive", "remove"]),
        acknowledgeUsers: z.boolean().default(false),
        deleteBranch: z.boolean().default(false),
      })
      .strict()
      .parse(input);
    const { root, common } = await this.repo(agentId, data.workspace, true);
    const listed = parseWorktrees(
      (await must(root, ["worktree", "list", "--porcelain"])).concat("\n\n"),
    );
    let target = "",
      branch = "",
      mainRoot = "";
    for (const [i, e] of listed.entries()) {
      const p = await realpath(String(e.worktree)).catch(() =>
        String(e.worktree),
      );
      if (i === 0) mainRoot = p;
      if (
        p === resolve(data.path) ||
        p === (await realpath(data.path).catch(() => ""))
      ) {
        target = p;
        branch = String(e.branch ?? "").replace("refs/heads/", "");
      }
    }
    assert(
      target,
      "worktree_unknown",
      "That path is not a worktree of this repository",
      404,
    );
    assert(
      target !== mainRoot,
      "main_worktree",
      "The main working tree cannot be archived or removed here",
      400,
    );
    const users = this.users(target);
    assert(
      !users.running,
      "worktree_active",
      "An agent attached to this worktree is running work. Wait for it to finish or cancel it first",
      409,
    );
    assert(
      data.acknowledgeUsers || (!users.owners.length && !users.tasks.length),
      "worktree_in_use",
      `This worktree is attached to ${users.owners.map((o) => o.name).join(", ") || "no agent"}` +
        (users.tasks.length
          ? ` with ${users.tasks.length} queued or resumable task(s)`
          : "") +
        `. Confirm to detach it from them and continue`,
      409,
    );
    let branchDeleted = false;
    let warning = "";
    if (data.mode === "remove") {
      const changes = await this.changes(target);
      assert(
        !changes.changed && !changes.untracked && !("error" in changes),
        "worktree_dirty",
        `Refusing to remove ${target}: it has ${changes.changed} modified and ${changes.untracked} untracked file(s) (${changes.files
          .slice(0, 8)
          .map((f) => f.path)
          .join(", ")}). Commit, stash, or archive it instead`,
        409,
      );
      await withRepoLock(common, async () => {
        await must(
          root,
          ["worktree", "remove", "--", target],
          "worktree_remove_failed",
        );
        if (data.deleteBranch && branch) {
          const r = await run(root, ["branch", "-d", "--", branch]);
          branchDeleted = r.ok;
          if (!r.ok) warning = `Branch ${branch} was kept: ${r.err.trim()}`;
        }
      });
    }
    // Detach from every agent that referenced the checkout.
    const detached: string[] = [];
    for (const a of this.store
      .list<Agent>("agent")
      .filter((x) => x.workspaces.some((w) => w.path === target))) {
      const rest = a.workspaces.filter((w) => w.path !== target);
      if (rest.length && !rest.some((w) => w.active)) {
        const back = rest.find((w) => w.path === mainRoot) ?? rest[0];
        back.active = true;
      }
      const { id, createdAt, control, ...config } = a;
      await this.team.saveAgent({ ...config, workspaces: rest }, a.id);
      detached.push(a.id);
    }
    const existing = this.records().find(
      (r) => r.repo === common && r.path === target,
    );
    const status = data.mode === "remove" ? "removed" : "archived";
    if (existing)
      this.store.put("worktree", { ...existing, status, ownerId: null });
    else
      this.store.put("worktree", {
        id: randomUUID(),
        path: target,
        repo: common,
        source: mainRoot,
        branch,
        base: "",
        ownerId: null,
        keepSource: false,
        status,
        createdAt: new Date().toISOString(),
      } satisfies WorktreeRecord);
    this.store.emit("workspace.worktree_" + status, agentId, {
      path: target,
      detached,
    });
    return {
      mode: data.mode,
      path: target,
      branch,
      detached,
      branchDeleted,
      warning,
    };
  }
  async close() {
    for (const { child } of this.running.values()) child.kill("SIGTERM");
    await Promise.all([...this.running.values()].map((r) => r.done));
  }
}
