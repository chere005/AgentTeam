import { useState } from "react";
import { api, type Agent, type Rule } from "../api";
import { RuleOptionsFields, splitList } from "./RuleOptions";
import { agentSelectorLabel } from "../agent-identity";
import "./task-settings.css";

/** Edit button and inline form for an existing routing rule (PUT /rules/:id). */
export function RuleEditor({
  rule,
  agents,
  act,
}: {
  rule: Rule;
  agents: Agent[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<string>(rule.mode ?? "advisory");
  const [specialty, setSpecialty] = useState(rule.specialty ?? "");
  const [files, setFiles] = useState(rule.match.changedFilesAny.join(", "));
  const [text, setText] = useState(rule.match.textIncludes.join(", "));
  const [priority, setPriority] = useState(String(rule.priority));
  const [target, setTarget] = useState(rule.targetId ?? "");
  const [enabled, setEnabled] = useState(rule.enabled !== false);
  const [error, setError] = useState("");
  const begin = () => {
    setMode(rule.mode ?? "advisory");
    setSpecialty(rule.specialty ?? "");
    setFiles(rule.match.changedFilesAny.join(", "));
    setText(rule.match.textIncludes.join(", "));
    setPriority(String(rule.priority));
    setTarget(rule.targetId ?? "");
    setEnabled(rule.enabled !== false);
    setError("");
    setOpen(true);
  };
  const save = async () => {
    setError("");
    const p = Number(priority);
    if (priority.trim() === "" || !Number.isInteger(p) || p < 0 || p > 10000)
      return setError("Priority must be a whole number from 0 to 10000");
    if (rule.scope === "action" && !target)
      return setError("Choose the agent to invoke");
    const textIncludes = splitList(text),
      changedFilesAny = splitList(files);
    try {
      await api("/rules/" + rule.id, "PUT", {
        agentId: rule.agentId,
        scope: rule.scope,
        ...(rule.scope === "action" ? { targetId: target } : {}),
        priority: p,
        enabled,
        mode,
        ...(specialty.trim() ? { specialty: specialty.trim() } : {}),
        match: {
          textIncludes,
          tagsAny: rule.match.tagsAny ?? [],
          changedFilesAny,
          catchAll:
            !textIncludes.length &&
            !changedFilesAny.length &&
            !(rule.match.tagsAny ?? []).length,
        },
        kind:
          mode === "mandatory"
            ? "review"
            : rule.kind === "review"
              ? "delegate"
              : (rule.kind ?? "delegate"),
      });
      setOpen(false);
      await act(async () => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (!open)
    return (
      <button
        type="button"
        onClick={begin}
        aria-label={`Edit rule ${agents.find((a) => a.id === rule.agentId)?.name ?? ""} ${rule.id.slice(0, 6)}`}
      >
        Edit
      </button>
    );
  return (
    <form
      className="form-card"
      data-testid="rule-edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {rule.scope === "action" && (
        <label>
          Invoke
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Select agent</option>
            {agents
              .filter((a) => a.id !== rule.agentId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {agentSelectorLabel(a)}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        Text contains (comma-separated)
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <RuleOptionsFields
        mode={mode}
        setMode={setMode}
        specialty={specialty}
        setSpecialty={setSpecialty}
        files={files}
        setFiles={setFiles}
      />
      <label>
        Priority (highest wins)
        <input
          inputMode="numeric"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Rule enabled
      </label>
      {error && (
        <p className="limit-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button type="submit" className="primary">
          Save changes
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
