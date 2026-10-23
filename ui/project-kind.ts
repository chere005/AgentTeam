import type { Workflow } from "../src/model";

/** Direct agent chats have task records for delegation, but aren't user projects. */
export function isProjectWorkflow(workflow: Workflow): boolean {
  const kind = (workflow as Workflow & { kind?: string }).kind;
  return kind !== "conversation" && !workflow.name.startsWith("Chat: ");
}
