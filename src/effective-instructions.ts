import { type Agent } from "./model.ts";
import type { TeamService } from "./service.ts";
import { capabilitiesFor, knowledgeContext } from "./run-context.ts";
import { toolExposure } from "./skill-adapters.ts";
import { adapterFor } from "./skill-adapters.ts";
import {
  approxTokens,
  classifySkills,
  composeSections,
  decideSkills,
  sectionsText,
  type SkillEntry,
} from "./skill-loading.ts";
import { adapterExposure } from "./tool-registry.ts";
import { runtimeGuidance } from "./runtime-instructions.ts";

/**
 * Effective-instructions preview for one agent: the same assembly a run performs (see
 * `TeamService.launchPlan` and `prepareRunContext`) but tolerant of problems and free of side effects
 * (no pinning). With `prompt`, on-demand skills are matched against it as a run would.
 */
export async function effectiveInstructions(
  service: TeamService,
  agentId: string,
  options: { prompt?: string } = {},
) {
  const agent = service.store.get<Agent>("agent", agentId);
  await service.skills.scan();
  const connection = service.connection(agent.environment);
  const adapter = adapterFor(agent.environment, connection.transport);
  const problems: { skillId: string; kind: string; message: string }[] = [];
  const loaded: { mode: "always" | "on-demand"; skill: any }[] = [];
  for (const assignment of agent.skills) {
    const skill = service.skills.items.get(assignment.id);
    if (!skill) {
      problems.push({
        skillId: assignment.id,
        kind: "missing",
        message: "Assigned skill is not in the catalog; a run would fail",
      });
      continue;
    }
    if (
      !skill.environments.includes(agent.environment) &&
      !assignment.allowUnverified
    )
      problems.push({
        skillId: skill.id,
        kind: "incompatible",
        message: `${skill.name} has no declared or inferred support for ${agent.environment}; a run would fail`,
      });
    for (const tool of skill.requiresTools)
      if (!agent.tools.includes(tool))
        problems.push({
          skillId: skill.id,
          kind: "missing_tool",
          message: `${skill.name} requires "${tool}", which the agent does not list; a run would fail. Importing a skill never grants it.`,
        });
    loaded.push({ mode: assignment.mode, skill });
  }
  const entries: SkillEntry[] = await classifySkills(service.store, loaded, {
    persist: false,
  });
  const prompt = options.prompt?.trim() ? options.prompt : undefined;
  const decisions = decideSkills(entries, prompt);
  const previewAgent = {
    ...agent,
    instructions: agent.instructions + "\n\n" + runtimeGuidance,
  };
  const sections = composeSections(previewAgent, entries, decisions, adapter);
  let knowledge: Awaited<ReturnType<typeof knowledgeContext>> = {
    citations: [],
    text: "",
  };
  if (prompt)
    try {
      knowledge = await knowledgeContext(service, agentId, prompt);
    } catch {
      /* no readable sources */
    }
  const caps = capabilitiesFor(service);
  const requirements = entries.flatMap((e) =>
    e.skill.requiresTools.map((tool: string) => ({
      tool,
      skill: e.skill.name,
      listedByAgent: agent.tools.includes(tool),
      advertisedBy: caps.tools
        .agentView(agentId)
        .filter((g) => g.tools.some((t) => t.name === tool))
        .map((g) => g.server),
    })),
  );
  const text =
    sectionsText(sections) + (knowledge.text ? "\n\n" + knowledge.text : "");
  return {
    agent: {
      id: agent.id,
      name: agent.name,
      environment: agent.environment,
      roleType: agent.roleType,
      model: agent.model,
    },
    adapter: {
      ...adapter,
      transport: connection.transport,
      toolExposure: toolExposure(adapter.id),
      grantExposure: adapterExposure(adapter.id),
    },
    prompt: prompt ?? null,
    sections,
    skills: decisions,
    knowledge: {
      sources: await caps.knowledge.listFor(agentId),
      citations: knowledge.citations.map((c) => ({
        label: c.label,
        stale: c.stale,
      })),
      approxTokens: approxTokens(knowledge.text),
    },
    tools: {
      listed: agent.tools,
      requirements,
      grants: caps.tools.agentView(agentId),
    },
    problems,
    totals: {
      approxTokens: approxTokens(text),
      skillTokens: sections
        .filter((s) => s.kind === "skill")
        .reduce((n, s) => n + s.approxTokens, 0),
      note: "Approximate: characters / 4. Instruction text only.",
    },
    text,
  };
}
