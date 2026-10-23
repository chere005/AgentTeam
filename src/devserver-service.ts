import { createHash } from "node:crypto";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { WorkspaceService } from "./workspaces.ts";
import { assert, type Agent } from "./model.ts";
import { localPreviewUrl } from "./development.ts";
import { overlaps, type Lease } from "./resources.ts";
import { DevServerRunner, type DevServerInfo } from "./devserver.ts";

export const settingsSchema = z
  .object({
    workspace: z.string(),
    command: z.string().trim().min(1).max(2000),
    cwd: z.string().max(500).default("."),
    url: z.string().max(500),
    readyTimeoutSeconds: z.number().int().min(2).max(600).default(60),
  })
  .strict();
export type DevSettings = z.infer<typeof settingsSchema> & {
  id: string;
  updatedAt: string;
};

export const LOCK_POLICY =
  "The development server is not an AgentTeam resource-lock holder. It runs with your account and may write build output, caches or lockfiles into its working folder at any time. Those writes are not serialized with agent runs: AgentTeam only warns when an agent run holds a lease on the folder, and it never blocks or pauses either side. Prefer an isolated worktree for the server, keep generated output in gitignored directories, and review the diff before accepting an agent's changes.";

export type Suggestion = {
  label: string;
  command: string;
  url: string;
  source: string;
  note?: string;
};

const settingsId = (root: string) =>
  createHash("sha256").update(root).digest("hex").slice(0, 24);

/** Package-script suggestions. Nothing here is ever executed. */
export async function suggestScripts(dir: string) {
  const suggestions: Suggestion[] = [],
    warnings: string[] = [];
  let pkg: any;
  try {
    pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    return { suggestions, warnings };
  }
  const names = await readdir(dir).catch(() => [] as string[]);
  const pm = names.includes("pnpm-lock.yaml")
    ? "pnpm"
    : names.includes("yarn.lock")
      ? "yarn"
      : names.includes("bun.lock") || names.includes("bun.lockb")
        ? "bun"
        : "npm";
  const scripts: Record<string, unknown> =
    pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
  for (const [name, raw] of Object.entries(scripts)) {
    if (!/^(dev|start|serve|develop|preview|storybook)(:|$)/.test(name))
      continue;
    const text = String(raw);
    const flag = /(?:--port|-p)[ =](\d{4,5})|PORT=(\d{4,5})/.exec(text);
    const guess = flag
      ? Number(flag[1] ?? flag[2])
      : /vite/.test(text)
        ? 5173
        : /storybook/.test(text)
          ? 6006
          : /astro/.test(text)
            ? 4321
            : /webpack|parcel/.test(text)
              ? 8080
              : 3000;
    const run = pm === "yarn" || pm === "bun" ? `${pm} run` : `${pm} run`;
    let command = `${run} ${name}`;
    let note: string | undefined;
    if (/\bvite\b/.test(text) && !flag) {
      command += pm === "yarn" ? "" : " --";
      command += ` --host 127.0.0.1 --port ${guess} --strictPort`;
      note = "Vite ignores PORT/HOST, so the flags are added explicitly.";
    }
    suggestions.push({
      label: `${pm} ${name}`,
      command,
      url: `http://127.0.0.1:${guess}`,
      source: `package.json scripts.${name}: ${text.slice(0, 120)}`,
      note,
    });
  }
  const hasDeps =
    Object.keys(pkg?.dependencies ?? {}).length +
      Object.keys(pkg?.devDependencies ?? {}).length >
    0;
  if (hasDeps && !names.includes("node_modules"))
    warnings.push(
      `node_modules is missing in ${dir}. Run ${pm} install yourself first; AgentTeam never installs dependencies automatically.`,
    );
  return { suggestions, warnings };
}

/** For a git worktree checkout, the root of the repository it was created from. */
export async function projectRootOf(root: string) {
  try {
    const text = await readFile(join(root, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!gitdir) return null;
    const common = dirname(dirname(resolve(root, gitdir)));
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

export class DevServerService {
  team: TeamService;
  ws: WorkspaceService;
  runner = new DevServerRunner();
  constructor(team: TeamService) {
    this.team = team;
    this.ws = new WorkspaceService(team.store);
  }
  private settingsFor(root: string): DevSettings | null {
    try {
      return this.team.store.get<DevSettings>(
        "devserver-settings",
        settingsId(root),
      );
    } catch {
      return null;
    }
  }
  private async resolveCwd(
    agentId: string,
    workspace: string,
    cwd: string,
    write: boolean,
  ) {
    const loc = await this.ws.location(
      agentId,
      { workspace, path: cwd },
      write,
    );
    assert(
      (await stat(loc.target)).isDirectory(),
      "invalid_cwd",
      "Working directory must be a folder",
      400,
    );
    return loc;
  }
  async state(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const loc = await this.ws.location(agentId, { workspace });
    let settings = this.settingsFor(loc.root),
      inherited: string | null = null;
    if (!settings) {
      const project = await projectRootOf(loc.root);
      const parent = project ? this.settingsFor(project) : null;
      if (parent) {
        settings = parent;
        inherited = project;
      }
    }
    const cwd = settings?.cwd ?? ".";
    const dir = await this.resolveCwd(agentId, workspace, cwd, false).catch(
      () => loc,
    );
    const { suggestions, warnings } = await suggestScripts(dir.target);
    const server = this.runner.get(loc.root);
    const locks = this.team.store
      .list<Lease>("lease")
      .filter((l) => l.paths.some((p) => overlaps(p, loc.root)))
      .map((l) => {
        let agent = l.agentId;
        try {
          agent = this.team.store.get<Agent>("agent", l.agentId).name;
        } catch {}
        return { leaseId: l.id, agent, since: l.acquiredAt };
      });
    return {
      settings: settings && {
        command: settings.command,
        cwd: settings.cwd,
        url: settings.url,
        readyTimeoutSeconds: settings.readyTimeoutSeconds,
      },
      inheritedFrom: inherited,
      suggestions,
      warnings,
      server,
      console: this.runner.consoleEntries(loc.root),
      locks,
      lockPolicy: LOCK_POLICY,
    };
  }
  async save(agentId: string, input: unknown) {
    const data = settingsSchema.parse(input);
    await this.resolveCwd(agentId, data.workspace, data.cwd, true);
    const loc = await this.ws.location(
      agentId,
      { workspace: data.workspace },
      true,
    );
    const url = localPreviewUrl(data.url);
    const record: DevSettings = {
      ...data,
      url,
      id: settingsId(loc.root),
      updatedAt: new Date().toISOString(),
    };
    this.team.store.put("devserver-settings", record);
    return record;
  }
  async start(agentId: string, input: unknown) {
    filesystemPolicy(this.team.store).assertConfinedExecution();
    const body = (input ?? {}) as Record<string, unknown>;
    const saved = "command" in body ? await this.save(agentId, body) : null;
    const { workspace } = z
      .object({ workspace: z.string() })
      .passthrough()
      .parse(body);
    const loc = await this.ws.location(agentId, { workspace }, true);
    const settings = saved ?? this.settingsFor(loc.root);
    assert(settings, "no_settings", "Configure the command and URL first", 400);
    const dir = await this.resolveCwd(agentId, workspace, settings.cwd, true);
    const locks = this.team.store
      .list<Lease>("lease")
      .filter((l) => l.paths.some((p) => overlaps(p, loc.root)));
    const info = await this.runner.start({
      key: loc.root,
      agentId,
      workspace: loc.root,
      cwd: dir.target,
      command: settings.command,
      url: localPreviewUrl(settings.url),
      readyTimeoutMs: settings.readyTimeoutSeconds * 1000,
      onChange: (i) =>
        this.team.store.emit("devserver." + i.state, agentId, {
          workspace: loc.root,
          exitCode: i.exitCode,
        }),
    });
    if (locks.length)
      info.hints.push(
        "An agent run currently holds a lease on this folder; files the server generates may race with it. " +
          "See the resource-lock note.",
      );
    return info;
  }
  async stop(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const loc = await this.ws.location(agentId, { workspace }, true);
    return this.runner.stop(loc.root);
  }
  async restart(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const loc = await this.ws.location(agentId, { workspace }, true);
    if (this.runner.get(loc.root)) await this.runner.stop(loc.root);
    return this.start(agentId, { workspace });
  }
  async clearConsole(agentId: string, input: unknown) {
    const { workspace } = z
      .object({ workspace: z.string() })
      .strict()
      .parse(input);
    const loc = await this.ws.location(agentId, { workspace });
    this.runner.clearConsole(loc.root);
    return { ok: true };
  }
  /** Returns undefined when the path is not a development-server route. */
  async route(
    method: string | undefined,
    path: string,
    readBody: () => Promise<unknown>,
  ): Promise<unknown> {
    const m =
      /^\/agents\/([^/]+)\/devserver\/(state|settings|start|stop|restart|clear-console)$/.exec(
        path,
      );
    if (!m || method !== "POST") return undefined;
    const agentId = decodeURIComponent(m[1]);
    this.team.store.get<Agent>("agent", agentId);
    const data = await readBody();
    switch (m[2]) {
      case "state":
        return this.state(agentId, data);
      case "settings":
        return this.save(agentId, data);
      case "start":
        return this.start(agentId, data);
      case "stop":
        return this.stop(agentId, data);
      case "restart":
        return this.restart(agentId, data);
      default:
        return this.clearConsole(agentId, data);
    }
  }
  async close() {
    await this.runner.closeAll();
    this.runner.dispose();
  }
}
export type { DevServerInfo };
