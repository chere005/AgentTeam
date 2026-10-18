/**
 * What each adapter actually does with an agent's skills. Only implemented behavior is claimed here;
 * `src/skill-loading.ts` is the code these statements describe.
 *
 *  - Always load: the full skill text is part of the instructions sent with every run (all adapters).
 *  - On demand: AgentTeam compares the run's request with the skill's name/description (deterministic
 *    keyword match, see `matchOnDemand`) and injects the full text for that run only when it matches.
 *    That selection happens in AgentTeam before the provider is called, so it works on every adapter.
 *  - Model-initiated loading (the model reads the skill file itself): only possible where the provider
 *    has file access. It is never relied upon and never verified, so it is reported separately.
 */
export type AdapterId =
  "codex-cli" | "claude-cli" | "wolfram-wolframscript" | "acp";
export type ModelRead = "unsupported" | "possible-unverified";
export type SkillAdapterInfo = {
  id: AdapterId;
  label: string;
  /** How always-load skills reach the provider. */
  always: string;
  /** How on-demand skills reach the provider. */
  onDemand: string;
  /** Whether unselected on-demand skills may be read by the model from disk. */
  modelRead: ModelRead;
  modelReadNote: string;
};
const rows: Record<AdapterId, SkillAdapterInfo> = {
  "codex-cli": {
    id: "codex-cli",
    label: "Codex · direct CLI",
    always: "Full text is prepended to the prompt on stdin for every run.",
    onDemand:
      "Implemented in AgentTeam: injected for a run only when the request matches the skill; otherwise only name and description are listed.",
    modelRead: "possible-unverified",
    modelReadNote:
      "Codex runs in a read-only sandbox, so it may read a listed skill file itself. This is not verified and not relied upon.",
  },
  "claude-cli": {
    id: "claude-cli",
    label: "Claude · direct CLI",
    always: "Full text is passed with --append-system-prompt for every run.",
    onDemand:
      "Implemented in AgentTeam: injected for a run only when the request matches the skill; otherwise only name and description are listed.",
    modelRead: "unsupported",
    modelReadNote:
      'The adapter starts Claude with tools disabled (--tools ""), so the model cannot open skill files. Model-initiated on-demand loading is not supported.',
  },
  "wolfram-wolframscript": {
    id: "wolfram-wolframscript",
    label: "Wolfram · wolframscript (LLMSynthesize)",
    always: "Full text is prepended to the LLMSynthesize prompt for every run.",
    onDemand:
      "Implemented in AgentTeam: injected for a run only when the request matches the skill; otherwise only name and description are listed.",
    modelRead: "unsupported",
    modelReadNote:
      "LLMSynthesize has no file access here. Model-initiated on-demand loading is not supported.",
  },
  acp: {
    id: "acp",
    label: "ACP (Agent Client Protocol)",
    always: "Full text is prepended to the prompt for every run.",
    onDemand:
      "Implemented in AgentTeam: injected for a run only when the request matches the skill; otherwise only name and description are listed.",
    modelRead: "possible-unverified",
    modelReadNote:
      "AgentTeam does not offer file reads over ACP (fs capabilities are off); a skill file is readable only if the connected agent has its own file tools. Not verified.",
  },
};
export function adapterFor(
  environment: string,
  transport?: "direct" | "acp",
): SkillAdapterInfo {
  if (transport === "acp") return rows.acp;
  if (environment === "claude") return rows["claude-cli"];
  if (environment === "wolfram") return rows["wolfram-wolframscript"];
  return rows["codex-cli"];
}
export const skillAdapters = () => Object.values(rows);
/**
 * Tools a skill may require are recorded policy labels. No direct adapter exposes AgentTeam-controlled
 * tools to the provider (see src/capabilities.ts), so a requirement is satisfied only in the sense of
 * "the agent lists it"; this helper explains that per adapter.
 */
export function toolExposure(adapter: AdapterId) {
  return adapter === "acp"
    ? "Tool use is up to the connected agent; AgentTeam does not pass tools or MCP servers to it."
    : adapter === "claude-cli"
      ? 'Tools are disabled for this adapter (--tools "" and --strict-mcp-config).'
      : adapter === "codex-cli"
        ? "Codex runs read-only with approvals off; AgentTeam does not pass tools or MCP servers."
        : "No tools are available through LLMSynthesize.";
}
