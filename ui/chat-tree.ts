type ChatAgent = { id: string; name: string; parentId?: string | null };
export type ChatTreeNode<T extends ChatAgent = ChatAgent> = {
  agent: T;
  children: ChatTreeNode<T>[];
};
/** Stable org order, including detached parents and malformed historical cycles. */
export function chatTree<T extends ChatAgent>(agents: T[]): ChatTreeNode<T>[] {
  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, T[]>();
  for (const agent of agents) {
    if (
      agent.parentId &&
      ids.has(agent.parentId) &&
      agent.parentId !== agent.id
    )
      children.set(agent.parentId, [
        ...(children.get(agent.parentId) ?? []),
        agent,
      ]);
  }
  const seen = new Set<string>();
  const visit = (agent: T): ChatTreeNode<T> => {
    seen.add(agent.id);
    return {
      agent,
      children: (children.get(agent.id) ?? [])
        .filter((child) => !seen.has(child.id))
        .map(visit),
    };
  };
  const roots = agents
    .filter(
      (agent) =>
        !agent.parentId ||
        !ids.has(agent.parentId) ||
        agent.parentId === agent.id,
    )
    .map(visit);
  for (const agent of agents) if (!seen.has(agent.id)) roots.push(visit(agent));
  return roots;
}
