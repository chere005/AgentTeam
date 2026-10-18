// Team packs: install (atomic, via TeamTemplates.insert) and explicit update of versioned packs.
//
// Install never imports credentials or absolute paths, never pre-approves skills and requires the
// user to acknowledge the listed grants (write access, tools, skills, required reviews).
// Update never auto-overwrites local edits: it three-way diffs the installed pack version, the new
// version and the live configuration (src/team-pack-diff.ts), applies only fields the user never
// changed, and writes nothing until every conflict has an explicit resolution.
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AppError,
  agentSchema,
  edgeSchema,
  ruleSchema,
  assert,
  type Agent,
  type Edge,
  type Rule,
  type Session,
} from "./model.ts";
import type { TeamService } from "./service.ts";
import {
  TEAM_TEMPLATE_FORMAT,
  TEAM_TEMPLATE_SCHEMA_VERSION,
  type TeamTemplate,
  type TeamTemplates,
} from "./teams.ts";
import {
  checkPackSkills,
  edgeKey,
  manifestHash,
  packGrants,
  parseManifest,
  ruleKey,
  stableStringify,
  type PackManifest,
} from "./team-pack-manifest.ts";
import {
  computeDiff,
  type Change,
  type Fields,
  type Resolution,
  type View,
} from "./team-pack-diff.ts";

const KIND = "team-pack-install";
const point = z.object({ x: z.number(), y: z.number() }).strict();
const source = {
  packId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,62}$/)
    .optional(),
  manifest: z.unknown().optional(),
};
const oneSource = (v: { packId?: string; manifest?: unknown }) =>
  Boolean(v.packId) !== (v.manifest !== undefined);
const installSchema = z
  .object({
    ...source,
    workspaces: z.record(z.string(), z.string()).default({}),
    modelMap: z.record(z.string(), z.string().min(1)).default({}),
    allowUnknownModels: z.boolean().default(false),
    allowUninstalledEnvironments: z.boolean().default(false),
    offset: point.default({ x: 0, y: 0 }),
    /** Must be true to install a pack that lists grants (write access, tools, skills, required reviews). */
    acknowledgeGrants: z.boolean().default(false),
    allowDuplicate: z.boolean().default(false),
  })
  .strict()
  .refine(oneSource, { message: "Provide exactly one of packId or manifest" });
const updateSchema = z
  .object({
    ...source,
    modelMap: z.record(z.string(), z.string().min(1)).default({}),
    /** Change id -> decision, for every conflict. */
    resolutions: z
      .record(z.string(), z.enum(["keep-local", "take-pack"]))
      .default({}),
    /** diffHash from the preview; the update is refused if the configuration changed since. */
    diffHash: z.string().optional(),
    acceptLicenseChanges: z.boolean().default(false),
    offset: point.default({ x: 0, y: 0 }),
  })
  .strict()
  .refine(oneSource, { message: "Provide exactly one of packId or manifest" });

export type PackInstall = {
  id: string;
  packId: string;
  name: string;
  version: string;
  manifestHash: string;
  installedAt: string;
  updatedAt: string;
  modelMap: Record<string, string>;
  /** The installed pack version; its `template` is the "old" side of every later three-way diff. */
  manifest: PackManifest;
  ids: {
    agents: Record<string, string>;
    edges: Record<string, string>;
    rules: Record<string, string>;
  };
  /** Union of upstream notices from every installed version (never dropped by an update). */
  notices: string[];
  history: { version: string; at: string; manifestHash: string }[];
};

const versionParts = (v: string) => v.split(".").map(Number);
export function compareVersions(a: string, b: string) {
  const [x, y] = [versionParts(a), versionParts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const effectiveModel = (
  map: Record<string, string>,
  env: string,
  model: string,
) => map[`${env}:${model}`] ?? model;
const sortedSkills = (
  skills: { id: string; mode: string; allowUnverified: boolean }[],
) =>
  skills
    .map((s) => ({
      id: s.id,
      mode: s.mode,
      allowUnverified: s.allowUnverified,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

/** Configuration view of a template; workspaces and canvas positions are local-only and excluded. */
export function templateView(
  t: TeamTemplate,
  modelMap: Record<string, string>,
): View {
  const view: View = { agents: {}, edges: {}, rules: {} };
  for (const a of t.agents)
    view.agents[a.key] = {
      name: a.name,
      role: a.role,
      environment: a.environment,
      model: effectiveModel(modelMap, a.environment, a.model),
      effort: a.effort,
      schedulingPriority: a.schedulingPriority,
      maxConcurrentInvocations: a.maxConcurrentInvocations,
      instructions: a.instructions,
      tools: [...a.tools],
      skills: sortedSkills(a.skills),
      parent: a.parentKey,
    };
  for (const e of t.edges)
    view.edges[edgeKey(e)] = {
      bidirectional: e.bidirectional,
      kind: e.kind,
      enabled: e.enabled,
    };
  for (const r of t.rules)
    view.rules[ruleKey(r)] = {
      priority: r.priority,
      enabled: r.enabled,
      match: r.match,
      mode: r.mode,
      specialty: r.specialty ?? null,
      kind: r.kind,
    };
  return view;
}

type Summary = {
  id: string;
  packId: string;
  name: string;
  version: string;
  status: string;
  installedAt: string;
  updatedAt: string;
};
const summarize = (r: PackInstall): Summary => ({
  id: r.id,
  packId: r.packId,
  name: r.name,
  version: r.version,
  status: r.manifest.pack.status,
  installedAt: r.installedAt,
  updatedAt: r.updatedAt,
});

export class TeamPacks {
  service: TeamService;
  teams: TeamTemplates;
  assetsDir: () => string;
  constructor(
    service: TeamService,
    teams: TeamTemplates,
    assetsDir: () => string,
  ) {
    this.service = service;
    this.teams = teams;
    this.assetsDir = assetsDir;
  }
  private get store() {
    return this.service.store;
  }

  // ---- bundled library -------------------------------------------------------------------

  private packsRoot() {
    return join(this.assetsDir(), "team-packs");
  }
  private loadBundled(packId: string): PackManifest {
    const file = join(this.packsRoot(), packId, "pack.json");
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(packId) || !existsSync(file))
      throw new AppError(404, "not_found", `team pack ${packId} not found`);
    const m = parseManifest(JSON.parse(readFileSync(file, "utf8")));
    assert(
      m.pack.id === packId,
      "invalid_pack",
      "Bundled pack id differs from its directory",
      500,
    );
    return m;
  }
  /** Bundled packs with their install state; a broken bundled pack is listed as invalid, not hidden. */
  library() {
    const root = this.packsRoot();
    const installs = this.store.list<PackInstall>(KIND);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          const m = this.loadBundled(d.name);
          return {
            packId: m.pack.id,
            name: m.pack.name,
            version: m.pack.version,
            description: m.pack.description,
            status: m.pack.status,
            license: m.pack.source.license,
            source: m.pack.source.name,
            agents: m.template.agents.length,
            bundledSkills: m.skills.filter((s) => s.bundled).length,
            missingSkills: m.skills.filter((s) => !s.bundled).length,
            limitations: m.pack.limitations,
            installs: installs
              .filter((i) => i.packId === m.pack.id)
              .map((i) => ({ id: i.id, version: i.version })),
          };
        } catch (e) {
          return { packId: d.name, invalid: (e as Error).message };
        }
      });
  }
  /** The full bundled manifest (for the preview UI). */
  bundled(packId: string) {
    return this.loadBundled(packId);
  }
  private resolve(opts: { packId?: string; manifest?: unknown }): PackManifest {
    return opts.packId
      ? this.loadBundled(opts.packId)
      : parseManifest(opts.manifest);
  }

  // ---- shared checks ---------------------------------------------------------------------

  /** Pack-level problems that block installation or update (license/notice and pin checks). */
  private packIssues(m: PackManifest) {
    const issues: { code: string; message: string }[] = [];
    const skills = checkPackSkills(this.assetsDir(), m);
    for (const s of skills)
      for (const p of s.problems)
        issues.push({
          code: "skill_license",
          message: `Skill ${s.name}: ${p}`,
        });
    for (const s of m.skills) {
      if (!s.bundled) continue;
      const live = this.service.skills.items.get(s.id);
      if (live && live.hash !== s.sha256)
        issues.push({
          code: "skill_pin_mismatch",
          message: `Skill ${s.name}: installed content differs from the revision pinned by the pack`,
        });
    }
    const warnings: string[] = [];
    if (
      !/^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1\.0\.0|CC0-1\.0|Python-2\.0)$/.test(
        m.pack.source.license,
      )
    )
      warnings.push(
        `Pack license ${m.pack.source.license} is not on AgentTeam's allow-list; review it before use`,
      );
    return { issues, warnings, skills };
  }

  private envelope(m: PackManifest) {
    return {
      format: TEAM_TEMPLATE_FORMAT,
      schemaVersion: TEAM_TEMPLATE_SCHEMA_VERSION,
      template: m.template,
    };
  }

  // ---- install ---------------------------------------------------------------------------

  /** Compatibility and installation changes; writes nothing. */
  async preview(input: unknown) {
    const opts = installSchema.parse(input);
    const m = this.resolve(opts);
    const pack = this.packIssues(m);
    const install = await this.teams.preview({
      envelope: this.envelope(m),
      workspaces: opts.workspaces,
      modelMap: opts.modelMap,
      allowUnknownModels: opts.allowUnknownModels,
      allowUninstalledEnvironments: opts.allowUninstalledEnvironments,
    });
    const issues = [...pack.issues, ...install.issues];
    const existing = this.store
      .list<PackInstall>(KIND)
      .filter((i) => i.packId === m.pack.id);
    if (existing.length && !opts.allowDuplicate)
      issues.push({
        code: "pack_already_installed",
        message: `${m.pack.name} ${existing[0].version} is already installed; use update, or allow a second copy`,
      });
    const runtimes = this.teams.runtimes();
    const grants = packGrants(m);
    return {
      ok: !issues.length,
      pack: m.pack,
      manifestHash: manifestHash(m),
      issues,
      warnings: [...pack.warnings, ...install.warnings],
      harnesses: m.harnesses.map((h) => ({
        ...h,
        usedBy: m.template.agents
          .filter((a) => a.environment === h.environment)
          .map((a) => a.name),
        installed: runtimes
          ? Boolean(runtimes.find((r) => r.id === h.environment)?.installed)
          : null,
      })),
      skills: m.skills.map((s, i) => ({
        ...(s.bundled
          ? {
              id: s.id,
              license: s.license,
              revision: s.revision,
              source: s.source,
              licenseFile: s.licenseFile,
            }
          : { purpose: s.purpose, note: s.note }),
        name: s.name,
        bundled: s.bundled,
        status: pack.skills[i].status,
        installedHere: s.bundled ? this.service.skills.items.has(s.id) : false,
      })),
      modelMappings: m.modelMappings,
      tools: m.tools,
      grants,
      workspaceSlots: install.workspaceSlots,
      externalDependencies: install.externalDependencies,
      changes: {
        agents: m.template.agents.map((a) => ({
          key: a.key,
          name: a.name,
          environment: a.environment,
          model: effectiveModel(opts.modelMap, a.environment, a.model),
          skills: a.skills.map((s) => s.id),
        })),
        edges: m.template.edges.length,
        rules: m.template.rules.length,
        groups: m.template.groups.map((g) => g.name),
        records: [
          "one team-pack install record (version, pinned manifest, attribution)",
        ],
      },
      requiresGrantAcknowledgement: grants.length > 0,
    };
  }

  /** Insert the pack's team and its install record in one transaction. */
  async install(input: unknown) {
    const opts = installSchema.parse(input);
    const m = this.resolve(opts);
    const p = await this.preview(input);
    if (p.issues.length)
      throw new AppError(
        422,
        "pack_invalid",
        `Pack cannot be installed: ${p.issues.map((i) => i.message).join("; ")}`,
      );
    assert(
      !p.requiresGrantAcknowledgement || opts.acknowledgeGrants,
      "grants_not_acknowledged",
      "Installing this pack grants access listed in its preview; acknowledge the grants to continue",
      422,
    );
    let installId = "";
    const result = await this.teams.insert(
      {
        envelope: this.envelope(m),
        workspaces: opts.workspaces,
        modelMap: opts.modelMap,
        allowUnknownModels: opts.allowUnknownModels,
        allowUninstalledEnvironments: opts.allowUninstalledEnvironments,
        offset: opts.offset,
      },
      (r, t) => {
        const now = new Date().toISOString();
        const record: PackInstall = {
          id: randomUUID(),
          packId: m.pack.id,
          name: m.pack.name,
          version: m.pack.version,
          manifestHash: manifestHash(m),
          installedAt: now,
          updatedAt: now,
          modelMap: opts.modelMap,
          manifest: m,
          ids: {
            agents: r.idMap,
            edges: Object.fromEntries(
              t.edges.map((e, i) => [edgeKey(e), r.edges[i].id]),
            ),
            rules: Object.fromEntries(
              t.rules.map((x, i) => [ruleKey(x), r.rules[i].id]),
            ),
          },
          notices: [...m.pack.notices],
          history: [
            { version: m.pack.version, at: now, manifestHash: manifestHash(m) },
          ],
        };
        installId = record.id;
        this.store.put(KIND, record);
        this.store.emit("team-pack.installed", record.id, {
          pack: m.pack.id,
          version: m.pack.version,
        });
      },
    );
    return { ...result, installId };
  }

  installed() {
    return this.store.list<PackInstall>(KIND).map(summarize);
  }
  getInstall(id: string) {
    return this.store.get<PackInstall>(KIND, id);
  }

  // ---- update ----------------------------------------------------------------------------

  private localView(r: PackInstall): View {
    const view: View = { agents: {}, edges: {}, rules: {} };
    const agents = new Map(
      this.store.list<Agent>("agent").map((a) => [a.id, a]),
    );
    const keyOfId = new Map(
      Object.entries(r.ids.agents).map(([k, id]) => [id, k]),
    );
    for (const [key, id] of Object.entries(r.ids.agents)) {
      const a = agents.get(id);
      if (!a) continue;
      view.agents[key] = {
        name: a.name,
        role: a.role,
        environment: a.environment,
        model: a.model,
        effort: a.effort,
        schedulingPriority: a.schedulingPriority,
        maxConcurrentInvocations: a.maxConcurrentInvocations,
        instructions: a.instructions,
        tools: [...a.tools],
        skills: sortedSkills(a.skills),
        parent: a.parentId
          ? (keyOfId.get(a.parentId) ?? `external:${a.parentId}`)
          : null,
      };
    }
    const edges = new Map(this.store.list<Edge>("edge").map((e) => [e.id, e]));
    for (const [key, id] of Object.entries(r.ids.edges)) {
      const e = edges.get(id);
      if (e)
        view.edges[key] = {
          bidirectional: e.bidirectional,
          kind: e.kind,
          enabled: e.enabled,
        };
    }
    const rules = new Map(this.store.list<Rule>("rule").map((x) => [x.id, x]));
    for (const [key, id] of Object.entries(r.ids.rules)) {
      const x = rules.get(id);
      if (x)
        view.rules[key] = {
          priority: x.priority,
          enabled: x.enabled,
          match: x.match,
          mode: x.mode ?? "advisory",
          specialty: x.specialty ?? null,
          kind: x.kind,
        };
    }
    return view;
  }

  private analyse(
    r: PackInstall,
    next: PackManifest,
    extraModelMap: Record<string, string>,
  ) {
    const modelMap = { ...r.modelMap, ...extraModelMap };
    const old = templateView(r.manifest.template, r.modelMap);
    const nextView = templateView(next.template, modelMap);
    const nameOf = (m: PackManifest) => (k: string) =>
      next.template.agents.find((a) => a.key === k)?.name ??
      m.template.agents.find((a) => a.key === k)?.name ??
      k;
    const changes = computeDiff(old, nextView, this.localView(r), {
      agent: nameOf(r.manifest),
    });
    return { modelMap, changes, nextView };
  }

  private licenseChanges(prev: PackManifest, next: PackManifest) {
    const out: {
      subject: string;
      change: string;
      from?: string;
      to?: string;
    }[] = [];
    if (prev.pack.source.license !== next.pack.source.license)
      out.push({
        subject: `pack ${next.pack.name}`,
        change: "license-changed",
        from: prev.pack.source.license,
        to: next.pack.source.license,
      });
    const was = new Map(
      prev.skills.flatMap((s) => (s.bundled ? [[s.id, s] as const] : [])),
    );
    for (const s of next.skills) {
      if (!s.bundled) continue;
      const p = was.get(s.id);
      if (!p)
        out.push({
          subject: `skill ${s.name}`,
          change: "added",
          to: `${s.license} @ ${s.revision.slice(0, 12)}`,
        });
      else {
        if (p.license !== s.license)
          out.push({
            subject: `skill ${s.name}`,
            change: "license-changed",
            from: p.license,
            to: s.license,
          });
        if (p.revision !== s.revision)
          out.push({
            subject: `skill ${s.name}`,
            change: "revision-changed",
            from: p.revision.slice(0, 12),
            to: s.revision.slice(0, 12),
          });
      }
    }
    for (const s of prev.skills)
      if (s.bundled && !next.skills.some((x) => x.bundled && x.id === s.id))
        out.push({
          subject: `skill ${s.name}`,
          change: "removed",
          from: s.license,
        });
    return out;
  }

  /** Configuration diff between the installed version and a new one; writes nothing. */
  async updatePreview(installId: string, input: unknown) {
    const opts = updateSchema.parse(input);
    const r = this.getInstall(installId);
    const next = this.resolve(opts);
    return this.updateReport(r, next, opts);
  }

  private updateReport(
    r: PackInstall,
    next: PackManifest,
    opts: z.output<typeof updateSchema>,
  ) {
    assert(
      next.pack.id === r.packId,
      "pack_mismatch",
      `This is pack ${next.pack.id}, not ${r.packId}`,
      422,
    );
    const pack = this.packIssues(next);
    const issues = [...pack.issues];
    const cmp = compareVersions(next.pack.version, r.version);
    if (cmp <= 0)
      issues.push({
        code: "not_newer",
        message: `Version ${next.pack.version} is not newer than the installed ${r.version}`,
      });
    const { changes, modelMap } = this.analyse(r, next, opts.modelMap);
    // Skills that will be applied must exist here (conflicts are checked once resolved).
    for (const c of changes)
      if (c.field === "skills" && c.status === "apply")
        for (const s of JSON.parse(c.new ?? "[]") as { id: string }[])
          if (!this.service.skills.items.has(s.id))
            issues.push({
              code: "missing_skill",
              message: `${c.label}: skill ${s.id} is not installed`,
            });
    const warnings = [...pack.warnings];
    for (const c of changes) {
      if (c.reason === "deleted-locally")
        warnings.push(`${c.label} was deleted locally and is not recreated`);
      if (c.reason === "removed-by-pack-kept")
        warnings.push(
          `${c.label} was removed by the pack but is kept (agents are never deleted by an update)`,
        );
      if (c.reason === "agent-missing")
        warnings.push(
          `${c.label} refers to an agent that no longer exists and is skipped`,
        );
      if (c.action === "add" && c.entity === "agent")
        warnings.push(
          `${c.label} is new in the pack; it is added without folders (attach them yourself)`,
        );
    }
    const licenseChanges = this.licenseChanges(r.manifest, next);
    const dropped = r.notices.filter((n) => !next.pack.notices.includes(n));
    if (dropped.length)
      warnings.push(
        `${dropped.length} upstream notice(s) from earlier versions are retained in the install record`,
      );
    const diffHash = createHash("sha256")
      .update(stableStringify({ changes, modelMap, to: manifestHash(next) }))
      .digest("hex");
    return {
      ok: !issues.length,
      install: summarize(r),
      from: r.version,
      to: next.pack.version,
      pack: next.pack,
      changes,
      conflicts: changes.filter((c) => c.status === "conflict").length,
      applicable: changes.filter((c) => c.status === "apply").length,
      keptLocal: changes.filter((c) => c.status === "keep-local").length,
      issues,
      warnings,
      skills: pack.skills,
      licenseChanges,
      requiresLicenseAcceptance: licenseChanges.some(
        (c) => c.change !== "removed",
      ),
      diffHash,
    };
  }

  /** Apply an update atomically; refuses on unresolved conflicts, stale previews or busy agents. */
  async update(installId: string, input: unknown) {
    const opts = updateSchema.parse(input);
    const next = this.resolve(opts);
    return this.store.transaction(() => {
      const r = this.getInstall(installId);
      const report = this.updateReport(r, next, opts);
      if (report.issues.length)
        throw new AppError(
          422,
          "pack_update_invalid",
          `Update cannot be applied: ${report.issues.map((i) => i.message).join("; ")}`,
        );
      assert(
        opts.diffHash === report.diffHash,
        "diff_stale",
        "The configuration or pack changed since the preview; review the diff again",
        409,
      );
      assert(
        !report.requiresLicenseAcceptance || opts.acceptLicenseChanges,
        "license_change_unacknowledged",
        "This version changes pack or companion-skill license/revision information; acknowledge it to continue",
        422,
      );
      const byId = new Map(report.changes.map((c) => [c.id, c]));
      for (const id of Object.keys(opts.resolutions))
        assert(
          byId.get(id)?.status === "conflict",
          "unknown_resolution",
          `${id} is not a conflict in this update`,
          422,
        );
      const unresolved = report.changes.filter(
        (c) => c.status === "conflict" && !opts.resolutions[c.id],
      );
      if (unresolved.length)
        throw new AppError(
          409,
          "unresolved_conflicts",
          `Resolve ${unresolved.length} conflict(s) first (keep local or take the pack value): ${unresolved.map((c) => c.id).join(", ")}`,
        );
      const take = (c: Change) =>
        c.status === "apply" ||
        (c.status === "conflict" && opts.resolutions[c.id] === "take-pack");
      const { nextView, modelMap } = this.analyse(r, next, opts.modelMap);
      const localAgents = new Map(
        this.store.list<Agent>("agent").map((a) => [a.id, a]),
      );
      const running = new Set(
        this.store
          .list<Session>("session")
          .filter((s) => s.state === "running")
          .map((s) => s.agentId),
      );
      const ids = {
        agents: { ...r.ids.agents },
        edges: { ...r.ids.edges },
        rules: { ...r.ids.rules },
      };
      const notes: string[] = [];
      const layout: Record<string, { x: number; y: number }> = {};
      const created: Agent[] = [];
      const createdKey = new Map<string, string>();
      const now = new Date().toISOString();

      // Agents: adds first so dependent parents/edges/rules can resolve them.
      for (const c of report.changes.filter(
        (c) => c.entity === "agent" && c.action === "add" && take(c),
      )) {
        const f = nextView.agents[c.key]!;
        const t = next.template.agents.find((a) => a.key === c.key)!;
        const data = agentSchema.parse({
          name: f.name,
          role: f.role,
          kind: "agent",
          environment: f.environment,
          model: f.model,
          effort: f.effort,
          schedulingPriority: f.schedulingPriority,
          maxConcurrentInvocations: f.maxConcurrentInvocations,
          instructions: f.instructions,
          tools: f.tools,
          skills: f.skills,
          workspaces: [],
          parentId: null,
        });
        const agent: Agent = {
          ...data,
          id: randomUUID(),
          control: "team",
          createdAt: now,
        };
        ids.agents[c.key] = agent.id;
        createdKey.set(agent.id, c.key);
        layout[agent.id] = {
          x: t.position.x + opts.offset.x,
          y: t.position.y + opts.offset.y,
        };
        created.push(agent);
        localAgents.set(agent.id, agent);
      }
      const patches = new Map<string, Fields>();
      for (const c of report.changes)
        if (c.entity === "agent" && c.field && take(c)) {
          const patch = patches.get(c.key) ?? {};
          patch[c.field] = nextView.agents[c.key]![c.field];
          patches.set(c.key, patch);
        }
      const busy: string[] = [];
      for (const key of patches.keys()) {
        const id = ids.agents[key];
        if (id && running.has(id)) busy.push(localAgents.get(id)?.name ?? key);
      }
      assert(
        !busy.length,
        "agent_busy",
        `Stop the active session of ${busy.join(", ")} before updating it`,
        409,
      );
      const updated: Agent[] = [];
      const parentPatches: [string, string | null][] = [];
      for (const a of created) {
        const key = createdKey.get(a.id)!;
        parentPatches.push([
          key,
          (nextView.agents[key]!.parent as string | null) ?? null,
        ]);
      }
      for (const [key, patch] of patches) {
        const agent = localAgents.get(ids.agents[key]);
        if (!agent) continue;
        const { parent, ...fields } = patch;
        if ("parent" in patch)
          parentPatches.push([key, parent as string | null]);
        const keys = Object.keys(agentSchema.shape);
        const base = Object.fromEntries(
          Object.entries(agent).filter(([k]) => keys.includes(k)),
        );
        const parsed = agentSchema.parse({ ...base, ...fields });
        updated.push({ ...agent, ...parsed });
      }
      const resultAgents = new Map<string, Agent>();
      for (const a of [...created, ...updated]) resultAgents.set(a.id, a);
      for (const [key, parentKey] of parentPatches) {
        const id = ids.agents[key];
        const agent = resultAgents.get(id) ?? localAgents.get(id);
        if (!agent) continue;
        const parentId =
          parentKey === null ? null : (ids.agents[parentKey] ?? undefined);
        if (
          parentId === undefined ||
          (parentId !== null && !localAgents.has(parentId))
        ) {
          notes.push(
            `${agent.name}: parent was not changed because the new parent no longer exists`,
          );
          continue;
        }
        resultAgents.set(id, { ...agent, parentId });
      }
      // Reject hierarchy cycles introduced by the combination of changes.
      const parentOf = (id: string) =>
        (resultAgents.get(id) ?? localAgents.get(id))?.parentId ?? null;
      for (const id of resultAgents.keys()) {
        const seen = new Set([id]);
        for (let p = parentOf(id); p; p = parentOf(p)) {
          assert(
            !seen.has(p),
            "parent_cycle",
            "Agent hierarchy must not contain a cycle",
            422,
          );
          seen.add(p);
        }
      }
      // Skills of every agent that will change must exist here.
      for (const [id, a] of resultAgents)
        for (const s of a.skills)
          assert(
            this.service.skills.items.has(s.id),
            "missing_skill",
            `${a.name}: skill ${s.id} is not installed`,
            422,
          );

      type Whole = { c: Change; fields: Fields | undefined };
      const wholes: Whole[] = report.changes
        .filter((c) => c.entity !== "agent" && take(c))
        .map((c) => ({
          c,
          fields: (c.entity === "edge" ? nextView.edges : nextView.rules)[
            c.key
          ],
        }));
      const edgeWrites: Edge[] = [];
      const edgeRemovals: string[] = [];
      const ruleWrites: Rule[] = [];
      const ruleRemovals: string[] = [];
      const edgesNow = new Map(
        this.store.list<Edge>("edge").map((e) => [e.id, e]),
      );
      const rulesNow = new Map(
        this.store.list<Rule>("rule").map((x) => [x.id, x]),
      );
      for (const { c, fields } of wholes) {
        const bag = c.entity === "edge" ? ids.edges : ids.rules;
        const existing = bag[c.key];
        if (!fields) {
          if (existing)
            (c.entity === "edge" ? edgeRemovals : ruleRemovals).push(existing);
          delete bag[c.key];
          continue;
        }
        const tid = (k: string) => ids.agents[k];
        if (c.entity === "edge") {
          const [pair] = c.key.split(":");
          const [from, to] = pair.split(">");
          const prev = existing ? edgesNow.get(existing) : undefined;
          const edge: Edge = {
            ...edgeSchema.parse({ ...fields, from: tid(from), to: tid(to) }),
            id: prev?.id ?? randomUUID(),
          };
          bag[c.key] = edge.id;
          edgeWrites.push(edge);
        } else {
          const [agent, target] = c.key.split("|");
          const prev = existing ? rulesNow.get(existing) : undefined;
          const { specialty, ...rest } = fields;
          const rule: Rule = {
            ...ruleSchema.parse({
              ...rest,
              ...(specialty ? { specialty } : {}),
              scope: c.key.split("|")[2],
              agentId: tid(agent),
              ...(target ? { targetId: tid(target) } : {}),
            }),
            id: prev?.id ?? randomUUID(),
          };
          bag[c.key] = rule.id;
          ruleWrites.push(rule);
        }
      }
      // A pack-removed entity the user chose to keep becomes purely local (no longer tracked).
      for (const c of report.changes)
        if (
          c.entity !== "agent" &&
          c.status === "conflict" &&
          opts.resolutions[c.id] === "keep-local"
        ) {
          const nextHas = (
            c.entity === "edge" ? nextView.edges : nextView.rules
          )[c.key];
          if (!nextHas)
            delete (c.entity === "edge" ? ids.edges : ids.rules)[c.key];
        }

      for (const a of created) {
        this.store.put("agent", resultAgents.get(a.id)!);
        this.store.emit("agent.created", a.id);
      }
      for (const a of updated) {
        this.store.put("agent", resultAgents.get(a.id)!);
        this.store.emit("agent.updated", a.id);
      }
      for (const id of edgeRemovals) {
        this.store.remove("edge", id);
        this.store.emit("edge.deleted", id);
      }
      for (const e of edgeWrites) {
        this.store.put("edge", e);
        this.store.emit(
          edgesNow.has(e.id) ? "edge.updated" : "edge.created",
          e.id,
        );
      }
      for (const id of ruleRemovals) {
        this.store.remove("rule", id);
        this.store.emit("rule.deleted", id);
      }
      for (const x of ruleWrites) {
        this.store.put("rule", x);
        this.store.emit(
          rulesNow.has(x.id) ? "rule.updated" : "rule.created",
          x.id,
        );
      }
      const hash = manifestHash(next);
      const record: PackInstall = {
        ...r,
        name: next.pack.name,
        version: next.pack.version,
        manifestHash: hash,
        updatedAt: now,
        modelMap,
        manifest: next,
        ids,
        notices: [...new Set([...r.notices, ...next.pack.notices])],
        history: [
          ...r.history,
          { version: next.pack.version, at: now, manifestHash: hash },
        ],
      };
      this.store.put(KIND, record);
      this.store.emit("team-pack.updated", r.id, {
        pack: r.packId,
        from: r.version,
        to: next.pack.version,
      });
      return {
        install: summarize(record),
        from: r.version,
        to: next.pack.version,
        applied: report.changes.filter(take).map((c) => c.id),
        keptLocal: report.changes
          .filter(
            (c) =>
              c.status === "keep-local" ||
              opts.resolutions[c.id] === "keep-local",
          )
          .map((c) => c.id),
        addedAgents: created.map((a) => a.id),
        layout,
        notes,
        warnings: report.warnings,
      };
    });
  }

  /** License/notice attribution retained for an installed pack (shown in the UI). */
  attribution(installId: string) {
    const r = this.getInstall(installId);
    const m = r.manifest;
    return {
      pack: {
        source: m.pack.source,
        name: m.pack.name,
        version: m.pack.version,
      },
      notices: r.notices,
      skills: m.skills.map((s) =>
        s.bundled
          ? {
              name: s.name,
              id: s.id,
              license: s.license,
              revision: s.revision,
              source: s.source,
              licenseFile: s.licenseFile,
            }
          : { name: s.name, note: s.note },
      ),
    };
  }
}
