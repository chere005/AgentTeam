import { useCallback, useEffect, useId, useState } from "react";
import { api, type Task } from "../api";
import "./task-settings.css";

/** States in which the backend accepts task edits (src/limits.ts setChecks, src/shared-state.ts setConfig). */
export const EDITABLE_TASK_STATES = [
  "queued",
  "failed",
  "interrupted",
  "blocked",
];
export const taskEditable = (status: string) =>
  EDITABLE_TASK_STATES.includes(status);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- pure form logic (unit-testable, no React) ------------------------------------------------
export type CheckDraft = {
  type:
    | "output-fields"
    | "output-matches"
    | "artifact-exists"
    | "artifact-matches"
    | "execution-verified"
    | "validation-gate";
  fields: string;
  pattern: string;
  flags: string;
  path: string;
  verification?: Extract<
    NonNullable<Task["completionChecks"]>[number],
    { type: "execution-verified" }
  >;
};
export const CHECK_TYPES: {
  type: CheckDraft["type"];
  label: string;
  help: string;
}[] = [
  {
    type: "output-fields",
    label: "Output has JSON fields",
    help: "The result must contain a JSON object (the whole text or a fenced block) with these keys, each non-empty.",
  },
  {
    type: "output-matches",
    label: "Output matches pattern",
    help: "The result must match this regular expression.",
  },
  {
    type: "artifact-exists",
    label: "File exists",
    help: "A file must exist at this path, relative to the agent's active workspace. Absolute paths and .. are rejected.",
  },
  {
    type: "artifact-matches",
    label: "File content matches pattern",
    help: "A UTF-8 text file of at most 256 KiB must match this regular expression. The path is relative to the task's working directory and must be inside its readable attached workspace and declared folders.",
  },
  {
    type: "validation-gate",
    label: "Validation gate passed",
    help: "A real Wolfram kernel validation must have passed for the task's current inputs. Needs the validation requirement below.",
  },
  {
    type: "execution-verified",
    label: "Program execution verified",
    help: "AgentTeam runs an immutable source snapshot in confinement and checks its complete output against the confirmed reference. Configure it on the prepared execution project.",
  },
];
export const emptyCheck = (
  type: CheckDraft["type"] = "output-fields",
): CheckDraft => ({
  type,
  fields: "",
  pattern: "",
  flags: "",
  path: "",
});
export function draftsFromChecks(
  checks: Task["completionChecks"],
): CheckDraft[] {
  return (checks ?? []).map((c) => ({
    ...emptyCheck(c.type),
    ...(c.type === "execution-verified" ? { verification: c } : {}),
    ...(c.type === "output-fields" ? { fields: c.fields.join(", ") } : {}),
    ...(c.type === "output-matches" || c.type === "artifact-matches"
      ? { pattern: c.pattern, flags: c.flags ?? "" }
      : {}),
    ...(c.type === "artifact-exists" || c.type === "artifact-matches"
      ? { path: c.path }
      : {}),
  }));
}
/** Client-side validation; the backend remains the authority. Throws a readable message. */
export function checksFromDrafts(drafts: CheckDraft[]) {
  if (drafts.length > 20) throw new Error("At most 20 checks per task");
  return drafts.map((d, i) => {
    const n = `Check ${i + 1}`;
    if (d.type === "execution-verified") {
      if (!d.verification)
        throw new Error(
          `${n}: configure program verification on the prepared execution project`,
        );
      return d.verification;
    }
    if (d.type === "output-fields") {
      const fields = [
        ...new Set(
          d.fields
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean),
        ),
      ];
      if (!fields.length)
        throw new Error(`${n}: list at least one field name, comma separated`);
      if (fields.length > 50) throw new Error(`${n}: at most 50 fields`);
      return { type: d.type, fields };
    }
    if (d.type === "artifact-exists" || d.type === "artifact-matches") {
      const path = d.path.trim();
      if (!path) throw new Error(`${n}: enter a file path`);
      if (path.length > 1000) throw new Error(`${n}: path is too long`);
      if (d.type === "artifact-exists") return { type: d.type, path };
    }
    if (d.type === "output-matches" || d.type === "artifact-matches") {
      if (!d.pattern) throw new Error(`${n}: enter a pattern`);
      if (d.pattern.length > 4096)
        throw new Error(`${n}: the pattern may have at most 4096 characters`);
      try {
        new RegExp(d.pattern, d.flags);
      } catch (e) {
        throw new Error(`${n}: not a valid regular expression (${message(e)})`);
      }
      return {
        type: d.type,
        ...(d.type === "artifact-matches" ? { path: d.path.trim() } : {}),
        pattern: d.pattern,
        flags: d.flags,
      };
    }
    return { type: d.type };
  });
}
export type PolicyDraft = {
  maxAttempts: string;
  backoffMs: string;
  backoffFactor: string;
  maxBackoffMs: string;
  auto: boolean;
};
export function policyFromDraft(d: PolicyDraft) {
  const whole = (raw: string, label: string, min: number, max: number) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`${label} must be a whole number from ${min} to ${max}`);
    return n;
  };
  const factor = Number(d.backoffFactor);
  if (
    d.backoffFactor.trim() === "" ||
    !Number.isFinite(factor) ||
    factor < 1 ||
    factor > 10
  )
    throw new Error("Backoff factor must be a number from 1 to 10");
  return {
    maxAttempts: whole(d.maxAttempts, "Maximum attempts", 1, 50),
    backoffMs: whole(d.backoffMs, "First backoff (ms)", 0, 3_600_000),
    backoffFactor: factor,
    maxBackoffMs: whole(d.maxBackoffMs, "Longest backoff (ms)", 0, 86_400_000),
    auto: d.auto,
  };
}

// ---- shared pieces ----------------------------------------------------------------------------
function Status({ error, saved }: { error: string; saved: string }) {
  return (
    <>
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
    </>
  );
}

/**
 * Per-task settings: validation requirement, completion checks, retry policy and shared-state
 * context. Sections load when the panel opens. Everything is locked while the backend would
 * refuse the edit (a running or finished task); backend errors are shown as returned.
 */
export function TaskSettings({
  task,
  tasks,
  act,
}: {
  task: Task;
  tasks: Task[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const editable = taskEditable(task.status);
  const finished = task.status === "completed" || task.status === "cancelled";
  return (
    <div className="task-settings" data-testid="task-settings">
      <button
        type="button"
        className="task-settings-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Task settings
      </button>
      {open && (
        <>
          {!editable && (
            <p className="hint" data-testid="task-locked">
              This task is {task.status}.{" "}
              {task.status === "running"
                ? "Validation, completion checks and shared-state settings cannot change while it runs; stop it or wait for it to finish."
                : "Its validation, completion-check and shared-state settings are final."}
            </p>
          )}
          <ValidationToggle task={task} editable={editable} act={act} />
          <CompletionChecksEditor task={task} editable={editable} act={act} />
          <RetryPolicyEditor task={task} editable={!finished} act={act} />
          <StateConfigEditor
            task={task}
            tasks={tasks}
            editable={editable}
            act={act}
          />
        </>
      )}
    </div>
  );
}

function ValidationToggle({
  task,
  editable,
  act,
}: {
  task: Task;
  editable: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const change = async (value: boolean) => {
    setError("");
    setSaved("");
    try {
      await api(`/tasks/${task.id}/requires-validation`, "PUT", {
        requiresValidation: value,
      });
      setSaved(
        value
          ? "Validation is now required before this task can run."
          : "Validation is no longer required.",
      );
      await act(async () => undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section className="task-section" aria-label="Validation requirement">
      <label className="inline">
        <input
          type="checkbox"
          data-testid="requires-validation"
          checked={!!task.requiresValidation}
          disabled={!editable}
          onChange={(e) => void change(e.target.checked)}
        />
        Requires Wolfram validation before it can run
      </label>
      <small className="quiet">
        The task stays queued until a real kernel run passes for its exact
        inputs.
      </small>
      <Status error={error} saved={saved} />
    </section>
  );
}

function CompletionChecksEditor({
  task,
  editable,
  act,
}: {
  task: Task;
  editable: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const id = useId();
  const [drafts, setDrafts] = useState<CheckDraft[]>(() =>
    draftsFromChecks(task.completionChecks),
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const set = (i: number, patch: Partial<CheckDraft>) =>
    setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const save = async () => {
    setError("");
    setSaved("");
    try {
      const checks = checksFromDrafts(drafts);
      await api(`/tasks/${task.id}/completion-checks`, "PUT", { checks });
      setSaved(
        checks.length
          ? `Saved ${checks.length} completion check${checks.length === 1 ? "" : "s"}.`
          : "Completion checks removed.",
      );
      await act(async () => undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section
      className="task-section"
      aria-label="Completion checks"
      data-testid="completion-checks"
    >
      <b>Completion checks</b>
      <p className="hint">
        Returned text alone is not success. When checks are set, the task
        completes only if every check passes against its exact result; a failed
        check fails the task and the reason is recorded. Required delegated work
        must also finish before the parent can complete.
      </p>
      {!drafts.length && <small className="quiet">No checks set.</small>}
      {drafts.map((d, i) => {
        const info = CHECK_TYPES.find((c) => c.type === d.type)!;
        return (
          <fieldset
            key={i}
            className="task-check"
            disabled={!editable}
            data-testid="check-row"
          >
            <legend>Check {i + 1}</legend>
            <label>
              Type
              <select
                value={d.type}
                onChange={(e) =>
                  set(i, { type: e.target.value as CheckDraft["type"] })
                }
              >
                {CHECK_TYPES.map((c) => (
                  <option key={c.type} value={c.type}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {d.type === "output-fields" && (
              <label>
                Field names (comma separated)
                <input
                  value={d.fields}
                  onChange={(e) => set(i, { fields: e.target.value })}
                  placeholder="summary, verdict"
                />
              </label>
            )}
            {(d.type === "output-matches" || d.type === "artifact-matches") && (
              <>
                <label>
                  Pattern (regular expression)
                  <input
                    value={d.pattern}
                    onChange={(e) => set(i, { pattern: e.target.value })}
                    placeholder="^DONE\b"
                  />
                </label>
                <div className="row" role="group" aria-label="Pattern flags">
                  {(
                    [
                      ["i", "ignore case"],
                      ["m", "multiline"],
                      ["s", "dot matches newline"],
                      ["u", "unicode"],
                    ] as const
                  ).map(([flag, label]) => (
                    <label className="inline" key={flag}>
                      <input
                        type="checkbox"
                        checked={d.flags.includes(flag)}
                        onChange={(e) =>
                          set(i, {
                            flags: e.target.checked
                              ? [...d.flags, flag].sort().join("")
                              : d.flags.replace(flag, ""),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </>
            )}
            {(d.type === "artifact-exists" ||
              d.type === "artifact-matches") && (
              <label>
                File path (relative to the workspace)
                <input
                  value={d.path}
                  onChange={(e) => set(i, { path: e.target.value })}
                  placeholder="reports/summary.md"
                />
              </label>
            )}
            {d.type === "validation-gate" && !task.requiresValidation && (
              <p className="limit-error" role="note">
                This check fails until the task requires validation (see the
                switch above).
              </p>
            )}
            <small className="quiet">{info.help}</small>
            <button
              type="button"
              onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
              aria-label={`Remove check ${i + 1}`}
            >
              Remove
            </button>
          </fieldset>
        );
      })}
      <div className="row">
        <button
          type="button"
          disabled={!editable || drafts.length >= 20}
          id={id + "-add"}
          onClick={() => setDrafts([...drafts, emptyCheck()])}
        >
          Add check
        </button>
        <button
          type="button"
          className="primary"
          disabled={!editable}
          onClick={() => void save()}
        >
          Save checks
        </button>
      </div>
      <Status error={error} saved={saved} />
    </section>
  );
}

type RecoveryView = { policy: Record<string, number | boolean> };
function RetryPolicyEditor({
  task,
  editable,
  act,
}: {
  task: Task;
  editable: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    try {
      const v: RecoveryView = await api(`/tasks/${task.id}/recovery`);
      const p = v.policy;
      setDraft({
        maxAttempts: String(p.maxAttempts),
        backoffMs: String(p.backoffMs),
        backoffFactor: String(p.backoffFactor),
        maxBackoffMs: String(p.maxBackoffMs),
        auto: !!p.auto,
      });
    } catch (e) {
      setError(message(e));
    }
  }, [task.id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!draft) return error ? <Status error={error} saved="" /> : null;
  const field = (
    key: keyof Omit<PolicyDraft, "auto">,
    label: string,
    hint?: string,
  ) => (
    <label>
      {label}
      <input
        inputMode="decimal"
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      />
      {hint && <small className="quiet">{hint}</small>}
    </label>
  );
  const save = async () => {
    setError("");
    setSaved("");
    try {
      await api(
        `/tasks/${task.id}/retry-policy`,
        "PUT",
        policyFromDraft(draft),
      );
      setSaved("Retry policy saved.");
      await load();
      await act(async () => undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section
      className="task-section"
      aria-label="Retry policy"
      data-testid="retry-policy"
    >
      <b>Retry policy</b>
      <p className="hint">
        Failed tasks wait for the backoff, then can be retried from their last
        checkpoint. Retries never repeat an effect whose outcome is uncertain,
        and they stop at the maximum number of attempts.
      </p>
      <fieldset className="task-grid" disabled={!editable}>
        {field("maxAttempts", "Maximum attempts", "1 to 50")}
        {field("backoffMs", "First backoff (ms)", "0 to 3,600,000")}
        {field(
          "backoffFactor",
          "Backoff factor",
          "1 to 10, applied per failure",
        )}
        {field("maxBackoffMs", "Longest backoff (ms)", "0 to 86,400,000")}
        <label className="inline">
          <input
            type="checkbox"
            checked={draft.auto}
            onChange={(e) => setDraft({ ...draft, auto: e.target.checked })}
          />
          Retry automatically after the backoff
        </label>
      </fieldset>
      <button
        type="button"
        className="primary"
        disabled={!editable}
        onClick={() => void save()}
      >
        Save retry policy
      </button>
      <Status error={error} saved={saved} />
    </section>
  );
}

type StateField = { key: string };
type ConfigView = {
  memory: "persisted" | "fresh";
  stateKeys?: string[];
  inputs?: { taskId: string; maxChars: number }[];
  includeArtifacts: boolean;
  maxContextChars: number;
  requiredWrites: string[];
};
export type StateDraft = {
  memory: "persisted" | "fresh";
  allFields: boolean;
  stateKeys: string[];
  allInputs: boolean;
  inputs: Record<string, string>; // taskId -> maxChars text; presence means selected
  includeArtifacts: boolean;
  maxContextChars: string;
  requiredWrites: string[];
};
export function draftFromConfig(c: ConfigView): StateDraft {
  return {
    memory: c.memory,
    allFields: !c.stateKeys,
    stateKeys: c.stateKeys ?? [],
    allInputs: !c.inputs,
    inputs: Object.fromEntries(
      (c.inputs ?? []).map((i) => [i.taskId, String(i.maxChars)]),
    ),
    includeArtifacts: c.includeArtifacts,
    maxContextChars: String(c.maxContextChars),
    requiredWrites: c.requiredWrites,
  };
}
export function configFromDraft(d: StateDraft) {
  const bounded = (raw: string, label: string, min: number, max: number) => {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(n) || n < min || n > max)
      throw new Error(`${label} must be a whole number from ${min} to ${max}`);
    return n;
  };
  return {
    memory: d.memory,
    ...(d.allFields ? {} : { stateKeys: d.stateKeys }),
    ...(d.allInputs
      ? {}
      : {
          inputs: Object.entries(d.inputs).map(([taskId, raw]) => ({
            taskId,
            maxChars: bounded(raw, "Per-input character cap", 200, 50_000),
          })),
        }),
    includeArtifacts: d.includeArtifacts,
    maxContextChars: bounded(
      d.maxContextChars,
      "Context budget",
      1000,
      100_000,
    ),
    requiredWrites: d.requiredWrites,
  };
}
const toggle = (list: string[], key: string, on: boolean) =>
  on ? [...new Set([...list, key])] : list.filter((k) => k !== key);

function StateConfigEditor({
  task,
  tasks,
  editable,
  act,
}: {
  task: Task;
  tasks: Task[];
  editable: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<StateDraft | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const load = useCallback(async () => {
    try {
      const [cfg, state] = await Promise.all([
        api(`/tasks/${task.id}/state-config`),
        api(`/workflows/${task.workflowId}/state`),
      ]);
      setDraft(draftFromConfig(cfg));
      setFields((state.fields as StateField[]).map((f) => f.key));
    } catch (e) {
      setError(message(e));
    }
  }, [task.id, task.workflowId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!draft) return error ? <Status error={error} saved="" /> : null;
  const deps = task.dependsOn
    .map((d) => tasks.find((t) => t.id === d))
    .filter((t): t is Task => !!t);
  const save = async () => {
    setError("");
    setSaved("");
    try {
      await api(
        `/tasks/${task.id}/state-config`,
        "PUT",
        configFromDraft(draft),
      );
      setSaved("State and context settings saved.");
      await load();
      await act(async () => undefined);
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <section
      className="task-section"
      aria-label="Shared state and context"
      data-testid="state-config"
    >
      <b>Shared state and context</b>
      <fieldset className="task-grid" disabled={!editable}>
        <legend className="quiet">What this task sees when it runs</legend>
        <label>
          Memory
          <select
            value={draft.memory}
            onChange={(e) =>
              setDraft({
                ...draft,
                memory: e.target.value as StateDraft["memory"],
              })
            }
          >
            <option value="persisted">
              Persisted: shared state, artifacts and workflow overview
            </option>
            <option value="fresh">
              Fresh: withhold them (recovery note is still given)
            </option>
          </select>
        </label>
        <fieldset className="task-sub">
          <legend>Shared-state fields shown</legend>
          <label className="inline">
            <input
              type="radio"
              name={task.id + "-fields"}
              checked={draft.allFields}
              onChange={() => setDraft({ ...draft, allFields: true })}
            />
            Every field the agent may read
          </label>
          <label className="inline">
            <input
              type="radio"
              name={task.id + "-fields"}
              checked={!draft.allFields}
              onChange={() => setDraft({ ...draft, allFields: false })}
            />
            Only the selected fields
          </label>
          {!draft.allFields &&
            (fields.length ? (
              fields.map((k) => (
                <label className="inline" key={k}>
                  <input
                    type="checkbox"
                    checked={draft.stateKeys.includes(k)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        stateKeys: toggle(draft.stateKeys, k, e.target.checked),
                      })
                    }
                  />
                  <code>{k}</code>
                </label>
              ))
            ) : (
              <small className="quiet">
                This workflow has no state fields yet.
              </small>
            ))}
        </fieldset>
        <fieldset className="task-sub">
          <legend>Dependency outputs passed in</legend>
          <label className="inline">
            <input
              type="radio"
              name={task.id + "-inputs"}
              checked={draft.allInputs}
              onChange={() => setDraft({ ...draft, allInputs: true })}
            />
            All dependencies, default cap
          </label>
          <label className="inline">
            <input
              type="radio"
              name={task.id + "-inputs"}
              checked={!draft.allInputs}
              onChange={() => setDraft({ ...draft, allInputs: false })}
            />
            Only the selected dependencies
          </label>
          {!draft.allInputs &&
            (deps.length ? (
              deps.map((t) => {
                const on = t.id in draft.inputs;
                return (
                  <div className="row" key={t.id}>
                    <label className="inline">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const next = { ...draft.inputs };
                          if (e.target.checked) next[t.id] = "8000";
                          else delete next[t.id];
                          setDraft({ ...draft, inputs: next });
                        }}
                      />
                      {t.title}
                    </label>
                    {on && (
                      <label className="inline">
                        Cap (characters)
                        <input
                          inputMode="numeric"
                          value={draft.inputs[t.id]}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              inputs: {
                                ...draft.inputs,
                                [t.id]: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                    )}
                  </div>
                );
              })
            ) : (
              <small className="quiet">This task has no dependencies.</small>
            ))}
        </fieldset>
        <label className="inline">
          <input
            type="checkbox"
            checked={draft.includeArtifacts}
            onChange={(e) =>
              setDraft({ ...draft, includeArtifacts: e.target.checked })
            }
          />
          Include registered artifacts
        </label>
        <label>
          Context budget (characters)
          <input
            inputMode="numeric"
            value={draft.maxContextChars}
            onChange={(e) =>
              setDraft({ ...draft, maxContextChars: e.target.value })
            }
          />
          <small className="quiet">1,000 to 100,000</small>
        </label>
        <fieldset className="task-sub">
          <legend>Fields this task must write</legend>
          <small className="quiet">
            The task fails with an actionable error if its structured output
            does not write each of these.
          </small>
          {fields.map((k) => (
            <label className="inline" key={k}>
              <input
                type="checkbox"
                checked={draft.requiredWrites.includes(k)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    requiredWrites: toggle(
                      draft.requiredWrites,
                      k,
                      e.target.checked,
                    ),
                  })
                }
              />
              <code>{k}</code>
            </label>
          ))}
          {!fields.length && (
            <small className="quiet">
              This workflow has no state fields yet.
            </small>
          )}
        </fieldset>
      </fieldset>
      <button
        type="button"
        className="primary"
        disabled={!editable}
        onClick={() => void save()}
      >
        Save state settings
      </button>
      <Status error={error} saved={saved} />
    </section>
  );
}
