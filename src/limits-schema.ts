import { z } from "zod";
/** Zod schemas for workflow limits and task completion checks (kept free of runtime imports). */
const bound = (max: number) =>
  z.number().int().min(1).max(max).nullable().default(null);
export const limitsSchema = z
  .object({
    maxRuntimeSeconds: bound(30 * 24 * 3600),
    maxAgentTurns: bound(1_000_000),
    maxHandoffs: bound(1_000_000),
    maxRetries: bound(1_000_000),
    maxSpawnedAgents: bound(1_000_000),
    maxTokens: bound(Number.MAX_SAFE_INTEGER),
    maxChildrenPerTask: bound(1000),
    maxDelegationDepth: z.number().int().min(1).max(50).default(4),
  })
  .strict();
export type Limits = z.infer<typeof limitsSchema>;
// Patches must not re-apply defaults, so build from the plain bounds rather than `.partial()`.
const patchBound = (max: number) =>
  z.number().int().min(1).max(max).nullable().optional();
export const limitsPatchSchema = z
  .object({
    maxRuntimeSeconds: patchBound(30 * 24 * 3600),
    maxAgentTurns: patchBound(1_000_000),
    maxHandoffs: patchBound(1_000_000),
    maxRetries: patchBound(1_000_000),
    maxSpawnedAgents: patchBound(1_000_000),
    maxTokens: patchBound(Number.MAX_SAFE_INTEGER),
    maxChildrenPerTask: patchBound(1000),
    maxDelegationDepth: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const DEFAULT_LIMITS: Limits = limitsSchema.parse({});
export const completionCheckSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("output-fields"),
      /** The output must contain a JSON object (whole text or a fenced/embedded block) with these non-empty keys. */
      fields: z.array(z.string().min(1)).min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal("output-matches"),
      pattern: z.string().min(1).max(500),
      flags: z
        .string()
        .regex(/^[imsu]*$/)
        .default(""),
    })
    .strict()
    // Refuse a pattern that does not compile when it is saved, not when the task finishes.
    .superRefine((c, ctx) => {
      try {
        new RegExp(c.pattern, c.flags);
      } catch (e) {
        ctx.addIssue({
          code: "custom",
          path: ["pattern"],
          message: `Invalid regular expression: ${(e as Error).message}`,
        });
      }
    }),
  z
    .object({
      type: z.literal("artifact-exists"),
      /** Relative to the task working directory; must stay inside a readable attached workspace and task scope. */
      path: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact-matches"),
      /** UTF-8 file relative to the task working directory, subject to the same access policy as artifact-exists. */
      path: z.string().min(1).max(1000),
      pattern: z.string().min(1).max(500),
      flags: z
        .string()
        .regex(/^[imsu]*$/)
        .default(""),
    })
    .strict()
    .superRefine((c, ctx) => {
      try {
        new RegExp(c.pattern, c.flags);
      } catch (e) {
        ctx.addIssue({
          code: "custom",
          path: ["pattern"],
          message: `Invalid regular expression: ${(e as Error).message}`,
        });
      }
    }),
  z.object({ type: z.literal("validation-gate") }).strict(),
]);
export type CompletionCheck = z.infer<typeof completionCheckSchema>;
