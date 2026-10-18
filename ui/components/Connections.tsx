import { useEffect, useState } from "react";
import { api, type Agent } from "../api";
type Connection = {
  transport: "direct" | "acp";
  executable: string;
  args: string[];
};
export function Connections() {
  const [providers, setProviders] = useState<Record<string, Connection>>({});
  const [error, setError] = useState(""),
    [status, setStatus] = useState("");
  useEffect(() => {
    void api("/connections")
      .then(setProviders)
      .catch((e) => setError(e.message));
  }, []);
  const change = (id: string, patch: Partial<Connection>) =>
    setProviders({ ...providers, [id]: { ...providers[id], ...patch } });
  return (
    <section className="settings-card">
      <h3>Agent connections</h3>
      <p>
        ACP v1 uses an installed adapter. Direct mode keeps the existing CLI
        bridge. Existing conversations stay bound to their connection type; use
        a new agent when switching.
      </p>
      <p className="hint">
        ACP adapters run with their own local permissions. AgentTeam does not
        yet expose filesystem or terminal services through ACP, or control
        provider-native subagent spawning. Keep the adapter’s sandbox enabled.
      </p>
      {Object.entries(providers).map(([id, connection]) => (
        <div className="harness-setting" key={id}>
          <label>
            {id} connection
            <select
              aria-label={`${id} connection`}
              value={connection.transport}
              onChange={(e) =>
                change(id, {
                  transport: e.target.value as Connection["transport"],
                })
              }
            >
              <option value="direct">Direct CLI</option>
              <option value="acp">ACP v1 adapter</option>
            </select>
          </label>
          {connection.transport === "acp" && (
            <>
              <label>
                ACP executable
                <div className="row">
                  <input
                    aria-label={`${id} ACP executable`}
                    value={connection.executable}
                    onChange={(e) => change(id, { executable: e.target.value })}
                  />
                  <button
                    onClick={async () => {
                      const path = await window.agentteam.chooseExecutable();
                      if (path) change(id, { executable: path });
                    }}
                  >
                    Browse
                  </button>
                </div>
              </label>
              <label>
                Adapter arguments (one per line)
                <textarea
                  aria-label={`${id} ACP arguments`}
                  value={connection.args.join("\n")}
                  onChange={(e) =>
                    change(id, {
                      args: e.target.value ? e.target.value.split("\n") : [],
                    })
                  }
                />
              </label>
              <p className="hint">
                Use the adapter executable, or a Node executable with the
                adapter script as its first argument. No shell commands or
                automatic downloads.{" "}
                {id === "wolfram" &&
                  "Internal Wolfram ACP integration is deferred; use Direct CLI until validated."}
              </p>
            </>
          )}
          <button
            onClick={async () => {
              setError("");
              setStatus("");
              try {
                await api(`/connections/${id}`, "PUT", connection);
                setStatus(`${id} connection saved`);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Save {id} connection
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
export function PendingApprovals({
  agents,
  openInbox,
}: {
  agents: Agent[];
  /** Contextual entry: the Inbox lists every pending approval (this panel shows the first). */
  openInbox?: () => void;
}) {
  const [pending, setPending] = useState<any[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api("/approvals")
        .then((result) => {
          if (alive) setPending(result);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 1000);
    const unsubscribe = window.agentteam.onEvent(load);
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  if (!pending.length) return null;
  const approval = pending[0];
  async function choose(optionId: string | null) {
    try {
      await api(`/approvals/${approval.id}`, "POST", { optionId });
      setPending((p) => p.filter((a) => a.id !== approval.id));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div
      className="approval-panel"
      role="dialog"
      aria-label="Agent permission request"
    >
      <h3>
        {agents.find((a) => a.id === approval.agentId)?.name ?? "Agent"} needs
        permission
      </h3>
      <p>{approval.request.toolCall.title}</p>
      {approval.orphaned && (
        <p className="hint">
          AgentTeam restarted while this request was open. Your answer is
          recorded and applied once when the task resumes.
        </p>
      )}
      <details>
        <summary>Requested operation</summary>
        <pre>{JSON.stringify(approval.request.toolCall, null, 2)}</pre>
      </details>
      <div className="row">
        {approval.request.options.map((o: any) => (
          <button key={o.optionId} onClick={() => void choose(o.optionId)}>
            {o.name}
          </button>
        ))}
        <button onClick={() => void choose(null)}>Cancel request</button>
      </div>
      {openInbox && (
        <button className="text-button" onClick={openInbox}>
          {pending.length > 1
            ? `${pending.length - 1} more waiting · Open inbox`
            : "Open inbox"}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <small>
        {pending.length} pending · permissions apply through this adapter
      </small>
    </div>
  );
}
