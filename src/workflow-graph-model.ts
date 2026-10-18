import { z } from "zod";
import { completionCheckSchema } from "./limits-schema.ts";

/**
 * Executable workflow graph: schemas, static validation and the pure branch/join/condition rules.
 *
 * This is NOT the agent communication graph (agents + edges + rules in model.ts). A workflow graph
 * describes *steps* (nodes) and the order, branching and joining between them. Nothing in this file
 * touches the store, the scheduler or the filesystem; src/workflow-graph.ts runs the graphs and
 * every executing node goes through the same backend gates as ordinary tasks.
 */

export const NODE_TYPES = [
  "task",
  "command",
  "condition",
  "human",
  "fanout",
  "join",
  "loop",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const EDGE_TRIGGERS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "always",
  "true",
  "false",
  "iterate",
  "done",
] as const;
export type EdgeTrigger = (typeof EDGE_TRIGGERS)[number];
export type ValueType = "string" | "number" | "boolean" | "json";
export type Outcome = "completed" | "failed" | "cancelled" | "skipped";

export const MAX_NODES = 100;
export const MAX_EDGES = 300;
export const MAX_LOOP_ITERATIONS = 25;
export const MAX_COMMAND_TIMEOUT_MS = 600_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
export const DEFAULT_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const MAX_INPUT_CHARS = 16_000;

/** Fields every node type publishes once finished; the only things other nodes may reference. */
export const OUTPUT_FIELDS: Record<NodeType, Record<string, ValueType>> = {
  task: { status: "string", result: "string", taskId: "string" },
  command: {
    status: "string",
    exitCode: "number",
    passed: "boolean",
    stdout: "string",
    stderr: "string",
    timedOut: "boolean",
  },
  condition: { status: "string", value: "boolean", branch: "string" },
  human: { status: "string", answer: "string", choice: "string" },
  fanout: { status: "string" },
  join: {
    status: "string",
    completed: "number",
    failed: "number",
    cancelled: "number",
    skipped: "number",
    partial: "boolean",
  },
  loop: {
    status: "string",
    iteration: "number",
    exhausted: "boolean",
  },
};

export const nodeIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,39}$/,
    "Node ids look like `run-tests` (a-z, 0-9, -)",
  );
const inputNameSchema = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,29}$/, "Input names are letters and digits");
const valueTypeSchema = z.enum(["string", "number", "boolean", "json"]);

export const inputSpecSchema = z
  .object({
    /** `<nodeId>.<field>` (a field of an earlier step) or `state:<key>` (shared workflow state). */
    from: z.string().min(1).max(120),
    type: valueTypeSchema.default("string"),
    required: z.boolean().default(true),
  })
  .strict();
export type InputSpec = z.infer<typeof inputSpecSchema>;
const inputsSchema = z
  .record(inputNameSchema, inputSpecSchema)
  .refine((v) => Object.keys(v).length <= 20, "At most 20 inputs per node")
  .optional();

export type Operand =
  { input: string } | { value: string | number | boolean | null };
const operandSchema: z.ZodType<Operand> = z.union([
  z.object({ input: inputNameSchema }).strict(),
  z
    .object({
      value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
]);
export const COMPARE_OPS = [
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "contains",
  "startsWith",
  "truthy",
  "falsy",
] as const;
export type Expr =
  | { all: Expr[] }
  | { any: Expr[] }
  | { not: Expr }
  | { left: Operand; op: (typeof COMPARE_OPS)[number]; right?: Operand };
export const exprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(exprSchema).min(1).max(20) }).strict(),
    z.object({ any: z.array(exprSchema).min(1).max(20) }).strict(),
    z.object({ not: exprSchema }).strict(),
    z
      .object({
        left: operandSchema,
        op: z.enum(COMPARE_OPS),
        right: operandSchema.optional(),
      })
      .strict(),
  ]),
);

const base = {
  id: nodeIdSchema,
  label: z.string().max(120).optional(),
  inputs: inputsSchema,
};
/** Argument: a literal, or `{input}` replaced by the (never flag-like) value of a declared input. */
const argSchema = z.union([
  z.string().max(4000),
  z.object({ input: inputNameSchema }).strict(),
]);
export const nodeSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...base,
      type: z.literal("task"),
      agentId: z.string().min(1).max(200),
      title: z.string().min(1).max(1000),
      instructions: z.string().max(50_000).default(""),
      completionCriteria: z.string().min(1).max(5000),
      requiresValidation: z.boolean().optional(),
      completionChecks: z.array(completionCheckSchema).max(20).optional(),
      changedFiles: z.array(z.string().max(500)).max(1000).optional(),
      tags: z.array(z.string().max(100)).max(100).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("command"),
      /** Agent whose attached workspace confines the command (and whose resource lease it takes). */
      agentId: z.string().min(1).max(200),
      argv: z.array(argSchema).min(1).max(100),
      /** Explicit opt-in: argv is then exactly one script string run by the platform shell. */
      shell: z.boolean().optional(),
      /** Relative to the chosen attached workspace root. */
      cwd: z.string().max(500).optional(),
      /** One of the agent's attached workspace paths; default is its active (else first) workspace. */
      workspace: z.string().max(1000).optional(),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(MAX_COMMAND_TIMEOUT_MS)
        .default(DEFAULT_COMMAND_TIMEOUT_MS),
      maxOutputBytes: z
        .number()
        .int()
        .min(1024)
        .max(MAX_COMMAND_OUTPUT_BYTES)
        .default(DEFAULT_COMMAND_OUTPUT_BYTES),
      /** Declared side effects: needs write access, goes through the effect ledger with uncertain-outcome handling. */
      mutating: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal("condition"), expr: exprSchema })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("human"),
      agentId: z.string().max(200).optional(),
      prompt: z.string().min(1).max(4000),
      choices: z
        .array(z.string().min(1).max(60))
        .min(1)
        .max(8)
        .default(["approve", "reject"]),
      allowText: z.boolean().optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal("fanout") }).strict(),
  z
    .object({
      ...base,
      type: z.literal("join"),
      /** `all`: every branch must complete. `partial`: continue with at least `minCompleted` completed branches. */
      mode: z.enum(["all", "partial"]).default("all"),
      minCompleted: z.number().int().min(1).max(100).optional(),
      /** How branches that never ran (dead paths) count. */
      skipped: z.enum(["ignore", "fail"]).default("ignore"),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal("loop"),
      /** Optional in the schema only so a draft can be saved; validation refuses a run without it. */
      maxIterations: z.number().int().optional(),
      until: exprSchema.optional(),
      onExhausted: z.enum(["fail", "exit"]).default("fail"),
    })
    .strict(),
]);
export type GraphNode = z.infer<typeof nodeSchema>;

export const edgeSpecSchema = z
  .object({
    from: nodeIdSchema,
    to: nodeIdSchema,
    on: z.enum(EDGE_TRIGGERS).optional(),
    /** Loop-back edge: the only way a cycle is allowed, and only into a loop node. */
    back: z.boolean().optional(),
  })
  .strict();
export type GraphEdge = z.infer<typeof edgeSpecSchema>;

export const definitionSchema = z
  .object({
    nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
    edges: z.array(edgeSpecSchema).max(MAX_EDGES),
  })
  .strict();
export type GraphDefinition = z.infer<typeof definitionSchema>;

export const graphInputSchema = z
  .object({
    workflowId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).default(""),
    nodes: z.array(nodeSchema).min(1).max(MAX_NODES),
    edges: z.array(edgeSpecSchema).max(MAX_EDGES),
  })
  .strict();
export const graphPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    nodes: z.array(nodeSchema).min(1).max(MAX_NODES).optional(),
    edges: z.array(edgeSpecSchema).max(MAX_EDGES).optional(),
  })
  .strict();

// ---- static validation ---------------------------------------------------------------------

export type Issue = {
  code: string;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
};
export type ValidationContext = {
  agent?: (id: string) => {
    workspaces: { path: string; access: "read" | "write"; active: boolean }[];
  } | null;
  /** Keys of the workflow's shared-state fields; null skips the check. */
  stateKeys?: Set<string> | null;
};

export function effectiveTrigger(
  edge: GraphEdge,
  source: GraphNode | undefined,
): EdgeTrigger | null {
  if (edge.on) return edge.on;
  if (!source) return null;
  return source.type === "condition" || source.type === "loop"
    ? null
    : "success";
}
const TRIGGERS_FOR: Record<NodeType, EdgeTrigger[]> = {
  task: ["success", "failure", "cancelled", "skipped", "always"],
  command: ["success", "failure", "cancelled", "skipped", "always"],
  human: ["success", "failure", "cancelled", "skipped", "always"],
  fanout: ["success", "skipped", "always"],
  join: ["success", "failure", "cancelled", "skipped", "always"],
  condition: ["true", "false", "failure", "skipped", "always"],
  loop: ["iterate", "done", "failure", "cancelled", "skipped", "always"],
};
export function parseRef(
  from: string,
):
  | { kind: "state"; key: string }
  | { kind: "node"; node: string; field: string }
  | null {
  const state = from.match(/^state:([a-z][a-z0-9-]*)$/);
  if (state) return { kind: "state", key: state[1] };
  const node = from.match(/^([a-z][a-z0-9-]*)\.([A-Za-z]+)$/);
  return node ? { kind: "node", node: node[1], field: node[2] } : null;
}
export function compatible(declared: ValueType, actual: ValueType) {
  return (
    declared === actual ||
    declared === "json" ||
    (declared === "string" && actual !== "json")
  );
}
function exprInputs(e: Expr, into = new Set<string>()) {
  if ("all" in e) e.all.forEach((x) => exprInputs(x, into));
  else if ("any" in e) e.any.forEach((x) => exprInputs(x, into));
  else if ("not" in e) exprInputs(e.not, into);
  else {
    for (const o of [e.left, e.right]) if (o && "input" in o) into.add(o.input);
  }
  return into;
}
function exprShape(e: Expr, depth = 1): { depth: number; size: number } {
  if ("all" in e || "any" in e) {
    const kids = "all" in e ? e.all : e.any;
    const k = kids.map((x) => exprShape(x, depth + 1));
    return {
      depth: Math.max(depth, ...k.map((x) => x.depth)),
      size: 1 + k.reduce((n, x) => n + x.size, 0),
    };
  }
  if ("not" in e) {
    const k = exprShape(e.not, depth + 1);
    return { depth: k.depth, size: 1 + k.size };
  }
  return { depth, size: 1 };
}
/** Value part of an argument (`--opt=value` or the whole argument). */
export function argValue(arg: string) {
  return /^--?[A-Za-z][\w-]*=/.test(arg)
    ? arg.slice(arg.indexOf("=") + 1)
    : arg;
}
/** True when a command argument names a path that lexically leaves the workspace (`..`, `~`). */
export function lexicalPathEscape(arg: string): boolean {
  const value = argValue(arg);
  return /^~/.test(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value);
}
/** True when an argument looks like a filesystem path (checked against the workspace at run time). */
export function pathLike(arg: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\.\.?([\\/]|$))/.test(argValue(arg));
}

export function validateGraph(
  def: GraphDefinition,
  ctx: ValidationContext = {},
): { ok: boolean; errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [],
    warnings: Issue[] = [];
  const err = (code: string, message: string, extra: Partial<Issue> = {}) =>
    errors.push({ code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<Issue> = {}) =>
    warnings.push({ code, message, ...extra });
  const nodes = new Map<string, GraphNode>();
  for (const n of def.nodes) {
    if (nodes.has(n.id))
      err("duplicate_node", `Node id "${n.id}" is used twice`, {
        nodeId: n.id,
      });
    nodes.set(n.id, n);
  }
  // Edges: endpoints, triggers, duplicates.
  const seen = new Set<string>();
  const edges: (GraphEdge & { on: EdgeTrigger })[] = [];
  for (const e of def.edges) {
    const at = { edge: { from: e.from, to: e.to } };
    const from = nodes.get(e.from),
      to = nodes.get(e.to);
    if (!from || !to) {
      err(
        "edge_unknown_node",
        `Edge ${e.from} -> ${e.to} names a node that does not exist`,
        at,
      );
      continue;
    }
    if (e.from === e.to) {
      err("invalid_cycle", `Node "${e.from}" cannot depend on itself`, {
        ...at,
        nodeId: e.from,
      });
      continue;
    }
    const on = effectiveTrigger(e, from);
    if (!on) {
      err(
        "edge_trigger_required",
        `Edges leaving ${from.type} node "${from.id}" must say which outcome they follow (${TRIGGERS_FOR[from.type].join(", ")})`,
        at,
      );
      continue;
    }
    if (!TRIGGERS_FOR[from.type].includes(on)) {
      err(
        "edge_trigger_invalid",
        `A ${from.type} node cannot produce "${on}" (allowed: ${TRIGGERS_FOR[from.type].join(", ")})`,
        at,
      );
      continue;
    }
    const key = `${e.from}>${e.to}>${on}>${e.back ? 1 : 0}`;
    if (seen.has(key)) {
      err(
        "duplicate_edge",
        `Edge ${e.from} -> ${e.to} (${on}) is listed twice`,
        at,
      );
      continue;
    }
    seen.add(key);
    edges.push({ ...e, on });
  }
  const forward = edges.filter((e) => !e.back),
    back = edges.filter((e) => e.back);
  const out = new Map<string, typeof forward>(),
    into = new Map<string, typeof forward>();
  for (const n of def.nodes) {
    out.set(n.id, []);
    into.set(n.id, []);
  }
  for (const e of forward) {
    out.get(e.from)!.push(e);
    into.get(e.to)!.push(e);
  }
  const reach = (
    starts: string[],
    adj: Map<string, typeof forward>,
    key: "to" | "from",
  ) => {
    const found = new Set<string>(),
      stack = [...starts];
    while (stack.length) {
      const id = stack.pop()!;
      for (const e of adj.get(id) ?? []) {
        const next = e[key];
        if (!found.has(next)) {
          found.add(next);
          stack.push(next);
        }
      }
    }
    return found;
  };
  // Cycles among forward edges (iterative DFS with colors).
  const color = new Map<string, 0 | 1 | 2>();
  let cycle: string[] | null = null;
  const dfs = (start: string) => {
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    const path = [start];
    color.set(start, 1);
    while (stack.length && !cycle) {
      const top = stack[stack.length - 1];
      const edge = out.get(top.id)![top.i++];
      if (!edge) {
        color.set(top.id, 2);
        stack.pop();
        path.pop();
        continue;
      }
      const c = color.get(edge.to) ?? 0;
      if (c === 1) cycle = [...path.slice(path.indexOf(edge.to)), edge.to];
      else if (c === 0) {
        color.set(edge.to, 1);
        stack.push({ id: edge.to, i: 0 });
        path.push(edge.to);
      }
    }
  };
  for (const n of def.nodes) if (!color.get(n.id)) dfs(n.id);
  if (cycle)
    err(
      "invalid_cycle",
      `Cycle ${(cycle as string[]).join(" -> ")} is not allowed; only a loop node with a back edge and an iteration limit may repeat steps`,
      { nodeId: (cycle as string[])[0] },
    );
  // Entry points and reachability.
  const entries = def.nodes
    .filter((n) => !into.get(n.id)!.length)
    .map((n) => n.id);
  if (!entries.length)
    err("no_entry", "Every node has an incoming edge, so nothing can start");
  const reachable = reach(entries, out, "to");
  for (const id of entries) reachable.add(id);
  for (const n of def.nodes)
    if (!reachable.has(n.id))
      err(
        "unreachable_node",
        `Step "${n.id}" can never run: no path leads to it from a starting step`,
        {
          nodeId: n.id,
        },
      );
  // Loops.
  const loopBody = new Map<string, Set<string>>();
  for (const n of def.nodes) {
    if (n.type !== "loop") continue;
    const at = { nodeId: n.id };
    if (
      n.maxIterations === undefined ||
      !Number.isInteger(n.maxIterations) ||
      n.maxIterations < 1 ||
      n.maxIterations > MAX_LOOP_ITERATIONS
    )
      err(
        "loop_unbounded",
        `Loop "${n.id}" needs maxIterations between 1 and ${MAX_LOOP_ITERATIONS}`,
        at,
      );
    const iterate = out.get(n.id)!.filter((e) => e.on === "iterate");
    const backs = back.filter((e) => e.to === n.id);
    if (!iterate.length)
      err(
        "loop_no_body",
        `Loop "${n.id}" has no "iterate" edge to its body`,
        at,
      );
    if (!backs.length)
      err(
        "loop_no_back_edge",
        `Loop "${n.id}" has no back edge returning from its body`,
        at,
      );
    if (!out.get(n.id)!.some((e) => e.on === "done"))
      warn(
        "loop_no_exit",
        `Loop "${n.id}" has no "done" edge, so nothing runs after it`,
        at,
      );
    const body = reach(
      iterate.map((e) => e.to),
      out,
      "to",
    );
    for (const e of iterate) body.add(e.to);
    body.delete(n.id);
    loopBody.set(n.id, body);
  }
  for (const e of back) {
    const to = nodes.get(e.to)!;
    const at = { edge: { from: e.from, to: e.to } };
    if (to.type !== "loop")
      err(
        "back_edge_target",
        `Back edge ${e.from} -> ${e.to} must return to a loop node`,
        at,
      );
    else if (!loopBody.get(to.id)?.has(e.from))
      err(
        "back_edge_outside_body",
        `Back edge ${e.from} -> ${e.to} must start inside the loop body`,
        at,
      );
  }
  // Fan-out / join.
  // Ancestors for input references: everything that runs before, plus the body of any enclosing
  // loop (an earlier iteration's output is available to the loop condition and to later steps).
  const ancestorsOf = (id: string) => {
    const found = reach([id], into, "from");
    for (const a of [id, ...found])
      for (const b of loopBody.get(a) ?? []) found.add(b);
    found.delete(id);
    return found;
  };
  for (const n of def.nodes) {
    if (n.type === "fanout" && out.get(n.id)!.length < 2)
      err(
        "fanout_branches",
        `Fan-out "${n.id}" needs at least two outgoing branches`,
        { nodeId: n.id },
      );
    if (n.type === "join") {
      const incoming = into.get(n.id)!;
      if (incoming.length < 2)
        err(
          "join_inputs",
          `Join "${n.id}" needs at least two incoming branches`,
          { nodeId: n.id },
        );
      const fans = def.nodes
        .filter((x) => x.type === "fanout")
        .map((x) => x.id);
      const common = fans.some((f) => {
        const below = reach([f], out, "to");
        return incoming.every((e) => e.from === f || below.has(e.from));
      });
      if (!common)
        err(
          "join_without_fanout",
          `Join "${n.id}" does not merge branches of one fan-out; put a fan-out node before the branches it joins`,
          { nodeId: n.id },
        );
      if (n.minCompleted !== undefined && n.minCompleted > incoming.length)
        err(
          "join_min_completed",
          `Join "${n.id}" wants ${n.minCompleted} completed branches but has ${incoming.length}`,
          { nodeId: n.id },
        );
    }
  }
  for (const n of def.nodes)
    if (n.type === "fanout") {
      const below = reach([n.id], out, "to");
      if (![...below].some((id) => nodes.get(id)?.type === "join"))
        warn(
          "fanout_without_join",
          `Fan-out "${n.id}" never rejoins; its branches end separately`,
          { nodeId: n.id },
        );
    }
  // Conditions.
  for (const n of def.nodes) {
    if (n.type !== "condition") continue;
    const shape = exprShape(n.expr);
    if (shape.depth > 5 || shape.size > 30)
      err(
        "expr_too_large",
        `Condition "${n.id}" is too deep or large (max depth 5, 30 terms)`,
        { nodeId: n.id },
      );
    const ons = new Set(out.get(n.id)!.map((e) => e.on));
    for (const b of ["true", "false"] as const)
      if (!ons.has(b))
        warn(
          "condition_branch_missing",
          `Condition "${n.id}" has no "${b}" branch; that outcome ends the path`,
          { nodeId: n.id },
        );
  }
  for (const n of def.nodes)
    if (n.type === "loop" && n.until) {
      const shape = exprShape(n.until);
      if (shape.depth > 5 || shape.size > 30)
        err("expr_too_large", `Loop "${n.id}" condition is too large`, {
          nodeId: n.id,
        });
    }
  // Inputs.
  for (const n of def.nodes) {
    const declared = new Set(Object.keys(n.inputs ?? {}));
    const used = new Set<string>();
    if (n.type === "condition") exprInputs(n.expr, used);
    if (n.type === "loop" && n.until) exprInputs(n.until, used);
    if (n.type === "command")
      for (const a of n.argv) if (typeof a !== "string") used.add(a.input);
    for (const name of used)
      if (!declared.has(name))
        err(
          "input_undeclared",
          `"${n.id}" uses input "${name}" that it does not declare`,
          { nodeId: n.id },
        );
    const ancestors = ancestorsOf(n.id);
    for (const [name, spec] of Object.entries(n.inputs ?? {})) {
      const ref = parseRef(spec.from);
      const at = { nodeId: n.id };
      if (!ref) {
        err(
          "input_ref_invalid",
          `Input "${name}" of "${n.id}": "${spec.from}" is neither <node>.<field> nor state:<key>`,
          at,
        );
        continue;
      }
      if (ref.kind === "state") {
        if (ctx.stateKeys && !ctx.stateKeys.has(ref.key))
          err(
            "input_unknown_state",
            `Input "${name}" of "${n.id}" reads shared state "${ref.key}", which is not defined in this workflow`,
            at,
          );
        continue;
      }
      const source = nodes.get(ref.node);
      if (!source) {
        err(
          "input_unknown_node",
          `Input "${name}" of "${n.id}" references unknown step "${ref.node}"`,
          at,
        );
        continue;
      }
      const actual = OUTPUT_FIELDS[source.type][ref.field];
      if (!actual) {
        err(
          "input_unknown_field",
          `Input "${name}" of "${n.id}": a ${source.type} step has no output "${ref.field}" (has: ${Object.keys(OUTPUT_FIELDS[source.type]).join(", ")})`,
          at,
        );
        continue;
      }
      if (!ancestors.has(ref.node))
        err(
          "input_not_upstream",
          `Input "${name}" of "${n.id}" reads "${ref.node}", which does not run before it`,
          at,
        );
      if (!compatible(spec.type, actual))
        err(
          "input_type_mismatch",
          `Input "${name}" of "${n.id}" is declared ${spec.type} but ${spec.from} is ${actual}`,
          at,
        );
    }
  }
  // Agents, tasks and commands.
  for (const n of def.nodes) {
    const at = { nodeId: n.id };
    if (
      n.type === "task" ||
      n.type === "command" ||
      (n.type === "human" && n.agentId)
    ) {
      const agent = ctx.agent?.(n.agentId!);
      if (ctx.agent && !agent)
        err(
          "agent_unknown",
          `Step "${n.id}" names agent "${n.agentId}", which does not exist`,
          at,
        );
      if (n.type === "command") {
        if (agent) {
          if (!agent.workspaces.length)
            err(
              "command_no_workspace",
              `Step "${n.id}": agent has no attached workspace to confine the command`,
              at,
            );
          else {
            const ws = n.workspace
              ? agent.workspaces.find((w) => w.path === n.workspace)
              : (agent.workspaces.find((w) => w.active) ?? agent.workspaces[0]);
            if (!ws)
              err(
                "command_workspace",
                `Step "${n.id}": ${n.workspace} is not attached to the agent`,
                at,
              );
            else if (n.mutating && ws.access !== "write")
              err(
                "command_read_only",
                `Step "${n.id}" is declared mutating but its workspace is read-only`,
                at,
              );
          }
        }
        if (
          n.cwd &&
          (/^([\\/]|[A-Za-z]:)/.test(n.cwd) ||
            /(^|[\\/])\.\.([\\/]|$)/.test(n.cwd))
        )
          err(
            "command_cwd_invalid",
            `Step "${n.id}": cwd must stay inside the workspace (relative, no "..")`,
            at,
          );
        if (n.shell) {
          if (n.argv.length !== 1 || typeof n.argv[0] !== "string")
            err(
              "command_shell_form",
              `Step "${n.id}": a shell command is exactly one script string`,
              at,
            );
          warn(
            "command_shell",
            `Step "${n.id}" runs through the platform shell; prefer an argv list`,
            at,
          );
        } else {
          if (typeof n.argv[0] !== "string" || !n.argv[0].trim())
            err(
              "command_empty",
              `Step "${n.id}": the program name must be a literal string`,
              at,
            );
          else if (/[\\/]/.test(n.argv[0]) && lexicalPathEscape(n.argv[0]))
            err(
              "command_path_escape",
              `Step "${n.id}": program path leaves the workspace`,
              at,
            );
          for (const a of n.argv)
            if (typeof a === "string" && lexicalPathEscape(a))
              err(
                "command_path_escape",
                `Step "${n.id}": argument "${a.slice(0, 60)}" names a path outside the workspace`,
                at,
              );
        }
      }
    }
    if (n.type === "human" && new Set(n.choices).size !== n.choices.length)
      err("human_choices", `Step "${n.id}" lists the same choice twice`, at);
  }
  return { ok: !errors.length, errors, warnings };
}

// ---- pure runtime rules --------------------------------------------------------------------

/** Does an edge fire given how its source finished? `branch` is a condition/loop decision. */
export function edgeFires(
  on: EdgeTrigger,
  outcome: Outcome,
  branch?: string,
): boolean {
  switch (on) {
    case "success":
      return outcome === "completed";
    case "failure":
      return outcome === "failed";
    case "cancelled":
      return outcome === "cancelled";
    case "skipped":
      return outcome === "skipped";
    case "always":
      return true;
    case "true":
    case "false":
    case "iterate":
    case "done":
      return outcome === "completed" && branch === on;
  }
}

export type JoinInput = { outcome: Outcome };
export type JoinResult = {
  outcome: Outcome;
  completed: number;
  failed: number;
  cancelled: number;
  skipped: number;
  partial: boolean;
  reason: string;
};
/**
 * Join semantics over the final outcomes of every incoming branch (a join always waits for all of
 * them): `all` completes only when no branch failed or was cancelled; `partial` completes (flagged
 * `partial`) with at least `minCompleted` completed branches (default 1). Branches that never ran
 * are ignored unless `skipped: "fail"`. With nothing completed and nothing failed the join is skipped.
 */
export function joinOutcome(
  node: {
    mode: "all" | "partial";
    minCompleted?: number;
    skipped: "ignore" | "fail";
  },
  inputs: JoinInput[],
): JoinResult {
  const n = (o: Outcome) => inputs.filter((i) => i.outcome === o).length;
  const completed = n("completed"),
    failed = n("failed"),
    cancelled = n("cancelled"),
    skipped = n("skipped");
  const counts = { completed, failed, cancelled, skipped };
  const bad = failed + cancelled + (node.skipped === "fail" ? skipped : 0);
  if (!completed && !failed && !cancelled)
    return {
      ...counts,
      outcome: "skipped",
      partial: false,
      reason: "no branch ran",
    };
  if (!bad)
    return {
      ...counts,
      outcome: "completed",
      partial: false,
      reason: `${completed} branch(es) completed`,
    };
  if (node.mode === "partial" && completed >= (node.minCompleted ?? 1))
    return {
      ...counts,
      outcome: "completed",
      partial: true,
      reason: `partial: ${completed} completed, ${failed} failed, ${cancelled} cancelled, ${skipped} skipped`,
    };
  return {
    ...counts,
    outcome: failed ? "failed" : cancelled ? "cancelled" : "failed",
    partial: false,
    reason: `${failed} failed, ${cancelled} cancelled, ${skipped} skipped of ${inputs.length} branches`,
  };
}

export type Scalar = string | number | boolean | null;
export class ExprError extends Error {}
function operand(
  o: Operand | undefined,
  inputs: Record<string, unknown>,
): unknown {
  if (!o) throw new ExprError("missing operand");
  if ("input" in o) {
    if (!(o.input in inputs))
      throw new ExprError(`input "${o.input}" is not available`);
    return inputs[o.input];
  }
  return o.value;
}
/** Evaluates a condition over resolved inputs. Never executes text; type errors throw ExprError. */
export function evalExpr(e: Expr, inputs: Record<string, unknown>): boolean {
  if ("all" in e) return e.all.every((x) => evalExpr(x, inputs));
  if ("any" in e) return e.any.some((x) => evalExpr(x, inputs));
  if ("not" in e) return !evalExpr(e.not, inputs);
  const l = operand(e.left, inputs);
  if (e.op === "truthy") return !!l;
  if (e.op === "falsy") return !l;
  const r = operand(e.right, inputs);
  switch (e.op) {
    case "eq":
      return JSON.stringify(l) === JSON.stringify(r);
    case "ne":
      return JSON.stringify(l) !== JSON.stringify(r);
    case "contains":
      if (typeof l === "string" && typeof r === "string") return l.includes(r);
      if (Array.isArray(l))
        return l.some((x) => JSON.stringify(x) === JSON.stringify(r));
      throw new ExprError("contains needs a string or a list on the left");
    case "startsWith":
      if (typeof l === "string" && typeof r === "string")
        return l.startsWith(r);
      throw new ExprError("startsWith needs two strings");
    default: {
      if (
        (typeof l === "number" && typeof r === "number") ||
        (typeof l === "string" && typeof r === "string")
      ) {
        if (e.op === "gt") return l > r;
        if (e.op === "ge") return l >= r;
        if (e.op === "lt") return l < r;
        return l <= r;
      }
      throw new ExprError(`${e.op} compares two numbers or two strings`);
    }
  }
}
export function typeOfValue(v: unknown): ValueType {
  return typeof v === "string"
    ? "string"
    : typeof v === "number"
      ? "number"
      : typeof v === "boolean"
        ? "boolean"
        : "json";
}
/** Graph reachability helpers shared with the engine. */
export function downstreamOf(def: GraphDefinition, start: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of def.edges)
    if (!e.back)
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
  const found = new Set<string>(),
    stack = [start];
  while (stack.length)
    for (const next of adj.get(stack.pop()!) ?? [])
      if (!found.has(next)) {
        found.add(next);
        stack.push(next);
      }
  return found;
}
