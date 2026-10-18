import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import {
  AppError,
  agentSchema,
  edgeSchema,
  environment,
  ruleSchema,
  assert,
  type Agent,
  type Edge,
  type Rule,
} from "./model.ts";
import type { TeamService } from "./service.ts";
import type { DetectedRuntime } from "./discovery.ts";

export const TEAM_TEMPLATE_FORMAT = "agentteam.team-template";
/**
 * Highest schema version this build can read and the one it writes.
 * v2 (additive) adds optional `groups` (canvas selection groups). v1 envelopes still read; groups default to [].
 */
export const TEAM_TEMPLATE_SCHEMA_VERSION = 2;

const kindEnum = z.enum(["delegate", "consult", "review", "notify"]);
const key = z.string().min(1).max(64);
const point = z.object({ x: z.number(), y: z.number() }).strict();

const templateAgent = z
  .object({
    key,
    name: z.string().trim().min(1).max(120),
    role: z.string().max(4000).default(""),
    environment,
    model: z.string().min(1).default("default"),
    effort: z.string().min(1).nullable().default(null),
    schedulingPriority: z.number().int().min(0).max(101).default(50),
    maxConcurrentInvocations: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .nullable()
      .default(null),
    instructions: z.string().max(100_000).default(""),
    tools: z.array(z.string().min(1)).default([]),
    skills: agentSchema.shape.skills,
    // Workspaces are slots to be mapped on insert; paths only when exported explicitly.
    workspaces: z
      .array(
        z
          .object({
            slot: key,
            label: z.string().max(200).default(""),
            access: z.enum(["read", "write"]),
            active: z.boolean().default(false),
            path: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    parentKey: key.nullable().default(null),
    position: point.default({ x: 0, y: 0 }),
  })
  .strict();

const templateEdge = edgeSchema.extend({ from: key, to: key }).strict();
const templateRule = z
  .object({
    agentKey: key,
    targetKey: key.optional(),
    scope: z.enum(["intake", "action"]),
    priority: z.number().int().min(0).max(10000),
    enabled: z.boolean().default(true),
    match: ruleSchema.shape.match,
    mode: ruleSchema.shape.mode,
    specialty: ruleSchema.shape.specialty,
    kind: kindEnum.default("delegate"),
  })
  .strict();
/** A relationship that crossed the selection boundary; recorded by name only, never inserted. */
const externalDependency = z
  .object({
    type: z.enum(["edge", "rule", "parent"]),
    agentKey: key,
    direction: z.enum(["incoming", "outgoing"]),
    kind: kindEnum.optional(),
    externalName: z.string().max(120),
  })
  .strict();

const templateGroup = z
  .object({
    name: z.string().trim().min(1).max(40),
    agentKeys: z.array(key).min(1).max(200),
  })
  .strict();

export const teamTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000).default(""),
    version: z.number().int().min(1).default(1),
    agents: z.array(templateAgent).min(1).max(200),
    edges: z.array(templateEdge).default([]),
    rules: z.array(templateRule).default([]),
    externalDependencies: z.array(externalDependency).default([]),
    includesAbsolutePaths: z.boolean().default(false),
    /** Canvas selection groups (schema v2); membership is by agent key and exclusive. */
    groups: z.array(templateGroup).max(50).default([]),
  })
  .strict()
  .superRefine((t, ctx) => {
    const keys = new Set(t.agents.map((a) => a.key));
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    const grouped = new Set<string>();
    for (const g of t.groups) {
      for (const k of g.agentKeys) {
        if (!keys.has(k)) bad(`Group ${g.name} references unknown agent ${k}`);
        if (grouped.has(k)) bad(`Agent ${k} is in more than one group`);
        grouped.add(k);
      }
    }
    if (keys.size !== t.agents.length) bad("Duplicate agent keys");
    const parents = new Map(t.agents.map((a) => [a.key, a.parentKey]));
    for (const a of t.agents) {
      if (a.parentKey && !keys.has(a.parentKey))
        bad(`Agent ${a.key} has unknown parent ${a.parentKey}`);
      const seen = new Set<string>([a.key]);
      for (let p = a.parentKey; p; p = parents.get(p) ?? null) {
        if (seen.has(p)) {
          bad("Agent hierarchy must not contain a cycle");
          break;
        }
        seen.add(p);
      }
      if (new Set(a.workspaces.map((w) => w.slot)).size !== a.workspaces.length)
        bad(`Duplicate workspace slot in ${a.key}`);
      if (a.workspaces.filter((w) => w.active).length > 1)
        bad("Only one workspace can be active");
      if (a.workspaces.some((w) => w.path) && !t.includesAbsolutePaths)
        bad("Workspace paths require includesAbsolutePaths");
    }
    for (const e of t.edges) {
      if (!keys.has(e.from) || !keys.has(e.to))
        bad("Edge references an agent outside the template");
      if (e.from === e.to) bad("Edges must connect different agents");
    }
    for (const r of t.rules) {
      if (!keys.has(r.agentKey) || (r.targetKey && !keys.has(r.targetKey)))
        bad("Rule references an agent outside the template");
      if (r.scope === "action" && !r.targetKey)
        bad("Action rules require a target");
    }
  });
export type TeamTemplate = z.infer<typeof teamTemplateSchema>;

export const envelopeSchema = z
  .object({
    format: z.literal(TEAM_TEMPLATE_FORMAT),
    schemaVersion: z.number().int().min(1),
    exportedAt: z.string().optional(),
    template: z.unknown(),
  })
  .strict();
export type TeamTemplateEnvelope = {
  format: typeof TEAM_TEMPLATE_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  template: TeamTemplate;
};
export type StoredTemplate = TeamTemplate & {
  id: string;
  /** Live team the selection was saved from (library metadata; not part of the export). */
  sourceTeam?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
};

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(4000).default(""),
    agentIds: z.array(z.string()).min(1).max(200),
    /** Canvas coordinates by agent id (held by the UI); normalized to be relative. */
    positions: z.record(z.string(), point).default({}),
    includeAbsolutePaths: z.boolean().default(false),
    /** Canvas groups (renderer state) to keep with the team: agent ids per named group. */
    groups: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(40),
            agentIds: z.array(z.string()).min(1).max(200),
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();
const insertSchema = z
  .object({
    templateId: z.string().optional(),
    envelope: z.unknown().optional(),
    /** Template workspace slot -> absolute directory on this machine. */
    workspaces: z.record(z.string(), z.string()).default({}),
    /** Copy absolute paths embedded in the template (must be explicit). */
    useEmbeddedPaths: z.boolean().default(false),
    /** "environment:model" -> replacement model id. */
    modelMap: z.record(z.string(), z.string().min(1)).default({}),
    allowUnknownModels: z.boolean().default(false),
    allowUninstalledEnvironments: z.boolean().default(false),
    offset: point.default({ x: 0, y: 0 }),
    /**
     * Destination team (src/team-spaces.ts). Default: a new team named after the template (or
     * `teamName`), made unique, which becomes the active team. `teamId` inserts into an existing
     * team instead.
     */
    teamId: z.string().min(1).max(64).optional(),
    teamName: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine((v) => !(v.teamId && v.teamName), {
    message: "Provide at most one of teamId or teamName",
  })
  .refine((v) => Boolean(v.templateId) !== Boolean(v.envelope), {
    message: "Provide exactly one of templateId or envelope",
  });
export type InsertOptions = z.input<typeof insertSchema>;

export type Issue = {
  code: string;
  message: string;
  agentKey?: string;
};
export type Preview = {
  ok: boolean;
  issues: Issue[];
  warnings: string[];
  workspaceSlots: {
    agentKey: string;
    slot: string;
    label: string;
    access: string;
    embeddedPath: boolean;
  }[];
  externalDependencies: TeamTemplate["externalDependencies"];
  counts: { agents: number; edges: number; rules: number };
};

export const SECRET_PATTERN =
  /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,})/i;

export function checkCompatibility(envelopeInput: unknown): TeamTemplate {
  const parsed = envelopeSchema.safeParse(envelopeInput);
  if (!parsed.success) {
    const fmt = (envelopeInput as { format?: unknown } | null)?.format;
    throw new AppError(
      400,
      "invalid_template",
      fmt === TEAM_TEMPLATE_FORMAT || fmt === undefined
        ? "Not a valid AgentTeam team template envelope"
        : "Unrecognized team template format",
    );
  }
  assert(
    parsed.data.schemaVersion <= TEAM_TEMPLATE_SCHEMA_VERSION,
    "template_too_new",
    `Template schema version ${parsed.data.schemaVersion} is newer than this AgentTeam supports (${TEAM_TEMPLATE_SCHEMA_VERSION}); update the app`,
    422,
  );
  // Future: migrate older schema versions here before validation.
  return teamTemplateSchema.parse(parsed.data.template);
}

export class TeamTemplates {
  service: TeamService;
  runtimes: () => DetectedRuntime[] | undefined;
  constructor(
    service: TeamService,
    runtimes: () => DetectedRuntime[] | undefined = () => undefined,
  ) {
    this.service = service;
    this.runtimes = runtimes;
  }
  private get store() {
    return this.service.store;
  }

  /** Snapshot a group of agents into a portable template (not persisted). */
  build(input: unknown): TeamTemplate {
    const data = createSchema.parse(input);
    const all = this.store.list<Agent>("agent");
    const byId = new Map(all.map((a) => [a.id, a]));
    const selected = [...new Set(data.agentIds)].map((id) => {
      const a = byId.get(id);
      if (!a) throw new AppError(404, "not_found", `agent ${id} not found`);
      return a;
    });
    // The single global Team Assistant is never part of a template.
    assert(
      !selected.some((a) => a.kind === "team-assistant"),
      "assistant_not_templatable",
      "The Team Assistant is global and cannot be saved in a team template",
      400,
    );
    const keyOf = new Map(selected.map((a, i) => [a.id, `a${i + 1}`]));
    const external: TeamTemplate["externalDependencies"] = [];
    const nameOf = (id: string) => byId.get(id)?.name ?? "(deleted agent)";
    const minX = Math.min(...selected.map((a) => data.positions[a.id]?.x ?? 0));
    const minY = Math.min(...selected.map((a) => data.positions[a.id]?.y ?? 0));
    const agents = selected.map((a, i) => {
      const k = keyOf.get(a.id)!;
      if (a.parentId && !keyOf.has(a.parentId))
        external.push({
          type: "parent",
          agentKey: k,
          direction: "incoming",
          externalName: nameOf(a.parentId),
        });
      return {
        key: k,
        name: a.name,
        role: a.role,
        environment: a.environment,
        model: a.model,
        effort: a.effort,
        schedulingPriority: a.schedulingPriority,
        maxConcurrentInvocations: a.maxConcurrentInvocations,
        instructions: a.instructions,
        tools: [...a.tools],
        skills: a.skills.map((s) => ({ ...s })),
        workspaces: a.workspaces.map((w, n) => ({
          slot: `w${n + 1}`,
          label: basename(w.path),
          access: w.access,
          active: w.active,
          ...(data.includeAbsolutePaths ? { path: w.path } : {}),
        })),
        parentKey: a.parentId ? (keyOf.get(a.parentId) ?? null) : null,
        position: {
          x: (data.positions[a.id]?.x ?? (i % 3) * 310) - minX,
          y: (data.positions[a.id]?.y ?? Math.floor(i / 3) * 270) - minY,
        },
      };
    });
    const edges: TeamTemplate["edges"] = [];
    for (const e of this.store.list<Edge>("edge")) {
      const f = keyOf.get(e.from),
        t = keyOf.get(e.to);
      if (f && t)
        edges.push({
          from: f,
          to: t,
          bidirectional: e.bidirectional,
          kind: e.kind,
          enabled: e.enabled,
        });
      else if (f || t)
        external.push({
          type: "edge",
          agentKey: (f ?? t)!,
          direction: f ? "outgoing" : "incoming",
          kind: e.kind,
          externalName: nameOf(f ? e.to : e.from),
        });
    }
    const rules: TeamTemplate["rules"] = [];
    for (const r of this.store.list<Rule>("rule")) {
      const a = keyOf.get(r.agentId),
        t = r.targetId ? keyOf.get(r.targetId) : undefined;
      if (a && (!r.targetId || t))
        rules.push({
          agentKey: a,
          ...(t ? { targetKey: t } : {}),
          scope: r.scope,
          priority: r.priority,
          enabled: r.enabled,
          match: r.match,
          mode: r.mode ?? "advisory",
          ...(r.specialty ? { specialty: r.specialty } : {}),
          kind: r.kind,
        });
      else if (a || t)
        external.push({
          type: "rule",
          agentKey: (a ?? t)!,
          direction: a ? "outgoing" : "incoming",
          kind: r.kind,
          externalName: nameOf(a ? r.targetId! : r.agentId),
        });
    }
    return teamTemplateSchema.parse({
      name: data.name,
      description: data.description,
      agents,
      edges,
      rules,
      externalDependencies: external,
      includesAbsolutePaths: data.includeAbsolutePaths,
      // Membership outside the saved selection is dropped; emptied groups disappear.
      groups: data.groups
        .map((g) => ({
          name: g.name,
          agentKeys: g.agentIds
            .map((id) => keyOf.get(id))
            .filter((k): k is string => Boolean(k)),
        }))
        .filter((g) => g.agentKeys.length),
    });
  }

  create(input: unknown): StoredTemplate {
    const template = this.build(input);
    const now = new Date().toISOString();
    // Library metadata only (never exported): the live team the selection was saved from.
    const spaces = this.service.teamSpaces;
    const from = new Set(
      createSchema
        .parse(input)
        .agentIds.map((id) => {
          try {
            return spaces.teamOfAgent(this.store.get<Agent>("agent", id));
          } catch {
            return null;
          }
        })
        .filter((t): t is string => !!t),
    );
    const sourceTeam =
      from.size === 1
        ? (({ id, name }) => ({ id, name }))(spaces.get([...from][0]))
        : undefined;
    return this.store.transaction(() => {
      const stored = {
        ...template,
        ...(sourceTeam ? { sourceTeam } : {}),
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      this.store.put("team-template", stored);
      this.store.emit("team-template.created", stored.id);
      return stored;
    });
  }
  list() {
    return this.store.list<StoredTemplate>("team-template").map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      version: t.version,
      agents: t.agents.length,
      updatedAt: t.updatedAt,
      ...(t.sourceTeam ? { sourceTeam: t.sourceTeam } : {}),
    }));
  }
  get(id: string) {
    return this.store.get<StoredTemplate>("team-template", id);
  }
  update(id: string, input: unknown) {
    const data = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(4000).optional(),
      })
      .strict()
      .parse(input);
    const current = this.get(id);
    return this.store.transaction(() => {
      const next = {
        ...current,
        ...data,
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      };
      this.store.put("team-template", next);
      this.store.emit("team-template.updated", id);
      return next;
    });
  }
  duplicate(id: string) {
    const current = this.get(id);
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      const copy = {
        ...current,
        id: randomUUID(),
        name: `${current.name} copy`.slice(0, 120),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.store.put("team-template", copy);
      this.store.emit("team-template.created", copy.id);
      return copy;
    });
  }
  delete(id: string) {
    this.get(id);
    this.store.transaction(() => {
      this.store.remove("team-template", id);
      this.store.emit("team-template.deleted", id);
    });
  }

  export(id: string): TeamTemplateEnvelope {
    const {
      id: _id,
      createdAt,
      updatedAt,
      sourceTeam,
      ...template
    } = this.get(id);
    return {
      format: TEAM_TEMPLATE_FORMAT,
      schemaVersion: TEAM_TEMPLATE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      template: teamTemplateSchema.parse(template),
    };
  }
  /** Validate an imported envelope and add it to the library (no agents are created). */
  import(envelope: unknown): StoredTemplate {
    const template = checkCompatibility(envelope);
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      const stored = {
        ...template,
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      this.store.put("team-template", stored);
      this.store.emit("team-template.created", stored.id);
      return stored;
    });
  }

  private resolve(opts: z.output<typeof insertSchema>): TeamTemplate {
    if (opts.templateId) {
      const { id, createdAt, updatedAt, sourceTeam, ...template } = this.get(
        opts.templateId,
      );
      return teamTemplateSchema.parse(template);
    }
    return checkCompatibility(opts.envelope);
  }

  /** Pure validation of the template against this installation; no writes. */
  private validate(
    t: TeamTemplate,
    opts: z.output<typeof insertSchema>,
    mapped: Map<string, string>,
  ): Preview {
    const issues: Issue[] = [];
    const warnings: string[] = [];
    const slots: Preview["workspaceSlots"] = [];
    const runtimes = this.runtimes();
    for (const a of t.agents) {
      const issue = (code: string, message: string) =>
        issues.push({
          code,
          message: `${a.name}: ${message}`,
          agentKey: a.key,
        });
      if (SECRET_PATTERN.test(a.instructions + "\n" + a.role))
        warnings.push(
          `${a.name}: instructions look like they contain a credential; review before sharing`,
        );
      const runtime = runtimes?.find((r) => r.id === a.environment);
      if (runtimes && !runtime?.installed && !opts.allowUninstalledEnvironments)
        issue(
          "environment_unavailable",
          `${a.environment} is not installed or detected on this machine`,
        );
      const model = opts.modelMap[`${a.environment}:${a.model}`] ?? a.model;
      if (runtime?.installed && model !== "default") {
        const found = runtime.models.find((m) => m.id === model);
        if (!found && !opts.allowUnknownModels)
          issue(
            "model_unavailable",
            `model ${model} is not advertised by ${a.environment}; map it or allow unknown models`,
          );
        else if (
          found &&
          a.effort &&
          found.efforts.length &&
          !found.efforts.includes(a.effort)
        )
          issue(
            "effort_unsupported",
            `effort ${a.effort} is not supported by ${model}`,
          );
      }
      for (const s of a.skills) {
        const skill = this.service.skills.items.get(s.id);
        if (!skill) {
          issue("missing_skill", `skill ${s.id} is not installed`);
          continue;
        }
        if (!skill.environments.includes(a.environment) && !s.allowUnverified)
          issue(
            "incompatible_skill",
            `${skill.name} has no declared support for ${a.environment}`,
          );
        for (const tool of skill.requiresTools)
          if (!a.tools.includes(tool))
            issue("missing_tool", `${skill.name} requires ${tool}`);
      }
      for (const w of a.workspaces) {
        const id = `${a.key}/${w.slot}`;
        slots.push({
          agentKey: a.key,
          slot: w.slot,
          label: w.label,
          access: w.access,
          embeddedPath: Boolean(w.path),
        });
        if (
          opts.workspaces[id] === undefined &&
          !(w.path && opts.useEmbeddedPaths)
        )
          issue(
            "workspace_unmapped",
            `workspace ${w.label || w.slot} (${id}) needs a directory mapping`,
          );
      }
      const paths = a.workspaces
        .map((w) => mapped.get(`${a.key}/${w.slot}`))
        .filter(Boolean);
      if (new Set(paths).size !== paths.length)
        issue("duplicate_workspace", "the same directory is attached twice");
    }
    for (const k of Object.keys(opts.workspaces))
      if (!slots.some((s) => `${s.agentKey}/${s.slot}` === k))
        issues.push({
          code: "unknown_workspace_slot",
          message: `Mapping ${k} does not match any template workspace`,
        });
    return {
      ok: !issues.length,
      issues,
      warnings,
      workspaceSlots: slots,
      externalDependencies: t.externalDependencies,
      counts: {
        agents: t.agents.length,
        edges: t.edges.length,
        rules: t.rules.length,
      },
    };
  }

  /** Resolve and verify workspace directories (async fs work, outside the transaction). */
  private async mapWorkspaces(
    t: TeamTemplate,
    opts: z.output<typeof insertSchema>,
  ) {
    const mapped = new Map<string, string>();
    const problems: Issue[] = [];
    for (const a of t.agents)
      for (const w of a.workspaces) {
        const id = `${a.key}/${w.slot}`;
        const raw =
          opts.workspaces[id] ?? (opts.useEmbeddedPaths ? w.path : undefined);
        if (raw === undefined) continue;
        try {
          if (!isAbsolute(raw))
            throw new Error("Workspace paths must be absolute");
          const real = await realpath(raw);
          if (!(await stat(real)).isDirectory())
            throw new Error("Workspace must be a directory");
          mapped.set(id, real);
        } catch (e) {
          problems.push({
            code: "invalid_workspace",
            message: `${a.name}: workspace ${id}: ${(e as Error).message}`,
            agentKey: a.key,
          });
        }
      }
    return { mapped, problems };
  }

  async preview(input: unknown): Promise<Preview> {
    const opts = insertSchema.parse(input);
    const t = this.resolve(opts);
    const { mapped, problems } = await this.mapWorkspaces(t, opts);
    const p = this.validate(t, opts, mapped);
    p.issues.push(...problems);
    p.ok = !p.issues.length;
    return p;
  }

  /**
   * Insert the whole team atomically: validation failure or any error leaves nothing behind.
   * `inTransaction` (used by team packs) runs synchronously inside the same transaction, after the
   * entities are written, so related records commit or roll back together with the team.
   */
  async insert(
    input: unknown,
    inTransaction?: (
      result: {
        agents: Agent[];
        edges: Edge[];
        rules: Rule[];
        idMap: Record<string, string>;
      },
      template: TeamTemplate,
    ) => void,
  ) {
    const opts = insertSchema.parse(input);
    const t = this.resolve(opts);
    const { mapped, problems } = await this.mapWorkspaces(t, opts);
    return this.store.transaction(() => {
      // Re-validate inside the synchronous section so state cannot change between check and write.
      const p = this.validate(t, opts, mapped);
      p.issues.push(...problems);
      if (p.issues.length)
        throw new AppError(
          422,
          "template_invalid",
          `Team cannot be inserted: ${p.issues.map((i) => i.message).join("; ")}`,
        );
      assert(
        !t.agents.some(
          (a) => (a as { kind?: string }).kind === "team-assistant",
        ),
        "duplicate_assistant",
        "Only one team assistant is allowed",
      );
      const spaces = this.service.teamSpaces;
      const team = opts.teamId
        ? spaces.get(spaces.forCreate(opts.teamId))
        : spaces.createInTx(opts.teamName ?? t.name, t.description);
      spaces.activateInTx(team.id);
      const ids = new Map(t.agents.map((a) => [a.key, randomUUID()]));
      const createdAt = new Date().toISOString();
      const layout: Record<string, { x: number; y: number }> = {};
      const agents: Agent[] = t.agents.map((a) => {
        const data = agentSchema.parse({
          name: a.name,
          role: a.role,
          kind: "agent",
          environment: a.environment,
          model: opts.modelMap[`${a.environment}:${a.model}`] ?? a.model,
          effort: a.effort,
          schedulingPriority: a.schedulingPriority,
          maxConcurrentInvocations: a.maxConcurrentInvocations,
          instructions: a.instructions,
          tools: a.tools,
          skills: a.skills,
          workspaces: a.workspaces.map((w) => ({
            path: mapped.get(`${a.key}/${w.slot}`)!,
            access: w.access,
            active: w.active,
          })),
          parentId: a.parentKey ? ids.get(a.parentKey)! : null,
        });
        const id = ids.get(a.key)!;
        layout[id] = {
          x: a.position.x + opts.offset.x,
          y: a.position.y + opts.offset.y,
        };
        return { ...data, teamId: team.id, id, control: "team", createdAt };
      });
      const edges: Edge[] = t.edges.map((e) => ({
        ...edgeSchema.parse({
          ...e,
          from: ids.get(e.from)!,
          to: ids.get(e.to)!,
        }),
        id: randomUUID(),
      }));
      const rules: Rule[] = t.rules.map((r) => {
        const { agentKey, targetKey, ...rest } = r;
        return {
          ...ruleSchema.parse({
            ...rest,
            agentId: ids.get(agentKey)!,
            ...(targetKey ? { targetId: ids.get(targetKey)! } : {}),
          }),
          id: randomUUID(),
        };
      });
      for (const a of agents) {
        this.store.put("agent", a);
        this.store.emit("agent.created", a.id);
      }
      for (const e of edges) {
        this.store.put("edge", e);
        this.store.emit("edge.created", e.id);
      }
      for (const r of rules) {
        this.store.put("rule", r);
        this.store.emit("rule.created", r.id);
      }
      const result = {
        teamId: team.id,
        teamName: team.name,
        agents,
        edges,
        rules,
        layout,
        idMap: Object.fromEntries(ids),
        externalDependencies: t.externalDependencies,
        warnings: p.warnings,
        groups: t.groups.map((g) => ({
          name: g.name,
          agentIds: g.agentKeys.map((k) => ids.get(k)!),
        })),
      };
      inTransaction?.(result, t);
      this.store.emit("team.inserted", agents[0].id, {
        template: t.name,
        agentIds: agents.map((a) => a.id),
      });
      return result;
    });
  }
}
