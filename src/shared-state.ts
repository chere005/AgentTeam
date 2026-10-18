import { z } from "zod";
import {
  AppError,
  assert,
  type Agent,
  type Task,
  type Workflow,
} from "./model.ts";
import {
  allowedFor,
  canonical,
  clip,
  hardClip,
  issueLines,
  sliceCodePoints,
  sha256,
  untrusted,
  UNTRUSTED_NOTICE,
  type Actor,
} from "./shared-common.ts";
import type { PreparedArtifact, Provenance } from "./artifacts.ts";
import { taskInputHash } from "./validation.ts";
import type { TeamService } from "./service.ts";

/**
 * Typed shared workflow state.
 *
 *  - `state-field`   mutable definition: kind, zod-compiled schema, per-agent readers/writers.
 *  - `state-change`  append-only history (SQLite triggers forbid update/delete). The current value of
 *                    a field is its newest change; there is no separate mutable copy to drift.
 *  - `task-state-config` per task: persisted vs fresh memory, selected inputs, context budget.
 *  - `state-run`     per task attempt: the versions the run started from (conflict base) and a
 *                    summary/hash of the context it was given.
 *
 * Writes are optimistic: callers say which version they based the write on and a stale base is
 * rejected with an error naming the current version and who changed it. Checkpoints (src/checkpoints.ts)
 * embed the field versions at each boundary, so any checkpoint can restore state by appending
 * `restore` changes; history is never rewritten.
 */
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_FIELDS_PER_WORKFLOW = 200;
export const MAX_SCHEMA_NODES = 100;
export const MAX_SCHEMA_DEPTH = 6;
export const KINDS = ["decision", "requirement", "output", "handoff"] as const;
export type Kind = (typeof KINDS)[number];
export const DEFAULT_CONTEXT_CHARS = 24_000;
export const DEFAULT_DEPENDENCY_CHARS = 8_000;
export const FIELD_CONTEXT_CHARS = 4_000;
export const BLOCK_LANG = "agentteam-state";
/** Room kept for the notice, summary and section headings of the prompt context. */
const CONTEXT_HEADER_RESERVE = 900;
/** Upper bound for the "how to write shared state" help, all writable fields together. */
const WRITE_HELP_CHARS = 6_000;
/** Upper bound for one field's schema description in that help. */
const SCHEMA_HINT_CHARS = 300;

export const keySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,63}$/,
    "use lowercase letters, digits and - (start with a letter, max 64)",
  );

// ---- declarative field schemas (serializable; compiled to zod) ---------------------------------
export type FieldSchema =
  | { type: "string"; minLength?: number; maxLength?: number }
  | { type: "number"; min?: number; max?: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "enum"; values: string[] }
  | { type: "array"; items: FieldSchema; maxItems?: number }
  | {
      type: "object";
      properties: Record<string, FieldSchema>;
      optional?: string[];
    };
export const fieldSchemaZ: z.ZodType<FieldSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("string"),
        minLength: z.number().int().min(0).max(20000).optional(),
        maxLength: z.number().int().min(1).max(20000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("number"),
        min: z.number().optional(),
        max: z.number().optional(),
        integer: z.boolean().optional(),
      })
      .strict(),
    z.object({ type: z.literal("boolean") }).strict(),
    z
      .object({
        type: z.literal("enum"),
        values: z.array(z.string().min(1).max(200)).min(1).max(50),
      })
      .strict(),
    z
      .object({
        type: z.literal("array"),
        items: fieldSchemaZ,
        maxItems: z.number().int().min(1).max(1000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("object"),
        properties: z.record(z.string().min(1).max(64), fieldSchemaZ),
        optional: z.array(z.string()).optional(),
      })
      .strict(),
  ]),
) as z.ZodType<FieldSchema>;

function measure(s: FieldSchema, depth = 1): { nodes: number; depth: number } {
  let nodes = 1,
    d = depth;
  const kids =
    s.type === "array"
      ? [s.items]
      : s.type === "object"
        ? Object.values(s.properties)
        : [];
  for (const k of kids) {
    const m = measure(k, depth + 1);
    nodes += m.nodes;
    d = Math.max(d, m.depth);
  }
  return { nodes, depth: d };
}
export function compileSchema(s: FieldSchema): z.ZodType {
  switch (s.type) {
    case "string":
      return z
        .string()
        .min(s.minLength ?? 0)
        .max(s.maxLength ?? 20000);
    case "number": {
      let n = s.integer ? z.number().int() : z.number();
      if (s.min !== undefined) n = n.min(s.min);
      if (s.max !== undefined) n = n.max(s.max);
      return n;
    }
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(s.values as [string, ...string[]]);
    case "array":
      return z.array(compileSchema(s.items)).max(s.maxItems ?? 1000);
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const [k, v] of Object.entries(s.properties))
        shape[k] = s.optional?.includes(k)
          ? compileSchema(v).optional()
          : compileSchema(v);
      return z.object(shape).strict();
    }
  }
}
export function describeSchema(s: FieldSchema): string {
  switch (s.type) {
    case "string":
      return "string";
    case "number":
      return s.integer ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "enum":
      return s.values.map((v) => JSON.stringify(v)).join("|");
    case "array":
      return `[${describeSchema(s.items)}]`;
    case "object":
      return `{${Object.entries(s.properties)
        .map(
          ([k, v]) =>
            `${k}${s.optional?.includes(k) ? "?" : ""}: ${describeSchema(v)}`,
        )
        .join(", ")}}`;
  }
}
const str = (max = 2000, min = 0): FieldSchema => ({
  type: "string",
  minLength: min,
  maxLength: max,
});
const optionalOf = (
  props: Record<string, FieldSchema>,
  optional: string[],
): FieldSchema => ({ type: "object", properties: props, optional });
export const BUILTIN_SCHEMAS: Record<Kind, FieldSchema> = {
  decision: optionalOf(
    {
      decision: str(2000, 1),
      rationale: str(8000),
      status: {
        type: "enum",
        values: ["proposed", "accepted", "rejected", "superseded"],
      },
    },
    ["rationale", "status"],
  ),
  requirement: optionalOf(
    {
      text: str(4000, 1),
      priority: { type: "enum", values: ["must", "should", "could"] },
      status: { type: "enum", values: ["open", "met", "dropped"] },
    },
    ["priority", "status"],
  ),
  output: optionalOf(
    {
      summary: str(20000, 1),
      artifactIds: { type: "array", items: str(100), maxItems: 50 },
    },
    ["artifactIds"],
  ),
  handoff: optionalOf(
    {
      summary: str(8000, 1),
      to: str(200),
      openQuestions: { type: "array", items: str(1000), maxItems: 50 },
      nextSteps: { type: "array", items: str(1000), maxItems: 50 },
    },
    ["to", "openQuestions", "nextSteps"],
  ),
};

export const fieldInputSchema = z
  .object({
    kind: z.enum(KINDS),
    description: z.string().max(1000).default(""),
    schema: fieldSchemaZ.nullable().default(null),
    readers: z.array(z.string().min(1)).max(100).default(["*"]),
    writers: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict();

export type FieldDef = {
  id: string;
  workflowId: string;
  key: string;
  kind: Kind;
  description: string;
  schema: FieldSchema | null;
  readers: string[];
  writers: string[];
  definitionVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type StateChange = {
  id: string;
  workflowId: string;
  key: string;
  version: number;
  previousVersion: number;
  value: unknown;
  valueHash: string;
  cleared: boolean;
  type: "write" | "restore";
  actor: Actor;
  agentId: string | null;
  taskId: string | null;
  runId: string | null;
  note: string;
  restoredFromVersion?: number;
  checkpointId?: string;
  createdAt: string;
};

export const taskConfigSchema = z
  .object({
    memory: z.enum(["persisted", "fresh"]).default("persisted"),
    /** Subset of state fields to show; default every field the agent may read. */
    stateKeys: z.array(keySchema).max(50).optional(),
    /** Selected dependency outputs with per-input caps; default all dependencies at the default cap. */
    inputs: z
      .array(
        z
          .object({
            taskId: z.string().min(1),
            maxChars: z
              .number()
              .int()
              .min(200)
              .max(50_000)
              .default(DEFAULT_DEPENDENCY_CHARS),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    includeArtifacts: z.boolean().default(true),
    maxContextChars: z
      .number()
      .int()
      .min(1000)
      .max(100_000)
      .default(DEFAULT_CONTEXT_CHARS),
    /** Fields the task must write via its structured output, or it fails with an actionable error. */
    requiredWrites: z.array(keySchema).max(50).default([]),
  })
  .strict();
export type TaskStateConfig = z.infer<typeof taskConfigSchema> & { id: string };

const writeItemSchema = z
  .object({
    key: keySchema,
    value: z.unknown(),
    expectedVersion: z.number().int().min(0).optional(),
    note: z.string().max(500).default(""),
  })
  .strict();
const outputBlockSchema = z
  .object({
    writes: z.array(writeItemSchema).max(50).default([]),
    artifacts: z.array(z.unknown()).max(20).default([]),
  })
  .strict();

export type Prepared = {
  hasBlock: boolean;
  writes: {
    key: string;
    value: unknown;
    expectedVersion: number | null;
    note: string;
  }[];
  artifacts: PreparedArtifact[];
};

const conflict = (message: string) =>
  new AppError(409, "state_conflict", message);
const invalid = (code: string, message: string) =>
  new AppError(422, code, message);

export class SharedStateService {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
    this.store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS state_change_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='state-change' BEGIN SELECT RAISE(ABORT,'state history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS state_change_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='state-change' BEGIN SELECT RAISE(ABORT,'state history is immutable'); END;
      CREATE INDEX IF NOT EXISTS state_change_field ON entities(json_extract(data,'$.workflowId'), json_extract(data,'$.key')) WHERE kind='state-change';`);
  }
  private get store() {
    return this.service.store;
  }

  // ---- field definitions ---------------------------------------------------------------------
  fields(workflowId: string): FieldDef[] {
    return this.store
      .list<FieldDef>("state-field")
      .filter((f) => f.workflowId === workflowId);
  }
  field(workflowId: string, key: string): FieldDef {
    const found = this.fields(workflowId).find((f) => f.key === key);
    if (!found) {
      const known = this.fields(workflowId).map((f) => f.key);
      throw new AppError(
        404,
        "state_field_unknown",
        `Field "${key}" is not defined for this workflow. Defined fields: ${known.length ? known.join(", ") : "(none)"}. Define it with PUT /workflows/:id/state/fields/${key}.`,
      );
    }
    return found;
  }
  effectiveSchema(def: FieldDef): FieldSchema {
    return def.schema ?? BUILTIN_SCHEMAS[def.kind];
  }
  defineField(workflowId: string, key: string, input: unknown): FieldDef {
    keySchema.parse(key);
    const data = fieldInputSchema.parse(input);
    this.store.get<Workflow>("workflow", workflowId);
    if (data.schema) {
      const m = measure(data.schema);
      assert(
        m.nodes <= MAX_SCHEMA_NODES && m.depth <= MAX_SCHEMA_DEPTH,
        "state_schema_too_complex",
        `Field schema may have at most ${MAX_SCHEMA_NODES} nodes and depth ${MAX_SCHEMA_DEPTH} (got ${m.nodes} nodes, depth ${m.depth})`,
        400,
      );
      if (data.schema.type === "object")
        for (const o of data.schema.optional ?? [])
          assert(
            o in data.schema.properties,
            "state_schema_invalid",
            `optional lists unknown property "${o}"`,
            400,
          );
    }
    for (const id of [...data.readers, ...data.writers])
      if (id !== "*") this.store.get<Agent>("agent", id);
    return this.store.transaction(() => {
      const existing = this.fields(workflowId).find((f) => f.key === key);
      assert(
        existing || this.fields(workflowId).length < MAX_FIELDS_PER_WORKFLOW,
        "state_field_limit",
        `A workflow may define at most ${MAX_FIELDS_PER_WORKFLOW} state fields`,
        409,
      );
      const now = new Date().toISOString();
      const def: FieldDef = {
        id: `${workflowId}:${key}`,
        workflowId,
        key,
        kind: data.kind,
        description: data.description,
        schema: data.schema,
        readers: [...new Set(data.readers)],
        writers: [...new Set(data.writers)],
        definitionVersion: (existing?.definitionVersion ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const head = this.head(workflowId, key);
      if (head && !head.cleared) {
        const r = compileSchema(this.effectiveSchema(def)).safeParse(
          head.value,
        );
        if (!r.success)
          throw conflict(
            `Cannot change the schema of "${key}": its current value (version ${head.version}) would no longer be valid (${issueLines(r.error)}). Write a compatible value first, or keep the old schema.`,
          );
      }
      this.store.put("state-field", def);
      this.store.emit("state.field.defined", def.id, {
        workflowId,
        key,
        kind: def.kind,
        definitionVersion: def.definitionVersion,
        readers: def.readers,
        writers: def.writers,
      });
      return def;
    });
  }

  // ---- history and heads -----------------------------------------------------------------------
  head(workflowId: string, key: string): StateChange | undefined {
    const row = this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='state-change' AND json_extract(data,'$.workflowId')=? AND json_extract(data,'$.key')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(workflowId, key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private change(
    workflowId: string,
    key: string,
    version: number,
  ): StateChange | undefined {
    try {
      return this.store.get<StateChange>(
        "state-change",
        `${workflowId}:${key}:${version}`,
      );
    } catch {
      return undefined;
    }
  }
  private canRead(def: FieldDef, actor: Actor) {
    return allowedFor(def.readers, actor) || allowedFor(def.writers, actor);
  }
  private actorOf(agentId?: string | null): Actor {
    if (!agentId) return { type: "user" };
    this.store.get<Agent>("agent", agentId);
    return { type: "agent", agentId };
  }
  actor(agentId?: string | null) {
    return this.actorOf(agentId);
  }
  private fieldView(def: FieldDef) {
    const head = this.head(def.workflowId, def.key);
    return {
      ...def,
      effectiveSchema: this.effectiveSchema(def),
      version: head?.version ?? 0,
      value: head && !head.cleared ? head.value : null,
      valueHash: head?.valueHash ?? null,
      updatedBy: head
        ? {
            actor: head.actor,
            taskId: head.taskId,
            runId: head.runId,
            at: head.createdAt,
            type: head.type,
          }
        : null,
    };
  }
  view(workflowId: string, actor: Actor) {
    this.store.get<Workflow>("workflow", workflowId);
    return {
      workflowId,
      fields: this.fields(workflowId)
        .filter((d) => this.canRead(d, actor))
        .map((d) => this.fieldView(d)),
    };
  }
  read(workflowId: string, key: string, actor: Actor) {
    const def = this.field(workflowId, key);
    assert(
      this.canRead(def, actor),
      "state_read_denied",
      `Agent may not read "${key}" (readers: ${def.readers.join(", ") || "(none)"}). Ask the workflow owner to add it to the field's readers.`,
      403,
    );
    return this.fieldView(def);
  }
  history(workflowId: string, key: string, actor: Actor, limit = 100) {
    this.read(workflowId, key, actor);
    const rows = this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='state-change' AND json_extract(data,'$.workflowId')=? AND json_extract(data,'$.key')=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(workflowId, key, Math.max(1, Math.min(500, Math.floor(limit))))
      .map((r) => JSON.parse(String(r.data)) as StateChange);
    return rows.reverse();
  }

  // ---- writes ----------------------------------------------------------------------------------
  /** Validates and appends one change. Throws actionable errors; call inside a transaction for batches. */
  write(input: {
    workflowId: string;
    key: string;
    value: unknown;
    expectedVersion: number;
    actor: Actor;
    taskId?: string | null;
    note?: string;
  }): StateChange {
    const { workflowId, key, actor } = input;
    return this.store.transaction(() => {
      const def = this.field(workflowId, key);
      let task: Task | null = null;
      if (actor.type === "agent") {
        assert(
          allowedFor(def.writers, actor),
          "state_write_denied",
          `Agent may not write "${key}" (writers: ${def.writers.join(", ") || "(none; only the user may write it)"}). Ask the workflow owner to add the agent to the field's writers.`,
          403,
        );
        assert(
          input.taskId,
          "state_attribution_required",
          "Agent writes must name the running task they belong to (taskId) so the change is attributed to a task and run",
          400,
        );
      }
      if (input.taskId) {
        task = this.store.get<Task>("task", input.taskId);
        assert(
          task.workflowId === workflowId,
          "task_workflow_mismatch",
          "Task belongs to another workflow",
          400,
        );
        if (actor.type === "agent") {
          assert(
            task.agentId === actor.agentId,
            "attribution_mismatch",
            "The task is assigned to a different agent",
            403,
          );
          assert(
            task.status === "running",
            "task_not_running",
            `Task is ${task.status}; an agent writes shared state only while its task is running`,
            409,
          );
        }
      }
      const value = this.validateValue(def, input.value);
      const head = this.head(workflowId, key);
      const current = head?.version ?? 0;
      if (input.expectedVersion !== current) {
        const by = head
          ? `by ${head.actor.type === "agent" ? "agent " + head.actor.agentId : head.actor.type}${head.taskId ? " (task " + head.taskId + ")" : ""} at ${head.createdAt}`
          : "";
        throw conflict(
          `Write to "${key}" rejected: it is based on version ${input.expectedVersion} but the current version is ${current}${by ? ", last changed " + by : ""}. Nothing was overwritten. Re-read the field, merge your change into the current value (${head ? "hash " + head.valueHash.slice(0, 12) : "unset"}) and write again with expectedVersion ${current}.`,
        );
      }
      const valueHash = sha256(canonical(value));
      if (head && !head.cleared && head.valueHash === valueHash) return head; // idempotent replay
      return this.append({
        workflowId,
        key,
        version: current + 1,
        previousVersion: current,
        value,
        valueHash,
        cleared: false,
        type: "write",
        actor,
        agentId: actor.type === "agent" ? actor.agentId : null,
        taskId: task?.id ?? null,
        runId: task ? this.runId(task) : null,
        note: input.note ?? "",
      });
    });
  }
  private append(c: Omit<StateChange, "id" | "createdAt">): StateChange {
    const change: StateChange = {
      ...c,
      id: `${c.workflowId}:${c.key}:${c.version}`,
      createdAt: new Date().toISOString(),
    };
    this.store.put("state-change", change);
    this.store.emit("state.changed", change.id, {
      workflowId: change.workflowId,
      key: change.key,
      version: change.version,
      type: change.type,
      agentId: change.agentId,
      taskId: change.taskId,
    });
    return change;
  }
  private validateValue(def: FieldDef, raw: unknown) {
    const text = canonical(raw);
    assert(
      Buffer.byteLength(text) <= MAX_VALUE_BYTES,
      "state_value_too_large",
      `Value for "${def.key}" is ${Buffer.byteLength(text)} bytes; the limit is ${MAX_VALUE_BYTES}. Store large content as an artifact and keep only a summary or its id in state.`,
      413,
    );
    const schema = this.effectiveSchema(def);
    const r = compileSchema(schema).safeParse(raw);
    if (!r.success)
      throw invalid(
        "state_schema_invalid",
        `Value for "${def.key}" (${def.kind}) does not match its schema ${describeSchema(schema)}: ${issueLines(r.error)}. Nothing was written.`,
      );
    return r.data;
  }

  // ---- checkpoint integration -----------------------------------------------------------------
  /** Field versions right now; embedded in every checkpoint so recovery can restore them. */
  snapshot(workflowId: string) {
    const versions: Record<string, number> = {};
    for (const d of this.fields(workflowId))
      versions[d.key] = this.head(workflowId, d.key)?.version ?? 0;
    return { versions, digest: sha256(canonical(versions)) };
  }
  planRestore(workflowId: string, checkpointId: string) {
    const cp = this.store.get<{
      workflowId: string;
      taskId: string;
      seq: number;
      data: { state?: { versions?: Record<string, number> } };
    }>("checkpoint", checkpointId);
    assert(
      cp.workflowId === workflowId,
      "checkpoint_workflow_mismatch",
      "That checkpoint belongs to another workflow",
      400,
    );
    const target = cp.data.state?.versions;
    assert(
      target,
      "checkpoint_without_state",
      "This checkpoint was recorded before shared state existed, so it has nothing to restore",
      409,
    );
    const steps = this.fields(workflowId)
      .map((d) => {
        const to = target[d.key] ?? 0;
        const head = this.head(workflowId, d.key);
        const from = head?.version ?? 0;
        // Compare content, not version numbers: a restore bumps versions but may change nothing.
        const want = to === 0 ? undefined : this.change(workflowId, d.key, to);
        const same =
          to === from ||
          ((!head || head.cleared) && (!want || want.cleared)) ||
          (!!head &&
            !!want &&
            !head.cleared &&
            !want.cleared &&
            head.valueHash === want.valueHash);
        return { key: d.key, from, to, same };
      })
      .filter((s) => !s.same)
      .map(({ key, from, to }) => ({ key, from, to }));
    return { checkpointId, taskId: cp.taskId, seq: cp.seq, steps };
  }
  /** Appends `restore` changes that bring fields back to a checkpoint's versions. History is kept. */
  restore(workflowId: string, input: unknown, actor: Actor = { type: "user" }) {
    const data = z
      .object({
        checkpointId: z.string().min(1),
        expectedVersions: z
          .record(z.string(), z.number().int().min(0))
          .optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const plan = this.planRestore(workflowId, data.checkpointId);
      for (const [key, expected] of Object.entries(
        data.expectedVersions ?? {},
      )) {
        const now = this.head(workflowId, key)?.version ?? 0;
        if (now !== expected)
          throw conflict(
            `Restore rejected: "${key}" is at version ${now}, not ${expected}. Review the new changes and restore again.`,
          );
      }
      const applied: StateChange[] = [];
      for (const s of plan.steps) {
        const src =
          s.to === 0 ? undefined : this.change(workflowId, s.key, s.to);
        assert(
          s.to === 0 || src,
          "restore_source_missing",
          `Version ${s.to} of "${s.key}" is missing from history`,
          500,
        );
        applied.push(
          this.append({
            workflowId,
            key: s.key,
            version: s.from + 1,
            previousVersion: s.from,
            value: src ? src.value : null,
            valueHash: src ? src.valueHash : sha256(canonical(null)),
            cleared: !src || src.cleared,
            type: "restore",
            actor,
            agentId: null,
            taskId: null,
            runId: null,
            note: `Restored to version ${s.to} from checkpoint ${plan.checkpointId}`,
            restoredFromVersion: s.to,
            checkpointId: plan.checkpointId,
          }),
        );
      }
      this.store.emit("state.restored", workflowId, {
        checkpointId: plan.checkpointId,
        keys: applied.map((c) => c.key),
      });
      return { checkpointId: plan.checkpointId, restored: applied };
    });
  }
  /** Fields that moved since a checkpoint (shown to resumed runs so they re-read before writing). */
  driftSince(workflowId: string, checkpointVersions: Record<string, number>) {
    return this.fields(workflowId)
      .map((d) => {
        const head = this.head(workflowId, d.key);
        return {
          key: d.key,
          from: checkpointVersions[d.key] ?? 0,
          to: head?.version ?? 0,
          by: head?.agentId ?? head?.actor.type ?? null,
        };
      })
      .filter((s) => s.from !== s.to);
  }

  // ---- task config, runs and provenance -------------------------------------------------------
  config(taskId: string): TaskStateConfig {
    try {
      return this.store.get<TaskStateConfig>("task-state-config", taskId);
    } catch {
      return { id: taskId, ...taskConfigSchema.parse({}) };
    }
  }
  setConfig(taskId: string, input: unknown) {
    const data = taskConfigSchema.parse(input);
    const task = this.store.get<Task>("task", taskId);
    assert(
      ["queued", "interrupted", "blocked", "failed"].includes(task.status),
      "task_started",
      `Task is ${task.status}; change its state/context settings before it starts or while it is waiting to be retried`,
      409,
    );
    for (const i of data.inputs ?? [])
      assert(
        task.dependsOn.includes(i.taskId),
        "input_not_dependency",
        `Input ${i.taskId} is not one of the task's dependencies; only dependency outputs can be passed downstream`,
        400,
      );
    const cfg: TaskStateConfig = { id: taskId, ...data };
    this.store.put("task-state-config", cfg);
    this.store.emit("task.state-config", taskId, { memory: cfg.memory });
    return cfg;
  }
  runId(task: Task) {
    return `${task.id}#${this.service.recovery.state(task.id).attempt}`;
  }
  private runState(taskId: string) {
    try {
      return this.store.get<{
        id: string;
        runId: string;
        fresh: boolean;
        versions: Record<string, number>;
        context: { chars: number; hash: string; summary: string };
      }>("state-run", taskId);
    } catch {
      return null;
    }
  }
  provenance(task: Task | null, actor: Actor): Provenance {
    if (!task)
      return {
        actor,
        agentId: actor.type === "agent" ? actor.agentId : null,
        taskId: null,
        runId: null,
        inputHashes: null,
      };
    const run = this.runState(task.id);
    return {
      actor,
      agentId: actor.type === "agent" ? actor.agentId : task.agentId,
      taskId: task.id,
      runId: this.runId(task),
      inputHashes: {
        task: taskInputHash(this.store, task),
        dependencies: task.dependsOn.map((id) => ({
          taskId: id,
          resultHash: sha256(this.store.get<Task>("task", id).result ?? ""),
        })),
        stateVersions: run?.versions ?? this.snapshot(task.workflowId).versions,
      },
    };
  }

  /**
   * Called as a task run starts: records the versions the run is based on and returns the prompt
   * context (selected dependency outputs, readable state, artifacts), every part labelled untrusted.
   */
  beginRun(task: Task, opts: { replay?: boolean } = {}) {
    const cfg = this.config(task.id);
    const fresh = cfg.memory === "fresh";
    const built = this.buildContext(task, cfg);
    const prior = this.runState(task.id);
    // A replayed run reuses the provider output of the original run, so its writes were based on
    // the versions that run saw: keep those as the conflict base. Re-recording them now would let a
    // replay silently overwrite state that changed after the original run started.
    if (opts.replay && prior && prior.runId === this.runId(task)) return built;
    const versions = this.snapshot(task.workflowId).versions;
    this.store.put("state-run", {
      id: task.id,
      runId: this.runId(task),
      fresh,
      versions,
      startedAt: new Date().toISOString(),
      context: {
        chars: built.text.length,
        hash: sha256(built.text),
        summary: built.summary,
      },
    });
    return built;
  }
  /** What a task's prompt would contain right now (used by the preview route and tests). */
  previewContext(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    return this.buildContext(task, this.config(taskId));
  }

  private buildContext(task: Task, cfg: TaskStateConfig) {
    const fresh = cfg.memory === "fresh";
    const actor: Actor = { type: "agent", agentId: task.agentId };
    const max = cfg.maxContextChars;
    // Every line that ends up in the text is charged against this budget; the joined text is then
    // hard-clipped to `max` as a final guarantee (hardClip), so no input can grow the prompt past it.
    let budget = max - Math.min(CONTEXT_HEADER_RESERVE, Math.floor(max * 0.3));
    const fits = (n: number) => budget - n >= 0;
    const spend = (text: string) => {
      budget -= text.length + 2;
      return text;
    };
    const defs = this.fields(task.workflowId);
    // 0. Write instructions are built first (schema text is bounded per field and in total) so they
    //    are never crowded out by data and never grow the context past its cap.
    const writable = defs.filter((d) => allowedFor(d.writers, actor));
    let writeText = "";
    if (writable.length || cfg.requiredWrites.length) {
      const cap = Math.min(
        WRITE_HELP_CHARS,
        Math.max(400, Math.floor(max / 4)),
      );
      const head =
        `To record shared state, end your reply with one fenced block tagged ${BLOCK_LANG} containing JSON {"writes":[{"key","value","expectedVersion"}],"artifacts":[{"kind","title","path"|"text"}]}. ` +
        (cfg.requiredWrites.length
          ? `Required: ${cfg.requiredWrites.join(", ")}. `
          : "") +
        "Fields you may write: ";
      const items: string[] = [];
      let used = head.length + 2;
      for (const d of writable) {
        const schema = clip(
          describeSchema(this.effectiveSchema(d)),
          SCHEMA_HINT_CHARS,
        ).text.replace(/\n/g, " ");
        const item = `${d.key} (${d.kind}, current version ${this.head(task.workflowId, d.key)?.version ?? 0}, value ${schema})`;
        if (used + item.length + 2 > cap - 120) break;
        used += item.length + 2;
        items.push(item);
      }
      const rest = writable.length - items.length;
      writeText = sliceCodePoints(
        head +
          (items.length ? items.join("; ") : "(none)") +
          (rest > 0
            ? `; ${rest} more writable field(s) not listed (read their schemas with GET /workflows/:id/state).`
            : "."),
        cap,
      );
      spend(writeText);
    }
    // 1. Dependency outputs (selected, size-limited).
    const selected =
      cfg.inputs ??
      task.dependsOn.map((taskId) => ({
        taskId,
        maxChars: DEFAULT_DEPENDENCY_CHARS,
      }));
    const deps: string[] = [];
    let truncatedDeps = 0,
      droppedDeps = 0;
    for (const sel of selected) {
      let dep: Task;
      try {
        dep = this.store.get<Task>("task", sel.taskId);
      } catch {
        continue;
      }
      const result = dep.result ?? "";
      const attrs = {
        task: dep.id,
        title: dep.title,
        status: dep.status,
        chars: String(result.length),
        sha256: sha256(result).slice(0, 12),
      };
      const cap = Math.max(0, Math.min(sel.maxChars, budget - 600));
      if (cap < 200 && result.length) {
        truncatedDeps++;
        const line = untrusted(
          "dependency-result",
          { ...attrs, omitted: "true" },
          `(omitted: context budget of ${max} characters is used up)`,
        );
        if (!fits(line.length + 2)) {
          droppedDeps++;
          continue;
        }
        deps.push(spend(line));
        continue;
      }
      const c = clip(result, cap);
      if (c.truncated) truncatedDeps++;
      const block = untrusted(
        "dependency-result",
        { ...attrs, truncated: String(c.truncated) },
        c.text,
      );
      if (!fits(block.length + 2)) {
        truncatedDeps++;
        droppedDeps++;
        continue;
      }
      deps.push(spend(block));
    }
    if (droppedDeps)
      deps.push(
        spend(
          `- ${droppedDeps} more dependency output(s) omitted (context budget used up)`,
        ),
      );
    const unselected = Math.max(0, task.dependsOn.length - selected.length);
    // 2. Shared state the agent may read (skipped for fresh-memory runs).
    const stateLines: string[] = [];
    let stateShown = 0,
      stateReadable = 0,
      stateDropped = 0;
    if (!fresh) {
      for (const d of defs) {
        if (!this.canRead(d, actor)) continue;
        if (cfg.stateKeys && !cfg.stateKeys.includes(d.key)) continue;
        stateReadable++;
        const head = this.head(task.workflowId, d.key);
        let line: string,
          shown = false;
        if (!head || head.cleared)
          line = `- ${d.key} (${d.kind}) version 0: not set`;
        else {
          const cap = Math.max(0, Math.min(FIELD_CONTEXT_CHARS, budget - 600));
          if (cap < 100)
            line = `- ${d.key} (${d.kind}) version ${head.version}: omitted (context budget used up)`;
          else {
            const c = clip(JSON.stringify(head.value), cap);
            line = untrusted(
              "state-field",
              {
                key: d.key,
                "field-kind": d.kind,
                version: String(head.version),
                by: head.agentId ?? head.actor.type,
                truncated: String(c.truncated),
              },
              c.text,
            );
            shown = true;
          }
        }
        // Keep room for the closing count line.
        if (!fits(line.length + 2 + 100)) {
          stateDropped++;
          continue;
        }
        stateLines.push(spend(line));
        if (shown) stateShown++;
      }
      if (stateDropped)
        stateLines.push(
          spend(
            `- ${stateDropped} more readable field(s) omitted (context budget used up)`,
          ),
        );
    }
    // 3. Artifacts produced upstream (metadata only; content is previewed through the API).
    const artifactLines: string[] = [];
    if (!fresh && cfg.includeArtifacts) {
      const all = this.service.artifacts
        .all(task.workflowId)
        .filter(
          (a) =>
            allowedFor(a.readers, actor) ||
            a.provenance.agentId === task.agentId,
        )
        .slice(-20);
      for (const a of all) {
        const line = `- [${String(a.kind).slice(0, 40)}] ${sliceCodePoints(a.title.replace(/[\r\n]/g, " "), 120)} (id ${a.id}, ${a.source.type === "file" ? sliceCodePoints(a.source.path, 200) : "inline"}, ${a.source.size} bytes, sha256 ${a.source.sha256.slice(0, 12)}, by task ${a.provenance.taskId ?? "user"})`;
        if (!fits(line.length + 1 + 200)) break;
        budget -= line.length + 1;
        artifactLines.push(line);
      }
    }
    // 4. Bounded workflow metadata (no task results or instructions; skipped for fresh memory).
    let overview = "";
    if (!fresh) {
      const wf = this.store.get<Workflow>("workflow", task.workflowId);
      const counts: Record<string, number> = {};
      for (const t of this.store.list<Task>("task"))
        if (t.workflowId === task.workflowId)
          counts[t.status] = (counts[t.status] ?? 0) + 1;
      const block = untrusted(
        "workflow",
        { workflow: wf.id },
        `name: ${clip(wf.name, 200).text}\ngoal: ${clip(wf.goal, 1000).text}\ntasks by status: ${
          Object.entries(counts)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "none"
        }`,
      );
      if (fits(block.length + 40)) overview = spend(block);
    }
    // 5. Drift since this task's own last checkpoint, so a resumed run re-reads before writing.
    const notes: string[] = [];
    if (!fresh) {
      const last = this.service.recovery.latest(task.id);
      const was = (
        last?.data as
          { state?: { versions?: Record<string, number> } } | undefined
      )?.state?.versions;
      if (
        was &&
        last &&
        [
          "task.requeued",
          "task.interrupted",
          "task.blocked",
          "task.failed",
        ].includes(last.boundary)
      ) {
        const drift = this.driftSince(task.workflowId, was).filter((s) =>
          defs.some((d) => d.key === s.key && this.canRead(d, actor)),
        );
        if (drift.length) {
          const note = clip(
            "State changed since this task's last checkpoint: " +
              drift.map((s) => `${s.key} v${s.from} -> v${s.to}`).join(", ") +
              ". Re-read before writing.",
            Math.max(200, Math.min(2000, budget)),
          ).text;
          notes.push(spend(note));
        }
      }
    }
    const summary =
      `${selected.length} dependency output(s) passed${truncatedDeps ? ` (${truncatedDeps} truncated or omitted)` : ""}${unselected > 0 ? `, ${unselected} dependency output(s) not selected` : ""}; ` +
      (fresh
        ? "fresh-memory run: shared state, artifacts and workflow overview withheld"
        : `${stateShown} of ${stateReadable} readable state field(s) shown; ${artifactLines.length} artifact(s) listed`);
    const parts: string[] = [
      UNTRUSTED_NOTICE + "\nContext summary: " + summary + ".",
    ];
    if (deps.length) parts.push("Dependency outputs:\n" + deps.join("\n"));
    if (stateLines.length)
      parts.push(
        "Shared workflow state (current versions):\n" + stateLines.join("\n"),
      );
    if (artifactLines.length)
      parts.push(
        "Workflow artifacts (metadata):\n" +
          untrusted(
            "artifact-list",
            { count: String(artifactLines.length) },
            artifactLines.join("\n"),
          ),
      );
    if (overview) parts.push("Workflow overview (metadata):\n" + overview);
    parts.push(...notes);
    if (writeText) parts.push(writeText);
    const final = hardClip(parts.join("\n\n"), max);
    return {
      text: final.text,
      summary,
      truncated: truncatedDeps > 0 || final.clipped,
    };
  }

  // ---- structured task output -------------------------------------------------------------------
  /** Parses and validates the agentteam-state block (async: confines artifact files). Writes nothing. */
  async prepare(task: Task, result: string): Promise<Prepared> {
    const cfg = this.config(task.id);
    const blocks = [
      ...result.matchAll(/```agentteam-state[ \t]*\r?\n([\s\S]*?)\r?\n```/g),
    ];
    const fail = (msg: string) =>
      invalid(
        "structured_output_invalid",
        `Structured output rejected (${BLOCK_LANG} block): ${msg} Nothing was written; fix the block and finish the task again.`,
      );
    if (blocks.length > 1)
      throw fail(`found ${blocks.length} blocks but exactly one is allowed.`);
    if (!blocks.length) {
      if (cfg.requiredWrites.length)
        throw fail(
          `this task must write ${cfg.requiredWrites.join(", ")} but the reply has no ${BLOCK_LANG} block.`,
        );
      return { hasBlock: false, writes: [], artifacts: [] };
    }
    let json: unknown;
    try {
      json = JSON.parse(blocks[0][1]);
    } catch (e) {
      throw fail(
        `the block is not valid JSON (${e instanceof Error ? e.message : "parse error"}).`,
      );
    }
    const parsed = outputBlockSchema.safeParse(json);
    if (!parsed.success) throw fail(`${issueLines(parsed.error)}.`);
    const seen = new Set<string>();
    const agent = { type: "agent", agentId: task.agentId } as const;
    const writes: Prepared["writes"] = [];
    for (const w of parsed.data.writes) {
      if (w.value === undefined) throw fail(`write "${w.key}" has no value.`);
      if (seen.has(w.key))
        throw fail(
          `field "${w.key}" is written twice; write each field once per run.`,
        );
      seen.add(w.key);
      const def = this.field(task.workflowId, w.key);
      if (!allowedFor(def.writers, agent))
        throw new AppError(
          403,
          "state_write_denied",
          `Structured output rejected: this task's agent may not write "${w.key}" (writers: ${def.writers.join(", ") || "(none)"}). Remove the write or ask the workflow owner to grant access. Nothing was written.`,
        );
      try {
        this.validateValue(def, w.value);
      } catch (e) {
        if (e instanceof AppError && e.code !== "state_conflict")
          throw new AppError(
            e.status,
            "structured_output_invalid",
            `Structured output rejected: ${e.message}`,
          );
        throw e;
      }
      writes.push({
        key: w.key,
        value: w.value,
        expectedVersion: w.expectedVersion ?? null,
        note: w.note,
      });
    }
    const missing = cfg.requiredWrites.filter((k) => !seen.has(k));
    if (missing.length)
      throw fail(`required field(s) ${missing.join(", ")} were not written.`);
    const artifacts: PreparedArtifact[] = [];
    for (const raw of parsed.data.artifacts) {
      try {
        artifacts.push(await this.service.artifacts.prepare(task.agentId, raw));
      } catch (e) {
        if (e instanceof AppError)
          throw new AppError(
            e.status,
            "structured_output_invalid",
            `Structured output rejected: artifact ${artifacts.length + 1}: ${e.message}`,
          );
        throw e;
      }
    }
    return { hasBlock: true, writes, artifacts };
  }
  /**
   * Applies prepared output atomically. Run inside the same transaction as the task's completion so a
   * conflict or a failed completion leaves no partial writes.
   */
  commit(task: Task, prepared: Prepared) {
    if (!prepared.writes.length && !prepared.artifacts.length) return;
    this.store.transaction(() => {
      const run = this.runState(task.id);
      const actor: Actor = { type: "agent", agentId: task.agentId };
      for (const w of prepared.writes) {
        const expected =
          w.expectedVersion ??
          run?.versions[w.key] ??
          this.head(task.workflowId, w.key)?.version ??
          0;
        this.write({
          workflowId: task.workflowId,
          key: w.key,
          value: w.value,
          expectedVersion: expected,
          actor,
          taskId: task.id,
          note: w.note,
        });
      }
      const provenance = this.provenance(task, actor);
      for (const a of prepared.artifacts)
        this.service.artifacts.save(task.workflowId, a, provenance);
    });
  }
}
