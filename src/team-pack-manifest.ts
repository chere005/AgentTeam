// Versioned team-pack manifest: a team template plus provenance, per-skill license/pin references,
// supported harnesses/tools and model mappings. Pure validation only (no store access) so the
// release audit and the runtime share the same checks.
//
// A pack never carries credentials, absolute paths or permission grants: workspaces stay named slots
// the user maps, models are mappings the user chooses, and grants are listed for acknowledgement.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AppError, environment } from "./model.ts";
import {
  SECRET_PATTERN,
  teamTemplateSchema,
  type TeamTemplate,
} from "./teams.ts";

export const TEAM_PACK_FORMAT = "agentteam.team-pack";
/** Highest manifest version this build reads and the one it writes. */
export const TEAM_PACK_MANIFEST_VERSION = 1;

/** Licenses acceptable for bundled companion skills and packs (SPDX ids). Mirrors scripts/audit-release.mjs. */
export const ALLOWED_PACK_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Python-2.0",
]);

/** Shown (and required) wording for skills the pack wants but does not ship. */
export const NOT_BUNDLED_NOTE = "not bundled — install separately";

const slug = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const spdx = z.string().regex(/^[A-Za-z0-9.+-]+$/);
const https = z
  .string()
  .max(500)
  .regex(/^https:\/\/[^\s]+$/);
const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/);

const bundledSkill = z
  .object({
    bundled: z.literal(true),
    /** Catalog id of a skill that exists under assets/skills, e.g. curated:publisher--name. */
    id: z.string().regex(/^curated:[a-z0-9-]+$/),
    name: z.string().min(1).max(120),
    source: https,
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    license: spdx,
    /** Retained upstream license/notice file inside the skill's directory. */
    licenseFile: fileName.default("UPSTREAM-LICENSE.txt"),
  })
  .strict();
/** A capability the pack wants but cannot ship. Deliberately has no id, license, revision or hash. */
const missingSkill = z
  .object({
    bundled: z.literal(false),
    name: z.string().min(1).max(120),
    purpose: z.string().min(1).max(400),
    note: z.literal(NOT_BUNDLED_NOTE).default(NOT_BUNDLED_NOTE),
  })
  .strict();

const harness = z
  .object({
    environment,
    support: z.enum(["declared", "format-compatible", "unvalidated"]),
    note: z.string().max(400).default(""),
  })
  .strict();
const modelMapping = z
  .object({
    environment,
    templateModel: z.string().min(1),
    /** A suggestion shown to the user; never applied unless they choose it in the install options. */
    preferredModel: z.string().min(1).optional(),
    note: z.string().max(400).default(""),
  })
  .strict();

export const packManifestSchema = z
  .object({
    format: z.literal(TEAM_PACK_FORMAT),
    manifestVersion: z.number().int().min(1),
    pack: z
      .object({
        id: slug,
        name: z.string().trim().min(1).max(120),
        version: semver,
        description: z.string().max(4000).default(""),
        status: z.enum(["skeleton", "stable"]).default("stable"),
        /** Attribution for the pack itself. A pack's license is independent of its skills' licenses. */
        source: z
          .object({
            name: z.string().min(1).max(200),
            url: https.optional(),
            author: z.string().max(200).optional(),
            license: spdx,
            /** License/notice file shipped beside pack.json (bundled packs). */
            licenseFile: fileName.optional(),
          })
          .strict(),
        /** Upstream notices that must be retained verbatim when the pack is redistributed. */
        notices: z.array(z.string().min(1).max(2000)).max(20).default([]),
        /** What the pack does not cover or cannot do yet; required for skeletons. */
        limitations: z.array(z.string().min(1).max(600)).max(30).default([]),
      })
      .strict(),
    harnesses: z.array(harness).min(1).max(3),
    /** Tool identifiers agents in this pack declare; informational compatibility data. */
    tools: z.array(z.string().min(1)).default([]),
    modelMappings: z.array(modelMapping).default([]),
    skills: z
      .array(z.union([bundledSkill, missingSkill]))
      .max(50)
      .default([]),
    /** The team itself in template form; must not embed absolute paths. */
    template: teamTemplateSchema,
  })
  .strict()
  .superRefine((m, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set<string>();
    const bundled = new Set<string>();
    for (const s of m.skills)
      if (s.bundled) {
        if (ids.has(s.id)) bad(`Duplicate skill reference ${s.id}`);
        ids.add(s.id);
        bundled.add(s.id);
      }
    const supported = new Set(m.harnesses.map((h) => h.environment));
    if (supported.size !== m.harnesses.length) bad("Duplicate harness entry");
    const tools = new Set(m.tools);
    const t = m.template;
    if (
      t.includesAbsolutePaths ||
      t.agents.some((a) => a.workspaces.some((w) => w.path))
    )
      bad("Packs must not embed absolute paths; use workspace slots");
    for (const a of t.agents) {
      if (!/^[A-Za-z0-9_-]+$/.test(a.key))
        bad(`Agent key ${a.key} may only use letters, digits, - and _`);
      if (!supported.has(a.environment))
        bad(
          `Agent ${a.name} uses ${a.environment}, which the pack does not list under harnesses`,
        );
      for (const tool of a.tools)
        if (!tools.has(tool))
          bad(`Agent ${a.name} uses undeclared tool ${tool}`);
      for (const s of a.skills) {
        if (!bundled.has(s.id))
          bad(
            `Agent ${a.name} references skill ${s.id} that the pack does not declare as bundled`,
          );
        if (s.allowUnverified)
          bad(`Agent ${a.name}: packs must not pre-approve unverified skills`);
      }
    }
    const edgeKeys = new Set<string>();
    for (const e of t.edges) {
      const k = edgeKey(e);
      if (edgeKeys.has(k)) bad(`Duplicate connection ${k}`);
      edgeKeys.add(k);
    }
    const ruleKeys = new Set<string>();
    for (const r of t.rules) {
      const k = ruleKey(r);
      if (ruleKeys.has(k)) bad(`Duplicate rule ${k}`);
      ruleKeys.add(k);
    }
    if (m.pack.status === "skeleton" && !m.pack.limitations.length)
      bad("A skeleton pack must list what is missing under pack.limitations");
    for (const mm of m.modelMappings)
      if (!supported.has(mm.environment))
        bad(
          `Model mapping for ${mm.environment} has no matching harness entry`,
        );
  });
export type PackManifest = z.infer<typeof packManifestSchema>;
export type BundledSkillRef = z.infer<typeof bundledSkill>;

export const edgeKey = (e: TeamTemplate["edges"][number]) =>
  `${e.from}>${e.to}:${e.kind}`;
export const ruleKey = (r: TeamTemplate["rules"][number]) =>
  [r.agentKey, r.targetKey ?? "", r.scope, r.kind, r.specialty ?? ""].join("|");

const SECRET_KEY =
  /^(api[_-]?keys?|secrets?|passwords?|tokens?|credentials?|authorization|private[_-]?key)$/i;

/** Reject credential-looking keys or values anywhere in raw manifest JSON. */
export function scanForSecrets(value: unknown, path = "$"): string[] {
  const found: string[] = [];
  if (typeof value === "string") {
    if (SECRET_PATTERN.test(value))
      found.push(`${path} looks like a credential`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => found.push(...scanForSecrets(v, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) found.push(`${path}.${k} is a credential field`);
      found.push(...scanForSecrets(v, `${path}.${k}`));
    }
  }
  return found;
}

/** Parse and validate a manifest; never returns a partially valid pack. */
export function parseManifest(raw: unknown): PackManifest {
  const head = raw as { format?: unknown; manifestVersion?: unknown } | null;
  if (!head || typeof head !== "object" || head.format !== TEAM_PACK_FORMAT)
    throw new AppError(
      400,
      "invalid_pack",
      "Not an AgentTeam team-pack manifest",
    );
  if (
    typeof head.manifestVersion === "number" &&
    head.manifestVersion > TEAM_PACK_MANIFEST_VERSION
  )
    throw new AppError(
      422,
      "pack_too_new",
      `Pack manifest version ${head.manifestVersion} is newer than this AgentTeam supports (${TEAM_PACK_MANIFEST_VERSION}); update the app`,
    );
  const secrets = scanForSecrets(raw);
  if (secrets.length)
    throw new AppError(
      422,
      "pack_contains_credentials",
      `Pack rejected: ${secrets.slice(0, 5).join("; ")}`,
    );
  const parsed = packManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      400,
      "invalid_pack",
      `Invalid team-pack manifest: ${parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  return parsed.data;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, sortKeys(x)]),
        )
      : v;
export const stableStringify = (v: unknown) => JSON.stringify(sortKeys(v));
export const manifestHash = (m: PackManifest) =>
  createHash("sha256").update(stableStringify(m)).digest("hex");

export type Grant = { kind: string; agentKey?: string; description: string };
/** Everything installing the pack would let its agents do, listed so the user can acknowledge it. */
export function packGrants(m: PackManifest): Grant[] {
  const out: Grant[] = [];
  for (const a of m.template.agents) {
    for (const w of a.workspaces)
      if (w.access === "write")
        out.push({
          kind: "workspace-write",
          agentKey: a.key,
          description: `${a.name} gets read & write access to the folder you map for "${w.label || w.slot}"`,
        });
    for (const tool of a.tools)
      out.push({
        kind: "tool",
        agentKey: a.key,
        description: `${a.name} is configured to use tool ${tool}`,
      });
    for (const s of a.skills)
      out.push({
        kind: "skill",
        agentKey: a.key,
        description: `${a.name} loads skill ${s.id} (${s.mode})`,
      });
  }
  for (const r of m.template.rules)
    if (r.mode === "mandatory") {
      const who =
        m.template.agents.find((a) => a.key === r.agentKey)?.name ?? r.agentKey;
      out.push({
        kind: "required-review",
        agentKey: r.agentKey,
        description: `Required review by ${who}${r.specialty ? ` (${r.specialty})` : ""} blocks dependent tasks until it approves`,
      });
    }
  for (const a of m.template.agents)
    if (a.schedulingPriority > 75)
      out.push({
        kind: "priority",
        agentKey: a.key,
        description: `${a.name} runs at scheduling priority ${a.schedulingPriority}`,
      });
  return out;
}

export type SkillCheck = {
  id?: string;
  name: string;
  status: "ok" | "not-bundled" | "invalid";
  license?: string;
  revision?: string;
  problems: string[];
};
const sha256File = (p: string) =>
  createHash("sha256").update(readFileSync(p, "utf8")).digest("hex");

/**
 * Companion-skill license/notice and pin check. Independent of the pack's own license: every
 * bundled reference needs retained license text, an allowed license and pins that match both the
 * catalog and the bytes on disk. Not-bundled references carry no metadata and are not checked.
 */
export function checkPackSkills(
  assetsDir: string,
  m: PackManifest,
): SkillCheck[] {
  let catalog: { skills: Record<string, unknown>[] } = { skills: [] };
  try {
    catalog = JSON.parse(
      readFileSync(join(assetsDir, "recommended-skills.json"), "utf8"),
    );
  } catch {
    /* reported per skill below */
  }
  return m.skills.map((s): SkillCheck => {
    if (!s.bundled)
      return { name: s.name, status: "not-bundled", problems: [] };
    const problems: string[] = [];
    const dir = join(assetsDir, "skills", s.id.replace(/^curated:/, ""));
    if (!allowedLicense(s.license))
      problems.push(`license "${s.license}" is not on the allow-list`);
    if (!existsSync(join(dir, "SKILL.md")))
      problems.push("skill is not under assets/skills");
    const licensePath = join(dir, s.licenseFile);
    if (
      !existsSync(licensePath) ||
      readFileSync(licensePath, "utf8").trim().length < 100
    )
      problems.push(`license/notice text ${s.licenseFile} is missing or empty`);
    const entry = catalog.skills.find((c) => c.id === s.id);
    if (!entry) problems.push("skill has no bundled catalog entry");
    else {
      if (entry.license !== s.license)
        problems.push(
          `license differs from catalog ("${String(entry.license)}")`,
        );
      if (entry.commit !== s.revision)
        problems.push("pinned revision differs from catalog commit");
      if (entry.source !== s.source)
        problems.push("source differs from catalog");
      if ((entry.licenseFile ?? "UPSTREAM-LICENSE.txt") !== s.licenseFile)
        problems.push("license file differs from catalog");
      if (entry.skillSha256 && entry.skillSha256 !== s.sha256)
        problems.push("pinned sha256 differs from catalog");
    }
    if (
      existsSync(join(dir, "SKILL.md")) &&
      sha256File(join(dir, "SKILL.md")) !== s.sha256
    )
      problems.push("SKILL.md bytes differ from the pinned sha256");
    return {
      id: s.id,
      name: s.name,
      status: problems.length ? "invalid" : "ok",
      license: s.license,
      revision: s.revision,
      problems,
    };
  });
}
const allowedLicense = (l: string) => ALLOWED_PACK_LICENSES.has(l);

/** Pack-level license check, separate from the skills. `packDir` is where pack.json lives. */
export function checkPackLicense(packDir: string, m: PackManifest): string[] {
  const problems: string[] = [];
  const { license, licenseFile } = m.pack.source;
  if (!allowedLicense(license))
    problems.push(`pack license "${license}" is not on the allow-list`);
  if (!licenseFile)
    problems.push("pack.source.licenseFile is required for a bundled pack");
  else {
    const p = join(packDir, licenseFile);
    if (!existsSync(p) || readFileSync(p, "utf8").trim().length < 100)
      problems.push(
        `pack license/notice text ${licenseFile} is missing or empty`,
      );
  }
  return problems;
}
