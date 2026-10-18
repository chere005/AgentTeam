import { z } from "zod";
import { assert, ruleSchema } from "./model.ts";
import type { Agent, Rule } from "./model.ts";

/**
 * Per-run routing-rule overrides for playground runs (fixture-only). They are applied to the COPY
 * of the team's rules only; the live rules are never modified. Agents are named, not identified,
 * like the agent overrides, and added rules go through the same `ruleSchema` as real ones.
 */
export const ruleOverridesSchema = z
  .object({
    /** Ids of live rules to switch off for this run. */
    disable: z.array(z.string().max(200)).max(200).default([]),
    /** Live rule id -> priority for this run. */
    priority: z
      .record(z.string().max(200), z.number().int().min(0).max(10_000))
      .default({}),
    /** Extra rules for this run, naming agents by name. */
    add: z
      .array(
        z
          .object({
            agent: z.string().min(1).max(200),
            target: z.string().min(1).max(200).optional(),
            scope: z.enum(["intake", "action"]),
            kind: z
              .enum(["delegate", "consult", "review", "notify"])
              .default("delegate"),
            priority: z.number().int().min(0).max(10_000),
            mode: z.enum(["advisory", "mandatory"]).default("advisory"),
            match: ruleSchema.shape.match,
          })
          .strict(),
      )
      .max(50)
      .default([]),
  })
  .strict();
export type RuleOverrides = z.infer<typeof ruleOverridesSchema>;

export const emptyRuleOverrides: RuleOverrides = {
  disable: [],
  priority: {},
  add: [],
};

/** The rules the run's copy of the team gets, plus a readable list of what was overridden. */
export function applyRuleOverrides(
  live: Rule[],
  overrides: RuleOverrides,
  byName: Map<string, Pick<Agent, "id" | "name">>,
): { rules: Rule[]; summary: string[] } {
  const known = new Set(live.map((r) => r.id));
  const ref = (name: string, what: string) => {
    const a = byName.get(name);
    assert(
      a,
      "unknown_agent",
      `Rule override ${what} names unknown agent "${name}"`,
      400,
    );
    return a.id;
  };
  const summary: string[] = [];
  for (const id of [...overrides.disable, ...Object.keys(overrides.priority)])
    assert(
      known.has(id),
      "unknown_rule",
      `Rule override names unknown rule "${id}"`,
      400,
    );
  const label = (r: Rule) => {
    const agent = [...byName.values()].find((a) => a.id === r.agentId)?.name;
    const target = r.targetId
      ? [...byName.values()].find((a) => a.id === r.targetId)?.name
      : null;
    return `${r.scope} rule on ${agent ?? r.agentId}${target ? ` -> ${target}` : ""} (${r.id.slice(0, 8)})`;
  };
  const rules = live.map((r) => {
    let out = r;
    if (overrides.disable.includes(r.id)) {
      out = { ...out, enabled: false };
      summary.push(`disabled ${label(r)}`);
    }
    const priority = overrides.priority[r.id];
    if (priority !== undefined && priority !== r.priority) {
      out = { ...out, priority };
      summary.push(`priority ${r.priority} -> ${priority} for ${label(r)}`);
    }
    return out;
  });
  overrides.add.forEach((a, i) => {
    const agentId = ref(a.agent, `#${i + 1}`);
    const targetId = a.target ? ref(a.target, `#${i + 1}`) : undefined;
    const data = ruleSchema.parse({
      agentId,
      scope: a.scope,
      ...(targetId ? { targetId } : {}),
      priority: a.priority,
      enabled: true,
      mode: a.mode,
      match: a.match,
      kind: a.kind,
    });
    const rule: Rule = { ...data, id: `override-${i + 1}` };
    rules.push(rule);
    summary.push(`added ${label(rule)} at priority ${a.priority}`);
  });
  return { rules, summary };
}
