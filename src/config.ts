import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { SkillRoot } from "./skills.ts";
export let projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const dataDir = resolve(
  process.env.AGENTTEAM_DATA_DIR ?? join(projectRoot, ".agentteam"),
);
export function roots(): SkillRoot[] {
  const home = homedir();
  const defaults: SkillRoot[] = [
    {
      path: join(projectRoot, "assets/skills"),
      origin: "bundled",
      label: "AgentTeam recommended",
    },
    {
      path: join(home, ".codex/skills"),
      environment: "codex",
      label: "Codex skills",
    },
    { path: join(home, ".agents/skills"), label: "Shared agent skills" },
    {
      path: join(home, ".claude/skills"),
      environment: "claude",
      label: "Claude Code skills",
    },
    {
      path: join(home, ".claude/plugins/cache"),
      environment: "claude",
      label: "Claude plugins",
    },
    {
      path: join(home, ".codex/plugins/cache"),
      environment: "codex",
      label: "Codex plugins",
    },
  ];
  if (process.env.AGENTTEAM_SKILL_ROOTS) {
    const extra = z
      .array(
        z
          .object({
            path: z.string(),
            environment: z.enum(["codex", "claude", "wolfram"]).optional(),
            label: z.string().optional(),
          })
          .strict(),
      )
      .parse(JSON.parse(process.env.AGENTTEAM_SKILL_ROOTS));
    defaults.push(...extra.map((r) => ({ ...r, path: resolve(r.path) })));
  }
  return defaults;
}
export async function recommendations() {
  return JSON.parse(
    await readFile(join(projectRoot, "assets/recommended-skills.json"), "utf8"),
  );
}

export function setProjectRoot(path: string) {
  projectRoot = path;
}

export type ProviderProfile = "chat" | "task";
export type ProviderLimits = { timeoutMs: number; maxOutputBytes: number };
const providerDefaults = {
  chat: { timeoutSeconds: 180, maxOutputMb: 4 },
  task: { timeoutSeconds: 1800, maxOutputMb: 16 },
} as const;
function positive(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
/**
 * Provider timeout/output bounds. Env: AGENTTEAM_CHAT_TIMEOUT_SECONDS,
 * AGENTTEAM_TASK_TIMEOUT_SECONDS, AGENTTEAM_CHAT_MAX_OUTPUT_MB,
 * AGENTTEAM_TASK_MAX_OUTPUT_MB. Invalid values fall back to defaults.
 */
export function providerLimits(
  profile: ProviderProfile = "chat",
  env: Record<string, string | undefined> = process.env,
): ProviderLimits {
  const key = profile.toUpperCase();
  const d = providerDefaults[profile];
  return {
    timeoutMs:
      positive(
        env[`AGENTTEAM_${key}_TIMEOUT_SECONDS`],
        d.timeoutSeconds,
        1,
        86_400,
      ) * 1000,
    maxOutputBytes: Math.floor(
      positive(
        env[`AGENTTEAM_${key}_MAX_OUTPUT_MB`],
        d.maxOutputMb,
        0.001,
        1024,
      ) * 1_000_000,
    ),
  };
}
