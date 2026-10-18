import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Markdown } from "./Markdown";
import "./pipeline.css";

export const PIPELINE_SAMPLE_ID = "plan-implement-review-pipeline";
type Note = {
  id: string;
  taskId: string;
  label: string;
  seq: number;
  outcome: string;
  markdown: string;
  sha256: string;
  intact: boolean;
  createdAt: string;
  prevNoteId: string | null;
  provenance: { agentName: string; model: string; effort: string | null };
  inputs: {
    taskId: string;
    title: string;
    resultHash: string;
    noteId: string | null;
  }[];
};
type View = {
  paused: boolean;
  config: {
    isolation: string;
    implementationWorkers: number;
    fixWorkers: number;
  };
  stage2: { state: string; error?: string };
  preflight: null | {
    verified: boolean;
    checkedAt: string;
    checks: { name: string; ok: boolean; detail: string }[];
    warnings: string[];
  };
  stages: {
    taskId: string;
    label: string;
    status: string;
    waitReason: string | null;
    agent: string;
  }[];
  notes: Note[];
};

/** Preflight (Prepare and verify), stage list and the scrollable, append-only handoff history. */
export function PipelineHistory({
  workflowId,
  act,
}: {
  workflowId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<View | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const refs = useRef(new Map<string, HTMLDetailsElement>());
  const load = useCallback(async () => {
    try {
      setView(await api("/pipelines/" + workflowId + "/history"));
    } catch {
      /* workflow may have been deleted */
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (
        e.type.startsWith("handoff.") ||
        e.type.startsWith("pipeline.") ||
        e.type.startsWith("task.") ||
        e.type.startsWith("workflow.")
      )
        void load();
    });
  }, [load]);
  const jump = (id: string) => {
    setFocus(id);
    const el = refs.current.get(id);
    if (el) {
      el.open = true;
      el.scrollIntoView?.({ block: "nearest" });
    }
  };
  if (!view) return null;
  const p = view.preflight;
  return (
    <div className="pipeline-panel" aria-label="Pipeline">
      <div className="row between">
        <h4>
          Pipeline: {view.config.implementationWorkers} implementation +{" "}
          {view.config.fixWorkers} fix workers, {view.config.isolation}{" "}
          isolation
        </h4>
        <span
          className={"badge gate-badge " + (p?.verified ? "open" : "closed")}
        >
          {p?.verified ? "verified" : "not verified"}
        </span>
      </div>
      <button
        onClick={() =>
          void act(async () => {
            setError("");
            try {
              await api("/pipelines/" + workflowId + "/prepare", "POST");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
            await load();
          })
        }
      >
        Prepare and verify
      </button>
      {error && (
        <p className="blocker" role="alert">
          {error}
        </p>
      )}
      {p ? (
        <ul className="pipeline-checks" aria-label="Preflight checks">
          {p.checks.map((c) => (
            <li key={c.name} className={c.ok ? "good" : "bad"}>
              {c.ok ? "ok" : "blocked"}: {c.name} ({c.detail})
            </li>
          ))}
          {p.warnings.map((w) => (
            <li key={w}>Note: {w}</li>
          ))}
        </ul>
      ) : (
        <p className="quiet">
          Not verified yet: resume stays refused until provider availability,
          models, caps and parallel resource access were checked.
        </p>
      )}
      {view.stage2.state === "failed" && (
        <p className="blocker">
          Fix-worker assignment failed: {view.stage2.error}{" "}
          <button
            onClick={() =>
              void act(() =>
                api("/pipelines/" + workflowId + "/stage2", "POST"),
              )
            }
          >
            Retry assignment
          </button>
        </p>
      )}
      <ol className="pipeline-stages" aria-label="Pipeline stages">
        {view.stages.map((s) => (
          <li key={s.taskId}>
            {s.label} ({s.agent}): {s.status}
            {s.waitReason ? `, waiting: ${s.waitReason}` : ""}
          </li>
        ))}
      </ol>
      <h4>Workflow history (append-only handoff notes)</h4>
      <div
        className="pipeline-history"
        role="log"
        aria-label="Workflow history"
        tabIndex={0}
      >
        {!view.notes.length && (
          <span className="quiet">
            No attempt has finished yet. Each stage attempt appends one
            immutable note; a retry never replaces an earlier one.
          </span>
        )}
        {view.notes.map((n) => (
          <details
            key={n.id}
            id={"note-" + n.id}
            data-testid="handoff-note"
            className={"pipeline-note" + (focus === n.id ? " focus" : "")}
            ref={(el) => {
              if (el) refs.current.set(n.id, el);
              else refs.current.delete(n.id);
            }}
          >
            <summary>
              {n.label}, attempt {n.seq}: {n.outcome} ({n.provenance.agentName},{" "}
              {n.provenance.model}){n.intact ? "" : " [content hash mismatch]"}
            </summary>
            <div className="inputs" aria-label="Inputs consumed">
              <span className="quiet">Inputs consumed:</span>
              {n.inputs.length ? (
                n.inputs.map((i) =>
                  i.noteId ? (
                    <button
                      key={i.taskId}
                      onClick={() => jump(i.noteId!)}
                      title={"result " + i.resultHash}
                    >
                      {i.title} ({i.noteId})
                    </button>
                  ) : (
                    <span key={i.taskId}>{i.title} (no note)</span>
                  ),
                )
              ) : (
                <span>none</span>
              )}
            </div>
            <div className="md">
              <Markdown text={n.markdown} />
            </div>
            <span className="quiet">
              sha256 {n.sha256.slice(0, 16)}
              {n.prevNoteId ? ` · previous attempt ${n.prevNoteId}` : ""}
            </span>
          </details>
        ))}
      </div>
    </div>
  );
}
