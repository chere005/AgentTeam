import { watch as fsWatch, type FSWatcher, type WatchEventType } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { decide, hasRestrictions } from "./access.ts";
import type { Agent } from "./model.ts";
import type { Store } from "./store.ts";
import type { WorkspaceService } from "./workspaces.ts";

/**
 * Keeps folder listings and Git status fresh after external edits without busy polling.
 *
 * Primary mechanism: one recursive `fs.watch` per subscribed workspace root, debounced into a
 * single `workspace.changed` event (quiet period, with a maximum wait so continuous writes still
 * notify). `.git` internals other than HEAD/index/ref changes and `node_modules` are ignored.
 * Fallback when `fs.watch` fails (inotify limits, unsupported FS): a bounded fingerprint poll at
 * a slow interval. Subscriptions are leases that expire unless renewed (checked on every event and
 * flush, and by one unref'd sweep timer, in both watch and poll mode), and the number of watched
 * roots is capped, so a closed UI cannot leave watchers behind.
 */
export type ChangeInfo = {
  root: string;
  mode: "watch" | "poll";
  paths: string[];
  git: boolean;
  at: string;
};
export type WatcherOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
  maxRoots?: number;
  leaseMs?: number;
  /** How often expired leases are swept (the sweep timer never keeps the process alive). */
  sweepMs?: number;
  /** Injection points for tests. */
  watch?: typeof fsWatch;
  fingerprint?: (root: string) => Promise<string>;
  /** Clock for lease expiry (tests use a fake one). */
  now?: () => number;
  onChange: (info: ChangeInfo) => void;
  /** Called when a subscription ends (expired, unsubscribed or closed). */
  onStop?: (root: string) => void;
};
type Entry = {
  root: string;
  mode: "watch" | "poll" | "off";
  watcher?: FSWatcher;
  poller?: NodeJS.Timeout;
  timer?: NodeJS.Timeout;
  firstPending?: number;
  pending: Set<string>;
  gitTouched: boolean;
  fingerprint?: string;
  expires: number;
  closed: boolean;
};
const PATH_CAP = 20;

const GIT_STATE =
  /^\.git[\\/](HEAD|index|MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|refs[\\/].*|rebase-(merge|apply)[\\/]?.*)$/;
/** Returns null to ignore an event, else whether it concerns Git state. */
export function classifyEvent(name: string | null): { git: boolean } | null {
  if (!name) return { git: false }; // unknown name: still a change
  const parts = name.split(/[\\/]/);
  if (parts.includes("node_modules")) return null;
  if (parts[0] === ".git")
    return GIT_STATE.test(name) && !name.endsWith(".lock")
      ? { git: true }
      : null;
  return { git: false };
}

/** Cheap bounded snapshot of names, sizes and mtimes (depth 3, 2000 entries) plus Git state files. */
export async function folderFingerprint(root: string): Promise<string> {
  const parts: string[] = [];
  let budget = 2000;
  const walk = async (dir: string, depth: number) => {
    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (budget-- <= 0) return;
      const full = join(dir, e.name);
      try {
        const s = await lstat(full);
        parts.push(`${full}:${s.size}:${Math.floor(s.mtimeMs)}`);
      } catch {
        continue;
      }
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
    }
  };
  await walk(root, 0);
  for (const f of ["HEAD", "index", "MERGE_HEAD"])
    try {
      const s = await lstat(join(root, ".git", f));
      parts.push(`git:${f}:${s.size}:${Math.floor(s.mtimeMs)}`);
    } catch {
      /* absent */
    }
  return parts.join("|");
}

export class WorkspaceWatcher {
  entries = new Map<string, Entry>();
  o: Required<Omit<WatcherOptions, "onChange" | "onStop">> &
    Pick<WatcherOptions, "onChange" | "onStop">;
  private sweeper?: NodeJS.Timeout;
  constructor(options: WatcherOptions) {
    this.o = {
      debounceMs: 300,
      maxWaitMs: 2000,
      pollMs: 5000,
      maxRoots: 12,
      leaseMs: 90_000,
      sweepMs: 30_000,
      watch: fsWatch,
      fingerprint: folderFingerprint,
      now: Date.now,
      ...options,
    };
  }
  private expired(entry: Entry) {
    if (entry.expires > this.o.now()) return false;
    this.stop(entry);
    return true;
  }
  /** Start or renew a subscription. Returns the mode actually in use. */
  subscribe(root: string): "watch" | "poll" | "off" {
    const existing = this.entries.get(root);
    if (existing && !existing.closed && !this.expired(existing)) {
      existing.expires = this.o.now() + this.o.leaseMs;
      return existing.mode;
    }
    this.expire();
    if (this.entries.size >= this.o.maxRoots) return "off";
    const entry: Entry = {
      root,
      mode: "off",
      pending: new Set(),
      gitTouched: false,
      expires: this.o.now() + this.o.leaseMs,
      closed: false,
    };
    this.entries.set(root, entry);
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.expire(), this.o.sweepMs);
      this.sweeper.unref();
    }
    try {
      entry.watcher = this.o.watch(
        root,
        { recursive: true, persistent: false },
        (_type: WatchEventType, name) =>
          this.event(entry, name?.toString() ?? null),
      );
      entry.watcher.on("error", () => this.fallBack(entry));
      entry.mode = "watch";
    } catch {
      this.fallBack(entry);
    }
    return entry.mode;
  }
  unsubscribe(root: string) {
    const entry = this.entries.get(root);
    if (entry) this.stop(entry);
  }
  /** Drop expired leases. Called on every subscribe; also exposed for tests and shutdown. */
  expire(now = this.o.now()) {
    for (const e of [...this.entries.values()])
      if (e.expires <= now) this.stop(e);
  }
  list() {
    return [...this.entries.values()].map((e) => ({
      root: e.root,
      mode: e.mode,
    }));
  }
  close() {
    for (const e of [...this.entries.values()]) this.stop(e);
  }
  private stop(entry: Entry) {
    if (entry.closed) return;
    entry.closed = true;
    entry.watcher?.close();
    clearInterval(entry.poller);
    clearTimeout(entry.timer);
    if (this.entries.get(entry.root) === entry) this.entries.delete(entry.root);
    if (!this.entries.size && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    this.o.onStop?.(entry.root);
  }
  private event(entry: Entry, name: string | null) {
    if (entry.closed || this.expired(entry)) return;
    const kind = classifyEvent(name);
    if (!kind) return;
    if (kind.git) entry.gitTouched = true;
    if (name && entry.pending.size < PATH_CAP) entry.pending.add(name);
    this.schedule(entry);
  }
  private schedule(entry: Entry) {
    const now = Date.now();
    entry.firstPending ??= now;
    clearTimeout(entry.timer);
    const wait = Math.max(
      0,
      Math.min(this.o.debounceMs, entry.firstPending + this.o.maxWaitMs - now),
    );
    entry.timer = setTimeout(() => this.flush(entry), wait);
  }
  private flush(entry: Entry) {
    if (entry.closed || this.expired(entry)) return;
    const info: ChangeInfo = {
      root: entry.root,
      mode: entry.mode === "poll" ? "poll" : "watch",
      paths: [...entry.pending],
      git: entry.gitTouched,
      at: new Date().toISOString(),
    };
    entry.pending.clear();
    entry.gitTouched = false;
    entry.firstPending = undefined;
    this.o.onChange(info);
  }
  private fallBack(entry: Entry) {
    if (entry.closed || entry.mode === "poll") return;
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.mode = "poll";
    let running = false;
    const tick = async () => {
      if (running || entry.closed) return;
      running = true;
      try {
        const next = await this.o.fingerprint(entry.root);
        if (entry.fingerprint !== undefined && next !== entry.fingerprint)
          this.event(entry, null);
        entry.fingerprint = next;
      } catch {
        /* a vanished folder is reported by the next listing request */
      } finally {
        running = false;
      }
    };
    void tick();
    entry.poller = setInterval(() => {
      if (this.expired(entry)) return;
      void tick();
    }, this.o.pollMs);
    entry.poller.unref();
  }
}

/** Service tying the watcher to agent folder access and the event stream. */
export class WatchService {
  watcher: WorkspaceWatcher;
  ws: WorkspaceService;
  store: Store;
  /** root -> agent ids subscribed (events go to each). */
  subscribers = new Map<string, Set<string>>();
  constructor(
    store: Store,
    ws: WorkspaceService,
    options: Partial<WatcherOptions> = {},
  ) {
    this.store = store;
    this.ws = ws;
    this.watcher = new WorkspaceWatcher({
      ...options,
      onStop: (root) => {
        this.subscribers.delete(root);
        options.onStop?.(root);
      },
      onChange: (info) => {
        for (const agentId of this.subscribers.get(info.root) ?? []) {
          const paths = this.visiblePaths(agentId, info.root, info.paths);
          // Only excluded files changed: nothing this agent may see, so no event (and no names).
          if (paths === null) continue;
          this.store.emit("workspace.changed", agentId, {
            workspace: info.root,
            mode: info.mode,
            git: info.git,
            paths,
          });
        }
      },
    });
  }
  /**
   * Changed names the agent may see under its attachment rules (src/access.ts); excluded file names
   * never reach the event stream. Null when every reported change was excluded and Git state did
   * not change.
   */
  visiblePaths(
    agentId: string,
    root: string,
    paths: string[],
  ): string[] | null {
    let ws: Agent["workspaces"][number] | undefined;
    try {
      ws = this.store
        .get<Agent>("agent", agentId)
        .workspaces.find((w) => w.path === root);
    } catch {
      return null;
    }
    if (!ws) return null; // detached since subscribing
    if (!hasRestrictions(ws)) return paths;
    const visible = paths.filter((p) => {
      const rel = p.replace(/\\/g, "/");
      if (rel.split("/")[0] === ".git") return true; // Git state names (HEAD, index, refs)
      return decide(ws, rel).access !== "none";
    });
    return paths.length &&
      !visible.length &&
      !paths.some((p) => p.startsWith(".git"))
      ? null
      : visible;
  }
  async subscribe(agentId: string, input: unknown) {
    const loc = await this.ws.location(agentId, input);
    const mode = this.watcher.subscribe(loc.root);
    if (mode !== "off") {
      let set = this.subscribers.get(loc.root);
      if (!set) this.subscribers.set(loc.root, (set = new Set()));
      set.add(agentId);
    }
    return {
      workspace: loc.root,
      mode,
      note:
        mode === "off"
          ? "Too many watched folders; use Refresh to update manually."
          : mode === "poll"
            ? "File watching is unavailable here; checking for changes every few seconds."
            : "Watching for external changes.",
    };
  }
  async unsubscribe(agentId: string, input: unknown) {
    const loc = await this.ws.location(agentId, input);
    const set = this.subscribers.get(loc.root);
    set?.delete(agentId);
    if (!set?.size) {
      this.subscribers.delete(loc.root);
      this.watcher.unsubscribe(loc.root);
    }
    return { workspace: loc.root, mode: "off" as const };
  }
  close() {
    this.watcher.close();
    this.subscribers.clear();
  }
}
