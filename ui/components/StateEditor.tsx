import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import "./task-settings.css";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const KINDS = [
  ["decision", "Decision"],
  ["requirement", "Requirement"],
  ["output", "Output"],
  ["handoff", "Handoff"],
] as const;
const KEY = /^[a-z][a-z0-9-]{0,63}$/;

type AgentLite = { id: string; name: string };
type FieldLite = {
  key: string;
  kind: string;
  description: string;
  schema: unknown;
  readers: string[];
  writers: string[];
  version: number;
};
export type FieldDraft = {
  key: string;
  kind: string;
  description: string;
  schema: string;
  readers: string[];
  writers: string[];
  existing: boolean;
};
export const newFieldDraft = (): FieldDraft => ({
  key: "",
  kind: "decision",
  description: "",
  schema: "",
  readers: ["*"],
  writers: [],
  existing: false,
});
/** Client-side checks; the backend still validates schema shape, agent ids and limits. */
export function fieldBody(d: FieldDraft) {
  if (!KEY.test(d.key))
    throw new Error(
      "Field key: use lowercase letters, digits and - (start with a letter, max 64)",
    );
  if (d.description.length > 1000)
    throw new Error("Description may have at most 1000 characters");
  let schema: unknown = null;
  if (d.schema.trim()) {
    try {
      schema = JSON.parse(d.schema);
    } catch (e) {
      throw new Error(`Schema is not valid JSON (${message(e)})`);
    }
    if (typeof schema !== "object" || schema === null || Array.isArray(schema))
      throw new Error('Schema must be a JSON object such as {"type":"string"}');
  }
  return {
    kind: d.kind,
    description: d.description,
    schema,
    readers: d.readers,
    writers: d.writers,
  };
}

type Checkpoint = {
  id: string;
  seq: number;
  taskId: string;
  boundary: string;
  createdAt: string;
  data: { state?: { versions?: Record<string, number> } };
};
type Plan = {
  checkpointId: string;
  seq: number;
  steps: { key: string; from: number; to: number }[];
};

/**
 * Editors for a workflow's shared state: define or change a field (kind, schema, per-agent
 * readers/writers) and restore fields to a checkpoint after a preview. Restores append new
 * versions; history is never rewritten. The backend enforces every rule shown here.
 */
export function WorkflowStateEditor({
  workflowId,
  act,
}: {
  workflowId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [fields, setFields] = useState<FieldLite[]>([]);
  const [checkpoints, setCheckpoints] = useState<
    (Checkpoint & { title: string })[]
  >([]);
  const [draft, setDraft] = useState<FieldDraft | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [cp, setCp] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restored, setRestored] = useState("");
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try {
      const [ag, state, wf] = await Promise.all([
        api("/agents"),
        api(`/workflows/${workflowId}/state`),
        api(`/workflows/${workflowId}`),
      ]);
      setAgents(ag);
      setFields(state.fields);
      const lists = await Promise.all(
        (wf.tasks as { id: string; title: string }[]).map(async (t) =>
          ((await api(`/tasks/${t.id}/checkpoints`)) as Checkpoint[]).map(
            (c) => ({
              ...c,
              title: t.title,
            }),
          ),
        ),
      );
      setCheckpoints(
        lists
          .flat()
          .filter((c) => c.data?.state?.versions)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
    } catch {
      /* backend restarting */
    }
  }, [workflowId]);
  useEffect(() => {
    if (!open) return;
    void load();
    return window.agentteam?.onEvent((e) => {
      if (/^(state|checkpoint|task)[.]/.test(e.type)) void load();
    });
  }, [open, load]);
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const edit = (f: FieldLite) => {
    setSaved("");
    setError("");
    setDraft({
      key: f.key,
      kind: f.kind,
      description: f.description,
      schema: f.schema ? JSON.stringify(f.schema, null, 2) : "",
      readers: f.readers,
      writers: f.writers,
      existing: true,
    });
  };
  const perm = (list: "readers" | "writers", id: string, on: boolean) =>
    draft &&
    setDraft({
      ...draft,
      [list]: on
        ? [...new Set([...draft[list], id])]
        : draft[list].filter((x) => x !== id),
    });
  const save = async () => {
    if (!draft) return;
    setError("");
    setSaved("");
    try {
      await api(
        `/workflows/${workflowId}/state/fields/${draft.key}`,
        "PUT",
        fieldBody(draft),
      );
      setSaved(`Field ${draft.key} saved.`);
      setDraft(null);
      await load();
      await act(async () => undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  const preview = async () => {
    setRestoreError("");
    setRestored("");
    setPlan(null);
    try {
      setPlan(
        await api(
          `/workflows/${workflowId}/state/restore-preview?checkpointId=${encodeURIComponent(cp)}`,
        ),
      );
    } catch (e) {
      setRestoreError(message(e));
    }
  };
  const restore = async () => {
    if (!plan) return;
    setRestoreError("");
    try {
      const r = await api(`/workflows/${workflowId}/state/restore`, "POST", {
        checkpointId: plan.checkpointId,
        // Reject if any field moved since the preview was shown.
        expectedVersions: Object.fromEntries(
          plan.steps.map((s) => [s.key, s.from]),
        ),
      });
      setRestored(
        r.restored.length
          ? `Restored ${r.restored.map((c: { key: string }) => c.key).join(", ")}; history was kept.`
          : "Nothing needed to change.",
      );
      setPlan(null);
      await load();
      await act(async () => undefined);
    } catch (e) {
      setRestoreError(message(e));
    }
  };
  return (
    <details
      className="task-settings state-editor"
      data-testid="state-editor"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Edit shared state</summary>
      {open && (
        <>
          <section className="task-section" aria-label="State fields">
            <b>Fields</b>
            {!fields.length && !draft && (
              <small className="quiet">No state fields defined.</small>
            )}
            {fields.map((f) => (
              <div className="row between" key={f.key}>
                <span>
                  <code>{f.key}</code> <span className="badge">{f.kind}</span>{" "}
                  <small className="quiet">
                    read:{" "}
                    {f.readers
                      .map((r) => (r === "*" ? "everyone" : name(r)))
                      .join(", ") || "user only"}{" "}
                    · write:{" "}
                    {f.writers
                      .map((r) => (r === "*" ? "everyone" : name(r)))
                      .join(", ") || "user only"}
                  </small>
                </span>
                <button
                  type="button"
                  aria-label={`Edit field ${f.key}`}
                  onClick={() => edit(f)}
                >
                  Edit
                </button>
              </div>
            ))}
            {!draft && (
              <button
                type="button"
                onClick={() => {
                  setSaved("");
                  setError("");
                  setDraft(newFieldDraft());
                }}
              >
                Define field
              </button>
            )}
            {draft && (
              <form
                className="task-grid"
                data-testid="field-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label>
                  Key
                  <input
                    value={draft.key}
                    readOnly={draft.existing}
                    onChange={(e) =>
                      setDraft({ ...draft, key: e.target.value })
                    }
                    placeholder="decision-api"
                  />
                  <small className="quiet">
                    Lowercase letters, digits and -
                  </small>
                </label>
                <label>
                  Kind
                  <select
                    value={draft.kind}
                    onChange={(e) =>
                      setDraft({ ...draft, kind: e.target.value })
                    }
                  >
                    {KINDS.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Description
                  <input
                    value={draft.description}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                <label>
                  Value schema (JSON, optional)
                  <textarea
                    rows={4}
                    value={draft.schema}
                    onChange={(e) =>
                      setDraft({ ...draft, schema: e.target.value })
                    }
                    placeholder='Empty uses the built-in schema for the kind, e.g. {"type":"string","maxLength":200}'
                  />
                </label>
                <fieldset className="task-sub">
                  <legend>Who may read and write this field</legend>
                  <table className="perm-table">
                    <thead>
                      <tr>
                        <th scope="col">Agent</th>
                        <th scope="col">Read</th>
                        <th scope="col">Write</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[{ id: "*", name: "Everyone" }, ...agents].map((a) => (
                        <tr key={a.id}>
                          <th scope="row">{a.name}</th>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`${a.name} can read`}
                              checked={draft.readers.includes(a.id)}
                              onChange={(e) =>
                                perm("readers", a.id, e.target.checked)
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`${a.name} can write`}
                              checked={draft.writers.includes(a.id)}
                              onChange={(e) =>
                                perm("writers", a.id, e.target.checked)
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <small className="quiet">
                    You can always read and write from here; agents need the
                    permission to touch the field during a run.
                  </small>
                </fieldset>
                <div className="row">
                  <button type="submit" className="primary">
                    Save field
                  </button>
                  <button type="button" onClick={() => setDraft(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {error && (
              <p className="limit-error" role="alert">
                {error}
              </p>
            )}
            {saved && !error && (
              <p className="task-saved" role="status">
                {saved}
              </p>
            )}
          </section>
          <section
            className="task-section"
            aria-label="Restore shared state"
            data-testid="state-restore"
          >
            <b>Restore to checkpoint</b>
            <p className="hint">
              Preview first. Restoring appends new versions that bring fields
              back to the checkpoint; earlier history is kept, and the restore
              is refused if a field changed after the preview.
            </p>
            {checkpoints.length ? (
              <>
                <label>
                  Checkpoint
                  <select
                    value={cp}
                    onChange={(e) => {
                      setCp(e.target.value);
                      setPlan(null);
                      setRestored("");
                      setRestoreError("");
                    }}
                  >
                    <option value="">Select a checkpoint</option>
                    {checkpoints.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title} · #{c.seq} {c.boundary} ·{" "}
                        {new Date(c.createdAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={!cp}
                  onClick={() => void preview()}
                >
                  Preview restore
                </button>
              </>
            ) : (
              <small className="quiet">
                No checkpoint with recorded state yet. Checkpoints appear as
                tasks run.
              </small>
            )}
            {plan && (
              <div data-testid="restore-plan">
                {plan.steps.length ? (
                  <>
                    <ul>
                      {plan.steps.map((s) => (
                        <li key={s.key}>
                          <code>{s.key}</code>: version {s.from} becomes the
                          content of version {s.to}
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void restore()}
                    >
                      Restore {plan.steps.length} field
                      {plan.steps.length === 1 ? "" : "s"}
                    </button>
                  </>
                ) : (
                  <p>Shared state already matches this checkpoint.</p>
                )}
              </div>
            )}
            {restoreError && (
              <p className="limit-error" role="alert">
                {restoreError}
              </p>
            )}
            {restored && !restoreError && (
              <p className="task-saved" role="status">
                {restored}
              </p>
            )}
          </section>
        </>
      )}
    </details>
  );
}
