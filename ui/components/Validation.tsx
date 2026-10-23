import { useCallback, useEffect, useState } from "react";
import { api, type Task, type WorkflowSetup } from "../api";
import { Markdown } from "./Markdown";
import "./validation.css";

type Assertion = { name: string; passed: boolean; detail?: string };
export type GateView = {
  required: boolean;
  open: boolean;
  reason: string;
  inputHash: string;
  latestRecordId: string | null;
  attemptsUsed: number;
  maxAttempts: number;
};
export type RecordView = {
  id: string;
  attempt: number;
  inputHash: string;
  sourceHash: string;
  status: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
  assertions: Assertion[];
  kernel: null | {
    version: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  };
  spec: {
    claim: string;
    assumptions: string[];
    domains: string[];
    units?: string;
    derivation: string;
    source: string;
    inputs: Record<string, string>;
    evidenceKind: "symbolic-proof" | "numerical-evidence";
    tolerance?: { absolute?: number; relative?: number; precision?: number };
  };
};
type ActiveRun = { runId: string; taskId: string; state: string };
type View = { gate: GateView; records: RecordView[]; active: ActiveRun[] };

export const MAX_PARALLEL_VALIDATIONS = 2;
const REASONS: Record<string, string> = {
  "not-required": "Validation not required",
  pass: "Validated for the current inputs",
  missing: "Blocked: no validation record yet",
  failed: "Blocked: the latest validation failed",
  inconclusive: "Blocked: the latest validation was inconclusive",
  cancelled: "Blocked: the latest validation run was cancelled",
  stale: "Blocked: evidence is stale (inputs changed since it passed)",
  "attempts-exhausted":
    "Blocked: validation attempts exhausted; change the inputs or escalate to a human",
};
export const gateText = (reason: string) => REASONS[reason] ?? reason;

/** Loads a task's gate, records and active runs; refreshes on validation events. */
export function useValidation(taskId: string) {
  const [view, setView] = useState<View | null>(null);
  const load = useCallback(async () => {
    try {
      setView(await api("/tasks/" + taskId + "/validations"));
    } catch {
      /* task may have been deleted */
    }
  }, [taskId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (e.type.startsWith("validation.") || e.type.startsWith("task."))
        void load();
    });
  }, [load]);
  return { view, reload: load };
}

export function GateBadge({ task }: { task: Task }) {
  const { view } = useValidation(task.id);
  if (!task.requiresValidation) return null;
  const open = !!view?.gate.open;
  return (
    <span
      className={"badge gate-badge " + (open ? "open" : "closed")}
      title={view ? gateText(view.gate.reason) : "Loading gate"}
    >
      {open ? "validated" : (view?.gate.reason ?? "gate")}
    </span>
  );
}

/** One line per validation-required task: gate state and blocker. */
export function WorkflowGateSummary({ tasks }: { tasks: Task[] }) {
  const required = tasks.filter((t) => t.requiresValidation);
  if (!required.length) return null;
  return (
    <div className="gate-summary" aria-label="Validation gates">
      <b>Validation gates</b>
      {required.map((t) => (
        <GateLine key={t.id} task={t} />
      ))}
    </div>
  );
}
function GateLine({ task }: { task: Task }) {
  const { view } = useValidation(task.id);
  return (
    <div className="row between" data-testid="gate-line">
      <span>{task.title}</span>
      <span className="quiet">
        {view ? gateText(view.gate.reason) : "Loading…"}
        {view &&
          ` (${view.gate.attemptsUsed}/${view.gate.maxAttempts} attempts)`}
      </span>
    </div>
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const num = (s: string) => (s.trim() ? Number(s) : undefined);

export function TaskValidation({
  task,
  liveExecution,
  act,
}: {
  task: Task;
  liveExecution: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const { view, reload } = useValidation(task.id);
  const [f, setF] = useState({
    claim: "",
    assumptions: "",
    domains: "",
    units: "",
    derivation: "",
    source: "",
    inputs: "",
    kind: "symbolic-proof",
    absolute: "",
    relative: "",
    precision: "",
  });
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  if (!task.requiresValidation || !view) return null;
  const { gate, records, active } = view;
  const busy = active.length > 0;
  const exhausted = gate.attemptsUsed >= gate.maxAttempts;
  const submit = () =>
    act(async () => {
      const inputs: Record<string, string> = {};
      for (const l of lines(f.inputs)) {
        const i = l.indexOf("=");
        if (i > 0) inputs[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      const tolerance = {
        ...(num(f.absolute) ? { absolute: num(f.absolute) } : {}),
        ...(num(f.relative) ? { relative: num(f.relative) } : {}),
        ...(num(f.precision) ? { precision: num(f.precision) } : {}),
      };
      await api("/tasks/" + task.id + "/validations", "POST", {
        claim: f.claim,
        assumptions: lines(f.assumptions),
        domains: lines(f.domains),
        ...(f.units.trim() ? { units: f.units.trim() } : {}),
        derivation: f.derivation,
        source: f.source,
        inputs,
        evidenceKind: f.kind,
        ...(Object.keys(tolerance).length ? { tolerance } : {}),
      });
      await reload();
    });
  return (
    <section className="validation-panel" aria-label="Validation panel">
      <div className="row between">
        <h4>Validation</h4>
        <span className={"badge gate-badge " + (gate.open ? "open" : "closed")}>
          {gate.open ? "gate open" : "gate closed"}
        </span>
      </div>
      <p className={gate.open ? "hint" : "blocker"} data-testid="gate-reason">
        {gateText(gate.reason)}
      </p>
      <div className="cap" data-testid="validation-caps">
        Attempts for these inputs: {gate.attemptsUsed} / {gate.maxAttempts} ·
        Wolfram runs: at most {MAX_PARALLEL_VALIDATIONS} at a time (
        {active.length} for this task)
      </div>
      {active.map((r) => (
        <div className="row between" key={r.runId}>
          <span>Run {r.state}</span>
          <button
            onClick={() =>
              void act(async () => {
                await api("/validations/runs/" + r.runId + "/cancel", "POST");
                await reload();
              })
            }
          >
            Cancel run
          </button>
        </div>
      ))}
      <form
        className="validation-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          Claim
          <input
            required
            value={f.claim}
            onChange={(e) => set("claim", e.target.value)}
          />
        </label>
        <label>
          Assumptions (one per line)
          <textarea
            value={f.assumptions}
            onChange={(e) => set("assumptions", e.target.value)}
          />
        </label>
        <label>
          Domains (one per line)
          <textarea
            value={f.domains}
            onChange={(e) => set("domains", e.target.value)}
          />
        </label>
        <label>
          Units
          <input
            value={f.units}
            onChange={(e) => set("units", e.target.value)}
          />
        </label>
        <label>
          Derivation notes (Markdown)
          <textarea
            value={f.derivation}
            onChange={(e) => set("derivation", e.target.value)}
          />
        </label>
        <label>
          Inputs (name=value per line)
          <textarea
            value={f.inputs}
            onChange={(e) => set("inputs", e.target.value)}
          />
        </label>
        <label>
          Wolfram Language source (.wl)
          <textarea
            required
            value={f.source}
            onChange={(e) => set("source", e.target.value)}
          />
        </label>
        <label>
          Evidence kind
          <select value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            <option value="symbolic-proof">Symbolic proof</option>
            <option value="numerical-evidence">Numerical evidence</option>
          </select>
        </label>
        {f.kind === "numerical-evidence" && (
          <div className="row">
            <label>
              Absolute tolerance
              <input
                value={f.absolute}
                onChange={(e) => set("absolute", e.target.value)}
              />
            </label>
            <label>
              Relative tolerance
              <input
                value={f.relative}
                onChange={(e) => set("relative", e.target.value)}
              />
            </label>
            <label>
              Precision
              <input
                value={f.precision}
                onChange={(e) => set("precision", e.target.value)}
              />
            </label>
          </div>
        )}
        {!liveExecution && (
          <small className="blocker">
            Live execution is off; enable it to run a Wolfram validation.
          </small>
        )}
        <button
          className="primary"
          disabled={!liveExecution || busy || exhausted}
          title={
            exhausted
              ? "Attempts exhausted for these inputs"
              : busy
                ? "A validation run is already active for this task"
                : ""
          }
        >
          Start validation run
        </button>
      </form>
      <h4>Records and attempts ({records.length})</h4>
      {!records.length && <small className="quiet">No records yet.</small>}
      {[...records].reverse().map((r) => (
        <article
          className="validation-record"
          id={"validation-" + r.id}
          key={r.id}
          data-testid="validation-record"
        >
          <div className="row between">
            <b>
              Attempt {r.attempt}: {r.spec.claim}
            </b>
            <span className={"badge status-" + r.status}>{r.status}</span>
          </div>
          <dl>
            <dt>Reason</dt>
            <dd>{r.reason}</dd>
            <dt>Evidence</dt>
            <dd>
              {r.spec.evidenceKind === "symbolic-proof"
                ? "Symbolic proof"
                : "Numerical evidence"}
            </dd>
            <dt>Kernel</dt>
            <dd>{r.kernel?.version || "no kernel result"}</dd>
            <dt>Assumptions</dt>
            <dd>{r.spec.assumptions.join("; ") || "none stated"}</dd>
            <dt>Domains</dt>
            <dd>{r.spec.domains.join("; ") || "none stated"}</dd>
            {r.spec.units && (
              <>
                <dt>Units</dt>
                <dd>{r.spec.units}</dd>
              </>
            )}
            {r.spec.tolerance && (
              <>
                <dt>Tolerance</dt>
                <dd>
                  {Object.entries(r.spec.tolerance)
                    .map(([k, v]) => `${k} ${v}`)
                    .join(", ")}
                </dd>
              </>
            )}
            <dt>Inputs</dt>
            <dd>
              {Object.entries(r.spec.inputs)
                .map(([k, v]) => `${k} = ${v}`)
                .join("; ") || "none"}
            </dd>
            <dt>Assertions</dt>
            <dd>
              {r.assertions.length
                ? r.assertions
                    .map((a) => `${a.passed ? "✓" : "✗"} ${a.name}`)
                    .join("; ")
                : "none reported"}
            </dd>
          </dl>
          <details>
            <summary>Wolfram Language source</summary>
            <pre>{r.spec.source}</pre>
          </details>
          <details>
            <summary>Kernel output</summary>
            <pre>{r.kernel?.stdout || "(none)"}</pre>
          </details>
          {r.spec.derivation.trim() && (
            <div className="validation-notes" tabIndex={0} aria-label="Notes">
              <Markdown text={r.spec.derivation} />
            </div>
          )}
        </article>
      ))}
    </section>
  );
}

/** Sample setup: model-mapping verification that must pass before the workflow can resume. */
export function SampleSetup({
  workflow,
  act,
}: {
  workflow: { id: string; setup?: WorkflowSetup };
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const setup = workflow.setup;
  if (!setup?.requiresModelVerification) return null;
  const c = setup.modelCheck;
  return (
    <div className="gate-summary" aria-label="Model mapping">
      <div className="row between">
        <b>Model mapping</b>
        <span
          className={"badge gate-badge " + (c.verified ? "open" : "closed")}
        >
          {c.verified ? "verified" : "not verified"}
        </span>
        <span className="quiet">
          {setup.intendedLead} lead · {c.resolved.length}{" "}
          {c.resolved.length === 1 ? "agent" : "agents"}
        </span>
      </div>
      {!c.verified &&
        c.issues.map((i) => (
          <span className="blocker" key={i}>
            {i}
          </span>
        ))}
      {!c.verified && (
        <button
          onClick={() =>
            void act(() =>
              api(
                "/samples/workflows/" + workflow.id + "/verify-models",
                "POST",
              ),
            )
          }
        >
          Verify models
        </button>
      )}
      <details className="model-mapping-details" open={!c.verified}>
        <summary>
          Model details
          {(c.warnings ?? []).length > 0 &&
            ` · ${(c.warnings ?? []).length} note${(c.warnings ?? []).length === 1 ? "" : "s"}`}
        </summary>
        {c.resolved.map((r) => (
          <span className="quiet" key={r.name}>
            {r.name}: {r.model}
            {r.modelName ? ` (${r.modelName})` : ""}
          </span>
        ))}
        {(c.warnings ?? []).map((w) => (
          <span className="hint" key={w}>
            Note: {w}
          </span>
        ))}
        {c.verified && (
          <button
            onClick={() =>
              void act(() =>
                api(
                  "/samples/workflows/" + workflow.id + "/verify-models",
                  "POST",
                ),
              )
            }
          >
            Verify models again
          </button>
        )}
      </details>
    </div>
  );
}
