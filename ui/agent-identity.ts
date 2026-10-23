export type AgentIdentity = {
  name: string;
  nickname?: string | null;
};

/** Nicknames affect presentation only; API calls and links continue to use the stable id. */
export function agentDisplayName(agent: AgentIdentity): string {
  return agent.nickname?.trim() || agent.name;
}

/** Keep both names visible in choice controls when a nickname differs from the canonical name. */
export function agentSelectorLabel(agent: AgentIdentity): string {
  const nickname = agent.nickname?.trim();
  return nickname &&
    nickname.toLocaleLowerCase() !== agent.name.toLocaleLowerCase()
    ? `${nickname} (${agent.name})`
    : agent.name;
}

export function agentInitials(agent: AgentIdentity): string {
  const value = agentDisplayName(agent).trim();
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase();
  return (words[0][0] + words.at(-1)![0]).toLocaleUpperCase();
}
