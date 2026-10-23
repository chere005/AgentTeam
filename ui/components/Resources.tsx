import { PrioritySelect, priorityName } from "./PrioritySelect";
import { useEffect, useState } from "react";
import { LockKeyhole, Plus, Users, Clock, ShieldCheck } from "lucide-react";
import { api, type Snapshot, type TeamEvent } from "../api";
import { Cooperation } from "./Cooperation";
import { agentSelectorLabel } from "../agent-identity";
export function Resources({
  data,
  events,
  act,
}: {
  data: Snapshot;
  events: TeamEvent[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [state, setState] = useState<any>(null),
    [adding, setAdding] = useState(false),
    [name, setName] = useState(""),
    [path, setPath] = useState(""),
    [priorities, setPriorities] = useState<Record<string, number>>({}),
    [editing, setEditing] = useState("");
  const [wf, setWf] = useState(""),
    [coordinator, setCoordinator] = useState(""),
    [parallel, setParallel] = useState(false),
    [max, setMax] = useState(3),
    [resources, setResources] = useState<string[]>([]);
  const load = () => api("/resources").then(setState);
  useEffect(() => {
    void act(load);
  }, [events]);
  const paths = [
    ...new Set(data.agents.flatMap((a) => a.workspaces.map((w) => w.path))),
  ];
  // Active team only. Locks, priorities and queues are global, so other teams' holders are
  // still summarised (they can make this team's agents wait).
  const mine = new Set(data.agents.map((a) => a.id)),
    everyone = data.teamView?.allAgents ?? data.agents,
    nameOf = (id: string) => everyone.find((a) => a.id === id)?.name ?? id,
    teamName = data.teamView?.team.name ?? "this team";
  const ownResources = (state?.resources ?? []).filter(
      (r: any) =>
        paths.includes(r.path) ||
        r.priorities.some((v: any) => mine.has(v.agentId)),
    ),
    leases = (state?.leases ?? []).filter((l: any) => mine.has(l.agentId)),
    otherLeases = (state?.leases ?? []).filter(
      (l: any) => !mine.has(l.agentId),
    ),
    chatQueue = (state?.chatQueue ?? []).filter((q: any) =>
      mine.has(q.agentId),
    ),
    queue = (state?.queue ?? []).filter((q: any) => mine.has(q.agentId));
  function edit(r: any) {
    setAdding(true);
    setEditing(r.id);
    setName(r.name);
    setPath(r.path);
    setPriorities(
      Object.fromEntries(r.priorities.map((v: any) => [v.agentId, v.priority])),
    );
  }
  return (
    <div className="section scroll">
      <div className="section-title">
        <div>
          <span className="eyebrow">SHARED WORK</span>
          <h2>Resource coordination</h2>
        </div>
        <button
          onClick={() => {
            setAdding(!adding);
            setEditing("");
            setName("");
            setPath(paths[0] ?? "");
            setPriorities({});
          }}
        >
          <Plus size={15} />
          Resource
        </button>
      </div>
      <div className="access-banner">
        <div className="row">
          <LockKeyhole size={17} />
          <b>ONE AGENT AT A TIME, BY DEFAULT</b>
        </div>
        <p>
          Attached folders and overlapping subfolders are automatically
          exclusive during AgentTeam runs, even before you create a named
          resource. Named resources let you set priorities and allow guided
          parallel workflows.
        </p>
      </div>
      {adding && (
        <form
          className="form-card"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api("/resources", "POST", {
                ...(editing ? { id: editing } : {}),
                name,
                path,
                priorities: Object.entries(priorities).map(
                  ([agentId, priority]) => ({ agentId, priority }),
                ),
              });
              setAdding(false);
              await load();
            });
          }}
        >
          <h3>{editing ? "Edit resource" : "Name a shared resource"}</h3>
          <label>
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Application source"
            />
          </label>
          <label>
            Folder path
            <input
              required
              list="resource-paths"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Full path to attached folder or common parent"
            />
            <datalist id="resource-paths">
              {paths.map((path) => (
                <option value={path} key={path} />
              ))}
            </datalist>
          </label>
          <p className="hint">
            All files below this path belong to the resource. Start with an
            attached folder; a common parent can group overlapping projects.
          </p>
          <h3>Agent priority</h3>
          {data.agents.map((a) => (
            <label className="priority-row" key={a.id}>
              <span>
                {agentSelectorLabel(a)}
                <small>
                  Default {priorityName(a.schedulingPriority ?? 50)}
                </small>
              </span>
              <PrioritySelect
                label={"Priority for " + agentSelectorLabel(a)}
                value={priorities[a.id] ?? a.schedulingPriority ?? 50}
                onChange={(value) =>
                  setPriorities({ ...priorities, [a.id]: value })
                }
              />
            </label>
          ))}
          <p className="hint">
            Higher starts first. Every five seconds waiting adds a priority
            point, so lower-priority work can move ahead. Running work is not
            interrupted. Preempt always takes the next free turn ahead of normal
            priorities; continuous Preempt work can delay them.
          </p>
          <button className="primary">Save resource</button>
        </form>
      )}
      <div className="resource-list">
        {ownResources.map((r: any) => (
          <article className="settings-card" key={r.id}>
            <div className="row between">
              <div className="row">
                <LockKeyhole size={18} />
                <b>{r.name}</b>
              </div>
              <button onClick={() => edit(r)}>Priorities</button>
            </div>
            <code className="full-path">{r.path}</code>
            <small>
              {r.priorities
                .map(
                  (v: any) =>
                    `${nameOf(v.agentId)}: ${priorityName(v.priority)}`,
                )
                .join(" · ") || "Uses each agent’s default priority"}
            </small>
          </article>
        ))}
        {state && !ownResources.length && (
          <p className="hint">No named resources used by {teamName}.</p>
        )}
      </div>
      <h3>Currently holding resources</h3>
      {leases.length ? (
        leases.map((l: any) => (
          <div className="lease" key={l.id}>
            <div className="row">
              <span className="dot green pulse" />
              <b>{data.agents.find((a) => a.id === l.agentId)?.name}</b>
              <span className="badge">
                {l.workflowId ? "Workflow" : "Chat"}
              </span>
            </div>
            {l.paths.map((path: string) => (
              <code className="full-path" key={path}>
                {path}
              </code>
            ))}
          </div>
        ))
      ) : (
        <p className="hint">No active resource holders in {teamName}.</p>
      )}
      {otherLeases.length > 0 && (
        <details className="other-team-leases">
          <summary>
            {otherLeases.length} lease(s) held by other teams (locks are global)
          </summary>
          {otherLeases.map((l: any) => (
            <div className="lease" key={l.id}>
              <b>{nameOf(l.agentId)}</b>
              {l.paths.map((path: string) => (
                <code className="full-path" key={path}>
                  {path}
                </code>
              ))}
            </div>
          ))}
        </details>
      )}
      <h3>Waiting agents</h3>
      {chatQueue.map((q: any) => (
        <div className="queue-row" key={q.id}>
          <Clock size={15} />
          <div className="grow">
            <b>Chat · {nameOf(q.agentId)}</b>
            <small>
              base {q.priority} → effective {q.effectivePriority}
            </small>
          </div>
          <button
            onClick={() =>
              void act(() => api("/sessions/" + q.id + "/cancel", "POST"))
            }
          >
            Cancel
          </button>
        </div>
      ))}
      {queue.length ? (
        queue.map((q: any) => (
          <div className="queue-row" key={q.id}>
            <Clock size={15} />
            <div className="grow">
              <b>{q.title}</b>
              <small>
                {nameOf(q.agentId)} · base {q.priority} → effective{" "}
                {q.effectivePriority}
              </small>
              {q.blockers.length > 0 && (
                <small>
                  Waiting for{" "}
                  {q.blockers.map((id: string) => nameOf(id)).join(", ")}
                </small>
              )}
            </div>
          </div>
        ))
      ) : (
        <p className="hint">Nothing waiting for a turn.</p>
      )}
      <section className="settings-card">
        <div className="row">
          <Users size={19} />
          <h3>Guided parallel workflow</h3>
        </div>
        <p>
          Allow a specific workflow to share selected resources. A coordinator
          first writes a work-allocation plan; workers receive it before
          starting in parallel. Other workflows remain excluded.
        </p>
        <label>
          Workflow
          <select
            aria-label="Workflow"
            value={wf}
            onChange={(e) => {
              setWf(e.target.value);
              const w = data.workflows.find(
                (w) => w.id === e.target.value,
              ) as any;
              setCoordinator(
                w?.coordination?.coordinatorId ?? w?.ownerId ?? "",
              );
              setParallel(w?.coordination?.enabled ?? false);
              setResources(w?.coordination?.resourceIds ?? []);
              setMax(w?.coordination?.maxConcurrent ?? 3);
            }}
          >
            <option value="">Choose workflow</option>
            {data.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={parallel}
            onChange={(e) => setParallel(e.target.checked)}
          />
          Allow parallel work in this workflow
        </label>
        <div className="form-grid" style={{ marginTop: 15 }}>
          <label>
            Coordinating agent
            <select
              value={coordinator}
              onChange={(e) => setCoordinator(e.target.value)}
            >
              <option value="">Choose coordinator</option>
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentSelectorLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Max parallel workers
            <input
              type="number"
              min="2"
              max="32"
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
            />
          </label>
        </div>
        <label>Shared resources</label>
        {state?.resources.map((r: any) => (
          <label className="inline resource-choice" key={r.id}>
            <input
              type="checkbox"
              checked={resources.includes(r.id)}
              onChange={(e) =>
                setResources(
                  e.target.checked
                    ? [...resources, r.id]
                    : resources.filter((id) => id !== r.id),
                )
              }
            />
            {r.name}
          </label>
        ))}
        {!state?.resources.length && (
          <p className="hint">Add a named resource first.</p>
        )}
        <button
          className="primary"
          disabled={!wf || !coordinator || !resources.length}
          onClick={() =>
            void act(async () => {
              await api("/workflows/" + wf + "/coordination", "PUT", {
                enabled: parallel,
                coordinatorId: coordinator,
                resourceIds: resources,
                maxConcurrent: max,
              });
              await load();
            })
          }
        >
          Apply workflow access
        </button>
        <p className="hint">
          Parallel workers can edit the same files. Use the coordinator’s plan
          or separate Git worktrees to avoid conflicts. Changes require active
          tasks to finish first.
        </p>
      </section>
      <Cooperation data={data} events={events} act={act} />
      <p className="hint">
        Locks apply to work launched by AgentTeam and its Git mutations.
        External editors and native sessions are outside this coordination
        system.
      </p>
    </div>
  );
}
