import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TeamService } from "./service.ts";
import type { ApprovalRecord } from "./approvals.ts";
import { approvalFingerprint } from "./approvals.ts";
import {
  AppError,
  assert,
  type Agent,
  type Task,
  type Workflow,
} from "./model.ts";
import { sha256, untrusted, UNTRUSTED_NOTICE } from "./shared-common.ts";
import type { Effect } from "./checkpoints.ts";
import {
  displayCommand,
  planCommand,
  runCommand,
  type CommandResult,
} from "./workflow-graph-command.ts";
import {
  MAX_INPUT_CHARS,
  ExprError,
  compatible,
  definitionSchema,
  downstreamOf,
  edgeFires,
  effectiveTrigger,
  evalExpr,
  graphInputSchema,
  graphPatchSchema,
  joinOutcome,
  parseRef,
  typeOfValue,
  validateGraph,
  type EdgeTrigger,
  type GraphDefinition,
  type GraphEdge,
  type GraphNode,
  type Outcome,
  type ValidationContext,
} from "./workflow-graph-model.ts";

/**
 * Executable workflow graphs (docs/durable-execution.md, "Workflow graphs").
 *
 * Entities: `workflow-graph` (mutable current definition), `workflow-graph-version` (immutable,
 * one per definition change), `graph-run` (mutable cursor: per-node state) and `graph-step`
 * (immutable executed-path record, written once when a step reaches a final outcome; SQLite
 * triggers forbid update/delete). The engine only *creates* work: agent steps become ordinary
 * tasks (scheduler, validation gate, mandatory reviews, completion checks, limits and resource
 * leases all apply unchanged), command steps take the same resource lease, limits and the effect
 * ledger, and every other step type is evaluated only while the workflow is running and the steps
 * feeding it have passed their review gates. No node type has a code path around those checks.
 */

type CommandNode = Extract<GraphNode, { type: "command" }>;
type HumanNode = Extract<GraphNode, { type: "human" }>;
type LoopNode = Extract<GraphNode, { type: "loop" }>;
type JoinNode = Extract<GraphNode, { type: "join" }>;
type Edge = GraphEdge & { on: EdgeTrigger };

const STORE_CHARS = 32_000;
const cut = (s: string, n = STORE_CHARS) => (s.length > n ? s.slice(0, n) : s);

export type GraphRecord = {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  version: number;
  hash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  createdAt: string;
  updatedAt: string;
};
export type GraphVersion = Omit<GraphRecord, "updatedAt"> & { graphId: string };

export type NodeRun = {
  status: "pending" | "active" | "done";
  /** Executions started so far (a loop iteration or a re-run after a reset starts a new visit). */
  visit: number;
  /** Explicit retries within the current visit. */
  retries: number;
  outcome?: Outcome;
  branch?: string;
  output?: Record<string, unknown>;
  stepId?: string;
  startedAt?: string;
  /** Why a ready step has not started / an active step is not finished (data for the UI). */
  waiting?: string | null;
  taskId?: string;
  approvalId?: string;
  answerText?: string;
  effectKey?: string;
  display?: string;
  /** Last finished attempt of a command whose effect outcome is uncertain. */
  lastAttempt?: Record<string, unknown>;
  inputs?: Record<string, InputMeta>;
};
export type InputMeta = {
  source: string;
  type: string;
  sha256: string | null;
  chars: number;
  present: boolean;
  truncated?: boolean;
};
export type RunRecord = {
  id: string;
  graphId: string;
  graphName: string;
  graphVersion: number;
  graphHash: string;
  workflowId: string;
  definition: { nodes: GraphNode[]; edges: Edge[] };
  status: "running" | "completed" | "failed" | "cancelled";
  nodes: Record<string, NodeRun>;
  seq: number;
  startedAt: string;
  finishedAt?: string;
  reason?: string;
};
export type StepRecord = {
  id: string;
  runId: string;
  graphId: string;
  graphVersion: number;
  graphHash: string;
  seq: number;
  nodeId: string;
  nodeType: GraphNode["type"];
  visit: number;
  /** 1 for the first attempt of this visit; later numbers follow explicit retries. */
  attempt: number;
  outcome: Outcome;
  branch?: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
  inputs: Record<string, InputMeta>;
  output: Record<string, unknown>;
  refs: { taskId?: string; effectId?: string; approvalId?: string };
  command?: { display: string };
  /** Outgoing edges that fired for this outcome (the path actually taken). */
  fired: { to: string; on: EdgeTrigger; back: boolean }[];
};

const runInputSchema = z
  .object({ confirmCommandsHash: z.string().max(200).optional() })
  .strict();
const answerSchema = z
  .object({
    choice: z.string().min(1).max(60).nullable(),
    text: z.string().max(4000).optional(),
  })
  .strict();

const canonicalDef = (nodes: unknown, edges: unknown) =>
  sha256(JSON.stringify({ nodes, edges }));

export class WorkflowGraphService {
  service: TeamService;
  /** Wired to the live-execution switch by createApi; command steps never start while it is off. */
  enabled: () => boolean = () => true;
  private live = new Map<string, AbortController>();
  private inflight = new Set<Promise<void>>();
  private advancing = false;
  private again = false;
  private scheduled = false;
  constructor(service: TeamService) {
    this.service = service;
    this.store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS graph_step_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='graph-step' BEGIN SELECT RAISE(ABORT,'executed-path records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS graph_step_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='graph-step' BEGIN SELECT RAISE(ABORT,'executed-path records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS graph_version_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='workflow-graph-version' BEGIN SELECT RAISE(ABORT,'graph versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS graph_version_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='workflow-graph-version' BEGIN SELECT RAISE(ABORT,'graph versions are immutable'); END;
      CREATE INDEX IF NOT EXISTS graph_step_run ON entities(json_extract(data,'$.runId')) WHERE kind='graph-step';`);
    // Anything that can unblock a step wakes the engine; work is deferred so event handlers stay cheap.
    this.store.events.on("event", (e: { type: string }) => {
      if (
        e.type === "task.status" ||
        e.type === "approval.resolved" ||
        e.type === "approval.expired" ||
        e.type === "effect.decided" ||
        e.type === "resource.released" ||
        e.type.startsWith("workflow.")
      )
        this.schedule();
    });
  }
  private get store() {
    return this.service.store;
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.advanceAll();
      } catch {
        /* store closed (shutdown or test teardown) */
      }
    });
  }

  // ---- definitions ----------------------------------------------------------------------
  context(workflowId: string): ValidationContext {
    return {
      agent: (id) => {
        try {
          return this.store.get<Agent>("agent", id);
        } catch {
          return null;
        }
      },
      stateKeys: new Set(
        this.service.shared.fields(workflowId).map((f) => f.key),
      ),
    };
  }
  /** Fills the default trigger of every edge (valid graphs only). */
  normalize(def: GraphDefinition): { nodes: GraphNode[]; edges: Edge[] } {
    const byId = new Map(def.nodes.map((n) => [n.id, n]));
    return {
      nodes: def.nodes,
      edges: def.edges.map((e) => ({
        ...e,
        on: effectiveTrigger(e, byId.get(e.from))!,
      })),
    };
  }
  validate(workflowId: string, def: GraphDefinition) {
    return validateGraph(def, this.context(workflowId));
  }
  graph(id: string): GraphRecord {
    return this.store.get<GraphRecord>("workflow-graph", id);
  }
  withValidation(g: GraphRecord) {
    return { ...g, validation: this.validate(g.workflowId, g) };
  }
  list(workflowId?: string | null) {
    return this.store
      .list<GraphRecord>("workflow-graph")
      .filter((g) => !workflowId || g.workflowId === workflowId)
      .map((g) => this.withValidation(g));
  }
  versions(id: string) {
    this.graph(id);
    return this.store
      .list<GraphVersion>("workflow-graph-version")
      .filter((v) => v.graphId === id);
  }
  save(input: unknown) {
    const data = graphInputSchema.parse(input);
    this.store.get<Workflow>("workflow", data.workflowId);
    const now = new Date().toISOString();
    const graph: GraphRecord = {
      id: randomUUID(),
      workflowId: data.workflowId,
      name: data.name,
      description: data.description,
      version: 1,
      hash: canonicalDef(data.nodes, data.edges),
      nodes: data.nodes,
      edges: data.edges,
      createdAt: now,
      updatedAt: now,
    };
    this.store.transaction(() => {
      this.store.put("workflow-graph", graph);
      this.putVersion(graph);
      this.store.emit("graph.saved", graph.id, { version: 1 });
    });
    return this.withValidation(graph);
  }
  private putVersion(g: GraphRecord) {
    const { updatedAt: _u, ...rest } = g;
    this.store.put<GraphVersion & { id: string }>("workflow-graph-version", {
      ...rest,
      graphId: g.id,
      id: `${g.id}@${g.version}`,
    });
  }
  update(id: string, input: unknown) {
    const patch = graphPatchSchema.parse(input);
    const graph = this.graph(id);
    const next: GraphRecord = { ...graph, updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.nodes) next.nodes = patch.nodes;
    if (patch.edges) next.edges = patch.edges;
    const hash = canonicalDef(next.nodes, next.edges);
    this.store.transaction(() => {
      if (hash !== graph.hash) {
        next.hash = hash;
        next.version = graph.version + 1;
        this.putVersion(next);
      }
      this.store.put("workflow-graph", next);
      this.store.emit("graph.saved", id, { version: next.version });
    });
    return this.withValidation(next);
  }
  /** Every command a run would execute, exactly as it will be spawned; the hash gates `startRun`. */
  commands(id: string) {
    const g = this.graph(id);
    const list = g.nodes
      .filter((n): n is CommandNode => n.type === "command")
      .map((n) => {
        let workspace: string | null = null,
          access: string | null = null;
        try {
          const agent = this.store.get<Agent>("agent", n.agentId);
          const ws = n.workspace
            ? agent.workspaces.find((w) => w.path === n.workspace)
            : (agent.workspaces.find((w) => w.active) ?? agent.workspaces[0]);
          workspace = ws?.path ?? null;
          access = ws?.access ?? null;
        } catch {
          /* unknown agent is reported by validation */
        }
        return {
          nodeId: n.id,
          agentId: n.agentId,
          workspace,
          access,
          cwd: n.cwd ?? ".",
          argv: n.argv,
          shell: !!n.shell,
          mutating: n.mutating,
          timeoutMs: n.timeoutMs,
          maxOutputBytes: n.maxOutputBytes,
          display: displayCommand(n, n.argv, n.cwd ?? "."),
        };
      });
    return { commands: list, hash: sha256(JSON.stringify(list)) };
  }

  // ---- runs --------------------------------------------------------------------------------
  run(id: string): RunRecord {
    return this.store.get<RunRecord>("graph-run", id);
  }
  runs(graphId?: string | null) {
    return this.store
      .list<RunRecord>("graph-run")
      .filter((r) => !graphId || r.graphId === graphId)
      .map((r) => ({
        id: r.id,
        graphId: r.graphId,
        graphName: r.graphName,
        graphVersion: r.graphVersion,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt ?? null,
      }));
  }
  private save_(run: RunRecord) {
    this.store.put("graph-run", run);
  }
  startRun(graphId: string, input: unknown) {
    const body = runInputSchema.parse(input ?? {});
    const graph = this.graph(graphId);
    const check = this.validate(graph.workflowId, graph);
    assert(
      check.ok,
      "graph_invalid",
      `Graph has ${check.errors.length} validation error(s); first: ${check.errors[0]?.message}`,
      400,
    );
    assert(
      !this.store
        .list<RunRecord>("graph-run")
        .some((r) => r.graphId === graphId && r.status === "running"),
      "graph_running",
      "This graph already has a run in progress",
    );
    const preview = this.commands(graphId);
    if (preview.commands.length)
      assert(
        body.confirmCommandsHash === preview.hash,
        "commands_unconfirmed",
        "Review the commands this graph will run and confirm them (confirmCommandsHash from GET /graphs/:id/commands)",
      );
    const normalized = this.normalize(graph);
    // Pin each command step to the workspace the user confirmed: a later change of the agent's
    // active folder must not move an unpinned command somewhere it was not reviewed.
    const confirmed = new Map(
      preview.commands.map((c) => [c.nodeId, c.workspace]),
    );
    const def = {
      ...normalized,
      nodes: normalized.nodes.map((n) =>
        n.type === "command" && !n.workspace && confirmed.get(n.id)
          ? { ...n, workspace: confirmed.get(n.id)! }
          : n,
      ),
    };
    const run: RunRecord = {
      id: randomUUID(),
      graphId,
      graphName: graph.name,
      graphVersion: graph.version,
      graphHash: graph.hash,
      workflowId: graph.workflowId,
      definition: def,
      status: "running",
      nodes: Object.fromEntries(
        def.nodes.map((n) => [
          n.id,
          { status: "pending", visit: 0, retries: 0 } as NodeRun,
        ]),
      ),
      seq: 0,
      startedAt: new Date().toISOString(),
    };
    this.store.transaction(() => {
      this.save_(run);
      this.store.emit("graph.run.started", run.id, {
        graphId,
        workflowId: run.workflowId,
      });
    });
    this.advance(run.id);
    return this.view(run.id);
  }
  path(runId: string): StepRecord[] {
    return this.store.db
      .prepare(
        "SELECT data FROM entities WHERE kind='graph-step' AND json_extract(data,'$.runId')=? ORDER BY rowid",
      )
      .all(runId)
      .map((r) => JSON.parse(String(r.data)) as StepRecord);
  }

  // ---- engine entry points ---------------------------------------------------------------
  advanceAll() {
    if (this.advancing) {
      this.again = true;
      return;
    }
    this.advancing = true;
    try {
      do {
        this.again = false;
        for (const r of this.store.list<RunRecord>("graph-run"))
          if (r.status === "running")
            try {
              this.advance(r.id);
            } catch (e) {
              this.store.emit("graph.run.error", r.id, {
                message: e instanceof Error ? e.message : String(e),
              });
            }
      } while (this.again);
    } finally {
      this.advancing = false;
    }
  }
  /** Scheduler tick: re-check gates that have no event of their own (live switch, backoff, leases). */
  sweep() {
    if (
      this.store
        .list<RunRecord>("graph-run")
        .some((r) => r.status === "running")
    )
      this.advanceAll();
  }
  /** Startup: recover command steps whose process died (effect ledger decides), then continue. */
  recover() {
    this.live.clear();
    this.advanceAll();
  }
  /** Test/shutdown helper: advance until nothing is in flight. */
  async settle() {
    for (let i = 0; i < 500; i++) {
      this.advanceAll();
      if (!this.inflight.size) {
        this.advanceAll();
        if (!this.inflight.size) return;
      }
      await Promise.allSettled([...this.inflight]);
    }
  }

  advance(runId: string): boolean {
    let progressed = false;
    for (let i = 0; i < 5000; i++) {
      const run = this.run(runId);
      if (run.status !== "running") break;
      if (!this.stepOnce(run)) break;
      progressed = true;
    }
    this.finishIfDone(runId);
    return progressed;
  }
  private finishIfDone(runId: string) {
    const run = this.run(runId);
    if (run.status !== "running") return;
    if (!Object.values(run.nodes).every((n) => n.status === "done")) return;
    const failed = Object.keys(run.nodes).filter((id) =>
      this.unhandled(run, id),
    );
    run.status = failed.length ? "failed" : "completed";
    run.finishedAt = new Date().toISOString();
    run.reason = failed.length
      ? `Unhandled failure in ${failed.join(", ")}; retry the failed step or fix the graph`
      : undefined;
    this.store.transaction(() => {
      this.save_(run);
      this.store.emit("graph.run.finished", run.id, {
        status: run.status,
        graphId: run.graphId,
      });
    });
  }

  // ---- graph topology helpers -----------------------------------------------------------
  private incoming(run: RunRecord, id: string) {
    return run.definition.edges.filter((e) => e.to === id && !e.back);
  }
  private outgoing(run: RunRecord, id: string) {
    return run.definition.edges.filter((e) => e.from === id);
  }
  private node(run: RunRecord, id: string) {
    return run.definition.nodes.find((n) => n.id === id)!;
  }
  private body(run: RunRecord, loopId: string) {
    const iterate = run.definition.edges
      .filter((e) => e.from === loopId && e.on === "iterate" && !e.back)
      .map((e) => e.to);
    const set = new Set<string>(iterate);
    for (const t of iterate)
      for (const d of downstreamOf(run.definition, t)) set.add(d);
    set.delete(loopId);
    return set;
  }
  /** A failed/cancelled step nothing consumed: no outgoing edge fired and no join counted it. */
  unhandled(run: RunRecord, id: string) {
    const ns = run.nodes[id];
    if (
      ns.status !== "done" ||
      (ns.outcome !== "failed" && ns.outcome !== "cancelled")
    )
      return false;
    return !this.outgoing(run, id).some(
      (e) =>
        edgeFires(e.on, ns.outcome!, ns.branch) ||
        (!e.back && this.node(run, e.to).type === "join"),
    );
  }

  /** An edge is resolved once its source finished; a looping loop node resolves only its iterate edges. */
  private resolved(run: RunRecord, e: Edge, src: NodeRun) {
    if (src.status !== "done") return false;
    const loop = this.node(run, e.from).type === "loop";
    return !(
      loop &&
      src.outcome === "completed" &&
      src.branch === "iterate" &&
      e.on !== "iterate"
    );
  }
  // ---- stepping ---------------------------------------------------------------------------
  private stepOnce(run: RunRecord): boolean {
    for (const node of run.definition.nodes)
      if (run.nodes[node.id].status === "active" && this.pollActive(run, node))
        return true;
    for (const node of run.definition.nodes)
      if (node.type === "loop" && this.loopStep(run, node)) return true;
    for (const node of run.definition.nodes)
      if (run.nodes[node.id].status === "pending" && this.tryStart(run, node))
        return true;
    return false;
  }
  private setWaiting(run: RunRecord, id: string, reason: string | null) {
    const ns = run.nodes[id];
    if ((ns.waiting ?? null) === reason) return;
    ns.waiting = reason;
    this.save_(run);
  }
  private reset(run: RunRecord, ids: Iterable<string>) {
    for (const id of ids) {
      const ns = run.nodes[id];
      run.nodes[id] = { status: "pending", visit: ns.visit, retries: 0 };
    }
  }
  private resolveNode(
    run: RunRecord,
    node: GraphNode,
    outcome: Outcome,
    reason: string,
    extra: {
      branch?: string;
      output?: Record<string, unknown>;
      refs?: StepRecord["refs"];
    } = {},
  ) {
    const ns = run.nodes[node.id];
    const output: Record<string, unknown> = {
      status: outcome,
      ...(extra.output ?? {}),
    };
    for (const [k, v] of Object.entries(output))
      if (typeof v === "string") output[k] = cut(v);
    const seq = ++run.seq;
    const fired = this.outgoing(run, node.id)
      .filter((e) => edgeFires(e.on, outcome, extra.branch))
      .map((e) => ({ to: e.to, on: e.on, back: !!e.back }));
    const record: StepRecord = {
      id: `${run.id}:${String(seq).padStart(5, "0")}`,
      runId: run.id,
      graphId: run.graphId,
      graphVersion: run.graphVersion,
      graphHash: run.graphHash,
      seq,
      nodeId: node.id,
      nodeType: node.type,
      visit: ns.visit,
      attempt: ns.retries + 1,
      outcome,
      branch: extra.branch,
      reason: cut(reason, 2000),
      startedAt: ns.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      inputs: ns.inputs ?? {},
      output,
      refs: {
        taskId: ns.taskId,
        approvalId: ns.approvalId,
        effectId: ns.effectKey
          ? this.service.recovery.ledger.find(ns.effectKey)?.id
          : undefined,
        ...(extra.refs ?? {}),
      },
      command: ns.display ? { display: ns.display } : undefined,
      fired,
    };
    ns.status = "done";
    ns.outcome = outcome;
    ns.branch = extra.branch;
    ns.output = output;
    ns.stepId = record.id;
    ns.waiting = null;
    ns.lastAttempt = undefined;
    this.store.transaction(() => {
      this.store.put("graph-step", record);
      this.save_(run);
      this.store.emit("graph.step", run.id, {
        stepId: record.id,
        nodeId: node.id,
        outcome,
        branch: extra.branch ?? null,
      });
    });
  }

  /** Active steps: observe the task / approval / command they wait on. */
  private pollActive(run: RunRecord, node: GraphNode): boolean {
    const ns = run.nodes[node.id];
    if (node.type === "task") {
      if (!ns.taskId) return false;
      const task = this.store.get<Task>("task", ns.taskId);
      const out = { taskId: task.id, result: task.result ?? "" };
      if (task.status === "completed") {
        this.resolveNode(run, node, "completed", `Task completed`, {
          output: out,
        });
        return true;
      }
      if (task.status === "cancelled") {
        this.resolveNode(
          run,
          node,
          "cancelled",
          task.result ?? "Task cancelled",
          { output: out },
        );
        return true;
      }
      if (task.status === "failed") {
        const recovery = this.service.recovery;
        const waitsForAutoRetry =
          recovery.state(task.id).policy.auto &&
          recovery.retryGate(task).allowed &&
          !this.service.limits.meta(task.id).stoppedByLimit;
        if (!waitsForAutoRetry) {
          this.resolveNode(run, node, "failed", task.result ?? "Task failed", {
            output: out,
          });
          return true;
        }
      }
      const reason =
        task.status === "queued"
          ? (this.service.taskState(task.id).waitReason ?? "queued")
          : task.status;
      this.setWaiting(run, node.id, reason);
      return false;
    }
    if (node.type === "human") {
      if (!ns.approvalId) return false;
      const rec = this.store.get<ApprovalRecord>("approval", ns.approvalId);
      if (rec.status !== "resolved") return false;
      const sel = rec.response?.outcome;
      if (sel?.outcome === "selected") {
        this.resolveNode(run, node, "completed", `Answered: ${sel.optionId}`, {
          output: { answer: ns.answerText ?? "", choice: sel.optionId },
        });
      } else
        this.resolveNode(
          run,
          node,
          "cancelled",
          "Input request was cancelled",
          {
            output: { answer: "", choice: "" },
          },
        );
      return true;
    }
    if (node.type === "command") {
      const key = `${run.id}:${node.id}:${ns.visit}`;
      if (this.live.has(key)) return false;
      return this.orphanedCommand(run, node, ns);
    }
    return false;
  }
  /** A command step with no live process (restart, or waiting for a decision): the ledger decides. */
  private orphanedCommand(run: RunRecord, node: CommandNode, ns: NodeRun) {
    const ledger = this.service.recovery.ledger;
    const effect = ns.effectKey ? ledger.find(ns.effectKey) : undefined;
    if (!effect) {
      // Died before anything was recorded: nothing ran, so start over.
      this.reset(run, [node.id]);
      this.save_(run);
      return true;
    }
    if (effect.state === "attempted") {
      if (effect.mutating)
        ledger.markUncertain(
          effect.id,
          "Backend stopped while the command was running",
        );
      else
        ledger.fail(
          effect.id,
          "Interrupted before it finished; not a mutation",
        );
      return true;
    }
    if (effect.state === "completed") {
      this.finishFromEffect(run, node, effect);
      return true;
    }
    if (effect.state === "uncertain") {
      this.setWaiting(run, node.id, "effect-uncertain");
      return false;
    }
    // failed: the user decided "abandon", or it is safe to run again.
    if (effect.decision?.decision === "abandon") {
      this.resolveNode(
        run,
        node,
        "cancelled",
        "Abandoned after an uncertain outcome",
        {
          output: (ns.lastAttempt as Record<string, unknown>) ?? {},
        },
      );
      return true;
    }
    ns.retries = ns.retries + 1;
    this.reset(run, [node.id]);
    run.nodes[node.id].retries = ns.retries;
    this.save_(run);
    return true;
  }
  private finishFromEffect(run: RunRecord, node: CommandNode, effect: Effect) {
    let out: Record<string, unknown> = {};
    try {
      out = JSON.parse(effect.result ?? "{}");
    } catch {
      /* free text recorded by a user decision */
    }
    const ns = run.nodes[node.id];
    const last = (ns.lastAttempt ?? {}) as Record<string, unknown>;
    const applied = effect.decision?.decision === "completed";
    const output: Record<string, unknown> = {
      exitCode: 0,
      passed: true,
      stdout: "",
      stderr: "",
      timedOut: false,
      ...last,
      ...out,
    };
    if (applied) {
      output.passed = true;
      output.markedApplied = true;
    } else output.replayed = true;
    this.resolveNode(
      run,
      node,
      "completed",
      effect.decision?.decision === "completed"
        ? "Marked applied by the user"
        : "Replayed the recorded result (the command was not run again)",
      { output },
    );
  }

  // ---- starting steps ----------------------------------------------------------------------
  private tryStart(run: RunRecord, node: GraphNode): boolean {
    const ns = run.nodes[node.id];
    const inc = this.incoming(run, node.id);
    const sources = inc.map((e) => ({ e, src: run.nodes[e.from] }));
    if (sources.some((s) => !this.resolved(run, s.e, s.src))) return false;
    const fired = sources.filter((s) =>
      edgeFires(s.e.on, s.src.outcome!, s.src.branch),
    );
    if (inc.length && node.type !== "join" && !fired.length) {
      ns.visit++;
      ns.startedAt = new Date().toISOString();
      this.resolveNode(run, node, "skipped", "No incoming path was taken");
      return true;
    }
    // Gate 1: a paused workflow (including a limit trip) starts nothing.
    const workflow = this.store.get<Workflow>("workflow", run.workflowId);
    if (workflow.paused) {
      this.setWaiting(run, node.id, "workflow-paused");
      return false;
    }
    // Gate 2: steps that consume an agent step's result wait for that task's required reviews.
    // (Agent steps get this through their task's dependsOn; the task gate also checks it.)
    const upstreamTasks = (node.type === "join" ? sources : fired)
      .filter(
        (s) =>
          s.src.outcome === "completed" &&
          typeof s.src.output?.taskId === "string",
      )
      .map((s) => s.src.output!.taskId as string);
    if (node.type !== "task" && upstreamTasks.length) {
      const blocking = this.service.orchestration.blockingReviews({
        dependsOn: upstreamTasks,
      } as Task);
      if (blocking.length) {
        this.setWaiting(run, node.id, "review-required");
        return false;
      }
    }
    switch (node.type) {
      case "task":
        return this.startTask(run, node, upstreamTasks);
      case "command":
        return this.startCommand(run, node);
      case "human":
        return this.startHuman(run, node);
      case "condition":
        return this.startCondition(run, node);
      case "fanout":
        ns.visit++;
        ns.startedAt = new Date().toISOString();
        this.resolveNode(
          run,
          node,
          "completed",
          `Started ${this.outgoing(run, node.id).length} branches`,
        );
        return true;
      case "join":
        return this.startJoin(
          run,
          node,
          sources.map((s) => s.src.outcome!),
        );
      case "loop":
        ns.visit++;
        ns.startedAt = new Date().toISOString();
        this.resolveNode(run, node, "completed", "Iteration 1", {
          branch: "iterate",
          output: { iteration: 1, exhausted: false },
        });
        return true;
    }
  }
  private fail(run: RunRecord, node: GraphNode, error: unknown) {
    const ns = run.nodes[node.id];
    if (!ns.visit) ns.visit = 1;
    ns.startedAt ??= new Date().toISOString();
    this.resolveNode(
      run,
      node,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    return true;
  }
  /** Typed inputs: step outputs or shared state, bounded, type-checked, recorded by hash. */
  resolveInputs(run: RunRecord, node: GraphNode) {
    const values: Record<string, unknown> = {};
    const meta: Record<string, InputMeta> = {};
    const actor = this.service.shared.actor(
      (node as { agentId?: string }).agentId ?? null,
    );
    for (const [name, spec] of Object.entries(node.inputs ?? {})) {
      const ref = parseRef(spec.from)!;
      let value: unknown = undefined;
      if (ref.kind === "node") {
        const src = run.nodes[ref.node];
        if (src?.status === "done" && src.outcome !== "skipped")
          value = src.output?.[ref.field];
      } else {
        try {
          const f = this.service.shared.read(run.workflowId, ref.key, actor);
          value = f.value ?? undefined;
        } catch (e) {
          if ((e as { status?: number }).status === 403) throw e;
        }
      }
      const present = value !== undefined && value !== null;
      if (!present) {
        if (spec.required)
          throw new AppError(
            409,
            "missing_input",
            `Input "${name}" (${spec.from}) has no value: the step it reads did not produce one`,
          );
        meta[name] = {
          source: spec.from,
          type: spec.type,
          sha256: null,
          chars: 0,
          present: false,
        };
        values[name] = null;
        continue;
      }
      const actual = typeOfValue(value);
      if (!compatible(spec.type, actual))
        throw new AppError(
          409,
          "input_type",
          `Input "${name}" (${spec.from}) is ${actual}, declared ${spec.type}`,
        );
      let v: unknown =
        spec.type === "string" && actual !== "string" ? String(value) : value;
      let truncated = false;
      if (typeof v === "string" && v.length > MAX_INPUT_CHARS) {
        v = v.slice(0, MAX_INPUT_CHARS);
        truncated = true;
      }
      const text = typeof v === "string" ? v : JSON.stringify(v);
      values[name] = v;
      meta[name] = {
        source: spec.from,
        type: spec.type,
        sha256: sha256(text),
        chars: text.length,
        present: true,
        truncated: truncated || undefined,
      };
    }
    return { values, meta };
  }
  private begin(
    run: RunRecord,
    node: GraphNode,
    meta: Record<string, InputMeta>,
  ) {
    const ns = run.nodes[node.id];
    ns.visit++;
    ns.status = "active";
    ns.startedAt = new Date().toISOString();
    ns.inputs = meta;
    ns.waiting = null;
  }

  private startTask(
    run: RunRecord,
    node: Extract<GraphNode, { type: "task" }>,
    deps: string[],
  ) {
    let inputs;
    try {
      inputs = this.resolveInputs(run, node);
    } catch (e) {
      return this.fail(run, node, e);
    }
    const block = Object.entries(inputs.values).length
      ? "\n\n" +
        UNTRUSTED_NOTICE +
        "\n" +
        Object.entries(inputs.values)
          .map(([name, v]) =>
            untrusted(
              "graph-input",
              { name, source: inputs.meta[name].source },
              typeof v === "string" ? v : JSON.stringify(v),
            ),
          )
          .join("\n")
      : "";
    try {
      const task = this.service.task({
        workflowId: run.workflowId,
        agentId: node.agentId,
        title: node.title,
        instructions: node.instructions + block,
        dependsOn: deps,
        completionCriteria: node.completionCriteria,
        requiresValidation: node.requiresValidation,
        completionChecks: node.completionChecks,
        changedFiles: node.changedFiles,
        tags: node.tags,
      });
      this.begin(run, node, inputs.meta);
      run.nodes[node.id].taskId = task.id;
      this.store.transaction(() => {
        this.save_(run);
        this.store.emit("graph.node.started", run.id, {
          nodeId: node.id,
          taskId: task.id,
        });
      });
      return true;
    } catch (e) {
      run.nodes[node.id].inputs = inputs.meta;
      return this.fail(run, node, e);
    }
  }

  private startCondition(
    run: RunRecord,
    node: Extract<GraphNode, { type: "condition" }>,
  ) {
    try {
      const inputs = this.resolveInputs(run, node);
      run.nodes[node.id].inputs = inputs.meta;
      const value = evalExpr(node.expr, inputs.values);
      const ns = run.nodes[node.id];
      ns.visit++;
      ns.startedAt = new Date().toISOString();
      this.resolveNode(run, node, "completed", `Condition is ${value}`, {
        branch: String(value),
        output: { value, branch: String(value) },
      });
      return true;
    } catch (e) {
      return this.fail(
        run,
        node,
        e instanceof ExprError
          ? new Error(`Condition could not be evaluated: ${e.message}`)
          : e,
      );
    }
  }

  private startJoin(run: RunRecord, node: JoinNode, outcomes: Outcome[]) {
    const r = joinOutcome(
      node,
      outcomes.map((outcome) => ({ outcome })),
    );
    const ns = run.nodes[node.id];
    ns.visit++;
    ns.startedAt = new Date().toISOString();
    this.resolveNode(run, node, r.outcome, r.reason, {
      output: {
        completed: r.completed,
        failed: r.failed,
        cancelled: r.cancelled,
        skipped: r.skipped,
        partial: r.partial,
      },
    });
    return true;
  }

  private startHuman(run: RunRecord, node: HumanNode) {
    let inputs;
    try {
      inputs = this.resolveInputs(run, node);
    } catch (e) {
      return this.fail(run, node, e);
    }
    const workflow = this.store.get<Workflow>("workflow", run.workflowId);
    const agentId = node.agentId ?? workflow.ownerId;
    const request = {
      sessionId: `graph:${run.id}`,
      toolCall: {
        toolCallId: `graph-${run.id}-${node.id}-${run.nodes[node.id].visit + 1}`,
        title: node.prompt,
        kind: "other",
        rawInput: {
          graphRunId: run.id,
          nodeId: node.id,
          allowText: !!node.allowText,
        },
      },
      options: node.choices.map((c, i) => ({
        optionId: c,
        name: c,
        kind: i === 0 ? "allow_once" : "reject_once",
      })),
    } as unknown as ApprovalRecord["request"];
    const record: ApprovalRecord = {
      id: randomUUID(),
      agentId,
      request,
      createdAt: new Date().toISOString(),
      fingerprint: approvalFingerprint(agentId, undefined, request),
      status: "pending",
    };
    this.begin(run, node, inputs.meta);
    run.nodes[node.id].approvalId = record.id;
    this.store.transaction(() => {
      this.store.put("approval", record);
      this.store.emit("approval.requested", agentId, { id: record.id });
      this.save_(run);
      this.store.emit("graph.node.started", run.id, {
        nodeId: node.id,
        approvalId: record.id,
      });
    });
    return true;
  }

  private startCommand(run: RunRecord, node: CommandNode) {
    const ns = run.nodes[node.id];
    let inputs;
    try {
      inputs = this.resolveInputs(run, node);
    } catch (e) {
      return this.fail(run, node, e);
    }
    const args: string[] = [];
    for (const a of node.argv) {
      if (typeof a === "string") {
        args.push(a);
        continue;
      }
      const v = inputs.values[a.input];
      const text =
        v === null || v === undefined
          ? ""
          : typeof v === "string"
            ? v
            : JSON.stringify(v);
      if (text.startsWith("-") || text.includes("\0") || text.length > 4000) {
        run.nodes[node.id].inputs = inputs.meta;
        return this.fail(
          run,
          node,
          new AppError(
            409,
            "input_argument",
            `Input "${a.input}" cannot be used as an argument (empty, flag-like, too long or contains NUL)`,
          ),
        );
      }
      args.push(text);
    }
    if (!this.enabled()) {
      this.setWaiting(run, node.id, "live-execution-disabled");
      return false;
    }
    let agent: Agent;
    try {
      agent = this.store.get<Agent>("agent", node.agentId);
    } catch (e) {
      return this.fail(run, node, e);
    }
    if (agent.control !== "team") {
      this.setWaiting(run, node.id, "human-control");
      return false;
    }
    const stepKey = `graph:${run.id}:${node.id}:${ns.visit + 1}`;
    const pseudo = {
      id: stepKey,
      workflowId: run.workflowId,
      agentId: node.agentId,
    } as Task;
    // Limits (turn cap, trips) then the folder lease: the same checks a task start goes through.
    try {
      this.service.limits.enforceStart(pseudo);
    } catch (e) {
      this.setWaiting(run, node.id, e instanceof Error ? e.message : "limit");
      return false;
    }
    try {
      this.service.resources.acquire(stepKey, node.agentId, run.workflowId);
    } catch (e) {
      if ((e as { code?: string }).code === "resource_busy") {
        this.setWaiting(run, node.id, "resource-busy");
        return false;
      }
      return this.fail(run, node, e);
    }
    this.service.limits.recordTurn(pseudo);
    this.begin(run, node, inputs.meta);
    const key = `${run.id}:${node.id}:${run.nodes[node.id].visit}`;
    const effectKey = `graph-command:${run.id}:${node.id}:${run.nodes[node.id].visit}`;
    run.nodes[node.id].effectKey = effectKey;
    run.nodes[node.id].display = displayCommand(node, args);
    const controller = new AbortController();
    this.live.set(key, controller);
    this.store.transaction(() => {
      this.save_(run);
      this.store.emit("graph.node.started", run.id, {
        nodeId: node.id,
        command: run.nodes[node.id].display,
      });
    });
    const visit = run.nodes[node.id].visit;
    const p = this.executeCommand(
      run.id,
      node,
      agent,
      args,
      stepKey,
      effectKey,
      visit,
      controller,
    )
      .catch(() => undefined)
      .finally(() => {
        this.inflight.delete(p);
        this.live.delete(key);
        try {
          this.service.resources.release(stepKey);
          this.advanceAll();
        } catch {
          /* store closed (shutdown or test teardown) */
        }
      });
    this.inflight.add(p);
    return true;
  }

  private async executeCommand(
    runId: string,
    node: CommandNode,
    agent: Agent,
    args: string[],
    stepKey: string,
    effectKey: string,
    visit: number,
    controller: AbortController,
  ) {
    const ledger = this.service.recovery.ledger;
    const still = (cancelled = false) => {
      const r = this.run(runId);
      const ns = r.nodes[node.id];
      return (r.status === "running" ||
        (cancelled && r.status === "cancelled")) &&
        ns.status === "active" &&
        ns.visit === visit
        ? r
        : null;
    };
    let effect: Effect | undefined;
    let began = false;
    try {
      const plan = await planCommand(node, agent, args);
      const begun = ledger.begin({
        taskId: stepKey,
        key: effectKey,
        kind: "graph-command",
        description: plan.display,
        mutating: plan.mutating,
        ref: { runId, nodeId: node.id },
      });
      effect = begun.effect;
      began = true;
      if (begun.action === "replay") {
        const r = still();
        if (r) this.finishFromEffect(r, node, effect);
        return;
      }
      {
        const r = still();
        if (r) {
          r.nodes[node.id].display = plan.display;
          this.save_(r);
        }
      }
      const result = await runCommand(plan, controller.signal, (pid) =>
        this.service.resources.attachProcess(stepKey, pid),
      );
      const r = still(result.aborted);
      const output = commandOutput(result);
      const ok = result.exitCode === 0 && !result.timedOut && !result.aborted;
      if (ok) {
        ledger.complete(effect.id, JSON.stringify(output));
        if (r)
          this.resolveNode(
            r,
            node,
            "completed",
            `Exit code 0 in ${result.durationMs} ms`,
            { output },
          );
        return;
      }
      const why = result.spawnError
        ? `Could not start: ${result.spawnError}`
        : result.aborted
          ? "Cancelled"
          : result.timedOut
            ? `Timed out after ${plan.timeoutMs} ms`
            : `Exit code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
      // Spawn failure proves nothing ran. A mutating program that ran and failed (or was killed)
      // may have changed things: that outcome is uncertain and the user decides (ledger).
      if (plan.mutating && !result.spawnError) {
        ledger.markUncertain(effect.id, why);
        if (r) {
          r.nodes[node.id].lastAttempt = output;
          r.nodes[node.id].waiting = "effect-uncertain";
          this.save_(r);
        }
        return;
      }
      ledger.fail(effect.id, why);
      if (r)
        this.resolveNode(
          r,
          node,
          result.aborted ? "cancelled" : "failed",
          why,
          { output },
        );
    } catch (e) {
      const code = (e as { code?: string }).code;
      const r = still();
      if (code === "effect_uncertain" || code === "effect_in_flight") {
        if (r) {
          r.nodes[node.id].waiting = "effect-uncertain";
          this.save_(r);
        }
        return;
      }
      if (began && effect)
        ledger.fail(effect.id, e instanceof Error ? e.message : String(e));
      if (r)
        this.resolveNode(
          r,
          node,
          "failed",
          e instanceof Error ? e.message : String(e),
        );
    }
  }

  private loopStep(run: RunRecord, node: LoopNode): boolean {
    const ns = run.nodes[node.id];
    if (
      ns.status !== "done" ||
      ns.outcome !== "completed" ||
      ns.branch !== "iterate"
    )
      return false;
    const body = this.body(run, node.id);
    if (![...body].every((id) => run.nodes[id].status === "done")) return false;
    const continues = run.definition.edges
      .filter((e) => e.back && e.to === node.id)
      .some((e) => {
        const s = run.nodes[e.from];
        return s.status === "done" && edgeFires(e.on, s.outcome!, s.branch);
      });
    if (!continues) return false;
    if (this.store.get<Workflow>("workflow", run.workflowId).paused) {
      this.setWaiting(run, node.id, "workflow-paused");
      return false;
    }
    const iteration = Number(ns.output?.iteration ?? 1);
    ns.visit++;
    ns.startedAt = new Date().toISOString();
    let done = false;
    try {
      const inputs = this.resolveInputs(run, node);
      ns.inputs = inputs.meta;
      done = node.until ? evalExpr(node.until, inputs.values) : false;
    } catch (e) {
      this.resolveNode(
        run,
        node,
        "failed",
        e instanceof Error ? e.message : String(e),
        {
          output: { iteration, exhausted: false },
        },
      );
      return true;
    }
    if (done) {
      this.resolveNode(
        run,
        node,
        "completed",
        `Condition met after ${iteration} iteration(s)`,
        {
          branch: "done",
          output: { iteration, exhausted: false },
        },
      );
    } else if (iteration >= (node.maxIterations ?? 1)) {
      this.resolveNode(
        run,
        node,
        node.onExhausted === "fail" ? "failed" : "completed",
        `Reached the limit of ${node.maxIterations} iterations`,
        { branch: "done", output: { iteration, exhausted: true } },
      );
    } else {
      this.reset(run, body);
      this.resolveNode(
        run,
        node,
        "completed",
        `Iteration ${iteration + 1} of at most ${node.maxIterations}`,
        {
          branch: "iterate",
          output: { iteration: iteration + 1, exhausted: false },
        },
      );
    }
    return true;
  }

  // ---- user actions ------------------------------------------------------------------------
  /** Answer a human-input step: persisted approval + optional free text. */
  async answer(runId: string, nodeId: string, input: unknown) {
    const body = answerSchema.parse(input);
    const run = this.run(runId);
    const node = run.definition.nodes.find((n) => n.id === nodeId);
    assert(
      node?.type === "human",
      "not_human_step",
      "That step does not ask for input",
      400,
    );
    const ns = run.nodes[nodeId];
    assert(
      ns.status === "active" && ns.approvalId,
      "not_waiting",
      "This step is not waiting for input",
    );
    assert(
      body.choice === null || (node as HumanNode).choices.includes(body.choice),
      "invalid_option",
      "Unknown choice",
      400,
    );
    assert(
      !body.text || (node as HumanNode).allowText,
      "text_not_allowed",
      "This step does not accept free text",
      400,
    );
    this.store.transaction(() => {
      ns.answerText = body.text ?? "";
      this.save_(run);
    });
    this.service.approvals.respond(ns.approvalId, body.choice);
    this.advance(runId);
    return this.view(runId);
  }

  /** Nodes whose retry would discard completed work are refused. */
  retryBlockers(run: RunRecord, nodeId: string) {
    const ns = run.nodes[nodeId];
    if (run.status === "cancelled") return "The run was cancelled";
    if (run.status === "completed") return "The run completed";
    if (
      ns.status !== "done" ||
      (ns.outcome !== "failed" && ns.outcome !== "cancelled")
    )
      return "Only a failed or cancelled step can be retried";
    for (const d of downstreamOf(run.definition, nodeId)) {
      const s = run.nodes[d];
      if (s.status === "active") return `Downstream step "${d}" is running`;
      if (s.status === "done" && s.outcome === "completed")
        return `Downstream step "${d}" already completed; its work is not undone`;
    }
    return null;
  }
  retryStep(runId: string, nodeId: string) {
    const run = this.run(runId);
    const node = run.definition.nodes.find((n) => n.id === nodeId);
    assert(node, "unknown_step", "No such step", 404);
    const blocked = this.retryBlockers(run, nodeId);
    assert(!blocked, "not_retryable", blocked ?? "", 409);
    const ns = run.nodes[nodeId];
    const down = downstreamOf(run.definition, nodeId);
    const retries = ns.retries + 1;
    if (node.type === "task" && ns.taskId) {
      const task = this.store.get<Task>("task", ns.taskId);
      // Retry-from-checkpoint of the same task: attempts, backoff, uncertain effects and every gate apply.
      if (task.status === "failed") this.service.recovery.requeue(task.id);
    }
    this.store.transaction(() => {
      const keepTask =
        node.type === "task" &&
        ns.taskId &&
        this.store.get<Task>("task", ns.taskId).status === "queued"
          ? ns.taskId
          : undefined;
      this.reset(run, down);
      run.nodes[nodeId] = {
        status: keepTask ? "active" : "pending",
        visit: ns.visit,
        retries,
        taskId: keepTask,
        startedAt: ns.startedAt,
        inputs: ns.inputs,
      };
      if (run.status === "failed") {
        run.status = "running";
        run.finishedAt = undefined;
        run.reason = undefined;
      }
      this.save_(run);
      this.store.emit("graph.step.retry", run.id, { nodeId, retries });
    });
    this.advance(runId);
    return this.view(runId);
  }

  cancelRun(runId: string) {
    const run = this.run(runId);
    assert(
      run.status === "running" || run.status === "failed",
      "not_running",
      "The run already finished",
    );
    this.store.transaction(() => {
      run.status = "cancelled";
      run.finishedAt = new Date().toISOString();
      run.reason = "Cancelled by the user";
      this.save_(run);
      this.store.emit("graph.run.finished", run.id, {
        status: "cancelled",
        graphId: run.graphId,
      });
    });
    for (const node of run.definition.nodes) {
      const ns = run.nodes[node.id];
      if (ns.status !== "active") continue;
      if (node.type === "human" && ns.approvalId) {
        try {
          this.service.approvals.respond(ns.approvalId, null);
        } catch {
          /* already answered */
        }
      }
      if (node.type === "command") {
        const live = this.live.get(`${run.id}:${node.id}:${ns.visit}`);
        // A live process records its own cancelled step when it has stopped.
        if (live) {
          live.abort();
          continue;
        }
      }
      if (node.type === "task" && ns.taskId) {
        const task = this.store.get<Task>("task", ns.taskId);
        if (task.status === "running") {
          if (!this.service.limits.abortTask(task.id))
            this.service.transitionTask(task.id, {
              status: "cancelled",
              result: "Graph run cancelled",
            });
        } else if (
          ["queued", "failed", "interrupted", "blocked"].includes(task.status)
        )
          this.service.transitionTask(task.id, {
            status: "cancelled",
            result: "Graph run cancelled",
          });
      }
      this.resolveNode(run, node, "cancelled", "The run was cancelled");
    }
    return this.view(runId);
  }

  // ---- views -------------------------------------------------------------------------------
  view(runId: string) {
    const run = this.run(runId);
    const ledger = this.service.recovery.ledger;
    const nodes = run.definition.nodes.map((n) => {
      const ns = run.nodes[n.id];
      let task: unknown = null;
      if (ns.taskId)
        try {
          const t = this.service.taskState(ns.taskId);
          task = { id: t.id, status: t.status, waitReason: t.waitReason };
        } catch {
          /* removed */
        }
      const effect = ns.effectKey ? ledger.find(ns.effectKey) : undefined;
      return {
        id: n.id,
        type: n.type,
        label: n.label ?? null,
        ...ns,
        task,
        effect: effect
          ? {
              id: effect.id,
              state: effect.state,
              description: effect.description,
              mutating: effect.mutating,
            }
          : null,
        retryable: !this.retryBlockers(run, n.id),
        unhandled: this.unhandled(run, n.id),
        pendingInput:
          n.type === "human" && ns.status === "active"
            ? {
                prompt: (n as HumanNode).prompt,
                choices: (n as HumanNode).choices,
                allowText: !!(n as HumanNode).allowText,
              }
            : null,
      };
    });
    const attention: { kind: string; nodeId: string; message: string }[] = [];
    for (const n of nodes) {
      if (n.pendingInput)
        attention.push({
          kind: "human-input",
          nodeId: n.id,
          message: n.pendingInput.prompt,
        });
      if (n.effect?.state === "uncertain")
        attention.push({
          kind: "uncertain-effect",
          nodeId: n.id,
          message: `Decide whether "${n.effect.description}" was applied (Recovery panel)`,
        });
      if (n.unhandled)
        attention.push({
          kind: "failed-step",
          nodeId: n.id,
          message: `${n.id} ${n.outcome}; nothing handles it${n.retryable ? " (retryable)" : ""}`,
        });
    }
    return {
      id: run.id,
      graphId: run.graphId,
      graphName: run.graphName,
      graphVersion: run.graphVersion,
      graphHash: run.graphHash,
      workflowId: run.workflowId,
      status: run.status,
      reason: run.reason ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      definition: run.definition,
      nodes,
      attention,
      path: this.path(runId),
    };
  }
}

function commandOutput(r: CommandResult): Record<string, unknown> {
  return {
    exitCode: r.exitCode,
    passed: r.exitCode === 0 && !r.timedOut && !r.aborted,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    truncated: r.truncated.stdout || r.truncated.stderr,
    signal: r.signal,
    durationMs: r.durationMs,
    ...(r.spawnError ? { spawnError: r.spawnError } : {}),
  };
}

/**
 * Workflow graph API (behind the bearer-token check in http.ts):
 *   GET  /graphs[?workflowId=]              graphs with live validation
 *   POST /graphs                            save {workflowId, name, nodes, edges}
 *   POST /graphs/validate                   validate a draft {workflowId, nodes, edges} without saving
 *   GET|PUT /graphs/:id                     one graph / edit (a definition change appends an immutable version)
 *   GET  /graphs/:id/versions               immutable definition history
 *   GET  /graphs/:id/commands               commands a run would execute + the hash start must confirm
 *   GET|POST /graphs/:id/runs               runs / start {confirmCommandsHash}
 *   GET  /graph-runs/:id                    live view: node states, attention list, executed path
 *   GET  /graph-runs/:id/path               immutable executed-path records
 *   POST /graph-runs/:id/cancel
 *   POST /graph-runs/:id/nodes/:node/answer {choice|null, text?} human-input step
 *   POST /graph-runs/:id/nodes/:node/retry  retry a failed step (task: retry-from-checkpoint)
 */
export async function graphRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  const graphs = service.graphs;
  const dec = (v: string) => decodeURIComponent(v);
  let m: RegExpMatchArray | null;
  if (path === "/graphs" && method === "GET")
    return { data: graphs.list(url.searchParams.get("workflowId")) };
  if (path === "/graphs" && method === "POST")
    return { data: graphs.save(await readBody()), status: 201 };
  if (path === "/graphs/validate" && method === "POST") {
    const body = z
      .object({
        workflowId: z.string(),
        nodes: z.array(z.unknown()),
        edges: z.array(z.unknown()),
      })
      .passthrough()
      .parse(await readBody());
    const def = definitionSchema.parse({
      nodes: body.nodes,
      edges: body.edges,
    });
    service.store.get("workflow", body.workflowId);
    return { data: graphs.validate(body.workflowId, def) };
  }
  if ((m = path.match(/^\/graphs\/([^/]+)(?:\/(versions|commands|runs))?$/))) {
    const id = dec(m[1]);
    if (!m[2] && method === "GET")
      return { data: graphs.withValidation(graphs.graph(id)) };
    if (!m[2] && method === "PUT")
      return { data: graphs.update(id, await readBody()) };
    if (m[2] === "versions" && method === "GET")
      return { data: graphs.versions(id) };
    if (m[2] === "commands" && method === "GET")
      return { data: graphs.commands(id) };
    if (m[2] === "runs" && method === "GET") return { data: graphs.runs(id) };
    if (m[2] === "runs" && method === "POST")
      return { data: graphs.startRun(id, await readBody()), status: 201 };
  }
  if (
    (m = path.match(
      /^\/graph-runs\/([^/]+)(?:\/(path|cancel)|\/nodes\/([^/]+)\/(answer|retry))?$/,
    ))
  ) {
    const id = dec(m[1]);
    if (!m[2] && !m[3] && method === "GET") return { data: graphs.view(id) };
    if (m[2] === "path" && method === "GET") return { data: graphs.path(id) };
    if (m[2] === "cancel" && method === "POST") {
      z.object({})
        .strict()
        .parse(await readBody());
      return { data: graphs.cancelRun(id) };
    }
    if (m[4] === "answer" && method === "POST")
      return { data: await graphs.answer(id, dec(m[3]), await readBody()) };
    if (m[4] === "retry" && method === "POST") {
      z.object({})
        .strict()
        .parse(await readBody());
      return { data: graphs.retryStep(id, dec(m[3])), status: 202 };
    }
  }
  return undefined;
}
