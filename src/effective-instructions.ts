import { AppError, assert, type Agent, type Task } from "./model.ts";
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
import { capabilityContext } from "./capability-context.ts";
import type { PlanFacts } from "./launch-capability.ts";

/**
 * Effective-instructions preview for one agent: the same assembly a run performs (see
 * `TeamService.launchPlan` and `prepareRunContext`) but tolerant of problems and free of side effects
 * (no pinning). With `prompt`, on-demand skills are matched against it as a run would. With
 * `taskId` the preview is that task's: its narrowed tools, its task folder and the generated
 * capability line of the run it would get, from the same assembler a launch uses.
 */
export async function effectiveInstructions(
  service: TeamService,
  agentId: string,
  options: { prompt?: string; taskId?: string } = {},
) {
  const agent = service.store.get<Agent>("agent", agentId);
  const task = options.taskId
    ? service.store.get<Task>("task", options.taskId)
    : undefined;
  if (task)
    assert(
      task.agentId === agent.id,
      "task_agent",
      "Task belongs to another agent",
      403,
    );
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
  // The launch facts from saved configuration alone (no disk, no pinning); a task folder that no
  // longer exists is reported as a problem rather than failing the preview.
  let facts: PlanFacts;
  try {
    facts = service.launchReadiness.prospectivePlan(agent, task);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    problems.push({
      skillId: "",
      kind: "task_scope",
      message: error.message,
    });
    facts = service.launchReadiness.prospectivePlan(agent);
  }
  const capabilities = capabilityContext(
    service,
    agent,
    facts,
    undefined,
    task?.id,
  );
  const previewAgent = {
    ...agent,
    instructions:
      agent.instructions + service.instructionTail(agent, task, facts),
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
    task: task ? { id: task.id, title: task.title } : null,
    capabilities: {
      line: capabilities.line,
      available: capabilities.effective.available,
      gaps: capabilities.effective.gaps,
      toolNames: capabilities.effective.toolNames,
      folders: capabilities.effective.folders,
      taskRoot: capabilities.effective.taskRoot,
      sandbox: capabilities.effective.sandbox,
      teammates: capabilities.teammates,
      readiness: service.launchReadiness.evaluatePlan(agent, facts, { task }),
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
