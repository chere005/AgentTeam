// Release-audit check for bundled team packs (assets/team-packs/<id>/pack.json). Used by
// scripts/audit-release.mjs. Fails a pack that references a skill without retained license text or
// notice, whose pins disagree with the skill catalog, or whose own license notice is missing.
// The pack's license and each companion skill's license are checked independently.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkPackLicense,
  checkPackSkills,
  parseManifest,
} from "./team-pack-manifest.ts";

export function auditTeamPacks(assetsDir: string): {
  packs: number;
  skills: number;
  failures: string[];
} {
  const failures: string[] = [];
  const root = join(assetsDir, "team-packs");
  let packs = 0,
    skills = 0;
  if (!existsSync(root)) return { packs, skills, failures };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const at = `team pack ${entry.name}`;
    try {
      if (!existsSync(join(dir, "pack.json"))) {
        failures.push(`${at}: pack.json missing`);
        continue;
      }
      const m = parseManifest(
        JSON.parse(readFileSync(join(dir, "pack.json"), "utf8")),
      );
      packs++;
      if (m.pack.id !== entry.name)
        failures.push(`${at}: pack.id "${m.pack.id}" differs from directory`);
      for (const p of checkPackLicense(dir, m)) failures.push(`${at}: ${p}`);
      if (!existsSync(join(dir, "README.md")))
        failures.push(`${at}: README.md missing`);
      for (const c of checkPackSkills(assetsDir, m)) {
        skills++;
        for (const p of c.problems)
          failures.push(`${at}: skill ${c.id ?? c.name}: ${p}`);
      }
    } catch (e) {
      failures.push(`${at}: ${(e as Error).message}`);
    }
  }
  return { packs, skills, failures };
}
