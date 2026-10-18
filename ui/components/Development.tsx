import { useEffect, useState } from "react";
import { api, saved, persist } from "../api";
import type { DevProcess } from "../../src/development";

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

export function DevelopmentPreview({
  agentId,
  workspace,
}: {
  agentId: string;
  workspace: string;
}) {
  const key = "dev." + workspace;
  const initial = saved(key, {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
  });
  const [command, setCommand] = useState(initial.command),
    [url, setUrl] = useState(initial.url);
  const [processes, setProcesses] = useState<DevProcess[]>([]),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    async function poll() {
      try {
        const result = await api(
          `/agents/${agentId}/development/list`,
          "POST",
          { workspace },
        );
        if (alive) setProcesses(result);
      } catch (e) {
        if (alive) setError(String((e as Error).message));
      }
    }
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [agentId, workspace]);
  const current = processes.at(-1);
  const running =
    current && ["starting", "running", "stopping"].includes(current.state);
  async function action(stop: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        `/agents/${agentId}/development/${stop ? "stop" : "start"}`,
        "POST",
        stop ? { processId: current!.id } : { workspace, command, url },
      );
      setProcesses((old) => [...old.filter((p) => p.id !== result.id), result]);
      if (!stop) persist(key, { command, url });
      else setPreview("");
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Development preview">
      <h3>Development server</h3>
      <code className="full-path">{workspace}</code>
      <label>
        Server command
        <input
          value={command}
          disabled={!!running}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label>
        Preview URL
        <input
          value={url}
          disabled={!!running}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <p className="hint">
        Runs this command with your local account in this folder. PORT and HOST
        are provided; configure your server to use them. Server writes are not
        protected by agent resource locks.
      </p>
      <div className="row">
        <button
          disabled={busy || !!running || !command.trim()}
          onClick={() => void action(false)}
        >
          Start server
        </button>
        <button disabled={busy || !running} onClick={() => void action(true)}>
          Stop server
        </button>
        <button
          disabled={!current || current.state !== "running"}
          onClick={() => {
            setPreview(current!.url);
            setReload(reload + 1);
          }}
        >
          Open / reload preview
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {current && (
        <>
          <p role="status">
            Process: {current.state}
            {current.exitCode !== null ? ` · exit ${current.exitCode}` : ""}.
            The server logs indicate when it is ready.
          </p>
          <details>
            <summary>Server logs</summary>
            <pre className="server-log">{current.log || "No output yet."}</pre>
          </details>
        </>
      )}
      {preview && (
        <>
          <p className="hint">
            If the page is blank, check the server logs and URL. Servers may
            prohibit embedding.
          </p>
          <iframe
            key={reload}
            title="Local development preview"
            src={preview}
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
            className="development-frame"
          />
        </>
      )}
    </section>
  );
}
