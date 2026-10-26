import { z } from "zod";
import { limitsPatchSchema } from "./limits-schema.ts";
import {
  agentSchema,
  edgeSchema,
  ruleSchema,
  workflowSchema,
} from "./model.ts";
import { PROPOSAL_FENCE, proposalInputSchema } from "./assistant.ts";

/**
 * The Team Assistant's proposal protocol: what a change proposal looks like and when to write one.
 * The JSON Schema and every field list are generated from the zod schemas the backend validates
 * with (`proposalInputSchema`, `agentSchema`, …), so the prompt cannot drift from what `extract`
 * accepts. This text is application instructions, placed before the untrusted team-state block.
 */

type Json = {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  items?: Json;
  properties?: Record<string, Json>;
  required?: string[];
  anyOf?: Json[];
  oneOf?: Json[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
};

/** Compact type of one JSON Schema node: `codex|claude`, `string[]`, `{id, mode?}`, `int 0..101`. */
function typeOf(node: Json, depth: number, omit: string[] = []): string {
  if (node.const !== undefined) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map((v) => String(v)).join("|");
  const union = node.anyOf ?? node.oneOf;
  if (union)
    return [
      ...new Set(
        union.map((n) => (n.type === "null" ? "null" : typeOf(n, depth, omit))),
      ),
    ].join("|");
  const type = Array.isArray(node.type)
    ? node.type.filter((t) => t !== "null").join("|") +
      (node.type.includes("null") ? "|null" : "")
    : node.type;
  if (type === "array")
    return node.items ? `${typeOf(node.items, depth, omit)}[]` : "array";
  if (type === "object" && node.properties)
    return depth <= 0 ? "object" : `{${fieldList(node, depth - 1, omit)}}`;
  if (type === "integer" || type === "number") {
    const range =
      node.minimum !== undefined && node.maximum !== undefined
        ? ` ${node.minimum}..${node.maximum}`
        : "";
    return (type === "integer" ? "int" : "number") + range;
  }
  return type ?? "any";
}
function fieldList(node: Json, depth: number, omit: string[]): string {
  const required = new Set(node.required ?? []);
  return Object.entries(node.properties ?? {})
    .filter(([k]) => !omit.includes(k))
    .map(
      ([k, v]) =>
        `${k}${required.has(k) && v.default === undefined ? "" : "?"}: ${typeOf(v, depth, omit)}`,
    )
    .join(", ");
}
/** Field reference generated from a zod schema (input side: defaulted fields are optional). */
export function fieldsOf(schema: z.ZodType, omit: string[] = []) {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
  }) as Json;
  return fieldList(json, 2, omit);
}

/** Example proposals. Each one parses with `proposalInputSchema` (test/assistant.test.ts checks it). */
export const PROTOCOL_EXAMPLES: { request: string; proposal: unknown }[] = [
  {
    request: "Add appropriate skills to the frontend and backend engineers",
    proposal: {
      title: "Add skills to the engineers",
      rationale:
        "Frontend Engineer builds React UI; Backend Engineer owns the TypeScript API.",
      ops: [
        {
          op: "agent.skills",
          agentId: "AGENT_ID_OF_FRONTEND_ENGINEER",
          add: [
            { id: "SKILL_ID_FRONTEND_DESIGN", mode: "on-demand" },
            { id: "SKILL_ID_TYPESCRIPT", mode: "on-demand" },
          ],
        },
        {
          op: "agent.skills",
          agentId: "AGENT_ID_OF_BACKEND_ENGINEER",
          add: [{ id: "SKILL_ID_TYPESCRIPT" }],
        },
      ],
    },
  },
  {
    request: "Add a reviewer that checks the lead's work",
    proposal: {
      title: "Add a code reviewer",
      ops: [
        {
          op: "agent.create",
          ref: "reviewer",
          agent: {
            name: "Code Reviewer",
            roleType: "reviewer",
            environment: "codex",
            role: "Reviews changes for correctness and tests",
            parentId: "AGENT_ID_OF_LEAD",
          },
        },
        {
          op: "edge.create",
          edge: { from: "AGENT_ID_OF_LEAD", to: "@reviewer", kind: "review" },
        },
      ],
    },
  },
  {
    request:
      "Have the lead and writer each write their own report-for-duty file",
    proposal: {
      title: "Write each agent's duty file",
      ops: [
        {
          op: "project.start",
          teamId: "ACTIVE_TEAM_ID",
          name: "Report for duty",
          goal: "Each selected agent writes its own duty file",
          workspace: "ABSOLUTE_WORKSPACE_PATH",
          tasks: [
            {
              agentId: "AGENT_ID_OF_LEAD",
              title: "Write Lead.txt",
              instructions:
                "Write Lead.txt in the selected workspace containing exactly: say who you are, reporting for duty",
              completionChecks: [
                { type: "artifact-exists", path: "Lead.txt" },
                {
                  type: "artifact-matches",
                  path: "Lead.txt",
                  pattern: "^say who you are, reporting for duty(?:\\r?\\n)?$",
                },
              ],
            },
            {
              agentId: "AGENT_ID_OF_WRITER",
              title: "Write Writer.txt",
              instructions:
                "Write Writer.txt in the selected workspace containing exactly: say who you are, reporting for duty",
              completionChecks: [
                { type: "artifact-exists", path: "Writer.txt" },
                {
                  type: "artifact-matches",
                  path: "Writer.txt",
                  pattern: "^say who you are, reporting for duty(?:\\r?\\n)?$",
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    request: "Make the lead's role clearer and cap the project at 40 turns",
    proposal: {
      title: "Clarify the lead and bound the project",
      ops: [
        {
          op: "agent.update",
          id: "AGENT_ID_OF_LEAD",
          changes: { role: "Plans the work and delegates to the engineers" },
        },
        {
          op: "workflow.limits",
          workflowId: "WORKFLOW_ID",
          limits: { maxAgentTurns: 40 },
        },
      ],
    },
  },
];

let cached: string | null = null;
/** The protocol text (static: generated once from the schemas). */
export function proposalProtocol(): string {
  if (cached) return cached;
  const schema = JSON.stringify(
    z.toJSONSchema(proposalInputSchema, { io: "input" }),
  );
  const fence = "```";
  const examples = PROTOCOL_EXAMPLES.map(
    (e, i) =>
      `Example ${i + 1}, user: "${e.request}"\n${fence}${PROPOSAL_FENCE}\n${JSON.stringify(e.proposal)}\n${fence}`,
  ).join("\n");
  cached = [
    "## Proposing team changes",
    "You cannot change the team yourself, and nothing you write is applied automatically. When the user asks for team changes (agents, skills, connections, rules, projects, limits, folders), reply with:",
    "1. One short paragraph with the plan: which agents change and how, and why.",
    `2. Exactly ONE fenced block whose info string is ${PROPOSAL_FENCE}, containing ONE JSON object that matches the schema below (plain JSON: no comments, no trailing commas).`,
    "The app validates the block, shows the user a diff under your reply, and only the user can approve and apply it. Never say a change was applied, made or saved; say it is proposed for review. Ask one clarifying question instead of proposing only when the request is genuinely ambiguous (for example, which of two agents is meant); otherwise choose sensibly from the team state and explain the choice in the plan.",
    "Rules: use ids exactly as they appear in the team-state data, only for agents of the active team (activeTeam). Assign only skill ids from skills.items whose environments include the agent's environment, and only skills whose requiresTools the agent already has; prefer on-demand (loaded when relevant) over always (always in the prompt). Do not re-add skills an agent already has. Assigning skills never grants tools or folders. If the user sends you a validation error for your proposal, reply with a corrected block.",
    "Operations (ops[], applied in order; `@ref` names an agent or workflow created by an earlier op with that ref):",
    "- agent.skills {agentId, add?: [{id, mode?: on-demand|always}], remove?: [skillId]}: add or remove skills and keep the others. Use this for skill changes.",
    "- agent.create {ref?, agent: AgentFields}: create an ordinary agent in the active team.",
    "- agent.update {id, changes: some AgentFields}: replace the given fields (skills given here replace the whole list; prefer agent.skills).",
    "- edge.create {edge: EdgeFields}: a communication link from → to. edge.update {id, changes: some EdgeFields}.",
    "- rule.create {rule: RuleFields}: a routing rule; mode mandatory means a required review (kind review).",
    "- project.start {teamId, name?, goal, workspace, tasks:[{agentId,title,instructions,completionChecks?}]}: create AND start independent simple file tasks on existing agents in the active team. It must be the ONLY operation. The user's Start tasks action applies it and starts the saved tasks through readiness checks; no planner turn or second dispatch is needed. Use this when the user asks the team to DO simple work. Include one explicit task for each participating ordinary agent, including the lead when requested; exclude Team Assistant. Check each agent's simpleTask availability, name any unavailable agents and explain any omitted agents in the paragraph. Never silently substitute models, widen permissions or claim unavailable agents ran. Use the user's chosen workspace (or an existing shared writable folder when unambiguous). For file requests include explicit safe filenames and actual artifact-exists/artifact-matches checks; never use output prose as proof a file exists. Escape literal text in a regex and sanitize Windows-invalid filename characters, trailing dots/spaces and reserved device names; filenames must be unique after sanitizing. Tasks run independently without pipeline stages or delegation chains. Team configuration changes belong in a separate proposal.",
    "- workflow.create {ref?, workflow: WorkflowFields}: create an EMPTY DRAFT project container owned by ownerId. This creates NO tasks and starts NO agents. Use only when the user specifically wants a blank draft; never use this to fulfill a request to start work.",
    "- workflow.limits {workflowId, limits: LimitFields}: stopping conditions (null removes a bound).",
    "- resource.assign {agentId, action: add|remove, workspace: {path, access?: read|write, active?}}: attach or detach a folder (absolute path).",
    `AgentFields: ${fieldsOf(agentSchema, ["kind", "allowUnverified"])}`,
    `EdgeFields: ${fieldsOf(edgeSchema)}`,
    `RuleFields: ${fieldsOf(ruleSchema)}`,
    `WorkflowFields: ${fieldsOf(workflowSchema)}`,
    `LimitFields: ${fieldsOf(limitsPatchSchema)}`,
    `Proposal JSON Schema: ${schema}`,
    "Examples (ids are placeholders; use real ids from the team state):",
    examples,
  ].join("\n");
  return cached;
}
