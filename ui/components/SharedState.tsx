import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import "./shared-state.css";

type Who = {
  actor: { type: string; agentId?: string };
  taskId: string | null;
  runId: string | null;
  at: string;
  type: string;
} | null;
type Field = {
  key: string;
  kind: string;
  description: string;
  version: number;
  value: unknown;
  readers: string[];
  writers: string[];
  updatedBy: Who;
};
type Change = {
  version: number;
  type: string;
  value: unknown;
  cleared: boolean;
  agentId: string | null;
  actor: { type: string };
  taskId: string | null;
  runId: string | null;
  note: string;
  createdAt: string;
  checkpointId?: string;
};
type Validation = {
  id: string;
  effectiveStatus: string;
  kernelVersion: string | null;
};
type Artifact = {
  id: string;
  kind: string;
  title: string;
  description: string;
  source: { type: string; path?: string; size: number; sha256: string };
  readers: string[];
  validations: Validation[];
  unvalidated: boolean;
  createdAt: string;
  provenance: {
    agentId: string | null;
    taskId: string | null;
    runId: string | null;
    actor: { type: string };
    inputHashes: {
      task: string;
      dependencies: { taskId: string; resultHash: string }[];
      stateVersions: Record<string, number>;
    } | null;
  };
};
type Preview = {
  text: string;
  binary: boolean;
  truncated: boolean;
  size: number;
  bytesShown: number;
  modifiedSinceRegistration: boolean;
};

const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Read-only viewer for a workflow's typed shared state (current values, per-field permissions and the
 * immutable change history) and its artifact registry (preview and provenance). Renders nothing until the
 * workflow has a field or an artifact. Everything shown is data; values are rendered as plain text.
 */
export function WorkflowSharedState({ workflowId }: { workflowId: string }) {
  const [fields, setFields] = useState<Field[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<Record<string, Change[]>>({});
  const [previews, setPreviews] = useState<Record<string, Preview | string>>(
    {},
  );
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const load = useCallback(async () => {
    try {
      const [state, list, agents] = await Promise.all([
        api(`/workflows/${workflowId}/state`),
        api(`/workflows/${workflowId}/artifacts`),
        api("/agents"),
      ]);
      setFields(state.fields);
      setArtifacts([...list].reverse());
      setNames(
        Object.fromEntries(
          agents.map((a: { id: string; name: string }) => [a.id, a.name]),
        ),
      );
    } catch {
      /* backend restarting */
    }
  }, [workflowId]);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent((e) => {
      if (/^(state|artifact)[.]/.test(e.type)) void load();
    });
  }, [load]);
  if (!fields.length && !artifacts.length) return null;
  const who = (id: string | null | undefined) =>
    id ? (names[id] ?? id) : "user";
  const toggleHistory = async (key: string) => {
    const next = !open["h:" + key];
    setOpen({ ...open, ["h:" + key]: next });
    if (next)
      try {
        setHistory({
          ...history,
          [key]: await api(
            `/workflows/${workflowId}/state/fields/${key}/history`,
          ),
        });
      } catch (e) {
        setHistory({ ...history, [key]: [] });
      }
  };
  const showPreview = async (id: string) => {
    try {
      setPreviews({ ...previews, [id]: await api(`/artifacts/${id}/preview`) });
    } catch (e) {
      setPreviews({
        ...previews,
        [id]: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <section
      className="shared-panel"
      aria-label="Shared state and artifacts"
      data-testid="shared-panel"
    >
      <b>Shared state</b>
      {!fields.length && (
        <small className="quiet">No state fields defined.</small>
      )}
      {fields.map((f) => (
        <article key={f.key} className="shared-field" data-testid="state-field">
          <div className="row between">
            <span>
              <code>{f.key}</code> <span className="badge">{f.kind}</span>
            </span>
            <span className="quiet">
              version {f.version}
              {f.updatedBy
                ? ` · ${f.updatedBy.type} by ${who(f.updatedBy.actor.agentId)}`
                : " · not set"}
            </span>
          </div>
          {f.description && <small className="quiet">{f.description}</small>}
          <pre className="shared-value" data-testid="state-value">
            {f.version ? json(f.value) : "(not set)"}
          </pre>
          <small className="quiet">
            Read:{" "}
            {f.readers
              .map((r) => (r === "*" ? "everyone" : who(r)))
              .join(", ") || "user only"}{" "}
            · Write:{" "}
            {f.writers
              .map((r) => (r === "*" ? "everyone" : who(r)))
              .join(", ") || "user only"}
          </small>
          <button
            onClick={() => void toggleHistory(f.key)}
            aria-expanded={!!open["h:" + f.key]}
          >
            {open["h:" + f.key] ? "Hide history" : "History"}
          </button>
          {open["h:" + f.key] && (
            <ol className="shared-history" data-testid="state-history">
              {(history[f.key] ?? []).map((c) => (
                <li key={c.version}>
                  <b>v{c.version}</b> {c.type} by {who(c.agentId)}
                  {c.taskId
                    ? ` · task ${c.taskId.slice(0, 8)} · run ${c.runId?.split("#")[1] ?? "?"}`
                    : ""}{" "}
                  · {new Date(c.createdAt).toLocaleString()}
                  {c.note && <small className="quiet"> — {c.note}</small>}
                  <pre className="shared-value">
                    {c.cleared ? "(cleared)" : json(c.value)}
                  </pre>
                </li>
              ))}
            </ol>
          )}
        </article>
      ))}
      <b>Artifacts</b>
      {!artifacts.length && (
        <small className="quiet">No artifacts registered.</small>
      )}
      {artifacts.map((a) => {
        const p = previews[a.id];
        return (
          <article key={a.id} className="shared-field" data-testid="artifact">
            <div className="row between">
              <span>
                {a.title} <span className="badge">{a.kind}</span>
                {a.unvalidated && (
                  <span className="badge recovery-blocked">
                    no validation record
                  </span>
                )}
              </span>
              <span className="quiet">
                {a.source.type === "file" ? a.source.path : "inline"} ·{" "}
                {a.source.size} bytes
              </span>
            </div>
            <div className="row">
              <button onClick={() => void showPreview(a.id)}>Preview</button>
              <button
                onClick={() =>
                  setOpen({ ...open, ["p:" + a.id]: !open["p:" + a.id] })
                }
                aria-expanded={!!open["p:" + a.id]}
              >
                Provenance
              </button>
            </div>
            {open["p:" + a.id] && (
              <dl className="shared-prov" data-testid="artifact-provenance">
                <dt>Produced by</dt>
                <dd>
                  {a.provenance.agentId
                    ? who(a.provenance.agentId)
                    : a.provenance.actor.type}
                </dd>
                <dt>Task / run</dt>
                <dd>
                  {a.provenance.taskId ?? "none"} /{" "}
                  {a.provenance.runId ?? "none"}
                </dd>
                <dt>Content sha256</dt>
                <dd>{a.source.sha256}</dd>
                {a.provenance.inputHashes && (
                  <>
                    <dt>Task input hash</dt>
                    <dd>{a.provenance.inputHashes.task}</dd>
                    <dt>Dependencies</dt>
                    <dd>
                      {a.provenance.inputHashes.dependencies
                        .map(
                          (d) =>
                            `${d.taskId.slice(0, 8)}:${d.resultHash.slice(0, 12)}`,
                        )
                        .join(", ") || "none"}
                    </dd>
                    <dt>State versions</dt>
                    <dd>
                      {Object.entries(a.provenance.inputHashes.stateVersions)
                        .map(([k, v]) => `${k}@${v}`)
                        .join(", ") || "none"}
                    </dd>
                  </>
                )}
                <dt>Validation records</dt>
                <dd>
                  {a.validations.length
                    ? a.validations
                        .map(
                          (v) =>
                            `${v.id.slice(0, 8)} (${v.effectiveStatus}${v.kernelVersion ? ", kernel " + v.kernelVersion : ""})`,
                        )
                        .join("; ")
                    : "none"}
                </dd>
              </dl>
            )}
            {p !== undefined && (
              <pre className="shared-value" data-testid="artifact-preview">
                {typeof p === "string"
                  ? p
                  : p.binary
                    ? `(binary file, ${p.size} bytes)`
                    : p.text +
                      (p.truncated
                        ? `\n[preview truncated: ${p.bytesShown} of ${p.size} bytes]`
                        : "") +
                      (p.modifiedSinceRegistration
                        ? "\n[file changed since it was registered]"
                        : "")}
              </pre>
            )}
          </article>
        );
      })}
    </section>
  );
}
