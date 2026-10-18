import { useState } from "react";
import { api } from "../api";

export function WorktreeSetup({
  agentId,
  workspace,
}: {
  agentId: string;
  workspace: string;
}) {
  const [branch, setBranch] = useState(
    "agentteam/work-" + Date.now().toString(36),
  );
  const [base, setBase] = useState("HEAD"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <details className="section">
      <summary>Create isolated worktree</summary>
      <p className="hint">
        Creates a fresh checkout from committed history. It becomes this agent’s
        active folder and replaces its access to the source repository.
        Uncommitted changes stay in the source.
      </p>
      <label>
        New branch
        <input value={branch} onChange={(e) => setBranch(e.target.value)} />
      </label>
      <label>
        Base revision
        <input value={base} onChange={(e) => setBase(e.target.value)} />
      </label>
      <p className="hint">
        Destination: an automatically named directory in AgentTeam-worktrees
        beside this repository.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy || !branch.trim() || !base.trim()}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api(`/agents/${agentId}/development/worktree`, "POST", {
              workspace,
              branch,
              base,
            });
          } catch (e) {
            setError(String((e as Error).message));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Creating worktree…" : "Create and attach"}
      </button>
    </details>
  );
}
