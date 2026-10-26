import { release as osRelease } from "node:os";
import type { Agent } from "./model.ts";
import type { TeamService } from "./service.ts";

/** Negative compatibility metadata. An OS version never proves that a sandbox is ready. */
export function simpleTaskSupport(
  service: Pick<TeamService, "connection">,
  agent: Agent,
  host: { platform: NodeJS.Platform; release: string } = {
    platform: process.platform,
    release: osRelease(),
  },
): { available: boolean; reason: string | null } {
  if (
    service.connection(agent.environment).transport !== "direct" ||
    !["claude", "codex"].includes(agent.environment)
  )
    return {
      available: false,
      reason:
        "Simple tasks require direct Claude or Codex file tools; this adapter cannot disable terminal tools.",
    };
  if (host.platform === "win32" && agent.environment === "codex") {
    const build = Number(host.release.split(".")[2]);
    return {
      available: false,
      reason:
        Number.isFinite(build) && build < 22000
          ? "Codex's scoped file sandbox requires Windows 11; this Windows 10 host cannot run it. Choose a Claude agent for simple file tasks."
          : "Codex's scoped file sandbox has not been verified on this Windows host. Choose a Claude agent for simple file tasks; Windows version alone does not establish sandbox readiness.",
    };
  }
  return { available: true, reason: null };
}
