import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { decide, traversable } from "./access.ts";
import { AppError, assert, type Agent } from "./model.ts";
import { Redactor } from "./redact.ts";
import type { Store } from "./store.ts";

/**
 * Knowledge sources: reference material (not instructions, not actions) from folders already attached
 * to an agent. A simple local lexical index: no embeddings, no network, no dependency.
 *
 * Access control: a source's folder must lie inside a workspace attached to the owning agent (agent
 * scope) or inside a workspace attached to some agent (project scope); every query re-checks that the
 * asking agent still has a workspace containing the folder, so detaching a folder revokes access.
 * Symlinks are never followed, dotfiles/secret-looking files are skipped and secret-shaped text is
 * redacted before it is indexed. Indexed text is untrusted DATA and is labelled that way wherever it is
 * handed to a model.
 */
export const LIMITS = {
  files: 400,
  fileBytes: 200_000,
  totalBytes: 2_000_000,
  depth: 8,
  chunkChars: 1200,
  chunkLines: 40,
  directories: 2000,
} as const;
const TEXT_EXTENSIONS = new Set(
  (
    ".md .markdown .txt .rst .adoc .json .yaml .yml .toml .csv .wl .m .wls .py .ts .tsx .js .jsx .mjs .cjs " +
    ".java .kt .go .rs .c .h .cpp .hpp .cs .swift .rb .php .sql .sh .html .css .xml"
  ).split(" "),
);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
]);
const SECRET_FILE =
  /^(\.env|id_rsa|id_ed25519|id_ecdsa)|\.(pem|key|p12|pfx|keystore|jks)$|secret|credential|passw(or)?d|\.npmrc$|\.netrc$/i;
export type KnowledgeScope =
  { kind: "agent"; agentId: string } | { kind: "project" };
export type KnowledgeSource = {
  id: string;
  name: string;
  scope: KnowledgeScope;
  /** Canonical folder path. */
  folder: string;
  /** Include relevant snippets (as untrusted, cited data) in runs of agents that can access it. */
  include: boolean;
  createdAt: string;
};
export type IndexedFile = {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  chunks: number;
};
export type Chunk = {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
};
export type KnowledgeIndex = {
  id: string;
  sourceId: string;
  status: "indexing" | "ready" | "failed";
  startedAt: string;
  indexedAt: string | null;
  files: IndexedFile[];
  chunks: Chunk[];
  bytes: number;
  truncated: boolean;
  skipped: Record<string, number>;
  error: string | null;
};
export type Citation = {
  sourceId: string;
  source: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  indexedAt: string | null;
  /** The file changed (or vanished) after it was indexed. */
  stale: boolean;
  label: string;
};
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    folder: z.string().min(1).max(2000),
    scope: z.enum(["agent", "project"]).default("agent"),
    include: z.boolean().default(false),
  })
  .strict();
const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    include: z.boolean().optional(),
  })
  .strict();
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const samePath = (a: string, b: string) => {
  const key = (value: string) => {
    if (process.platform === "win32")
      return value
        .replace(/^\\\\\?\\/, "")
        .replaceAll("/", "\\")
        .replace(/\\+$/, "")
        .toLowerCase();
    return resolve(value);
  };
  return key(a) === key(b);
};
/**
 * Whether one of `agent`'s attachments containing `abs` (canonical) grants it under the attachment's
 * file rules and exclusions (src/access.ts). Directories also count when they only lead to an
 * allowed path. Used both when indexing and on every query, so a new exclusion hides indexed text.
 */
export function visibleToAgent(agent: Agent, abs: string, dir = false) {
  return agent.workspaces.some((w) => {
    if (!inside(w.path, abs)) return false;
    const rel = relative(w.path, abs).split(sep).join("/");
    if (rel.split("/").some((p) => p.toLowerCase() === ".git")) return false;
    return decide(w, rel).access !== "none" || (dir && traversable(w, rel));
  });
}
export class KnowledgeBase {
  store: Store;
  running = new Set<string>();
  constructor(store: Store) {
    this.store = store;
  }
  private agent(id: string) {
    return this.store.get<Agent>("agent", id);
  }
  sources() {
    return this.store.list<KnowledgeSource>("knowledge-source");
  }
  source(id: string) {
    return this.store.get<KnowledgeSource>("knowledge-source", id);
  }
  index(sourceId: string): KnowledgeIndex | null {
    try {
      const idx = this.store.get<KnowledgeIndex>("knowledge-index", sourceId);
      // An index left "indexing" by a crash is reported as failed instead of spinning forever.
      if (
        idx.status === "indexing" &&
        !this.running.has(sourceId) &&
        Date.now() - Date.parse(idx.startedAt) > 5 * 60_000
      )
        return { ...idx, status: "failed", error: "Indexing did not finish" };
      return idx;
    } catch {
      return null;
    }
  }
  /** Canonical attached workspace roots of an agent (missing folders are ignored). */
  private async roots(agent: Agent) {
    const out: string[] = [];
    for (const w of agent.workspaces)
      try {
        out.push(await realpath(w.path));
      } catch {
        /* detached/missing */
      }
    return out;
  }
  /** Whether `agent` may use `source` right now. */
  async access(agent: Agent, source: KnowledgeSource) {
    if (source.scope.kind === "agent" && source.scope.agentId !== agent.id)
      return { ok: false as const, reason: "Owned by another agent" };
    let folder: string;
    try {
      folder = await realpath(source.folder);
    } catch {
      return { ok: false as const, reason: "Folder no longer exists" };
    }
    if (folder !== source.folder)
      return {
        ok: false as const,
        reason: "Folder path changed (symlink or move)",
      };
    const roots = await this.roots(agent);
    return roots.some((r) => inside(r, folder)) &&
      visibleToAgent(agent, folder, true)
      ? { ok: true as const, reason: "" }
      : {
          ok: false as const,
          reason: "Folder is not inside a folder attached to this agent",
        };
  }
  async create(agentId: string, input: unknown) {
    const data = createSchema.parse(input);
    const agent = this.agent(agentId);
    assert(
      isAbsolute(data.folder),
      "invalid_path",
      "Folder must be an absolute path",
      400,
    );
    let folder: string;
    try {
      folder = await realpath(data.folder);
      assert(
        (await stat(folder)).isDirectory(),
        "invalid_path",
        "Not a directory",
        400,
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, "invalid_path", "Folder does not exist");
    }
    const roots = await this.roots(agent);
    assert(
      roots.some((r) => inside(r, folder)),
      "folder_not_attached",
      "Knowledge folders must be inside a folder attached to this agent",
      403,
    );
    assert(
      visibleToAgent(agent, folder, true),
      "access_denied",
      "This folder is excluded by the attachment's access rules",
      403,
    );
    const source: KnowledgeSource = {
      id: randomUUID(),
      name: data.name,
      scope:
        data.scope === "agent"
          ? { kind: "agent", agentId }
          : { kind: "project" },
      folder,
      include: data.include,
      createdAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.store.put("knowledge-source", source);
      this.store.emit("knowledge.source_added", source.id, {
        agentId,
        name: source.name,
        scope: source.scope.kind,
      });
    });
    await this.refresh(source.id, agentId);
    return this.view(source.id);
  }
  update(id: string, input: unknown) {
    const patch = patchSchema.parse(input);
    const source = { ...this.source(id), ...patch };
    this.store.put("knowledge-source", source);
    this.store.emit("knowledge.source_updated", id, patch);
    return this.view(id);
  }
  remove(id: string) {
    const source = this.source(id);
    this.store.transaction(() => {
      this.store.remove("knowledge-source", id);
      this.store.remove("knowledge-index", id);
      this.store.emit("knowledge.source_removed", id, { name: source.name });
    });
  }
  view(id: string) {
    const source = this.source(id);
    const idx = this.index(id);
    return {
      ...source,
      status: idx?.status ?? "not-indexed",
      indexedAt: idx?.indexedAt ?? null,
      files: idx?.files.length ?? 0,
      chunks: idx?.chunks.length ?? 0,
      bytes: idx?.bytes ?? 0,
      truncated: idx?.truncated ?? false,
      skipped: idx?.skipped ?? {},
      error: idx?.error ?? null,
      limits: LIMITS,
    };
  }
  /** Sources an agent may see (own + project scope), with whether access currently holds. */
  async listFor(agentId: string) {
    const agent = this.agent(agentId);
    const out = [];
    for (const s of this.sources()) {
      if (s.scope.kind === "agent" && s.scope.agentId !== agentId) continue;
      const a = await this.access(agent, s);
      out.push({ ...this.view(s.id), access: a });
    }
    return out;
  }
  /** (Re)build the index. `by` is the agent whose access is checked (the owner by default). */
  async refresh(id: string, by?: string) {
    const source = this.source(id);
    const owner =
      by ?? (source.scope.kind === "agent" ? source.scope.agentId : null);
    if (owner) {
      const a = await this.access(this.agent(owner), source);
      assert(a.ok, "knowledge_access_denied", a.reason, 403);
    } else {
      // Project scope: the folder must still be attached to at least one agent.
      let allowed = false;
      for (const a of this.store.list<Agent>("agent"))
        if ((await this.access(a, source)).ok) {
          allowed = true;
          break;
        }
      assert(
        allowed,
        "knowledge_access_denied",
        "Folder is not attached to any agent",
        403,
      );
    }
    assert(
      !this.running.has(id),
      "index_in_progress",
      "Indexing is already running",
      409,
    );
    this.running.add(id);
    const startedAt = new Date().toISOString();
    this.store.put("knowledge-index", {
      id,
      sourceId: id,
      status: "indexing",
      startedAt,
      indexedAt: null,
      files: [],
      chunks: [],
      bytes: 0,
      truncated: false,
      skipped: {},
      error: null,
    } satisfies KnowledgeIndex);
    this.store.emit("knowledge.index_started", id, { name: source.name });
    // Never index what the attachment rules exclude: for an agent-scoped source the owner's rules,
    // for a project source what at least one agent may see (queries filter per agent again).
    const viewers = owner
      ? [this.agent(owner)]
      : this.store.list<Agent>("agent");
    const allowed = (abs: string, dir: boolean) =>
      viewers.some((a) => visibleToAgent(a, abs, dir));
    let result: KnowledgeIndex;
    try {
      result = {
        ...(await buildIndex(source.folder, allowed)),
        id,
        sourceId: id,
        startedAt,
      };
    } catch (e) {
      result = {
        id,
        sourceId: id,
        status: "failed",
        startedAt,
        indexedAt: null,
        files: [],
        chunks: [],
        bytes: 0,
        truncated: false,
        skipped: {},
        error: e instanceof Error ? e.message.slice(0, 300) : "Indexing failed",
      };
    } finally {
      this.running.delete(id);
    }
    // The source may have been removed while indexing; do not resurrect its index.
    try {
      this.source(id);
    } catch {
      return result;
    }
    this.store.transaction(() => {
      this.store.put("knowledge-index", result);
      this.store.emit("knowledge.index_finished", id, {
        status: result.status,
        files: result.files.length,
        chunks: result.chunks.length,
        bytes: result.bytes,
        truncated: result.truncated,
        error: result.error,
      });
    });
    return result;
  }
  /** Ranked passages with citations from the sources `agentId` may currently access. */
  async search(
    agentId: string,
    query: string,
    options: { limit?: number; onlyIncluded?: boolean } = {},
  ): Promise<Citation[]> {
    const agent = this.agent(agentId);
    const terms = tokenize(query);
    if (!terms.length) return [];
    const usable: { source: KnowledgeSource; index: KnowledgeIndex }[] = [];
    for (const source of this.sources()) {
      if (source.scope.kind === "agent" && source.scope.agentId !== agentId)
        continue;
      if (options.onlyIncluded && !source.include) continue;
      const index = this.index(source.id);
      if (!index || index.status !== "ready") continue;
      if (!(await this.access(agent, source)).ok) continue;
      usable.push({ source, index });
    }
    // Rules may have changed since indexing: re-check every file against the asking agent's rules.
    const all = usable.flatMap((u) =>
      u.index.chunks
        .filter((chunk) =>
          visibleToAgent(
            agent,
            join(u.source.folder, ...chunk.file.split("/")),
          ),
        )
        .map((chunk) => ({ ...u, chunk })),
    );
    if (!all.length) return [];
    const docFrequency = new Map<string, number>();
    const tokenized = all.map((x) => {
      const counts = new Map<string, number>();
      for (const t of tokenize(x.chunk.text))
        counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of new Set(terms))
        if (counts.has(t)) docFrequency.set(t, (docFrequency.get(t) ?? 0) + 1);
      return counts;
    });
    const scored = all
      .map((x, i) => {
        let score = 0;
        for (const t of new Set(terms)) {
          const tf = tokenized[i].get(t) ?? 0;
          if (!tf) continue;
          const idf = Math.log(1 + all.length / (docFrequency.get(t) ?? 1));
          score += (1 + Math.log(tf)) * idf;
        }
        if (x.chunk.file.toLowerCase().includes(terms[0])) score *= 1.2;
        return { x, score };
      })
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || a.x.chunk.file.localeCompare(b.x.chunk.file),
      )
      .slice(0, Math.max(1, Math.min(options.limit ?? 5, 20)));
    const out: Citation[] = [];
    for (const { x, score } of scored) {
      const meta = x.index.files.find((f) => f.path === x.chunk.file);
      out.push({
        sourceId: x.source.id,
        source: x.source.name,
        file: x.chunk.file,
        startLine: x.chunk.startLine,
        endLine: x.chunk.endLine,
        score: Math.round(score * 100) / 100,
        snippet: x.chunk.text.slice(0, 600),
        indexedAt: x.index.indexedAt,
        stale: meta ? await changedSince(x.source.folder, meta) : true,
        label: `${x.source.name}/${x.chunk.file}:${x.chunk.startLine}-${x.chunk.endLine}`,
      });
    }
    return out;
  }
}
const STOP = new Set(
  "the a an and or of to in is are was for on with as by be this that it at from".split(
    " ",
  ),
);
export function tokenize(text: string) {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter(
    (t) => !STOP.has(t),
  );
}
async function changedSince(folder: string, file: IndexedFile) {
  try {
    const path = join(folder, ...file.path.split("/"));
    const info = await lstat(path);
    return (
      info.isSymbolicLink() ||
      info.size !== file.size ||
      Math.floor(info.mtimeMs) !== Math.floor(file.mtimeMs)
    );
  } catch {
    return true;
  }
}
async function readHead(path: string, max: number) {
  // O_NOFOLLOW: a file swapped for a symlink after the directory listing is not followed (POSIX).
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
export async function buildIndex(
  folder: string,
  allowed: (abs: string, dir: boolean) => boolean = () => true,
): Promise<Omit<KnowledgeIndex, "id" | "sourceId" | "startedAt">> {
  const redactor = new Redactor({ env: {}, maxString: 10_000_000 });
  const files: IndexedFile[] = [];
  const chunks: Chunk[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
  let bytes = 0,
    truncated = false,
    visited = 0;
  const walk = async (directory: string, depth: number) => {
    if (truncated) return;
    if (depth > LIMITS.depth || ++visited > LIMITS.directories) {
      truncated = true;
      return;
    }
    let entries;
    try {
      // A directory swapped for a symlink after it was listed must not lead outside the folder.
      if (!samePath(await realpath(directory), directory)) {
        skip("symlink");
        return;
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skip("unreadable");
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skip("symlink");
        continue;
      }
      if (entry.name.startsWith(".")) {
        skip("hidden");
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) skip("excluded folder");
        else if (!allowed(path, true)) skip("access rules");
        else await walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = entry.name.includes(".")
        ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase()
        : "";
      if (!TEXT_EXTENSIONS.has(ext)) {
        skip("unsupported type");
        continue;
      }
      if (SECRET_FILE.test(entry.name)) {
        skip("secret-looking name");
        continue;
      }
      if (!allowed(path, false)) {
        skip("access rules");
        continue;
      }
      if (files.length >= LIMITS.files) {
        truncated = true;
        return;
      }
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (info.size > LIMITS.fileBytes) {
        skip("too large");
        continue;
      }
      if (bytes + info.size > LIMITS.totalBytes) {
        truncated = true;
        return;
      }
      let head: Buffer;
      try {
        head = await readHead(path, info.size);
      } catch {
        skip("unreadable");
        continue;
      }
      if (head.subarray(0, 4096).includes(0)) {
        skip("binary");
        continue;
      }
      const text = redactor.string(head.toString("utf8"));
      const rel = relative(folder, path).split(sep).join("/");
      const made = chunkText(rel, text);
      bytes += info.size;
      files.push({
        path: rel,
        size: info.size,
        mtimeMs: info.mtimeMs,
        sha256: createHash("sha256").update(head).digest("hex"),
        chunks: made.length,
      });
      chunks.push(...made);
    }
  };
  await walk(folder, 0);
  return {
    status: "ready",
    indexedAt: new Date().toISOString(),
    files,
    chunks,
    bytes,
    truncated,
    skipped,
    error: null,
  };
}
export function chunkText(file: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const out: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start,
      size = 0;
    while (
      end < lines.length &&
      end - start < LIMITS.chunkLines &&
      size + lines[end].length + 1 <= LIMITS.chunkChars
    ) {
      size += lines[end].length + 1;
      end++;
    }
    if (end === start) end = start + 1; // a single very long line
    const body = lines.slice(start, end).join("\n");
    if (body.trim())
      out.push({
        file,
        startLine: start + 1,
        endLine: end,
        text: body.slice(0, LIMITS.chunkChars),
      });
    start = end;
  }
  return out;
}
