import { useState } from "react";
import { api, type Agent, type Rule } from "../api";
import { SPECIALIST_PRESETS } from "../../src/roles";

export const splitList = (value: string) =>
  value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** Advisory vs mandatory, specialty and changed-file patterns for the rule form. */
export function RuleOptionsFields(p: {
  mode: string;
  setMode: (v: string) => void;
  specialty: string;
  setSpecialty: (v: string) => void;
  files: string;
  setFiles: (v: string) => void;
}) {
  return (
    <>
      <label>
        Routing strength
        <select
          value={p.mode}
          onChange={(e) => p.setMode(e.target.value)}
          data-testid="rule-mode"
        >
          <option value="advisory">Advisory: suggest this agent</option>
          <option value="mandatory">
            Mandatory: required review that blocks dependents
          </option>
        </select>
        <small data-testid="rule-mode-hint">
          {p.mode === "mandatory"
            ? "Dependent steps stay queued until this agent's review of the task passes with evidence. Prompt text and explicit recipients cannot satisfy it."
            : "Used for routing and optional consultation only; nothing waits for it."}
        </small>
      </label>
      <label>
        Specialty (optional)
        <input
          list="specialty-options"
          value={p.specialty}
          onChange={(e) => p.setSpecialty(e.target.value)}
          placeholder="accessibility, security, database…"
        />
        <datalist id="specialty-options">
          {SPECIALIST_PRESETS.map((s) => (
            <option key={s.specialty} value={s.specialty} />
          ))}
        </datalist>
        <small>
          Every matching specialty is invoked; rules inside one specialty
          compete by priority.
        </small>
      </label>
      <label>
        Changed files match (comma-separated globs)
        <input
          value={p.files}
          onChange={(e) => p.setFiles(e.target.value)}
          placeholder="**/migrations/**, **/*.tsx"
        />
      </label>
    </>
  );
}

export function RuleBadge({ rule }: { rule: Rule }) {
  const mandatory = (rule.mode ?? "advisory") === "mandatory";
  return (
    <span
      className={"badge " + (mandatory ? "badge-required" : "badge-advisory")}
      data-testid="rule-badge"
    >
      {mandatory ? "Required review" : "Advisory"}
      {rule.specialty ? " · " + rule.specialty : ""}
    </span>
  );
}

type Plan = {
  key: string;
  mode: string;
  specialty?: string;
  status: string;
  reason: string;
  winner?: { ruleId: string; targetId: string; priority: number };
  tied: { ruleId: string; targetId: string; priority: number }[];
  candidates: {
    ruleId: string;
    targetId: string;
    priority: number;
    allowed: boolean;
    denied?: string;
  }[];
};
/** Explains routing for a request: recipient decision, matched rules, ties and the winner. */
export function RoutingExplain({
  agents,
  from,
}: {
  agents: Agent[];
  from?: string;
}) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState(""),
    [out, setOut] = useState<any>(null),
    [error, setError] = useState("");
  const name = (id?: string | null) =>
    agents.find((a) => a.id === id)?.name ?? id ?? "none";
  return (
    <div data-testid="routing-explain">
      <label>
        Request text
        <input value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Changed files (comma-separated)
        <input value={files} onChange={(e) => setFiles(e.target.value)} />
      </label>
      <button
        disabled={!text.trim() && !files.trim()}
        onClick={() =>
          void api("/orchestration/preview", "POST", {
            text,
            changedFiles: splitList(files),
            ...(from ? { fromAgentId: from } : {}),
          })
            .then((r) => {
              setOut(r);
              setError("");
            })
            .catch((e) => setError(String(e)))
        }
      >
        Explain routing
      </button>
      {error && <p role="alert">{error}</p>}
      {out && (
        <div>
          {out.recipient && (
            <p data-testid="route-recipient">
              Recipient: {out.recipient.status}
              {out.recipient.agentId ? " · " + name(out.recipient.agentId) : ""}
              {out.recipient.method ? " (" + out.recipient.method + ")" : ""}
              {out.recipient.reason ? " · " + out.recipient.reason : ""}
            </p>
          )}
          {(out.specialists as Plan[]).map((s) => (
            <div key={s.key} className="rule" data-testid="specialist-plan">
              <div>
                <b>{s.specialty ?? "Required review"}</b>{" "}
                <span
                  className={
                    "badge " +
                    (s.mode === "mandatory"
                      ? "badge-required"
                      : "badge-advisory")
                  }
                >
                  {s.mode === "mandatory" ? "Required review" : "Advisory"}
                </span>
                <small>
                  {s.status === "tie"
                    ? "Tie: " +
                      s.tied
                        .map((t) => `${name(t.targetId)} (${t.priority})`)
                        .join(" vs ")
                    : s.status === "denied"
                      ? "Not usable"
                      : "Winner: " + name(s.winner?.targetId)}
                  {" · "}
                  {s.reason}
                </small>
                <small>
                  Candidates:{" "}
                  {s.candidates
                    .map(
                      (c) =>
                        `${name(c.targetId)} (priority ${c.priority}${c.allowed ? "" : ", " + c.denied})`,
                    )
                    .join("; ")}
                </small>
              </div>
            </div>
          ))}
          <small>{out.mandatoryNotice}</small>
        </div>
      )}
    </div>
  );
}
