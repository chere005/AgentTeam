import { useEffect, useState } from "react";
import { Clock, GitMerge, Share2 } from "lucide-react";
import { api, type Snapshot } from "../api";
import { ExternalNotice } from "./AccessUi";
import "./cooperation.css";
/** One path segment that passes the desktop IPC filter ([a-z0-9/-?=&%] only). */
const ipcSegment = (v: string) =>
  v.replace(/[^A-Za-z0-9-]/g, (c) =>
    encodeURIComponent(c) === c
      ? "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")
      : encodeURIComponent(c),
  );

type Reason = {
  code: string;
  blocking: boolean;
  title: string;
  detail: string;
};
type Overview = {
  leases: {
    id: string;
    agent: string;
    kind: string;
    scope: string;
    paths: string[];
    acquiredAt: string;
    draining?: { reason: string };
    livePids: number[];
  }[];
  draining: { id: string; reason: string; livePids: number[] }[];
  queue: {
    id: string;
    kind: "task" | "chat";
    title: string;
    agent: string;
    position: number;
    priorityLabel: string;
    score: number;
    waitedSeconds: number;
    agingPoints: number;
    reasons: Reason[];
  }[];
  shared: {
    path: string;
    resource: string | null;
    kind: string;
    note: string;
    agents: {
      agentId: string;
      name: string;
      access: string;
      summary: string;
      workspace: string;
    }[];
    pairs: { a: string; b: string; agentA: string; agentB: string }[];
  }[];
  external: {
    notice: string;
    drivers: {
      agentId: string;
      name: string;
      label: string;
      warning: string;
    }[];
  };
  fairness: string;
};

/** Queue (tasks and chat together), leases with owners, shared resources and parallel work. */
export function Cooperation({
  data,
  events,
  act,
}: {
  data: Snapshot;
  events: unknown;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [o, setO] = useState<Overview | null>(null);
  const load = () =>
    api("/resources/overview")
      .then((v) => setO(v as Overview))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, [events]);
  if (!o) return null;
  return (
    <div className="coop-section" data-testid="cooperation">
      <h3>
        <Clock size={15} /> Queue: tasks and chat runs
      </h3>
      <p className="hint">{o.fairness}</p>
      {o.queue.length ? (
        o.queue.map((q) => (
          <div className="coop-item" key={q.id} data-testid="queue-entry">
            <b>
              #{q.position} · {q.title}
            </b>
            <span className="coop-tag">
              {q.kind === "chat" ? "Chat" : "Task"}
            </span>
            <span className="coop-tag">{q.priorityLabel}</span>
            <small>
              {q.agent} · waited {q.waitedSeconds} s (+
              {q.agingPoints.toFixed(1)} aging) · score {q.score.toFixed(1)}
            </small>
            {q.reasons
              .filter((r) => r.code !== "queue-position")
              .map((r, i) => (
                <span
                  className={"reason" + (r.blocking ? " blocking" : "")}
                  key={r.code + i}
                >
                  {r.title}: {r.detail}
                </span>
              ))}
          </div>
        ))
      ) : (
        <p className="hint">The queue is empty.</p>
      )}
      <h3>Current owners</h3>
      {o.leases.length ? (
        o.leases.map((l) => (
          <div className="coop-item" key={l.id} data-testid="lease-owner">
            <b>{l.agent}</b>
            <span className="coop-tag">{l.kind}</span>
            <span className="coop-tag">
              {l.scope === "declared"
                ? "declared paths only"
                : "all attached folders"}
            </span>
            {l.draining && <span className="coop-tag warn">draining</span>}
            {l.paths.map((p) => (
              <code className="full-path" key={p}>
                {p}
              </code>
            ))}
            {l.draining && (
              <small>
                Kept after a restart: {l.draining.reason}.
                {l.livePids.length
                  ? ` Still running: ${l.livePids.join(", ")}.`
                  : " Released on the next scheduler tick."}{" "}
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        "Release this lease only if you have confirmed no process is still writing in these folders. Release it?",
                      )
                    )
                      void act(async () => {
                        await api(
                          // Lease ids such as "git:<uuid>" or "graph:<run>:<node>:1" contain
                          // characters the desktop IPC path filter rejects: percent-encode them.
                          "/resources/leases/" +
                            ipcSegment(l.id) +
                            "/force-release",
                          "POST",
                          {
                            confirmStopped: true,
                            reason:
                              "Released from the Resources view after confirming the process stopped",
                          },
                        );
                        await load();
                      });
                  }}
                >
                  Release after I stopped it
                </button>
              </small>
            )}
          </div>
        ))
      ) : (
        <p className="hint">No active owners.</p>
      )}
      <h3>
        <Share2 size={15} /> Resources shared by several agents
      </h3>
      {o.shared.length ? (
        o.shared.map((s) => (
          <div className="coop-item" key={s.path} data-testid="shared-resource">
            <code className="full-path">{s.path}</code>
            <span className="coop-tag">{s.kind}</span>
            {s.resource && <span className="coop-tag">{s.resource}</span>}
            <small>
              {s.agents.map((a) => `${a.name} (${a.summary})`).join(" · ")}
            </small>
            <small>
              Overlap causing lock conflicts:{" "}
              {s.pairs
                .map((p) => `${p.agentA} ${p.a} ~ ${p.agentB} ${p.b}`)
                .join("; ")}
            </small>
            <small>{s.note}</small>
          </div>
        ))
      ) : (
        <p className="hint">No folder is attached to more than one agent.</p>
      )}
      <ParallelWork data={data} events={events} act={act} />
      {o.external.drivers.map((d) => (
        <ExternalNotice
          key={d.agentId}
          holder={d.label.startsWith("Interactive") ? "cli" : "native"}
        />
      ))}
      <ExternalNotice />
    </div>
  );
}

type Parallel = {
  enabled: boolean;
  integration: { taskId: string; status: string } | null;
  workers: {
    taskId: string;
    title: string;
    status: string;
    agent: string;
    isolation: string;
    paths: string[];
    detection?: string;
    changed?: { rel: string }[];
    violations?: { detail: string }[];
  }[];
  conflicts: {
    id: string;
    files: string[];
    detail: string;
    coordinatorTaskId: string;
    coordinatorTaskStatus: string;
  }[];
  limits: string;
};
function ParallelWork({
  data,
  events,
  act,
}: {
  data: Snapshot;
  events: unknown;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const withParallel = data.workflows.filter(
    (w) => (w as any).coordination?.enabled,
  );
  const [wf, setWf] = useState("");
  const [view, setView] = useState<Parallel | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [trees, setTrees] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const current = wf || withParallel[0]?.id || "";
  const load = () =>
    current
      ? api("/workflows/" + current + "/parallel")
          .then((v) => setView(v as Parallel))
          .catch(() => {})
      : Promise.resolve();
  useEffect(() => {
    void load();
  }, [current, events]);
  if (!withParallel.length) return null;
  const workflow = data.workflows.find((w) => w.id === current);
  const plan = (workflow as any)?.coordination?.planTaskId;
  const queued = (workflow?.tasks ?? []).filter(
    (t) =>
      t.status === "queued" &&
      t.id !== plan &&
      !t.title.startsWith("Integrate parallel work") &&
      !t.title.startsWith("Resolve parallel write conflict"),
  );
  return (
    <div className="coop-section" data-testid="parallel-work">
      <h3>
        <GitMerge size={15} /> Guided parallel assignments
      </h3>
      <label>
        Workflow
        <select
          value={current}
          onChange={(e) => setWf(e.target.value)}
          aria-label="Parallel workflow"
        >
          {withParallel.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      {queued.map((t) => (
        <div className="rule-row" key={t.id}>
          <span style={{ flex: 1 }}>{t.title}</span>
          <input
            aria-label={"Paths for " + t.title}
            placeholder="Absolute paths, comma separated"
            disabled={!!trees[t.id]}
            value={paths[t.id] ?? ""}
            onChange={(e) => setPaths({ ...paths, [t.id]: e.target.value })}
          />
          <label className="inline">
            <input
              type="checkbox"
              checked={!!trees[t.id]}
              onChange={(e) => setTrees({ ...trees, [t.id]: e.target.checked })}
            />
            Own worktree
          </label>
        </div>
      ))}
      {queued.length > 0 && (
        <button
          className="primary"
          onClick={() =>
            void act(async () => {
              setError("");
              const assignments = queued
                .filter((t) => trees[t.id] || (paths[t.id] ?? "").trim())
                .map((t) => ({
                  taskId: t.id,
                  worktree: !!trees[t.id],
                  paths: trees[t.id]
                    ? []
                    : (paths[t.id] ?? "")
                        .split(",")
                        .map((p) => p.trim())
                        .filter(Boolean),
                }));
              try {
                await api(
                  "/workflows/" + current + "/parallel/assign",
                  "POST",
                  { assignments },
                );
              } catch (e) {
                setError(String((e as Error).message ?? e));
              }
              await load();
            })
          }
        >
          Assign disjoint work and add integration step
        </button>
      )}
      {error && <p className="error">{error}</p>}
      {view?.workers.map((w) => (
        <div className="coop-item" key={w.taskId}>
          <b>{w.title}</b>
          <span className="coop-tag">{w.agent}</span>
          <span className="coop-tag">
            {w.isolation === "worktree" ? "worktree" : "disjoint paths"}
          </span>
          <span className="coop-tag">{w.status}</span>
          {w.paths.map((p) => (
            <code className="full-path" key={p}>
              {p}
            </code>
          ))}
          {w.changed && (
            <small>
              Changed: {w.changed.map((c) => c.rel).join(", ") || "nothing"}
              {w.detection === "unavailable" ? " (detection unavailable)" : ""}
            </small>
          )}
          {w.violations?.map((v, i) => (
            <small className="reason blocking" key={i}>
              {v.detail}
            </small>
          ))}
        </div>
      ))}
      {view?.conflicts.map((c) => (
        <div className="coop-item" key={c.id} data-testid="parallel-conflict">
          <b>Conflict routed to the coordinator</b>
          <small className="reason blocking">{c.detail}</small>
          <small>
            Resolution task is {c.coordinatorTaskStatus}; integration waits for
            it.
          </small>
        </div>
      ))}
      {view?.integration && (
        <p className="hint">
          Final integration task is {view.integration.status}.
        </p>
      )}
      {view && <p className="hint">{view.limits}</p>}
    </div>
  );
}
