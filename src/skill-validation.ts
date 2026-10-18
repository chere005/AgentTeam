import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { adapterFor, toolExposure, type AdapterId } from "./skill-adapters.ts";

/**
 * Validation of the bundled skill catalog (assets/skills + assets/recommended-skills.json) and,
 * optionally, of the scanned catalog (including locally installed harness skills).
 * Read-only and offline. Used by `GET /capabilities/skills/validation`, the audit event it emits and
 * `scripts/audit-release.mjs`.
 */
export const SUPPORTED_ENVIRONMENTS = ["codex", "claude", "wolfram"] as const;
export type Severity = "error" | "warning" | "info";
export type Finding = {
  severity: Severity;
  code: string;
  skillId?: string;
  message: string;
};
export type SkillValidationReport = {
  generatedAt: string;
  curatedOn: string | null;
  ok: boolean;
  counts: { skills: number; errors: number; warnings: number; infos: number };
  environments: {
    environment: string;
    adapter: AdapterId;
    skills: number;
    toolNote: string;
  }[];
  findings: Finding[];
  skills: {
    id: string;
    name: string;
    version: string | null;
    commit: string | null;
    license: string | null;
    environments: string[];
    requiresTools: string[];
    hashOk: boolean | null;
    status: "ok" | "warning" | "error";
  }[];
};
const manifestSchema = z
  .object({
    environments: z.array(z.enum(SUPPORTED_ENVIRONMENTS)),
    requiresTools: z.array(z.string()).default([]),
    catalogId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    compatibilityEvidence: z.enum(["format-only", "declared"]).optional(),
  })
  .strict();
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const SEMVER = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/;
export type ValidationInput = {
  /** Directory holding `skills/` and `recommended-skills.json` (the repo's `assets`). */
  assetsDir: string;
  /** Warnings from the scanned catalog, folded in as findings. */
  scanWarnings?: { path: string; message: string }[];
  /** Scanned skills (bundled and installed) for cross-origin duplicate/version checks. */
  scanned?: {
    id: string;
    name: string;
    version?: string;
    hash: string;
    origin: string;
    path: string;
  }[];
};
export async function validateSkillCatalog(
  input: ValidationInput,
): Promise<SkillValidationReport> {
  const findings: Finding[] = [];
  const add = (
    severity: Severity,
    code: string,
    message: string,
    skillId?: string,
  ) => findings.push({ severity, code, message, skillId });
  let catalog: { curatedOn?: string; skills: any[] } = { skills: [] };
  try {
    catalog = JSON.parse(
      await readFile(join(input.assetsDir, "recommended-skills.json"), "utf8"),
    );
    if (!Array.isArray(catalog.skills)) throw new Error("skills is not a list");
  } catch (e) {
    add(
      "error",
      "catalog_unreadable",
      "assets/recommended-skills.json could not be read: " +
        (e instanceof Error ? e.message : "unknown error"),
    );
    catalog = { skills: [] };
  }
  const skillsDir = join(input.assetsDir, "skills");
  const directories = await readdir(skillsDir, { withFileTypes: true })
    .then((d) => d.filter((x) => x.isDirectory()).map((x) => x.name))
    .catch(() => {
      add("error", "missing_directory", "assets/skills is missing");
      return [] as string[];
    });
  // Duplicates in the catalog itself.
  const ids = new Map<string, number>(),
    names = new Map<string, string[]>();
  for (const s of catalog.skills) {
    ids.set(String(s.id), (ids.get(String(s.id)) ?? 0) + 1);
    names.set(String(s.name), [...(names.get(String(s.name)) ?? []), s.id]);
  }
  for (const [id, n] of ids)
    if (n > 1)
      add("error", "duplicate_id", `Catalog id ${id} appears ${n} times`, id);
  for (const [name, list] of names)
    if (list.length > 1)
      add(
        "warning",
        "duplicate_name",
        `Skill name "${name}" is used by ${list.join(", ")}; assignments would be ambiguous in prompts`,
      );
  const perSkill: SkillValidationReport["skills"] = [];
  const bundled = catalog.skills.filter((s) => s.bundled);
  const bundledIds = new Set<string>();
  for (const entry of bundled) {
    const id = String(entry.id);
    bundledIds.add(id);
    const before = findings.length;
    const dir = String(entry.id).replace(/^[^:]*:/, "");
    const base = join(skillsDir, dir);
    let hashOk: boolean | null = null;
    let environments: string[] = [];
    let requiresTools: string[] = [];
    let version: string | null = null;
    if (!(await exists(base))) {
      add(
        "error",
        "missing_directory",
        `${id}: assets/skills/${dir} is missing`,
        id,
      );
    } else {
      for (const f of [
        "SKILL.md",
        "agentteam.json",
        entry.licenseFile ?? "UPSTREAM-LICENSE.txt",
      ])
        if (!(await exists(join(base, f))))
          add("error", "missing_file", `${id}: ${f} is missing`, id);
      // License text must be present and non-trivial; the id must be allowed to ship.
      if (!entry.license || entry.license === "Not specified")
        add(
          "error",
          "license_missing",
          `${id}: catalog license is not specified`,
          id,
        );
      try {
        const text = await readFile(
          join(base, entry.licenseFile ?? "UPSTREAM-LICENSE.txt"),
          "utf8",
        );
        if (text.trim().length < 100)
          add(
            "error",
            "license_text",
            `${id}: license text is empty or truncated`,
            id,
          );
      } catch {
        /* reported as missing_file */
      }
      let content: string | null = null;
      try {
        content = await readFile(join(base, "SKILL.md"), "utf8");
      } catch {
        /* reported as missing_file */
      }
      if (content !== null) {
        const actual = createHash("sha256").update(content).digest("hex");
        if (entry.skillSha256) {
          hashOk = actual === entry.skillSha256;
          if (!hashOk)
            add(
              "error",
              "hash_drift",
              `${id}: SKILL.md hash ${actual.slice(0, 12)}… differs from the catalog's curated ${String(entry.skillSha256).slice(0, 12)}… (edited since curation?)`,
              id,
            );
        } else
          add(
            "warning",
            "hash_unpinned",
            `${id}: catalog has no skillSha256`,
            id,
          );
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const doc = match ? parseDocument(match[1]) : null;
        if (!doc || doc.errors.length)
          add(
            "error",
            "front_matter",
            `${id}: SKILL.md front matter is missing or invalid`,
            id,
          );
        else {
          const meta: any = doc.toJS({ maxAliasCount: 20 }) ?? {};
          if (meta.name !== entry.name)
            add(
              "error",
              "name_mismatch",
              `${id}: SKILL.md name "${meta.name}" differs from catalog name "${entry.name}"`,
              id,
            );
          const raw = meta.metadata?.version ?? meta.version;
          version = raw === undefined ? null : String(raw);
          if (version && !SEMVER.test(version))
            add(
              "warning",
              "version_format",
              `${id}: declared version "${version}" is not a version number`,
              id,
            );
        }
      }
      // Manifest versus catalog.
      try {
        const manifest = manifestSchema.parse(
          JSON.parse(await readFile(join(base, "agentteam.json"), "utf8")),
        );
        environments = manifest.environments;
        requiresTools = manifest.requiresTools;
        if (manifest.catalogId && manifest.catalogId !== dir)
          add(
            "error",
            "manifest_mismatch",
            `${id}: manifest catalogId "${manifest.catalogId}" differs from directory`,
            id,
          );
        if (!manifest.environments.length)
          add(
            "warning",
            "no_environment",
            `${id}: declares no supported environment; it cannot be assigned`,
            id,
          );
        const support = entry.environmentSupport ?? {};
        for (const env of SUPPORTED_ENVIRONMENTS) {
          const text = String(support[env] ?? "");
          const unsupported = /^not\b/i.test(text) || text === "";
          const declared = manifest.environments.includes(env);
          if (declared && unsupported)
            add(
              "error",
              "environment_mismatch",
              `${id}: manifest supports ${env} but the catalog says "${text || "nothing"}"`,
              id,
            );
          else if (!declared && !unsupported)
            add(
              "warning",
              "environment_mismatch",
              `${id}: catalog claims ${env} support ("${text}") that the manifest does not declare`,
              id,
            );
        }
        if (
          manifest.compatibilityEvidence !== "format-only" &&
          manifest.compatibilityEvidence !== "declared"
        )
          add(
            "info",
            "compat_evidence",
            `${id}: no compatibility evidence recorded; treated as inferred`,
            id,
          );
        // Required tools versus adapters (no direct adapter exposes AgentTeam tools).
        for (const tool of requiresTools)
          for (const env of manifest.environments)
            add(
              "warning",
              "tool_unavailable",
              `${id}: requires tool "${tool}" on ${env}. ${toolExposure(adapterFor(env).id)} Assigning needs the agent to list it; nothing grants it.`,
              id,
            );
      } catch (e) {
        if (await exists(join(base, "agentteam.json")))
          add(
            "error",
            "manifest_invalid",
            `${id}: agentteam.json is invalid: ${e instanceof Error ? e.message.slice(0, 200) : "parse error"}`,
            id,
          );
      }
    }
    // Source revision.
    if (!entry.commit || !/^[0-9a-f]{40}$/.test(String(entry.commit)))
      add(
        "error",
        "revision_invalid",
        `${id}: upstream commit is missing or not a 40-character revision`,
        id,
      );
    if (!entry.source)
      add(
        "error",
        "source_missing",
        `${id}: upstream source URL is missing`,
        id,
      );
    const mine = findings.slice(before).filter((f) => f.skillId === id);
    perSkill.push({
      id,
      name: String(entry.name),
      version,
      commit: entry.commit ?? null,
      license: entry.license ?? null,
      environments,
      requiresTools,
      hashOk,
      status: mine.some((f) => f.severity === "error")
        ? "error"
        : mine.some((f) => f.severity === "warning")
          ? "warning"
          : "ok",
    });
  }
  for (const dir of directories) {
    const id = "curated:" + dir;
    if (!bundledIds.has(id))
      add(
        "error",
        "orphan_directory",
        `assets/skills/${dir} has no bundled catalog entry`,
        id,
      );
  }
  for (const s of catalog.skills.filter((x) => !x.bundled))
    if (directories.includes(String(s.id).replace(/^[^:]*:/, "")))
      add(
        "error",
        "unexpected_directory",
        `${s.id}: not bundled but has an assets/skills directory`,
        s.id,
      );
  // Version conflicts between skills sharing a name (bundled versus installed, or two installed).
  const byName = new Map<string, NonNullable<ValidationInput["scanned"]>>();
  for (const s of input.scanned ?? [])
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const versions = new Set(list.map((s) => s.version ?? "unversioned"));
    const hashes = new Set(list.map((s) => s.hash));
    if (hashes.size > 1)
      add(
        versions.size > 1 ? "warning" : "info",
        versions.size > 1 ? "version_conflict" : "duplicate_name",
        `Skill "${name}" exists ${list.length} times with different content` +
          (versions.size > 1
            ? ` and versions ${[...versions].join(", ")}`
            : "") +
          `: ${list.map((s) => s.origin).join(", ")}. Pick one when assigning.`,
      );
  }
  for (const w of input.scanWarnings ?? [])
    add("warning", "scan_warning", `${w.path}: ${w.message}`);
  const counts = {
    skills: perSkill.length,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    infos: findings.filter((f) => f.severity === "info").length,
  };
  return {
    generatedAt: new Date().toISOString(),
    curatedOn: catalog.curatedOn ?? null,
    ok: counts.errors === 0,
    counts,
    environments: SUPPORTED_ENVIRONMENTS.map((environment) => ({
      environment,
      adapter: adapterFor(environment).id,
      skills: perSkill.filter((s) => s.environments.includes(environment))
        .length,
      toolNote: toolExposure(adapterFor(environment).id),
    })),
    findings,
    skills: perSkill,
  };
}
