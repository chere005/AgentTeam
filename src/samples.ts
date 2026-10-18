// Paused sample workflows. A sample is created atomically (agents, edges, workflow and tasks
// in one transaction) and stays paused until its model mapping is verified against what the
// installed harnesses actually advertise. Creating one never starts a provider or kernel.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentSchema,
  assert,
  type Agent,
  type Task,
  type Workflow,
} from "./model.ts";
import type { TeamService } from "./service.ts";
import type { DetectedRuntime } from "./discovery.ts";

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
export type WorkflowSetup = {
  sample: string;
  intendedLead: string;
  requiresModelVerification: boolean;
  modelCheck: ModelCheck;
};

const optionsSchema = z
  .object({
    /** One or two Wolfram agents; two is a hard cap. */
    wolframAgents: z.union([z.literal(1), z.literal(2)]).default(2),
    leadModel: z.string().min(1).default("opus"),
    wolframModel: z.string().min(1).default("default"),
    problem: z.string().max(20_000).default(""),
  })
  .strict();

const PROBLEM_PLACEHOLDER =
  "PROBLEM: (edit before running) State the problem here. Suggested example: a damped harmonic oscillator x'' + 2γx' + ω²x = 0 with x(0)=1, x'(0)=0; check the closed-form solution against the ODE, the initial conditions and (for γ=0) energy conservation.";

export function createWolframSample(service: TeamService, input: unknown = {}) {
  const o = optionsSchema.parse(input);
  const store = service.store;
  const problem = o.problem.trim() || PROBLEM_PLACEHOLDER;
  return store.transaction(() => {
    const createdAt = new Date().toISOString();
    const mkAgent = (data: object): Agent => {
      const parsed = agentSchema.parse(data);
      const agent: Agent = {
        ...parsed,
        id: randomUUID(),
        control: "team",
        createdAt,
      };
      store.put("agent", agent);
      store.emit("agent.created", agent.id);
      return agent;
    };
    const lead = mkAgent({
      name: "Opus 5.5 Lead",
      role: "Plans the problem, reasons over validated results and writes the final answer",
      environment: "claude",
      model: o.leadModel,
      effort: "high",
      schedulingPriority: 60,
      instructions:
        "You lead a problem-solving workflow. Never treat a mathematical statement as established until a Wolfram validation record for its exact inputs has passed. Agent agreement, generated code or prose never counts. Distinguish symbolic proof from numerical evidence and state tolerances for the latter.",
    });
    const wolfram: Agent[] = [];
    for (let i = 1; i <= o.wolframAgents; i++)
      wolfram.push(
        mkAgent({
          name: `Wolfram Validator ${i}`,
          role: "Derives and independently validates mathematics in Wolfram Language",
          environment: "wolfram",
          model: o.wolframModel,
          maxConcurrentInvocations: 1,
          schedulingPriority: 70,
          instructions:
            'Produce executable Wolfram Language (.wl) that sets validationAssertions to a list of <|"name"->..., "passed"->True|False|> associations. State assumptions, domains and units; give tolerances or working precision for numerical checks.',
        }),
      );
    for (const w of wolfram)
      service.saveEdge({
        from: lead.id,
        to: w.id,
        kind: "delegate",
        bidirectional: false,
        enabled: true,
      });
    const workflow = service.workflow({
      name: WOLFRAM_SAMPLE_NAME,
      goal: problem,
      ownerId: lead.id,
      completionCriteria:
        "A concise final answer that states the validated scope, the evidence kind (symbolic proof vs numerical evidence), and remaining limitations.",
    });
    const setup: WorkflowSetup = {
      sample: WOLFRAM_SAMPLE_ID,
      intendedLead: "Opus 5.5",
      requiresModelVerification: true,
      modelCheck: {
        verified: false,
        checkedAt: null,
        issues: [],
        warnings: [],
        resolved: [],
      },
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
          completionCriteria:
            "A passing validation record bound to these inputs",
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
    return service.workflowStatus(workflow.id);
  });
}

/** Opus and exactly version 5.5 (e.g. "claude-opus-5-5", "Opus 5.5"), not 4.5, 5.55 or Sonnet 5.5. */
export const isOpus55 = (s: string) =>
  /opus/i.test(s) && /(?<![\d.])5[.-]5(?![\d.])/.test(s);

/** Check the sample's agents against the models the installed harnesses advertise. */
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
  const issues: string[] = [];
  const warnings: string[] = [];
  const resolved: ModelCheck["resolved"] = [];
  for (const id of ids) {
    const a = store.get<Agent>("agent", id);
    const runtime = runtimes?.find((r) => r.id === a.environment);
    const found = runtime?.models.find((m) => m.id === a.model);
    const isLead = id === wf.ownerId;
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
    else if (!found) {
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
        `${a.name}: ${found.id} (${found.name}) is not identifiably ${wf.setup.intendedLead}; confirm the mapping before running (set the model explicitly to an Opus 5.5 id such as claude-opus-5-5)`,
      );
  }
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

export function sampleCatalog() {
  return [
    {
      id: WOLFRAM_SAMPLE_ID,
      name: WOLFRAM_SAMPLE_NAME,
      description:
        "Opus 5.5 lead with one or two Wolfram agents (hard cap two). Reasoning steps require a passing real-kernel validation record. Created paused; models must be verified before it can run.",
    },
  ];
}
