import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DevServerInfo } from "../../src/devserver";
import "./devserver.css";

type Suggestion = {
  label: string;
  command: string;
  url: string;
  source: string;
  note?: string;
};
type State = {
  settings: {
    command: string;
    cwd: string;
    url: string;
    readyTimeoutSeconds: number;
  } | null;
  inheritedFrom: string | null;
  suggestions: Suggestion[];
  warnings: string[];
  server: DevServerInfo | null;
  console: {
    at: string;
    level: string;
    message: string;
    source: string;
    line: number;
  }[];
  locks: { leaseId: string; agent: string; since: string }[];
  lockPolicy: string;
};
const viewports = [
  { id: "fill", label: "Fit pane", w: 0, h: 0 },
  { id: "mobile", label: "Mobile 375×812", w: 375, h: 812 },
  { id: "tablet", label: "Tablet 768×1024", w: 768, h: 1024 },
  { id: "laptop", label: "Laptop 1280×800", w: 1280, h: 800 },
];
const labels: Record<string, string> = {
  starting: "Starting — waiting for the URL to respond",
  ready: "Ready",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
};

export function DevServerPanel({
  agentId,
  workspace,
}: {
  agentId: string;
  workspace: string;
}) {
  const [state, setState] = useState<State | null>(null),
    [command, setCommand] = useState("npm run dev"),
    [cwd, setCwd] = useState("."),
    [url, setUrl] = useState("http://127.0.0.1:5173"),
    [timeout, setTimeoutSeconds] = useState(60),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [reload, setReload] = useState(0),
    [viewport, setViewport] = useState("fill");
  const loaded = useRef(false);
  const body = { workspace };
  async function refresh() {
    try {
      const next: State = await api(
        `/agents/${agentId}/devserver/state`,
        "POST",
        body,
      );
      setState(next);
      if (!loaded.current) {
        loaded.current = true;
        const first = next.settings ?? next.suggestions[0];
        if (first) {
          setCommand(first.command);
          setUrl(first.url);
        }
        if (next.settings) {
          setCwd(next.settings.cwd);
          setTimeoutSeconds(next.settings.readyTimeoutSeconds);
        }
      }
    } catch (e) {
      setError(String((e as Error).message));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1200);
    return () => clearInterval(timer);
  }, [agentId, workspace]);
  const server = state?.server ?? null;
  const active =
    !!server && ["starting", "ready", "stopping"].includes(server.state);
  useEffect(() => {
    if (!server || server.state !== "ready") setOpen(false);
  }, [server?.state, server?.id]);
  async function act(action: "start" | "stop" | "restart" | "settings") {
    setBusy(true);
    setError("");
    try {
      const payload =
        action === "start" || action === "settings"
          ? { workspace, command, cwd, url, readyTimeoutSeconds: timeout }
          : body;
      await api(`/agents/${agentId}/devserver/${action}`, "POST", payload);
      if (action === "restart") setOpen(false);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const vp = viewports.find((v) => v.id === viewport)!;
  const previewUrl = server?.previewUrl ?? "";
  return (
    <section aria-label="Development preview" className="devserver">
      <h3>Development server</h3>
      <code className="full-path">{workspace}</code>
      {state?.inheritedFrom && (
        <p className="hint">
          Settings are inherited from the source repository (
          {state.inheritedFrom}). Saving or starting stores separate settings
          for this worktree.
        </p>
      )}
      {state && state.suggestions.length > 0 && (
        <div className="row" role="group" aria-label="Suggested scripts">
          <span className="hint">Suggestions from package.json (not run):</span>
          {state.suggestions.map((s) => (
            <button
              key={s.command}
              className="chip"
              disabled={active}
              title={s.source + (s.note ? " — " + s.note : "")}
              onClick={() => {
                setCommand(s.command);
                setUrl(s.url);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {state?.warnings.map((w) => (
        <p key={w} role="note" className="warn">
          {w}
        </p>
      ))}
      <label>
        Server command
        <input
          value={command}
          disabled={active}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label>
        Working directory (relative to the folder)
        <input
          value={cwd}
          disabled={active}
          onChange={(e) => setCwd(e.target.value)}
        />
      </label>
      <label>
        Preview URL
        <input
          value={url}
          disabled={active}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label>
        Readiness timeout (seconds)
        <input
          type="number"
          min={2}
          max={600}
          value={timeout}
          disabled={active}
          onChange={(e) => setTimeoutSeconds(Number(e.target.value) || 60)}
        />
      </label>
      <p className="hint">
        Runs this command with your local account in this folder; PORT, HOST and
        BROWSER=none are provided and the server must listen on the URL's port.
        AgentTeam never starts it on its own.
      </p>
      <details className="lock-note">
        <summary>
          Resource locks
          {state?.locks.length
            ? ` — ${state.locks.length} active lease(s) overlap this folder`
            : ""}
        </summary>
        <p>{state?.lockPolicy}</p>
        {state?.locks.map((l) => (
          <p key={l.leaseId} role="note" className="warn">
            {l.agent} holds a lease here since{" "}
            {new Date(l.since).toLocaleTimeString()}.
          </p>
        ))}
      </details>
      <div className="row">
        <button
          disabled={busy || active || !command.trim()}
          onClick={() => void act("start")}
        >
          Start server
        </button>
        <button
          disabled={busy || !active || server?.state === "stopping"}
          onClick={() => void act("stop")}
        >
          Stop server
        </button>
        <button
          disabled={busy || !server || server.state === "stopping"}
          onClick={() => void act("restart")}
        >
          Restart server
        </button>
        <button disabled={busy || active} onClick={() => void act("settings")}>
          Save settings
        </button>
        <button
          disabled={server?.state !== "ready"}
          onClick={() => {
            setOpen(true);
            setReload((n) => n + 1);
          }}
        >
          Open / reload preview
        </button>
        <a
          className={"button" + (server?.state === "ready" ? "" : " disabled")}
          href={server?.state === "ready" ? previewUrl : undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={server?.state !== "ready"}
        >
          Open in browser
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {server && (
        <>
          <p role="status" data-state={server.state}>
            Server: {labels[server.state]}
            {server.exitCode !== null ? ` · exit ${server.exitCode}` : ""}
            {server.signal ? ` · signal ${server.signal}` : ""}
            {server.state === "starting"
              ? ` · ${server.checks} readiness check(s)`
              : ""}
          </p>
          {server.failure && <p role="alert">{server.failure}</p>}
          {server.hints.map((h) => (
            <p key={h} role="note" className="warn">
              {h}
            </p>
          ))}
          {server.detectedUrl && (
            <button
              disabled={active}
              onClick={() => setUrl(server.detectedUrl!)}
            >
              Use detected URL {server.detectedUrl}
            </button>
          )}
          <details>
            <summary>
              Server logs{server.logTruncated ? " (older output trimmed)" : ""}
            </summary>
            <pre className="server-log">{server.log || "No output yet."}</pre>
          </details>
        </>
      )}
      {open && server?.state === "ready" && (
        <>
          <div className="row" role="group" aria-label="Viewport size">
            {viewports.map((v) => (
              <button
                key={v.id}
                aria-pressed={viewport === v.id}
                onClick={() => setViewport(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          {server.embeddable === false ? (
            <p role="alert" data-testid="embed-blocked">
              {server.embedNote} Use Open in browser instead.
            </p>
          ) : (
            <p className="hint">
              If the page is blank, the server may refuse embedding or redirect
              outside {new URL(server.url).origin}; the preview cannot leave
              that origin. Use Open in browser for anything else.
            </p>
          )}
          {server.embeddable !== false && (
            <div className="preview-scroll">
              <iframe
                key={reload + viewport}
                title="Local development preview"
                src={previewUrl}
                sandbox="allow-scripts allow-forms allow-same-origin"
                referrerPolicy="no-referrer"
                className="development-frame"
                style={
                  vp.w
                    ? { width: vp.w, height: vp.h, maxWidth: "none" }
                    : undefined
                }
              />
            </div>
          )}
          <details open={!!state?.console.length}>
            <summary>
              Browser console errors ({state?.console.length ?? 0})
            </summary>
            <p className="hint">
              Errors and warnings from the embedded page (desktop app only).
            </p>
            {state?.console.map((c, i) => (
              <pre key={i} className={"console-" + c.level}>
                {c.level.toUpperCase()} {c.message}
                {c.source ? `\n  at ${c.source}:${c.line}` : ""}
              </pre>
            ))}
            <button
              onClick={() =>
                void api(
                  `/agents/${agentId}/devserver/clear-console`,
                  "POST",
                  body,
                ).then(refresh)
              }
            >
              Clear console
            </button>
          </details>
        </>
      )}
    </section>
  );
}
