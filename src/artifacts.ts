import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { decideBoth, lexicalRelative } from "./access.ts";
import { isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Task,
  type Workflow,
} from "./model.ts";
import { allowedFor, sha256, type Actor } from "./shared-common.ts";
import { taskInputHash } from "./validation.ts";
import type { TeamService } from "./service.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";

export const ARTIFACT_KINDS = [
  "file",
  "report",
  "diff",
  "log",
  "wolfram-result",
] as const;
/** Largest file that can be registered (hashed by streaming). */
export const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
/** Largest inline artifact body stored in SQLite. */
export const MAX_INLINE_BYTES = 256 * 1024;
export const DEFAULT_PREVIEW_BYTES = 16 * 1024;
export const MAX_PREVIEW_BYTES = 256 * 1024;
export const MAX_ARTIFACTS_PER_WORKFLOW = 2000;

export type ArtifactSource =
  | {
      type: "file";
      /** Real path of the attached workspace root the file was confined to. */
      root: string;
      /** Path relative to that root. */
      path: string;
      /** Resolved real path at registration (symlinks followed and checked). */
      realPath: string;
      size: number;
      sha256: string;
      mtimeMs: number;
    }
  | { type: "inline"; text: string; size: number; sha256: string };

export type Provenance = {
  actor: Actor;
  agentId: string | null;
  taskId: string | null;
  /** `<taskId>#<attempt>`; set when the artifact came from a task run. */
  runId: string | null;
  /** Hashes of what the producing run depended on. */
  inputHashes: {
    task: string;
    dependencies: { taskId: string; resultHash: string }[];
    stateVersions: Record<string, number>;
  } | null;
};

export type Artifact = {
  id: string;
  workflowId: string;
  kind: (typeof ARTIFACT_KINDS)[number];
  title: string;
  description: string;
  source: ArtifactSource;
  /** Agent ids (or "*") allowed to see this artifact; the user always can. */
  readers: string[];
  provenance: Provenance;
  /** Immutable validation records (src/validation.ts) this artifact is evidence for or from. */
  validationIds: string[];
  createdAt: string;
};

export const artifactInputSchema = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    path: z.string().min(1).max(1024).optional(),
    root: z.string().min(1).max(4096).optional(),
    text: z.string().max(MAX_INLINE_BYTES).optional(),
    validationIds: z.array(z.string().min(1)).max(20).default([]),
    readers: z.array(z.string().min(1)).max(50).default(["*"]),
  })
  .strict()
  .refine((a) => (a.path === undefined) !== (a.text === undefined), {
    message:
      "Provide exactly one of `path` (a workspace file) or `text` (inline body)",
  });
export type ArtifactInput = z.infer<typeof artifactInputSchema>;

export type PreparedArtifact = {
  input: ArtifactInput;
  source: ArtifactSource;
};

const registerRequestSchema = z
  .object({
    agentId: z.string().optional(),
    taskId: z.string().optional(),
  })
  .passthrough();

/** Resolves a relative path inside one attached workspace root; rejects traversal and symlink escapes. */
export async function confineToWorkspace(rootPath: string, rel: string) {
  assert(
    rel.length > 0 && !rel.includes("\0") && !isAbsolute(rel),
    "invalid_path",
    "Use a path relative to the attached workspace (no absolute paths)",
    400,
  );
  const segments = rel.split(/[\\/]/);
  assert(
    !segments.includes(".."),
    "path_escape",
    "Path escapes the attached workspace",
    403,
  );
  assert(
    !segments.includes(".git"),
    "git_internal",
    "Direct access to Git internals is not supported",
    403,
  );
  let root: string;
  try {
    root = await realpath(rootPath);
  } catch {
    throw new AppError(
      409,
      "workspace_missing",
      "The attached workspace folder no longer exists; reattach it",
    );
  }
  assert(
    root === rootPath,
    "workspace_changed",
    "Workspace target changed; reattach it",
    409,
  );
  let real: string;
  try {
    real = await realpath(resolve(root, rel));
  } catch {
    throw new AppError(
      404,
      "not_found",
      `File not found in the workspace: ${rel}`,
    );
  }
  const back = relative(root, real);
  assert(
    back !== ".." && !/^\.\.[\\/]/.test(back) && !isAbsolute(back),
    "path_escape",
    "Path escapes the attached workspace (a symbolic link points outside it)",
    403,
  );
  assert(
    !back.split(/[\\/]/).includes(".git"),
    "git_internal",
    "Direct access to Git internals is not supported",
    403,
  );
  return { root, real, rel: back.split("\\").join("/") };
}

function hashFile(path: string) {
  return new Promise<string>((ok, fail) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (c) => h.update(c));
    s.on("error", fail);
    s.on("end", () => ok(h.digest("hex")));
  });
}

export class ArtifactRegistry {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
    // Registered artifacts are provenance evidence: forbid rewriting or deleting them.
    this.store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS artifact_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='artifact' BEGIN SELECT RAISE(ABORT,'artifacts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS artifact_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='artifact' BEGIN SELECT RAISE(ABORT,'artifacts are immutable'); END;
      CREATE INDEX IF NOT EXISTS artifact_workflow ON entities(json_extract(data,'$.workflowId')) WHERE kind='artifact';`);
  }
  private get store() {
    return this.service.store;
  }
  private roots(agentId: string) {
    return this.store.get<Agent>("agent", agentId).workspaces.map((w) => ({
      path: w.path,
      active: w.active,
      access: w.access,
      rules: w.rules,
      explicitOnly: w.explicitOnly,
    }));
  }
  /** Async part of registration: confine the path / measure the body. Nothing is persisted. */
  async prepare(
    agentId: string | null,
    raw: unknown,
  ): Promise<PreparedArtifact> {
    const parsed = artifactInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        422,
        "artifact_invalid",
        "Artifact rejected: " +
          parsed.error.issues
            .map((i) => `${i.path.join(".") || "(artifact)"}: ${i.message}`)
            .join("; "),
      );
    const input = parsed.data;
    if (input.text !== undefined) {
      const size = Buffer.byteLength(input.text);
      assert(
        size <= MAX_INLINE_BYTES,
        "artifact_too_large",
        `Inline artifact is ${size} bytes; the limit is ${MAX_INLINE_BYTES}. Save it as a workspace file and register the path instead.`,
        413,
      );
      return {
        input,
        source: {
          type: "inline",
          text: input.text,
          size,
          sha256: sha256(input.text),
        },
      };
    }
    assert(
      agentId,
      "agent_required",
      "File artifacts are confined to an agent's attached workspaces; name the producing agent or task",
      400,
    );
    const roots = this.roots(agentId);
    assert(
      roots.length > 0,
      "no_workspace",
      "The agent has no attached workspace, so no file can be registered; use an inline `text` artifact or attach a workspace",
      409,
    );
    const root = input.root
      ? roots.find((r) => r.path === input.root)
      : (roots.find((r) => r.active) ?? roots[0]);
    assert(
      root,
      "invalid_root",
      "`root` must be one of the agent's attached workspace paths",
      400,
    );
    filesystemPolicy(this.store).assertPath(root.path);
    const loc = await confineToWorkspace(root.path, input.path!);
    // Exclusions and explicit-only rules apply to artifact registration like to file browsing.
    const access = decideBoth(root, lexicalRelative(input.path!), loc.rel);
    assert(
      access.access !== "none",
      "access_denied",
      `Access denied: ${access.reason}`,
      403,
    );
    const info = await stat(loc.real);
    assert(
      info.isFile(),
      "not_file",
      "Only regular files can be registered as artifacts",
      400,
    );
    assert(
      info.size <= MAX_ARTIFACT_FILE_BYTES,
      "artifact_too_large",
      `File is ${info.size} bytes; the limit is ${MAX_ARTIFACT_FILE_BYTES}`,
      413,
    );
    return {
      input,
      source: {
        type: "file",
        root: loc.root,
        path: loc.rel,
        realPath: loc.real,
        size: info.size,
        sha256: await hashFile(loc.real),
        mtimeMs: info.mtimeMs,
      },
    };
  }
  /** Synchronous persistence step; safe inside the task-completion transaction. */
  save(
    workflowId: string,
    prepared: PreparedArtifact,
    provenance: Provenance,
  ): Artifact {
    const count = this.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM entities WHERE kind='artifact' AND json_extract(data,'$.workflowId')=?",
      )
      .get(workflowId);
    assert(
      Number(count?.n ?? 0) < MAX_ARTIFACTS_PER_WORKFLOW,
      "artifact_limit",
      `This workflow already has ${MAX_ARTIFACTS_PER_WORKFLOW} artifacts`,
      409,
    );
    for (const id of prepared.input.validationIds) {
      const v = this.service.validation.records().find((r) => r.id === id);
      assert(
        v,
        "validation_not_found",
        `Validation record ${id} does not exist; link only existing records from POST /tasks/:id/validations`,
        400,
      );
      assert(
        this.store.get<Task>("task", v.taskId).workflowId === workflowId,
        "validation_foreign",
        `Validation record ${id} belongs to another workflow`,
        400,
      );
    }
    const artifact: Artifact = {
      id: randomUUID(),
      workflowId,
      kind: prepared.input.kind,
      title: prepared.input.title,
      description: prepared.input.description,
      source: prepared.source,
      readers: [...new Set(prepared.input.readers)],
      provenance,
      validationIds: [...new Set(prepared.input.validationIds)],
      createdAt: new Date().toISOString(),
    };
    this.store.put("artifact", artifact);
    this.store.emit("artifact.registered", artifact.id, {
      workflowId,
      kind: artifact.kind,
      taskId: provenance.taskId,
      agentId: provenance.agentId,
    });
    return artifact;
  }
  /** HTTP/UI registration. Agent actors must own a running task of the workflow. */
  async register(workflowId: string, raw: unknown) {
    this.store.get<Workflow>("workflow", workflowId);
    const head = registerRequestSchema.parse(raw);
    const { agentId: bodyAgent, taskId, ...rest } = head;
    const task = taskId ? this.store.get<Task>("task", taskId) : null;
    if (task)
      assert(
        task.workflowId === workflowId,
        "task_workflow_mismatch",
        "Task belongs to another workflow",
        400,
      );
    const agentId = bodyAgent ?? task?.agentId ?? null;
    if (agentId) this.store.get<Agent>("agent", agentId);
    if (task && bodyAgent)
      assert(
        task.agentId === bodyAgent,
        "attribution_mismatch",
        "The task is assigned to a different agent",
        403,
      );
    const actor: Actor = bodyAgent
      ? { type: "agent", agentId: bodyAgent }
      : { type: "user" };
    if (bodyAgent)
      assert(
        task && task.status === "running",
        "task_not_running",
        "An agent can register artifacts only through its own running task (pass taskId)",
        403,
      );
    const prepared = await this.prepare(agentId, rest);
    return this.store.transaction(() =>
      this.save(
        workflowId,
        prepared,
        this.service.shared.provenance(task, actor),
      ),
    );
  }
  all(workflowId: string): Artifact[] {
    return this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='artifact' AND json_extract(data,'$.workflowId')=? ORDER BY rowid",
      )
      .all(workflowId)
      .map((r) => JSON.parse(String(r.data)));
  }
  private readable(a: Artifact, actor: Actor) {
    return (
      allowedFor(a.readers, actor) ||
      (actor.type === "agent" && a.provenance.agentId === actor.agentId)
    );
  }
  /** Listing view: no inline body, with live validation status for linked Wolfram evidence. */
  view(a: Artifact) {
    const { source, ...rest } = a;
    const validations = a.validationIds.map((id) => {
      try {
        const rec = this.service.validation.record(id);
        const task = this.store.get<Task>("task", rec.taskId);
        return {
          id,
          taskId: rec.taskId,
          status: rec.status,
          effectiveStatus: this.service.validation.effectiveStatus(
            rec,
            taskInputHash(this.store, task),
          ),
          kernelVersion: rec.kernel?.version ?? null,
        };
      } catch {
        return {
          id,
          taskId: null,
          status: "missing",
          effectiveStatus: "missing",
          kernelVersion: null,
        };
      }
    });
    return {
      ...rest,
      source:
        source.type === "inline"
          ? {
              type: "inline" as const,
              size: source.size,
              sha256: source.sha256,
            }
          : { ...source, realPath: undefined },
      validations,
      unvalidated: a.kind === "wolfram-result" && a.validationIds.length === 0,
    };
  }
  list(
    workflowId: string,
    actor: Actor,
    filter: { taskId?: string; kind?: string } = {},
  ) {
    this.store.get<Workflow>("workflow", workflowId);
    return this.all(workflowId)
      .filter((a) => this.readable(a, actor))
      .filter((a) => !filter.taskId || a.provenance.taskId === filter.taskId)
      .filter((a) => !filter.kind || a.kind === filter.kind)
      .map((a) => this.view(a));
  }
  get(id: string, actor: Actor) {
    const a = this.store.get<Artifact>("artifact", id);
    assert(
      this.readable(a, actor),
      "artifact_forbidden",
      "This artifact is not readable by that agent; add the agent to the artifact's readers",
      403,
    );
    return a;
  }
  /** Bounded text preview; re-confines files at read time so a swapped symlink cannot escape. */
  async preview(id: string, actor: Actor, maxBytes = DEFAULT_PREVIEW_BYTES) {
    const a = this.get(id, actor);
    const limit = Math.max(
      1,
      Math.min(MAX_PREVIEW_BYTES, Math.floor(maxBytes)),
    );
    if (a.source.type === "inline") {
      const bytes = Buffer.from(a.source.text);
      const shown = bytes.subarray(0, limit);
      return {
        id,
        kind: a.kind,
        binary: false,
        size: a.source.size,
        bytesShown: shown.length,
        truncated: bytes.length > limit,
        modifiedSinceRegistration: false,
        text: shown.toString("utf8"),
      };
    }
    const src = a.source;
    // An exclusion added after registration also hides the file's current content: the producing
    // agent's attachment rules are re-checked at read time (the record itself stays as evidence).
    if (a.provenance.agentId) {
      let attachment: Agent["workspaces"][number] | undefined;
      try {
        attachment = this.store
          .get<Agent>("agent", a.provenance.agentId)
          .workspaces.find((w) => w.path === src.root);
      } catch {
        /* agent removed: confinement below still applies */
      }
      if (attachment) {
        const access = decideBoth(attachment, src.path, src.path);
        assert(
          access.access !== "none",
          "access_denied",
          `Access denied: ${access.reason}`,
          403,
        );
      }
    }
    filesystemPolicy(this.store).assertPath(src.root);
    const loc = await confineToWorkspace(src.root, src.path);
    assert(
      loc.real === src.realPath,
      "artifact_moved",
      "The file now resolves somewhere else than when it was registered; refusing to read it",
      409,
    );
    const handle = await open(loc.real, "r");
    try {
      const info = await handle.stat();
      assert(info.isFile(), "not_file", "Not a regular file", 400);
      const buffer = Buffer.alloc(Math.min(limit, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const data = buffer.subarray(0, bytesRead);
      const whole = info.size <= limit;
      const modified = whole
        ? sha256(data) !== src.sha256
        : info.size !== src.size || info.mtimeMs !== src.mtimeMs;
      const binary = data.includes(0);
      return {
        id,
        kind: a.kind,
        binary,
        size: info.size,
        bytesShown: binary ? 0 : bytesRead,
        truncated: info.size > bytesRead,
        modifiedSinceRegistration: modified,
        text: binary ? "" : data.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }
}
