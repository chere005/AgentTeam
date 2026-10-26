import { AppError } from "./model.ts";
import { ProviderError } from "./provider-errors.ts";
import type { Command } from "./runtime-types.ts";

export type ProviderCapabilityIssue = {
  code: "sandbox_unavailable";
  kind: "sandbox-unavailable";
  capability: "sandboxed-shell";
  message: string;
};

/**
 * Metadata-only refusals for execution profiles the host cannot support. This is a negative
 * compatibility check, not proof that a supported host's sandbox dependencies are working.
 * Use the actual command's grants so file-only and read-only Claude runs remain available.
 */
export function providerCapabilityIssue(
  command: Pick<Command, "allowedTools" | "acp">,
  environment: string,
  platform: NodeJS.Platform = process.platform,
): ProviderCapabilityIssue | null {
  if (
    platform !== "win32" ||
    environment !== "claude" ||
    command.acp ||
    !command.allowedTools?.includes("Bash")
  )
    return null;
  return {
    code: "sandbox_unavailable",
    kind: "sandbox-unavailable",
    capability: "sandboxed-shell",
    message:
      "Claude's required shell sandbox is unavailable on native Windows. Use a supported sandboxed runtime (for example Claude inside WSL2), or remove the shell tool for tasks that only need file tools. Sandbox enforcement remains enabled.",
  };
}

/** Call before recording a provider effect or starting a process. */
export function assertProviderCapabilities(
  command: Pick<Command, "allowedTools" | "acp">,
  environment: string,
  platform: NodeJS.Platform = process.platform,
) {
  const issue = providerCapabilityIssue(command, environment, platform);
  if (issue)
    throw new ProviderError(
      issue.kind,
      new AppError(409, issue.code, issue.message),
    );
}
