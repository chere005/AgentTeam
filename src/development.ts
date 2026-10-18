import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { WorkspaceService } from "./workspaces.ts";
import { assert, type Agent, type Session, type Task } from "./model.ts";
const exec = promisify(execFile);
export const localPreviewUrl = (value: string) => {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      Number(url.port) >= 1024,
    "invalid_preview",
    "Use a local HTTP URL with a port between 1024 and 65535",
    400,
  );
  return url.toString();
};
export type DevProcess = {
  id: string;
  agentId: string;
  workspace: string;
  command: string;
  url: string;
  state: "starting" | "running" | "stopping" | "stopped" | "failed";
  log: string;
  exitCode: number | null;
};
export class DevelopmentService {
  team: TeamService;
  ws: WorkspaceService;
  processes = new Map<string, { info: DevProcess; child: ChildProcess }>();
  creating = new Set<string>();
  constructor(team: TeamService) {
    this.team = team;
    this.ws = new WorkspaceService(team.store);
  }
  async worktree(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        branch: z.string().min(1).max(120),
        base: z.string().min(1).max(200).default("HEAD"),
      })
      .strict()
      .parse(input);
    const loc = await this.ws.location(
      agentId,
      { workspace: data.workspace },
      true,
    );
    const git = async (...args: string[]) =>
      (
        await exec(
          "git",
          ["-C", loc.root, "-c", "core.hooksPath=/dev/null", ...args],
          { timeout: 120000, maxBuffer: 2_000_000 },
        )
      ).stdout.trim();
    assert(
      (await realpath(await git("rev-parse", "--show-toplevel"))) === loc.root,
      "repo_root_required",
      "Attach the repository root to create a worktree",
      400,
    );
    await git("check-ref-format", "refs/heads/" + data.branch);
    assert(
      !data.branch.startsWith("-"),
      "invalid_branch",
      "Branch cannot begin with a dash",
      400,
    );
    const base = await git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      data.base + "^{commit}",
    );
    const common = await realpath(
      await git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    );
    assert(
      !this.creating.has(common),
      "worktree_busy",
      "Another worktree is being created for this repository",
      409,
    );
    assert(
      !this.team.store
        .list<Session>("session")
        .some((s) => s.agentId === agentId && s.state === "running") &&
        !this.team.store
          .list<Task>("task")
          .some((t) => t.agentId === agentId && t.status === "running"),
      "agent_busy",
      "Finish active work before switching worktrees",
      409,
    );
    const lease = "worktree:" + randomUUID();
    this.team.resources.acquire(lease, agentId, null);
    this.creating.add(common);
    let target = "",
      created = false;
    try {
      const parent = join(dirname(loc.root), "AgentTeam-worktrees");
      await mkdir(parent, { recursive: true });
      target = join(
        await realpath(parent),
        data.branch.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 60) +
          "-" +
          randomUUID().slice(0, 8),
      );
      await git("worktree", "add", "-b", data.branch, "--", target, base);
      created = true;
      target = await realpath(target);
      const agent = this.team.store.get<Agent>("agent", agentId);
      const { id, createdAt, control, ...config } = agent;
      const updated = await this.team.saveAgent(
        {
          ...config,
          workspaces: [
            ...agent.workspaces
              .filter((w) => w.path !== loc.root)
              .map((w) => ({ ...w, active: false })),
            { path: target, access: "write", active: true },
          ],
        },
        agentId,
      );
      this.team.store.emit("workspace.worktree_created", agentId, {
        source: loc.root,
        path: target,
        branch: data.branch,
        base,
      });
      return { agent: updated, path: target, branch: data.branch };
    } catch (e) {
      if (created)
        throw new Error(
          `Worktree was created at ${target}, but could not be attached: ${String(e)}. It has been preserved.`,
        );
      throw e;
    } finally {
      this.creating.delete(common);
      this.team.resources.release(lease);
    }
  }
  async feedback(sourceId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        path: z.string(),
        staged: z.boolean(),
        diffHash: z.string(),
        targetId: z.string(),
        text: z.string().trim().min(1).max(10000),
        row: z.number().int().min(0),
        requestId: z.string().uuid(),
      })
      .strict()
      .parse(input);
    const existing = this.team.store
      .list<any>("review-feedback")
      .find((f) => f.id === data.requestId);
    if (existing) return existing;
    this.team.store.get<Agent>("agent", data.targetId);
    const review = await this.ws.review(sourceId, {
      workspace: data.workspace,
      path: data.path,
      staged: data.staged,
    });
    assert(
      createHash("sha256").update(review.diff).digest("hex") === data.diffHash,
      "review_changed",
      "This diff changed. Refresh and review it before sending feedback",
      409,
    );
    const lines = review.diff.split("\n");
    assert(
      data.row < lines.length,
      "invalid_line",
      "Choose a line from this diff",
      400,
    );
    let old = 0,
      next = 0,
      anchor = "diff metadata";
    for (let i = 0; i <= data.row; i++) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]);
      if (h) {
        old = +h[1];
        next = +h[2];
        continue;
      }
      if (lines[i].startsWith("+") && !lines[i].startsWith("+++"))
        anchor = "new line " + next++;
      else if (lines[i].startsWith("-") && !lines[i].startsWith("---"))
        anchor = "old line " + old++;
      else if (lines[i].startsWith(" ")) {
        anchor = "new line " + next++;
        old++;
      }
    }
    return this.team.store.transaction(() => {
      const session = this.team.session(data.targetId);
      const message = this.team.message(session.id, {
        text: `Code review feedback\nWorkspace: ${data.workspace}\nFile: ${data.path} (${data.staged ? "staged" : "unstaged"}, ${anchor})\nDiff snapshot: ${data.diffHash}\n\n${data.text}\n\nQuoted diff context:\n${lines.slice(Math.max(0, data.row - 3), data.row + 4).join("\n")}\n\nInspect the current file before applying changes; the quoted context is a snapshot.`,
      });
      const record = {
        ...data,
        id: data.requestId,
        sourceId,
        sessionId: session.id,
        messageId: message.id,
        createdAt: new Date().toISOString(),
      };
      this.team.store.put("review-feedback", record);
      this.team.store.emit("review.feedback_sent", data.targetId, {
        path: data.path,
        messageId: message.id,
      });
      return record;
    });
  }
  list(agentId: string, workspace: string) {
    return [...this.processes.values()]
      .map((p) => p.info)
      .filter((p) => p.agentId === agentId && p.workspace === workspace);
  }
  async start(agentId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        command: z.string().trim().min(1).max(2000),
        url: z.string(),
      })
      .strict()
      .parse(input);
    const loc = await this.ws.location(
      agentId,
      { workspace: data.workspace },
      true,
    );
    const url = localPreviewUrl(data.url);
    assert(
      !this.list(agentId, loc.root).some((p) =>
        ["starting", "running", "stopping"].includes(p.state),
      ),
      "server_running",
      "Stop the existing server before starting another",
      409,
    );
    const info: DevProcess = {
      id: randomUUID(),
      agentId,
      workspace: loc.root,
      command: data.command,
      url,
      state: "starting",
      log: "",
      exitCode: null,
    };
    // User-entered command, deliberately executed by the platform shell.
    const child = spawn(data.command, {
      cwd: loc.root,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      env: {
        ...process.env,
        PORT: new URL(url).port,
        HOST: "127.0.0.1",
        FORCE_COLOR: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(info.id, { info, child });
    child.once("spawn", () => {
      info.state = "running";
    });
    const log = (chunk: Buffer) => {
      info.log = (info.log + chunk.toString("utf8")).slice(-64000);
    };
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    child.once("error", (e) => {
      info.state = "failed";
      info.log += "\n" + e.message;
    });
    child.once("close", (code) => {
      info.exitCode = code;
      info.state =
        info.state === "stopping" || code === 0 ? "stopped" : "failed";
    });
    return info;
  }
  async stop(id: string) {
    const processInfo = this.processes.get(id);
    assert(processInfo, "server_missing", "Development server not found", 404);
    const { child, info } = processInfo;
    if (!["starting", "running", "stopping"].includes(info.state)) return info;
    info.state = "stopping";
    if (child.pid) {
      if (process.platform === "win32")
        await exec("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(
          () => {},
        );
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 1500);
        timer.unref();
      }
    }
    return info;
  }
  async close() {
    await Promise.all([...this.processes.keys()].map((id) => this.stop(id)));
  }
}
