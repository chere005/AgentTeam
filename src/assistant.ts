import { randomUUID } from "node:crypto";
import { z } from "zod";
import { limitsPatchSchema } from "./limits-schema.ts";
import { Store } from "./store.ts";
import { withRoleDefaults } from "./roles.ts";
import { TeamService } from "./service.ts";
import { canonical, issueLines, sha256 } from "./shared-common.ts";
import {
  AppError,
  assert,
  type Agent,
  type Edge,
  type Message,
  type Rule,
  type Session,
  type Workflow,
} from "./model.ts";

/**
 * Team Assistant change proposals.
 *
 * A proposal is DATA: a bounded, strictly validated list of operations produced from assistant
 * output (or typed by the user). Nothing here is ever applied by assistant output. Applying needs
 * a user actor (the HTTP route is the only caller and it always passes `{type: "user"}`), a fresh
 * base version (proposals go stale when any entity they touch changes), an unexpired proposal and,
 * for significant changes, a separate explicit approval bound to the exact operations. Applying
 * runs the same TeamService mutations the forms use, first against an in-memory copy (dry run),
 * then for real; a failure part-way restores the pre-apply snapshot. Every step is audited.
 */

export const MAX_OPS = 50;
export const MAX_PROPOSAL_BLOCKS = 5;
export const PROPOSAL_FENCE = "agentteam-proposal";
const REF = /^[a-z][a-z0-9-]{0,39}$/;
const refName = z.string().regex(REF);
/** An existing entity id, or `@ref` naming an entity created earlier in the same proposal. */
const idOrRef = z.string().min(1).max(200);
const fields = z.record(z.string(), z.unknown());

export const opSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("agent.create"),
      ref: refName.optional(),
      agent: fields,
    })
    .strict(),
  z
    .object({ op: z.literal("agent.update"), id: idOrRef, changes: fields })
    .strict(),
  z.object({ op: z.literal("edge.create"), edge: fields }).strict(),
  z
    .object({ op: z.literal("edge.update"), id: idOrRef, changes: fields })
    .strict(),
  z.object({ op: z.literal("rule.create"), rule: fields }).strict(),
  z
    .object({
      op: z.literal("workflow.create"),
      ref: refName.optional(),
      workflow: fields,
    })
    .strict(),
  z
    .object({
      op: z.literal("workflow.limits"),
      workflowId: idOrRef,
      limits: fields,
    })
    .strict(),
  z
    .object({
      op: z.literal("resource.assign"),
      agentId: idOrRef,
      action: z.enum(["add", "remove"]),
      workspace: z
        .object({
          path: z.string().min(1).max(4096),
          access: z.enum(["read", "write"]).default("read"),
          active: z.boolean().default(false),
        })
        .strict(),
    })
    .strict(),
]);
export type Op = z.infer<typeof opSchema>;

/** Strict: unknown keys such as `autoApply` are rejected, never ignored. */
export const proposalInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    rationale: z.string().max(4000).default(""),
    ops: z.array(opSchema).min(1).max(MAX_OPS),
  })
  .strict();
export type ProposalInput = z.infer<typeof proposalInputSchema>;

export type ProposalSource =
  | { type: "user" }
  | { type: "assistant"; agentId?: string; messageId?: string; key?: string };
export type ProposalStatus =
  | "pending"
  | "approved"
  | "applied"
  | "rejected"
  | "stale"
  | "expired"
  | "failed";
export type DiffField = { path: string; before: unknown; after: unknown };
export type DiffEntry = {
  index: number;
  op: Op["op"];
  action: "create" | "update" | "remove";
  kind: "agent" | "edge" | "rule" | "workflow" | "limits" | "resource";
  target: string;
  label: string;
  fields: DiffField[];
  significant: boolean;
  reasons: string[];
};
export type Proposal = {
  id: string;
  title: string;
  rationale: string;
  source: ProposalSource;
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  ops: Op[];
  opsHash: string;
  /** Hash of every pre-existing entity the proposal touches or references (null = absent). */
  base: Record<string, string | null>;
  significant: boolean;
  reasons: string[];
  approval?: { by: "user"; at: string; opsHash: string; note?: string };
  statusReason?: string;
  appliedAt?: string;
  result?: { index: number; op: Op["op"]; id: string }[];
};
export type AuditEntry = {
  id: string;
  at: string;
  /** Who performed the action. Applying, approving and rejecting are always `user`. */
  actor: { type: "user" | "system" };
  proposedBy: ProposalSource;
  proposalId: string;
  action:
    | "created"
    | "approved"
    | "applied"
    | "rejected"
    | "rolled_back"
    | "stale"
    | "expired"
    | "failed";
  summary: string;
  changes?: { index: number; op: string; kind: string; target: string }[];
  detail?: string;
};

const SNAPSHOT_KINDS = [
  "agent",
  "edge",
  "rule",
  "workflow",
  "workflow-limits",
] as const;
const COPY_KINDS = [...SNAPSHOT_KINDS, "session", "task"] as const;

const agentInputOf = (a: Agent) => {
  const { id, createdAt, control, ...input } = a;
  return input as Record<string, unknown>;
};
const edgeInputOf = (e: Edge) => {
  const { id, ...input } = e;
  return input as Record<string, unknown>;
};
const isRef = (v: unknown): v is string =>
  typeof v === "string" && v[0] === "@";
const summarize = (v: unknown) => {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text && text.length > 400 ? text.slice(0, 400) + "…" : v;
};
const diffFields = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): DiffField[] => {
  const out: DiffField[] = [];
  for (const key of Object.keys(after).sort()) {
    const b = before ? before[key] : undefined;
    if (before && canonical(b) === canonical(after[key])) continue;
    out.push({
      path: key,
      before: summarize(b ?? null),
      after: summarize(after[key]),
    });
  }
  return out;
};

type Refs = Map<string, { kind: "agent" | "workflow"; id: string }>;

/** Resolves `@ref` to the entity id created earlier; ids pass through. */
function resolveId(value: unknown, kind: "agent" | "workflow", refs: Refs) {
  if (typeof value !== "string") return value;
  if (!isRef(value)) return value;
  const ref = refs.get(value.slice(1));
  assert(
    ref && ref.kind === kind,
    "proposal_invalid",
    `Reference ${value} does not name a ${kind} created earlier in this proposal`,
    400,
  );
  return ref.id;
}

/** Executes operations through the TeamService mutations the forms use; shared by dry run and apply. */
export async function executeOps(
  service: TeamService,
  ops: Op[],
  afterOp?: (index: number) => void,
  /** Filled as operations complete, so a caller can roll back exactly what was written. */
  results: { index: number; op: Op["op"]; id: string }[] = [],
) {
  const store = service.store;
  const refs: Refs = new Map();
  for (const [index, op] of ops.entries()) {
    let id = "";
    switch (op.op) {
      case "agent.create": {
        const input = { ...op.agent } as Record<string, unknown>;
        if ("parentId" in input)
          input.parentId = resolveId(input.parentId, "agent", refs);
        assert(
          input.kind === undefined || input.kind === "agent",
          "proposal_invalid",
          "Proposals can only create ordinary agents",
          400,
        );
        id = (await service.saveAgent(input)).id;
        if (op.ref) refs.set(op.ref, { kind: "agent", id });
        break;
      }
      case "agent.update": {
        id = String(resolveId(op.id, "agent", refs));
        const current = store.get<Agent>("agent", id);
        assert(
          !("kind" in op.changes) && !("control" in op.changes),
          "proposal_invalid",
          "Agent kind and control cannot be changed by a proposal",
          400,
        );
        const merged = { ...agentInputOf(current), ...op.changes };
        if ("parentId" in op.changes)
          merged.parentId = resolveId(merged.parentId, "agent", refs);
        await service.saveAgent(merged, id);
        break;
      }
      case "resource.assign": {
        id = String(resolveId(op.agentId, "agent", refs));
        const current = store.get<Agent>("agent", id);
        let workspaces = current.workspaces.map((w) => ({ ...w }));
        const real = await import("node:fs/promises")
          .then((fs) => fs.realpath(op.workspace.path))
          .catch(() => op.workspace.path);
        const same = (w: { path: string }) =>
          w.path === real || w.path === op.workspace.path;
        const existing = workspaces.find(same);
        workspaces = workspaces.filter((w) => !same(w));
        if (op.action === "add") {
          if (op.workspace.active) for (const w of workspaces) w.active = false;
          // Re-assigning an attached folder changes its access level only: its file rules and
          // exclusions (src/access.ts) are kept, never silently dropped.
          workspaces.push({
            ...op.workspace,
            ...(existing?.rules ? { rules: existing.rules } : {}),
            ...(existing?.explicitOnly ? { explicitOnly: true } : {}),
          });
        }
        await service.saveAgent({ ...agentInputOf(current), workspaces }, id);
        break;
      }
      case "edge.create": {
        const input = {
          ...op.edge,
          from: resolveId(op.edge.from, "agent", refs),
          to: resolveId(op.edge.to, "agent", refs),
        };
        id = service.saveEdge(input).id;
        break;
      }
      case "edge.update": {
        id = op.id;
        const current = store.get<Edge>("edge", id);
        const merged = { ...edgeInputOf(current), ...op.changes } as Record<
          string,
          unknown
        >;
        merged.from = resolveId(merged.from, "agent", refs);
        merged.to = resolveId(merged.to, "agent", refs);
        service.saveEdge(merged, id);
        break;
      }
      case "rule.create": {
        const input = { ...op.rule } as Record<string, unknown>;
        input.agentId = resolveId(input.agentId, "agent", refs);
        if (input.targetId !== undefined)
          input.targetId = resolveId(input.targetId, "agent", refs);
        id = service.saveRule(input).id;
        break;
      }
      case "workflow.create": {
        const input = { ...op.workflow } as Record<string, unknown>;
        input.ownerId = resolveId(input.ownerId, "agent", refs);
        id = service.workflow(input).id;
        if (op.ref) refs.set(op.ref, { kind: "workflow", id });
        break;
      }
      case "workflow.limits": {
        id = String(resolveId(op.workflowId, "workflow", refs));
        service.limits.setLimits(id, op.limits);
        break;
      }
    }
    results.push({ index, op: op.op, id });
    afterOp?.(index);
  }
  return results;
}

/** Entity hash used for the staleness check; volatile runtime state is excluded. */
function entityHash(store: Store, key: string): string | null {
  const [kind, id] = [
    key.slice(0, key.indexOf(":")),
    key.slice(key.indexOf(":") + 1),
  ];
  try {
    if (kind === "limits") {
      const state = store.get<{ limits: unknown }>("workflow-limits", id);
      return sha256(canonical(state.limits));
    }
    if (kind === "agent") {
      const { control, ...rest } = store.get<Agent>("agent", id);
      return sha256(canonical(rest));
    }
    if (kind === "workflow") {
      const { paused, ...rest } = store.get<Workflow>(
        "workflow",
        id,
      ) as Workflow & Record<string, unknown>;
      return sha256(canonical(rest));
    }
    return sha256(canonical(store.get(kind, id)));
  } catch {
    return null;
  }
}

function touchedKeys(ops: Op[]): string[] {
  const keys = new Set<string>();
  const agent = (v: unknown) => {
    if (typeof v === "string" && !isRef(v)) keys.add("agent:" + v);
  };
  for (const op of ops)
    switch (op.op) {
      case "agent.create":
        agent(op.agent.parentId);
        break;
      case "agent.update":
        agent(op.id);
        agent(op.changes.parentId);
        break;
      case "resource.assign":
        agent(op.agentId);
        break;
      case "edge.create":
        agent(op.edge.from);
        agent(op.edge.to);
        break;
      case "edge.update":
        if (!isRef(op.id)) keys.add("edge:" + op.id);
        agent(op.changes.from);
        agent(op.changes.to);
        break;
      case "rule.create":
        agent(op.rule.agentId);
        agent(op.rule.targetId);
        break;
      case "workflow.create":
        agent(op.workflow.ownerId);
        break;
      case "workflow.limits":
        if (!isRef(op.workflowId)) {
          keys.add("workflow:" + op.workflowId);
          keys.add("limits:" + op.workflowId);
        }
        break;
    }
  return [...keys].sort();
}

const SIGNIFICANT_AGENT_KEYS = [
  "environment",
  "tools",
  "skills",
  "workspaces",
  "instructions",
  "parentId",
  "roleType",
  "maxConcurrentInvocations",
];
const LIMIT_KEYS = [
  "maxRuntimeSeconds",
  "maxAgentTurns",
  "maxHandoffs",
  "maxRetries",
  "maxSpawnedAgents",
  "maxTokens",
  "maxChildrenPerTask",
  "maxDelegationDepth",
] as const;

/** Builds the reviewable diff (against current state, simulating earlier ops) and its significance. */
export function buildDiff(service: TeamService, ops: Op[]): DiffEntry[] {
  const store = service.store;
  const out: DiffEntry[] = [];
  // Simulated agents created earlier in the proposal, so later ops show the right "before".
  const simulated = new Map<string, Record<string, unknown>>();
  const label = (v: unknown) => {
    if (typeof v !== "string") return "?";
    if (isRef(v)) return v;
    try {
      return store.get<Agent>("agent", v).name;
    } catch {
      return v;
    }
  };
  const agentBefore = (id: string): Record<string, unknown> | null => {
    if (isRef(id)) return simulated.get(id) ?? null;
    try {
      return agentInputOf(store.get<Agent>("agent", id));
    } catch {
      return null;
    }
  };
  for (const [index, op] of ops.entries()) {
    const entry = (
      e: Omit<DiffEntry, "index" | "op" | "significant" | "reasons"> & {
        reasons?: string[];
      },
    ): DiffEntry => ({
      index,
      op: op.op,
      ...e,
      reasons: e.reasons ?? [],
      significant: (e.reasons ?? []).length > 0,
    });
    switch (op.op) {
      case "agent.create": {
        const input = op.agent;
        if (op.ref) simulated.set("@" + op.ref, input);
        const reasons = ["Creates an agent that can run provider work"];
        if (
          Array.isArray(input.workspaces) &&
          (input.workspaces as { access?: string }[]).some(
            (w) => w.access === "write",
          )
        )
          reasons.push("Grants write access to a folder");
        out.push(
          entry({
            action: "create",
            kind: "agent",
            target: op.ref ? "@" + op.ref : String(input.name ?? "agent"),
            label: `Create agent ${String(input.name ?? "")}`.trim(),
            fields: diffFields(null, input),
            reasons,
          }),
        );
        break;
      }
      case "agent.update": {
        const before = agentBefore(op.id);
        const after = { ...(before ?? {}), ...op.changes };
        const changed = diffFields(before, after).filter((f) =>
          Object.hasOwn(op.changes, f.path),
        );
        const reasons = changed
          .filter((f) => SIGNIFICANT_AGENT_KEYS.includes(f.path))
          .map((f) => `Changes ${f.path}`);
        out.push(
          entry({
            action: "update",
            kind: "agent",
            target: op.id,
            label: `Edit agent ${label(op.id)}`,
            fields: changed,
            reasons,
          }),
        );
        break;
      }
      case "resource.assign": {
        const before = agentBefore(op.agentId);
        out.push(
          entry({
            action: op.action === "add" ? "update" : "remove",
            kind: "resource",
            target: op.agentId,
            label: `${op.action === "add" ? "Attach" : "Detach"} ${op.workspace.path} ${op.action === "add" ? "(" + op.workspace.access + ") to" : "from"} ${label(op.agentId)}`,
            fields: [
              {
                path: "workspaces",
                before: summarize(before?.workspaces ?? null),
                after: summarize(
                  op.action === "add"
                    ? { add: op.workspace }
                    : { remove: op.workspace.path },
                ),
              },
            ],
            reasons:
              op.action === "add"
                ? [`Grants ${op.workspace.access} access to a folder`]
                : [],
          }),
        );
        break;
      }
      case "edge.create": {
        const e = op.edge;
        out.push(
          entry({
            action: "create",
            kind: "edge",
            target: `${label(e.from)} → ${label(e.to)}`,
            label: `Connect ${label(e.from)} → ${label(e.to)} (${String(e.kind ?? "")})`,
            fields: diffFields(null, e),
            reasons:
              e.enabled === false
                ? []
                : ["Changes who may communicate with whom"],
          }),
        );
        break;
      }
      case "edge.update": {
        let before: Record<string, unknown> | null = null;
        try {
          before = edgeInputOf(store.get<Edge>("edge", op.id));
        } catch {}
        const after = { ...(before ?? {}), ...op.changes };
        const changed = diffFields(before, after).filter((f) =>
          Object.hasOwn(op.changes, f.path),
        );
        const onlyDisable =
          changed.length === 1 &&
          changed[0].path === "enabled" &&
          after.enabled === false;
        out.push(
          entry({
            action: "update",
            kind: "edge",
            target: op.id,
            label: `Edit connection ${before ? `${label(before.from)} → ${label(before.to)}` : op.id}`,
            fields: changed,
            reasons:
              changed.length && !onlyDisable
                ? ["Changes who may communicate with whom"]
                : [],
          }),
        );
        break;
      }
      case "rule.create": {
        const r = op.rule;
        out.push(
          entry({
            action: "create",
            kind: "rule",
            target: label(r.agentId),
            label: `Add ${String(r.mode ?? "advisory")} ${String(r.kind ?? "delegate")} rule for ${label(r.agentId)}`,
            fields: diffFields(null, r),
            reasons:
              r.mode === "mandatory"
                ? ["Adds a required review that blocks dependent work"]
                : [],
          }),
        );
        break;
      }
      case "workflow.create": {
        out.push(
          entry({
            action: "create",
            kind: "workflow",
            target: op.ref ? "@" + op.ref : String(op.workflow.name ?? ""),
            label: `Create workflow ${String(op.workflow.name ?? "")}`.trim(),
            fields: diffFields(null, op.workflow),
          }),
        );
        break;
      }
      case "workflow.limits": {
        let before: Record<string, unknown> = {};
        try {
          before = service.limits.state(op.workflowId).limits as Record<
            string,
            unknown
          >;
        } catch {}
        const reasons: string[] = [];
        const parsed = limitsPatchSchema.safeParse(op.limits);
        if (parsed.success)
          for (const k of LIMIT_KEYS) {
            const next = (
              parsed.data as Record<string, number | null | undefined>
            )[k];
            if (next === undefined) continue;
            const prev = before[k] as number | null | undefined;
            if (
              prev !== undefined &&
              (next === null ? prev !== null : prev !== null && next > prev)
            )
              reasons.push(
                next === null ? `Removes the ${k} bound` : `Raises ${k}`,
              );
          }
        out.push(
          entry({
            action: "update",
            kind: "limits",
            target: op.workflowId,
            label: `Change stopping conditions of workflow ${op.workflowId}`,
            fields: diffFields(before, op.limits).filter((f) =>
              Object.hasOwn(op.limits, f.path),
            ),
            reasons,
          }),
        );
        break;
      }
    }
  }
  return out;
}

/** Collects every error a dry run would hit, one message per failing operation. */
async function dryRun(service: TeamService, ops: Op[]) {
  const sandboxStore = new Store(":memory:");
  try {
    for (const kind of COPY_KINDS)
      for (const entity of service.store.list<{ id: string }>(kind))
        sandboxStore.put(kind, entity);
    // Teams and the active team decide where new agents land and which links are cross-team.
    for (const team of service.store.list<{ id: string }>("team-space"))
      sandboxStore.put("team-space", team);
    sandboxStore.put("settings", {
      id: "active-team",
      teamId: service.teamSpaces.active(),
    });
    const sandbox = new TeamService(sandboxStore, service.skills);
    // Stop at the first failure: later ops usually depend on earlier ones.
    let index = 0;
    try {
      await executeOps(sandbox, ops, (i) => (index = i + 1));
      return null;
    } catch (e) {
      return { index, error: errorText(e) };
    }
  } finally {
    sandboxStore.close();
  }
}
function errorText(e: unknown) {
  if (e instanceof z.ZodError) return issueLines(e);
  if (e instanceof AppError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

export type ProposalOptions = {
  ttlMs?: number;
  /** Test seam: called after each real operation during apply (a throw simulates a mid-apply failure). */
  afterOp?: (index: number) => void;
  now?: () => number;
};

export class AssistantProposals {
  service: TeamService;
  store: Store;
  opts: Required<Pick<ProposalOptions, "ttlMs" | "now">> &
    Pick<ProposalOptions, "afterOp">;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(service: TeamService, options: ProposalOptions = {}) {
    this.service = service;
    this.store = service.store;
    this.opts = {
      ttlMs: options.ttlMs ?? 60 * 60 * 1000,
      now: options.now ?? Date.now,
      afterOp: options.afterOp,
    };
  }
  /** Applies are serialised so two proposals can never interleave their mutations. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private audit(
    p: Proposal,
    action: AuditEntry["action"],
    summary: string,
    extra: Partial<AuditEntry> = {},
  ) {
    const entry: AuditEntry = {
      id: "audit-" + randomUUID(),
      at: new Date(this.opts.now()).toISOString(),
      actor: {
        type: action === "stale" || action === "expired" ? "system" : "user",
      },
      proposedBy: p.source,
      proposalId: p.id,
      action,
      summary,
      ...extra,
    };
    this.store.put("assistant-audit", entry);
    this.store.emit("assistant.proposal." + action, p.id, {
      auditId: entry.id,
      actor: entry.actor.type,
      proposedBy: p.source.type,
    });
    return entry;
  }
  auditLog(proposalId?: string): AuditEntry[] {
    return this.store
      .list<AuditEntry>("assistant-audit")
      .filter((a) => !proposalId || a.proposalId === proposalId);
  }
  /** Validates and stores a proposal. Nothing is changed in the team configuration. */
  async create(input: unknown, source: ProposalSource): Promise<Proposal> {
    const data = proposalInputSchema.parse(input);
    this.checkStatic(data.ops);
    const failure = await dryRun(this.service, data.ops);
    if (failure)
      throw new AppError(
        400,
        "proposal_invalid",
        `Operation ${failure.index + 1} (${data.ops[failure.index]?.op}) is invalid: ${failure.error}`,
      );
    const diff = buildDiff(this.service, data.ops);
    const base: Record<string, string | null> = {};
    for (const key of touchedKeys(data.ops))
      base[key] = entityHash(this.store, key);
    const reasons = [...new Set(diff.flatMap((d) => d.reasons))];
    const now = this.opts.now();
    const proposal: Proposal = {
      id: randomUUID(),
      title: data.title,
      rationale: data.rationale,
      source,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.opts.ttlMs).toISOString(),
      status: "pending",
      ops: data.ops,
      opsHash: sha256(canonical(data.ops)),
      base,
      significant: reasons.length > 0,
      reasons,
    };
    this.store.transaction(() => {
      this.store.put("proposal", proposal);
      this.audit(
        proposal,
        "created",
        `Proposal "${proposal.title}" created (${proposal.ops.length} operations)`,
      );
    });
    return proposal;
  }
  /** Reference and existing-entity checks that do not need a dry run. */
  private checkStatic(ops: Op[]) {
    const seen = new Set<string>();
    const defined = new Set<string>();
    const need = (v: unknown, where: string) => {
      if (isRef(v))
        assert(
          defined.has(v.slice(1)),
          "proposal_invalid",
          `${where}: ${v} is not created earlier in this proposal`,
          400,
        );
    };
    for (const op of ops) {
      switch (op.op) {
        case "agent.create":
          need(op.agent.parentId, "agent.parentId");
          break;
        case "agent.update":
          need(op.id, "agent.update id");
          break;
        case "resource.assign":
          need(op.agentId, "resource.assign agentId");
          break;
        case "edge.create":
          need(op.edge.from, "edge.from");
          need(op.edge.to, "edge.to");
          break;
        case "rule.create":
          need(op.rule.agentId, "rule.agentId");
          need(op.rule.targetId, "rule.targetId");
          break;
        case "workflow.create":
          need(op.workflow.ownerId, "workflow.ownerId");
          break;
        case "workflow.limits":
          need(op.workflowId, "workflow.limits workflowId");
          break;
      }
      if ("ref" in op && op.ref) {
        assert(
          !seen.has(op.ref),
          "proposal_invalid",
          `Duplicate ref ${op.ref}`,
          400,
        );
        seen.add(op.ref);
        defined.add(op.ref);
      }
    }
  }
  /** Parses fenced `agentteam-proposal` blocks from an assistant message as data. */
  async extract(messageId: string) {
    const message = this.store.get<Message>("message", messageId);
    assert(
      message.role === "assistant",
      "not_assistant_message",
      "Proposals are only read from assistant messages",
      400,
    );
    const session = this.store.get<Session>("session", message.sessionId);
    const agent = this.store.get<Agent>("agent", session.agentId);
    assert(
      agent.kind === "team-assistant",
      "not_team_assistant",
      "Only the Team Assistant can propose configuration changes",
      403,
    );
    const re = new RegExp(
      "```" + PROPOSAL_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)```",
      "g",
    );
    const created: Proposal[] = [];
    const rejected: { block: number; error: string }[] = [];
    let block = 0;
    for (const m of message.text.matchAll(re)) {
      if (block >= MAX_PROPOSAL_BLOCKS) {
        rejected.push({
          block,
          error: `Only the first ${MAX_PROPOSAL_BLOCKS} proposal blocks are read`,
        });
        break;
      }
      const key = `${messageId}#${block}`;
      const existing = this.store
        .list<Proposal>("proposal")
        .find((p) => p.source.type === "assistant" && p.source.key === key);
      if (existing) created.push(this.get(existing.id));
      else
        try {
          created.push(
            await this.create(JSON.parse(m[1]), {
              type: "assistant",
              agentId: agent.id,
              messageId,
              key,
            }),
          );
        } catch (e) {
          rejected.push({
            block,
            error: e instanceof SyntaxError ? "Not valid JSON" : errorText(e),
          });
        }
      block++;
    }
    return { proposals: created, rejected };
  }
  list(): Proposal[] {
    return this.store
      .list<Proposal>("proposal")
      .map((p) => this.refresh(p))
      .reverse();
  }
  get(id: string): Proposal {
    return this.refresh(this.store.get<Proposal>("proposal", id));
  }
  /** Stored proposal plus the diff against the current state and why it can or cannot be applied. */
  detail(id: string) {
    const proposal = this.get(id);
    return {
      proposal,
      diff: buildDiff(this.service, proposal.ops),
      stale: this.staleKeys(proposal),
      canApply:
        (proposal.status === "pending" && !proposal.significant) ||
        proposal.status === "approved",
      needsApproval: proposal.significant && proposal.status === "pending",
    };
  }
  staleKeys(p: Proposal): string[] {
    return Object.entries(p.base)
      .filter(([key, hash]) => entityHash(this.store, key) !== hash)
      .map(([key]) => key);
  }
  /** Lazily moves open proposals to expired or stale when their base changed. */
  private refresh(p: Proposal): Proposal {
    if (p.status !== "pending" && p.status !== "approved") return p;
    let next: Proposal | null = null;
    if (Date.parse(p.expiresAt) <= this.opts.now())
      next = { ...p, status: "expired", statusReason: "Proposal expired" };
    else {
      const stale = this.staleKeys(p);
      if (stale.length)
        next = {
          ...p,
          status: "stale",
          statusReason: `The configuration changed since this was proposed: ${stale.join(", ")}`,
        };
    }
    if (!next) return p;
    const done = next;
    this.store.transaction(() => {
      this.store.put("proposal", done);
      this.audit(
        done,
        done.status === "stale" ? "stale" : "expired",
        done.statusReason!,
      );
    });
    return done;
  }
  reject(id: string, actor: { type: string }, note?: string) {
    this.requireUser(actor);
    const p = this.get(id);
    assert(
      p.status === "pending" || p.status === "approved",
      "proposal_" + p.status,
      `Proposal is ${p.status}`,
    );
    const next: Proposal = { ...p, status: "rejected", statusReason: note };
    this.store.transaction(() => {
      this.store.put("proposal", next);
      this.audit(next, "rejected", `Proposal "${p.title}" rejected`);
    });
    return next;
  }
  /** Explicit approval of a significant proposal, bound to its exact operations. */
  approve(id: string, actor: { type: string }, note?: string) {
    this.requireUser(actor);
    const p = this.get(id);
    assert(
      p.status === "pending",
      "proposal_" + p.status,
      `Proposal is ${p.status}`,
    );
    const next: Proposal = {
      ...p,
      status: "approved",
      approval: {
        by: "user",
        at: new Date(this.opts.now()).toISOString(),
        opsHash: p.opsHash,
        note,
      },
    };
    this.store.transaction(() => {
      this.store.put("proposal", next);
      this.audit(
        next,
        "approved",
        `Approved "${p.title}"${p.reasons.length ? ": " + p.reasons.join("; ") : ""}`,
      );
    });
    return next;
  }
  private requireUser(actor: { type: string }) {
    assert(
      actor?.type === "user",
      "assistant_cannot_apply",
      "Only the user can approve, reject or apply configuration changes; the assistant can only propose",
      403,
    );
  }
  /**
   * Applies a proposal as the user. Order of checks: actor, status, approval of significant
   * changes, staleness, dry run, then the real mutations with rollback of the whole proposal.
   */
  apply(id: string, actor: { type: string }) {
    this.requireUser(actor);
    return this.serial(async () => {
      const p = this.get(id);
      assert(
        p.status === "pending" || p.status === "approved",
        "proposal_" + p.status,
        p.statusReason ?? `Proposal is ${p.status}`,
      );
      if (p.significant)
        assert(
          p.status === "approved" && p.approval?.opsHash === p.opsHash,
          "approval_required",
          `This proposal has significant effects (${p.reasons.join("; ")}). Approve it explicitly before applying`,
        );
      const dry = await dryRun(this.service, p.ops);
      if (dry) {
        const failed: Proposal = {
          ...p,
          status: "failed",
          statusReason: `Operation ${dry.index + 1}: ${dry.error}`,
        };
        this.store.transaction(() => {
          this.store.put("proposal", failed);
          this.audit(failed, "failed", failed.statusReason!);
        });
        throw new AppError(409, "proposal_invalid", failed.statusReason!);
      }
      // Re-check just before mutating: the dry run awaited.
      const stale = this.staleKeys(p);
      if (stale.length) {
        this.refresh(p);
        throw new AppError(
          409,
          "proposal_stale",
          `The configuration changed since this was proposed: ${stale.join(", ")}`,
        );
      }
      const snapshot = new Map<string, unknown[]>();
      for (const kind of SNAPSHOT_KINDS)
        snapshot.set(kind, this.store.list<{ id: string }>(kind));
      const results: { index: number; op: Op["op"]; id: string }[] = [];
      try {
        await executeOps(this.service, p.ops, this.opts.afterOp, results);
      } catch (e) {
        this.rollback(snapshot, results);
        const failed: Proposal = {
          ...p,
          status: "failed",
          statusReason: `Rolled back: ${errorText(e)}`,
        };
        this.store.transaction(() => {
          this.store.put("proposal", failed);
          this.audit(failed, "rolled_back", failed.statusReason!);
        });
        throw e;
      }
      const applied: Proposal = {
        ...p,
        status: "applied",
        appliedAt: new Date(this.opts.now()).toISOString(),
        result: results,
      };
      this.store.transaction(() => {
        this.store.put("proposal", applied);
        this.audit(
          applied,
          "applied",
          `Applied "${p.title}" (${results.length} operations)`,
          {
            changes: results.map((r) => ({
              index: r.index,
              op: r.op,
              kind: r.op.split(".")[0],
              target: r.id,
            })),
          },
        );
      });
      return applied;
    });
  }
  /**
   * Restores exactly the entities the completed operations wrote (a failing operation writes in
   * one transaction, so it left nothing). Unrelated changes made meanwhile, such as another agent
   * edit or a control/pause toggle while apply awaited, are kept; a restored agent keeps its
   * current runtime `control`.
   */
  private rollback(
    snapshot: Map<string, unknown[]>,
    done: { op: Op["op"]; id: string }[],
  ) {
    const touched: [string, string][] = [];
    for (const r of done) {
      const kind = r.op.split(".")[0];
      if (r.op === "resource.assign") touched.push(["agent", r.id]);
      else if (r.op === "workflow.limits")
        touched.push(["workflow-limits", r.id], ["workflow", r.id]);
      else if (r.op === "workflow.create")
        touched.push(["workflow", r.id], ["workflow-limits", r.id]);
      else touched.push([kind, r.id]);
    }
    this.store.transaction(() => {
      for (const [kind, id] of touched) {
        const before = (
          snapshot.get(kind) as { id: string }[] | undefined
        )?.find((e) => e.id === id);
        let current: Record<string, unknown> | null = null;
        try {
          current = this.store.get(kind, id);
        } catch {}
        if (!before) {
          if (current) {
            this.store.remove(kind, id);
            this.store.emit(kind + ".deleted", id, { rolledBack: true });
          }
          continue;
        }
        const restored =
          kind === "agent" && current
            ? { ...before, control: current.control }
            : before;
        this.store.put(kind, restored);
      }
      this.store.emit("assistant.rolled_back", "assistant", {});
    });
  }
}
