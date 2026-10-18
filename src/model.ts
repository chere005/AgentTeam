import { z } from "zod";
export const environment = z.enum(["codex", "claude", "wolfram"]);
export const workspaceSchema = z
  .object({
    path: z.string().min(1),
    access: z.enum(["read", "write"]),
    active: z.boolean().default(false),
  })
  .strict();
export const agentSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().max(4000).default(""),
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
    match: z
      .object({
        textIncludes: z.array(z.string().trim().min(1)).default([]),
        tagsAny: z.array(z.string().trim().min(1)).default([]),
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
      !r.match.tagsAny.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Specify a match or explicitly enable catchAll",
      });
  });
export const routeSchema = z
  .object({
    text: z.string().min(1).max(100_000),
    tags: z.array(z.string()).default([]),
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
export const taskSchema = z
  .object({
    workflowId: z.string(),
    agentId: z.string(),
    title: z.string().min(1),
    invokedBy: z.string().optional(),
    instructions: z.string().default(""),
    dependsOn: z.array(z.string()).default([]),
    completionCriteria: z.string().min(1),
    requiresValidation: z.boolean().optional(),
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
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
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
