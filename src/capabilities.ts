/**
 * Runtime capability table. Every value describes what AgentTeam's adapters actually implement
 * today (src/runtime.ts, src/acp.ts, src/discovery.ts), not what a provider could support.
 * Keep these claims in step with the adapters when they change (there is no dedicated test).
 */
export type CapabilityLevel = "yes" | "partial" | "no";
export type CapabilityKey =
  | "streaming"
  | "tools"
  | "effort"
  | "modelDiscovery"
  | "sessionResume"
  | "subagents"
  | "cancellation";
export type Capability = { level: CapabilityLevel; note: string };
export type RuntimeCapabilityRow = {
  id: string;
  provider: "codex" | "claude" | "wolfram" | "acp";
  transport: "cli" | "wolframscript" | "acp";
  label: string;
  capabilities: Record<CapabilityKey, Capability>;
};
export const capabilityLabels: Record<CapabilityKey, string> = {
  streaming: "Streaming",
  tools: "Tools",
  effort: "Effort",
  modelDiscovery: "Model discovery",
  sessionResume: "Session resume",
  subagents: "Subagents",
  cancellation: "Cancellation",
};
const no = (note: string): Capability => ({ level: "no", note });
const yes = (note: string): Capability => ({ level: "yes", note });
const partial = (note: string): Capability => ({ level: "partial", note });
const cancelled = yes(
  "Stops the provider process (SIGTERM, then SIGKILL after 2 s). Child processes of the provider are not tracked.",
);
const rows: RuntimeCapabilityRow[] = [
  {
    id: "codex-cli",
    provider: "codex",
    transport: "cli",
    label: "Codex · direct CLI",
    capabilities: {
      streaming: partial(
        "JSON events are read as they arrive, but only completed agent messages become text; no token deltas.",
      ),
      tools: partial(
        "File and shell tools are confined by Codex's sandbox to the assigned workspace; writes require explicit workspace and tool grants.",
      ),
      effort: yes(
        "Passed as model_reasoning_effort. Choices come from the installed Codex model list.",
      ),
      modelDiscovery: yes("Queried from `codex app-server` (model/list)."),
      sessionResume: partial(
        "Thread id is stored and `exec resume` is used; resume after an app restart is not yet verified against a live account.",
      ),
      subagents: no(
        "Native subagents are not constrained by AgentTeam limits, so they are not offered.",
      ),
      cancellation: cancelled,
    },
  },
  {
    id: "claude-cli",
    provider: "claude",
    transport: "cli",
    label: "Claude Code · direct CLI",
    capabilities: {
      streaming: partial(
        "stream-json messages are read as they arrive; whole assistant messages, no token deltas.",
      ),
      tools: partial(
        "File tools require an attached workspace; Bash is enabled only when shell is explicitly granted on a writable workspace.",
      ),
      effort: yes("Passed with --effort. Choices are the static alias list."),
      modelDiscovery: partial(
        "Static aliases (sonnet, opus, haiku); the CLI is not asked for its model list. Other IDs go in as custom models.",
      ),
      sessionResume: partial(
        "Session id is stored and --resume is used; resume after an app restart is not yet verified against a live account.",
      ),
      subagents: no(
        "Native subagents are not constrained by AgentTeam limits, so they are not offered.",
      ),
      cancellation: cancelled,
    },
  },
  {
    id: "wolfram-wolframscript",
    provider: "wolfram",
    transport: "wolframscript",
    label: "Wolfram · wolframscript",
    capabilities: {
      streaming: no("One result is returned when LLMSynthesize finishes."),
      tools: no("LLMSynthesize only; no tool calling."),
      effort: no("No effort setting is passed."),
      modelDiscovery: no(
        "Static choices (installation default, Wolfram AI Assistant); the installation is not run during scans.",
      ),
      sessionResume: partial(
        "No provider session; AgentTeam replays the last 20 delivered messages in the prompt.",
      ),
      subagents: no("Not applicable."),
      cancellation: cancelled,
    },
  },
  {
    id: "acp",
    provider: "acp",
    transport: "acp",
    label: "Any agent · ACP adapter",
    capabilities: {
      streaming: yes("agent_message_chunk updates are emitted as they arrive."),
      tools: partial(
        "The adapter's own tools run under its permission requests, which AgentTeam surfaces for approval. AgentTeam does not provide filesystem or terminal services.",
      ),
      effort: partial(
        "Only when the adapter advertises a thought_level option offering the value; otherwise the turn is rejected.",
      ),
      modelDiscovery: partial(
        "Adapter-advertised model options are validated per session; the editor's lists still come from direct discovery.",
      ),
      sessionResume: partial(
        "Uses session/load only when the adapter advertises loadSession; sessions stay bound to one adapter command.",
      ),
      subagents: no(
        "Native subagents are not constrained by AgentTeam limits, so they are not offered.",
      ),
      cancellation: yes(
        "Sends session/cancel, then terminates the adapter process.",
      ),
    },
  },
];
export function runtimeCapabilities(): RuntimeCapabilityRow[] {
  return structuredClone(rows);
}
