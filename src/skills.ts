import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { AppError, type Environment } from "./model.ts";
export type SkillRoot = {
  path: string;
  environment?: Environment;
  origin?: "installed" | "bundled";
  label?: string;
};
export type Skill = {
  id: string;
  name: string;
  description: string;
  path: string;
  baseDir: string;
  hash: string;
  environments: Environment[];
  origin: "installed" | "bundled";
  harness: string;
  compatibility:
    "declared" | "source-inferred" | "format-compatible" | "unknown";
  requiresTools: string[];
  compatibilityNotes: string;
  body: string;
};
const manifest = z
  .object({
    environments: z.array(z.enum(["codex", "claude", "wolfram"])),
    requiresTools: z.array(z.string()).default([]),
    catalogId: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    compatibilityEvidence: z.enum(["format-only", "declared"]).optional(),
  })
  .strict();
export class SkillCatalog {
  roots: SkillRoot[];
  items = new Map<string, Skill>();
  warnings: { path: string; message: string }[] = [];
  constructor(roots: SkillRoot[]) {
    this.roots = roots;
  }
  async scan() {
    const next = new Map<string, Skill>(),
      seen = new Set<string>();
    const warnings: typeof this.warnings = [];
    let visited = 0;
    const walk = async (directory: string, root: SkillRoot, depth: number) => {
      if (depth > 12 || ++visited > 15000) {
        warnings.push({
          path: directory,
          message: "Discovery depth or directory limit reached",
        });
        return;
      }
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          warnings.push({
            path: directory,
            message: "Directory could not be read",
          });
        return;
      }
      for (const e of entries) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const path = join(directory, e.name);
        if (e.isDirectory()) {
          await walk(path, root, depth + 1);
          continue;
        }
        // Do not traverse symlinks from an otherwise approved root.
        if (!e.isFile() || e.name !== "SKILL.md") continue;
        try {
          const canonical = await realpath(path);
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          if ((await stat(path)).size > 512_000)
            throw new Error("Skill exceeds 512 KB limit");
          const content = await readFile(path, "utf8");
          const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
          if (!match) throw new Error("Missing YAML front matter");
          const doc = parseDocument(match[1]);
          if (doc.errors.length) throw new Error("Invalid YAML front matter");
          const meta = z
            .object({
              name: z.string().min(1),
              description: z.string().min(1),
              compatibility: z.string().optional(),
            })
            .passthrough()
            .parse(doc.toJS({ maxAliasCount: 20 }));
          let extra: z.infer<typeof manifest> | undefined;
          try {
            extra = manifest.parse(
              JSON.parse(
                await readFile(join(directory, "agentteam.json"), "utf8"),
              ),
            );
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          const id =
            extra?.catalogId && root.origin === "bundled"
              ? "curated:" + extra.catalogId
              : createHash("sha256")
                  .update(canonical)
                  .digest("hex")
                  .slice(0, 24);
          next.set(id, {
            origin: root.origin ?? "installed",
            harness: root.label ?? root.environment ?? "Shared / unknown",
            id,
            name: meta.name,
            description: meta.description,
            path: canonical,
            baseDir: dirname(canonical),
            hash: createHash("sha256").update(content).digest("hex"),
            environments:
              extra?.environments ??
              (root.environment ? [root.environment] : []),
            compatibility:
              extra?.compatibilityEvidence === "format-only"
                ? "format-compatible"
                : extra
                  ? "declared"
                  : root.environment
                    ? "source-inferred"
                    : "unknown",
            requiresTools: extra?.requiresTools ?? [],
            compatibilityNotes: meta.compatibility ?? "",
            body: content.slice(match[0].length),
          });
        } catch (e) {
          warnings.push({
            path,
            message: e instanceof Error ? e.message : "Unable to load skill",
          });
        }
      }
    };
    for (const root of this.roots) await walk(root.path, root, 0);
    this.items = next;
    this.warnings = warnings;
    return this.grouped();
  }
  get(id: string) {
    const skill = this.items.get(id);
    if (!skill)
      throw new AppError(
        404,
        "skill_not_found",
        `Skill ${id} is not in the catalog`,
      );
    return skill;
  }
  grouped(origin?: "installed" | "bundled") {
    const groups: Record<string, Omit<Skill, "body">[]> = {
      codex: [],
      claude: [],
      wolfram: [],
      unknown: [],
    };
    for (const skill of this.items.values()) {
      if (origin && skill.origin !== origin) continue;
      const { body, ...summary } = skill;
      for (const env of skill.environments.length
        ? skill.environments
        : ["unknown"])
        groups[env].push(summary);
    }
    for (const group of Object.values(groups))
      group.sort((a, b) => a.name.localeCompare(b.name));
    return {
      groups,
      warnings: this.warnings,
      total: [...this.items.values()].filter(
        (s) => !origin || s.origin === origin,
      ).length,
    };
  }
}
