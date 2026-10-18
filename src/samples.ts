// The Wolfram-validated reasoning TEAM (lead + one or two Wolfram validators) and the
// validated-reasoning PROJECT assigned to it, plus the model verification shared by every
// project. A team is inserted once (Saved teams library, src/example-teams.ts); each project is
// created paused against the team's existing agents and stays paused until its model mapping is
// verified against what the installed harnesses actually advertise. Creating either never starts
// a provider or kernel.
import { z } from "zod";
import { assert, type Agent, type Task, type Workflow } from "./model.ts";
import type { TeamService } from "./service.ts";
import type { DetectedRuntime } from "./discovery.ts";
import {
  TeamTemplates,
  teamTemplateSchema,
  type TeamTemplate,
} from "./teams.ts";
import {
  attachProjectWorkspaceInTx,
  resolveProjectWorkspace,
  teamProfile,
  type ProjectAttachment,
  type TeamProfile,
} from "./team-profiles.ts";

export const WOLFRAM_SAMPLE_ID = "wolfram-validated-reasoning";
export const WOLFRAM_SAMPLE_NAME = "Opus plan → Wolfram-validated reasoning";

export type ModelCheck = {
  verified: boolean;
  checkedAt: string | null;
  issues: string[];
  /** Non-blocking notes, e.g. an explicit model id that alias-only discovery cannot list. */
  warnings: string[];
  resolved: {
    agentId: string;
    name: string;
    environment: string;
    model: string;
    modelName: string | null;
  }[];
};
/** Stored (loosely) on the workflow document, like `coordination`. */
/** What a non-lead agent's model must identify as (e.g. family "sonnet", version "5.5"). */
export type ModelExpectation = {
  label: string;
  family: string;
  version: string;
  /** Effort the agent is configured with; checked against the model's advertised efforts. */
  effort?: string;
};
export type WorkflowSetup = {
  sample: string;
  intendedLead: string;
  requiresModelVerification: boolean;
  modelCheck: ModelCheck;
  /** Per-agent model expectations (pipeline sample); agents not listed keep the generic check. */
  expectations?: Record<string, ModelExpectation>;
  /** Extra resume gate (src/pipeline.ts): resource/parallel preflight bound to a fingerprint. */
  requiresPreflight?: boolean;
  preflight?: unknown;
  /** Every stage attempt records an immutable handoff note (src/handoffs.ts). */
  handoffNotes?: boolean;
  /** Project workspace attached to the team's agents when the project was assigned. */
  workspace?: string;
  /** Folder attachments this project added (src/project-lifecycle.ts detaches only these). */
  attachments?: ProjectAttachment[];
  /** The user declined the offer to detach this project's folders (never asked again). */
  detachDismissedAt?: string;
};

const teamOptionsSchema = z
  .object({
    /** One or two Wolfram agents; two is a hard cap. */
    wolframAgents: z.union([z.literal(1), z.literal(2)]).default(2),
    leadModel: z.string().min(1).default("opus"),
    wolframModel: z.string().min(1).default("default"),
  })
  .strict();
const optionsSchema = teamOptionsSchema
  .extend({ problem: z.string().max(20_000).default("") })
  .strict();
export type WolframTeamOptions = z.input<typeof teamOptionsSchema>;

const PROBLEM_PLACEHOLDER =
  "PROBLEM: (edit before running) State the problem here. Suggested example: a damped harmonic oscillator x'' + 2γx' + ω²x = 0 with x(0)=1, x'(0)=0; check the closed-form solution against the ODE, the initial conditions and (for γ=0) energy conservation.";

export const WOLFRAM_TEAM_NAME = "Wolfram-validated reasoning team";

/**
 * The TEAM: an Opus 5.5 lead (coordinator) with one or two Wolfram validators under it, delegate
 * edges down the tree, each validator capped at one invocation. No goal, workspace, workflow or
 * task: those belong to the projects assigned to the team later (createWolframProject).
 */
export function wolframTeamTemplate(input: unknown = {}): TeamTemplate {
  const o = teamOptionsSchema.parse(input);
  const validators = Array.from({ length: o.wolframAgents }, (_, i) => ({
    key: `validator-${i + 1}`,
    name: `Wolfram Validator ${i + 1}`,
    role: "Derives and independently validates mathematics in Wolfram Language",
    environment: "wolfram" as const,
    model: o.wolframModel,
    effort: null,
    schedulingPriority: 70,
    maxConcurrentInvocations: 1,
    instructions:
      'Produce executable Wolfram Language (.wl) that sets validationAssertions to a list of <|"name"->..., "passed"->True|False|> associations. State assumptions, domains and units; give tolerances or working precision for numerical checks.',
    tools: [],
    skills: [],
    workspaces: [],
    parentKey: "lead",
    position: { x: i * 310, y: 220 },
  }));
  return teamTemplateSchema.parse({
    name: WOLFRAM_TEAM_NAME,
    description:
      "Opus 5.5 lead over one or two Wolfram validators (hard cap two). Assign it a problem as a project: every reasoning step needs a passing real-kernel validation record.",
    agents: [
      {
        key: "lead",
        name: "Opus 5.5 Lead",
        role: "Plans the problem, reasons over validated results and writes the final answer",
        roleType: "coordinator",
        environment: "claude",
        model: o.leadModel,
        effort: "high",
        schedulingPriority: 60,
        maxConcurrentInvocations: null,
        instructions:
          "You lead a problem-solving workflow. Never treat a mathematical statement as established until a Wolfram validation record for its exact inputs has passed. Agent agreement, generated code or prose never counts. Distinguish symbolic proof from numerical evidence and state tolerances for the latter.",
        tools: [],
        skills: [],
        workspaces: [],
        parentKey: null,
        position: { x: 0, y: 0 },
      },
      ...validators,
    ],
    edges: validators.map((v) => ({
      from: "lead",
      to: v.key,
      kind: "delegate",
      bidirectional: false,
      enabled: true,
    })),
    project: {
      type: "wolfram-validated",
      lead: "lead",
      roles: { lead: ["lead"], validators: validators.map((v) => v.key) },
      workspace: {
        label: "Project folder (validation sources)",
        access: Object.fromEntries([
          ["lead", "read"],
          ...validators.map((v) => [v.key, "write"]),
        ]),
      },
      settings: { wolframAgents: o.wolframAgents },
      intendedLead: "Opus 5.5",
    },
  });
}

const projectSchema = z
  .object({
    /** The problem / goal of this project. */
    goal: z.string().trim().min(10).max(20_000),
    workspace: z.string().min(1).max(4096),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

/**
 * Inside a transaction: the paused validated-reasoning workflow (a PROJECT) for a team with a
 * wolfram-validated profile, built on the team's existing lead and validators.
 */
export function buildWolframProjectInTx(
  service: TeamService,
  profile: TeamProfile,
  input: { problem: string; name: string; workspace?: string },
) {
  const store = service.store;
  const agent = (id: string) => {
    const a = store.get<Agent>("agent", id);
    assert(
      service.teamSpaces.teamOfAgent(a) === profile.id,
      "team_member_moved",
      `${a.name} is no longer in this team; move it back or insert the team again`,
    );
    return a;
  };
  const lead = agent(profile.leadId);
  const wolfram = (profile.roles.validators ?? []).map(agent);
  assert(
    wolfram.length >= 1 && wolfram.length <= 2,
    "team_incomplete",
    "A Wolfram-validated team needs one or two Wolfram validators",
  );
  const attachments = input.workspace
    ? attachProjectWorkspaceInTx(
        store,
        Object.fromEntries([
          [lead.id, profile.workspace?.access[lead.id] ?? "read"],
          ...wolfram.map((w) => [
            w.id,
            profile.workspace?.access[w.id] ?? "write",
          ]),
        ]),
        input.workspace,
      )
    : [];
  const problem = input.problem;
  const workflow = service.workflow({
    name: input.name,
    goal: problem,
    ownerId: lead.id,
    teamId: profile.id,
    completionCriteria:
      "A concise final answer that states the validated scope, the evidence kind (symbolic proof vs numerical evidence), and remaining limitations.",
  });
  const setup: WorkflowSetup = {
    sample: WOLFRAM_SAMPLE_ID,
    intendedLead: profile.intendedLead ?? "Opus 5.5",
    requiresModelVerification: true,
    modelCheck: {
      verified: false,
      checkedAt: null,
      issues: [],
      warnings: [],
      resolved: [],
    },
    ...(input.workspace ? { workspace: input.workspace, attachments } : {}),
  };
  store.put("workflow", { ...workflow, paused: true, setup });
  store.emit("workflow.paused", workflow.id);
  const task = (data: Partial<Task> & { title: string; agentId: string }) =>
    service.task({
      workflowId: workflow.id,
      instructions: "",
      completionCriteria: "Done",
      ...data,
    });
  const plan = task({
    title: "Plan and decompose",
    agentId: lead.id,
    instructions: `${problem}\n\nRestate the problem, list assumptions, domains and units, and decompose it into mathematical steps. Mark which steps need Wolfram validation.`,
    completionCriteria:
      "Written plan with explicit assumptions/domains/units and a list of claims to validate",
  });
  const derive = task({
    title: "Derive and validate claim",
    agentId: wolfram[0].id,
    invokedBy: lead.id,
    dependsOn: [plan.id],
    requiresValidation: true,
    instructions:
      "Derive the result from the plan and provide the executable .wl validation (assertions, tolerances for numerics). Validation is recorded from a real kernel run only.",
    completionCriteria: "A passing validation record bound to these inputs",
  });
  const checks = [derive];
  if (wolfram[1])
    checks.push(
      task({
        title: "Independent validation",
        agentId: wolfram[1].id,
        invokedBy: lead.id,
        dependsOn: [plan.id],
        requiresValidation: true,
        instructions:
          "Validate the same claim independently (different method, or numerical cross-check with stated tolerance). Do not reuse the other agent's code.",
        completionCriteria: "A passing validation record bound to these inputs",
      }),
    );
  const reasoning = task({
    title: "Reason from validated results",
    agentId: lead.id,
    dependsOn: checks.map((t) => t.id),
    requiresValidation: true,
    instructions:
      "Continue the reasoning using only validated results. Any new mathematical claim needs its own passing validation record before dependent steps run.",
    completionCriteria: "Reasoning step with validated claims only",
  });
  const correction = task({
    title: "Correction loop (at most two rounds)",
    agentId: lead.id,
    dependsOn: [reasoning.id],
    instructions:
      "If any validation failed, was inconclusive, stale or disagreed, correct the derivation and revalidate. At most two correction rounds, and the gate allows three validation attempts per input set; then stop and escalate to a human. If everything passed, record 'no correction needed'.",
    completionCriteria:
      "All validations pass or the issue is escalated after the bounded rounds",
  });
  task({
    title: "Concise final answer",
    agentId: lead.id,
    dependsOn: [correction.id],
    requiresValidation: true,
    instructions:
      "Write a concise final answer. State exactly which results are validated (symbolic proof vs numerical evidence with tolerances) and the remaining limitations or assumptions. Do not claim more than the records show.",
    completionCriteria: "Final answer states validated scope and limitations",
  });
  return workflow.id;
}

/** Assign a validated-reasoning PROJECT to an existing wolfram-validated team (paused). */
export async function createWolframProject(
  service: TeamService,
  teamId: string,
  input: unknown,
) {
  const o = projectSchema.parse(input);
  const workspace = await resolveProjectWorkspace(o.workspace);
  const id = service.store.transaction(() => {
    const profile = teamProfile(service.store, teamId);
    assert(
      profile?.type === "wolfram-validated",
      "wrong_project_type",
      "This team does not take Wolfram-validated projects",
      400,
    );
    return buildWolframProjectInTx(service, profile!, {
      problem: o.goal,
      name: o.name ?? projectName("Validated", o.goal),
      workspace,
    });
  });
  return service.workflowStatus(id);
}

/** "Prefix: first line of the goal" (bounded), used as the default project name. */
export function projectName(prefix: string, goal: string) {
  const line = goal.trim().split("\n")[0].replace(/\s+/g, " ");
  const short = line.length > 70 ? line.slice(0, 69) + "…" : line;
  return `${prefix}: ${short}`.slice(0, 120);
}

/**
 * Legacy one-shot sample (POST /samples/wolfram-validated-reasoning, kept for compatibility):
 * inserts the team and assigns its first project in ONE transaction, without a workspace, using
 * the placeholder problem when none is given. The app now inserts the team from the Saved teams
 * library and assigns projects separately.
 */
export function createWolframSample(service: TeamService, input: unknown = {}) {
  const o = optionsSchema.parse(input);
  const problem = o.problem.trim() || PROBLEM_PLACEHOLDER;
  const { problem: _p, ...teamOptions } = o;
  const template = wolframTeamTemplate(teamOptions);
  return service.store.transaction(() => {
    const inserted = new TeamTemplates(service).insertTemplate(template, {
      teamName: WOLFRAM_SAMPLE_NAME.slice(0, 80),
    });
    const id = buildWolframProjectInTx(service, inserted.profile!, {
      problem,
      name: WOLFRAM_SAMPLE_NAME,
    });
    return service.workflowStatus(id);
  });
}

/** Opus and exactly version 5.5 (e.g. "claude-opus-5-5", "Opus 5.5"), not 4.5, 5.55 or Sonnet 5.5. */
export const isOpus55 = (s: string) =>
  /opus/i.test(s) && /(?<![\d.])5[.-]5(?![\d.])/.test(s);

/** True when `s` names the model family at exactly that version (e.g. "claude-sonnet-5-5", "Sonnet 5.5"). */
export const identifiesModel = (s: string, family: string, version: string) =>
  new RegExp(family, "i").test(s) &&
  new RegExp(`(?<![\\d.])${version.replace(/[.]/g, "[.-]")}(?![\\d.])`).test(s);

/** Check the sample's agents against the models the installed harnesses advertise. */
/** Agent fields the model check reads (live agents, or template agents keyed by template key). */
export type ModelSubject = Pick<
  Agent,
  "id" | "name" | "environment" | "model" | "effort"
>;
/**
 * The model check shared by team insert (template agents) and project resume (live agents):
 * environment installed, model advertised, explicit family/version expectations, advertised
 * effort, and (without an expectation) the generic Opus 5.5 lead check when `leadId` is given.
 * Nothing is substituted: an unavailable model is an issue, an explicit id that alias-only
 * discovery cannot list is a warning.
 */
export function assessModels(
  agents: ModelSubject[],
  runtimes: DetectedRuntime[] | undefined,
  o: {
    leadId?: string;
    intendedLead?: string;
    expectations?: Record<string, ModelExpectation>;
  },
) {
  const issues: string[] = [];
  const warnings: string[] = [];
  const resolved: ModelCheck["resolved"] = [];
  for (const a of agents) {
    const id = a.id;
    const runtime = runtimes?.find((r) => r.id === a.environment);
    const found = runtime?.models.find((m) => m.id === a.model);
    const isLead = id === o.leadId;
    const expect = o.expectations?.[id];
    // Alias-only discovery (the Claude CLI lists just sonnet/opus/haiku) cannot advertise a
    // concrete id. An explicit Opus 5.5 id for the lead is then passed through unchanged and
    // surfaced as unadvertised; it is never swapped for an alias.
    const aliasOnly = runtime?.modelSource === "provider-aliases";
    resolved.push({
      agentId: a.id,
      name: a.name,
      environment: a.environment,
      model: a.model,
      modelName: found?.name ?? null,
    });
    if (!runtimes)
      issues.push(`${a.name}: runtimes have not been discovered yet`);
    else if (!runtime?.installed)
      issues.push(`${a.name}: ${a.environment} is not installed or detected`);
    else if (expect) {
      // Explicit expectation (pipeline sample): the model must identify as the intended family and
      // version. An explicit id that alias-only discovery cannot list is surfaced, never swapped.
      const label = `${a.name}: ${a.model}`;
      if (!found) {
        if (
          aliasOnly &&
          identifiesModel(a.model, expect.family, expect.version)
        )
          warnings.push(
            `${label} is not in ${a.environment}'s advertised aliases; it is passed to the CLI unchanged, which fails the task if the model is unavailable`,
          );
        else
          issues.push(
            `${a.name}: model ${a.model} is not advertised by ${a.environment}; expected ${expect.label}. Pick an advertised model (nothing is substituted automatically)`,
          );
      } else if (
        expect.version &&
        !identifiesModel(
          `${found.id} ${found.name}`,
          expect.family,
          expect.version,
        )
      )
        issues.push(
          `${a.name}: ${found.id} (${found.name}) is not identifiably ${expect.label}; set the model explicitly`,
        );
      if (expect.effort) {
        // The configured effort must be one the model advertises (never swapped for another).
        const efforts = found?.efforts ?? [];
        if (!a.effort)
          issues.push(
            `${a.name}: no effort configured (intended ${expect.effort})`,
          );
        else if (found && efforts.length && !efforts.includes(a.effort))
          issues.push(
            `${a.name}: ${a.model} does not advertise effort "${a.effort}" (advertised: ${efforts.join(", ")}); change the effort, nothing is substituted`,
          );
        else if (!found || !efforts.length)
          warnings.push(
            `${a.name}: effort "${a.effort}" cannot be verified (no advertised effort list for ${a.model}); it is passed unchanged`,
          );
      }
    } else if (!found) {
      if (isLead && aliasOnly && isOpus55(a.model))
        warnings.push(
          `${a.name}: ${a.model} is not in ${a.environment}'s advertised aliases; it is passed to the CLI unchanged, which fails the task if the model is unavailable`,
        );
      else
        issues.push(
          `${a.name}: model ${a.model} is not advertised by ${a.environment}; pick an advertised model in the agent editor`,
        );
    } else if (isLead && !isOpus55(`${found.id} ${found.name}`))
      issues.push(
        `${a.name}: ${found.id} (${found.name}) is not identifiably ${o.intendedLead}; confirm the mapping before running (set the model explicitly to an Opus 5.5 id such as claude-opus-5-5)`,
      );
  }
  return { issues, warnings, resolved };
}

export function verifySampleModels(
  service: TeamService,
  workflowId: string,
  runtimes: DetectedRuntime[] | undefined,
): ModelCheck {
  const store = service.store;
  const wf = store.get<Workflow & { setup?: WorkflowSetup }>(
    "workflow",
    workflowId,
  );
  assert(
    wf.setup,
    "not_a_sample",
    "Workflow has no sample setup to verify",
    400,
  );
  const ids = new Set<string>([wf.ownerId]);
  for (const t of store.list<Task>("task"))
    if (t.workflowId === workflowId) ids.add(t.agentId);
  const { issues, warnings, resolved } = assessModels(
    [...ids].map((id) => store.get<Agent>("agent", id)),
    runtimes,
    {
      leadId: wf.ownerId,
      intendedLead: wf.setup.intendedLead,
      expectations: wf.setup.expectations,
    },
  );
  const modelCheck: ModelCheck = {
    verified: !issues.length,
    checkedAt: new Date().toISOString(),
    issues,
    warnings,
    resolved,
  };
  store.transaction(() => {
    store.put("workflow", { ...wf, setup: { ...wf.setup!, modelCheck } });
    store.emit("workflow.models_verified", wf.id, {
      verified: modelCheck.verified,
    });
  });
  return modelCheck;
}

/**
 * Legacy catalog (GET /samples) of the one-shot routes that insert a team and its first project
 * together. The app uses the example teams (GET /teams/examples) and "Assign project"
 * (POST /team-spaces/:id/projects) instead.
 */
const PIPELINE_CATALOG = {
  id: "plan-implement-review-pipeline",
  name: "Opus plan → Sonnet workers → parallel reviews → adjudication → fixes → final reviews → report",
  description:
    "Paused until goal, workspace, model mappings (Opus 5.5, Sonnet 5.5, Fable 5.1, Codex max effort) and parallel resource access are configured and verified. Up to five workers per stage; immutable handoff notes. Legacy one-shot: POST /pipelines creates the team and its first project; prefer the example team plus Assign project.",
};
export function sampleCatalog() {
  return [
    {
      id: PIPELINE_CATALOG.id,
      name: PIPELINE_CATALOG.name,
      description: PIPELINE_CATALOG.description,
    },
    {
      id: WOLFRAM_SAMPLE_ID,
      name: WOLFRAM_SAMPLE_NAME,
      description:
        "Opus 5.5 lead with one or two Wolfram agents (hard cap two). Reasoning steps require a passing real-kernel validation record. Created paused; models must be verified before it can run. Legacy one-shot: prefer the example team plus Assign project.",
    },
  ];
}
