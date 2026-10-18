import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { AppError } from "./model.ts";

const exec = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Development-server process runner.
 *
 * Lifecycle: starting (spawned, waiting for the URL to answer) -> ready ->
 * stopping -> stopped | failed. A spawned process alone is never "ready";
 * readiness means an HTTP response from the configured URL. Every server runs
 * in its own process group (POSIX) or is stopped with `taskkill /T` (Windows)
 * so the whole tree goes away, including at application shutdown.
 */
export type DevState = "starting" | "ready" | "stopping" | "stopped" | "failed";

export type ConsoleEntry = {
  at: string;
  level: "warning" | "error";
  message: string;
  source: string;
  line: number;
};

export type DevServerInfo = {
  id: string;
  key: string;
  agentId: string;
  workspace: string;
  cwd: string;
  command: string;
  url: string;
  /** URL the preview should open (follows same-origin redirects). */
  previewUrl: string;
  state: DevState;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  readyAt: string | null;
  endedAt: string | null;
  log: string;
  logTruncated: boolean;
  /** Why the server failed, when state is failed. */
  failure: string | null;
  hints: string[];
  /** Server printed a different URL than the configured one. */
  detectedUrl: string | null;
  /** null until the first successful probe. */
  embeddable: boolean | null;
  embedNote: string | null;
  redirect: { to: string; sameOrigin: boolean } | null;
  checks: number;
  lastStatus: number | null;
};

export type StartOptions = {
  key: string;
  agentId: string;
  workspace: string;
  cwd: string;
  command: string;
  url: string;
  readyTimeoutMs?: number;
  graceMs?: number;
  onChange?: (info: DevServerInfo) => void;
};

type Entry = {
  info: DevServerInfo;
  child: ChildProcess;
  finalState: "stopped" | "failed";
  exitSeen: boolean;
  settled: Promise<void>;
  graceMs: number;
  consoleLog: ConsoleEntry[];
  onChange?: (info: DevServerInfo) => void;
};

const LOG_LIMIT = 64_000;
const CONSOLE_LIMIT = 200;
const ACTIVE: DevState[] = ["starting", "ready", "stopping"];
export const isActive = (state: DevState) => ACTIVE.includes(state);

const runners = new Set<DevServerRunner>();

const processGroupAlive = (pid: number) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
async function waitGone(pid: number, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!processGroupAlive(pid)) return true;
    await sleep(50);
  }
  return !processGroupAlive(pid);
}
/** Stops the whole tree rooted at pid; only ever signals our own group. */
export async function killTree(pid: number, graceMs = 3000) {
  if (process.platform === "win32") {
    await exec("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => {});
    return;
  }
  if (!processGroupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  if (await waitGone(pid, graceMs)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  await waitGone(pid, 3000);
}

function portInUse(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
/** True when something already accepts connections on the URL's port. */
export async function urlPortOccupied(url: string) {
  const u = new URL(url),
    port = Number(u.port);
  const hosts =
    u.hostname === "localhost"
      ? ["127.0.0.1", "::1"]
      : [u.hostname.replace(/^\[|\]$/g, "")];
  return (await Promise.all(hosts.map((h) => portInUse(h, port)))).some(
    Boolean,
  );
}

type Probe = {
  status: number;
  previewUrl: string;
  redirect: { to: string; sameOrigin: boolean } | null;
  embeddable: boolean;
  embedNote: string | null;
};
/** Polls once. Same-origin redirects are followed manually; off-origin ones are reported, not followed. */
export async function probeUrl(
  url: string,
  timeoutMs = 2000,
): Promise<Probe | null> {
  let current = url,
    redirect: Probe["redirect"] = null;
  const origin = new URL(url).origin;
  for (let hop = 0; hop < 6; hop++) {
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html,*/*" },
      });
      await response.body?.cancel().catch(() => {});
    } catch {
      return null;
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      const same = next.origin === origin;
      redirect = { to: next.toString(), sameOrigin: same };
      if (!same) {
        return {
          status: response.status,
          previewUrl: url,
          redirect,
          ...embedding(response.headers),
        };
      }
      current = next.toString();
      continue;
    }
    return {
      status: response.status,
      previewUrl: current,
      redirect,
      ...embedding(response.headers),
    };
  }
  return null;
}
function embedding(headers: Headers) {
  const xfo = headers.get("x-frame-options")?.toLowerCase().trim();
  const csp = headers.get("content-security-policy") ?? "";
  const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]*)/i.exec(csp)?.[1];
  if (xfo && xfo !== "allow-all")
    return {
      embeddable: false,
      embedNote: `The server sends X-Frame-Options: ${xfo}, so it refuses to be embedded.`,
    };
  if (ancestors !== undefined && !/(^|\s)\*(\s|$)/.test(ancestors))
    return {
      embeddable: false,
      embedNote: `The server sends Content-Security-Policy frame-ancestors ${ancestors.trim()}, so it refuses to be embedded.`,
    };
  return { embeddable: true, embedNote: null };
}

const PORT_PATTERN =
  /(?:https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d{2,5})\b/gi;
function detectedPorts(log: string) {
  const found: { host: string; port: number }[] = [];
  for (const m of log.matchAll(PORT_PATTERN)) {
    const port = Number(m[2]);
    if (port >= 1024 && port <= 65535) found.push({ host: m[1], port });
  }
  return found;
}
function classify(log: string, code: number | null, port: string) {
  if (
    /EADDRINUSE|address already in use|port .* (is )?(already )?in use/i.test(
      log,
    )
  )
    return `Port ${port} is already in use by another process. Choose another port or stop the process using it.`;
  if (
    /Cannot find (module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|command not found|is not recognized as an internal|Missing script|: not found|could not determine executable|Failed to resolve import|ENOENT.*node_modules/i.test(
      log,
    ) ||
    code === 127 ||
    code === 9009
  )
    return "A dependency or the command itself appears to be missing. Run the project's install command (for example npm install) or check the command, then start again.";
  return null;
}

export class DevServerRunner {
  entries = new Map<string, Entry>();
  constructor() {
    runners.add(this);
  }
  get(key: string) {
    return this.entries.get(key)?.info ?? null;
  }
  consoleEntries(key: string) {
    return this.entries.get(key)?.consoleLog ?? [];
  }
  clearConsole(key: string) {
    const e = this.entries.get(key);
    if (e) e.consoleLog.length = 0;
  }
  /** Active entries whose configured origin matches the given URL. */
  matchOrigin(url: string) {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return [];
    }
    return [...this.entries.values()].filter((e) => {
      try {
        return isActive(e.info.state) && new URL(e.info.url).origin === origin;
      } catch {
        return false;
      }
    });
  }
  private change(entry: Entry) {
    entry.onChange?.(entry.info);
  }
  async start(opts: StartOptions) {
    const existing = this.entries.get(opts.key);
    if (existing && isActive(existing.info.state))
      throw new AppError(
        409,
        "server_running",
        "Stop the existing server before starting another",
      );
    if (await urlPortOccupied(opts.url))
      throw new AppError(
        409,
        "port_in_use",
        `Port ${new URL(opts.url).port} is already accepting connections. Choose another port or stop whatever is using it; AgentTeam never kills processes it did not start.`,
      );
    const port = new URL(opts.url).port;
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env))
      if (!k.startsWith("AGENTTEAM_")) env[k] = v;
    Object.assign(env, {
      PORT: port,
      HOST: "127.0.0.1",
      HOSTNAME: "127.0.0.1",
      BROWSER: "none",
      FORCE_COLOR: "0",
    });
    const info: DevServerInfo = {
      id: randomUUID(),
      key: opts.key,
      agentId: opts.agentId,
      workspace: opts.workspace,
      cwd: opts.cwd,
      command: opts.command,
      url: opts.url,
      previewUrl: opts.url,
      state: "starting",
      pid: null,
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      readyAt: null,
      endedAt: null,
      log: `$ ${opts.command}\n`,
      logTruncated: false,
      failure: null,
      hints: [],
      detectedUrl: null,
      embeddable: null,
      embedNote: null,
      redirect: null,
      checks: 0,
      lastStatus: null,
    };
    // User-entered command, deliberately executed by the platform shell.
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    info.pid = child.pid ?? null;
    let markSettled: () => void = () => {};
    const entry: Entry = {
      info,
      child,
      finalState: "stopped",
      exitSeen: false,
      settled: new Promise<void>((r) => (markSettled = r)),
      graceMs: opts.graceMs ?? 3000,
      consoleLog: [],
      onChange: opts.onChange,
    };
    this.entries.set(opts.key, entry);
    let closed!: () => void;
    const closedPromise = new Promise<void>((r) => (closed = r));
    const append = (text: string) => {
      info.log += text;
      if (info.log.length > LOG_LIMIT) {
        info.log = info.log.slice(-LOG_LIMIT);
        info.logTruncated = true;
      }
    };
    child.stdout?.on("data", (c: Buffer) => append(c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => append(c.toString("utf8")));
    child.once("close", () => closed());
    const finish = async (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      if (entry.exitSeen) return;
      entry.exitSeen = true;
      info.exitCode = code;
      info.signal = signal;
      // Reap stragglers left in the group by a wrapper shell that exited.
      if (info.pid && process.platform !== "win32")
        await killTree(info.pid, 1500);
      await Promise.race([closedPromise, sleep(500)]);
      const early = info.state === "starting";
      if (info.state === "stopping") info.state = entry.finalState;
      else if (early || (code !== 0 && code !== null) || signal)
        info.state = "failed";
      else info.state = "stopped";
      if (info.state === "failed" && !info.failure) {
        const why = classify(info.log, code, port);
        info.failure = early
          ? `The process exited before the server became ready (exit ${code ?? signal}).`
          : `The server exited unexpectedly (exit ${code ?? signal}).`;
        if (why) info.hints.push(why);
      }
      info.endedAt = new Date().toISOString();
      this.change(entry);
      markSettled();
    };
    child.once("exit", (code, signal) => void finish(code, signal));
    child.once("error", (e) => {
      append("\n" + e.message + "\n");
      info.failure = "Could not start the command: " + e.message;
      if (!entry.exitSeen) void finish(null, null);
    });
    this.change(entry);
    void this.waitReady(entry, opts.readyTimeoutMs ?? 60_000);
    return info;
  }
  private async terminate(entry: Entry, final: "stopped" | "failed") {
    const { info } = entry;
    if (!isActive(info.state) || info.state === "stopping") {
      await entry.settled;
      return;
    }
    entry.finalState = final;
    info.state = "stopping";
    this.change(entry);
    if (info.pid && !entry.exitSeen) await killTree(info.pid, entry.graceMs);
    await entry.settled;
  }
  private async waitReady(entry: Entry, timeoutMs: number) {
    const { info } = entry;
    const deadline = Date.now() + timeoutMs;
    const port = new URL(info.url).port;
    const fail = async (message: string) => {
      if (info.state !== "starting") return;
      info.failure = message;
      await this.terminate(entry, "failed");
    };
    while (info.state === "starting" && !entry.exitSeen) {
      const probe = await probeUrl(info.url);
      info.checks++;
      if (info.state !== "starting" || entry.exitSeen) return;
      info.lastStatus = probe?.status ?? null;
      if (probe && probe.status < 500) {
        info.state = "ready";
        info.readyAt = new Date().toISOString();
        info.previewUrl = probe.previewUrl;
        info.redirect = probe.redirect;
        info.embeddable = probe.embeddable;
        info.embedNote = probe.embedNote;
        if (probe.redirect && !probe.redirect.sameOrigin)
          info.hints.push(
            `The URL redirects to ${probe.redirect.to}, outside the configured origin. The embedded preview stays on ${new URL(info.url).origin}; use Open in browser for the redirect target.`,
          );
        else if (probe.redirect)
          info.hints.push(`The URL redirects to ${probe.redirect.to}.`);
        if (/\b0\.0\.0\.0:|\[::\]:/.test(info.log))
          info.hints.push(
            "The server reports listening on all network interfaces. It ignored HOST=127.0.0.1; configure it to bind to 127.0.0.1 only.",
          );
        this.change(entry);
        return;
      }
      if (/EADDRINUSE|address already in use/i.test(info.log))
        return fail(
          classify(info.log, null, port) ?? `Port ${port} is already in use.`,
        );
      const other = detectedPorts(info.log).find(
        (d) => String(d.port) !== port,
      );
      if (other) {
        const host = /^\[?::/.test(other.host)
          ? "[::1]"
          : other.host === "0.0.0.0"
            ? "127.0.0.1"
            : other.host;
        const candidate = `http://${host}:${other.port}/`;
        if (await probeUrl(candidate, 1500)) {
          info.detectedUrl = candidate;
          return fail(
            `The server ignored PORT=${port} and is listening on ${candidate}. Make the command honor PORT (for example pass a --port flag) or use the detected URL.`,
          );
        }
      }
      if (Date.now() > deadline) {
        info.hints.push(
          `No HTTP response from ${info.url} within ${Math.round(timeoutMs / 1000)} seconds${probe ? " (last status " + probe.status + ")" : ""}. Check the URL and port, and whether the server honors PORT and HOST.`,
        );
        return fail("The server did not become ready in time.");
      }
      await sleep(250);
    }
  }
  /** Stop the whole process tree and resolve once it is gone. */
  async stop(key: string) {
    const entry = this.entries.get(key);
    if (!entry)
      throw new AppError(404, "server_missing", "No development server");
    if (isActive(entry.info.state)) await this.terminate(entry, "stopped");
    return entry.info;
  }
  async closeAll() {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => isActive(e.info.state))
        .map((e) => this.terminate(e, "stopped").catch(() => {})),
    );
  }
  activeCount() {
    return [...this.entries.values()].filter((e) => isActive(e.info.state))
      .length;
  }
  dispose() {
    runners.delete(this);
  }
}

/** Stops every development-server tree owned by this process (application shutdown). */
export async function shutdownDevServers() {
  await Promise.all([...runners].map((r) => r.closeAll()));
}
export function liveDevServerCount() {
  return [...runners].reduce((n, r) => n + r.activeCount(), 0);
}
// Last resort if the process exits without a graceful shutdown: synchronously
// kill the groups we started. Only our own process groups are signalled.
process.on("exit", () => {
  if (process.platform === "win32") return;
  for (const r of runners)
    for (const e of r.entries.values())
      if (isActive(e.info.state) && e.info.pid && !e.exitSeen)
        try {
          process.kill(-e.info.pid, "SIGKILL");
        } catch {}
});

/** Origins the embedded preview may navigate to: those of active configured servers. */
export function previewNavigationAllowed(url: string) {
  if (url === "about:blank") return true;
  return [...runners].some((r) => r.matchOrigin(url).length > 0);
}
/** Records a console message from an embedded preview frame (called by the desktop shell). */
export function recordPreviewConsole(
  frameUrl: string,
  level: string,
  message: string,
  source: string,
  line: number,
) {
  if (level !== "error" && level !== "warning") return false;
  let hit = false;
  for (const r of runners)
    for (const e of r.matchOrigin(frameUrl)) {
      hit = true;
      e.consoleLog.push({
        at: new Date().toISOString(),
        level,
        message: message.slice(0, 2000),
        source: source.slice(0, 500),
        line,
      });
      if (e.consoleLog.length > CONSOLE_LIMIT)
        e.consoleLog.splice(0, e.consoleLog.length - CONSOLE_LIMIT);
    }
  return hit;
}
