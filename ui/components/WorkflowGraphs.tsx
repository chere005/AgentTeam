import { useCallback, useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type Snapshot, type TeamEvent } from "../api";
import { NODE_TYPE_LABEL, layerGraph, nodeSummary } from "../graph-layout";
import "./workflow-graphs.css";

type GNode = Record<string, any> & { id: string; type: string };
type GEdge = { from: string; to: string; on?: string; back?: boolean };
type Issue = { code: string; message: string; nodeId?: string };
type Validation = { ok: boolean; errors: Issue[]; warnings: Issue[] };
type Graph = {
  id: string;
  workflowId: string;
  name: string;
  description: string;
  version: number;
  nodes: GNode[];
  edges: GEdge[];
  validation: Validation;
};
type Step = {
  id: string;
  seq: number;
  nodeId: string;
  nodeType: string;
  visit: number;
  attempt: number;
  outcome: string;
  branch?: string;
  reason: string;
  fired: { to: string; on: string; back: boolean }[];
  command?: { display: string };
};
type RunNode = {
  id: string;
  type: string;
  status: string;
  outcome?: string;
  waiting?: string | null;
  visit: number;
  retryable: boolean;
  unhandled: boolean;
  display?: string;
  taskId?: string;
  effect: { id: string; state: string; description: string } | null;
  pendingInput: {
    prompt: string;
    choices: string[];
    allowText: boolean;
  } | null;
};
type RunView = {
  id: string;
  graphId: string;
  status: string;
  reason: string | null;
  graphVersion: number;
  definition: { nodes: GNode[]; edges: (GEdge & { on: string })[] };
  nodes: RunNode[];
  attention: { kind: string; nodeId: string; message: string }[];
  path: Step[];
};
type Commands = {
  hash: string;
  commands: {
    nodeId: string;
    display: string;
    mutating: boolean;
    shell: boolean;
    workspace: string | null;
    timeoutMs: number;
  }[];
};

const TYPES = [
  "task",
  "command",
  "condition",
  "human",
  "fanout",
  "join",
  "loop",
];
const TRIGGERS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "always",
  "true",
  "false",
  "iterate",
  "done",
];
const COLORS: Record<string, string> = {
  completed: "#2f6f4f",
  failed: "#8a3a3a",
  cancelled: "#7a6a2f",
  skipped: "#3a4252",
  active: "#2f5f8a",
  pending: "#222a37",
};
const OPS = [
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
];

type Form = Record<string, string | boolean>;
const emptyForm = (type: string): Form => ({
  type,
  id: "",
  agentId: "",
  title: "",
  instructions: "",
  completionCriteria: "done",
  argv: "",
  shell: false,
  cwd: "",
  timeoutMs: "60000",
  mutating: false,
  prompt: "",
  choices: "approve, reject",
  allowText: false,
  mode: "all",
  minCompleted: "",
  maxIterations: "3",
  onExhausted: "fail",
  expr: "",
  inputs: "",
});
/** Turns the form into a node definition; throws a readable message for malformed JSON. */
function buildNode(f: Form): GNode {
  const json = (key: string, label: string) => {
    const text = String(f[key] ?? "").trim();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  };
  const node: GNode = { id: String(f.id).trim(), type: String(f.type) };
  const inputs = json("inputs", "Inputs");
  if (inputs) node.inputs = inputs;
  switch (f.type) {
    case "task":
      Object.assign(node, {
        agentId: f.agentId,
        title: f.title,
        instructions: f.instructions,
        completionCriteria: f.completionCriteria,
      });
      break;
    case "command":
      Object.assign(node, {
        agentId: f.agentId,
        argv: String(f.argv)
          .split("\n")
          .map((l) => l.replace(/\r$/, ""))
          .filter((l) => l.length)
          .map((l) =>
            /^\{[a-zA-Z0-9]+\}$/.test(l) ? { input: l.slice(1, -1) } : l,
          ),
        timeoutMs: Number(f.timeoutMs) || 60000,
        mutating: !!f.mutating,
      });
      if (f.shell) node.shell = true;
      if (String(f.cwd).trim()) node.cwd = String(f.cwd).trim();
      break;
    case "condition":
      node.expr = json("expr", "Condition");
      break;
    case "human":
      Object.assign(node, {
        prompt: f.prompt,
        choices: String(f.choices)
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
        allowText: !!f.allowText,
      });
      if (String(f.agentId)) node.agentId = f.agentId;
      break;
    case "join":
      node.mode = f.mode;
      if (String(f.minCompleted).trim())
        node.minCompleted = Number(f.minCompleted);
      break;
    case "loop":
      node.onExhausted = f.onExhausted;
      if (String(f.maxIterations).trim())
        node.maxIterations = Number(f.maxIterations);
      {
        const until = json("expr", "Until condition");
        if (until) node.until = until;
      }
      break;
  }
  return node;
}
function formOf(n: GNode): Form {
  const f = emptyForm(n.type);
  for (const k of Object.keys(f))
    if (
      n[k] !== undefined &&
      k !== "argv" &&
      k !== "choices" &&
      k !== "inputs" &&
      k !== "expr"
    )
      f[k] = typeof n[k] === "boolean" ? n[k] : String(n[k]);
  f.id = n.id;
  if (n.argv)
    f.argv = n.argv
      .map((a: unknown) =>
        typeof a === "string" ? a : `{${(a as { input: string }).input}}`,
      )
      .join("\n");
  if (n.choices) f.choices = n.choices.join(", ");
  if (n.inputs) f.inputs = JSON.stringify(n.inputs);
  const e = n.type === "loop" ? n.until : n.expr;
  if (e) f.expr = JSON.stringify(e);
  return f;
}

/** Read-only React Flow rendering of a definition, optionally coloured by a run's state. */
function FlowView({
  nodes,
  edges,
  run,
}: {
  nodes: GNode[];
  edges: GEdge[];
  run?: RunView | null;
}) {
  const layout = useMemo(() => layerGraph(nodes, edges), [nodes, edges]);
  const state = new Map(run?.nodes.map((n) => [n.id, n]));
  const taken = new Set(
    run?.path.flatMap((s) => s.fired.map((f) => `${s.nodeId}>${f.to}`)),
  );
  const flowNodes: Node[] = nodes.map((n) => {
    const s = state.get(n.id);
    const key = s
      ? s.status === "done"
        ? (s.outcome ?? "pending")
        : s.status
      : "pending";
    return {
      id: n.id,
      position: layout.get(n.id) ?? { x: 0, y: 0 },
      draggable: false,
      connectable: false,
      selectable: false,
      data: {
        label: (
          <div
            data-testid={"flow-node-" + n.id}
            data-state={run ? key : undefined}
          >
            <b>{n.id}</b>
            <small>{NODE_TYPE_LABEL[n.type] ?? n.type}</small>
            {run && <small>{key}</small>}
          </div>
        ),
      },
      style: {
        width: 170,
        fontSize: 11,
        background: run ? (COLORS[key] ?? COLORS.pending) : "#1b2230",
        color: "#e6edf7",
        border: "1px solid #3a4558",
        borderRadius: 8,
        borderStyle:
          n.type === "fanout" || n.type === "join" || n.type === "loop"
            ? "dashed"
            : "solid",
      },
    };
  });
  const flowEdges: Edge[] = edges.map((e, i) => {
    const on = e.on ?? "";
    const hit = taken.has(`${e.from}>${e.to}`);
    return {
      id: `${e.from}>${e.to}>${i}`,
      source: e.from,
      target: e.to,
      label: (e.back ? "back " : "") + on,
      animated: !!run && hit,
      style: {
        stroke: hit ? "#8cddc2" : "#5c6a80",
        strokeDasharray: e.back ? "5 4" : undefined,
        strokeWidth: hit ? 2.2 : 1.2,
      },
      labelStyle: { fontSize: 10, fill: "#aab6c8" },
    };
  });
  return (
    <div className="wg-flow" data-testid="graph-flow">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
      >
        <Background />
      </ReactFlow>
    </div>
  );
}

function Issues({ v }: { v: Validation | null }) {
  if (!v) return null;
  return (
    <div data-testid="graph-validation" className={v.ok ? "wg-ok" : "wg-bad"}>
      <b>
        {v.ok
          ? "Valid: can run"
          : `${v.errors.length} problem(s) block running`}
      </b>
      <ul>
        {v.errors.map((e, i) => (
          <li key={"e" + i} data-testid="graph-error" data-code={e.code}>
            {e.message}
          </li>
        ))}
        {v.warnings.map((e, i) => (
          <li key={"w" + i} className="quiet" data-testid="graph-warning">
            Warning: {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Workflow graphs: the executable step graph (distinct from the agent communication graph on the
 * canvas). A form/list editor with live static validation, a read-only React Flow view, commands
 * shown before a run, the live run with its executed path, human answers and retry-from-step.
 */
export function WorkflowGraphs({
  data,
  events,
  act,
  goCanvas,
}: {
  data: Snapshot;
  events: TeamEvent[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  goCanvas: () => void;
}) {
  const [workflowId, setWorkflowId] = useState(data.workflows[0]?.id ?? "");
  const [graphs, setGraphs] = useState<Graph[]>([]);
  const [draft, setDraft] = useState<{
    id?: string;
    name: string;
    nodes: GNode[];
    edges: GEdge[];
  } | null>(null);
  const [issues, setIssues] = useState<Validation | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [edge, setEdge] = useState<GEdge>({ from: "", to: "", on: "success" });
  const [error, setError] = useState("");
  const [commands, setCommands] = useState<Commands | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [runs, setRuns] = useState<
    { id: string; status: string; startedAt: string; graphVersion: number }[]
  >([]);
  const [run, setRun] = useState<RunView | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const agents = data.agents;
  const wfId = data.workflows.some((w) => w.id === workflowId)
    ? workflowId
    : (data.workflows[0]?.id ?? "");

  const loadGraphs = useCallback(async () => {
    if (!wfId) return;
    try {
      setGraphs(await api(`/graphs?workflowId=${wfId}`));
    } catch {
      /* backend restarting */
    }
  }, [wfId]);
  useEffect(() => {
    void loadGraphs();
  }, [loadGraphs]);
  const loadRun = useCallback(async (id: string) => {
    try {
      setRun(await api(`/graph-runs/${id}`));
    } catch {
      /* gone */
    }
  }, []);
  const loadRuns = useCallback(async (graphId: string) => {
    try {
      setRuns([...(await api(`/graphs/${graphId}/runs`))].reverse());
    } catch {
      /* ignore */
    }
  }, []);
  const last = events.reduce((m, e) => Math.max(m, e.seq), 0);
  useEffect(() => {
    if (run) void loadRun(run.id);
    if (draft?.id) void loadRuns(draft.id);
    void loadGraphs();
    // Refresh when something the graph reacts to happened.
  }, [last]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live static validation of the draft (the backend is the single source of truth for the rules).
  useEffect(() => {
    if (!draft || !wfId || !draft.nodes.length) {
      setIssues(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        setIssues(
          await api("/graphs/validate", "POST", {
            workflowId: wfId,
            nodes: draft.nodes,
            edges: draft.edges,
          }),
        );
      } catch (e) {
        setIssues({
          ok: false,
          errors: [
            {
              code: "schema",
              message: e instanceof Error ? e.message : String(e),
            },
          ],
          warnings: [],
        });
      }
    }, 200);
    return () => clearTimeout(t);
  }, [draft, wfId]);

  const open = (g: Graph) => {
    setDraft({ id: g.id, name: g.name, nodes: g.nodes, edges: g.edges });
    setRun(null);
    setConfirmed(false);
    setCommands(null);
    void loadRuns(g.id);
    void api(`/graphs/${g.id}/commands`).then(setCommands, () => undefined);
  };
  const names = draft?.nodes.map((n) => n.id) ?? [];
  const save = async () => {
    if (!draft) return;
    setError("");
    try {
      const body = { name: draft.name, nodes: draft.nodes, edges: draft.edges };
      const saved: Graph = draft.id
        ? await api(`/graphs/${draft.id}`, "PUT", body)
        : await api("/graphs", "POST", { ...body, workflowId: wfId });
      setDraft({
        id: saved.id,
        name: saved.name,
        nodes: saved.nodes,
        edges: saved.edges,
      });
      await loadGraphs();
      void api(`/graphs/${saved.id}/commands`).then(
        setCommands,
        () => undefined,
      );
      setConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const addNode = () => {
    if (!form || !draft) return;
    setError("");
    try {
      const node = buildNode(form);
      const rest = draft.nodes.filter((n) => n.id !== (editing ?? node.id));
      if (!editing && draft.nodes.some((n) => n.id === node.id))
        throw new Error(`A step named "${node.id}" already exists`);
      const nodes = editing
        ? draft.nodes.map((n) => (n.id === editing ? node : n))
        : [...rest, node];
      setDraft({ ...draft, nodes });
      setForm(null);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const runAction = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await act(fn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (run) await loadRun(run.id);
    if (draft?.id) await loadRuns(draft.id);
  };
  const startRun = async () => {
    if (!draft?.id) return;
    setError("");
    try {
      const view: RunView = await api(
        `/graphs/${draft.id}/runs`,
        "POST",
        commands?.commands.length ? { confirmCommandsHash: commands.hash } : {},
      );
      setRun(view);
      await loadRuns(draft.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const f = (key: string, value: string | boolean) =>
    setForm((s) => (s ? { ...s, [key]: value } : s));
  const agentSelect = (key: string, optional = false) => (
    <select
      value={String(form?.[key] ?? "")}
      onChange={(e) => f(key, e.target.value)}
      aria-label={key}
    >
      <option value="">{optional ? "(workflow owner)" : "Choose agent"}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
  const dirty =
    !!draft &&
    (!draft.id ||
      JSON.stringify(graphs.find((g) => g.id === draft.id)?.nodes) !==
        JSON.stringify(draft.nodes) ||
      JSON.stringify(graphs.find((g) => g.id === draft.id)?.edges) !==
        JSON.stringify(draft.edges) ||
      graphs.find((g) => g.id === draft.id)?.name !== draft.name);

  return (
    <div className="wg" data-testid="workflow-graphs">
      <div className="row between">
        <b>Workflow graphs</b>
        <button
          onClick={goCanvas}
          title="The agent communication graph: who may talk to whom"
        >
          Agent communication graph
        </button>
      </div>
      <p className="quiet">
        An executable graph of steps (agent tasks, deterministic commands,
        conditions, human input, fan-out/join, bounded loops). It is separate
        from the canvas, which only shows how agents may communicate. Every step
        still passes the validation gate, required reviews, completion checks,
        limits and resource locks.
      </p>
      {error && (
        <div role="alert" className="wg-bad" data-testid="graph-error-message">
          {error}
        </div>
      )}
      {!data.workflows.length ? (
        <p>Create a workflow first (Workflows pane).</p>
      ) : (
        <>
          <div className="row">
            <select
              aria-label="Workflow"
              value={wfId}
              onChange={(e) => {
                setWorkflowId(e.target.value);
                setDraft(null);
                setRun(null);
              }}
            >
              {data.workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                setDraft({ name: "New graph", nodes: [], edges: [] });
                setRun(null);
                setRuns([]);
                setCommands(null);
              }}
            >
              New graph
            </button>
          </div>
          <ul className="wg-list" data-testid="graph-list">
            {graphs.map((g) => (
              <li key={g.id}>
                <button
                  className={draft?.id === g.id ? "active" : ""}
                  onClick={() => open(g)}
                  data-testid="graph-item"
                >
                  {g.name} <small>v{g.version}</small>{" "}
                  <span className={"badge " + (g.validation.ok ? "green" : "")}>
                    {g.validation.ok
                      ? "valid"
                      : `${g.validation.errors.length} problem(s)`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {draft && (
        <section className="wg-editor" data-testid="graph-editor">
          <div className="row">
            <input
              aria-label="Graph name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <button
              className="primary"
              onClick={() => void save()}
              disabled={!dirty || !draft.nodes.length}
            >
              Save{draft.id ? " (new version if the steps changed)" : ""}
            </button>
          </div>
          <FlowView
            nodes={draft.nodes}
            edges={draft.edges}
            run={run && run.graphId === draft.id ? run : null}
          />
          <Issues v={issues} />
          <h4>Steps</h4>
          <ul className="wg-steps" data-testid="graph-nodes">
            {draft.nodes.map((n) => (
              <li key={n.id} data-testid="graph-node">
                <b>{n.id}</b>{" "}
                <span className="badge">
                  {NODE_TYPE_LABEL[n.type] ?? n.type}
                </span>{" "}
                <small>{nodeSummary(n)}</small>
                <span className="grow" />
                <button
                  onClick={() => {
                    setForm(formOf(n));
                    setEditing(n.id);
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      nodes: draft.nodes.filter((x) => x.id !== n.id),
                      edges: draft.edges.filter(
                        (e) => e.from !== n.id && e.to !== n.id,
                      ),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {form ? (
            <div className="wg-form" data-testid="node-form">
              <div className="row">
                <label>
                  Step id{" "}
                  <input
                    aria-label="Step id"
                    value={String(form.id)}
                    disabled={!!editing}
                    onChange={(e) => f("id", e.target.value)}
                  />
                </label>
                <label>
                  Type{" "}
                  <select
                    aria-label="Step type"
                    value={String(form.type)}
                    disabled={!!editing}
                    onChange={(e) =>
                      setForm({
                        ...emptyForm(e.target.value),
                        id: String(form.id),
                      })
                    }
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {NODE_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {(form.type === "task" || form.type === "command") && (
                <label>Agent {agentSelect("agentId")}</label>
              )}
              {form.type === "task" && (
                <>
                  <label>
                    Title{" "}
                    <input
                      aria-label="Title"
                      value={String(form.title)}
                      onChange={(e) => f("title", e.target.value)}
                    />
                  </label>
                  <label>
                    Instructions{" "}
                    <textarea
                      aria-label="Instructions"
                      value={String(form.instructions)}
                      onChange={(e) => f("instructions", e.target.value)}
                    />
                  </label>
                  <label>
                    Completion criteria{" "}
                    <input
                      aria-label="Completion criteria"
                      value={String(form.completionCriteria)}
                      onChange={(e) => f("completionCriteria", e.target.value)}
                    />
                  </label>
                </>
              )}
              {form.type === "command" && (
                <>
                  <label>
                    Program and arguments (one per line; <code>{"{name}"}</code>{" "}
                    inserts a declared input)
                    <textarea
                      aria-label="Command arguments"
                      value={String(form.argv)}
                      onChange={(e) => f("argv", e.target.value)}
                    />
                  </label>
                  <div className="row">
                    <label>
                      Working directory (relative){" "}
                      <input
                        aria-label="Working directory"
                        value={String(form.cwd)}
                        onChange={(e) => f("cwd", e.target.value)}
                      />
                    </label>
                    <label>
                      Timeout ms{" "}
                      <input
                        aria-label="Timeout"
                        value={String(form.timeoutMs)}
                        onChange={(e) => f("timeoutMs", e.target.value)}
                      />
                    </label>
                  </div>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!form.mutating}
                      onChange={(e) => f("mutating", e.target.checked)}
                    />{" "}
                    Changes files or state (needs write access; outcome tracked
                    in the effect ledger)
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!form.shell}
                      onChange={(e) => f("shell", e.target.checked)}
                    />{" "}
                    Run through the platform shell (single script line; off
                    unless you need it)
                  </label>
                </>
              )}
              {form.type === "human" && (
                <>
                  <label>
                    Question{" "}
                    <input
                      aria-label="Question"
                      value={String(form.prompt)}
                      onChange={(e) => f("prompt", e.target.value)}
                    />
                  </label>
                  <label>
                    Choices (comma separated){" "}
                    <input
                      aria-label="Choices"
                      value={String(form.choices)}
                      onChange={(e) => f("choices", e.target.value)}
                    />
                  </label>
                  <label>Asked as {agentSelect("agentId", true)}</label>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!form.allowText}
                      onChange={(e) => f("allowText", e.target.checked)}
                    />{" "}
                    Allow a free-text answer
                  </label>
                </>
              )}
              {form.type === "join" && (
                <div className="row">
                  <label>
                    Mode{" "}
                    <select
                      aria-label="Join mode"
                      value={String(form.mode)}
                      onChange={(e) => f("mode", e.target.value)}
                    >
                      <option value="all">all branches must complete</option>
                      <option value="partial">
                        partial: enough branches complete
                      </option>
                    </select>
                  </label>
                  <label>
                    Minimum completed{" "}
                    <input
                      aria-label="Minimum completed"
                      value={String(form.minCompleted)}
                      onChange={(e) => f("minCompleted", e.target.value)}
                    />
                  </label>
                </div>
              )}
              {form.type === "loop" && (
                <div className="row">
                  <label>
                    Maximum iterations{" "}
                    <input
                      aria-label="Maximum iterations"
                      value={String(form.maxIterations)}
                      onChange={(e) => f("maxIterations", e.target.value)}
                    />
                  </label>
                  <label>
                    When exhausted{" "}
                    <select
                      aria-label="When exhausted"
                      value={String(form.onExhausted)}
                      onChange={(e) => f("onExhausted", e.target.value)}
                    >
                      <option value="fail">fail the loop</option>
                      <option value="exit">leave through done</option>
                    </select>
                  </label>
                </div>
              )}
              {(form.type === "condition" || form.type === "loop") && (
                <label>
                  {form.type === "loop"
                    ? "Stop when (optional JSON expression)"
                    : "Condition (JSON expression)"}
                  <textarea
                    aria-label="Expression"
                    placeholder={`{"left":{"input":"passed"},"op":"truthy"}   ops: ${OPS.join(", ")}`}
                    value={String(form.expr)}
                    onChange={(e) => f("expr", e.target.value)}
                  />
                </label>
              )}
              <label>
                Inputs (JSON, optional): references to earlier step outputs or
                shared state
                <textarea
                  aria-label="Inputs"
                  placeholder={`{"passed":{"from":"tests.passed","type":"boolean"}}`}
                  value={String(form.inputs)}
                  onChange={(e) => f("inputs", e.target.value)}
                />
              </label>
              <div className="row">
                <button className="primary" onClick={addNode}>
                  {editing ? "Update step" : "Add step"}
                </button>
                <button
                  onClick={() => {
                    setForm(null);
                    setEditing(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              {TYPES.map((t) => (
                <button key={t} onClick={() => setForm(emptyForm(t))}>
                  + {NODE_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          <h4>Connections</h4>
          <ul className="wg-steps" data-testid="graph-edges">
            {draft.edges.map((e, i) => (
              <li key={i} data-testid="graph-edge">
                {e.from} → {e.to}{" "}
                <span className="badge">
                  {e.back ? "back, " : ""}
                  {e.on ?? "default"}
                </span>
                <span className="grow" />
                <button
                  onClick={() =>
                    setDraft({
                      ...draft,
                      edges: draft.edges.filter((_, j) => j !== i),
                    })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="row" data-testid="edge-form">
            <select
              aria-label="Edge from"
              value={edge.from}
              onChange={(e) => setEdge({ ...edge, from: e.target.value })}
            >
              <option value="">from</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <select
              aria-label="Edge outcome"
              value={edge.on}
              onChange={(e) => setEdge({ ...edge, on: e.target.value })}
            >
              {TRIGGERS.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select
              aria-label="Edge to"
              value={edge.to}
              onChange={(e) => setEdge({ ...edge, to: e.target.value })}
            >
              <option value="">to</option>
              {names.map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
            <label>
              <input
                type="checkbox"
                checked={!!edge.back}
                onChange={(e) => setEdge({ ...edge, back: e.target.checked })}
              />{" "}
              loop back
            </label>
            <button
              disabled={!edge.from || !edge.to}
              onClick={() => {
                setDraft({
                  ...draft,
                  edges: [
                    ...draft.edges,
                    { ...edge, back: edge.back || undefined },
                  ],
                });
                setEdge({ from: "", to: "", on: "success" });
              }}
            >
              Connect
            </button>
          </div>
          {draft.id && (
            <section className="wg-run" data-testid="graph-run-panel">
              <h4>Run</h4>
              {commands && commands.commands.length > 0 && (
                <div className="wg-commands" data-testid="command-preview">
                  <b>
                    These commands will run on this computer, with no model
                    call:
                  </b>
                  <ul>
                    {commands.commands.map((c) => (
                      <li key={c.nodeId}>
                        <code>{c.display}</code>
                        <br />
                        <small>
                          step {c.nodeId} · workspace {c.workspace ?? "none"} ·
                          timeout {c.timeoutMs} ms
                          {c.mutating ? " · changes files" : ""}
                          {c.shell ? " · via shell" : " · no shell"}
                        </small>
                      </li>
                    ))}
                  </ul>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />{" "}
                    I have reviewed these commands
                  </label>
                </div>
              )}
              <div className="row">
                <button
                  className="primary"
                  disabled={
                    dirty ||
                    !graphs.find((g) => g.id === draft.id)?.validation.ok ||
                    (!!commands?.commands.length && !confirmed)
                  }
                  onClick={() => void startRun()}
                  title={dirty ? "Save your changes first" : ""}
                >
                  Start run
                </button>
              </div>
              <ul className="wg-list" data-testid="run-list">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      className={run?.id === r.id ? "active" : ""}
                      onClick={() => void loadRun(r.id)}
                      data-testid="run-item"
                    >
                      {new Date(r.startedAt).toLocaleTimeString()} v
                      {r.graphVersion} <span className="badge">{r.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {run && run.graphId === draft.id && (
                <div data-testid="run-view" data-status={run.status}>
                  <div className="row between">
                    <span>
                      Run status:{" "}
                      <span
                        className={"badge wg-" + run.status}
                        data-testid="run-status"
                      >
                        {run.status}
                      </span>
                      {run.reason && <small> {run.reason}</small>}
                    </span>
                    {(run.status === "running" || run.status === "failed") && (
                      <button
                        onClick={() =>
                          void runAction(() =>
                            api(`/graph-runs/${run.id}/cancel`, "POST", {}),
                          )
                        }
                      >
                        Cancel run
                      </button>
                    )}
                  </div>
                  {run.attention.length > 0 && (
                    <ul className="wg-attention" data-testid="run-attention">
                      {run.attention.map((a, i) => (
                        <li key={i} data-kind={a.kind}>
                          {a.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  {run.nodes.map((n) => (
                    <div
                      key={n.id}
                      className="wg-node-state"
                      data-testid="run-node"
                      data-node={n.id}
                      data-state={n.status === "done" ? n.outcome : n.status}
                    >
                      <span>
                        <b>{n.id}</b>{" "}
                        <span className="badge">
                          {n.status === "done" ? n.outcome : n.status}
                        </span>
                        {n.waiting && <small> waiting: {n.waiting}</small>}
                        {n.display && (
                          <small>
                            {" "}
                            <code>{n.display}</code>
                          </small>
                        )}
                      </span>
                      {n.pendingInput && (
                        <div className="wg-ask" data-testid="human-input">
                          <b>{n.pendingInput.prompt}</b>
                          {n.pendingInput.allowText && (
                            <textarea
                              aria-label="Your answer"
                              value={answers[n.id] ?? ""}
                              onChange={(e) =>
                                setAnswers({
                                  ...answers,
                                  [n.id]: e.target.value,
                                })
                              }
                            />
                          )}
                          <div className="row">
                            {n.pendingInput.choices.map((c) => (
                              <button
                                key={c}
                                className="primary"
                                onClick={() =>
                                  void runAction(() =>
                                    api(
                                      `/graph-runs/${run.id}/nodes/${n.id}/answer`,
                                      "POST",
                                      {
                                        choice: c,
                                        text: answers[n.id] || undefined,
                                      },
                                    ),
                                  )
                                }
                              >
                                {c}
                              </button>
                            ))}
                            <button
                              onClick={() =>
                                void runAction(() =>
                                  api(
                                    `/graph-runs/${run.id}/nodes/${n.id}/answer`,
                                    "POST",
                                    { choice: null },
                                  ),
                                )
                              }
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                      )}
                      {n.effect?.state === "uncertain" && (
                        <small>
                          Outcome uncertain: decide in the Recovery panel
                          (effect {n.effect.id.slice(0, 8)}).
                        </small>
                      )}
                      {n.retryable && (
                        <button
                          onClick={() =>
                            void runAction(() =>
                              api(
                                `/graph-runs/${run.id}/nodes/${n.id}/retry`,
                                "POST",
                                {},
                              ),
                            )
                          }
                        >
                          Retry from this step
                        </button>
                      )}
                    </div>
                  ))}
                  <h4>Executed path</h4>
                  <ol className="wg-path" data-testid="graph-path">
                    {run.path.map((s) => (
                      <li
                        key={s.id}
                        data-testid="path-step"
                        data-node={s.nodeId}
                        data-outcome={s.outcome}
                      >
                        <b>{s.nodeId}</b>{" "}
                        <small>
                          {NODE_TYPE_LABEL[s.nodeType] ?? s.nodeType}
                        </small>{" "}
                        <span className={"badge wg-" + s.outcome}>
                          {s.outcome}
                        </span>
                        {s.branch && <small> → {s.branch}</small>}
                        {s.attempt > 1 && <small> attempt {s.attempt}</small>}
                        {s.visit > 1 && <small> visit {s.visit}</small>}
                        <br />
                        <small className="quiet">{s.reason}</small>
                        {s.fired.length > 0 && (
                          <small className="quiet">
                            {" "}
                            · then {s.fired.map((x) => x.to).join(", ")}
                          </small>
                        )}
                      </li>
                    ))}
                    {!run.path.length && (
                      <li className="quiet">Nothing has finished yet.</li>
                    )}
                  </ol>
                </div>
              )}
            </section>
          )}
        </section>
      )}
    </div>
  );
}
