import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type {
  SetupState,
  WorktreeRecord,
  WorktreeSettings,
} from "../../src/worktrees";

type Info = {
  path: string;
  main: boolean;
  current: boolean;
  branch: string | null;
  head: string;
  base: string | null;
  ahead: number | null;
  managed: boolean;
  record: WorktreeRecord | null;
  archived: boolean;
  missing: boolean;
  owners: { id: string; name: string; active: boolean }[];
  tasks: { id: string; title: string; status: string }[];
  running: boolean;
  changes: {
    changed: number;
    untracked: number;
    files: { path: string; status: string }[];
    truncated: boolean;
  } | null;
};
const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "unknown");

/** Create form (replaces the basic one), project settings, and managed worktree list. */
export function WorktreeManager({
  agentId,
  workspace,
}: {
  agentId: string;
  workspace: string;
}) {
  const route = (action: string) => `/agents/${agentId}/worktrees/${action}`;
  const [branch, setBranch] = useState(""),
    [base, setBase] = useState("HEAD"),
    [directory, setDirectory] = useState(""),
    [keepSource, setKeepSource] = useState(false),
    [setup, setSetup] = useState(""),
    [shell, setShell] = useState(false),
    [branches, setBranches] = useState<string[]>([]),
    [suggested, setSuggested] = useState({ branch: "", directory: "" }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [items, setItems] = useState<Info[]>([]),
    [settings, setSettings] = useState<WorktreeSettings | null>(null),
    [confirm, setConfirm] = useState<{
      path: string;
      mode: "archive" | "remove";
      message?: string;
    } | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [list, plan] = await Promise.all([
        api(route("list"), "POST", { workspace }),
        api(route("suggest"), "POST", { workspace }),
      ]);
      setItems(list.worktrees);
      setBranches(plan.branches);
      setSuggested({ branch: plan.branch, directory: plan.directory });
    } catch {
      /* the workspace may be a non-repository or read-only */
    }
  }, [agentId, workspace]);
  useEffect(() => {
    void refresh();
    void api("/worktrees/settings")
      .then(setSettings)
      .catch(() => {});
  }, [refresh]);
  const anySetupRunning = items.some(
    (i) => i.record?.setup?.state === "running",
  );
  useEffect(() => {
    if (!anySetupRunning) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [anySetupRunning, refresh]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const saveSettings = (next: WorktreeSettings) => {
    setSettings(next);
    void api("/worktrees/settings", "PUT", next).catch((e) =>
      setError(String((e as Error).message)),
    );
  };
  return (
    <>
      <details className="section">
        <summary>Create isolated worktree</summary>
        <p className="hint">
          Creates a fresh checkout from committed history of{" "}
          <code>{workspace}</code>. Uncommitted changes stay in the source. By
          default it becomes this agent’s only active folder; leave names empty
          to have unique ones generated.
        </p>
        <label>
          New branch
          <input
            value={branch}
            placeholder={suggested.branch || "generated automatically"}
            onChange={(e) => setBranch(e.target.value)}
          />
        </label>
        <label>
          Base revision
          <input
            list="worktree-bases"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <datalist id="worktree-bases">
            <option value="HEAD" />
            {branches.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label>
          Destination directory (optional)
          <input
            value={directory}
            placeholder={
              suggested.directory || "AgentTeam-worktrees beside the repository"
            }
            onChange={(e) => setDirectory(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={keepSource}
            onChange={(e) => setKeepSource(e.target.checked)}
          />
          Keep the original repository attached (inactive)
        </label>
        <label>
          Setup command (optional)
          <input
            value={setup}
            placeholder="npm ci"
            onChange={(e) => setSetup(e.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={shell}
            onChange={(e) => setShell(e.target.checked)}
          />
          Run through the system shell (otherwise run directly, without shell
          expansion)
        </label>
        {setup.trim() && (
          <p className="hint">
            After creating, this will run in the new worktree:{" "}
            <code>
              {shell ? "[shell] " : ""}
              {setup.trim()}
            </code>
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button
          disabled={busy || !base.trim()}
          onClick={() =>
            void act(async () => {
              const r = await api(route("create"), "POST", {
                workspace,
                base,
                ...(branch.trim() ? { branch: branch.trim() } : {}),
                ...(directory.trim() ? { directory: directory.trim() } : {}),
                keepSource,
                ...(setup.trim()
                  ? { setup: { command: setup.trim(), shell, run: true } }
                  : {}),
              });
              setNotice(`Created ${r.branch} at ${r.path}`);
              setBranch("");
            })
          }
        >
          {busy ? "Creating worktree…" : "Create and attach"}
        </button>
      </details>
      <details className="section">
        <summary>Worktree settings</summary>
        <label className="check">
          <input
            type="checkbox"
            checked={settings?.autoCreate ?? false}
            disabled={!settings}
            onChange={(e) =>
              settings &&
              saveSettings({ ...settings, autoCreate: e.target.checked })
            }
          />
          Create an isolated worktree automatically when assigning coding work
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings?.keepSource ?? false}
            disabled={!settings}
            onChange={(e) =>
              settings &&
              saveSettings({ ...settings, keepSource: e.target.checked })
            }
          />
          Keep the original repository attached by default
        </label>
        <label>
          Default setup command (shown, never run automatically)
          <input
            aria-label="Default setup command"
            defaultValue={settings?.setup?.command ?? ""}
            key={settings ? "loaded" : "loading"}
            onBlur={(e) =>
              settings &&
              saveSettings({
                ...settings,
                setup: e.target.value.trim()
                  ? { command: e.target.value.trim(), shell: false }
                  : null,
              })
            }
          />
        </label>
        <p className="hint">
          Applies to all projects unless overridden per repository through the
          API. Auto-created worktrees list their setup command with a Run button
          instead of running it.
        </p>
      </details>
      <h3>Managed worktrees</h3>
      {items.map((w) => (
        <div
          className="worktree-card"
          key={w.path}
          aria-label={`Worktree ${w.branch ?? w.path}`}
        >
          <div>
            <b>{w.branch ?? "Detached HEAD"}</b>{" "}
            {w.main && <span className="badge">main checkout</span>}{" "}
            {w.archived && <span className="badge">archived</span>}{" "}
            {w.record?.status === "unattached" && (
              <span className="badge">not attached</span>
            )}
            {w.missing && <span className="badge">missing on disk</span>}
          </div>
          <code>{w.path}</code>
          <div className="hint">
            Base {short(w.base)} · HEAD {short(w.head)}
            {w.ahead != null && ` · ${w.ahead} commit(s) ahead`}
          </div>
          <div className="hint">
            Owner:{" "}
            {w.owners.length
              ? w.owners
                  .map((o) => o.name + (o.active ? " (active)" : ""))
                  .join(", ")
              : "no attached agent"}
            {" · "}Active tasks:{" "}
            {w.tasks.length
              ? w.tasks.map((t) => `${t.title} [${t.status}]`).join(", ")
              : "none"}
          </div>
          {w.changes && (
            <div className="hint">
              Changes: {w.changes.changed} modified, {w.changes.untracked}{" "}
              untracked
              {w.changes.files.length > 0 &&
                ` (${w.changes.files
                  .slice(0, 5)
                  .map((f) => f.path)
                  .join(", ")}${w.changes.files.length > 5 ? ", …" : ""})`}
            </div>
          )}
          {w.record?.setup && (
            <SetupView
              state={w.record.setup}
              busy={busy}
              onRun={() =>
                void act(() =>
                  api(route("setup"), "POST", { worktreeId: w.record!.id }),
                )
              }
            />
          )}
          {!w.main && (
            <div className="row">
              {w.record &&
                !w.missing &&
                !w.owners.some((o) => o.id === agentId) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api(route("attach"), "POST", {
                          worktreeId: w.record!.id,
                        }),
                      )
                    }
                  >
                    Attach to this agent
                  </button>
                )}
              {!w.archived && (
                <button
                  disabled={busy}
                  onClick={() => setConfirm({ path: w.path, mode: "archive" })}
                >
                  Archive
                </button>
              )}
              <button
                disabled={busy}
                onClick={() => setConfirm({ path: w.path, mode: "remove" })}
              >
                Remove
              </button>
            </div>
          )}
          {confirm?.path === w.path && (
            <div role="group" aria-label="Confirm worktree action">
              <p className="hint">
                {confirm.mode === "archive"
                  ? "Archive detaches this worktree from agents and keeps the directory, branch and any uncommitted files."
                  : "Remove deletes the checkout directory (the branch is kept). It is refused while there are uncommitted or untracked files."}
                {(w.owners.length > 0 || w.tasks.length > 0) &&
                  ` In use by ${w.owners.map((o) => o.name).join(", ") || "queued work"}${w.tasks.length ? ` with ${w.tasks.length} task(s)` : ""}: it will be detached from them.`}
              </p>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api(route("remove"), "POST", {
                      workspace,
                      path: w.path,
                      mode: confirm.mode,
                      acknowledgeUsers: true,
                    });
                    setConfirm(null);
                  })
                }
              >
                Confirm {confirm.mode}
              </button>
              <button onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function SetupView({
  state,
  busy,
  onRun,
}: {
  state: SetupState;
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <div className="setup" aria-label="Setup command">
      <div>
        Setup command:{" "}
        <code>
          {state.shell ? "[shell] " : ""}
          {state.command}
        </code>
      </div>
      <div>
        Setup: {state.state}
        {state.state === "pending" && " (not run yet)"}
        {state.exitCode !== null && ` · exit ${state.exitCode}`}
        {state.attempts > 0 && ` · attempt ${state.attempts}`}
      </div>
      {state.log && <pre aria-label="Setup log">{state.log}</pre>}
      <button disabled={busy || state.state === "running"} onClick={onRun}>
        {state.state === "failed"
          ? "Retry setup"
          : state.state === "pending"
            ? "Run setup"
            : "Run setup again"}
      </button>
    </div>
  );
}
