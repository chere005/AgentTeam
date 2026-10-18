import type { Store } from "./store.ts";
import type { Skill } from "./skills.ts";

/**
 * Skill change detection with user-controlled updates.
 *
 * A `skill-pin` records the SKILL.md hash (and a bounded text snapshot for showing what changed)
 * that the user, or first use, accepted. A skill whose current hash differs from its pin is never
 * loaded into a run until the user accepts the update; the run proceeds without it and says so.
 * Bundled skills whose hash equals the catalog's `skillSha256` are re-pinned automatically because
 * that hash is the curated, license-checked revision.
 */
export type SkillPin = {
  id: string;
  name: string;
  hash: string;
  version: string | null;
  path: string;
  acceptedAt: string;
  acceptedBy: "first-use" | "user" | "catalog";
  /** Body of the accepted revision for diffing; null when larger than the snapshot limit. */
  snapshot: string | null;
};
export type PinStatus = "unpinned" | "current" | "changed";
const SNAPSHOT_LIMIT = 200_000;
export function pinOf(store: Store, id: string): SkillPin | null {
  try {
    return store.get<SkillPin>("skill-pin", id);
  } catch {
    return null;
  }
}
export function pinStatus(pin: SkillPin | null, skill: Skill): PinStatus {
  return !pin ? "unpinned" : pin.hash === skill.hash ? "current" : "changed";
}
export function writePin(
  store: Store,
  skill: Skill,
  acceptedBy: SkillPin["acceptedBy"],
  content: string,
) {
  const previous = pinOf(store, skill.id);
  const pin: SkillPin = {
    id: skill.id,
    name: skill.name,
    hash: skill.hash,
    version: skill.version ?? null,
    path: skill.path,
    acceptedAt: new Date().toISOString(),
    acceptedBy,
    snapshot: content.length <= SNAPSHOT_LIMIT ? content : null,
  };
  store.put("skill-pin", pin);
  store.emit(
    acceptedBy === "first-use" ? "skill.pinned" : "skill.update_accepted",
    skill.id,
    {
      name: skill.name,
      acceptedBy,
      version: skill.version ?? null,
      hash: skill.hash,
      previousHash: previous?.hash ?? null,
      previousVersion: previous?.version ?? null,
    },
  );
  return pin;
}
/** Small line-multiset diff: enough to review what an update changes without a diff dependency. */
export function summarizeChange(before: string | null, after: string) {
  if (before === null)
    return {
      available: false as const,
      added: 0,
      removed: 0,
      preview: [] as string[],
    };
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const line of text.split(/\r?\n/)) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(before),
    b = count(after);
  const added: string[] = [],
    removed: string[] = [];
  for (const [line, n] of b) {
    const extra = n - (a.get(line) ?? 0);
    for (let i = 0; i < extra; i++) added.push(line);
  }
  for (const [line, n] of a) {
    const extra = n - (b.get(line) ?? 0);
    for (let i = 0; i < extra; i++) removed.push(line);
  }
  const clip = (l: string) => (l.length > 160 ? l.slice(0, 160) + "…" : l);
  return {
    available: true as const,
    added: added.length,
    removed: removed.length,
    preview: [
      ...removed.slice(0, 20).map((l) => "- " + clip(l)),
      ...added.slice(0, 20).map((l) => "+ " + clip(l)),
    ],
  };
}
