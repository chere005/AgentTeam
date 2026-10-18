import { useEffect, useState } from "react";
import { api } from "../api";

type RepoState = {
  branch?: string | null;
  detached?: boolean;
  unborn?: boolean;
  tracked?: number;
  operation?: string;
  activeRun?: string | null;
  canMutate?: boolean;
};

/**
 * Start a merge or rebase of the current branch with a chosen branch. Nothing starts without the
 * confirmation checkbox; a conflict leaves the in-progress state that the conflict panel handles
 * (resolve, continue or abort). The backend enforces every rule shown here (no force).
 */
export function GitIntegrate({
  agentId,
  workspace,
  st,
  run,
  busy,
  tick,
}: {
  agentId: string;
  workspace: string;
  st: RepoState;
  run: (label: string, body: () => Promise<any>) => Promise<void>;
  busy: boolean;
  tick: number;
}) {
  const [data, setData] = useState<any>(null),
    [mode, setMode] = useState<"merge" | "rebase">("merge"),
    [source, setSource] = useState(""),
    [sure, setSure] = useState(false),
    [rewrite, setRewrite] = useState(false),
    [runOk, setRunOk] = useState(false);
  useEffect(() => {
    api(`/agents/${agentId}/git/branches`, "POST", { workspace })
      .then(setData)
      .catch(() => setData(null));
  }, [agentId, workspace, tick, st.branch]);
  const names: string[] = [
    ...(data?.local ?? []).map((b: any) => b.name as string),
    ...(data?.remote ?? []).map((b: any) => b.name as string),
  ].filter((n) => n !== st.branch);
  const dirty = (st.tracked ?? 0) > 0;
  const idle = !st.operation || st.operation === "none";
  const onBranch = !st.detached && !st.unborn && !!st.branch;
  const ready =
    !busy &&
    !!st.canMutate &&
    idle &&
    onBranch &&
    !dirty &&
    !!source &&
    sure &&
    (!st.activeRun || runOk);
  const verb = mode === "merge" ? "Merge" : "Rebase";
  return (
    <details className="section">
      <summary>Merge or rebase</summary>
      <div className="row">
        <select
          aria-label="Integration mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as "merge" | "rebase");
            setSure(false);
            setRewrite(false);
          }}
        >
          <option value="merge">
            Merge a branch into {st.branch ?? "this branch"}
          </option>
          <option value="rebase">
            Rebase {st.branch ?? "this branch"} onto a branch
          </option>
        </select>
        <select
          aria-label="Branch to integrate"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">Choose a branch…</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={sure}
          onChange={(e) => setSure(e.target.checked)}
        />
        {mode === "merge"
          ? "I understand this can create a merge commit and stop with conflicts"
          : "I understand this replays my local commits and rewrites them"}
      </label>
      {mode === "rebase" && (
        <label className="check">
          <input
            type="checkbox"
            checked={rewrite}
            onChange={(e) => setRewrite(e.target.checked)}
          />
          Allow rewriting commits that are already on the upstream (a later push
          would need force, which is not offered)
        </label>
      )}
      {st.activeRun && (
        <label className="check">
          <input
            type="checkbox"
            checked={runOk}
            onChange={(e) => setRunOk(e.target.checked)}
          />
          Change the working tree while an agent is running here
        </label>
      )}
      <button
        disabled={!ready}
        onClick={() => {
          const body = {
            workspace,
            mode,
            source,
            confirmMode: sure,
            confirmRewrite: rewrite,
            confirmActiveRun: runOk,
          };
          // Each start needs its own confirmation.
          setSure(false);
          setRewrite(false);
          void run(verb, () =>
            api(`/agents/${agentId}/git/integrate`, "POST", body),
          );
        }}
      >
        {verb} {source || "…"}
      </button>
      {dirty && (
        <p className="hint">
          Commit or discard your {st.tracked} uncommitted change(s) first.
        </p>
      )}
      {!idle && (
        <p className="hint">Finish or abort the {st.operation} first.</p>
      )}
    </details>
  );
}
