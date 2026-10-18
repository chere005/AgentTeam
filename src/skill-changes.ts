import { AppError, type Agent } from "./model.ts";
import type { TeamService } from "./service.ts";
import { catalogRevisions } from "./skill-loading.ts";
import {
  pinOf,
  summarizeChange,
  writePin,
  type SkillPin,
} from "./skill-pins.ts";
import type { Skill } from "./skills.ts";

/** Change detection report: assigned and pinned skills compared with what is on disk now. */
export type SkillChangeRow = {
  id: string;
  name: string;
  status: "unchanged" | "changed" | "unpinned" | "missing" | "drift";
  assignedTo: { agentId: string; agent: string; mode: string }[];
  pinnedHash: string | null;
  currentHash: string | null;
  pinnedVersion: string | null;
  currentVersion: string | null;
  acceptedAt: string | null;
  acceptedBy: SkillPin["acceptedBy"] | null;
  change: ReturnType<typeof summarizeChange> | null;
  note: string;
};
export async function skillChanges(service: TeamService) {
  await service.skills.scan();
  const revisions = await catalogRevisions();
  const agents = service.store.list<Agent>("agent");
  const ids = new Set<string>();
  const assigned = new Map<string, SkillChangeRow["assignedTo"]>();
  for (const a of agents)
    for (const s of a.skills) {
      ids.add(s.id);
      assigned.set(s.id, [
        ...(assigned.get(s.id) ?? []),
        { agentId: a.id, agent: a.name, mode: s.mode },
      ]);
    }
  for (const pin of service.store.list<SkillPin>("skill-pin")) ids.add(pin.id);
  const rows: SkillChangeRow[] = [];
  for (const id of ids) {
    const pin = pinOf(service.store, id);
    const skill = service.skills.items.get(id) ?? null;
    const base = {
      id,
      assignedTo: assigned.get(id) ?? [],
      pinnedHash: pin?.hash ?? null,
      pinnedVersion: pin?.version ?? null,
      acceptedAt: pin?.acceptedAt ?? null,
      acceptedBy: pin?.acceptedBy ?? null,
    };
    if (!skill) {
      rows.push({
        ...base,
        name: pin?.name ?? id,
        status: "missing",
        currentHash: null,
        currentVersion: null,
        change: null,
        note: "The skill file is gone or no longer in a scanned root; runs fail until it is restored or unassigned.",
      });
      continue;
    }
    const known = skill.origin === "bundled" && revisions.get(id)?.skillSha256;
    const verified = !!known && known === skill.hash;
    const drift = !!known && !verified;
    const status: SkillChangeRow["status"] = drift
      ? "drift"
      : !pin
        ? verified
          ? "unchanged"
          : "unpinned"
        : pin.hash === skill.hash || verified
          ? "unchanged"
          : "changed";
    rows.push({
      ...base,
      name: skill.name,
      status,
      currentHash: skill.hash,
      currentVersion: skill.version ?? null,
      change:
        status === "changed"
          ? summarizeChange(pin?.snapshot ?? null, skill.body)
          : null,
      note:
        status === "drift"
          ? "Differs from the curated catalog hash; it is never loaded. Restore the bundled file."
          : status === "changed"
            ? "Changed since you accepted it; not loaded into runs until you accept the update."
            : status === "unpinned"
              ? "Not accepted yet; the first run pins it (or accept it here)."
              : "",
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows,
    pending: rows.filter((r) =>
      ["changed", "drift", "missing"].includes(r.status),
    ).length,
  };
}
export async function acceptSkills(service: TeamService, ids: string[]) {
  await service.skills.scan();
  const revisions = await catalogRevisions();
  const accepted: string[] = [];
  for (const id of ids) {
    const skill: Skill | undefined = service.skills.items.get(id);
    if (!skill)
      throw new AppError(
        404,
        "skill_not_found",
        `Skill ${id} is not in the catalog`,
      );
    const known = skill.origin === "bundled" && revisions.get(id)?.skillSha256;
    if (known && known !== skill.hash)
      throw new AppError(
        409,
        "skill_hash_drift",
        `${skill.name} differs from the curated catalog hash and cannot be accepted; restore the bundled file`,
      );
    writePin(service.store, skill, "user", skill.body);
    accepted.push(id);
  }
  return { accepted };
}
