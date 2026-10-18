import { recommendations } from "./config.ts";
import type { Skill } from "./skills.ts";
import type { Store } from "./store.ts";
import { adapterFor, type SkillAdapterInfo } from "./skill-adapters.ts";
import { pinOf, pinStatus, writePin, type PinStatus } from "./skill-pins.ts";

/**
 * Which skills reach a run, why, and what they cost. Shared by `TeamService.launchPlan`, the
 * effective-instructions preview and the run-context step, so the preview shows what a run gets.
 *
 * Skill text is untrusted DATA supplied by whoever authored the skill. Nothing here grants tools,
 * folders or any other permission: tool requirements are only checked against what the agent
 * already has, and loading text never modifies an agent.
 */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);
export type CatalogRevision = {
  commit: string | null;
  skillSha256: string | null;
  license: string | null;
  source: string | null;
};
export async function catalogRevisions(): Promise<
  Map<string, CatalogRevision>
> {
  const out = new Map<string, CatalogRevision>();
  try {
    const data = await recommendations();
    for (const s of data.skills ?? [])
      out.set(String(s.id), {
        commit: s.commit ?? null,
        skillSha256: s.skillSha256 ?? null,
        license: s.license ?? null,
        source: s.source ?? null,
      });
  } catch {
    /* a missing catalog only removes revision metadata */
  }
  return out;
}
export type SkillEntry = {
  mode: "always" | "on-demand";
  skill: Skill;
  pin: PinStatus;
  /** Bundled skill whose text matches the curated hash in assets/recommended-skills.json. */
  catalogVerified: boolean;
  /** Bundled skill that differs from the curated hash: never loaded. */
  catalogDrift: boolean;
  revision: CatalogRevision | null;
};
export type SkillDecision = {
  id: string;
  name: string;
  mode: "always" | "on-demand";
  state: "loaded" | "listed" | "skipped";
  reason: string;
  version: string | null;
  revision: string | null;
  hash: string;
  origin: "installed" | "bundled";
  pin: PinStatus;
  /** Approximate tokens this skill adds to the run (0 when skipped). */
  approxTokens: number;
  /** Approximate tokens of the full skill text, whether or not it was loaded. */
  fullTokens: number;
};
/** Resolves pin state for each assigned skill; with `persist`, first use is pinned and curated revisions are re-pinned. */
export async function classifySkills(
  store: Store,
  loaded: { mode: "always" | "on-demand"; skill: Skill }[],
  options: { persist: boolean },
): Promise<SkillEntry[]> {
  // launchPlan runs for every queued candidate on each scheduler tick: no catalog read without skills.
  if (!loaded.length) return [];
  const revisions = await catalogRevisions();
  return loaded.map(({ mode, skill }) => {
    const revision = revisions.get(skill.id) ?? null;
    const known = skill.origin === "bundled" && revision?.skillSha256;
    const catalogVerified = !!known && revision!.skillSha256 === skill.hash;
    const catalogDrift = !!known && !catalogVerified;
    let pin = pinStatus(pinOf(store, skill.id), skill);
    if (!catalogDrift && options.persist) {
      if (pin === "unpinned") {
        writePin(
          store,
          skill,
          catalogVerified ? "catalog" : "first-use",
          skill.body,
        );
        pin = "current";
      } else if (pin === "changed" && catalogVerified) {
        writePin(store, skill, "catalog", skill.body);
        pin = "current";
      }
    } else if (catalogVerified && pin === "changed") pin = "current";
    return { mode, skill, pin, catalogVerified, catalogDrift, revision };
  });
}
const GENERIC_NAME = new Set([
  "pro",
  "expert",
  "engineer",
  "developer",
  "specialist",
  "master",
  "architect",
  "code",
  "best",
  "practices",
  "guidelines",
  "design",
  "the",
]);
const STOP = new Set(
  (
    "a an and are as at be by can for from has have how in into is it its of on or that the this to use used " +
    "using when where which while with without you your will would should must may more most not only any all " +
    "also than then they them their these those such via per each other new like make makes made build builds " +
    "building write writes writing create creates creating generate generates generating implement implements " +
    "implementing apply applies work works working need needs needed invoke code application applications " +
    "project projects task tasks help helps ensure ensures including include includes provide provides"
  ).split(" "),
);
const words = (text: string) =>
  (text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [])
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);
/**
 * Deterministic on-demand selection. A skill matches a request when the request contains one of its
 * declared trigger phrases, a distinctive word of its name, or at least three distinct content words
 * of its description. The matched terms are returned so the reason can be shown to the user.
 */
export function matchOnDemand(
  skill: Pick<Skill, "name" | "description" | "triggers">,
  request: string,
) {
  const text = request.slice(0, 20_000).toLowerCase();
  const requestWords = new Set(words(text));
  const terms: string[] = [];
  for (const t of skill.triggers ?? []) {
    const phrase = t.toLowerCase();
    if (phrase.length >= 3 && text.includes(phrase))
      terms.push(`trigger "${t}"`);
  }
  const nameWords = words(skill.name.replace(/[-_]/g, " ")).filter(
    (w) => w.length >= 3 && !GENERIC_NAME.has(w),
  );
  if (text.includes(skill.name.toLowerCase()))
    terms.push(`name "${skill.name}"`);
  else
    for (const w of nameWords)
      if (requestWords.has(w)) terms.push(`name word "${w}"`);
  const overlap = new Set<string>();
  for (const w of new Set(words(skill.description)))
    if (w.length >= 4 && !STOP.has(w) && requestWords.has(w)) overlap.add(w);
  if (overlap.size >= 3)
    terms.push(`description words ${[...overlap].slice(0, 5).join(", ")}`);
  return { matched: terms.length > 0, terms };
}
export function decideSkills(
  entries: SkillEntry[],
  request: string | undefined,
): SkillDecision[] {
  return entries.map((e) => {
    const full = approxTokens(
      `Assigned skill: ${e.skill.name}\nResource base: ${e.skill.baseDir}\n${e.skill.body}`,
    );
    const base = {
      id: e.skill.id,
      name: e.skill.name,
      mode: e.mode,
      version: e.skill.version ?? null,
      revision: e.revision?.commit ?? null,
      hash: e.skill.hash,
      origin: e.skill.origin,
      pin: e.pin,
      fullTokens: full,
    };
    if (e.catalogDrift)
      return {
        ...base,
        state: "skipped" as const,
        reason:
          "SKILL.md differs from the curated catalog hash (hash drift); not loaded",
        approxTokens: 0,
      };
    if (e.pin === "changed")
      return {
        ...base,
        state: "skipped" as const,
        reason:
          "Changed since you accepted it; not loaded until you accept the update",
        approxTokens: 0,
      };
    if (e.mode === "always")
      return {
        ...base,
        state: "loaded" as const,
        reason: "Always load: included in every run",
        approxTokens: full,
      };
    if (request === undefined)
      return {
        ...base,
        state: "listed" as const,
        reason:
          "On demand: loaded only when a request matches (name and description are listed)",
        approxTokens: listedTokens(e.skill),
      };
    const m = matchOnDemand(e.skill, request);
    return m.matched
      ? {
          ...base,
          state: "loaded" as const,
          reason: "On demand: request matched " + m.terms.join("; "),
          approxTokens: full,
        }
      : {
          ...base,
          state: "listed" as const,
          reason: "On demand: request did not match; only listed",
          approxTokens: listedTokens(e.skill),
        };
  });
}
const listedText = (skill: Skill, adapter: SkillAdapterInfo) =>
  adapter.modelRead === "possible-unverified"
    ? `Available skill: ${skill.name}\n${skill.description}\nRead ${skill.path} when needed. Resources are relative to ${skill.baseDir}.`
    : `Available skill (not loaded for this request): ${skill.name}\n${skill.description}`;
const listedTokens = (skill: Skill) =>
  approxTokens(listedText(skill, adapterFor("codex")));
export type InstructionSection = {
  kind: "role" | "persistent" | "skill";
  title: string;
  text: string;
  skillId?: string;
  approxTokens: number;
};
export function composeSections(
  agent: { name: string; role: string; instructions: string },
  entries: SkillEntry[],
  decisions: SkillDecision[],
  adapter: SkillAdapterInfo,
): InstructionSection[] {
  const sections: InstructionSection[] = [];
  const add = (s: Omit<InstructionSection, "approxTokens">) => {
    if (s.text) sections.push({ ...s, approxTokens: approxTokens(s.text) });
  };
  add({
    kind: "role",
    title: "Role",
    text: `Agent: ${agent.name}\nRole: ${agent.role}`,
  });
  add({
    kind: "persistent",
    title: "Persistent instructions",
    text: agent.instructions,
  });
  entries.forEach((e, i) => {
    const d = decisions[i];
    if (d.state === "skipped") return;
    const matched = e.mode === "on-demand" && d.state === "loaded";
    add({
      kind: "skill",
      skillId: e.skill.id,
      title: `${d.state === "loaded" ? "Skill" : "Listed skill"}: ${e.skill.name}`,
      text:
        d.state === "loaded"
          ? `Assigned skill: ${e.skill.name}${matched ? " (loaded on demand)" : ""}\nResource base: ${e.skill.baseDir}\n${e.skill.body}`
          : listedText(e.skill, adapter),
    });
  });
  return sections;
}
export type SkillContext = {
  agent: { name: string; role: string; instructions: string };
  entries: SkillEntry[];
  adapter: SkillAdapterInfo;
  baseInstructions: string;
};
const CONTEXT = Symbol.for("agentteam.skillContext");
export function attachContext<T extends object>(plan: T, ctx: SkillContext): T {
  Object.defineProperty(plan, CONTEXT, { value: ctx, enumerable: false });
  return plan;
}
export const contextOf = (plan: object): SkillContext | undefined =>
  (plan as Record<symbol, SkillContext | undefined>)[CONTEXT];
export const sectionsText = (sections: InstructionSection[]) =>
  sections.map((s) => s.text).join("\n\n");
