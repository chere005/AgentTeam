import { z } from "zod";
import { completionCheckSchema } from "./limits-schema.ts";
export const environment = z.enum(["codex", "claude", "wolfram"]);
export const workspaceSchema = z
  .object({
    path: z.string().min(1),
    access: z.enum(["read", "write"]),
    active: z.boolean().default(false),
    /** File/subfolder rules and exclusions refining `access` (src/access.ts); absent = whole folder. */
    rules: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            access: z.enum(["none", "read", "write"]),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    /** Grant only the listed rules (explicit files/folders), not the whole folder. */
    explicitOnly: z.boolean().optional(),
  })
  .strict();
export const ROLE_TYPES = [
  "coordinator",
  "implementer",
  "reviewer",
  "adjudicator",
  "custom",
] as const;
export const agentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().max(4000).default(""),
    /** Role preset (src/roles.ts); "custom" keeps fully manual configuration. */
    roleType: z.enum(ROLE_TYPES).default("custom"),
    kind: z.enum(["agent", "team-assistant"]).default("agent"),
    environment,
    model: z.string().min(1).default("default"),
    effort: z.string().min(1).nullable().default(null),
    schedulingPriority: z.number().int().min(0).max(101).default(50),
    maxConcurrentInvocations: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .nullable()
      .default(null),
    instructions: z.string().max(100_000).default(""),
    tools: z.array(z.string().min(1)).default([]),
    skills: z
      .array(
        z
          .object({
            id: z.string().min(1),
            mode: z.enum(["always", "on-demand"]).default("on-demand"),
            allowUnverified: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    workspaces: z.array(workspaceSchema).default([]),
    parentId: z.string().nullable().default(null),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.workspaces.filter((w) => w.active).length > 1)
      ctx.addIssue({
        code: "custom",
        message: "Only one workspace can be active",
      });
    if (new Set(a.skills.map((s) => s.id)).size !== a.skills.length)
      ctx.addIssue({ code: "custom", message: "Duplicate skill assignment" });
  });
export const edgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    bidirectional: z.boolean().default(false),
    kind: z.enum(["delegate", "consult", "review", "notify"]),
    enabled: z.boolean().default(true),
  })
  .strict();
export const ruleSchema = z
  .object({
    agentId: z.string(),
    scope: z.enum(["intake", "action"]),
    targetId: z.string().optional(),
    priority: z.number().int().min(0).max(10000),
    enabled: z.boolean().default(true),
    /**
     * advisory: routing/consultation suggestion only. mandatory: a required review that blocks
     * dependents until the target's review passes (src/orchestration.ts); never bypassable by
     * prompt text or an explicit recipient.
     */
    mode: z.enum(["advisory", "mandatory"]).default("advisory"),
    /** Specialist trigger label (e.g. accessibility); every matching specialty is invoked. */
    specialty: z.string().trim().min(1).max(60).optional(),
    match: z
      .object({
        textIncludes: z.array(z.string().trim().min(1)).default([]),
        tagsAny: z.array(z.string().trim().min(1)).default([]),
        /** Glob patterns (`*`, `**`, `?`) matched against changed file paths. */
        changedFilesAny: z.array(z.string().trim().min(1).max(300)).default([]),
        catchAll: z.boolean().default(false),
      })
      .strict(),
    kind: z
      .enum(["delegate", "consult", "review", "notify"])
      .default("delegate"),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.scope === "action" && !r.targetId)
      ctx.addIssue({
        code: "custom",
        message: "Action rules require a target",
      });
    if (
      !r.match.catchAll &&
      !r.match.textIncludes.length &&
      !r.match.tagsAny.length &&
      !r.match.changedFilesAny.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Specify a match or explicitly enable catchAll",
      });
    if (r.mode === "mandatory" && r.kind !== "review")
      ctx.addIssue({
        code: "custom",
        message: "Mandatory rules are required reviews: use kind review",
      });
  });
export const routeSchema = z
  .object({
    text: z.string().min(1).max(100_000),
    tags: z.array(z.string()).default([]),
    changedFiles: z.array(z.string().max(500)).max(1000).default([]),
    fromAgentId: z.string().optional(),
    targetId: z.string().optional(),
    kind: z
      .enum(["delegate", "consult", "review", "notify"])
      .default("delegate"),
  })
  .strict();
export const workflowSchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().min(1),
    ownerId: z.string(),
    completionCriteria: z.string().min(1),
  })
  .strict();
export const MAX_TASK_TITLE = 1000;
export const MAX_TASK_DEPENDENCIES = 200;
export const taskSchema = z
  .object({
    workflowId: z.string(),
    agentId: z.string(),
    // Bounded: titles and dependency lists are repeated into prompts and review requests. Existing
    // longer records stay readable; prompt builders clip them on read.
    title: z.string().min(1).max(MAX_TASK_TITLE),
    invokedBy: z.string().optional(),
    instructions: z.string().default(""),
    dependsOn: z
      .array(z.string().max(200))
      .max(MAX_TASK_DEPENDENCIES)
      .default([]),
    completionCriteria: z.string().min(1),
    requiresValidation: z.boolean().optional(),
    parentTaskId: z.string().optional(),
    /** Scope evidence for specialist/mandatory-review rules (src/orchestration.ts). */
    changedFiles: z.array(z.string().max(500)).max(1000).optional(),
    tags: z.array(z.string().max(100)).max(100).optional(),
    completionChecks: z.array(completionCheckSchema).max(20).optional(),
    /**
     * Declared files/folders (absolute, inside the agent's attached folders) this task will touch.
     * Only these are leased; absent or empty keeps the safe default of leasing every attached folder.
     */
    resourcePaths: z.array(z.string().min(1).max(1000)).max(50).optional(),
  })
  .strict();
export type AgentInput = z.infer<typeof agentSchema>;
export type Agent = AgentInput & {
  id: string;
  control: "team" | "human";
  createdAt: string;
};
export type Edge = z.infer<typeof edgeSchema> & { id: string };
export type Rule = z.infer<typeof ruleSchema> & { id: string };
export type Workflow = z.infer<typeof workflowSchema> & {
  id: string;
  paused: boolean;
};
export type Task = z.infer<typeof taskSchema> & {
  id: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    /** Backend stopped mid-run; resumable from its last checkpoint (src/checkpoints.ts). */
    | "interrupted"
    /** Waiting for an explicit user decision about an uncertain external effect. */
    | "blocked";
  result?: string;
  queuedAt?: string;
};
export type Session = {
  id: string;
  agentId: string;
  providerSessionId: string | null;
  state: "idle" | "running";
};
export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  status: "queued" | "processing" | "delivered" | "failed";
  createdAt: string;
};
export type Environment = z.infer<typeof environment>;
export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
