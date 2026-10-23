import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { assert, type Agent } from "./model.ts";
import type { Store } from "./store.ts";

export type FilesystemBlock = {
  id: string;
  path: string;
  canonicalPath: string;
  createdAt: string;
};
const normalize = (path: string) =>
  resolve(path).replace(/[\\/]+$/, "") || resolve(path);
const covers = (root: string, path: string) => {
  // Conservatively case-insensitive on every platform; case variants never weaken a deny.
  const a = normalize(root).toLowerCase(),
    b = normalize(path).toLowerCase();
  const prefix = a.replace(/[\\/]+$/, "");
  return a === b || b.startsWith(prefix + "/") || b.startsWith(prefix + "\\");
};
export function canonicalPolicyPath(path: string): string {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(relative(parent, current));
      current = parent;
    }
  }
}
const policies = new WeakMap<Store, FilesystemPolicy>();
export function filesystemPolicy(store: Store) {
  let policy = policies.get(store);
  if (!policy) {
    policy = new FilesystemPolicy(store);
    policies.set(store, policy);
  }
  return policy;
}

/** Global, append-only denials. No approval, template or agent mutation can remove a block. */
export class FilesystemPolicy {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS filesystem_blocks_no_update BEFORE UPDATE ON entities WHEN OLD.kind='filesystem-block' BEGIN SELECT RAISE(ABORT, 'filesystem blocks are permanent'); END;
      CREATE TRIGGER IF NOT EXISTS filesystem_blocks_no_delete BEFORE DELETE ON entities WHEN OLD.kind='filesystem-block' BEGIN SELECT RAISE(ABORT, 'filesystem blocks are permanent'); END;`);
  }
  blocks() {
    return this.store.list<FilesystemBlock>("filesystem-block");
  }
  paths() {
    return this.blocks().flatMap((b) => [b.path, b.canonicalPath]);
  }
  assertPath(path: string, subtree = true) {
    // Lexical denial precedes filesystem resolution, including for a disconnected blocked drive.
    const blocks = this.blocks();
    const check = (candidate: string) =>
      assert(
        !blocks.some((b) =>
          [b.path, b.canonicalPath].some(
            (root) =>
              covers(root, candidate) || (subtree && covers(candidate, root)),
          ),
        ),
        "filesystem_blocked",
        "Access is permanently blocked by the global filesystem policy; approvals cannot override it",
        403,
      );
    check(path);
    if (blocks.length) check(canonicalPolicyPath(path));
  }
  assertAgent(agent: Agent) {
    for (const ws of agent.workspaces) this.assertPath(ws.path);
  }
  assertConfinedExecution() {
    assert(
      this.blocks().length === 0,
      "filesystem_sandbox_required",
      "Global filesystem blocks are active. This operation launches an external process without an enforceable filesystem sandbox and cannot be approved",
      403,
    );
  }
  add(input: unknown) {
    const data = z
      .object({
        paths: z.array(z.string().min(1).max(4096)).min(1).max(128),
        acknowledgePermanent: z.literal(true),
      })
      .strict()
      .parse(input);
    const running = ["task", "session", "graph-run", "dev-server"].some(
      (kind) =>
        this.store
          .list<{ status?: string; state?: string }>(kind)
          .some((r) =>
            [r.status, r.state].some(
              (v) => v === "running" || v === "starting",
            ),
          ),
    );
    assert(
      !running,
      "filesystem_policy_busy",
      "Stop active tasks, conversations, workflow commands and development servers before adding a global block",
      409,
    );
    const paths = data.paths.map((path) => {
      assert(
        isAbsolute(path) &&
          !/[\0\r\n]/.test(path) &&
          !path.includes("*") &&
          !path.includes("?"),
        "invalid_block_path",
        "Enter an absolute drive or folder path without wildcards",
        400,
      );
      return { path: resolve(path), canonicalPath: canonicalPolicyPath(path) };
    });
    this.store.transaction(() => {
      for (const entry of paths) {
        if (this.blocks().some((b) => covers(b.path, entry.path))) continue;
        const block = {
          id: randomUUID(),
          ...entry,
          createdAt: new Date().toISOString(),
        };
        this.store.put("filesystem-block", block);
        this.store.emit("filesystem.blocked", block.id, { path: block.path });
      }
    });
    return { blocks: this.blocks() };
  }
}
