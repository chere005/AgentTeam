import { useEffect, useMemo, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { Agent, Snapshot, TeamEvent } from "../api";
import { api } from "../api";
import { WorkflowLimits } from "./Limits";
import "./usage-limits.css";

type Use = { input: number; output: number; cache: number; reports: number };
type Limits = {
  workflowId: string;
  limits: Record<string, number | null>;
  trip: { kind: string; reason: string } | null;
  counters: {
    agentTurns: number;
    handoffs: number;
    retries: number;
    spawnedAgents: number;
    runtimeSeconds: number;
  };
  usage: {
    state: string;
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    turnsWithoutUsage: number;
    reportingTurns?: number;
  };
};
type UsageEvent = {
  agentId: string | null;
  workflowId: string | null;
  type: string;
  data: unknown;
};
const emptyUse = (): Use => ({ input: 0, output: 0, cache: 0, reports: 0 });
const fmt = (value: number) => value.toLocaleString();
const str = (v: unknown) => (typeof v === "string" ? v : "");
const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const tokenUse = (v: unknown) => {
  const u = asObject(v);
  const n = (key: string) =>
    typeof u[key] === "number" && Number.isFinite(u[key])
      ? (u[key] as number)
      : 0;
  const input = n("input_tokens");
  const output = n("output_tokens");
  return {
    input,
    output,
    cache:
      n("cached_input_tokens") +
      n("cache_creation_input_tokens") +
      n("cache_read_input_tokens"),
    reports: input || output ? 1 : 0,
  };
};

export function UsageAndLimits({
  data,
  events,
  openFeature,
}: {
  data: Snapshot;
  events: TeamEvent[];
  openFeature: (id: "settings" | "capabilities") => void;
}) {
  const [limits, setLimits] = useState<Record<string, Limits>>({});
  const [usageEvents, setUsageEvents] = useState<UsageEvent[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const projectIds = data.workflows.map((w) => w.id);
  const projectKey = projectIds.join("\0");
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all([
      Promise.all(
        projectIds.map(async (id) => {
          try {
            return [
              id,
              await api(`/workflows/${encodeURIComponent(id)}/limits`),
            ] as const;
          } catch {
            return [id, null] as const;
          }
        }),
      ),
      api(
        `/inspector/timeline?teamId=${encodeURIComponent(data.activeTeamId)}&minSeverity=debug&limit=5000`,
      ),
    ])
      .then(([projects, timeline]: any) => {
        if (!alive) return;
        setLimits(
          Object.fromEntries(
            projects
              .filter((x: any) => x[1])
              .map(([id, status]: [string, Limits]) => [id, status]),
          ),
        );
        setUsageEvents(
          timeline.entries.filter(
            (entry: any) =>
              (entry.type === "task.runtime" &&
                asObject(entry.data).type === "usage") ||
              entry.type === "runtime.usage",
          ),
        );
        setTruncated(!!timeline.truncated);
        setError("");
      })
      .catch(
        (e) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [projectKey, data.activeTeamId, events.length, refreshKey]);
  const byAgent = new Map<string, Use>();
  const byProject = new Map<string, Use>();
  const byEnvironment = new Map<string, Use>();
  for (const event of usageEvents) {
    const outer = asObject(event.data);
    const usage = event.type === "task.runtime" ? outer.data : event.data;
    const counted = tokenUse(usage);
    if (!counted.reports) continue;
    const add = (map: Map<string, Use>, id: string) => {
      const current = map.get(id) ?? emptyUse();
      current.input += counted.input;
      current.output += counted.output;
      current.cache += counted.cache;
      current.reports += counted.reports;
      map.set(id, current);
    };
    if (event.agentId) add(byAgent, event.agentId);
    if (event.workflowId) add(byProject, event.workflowId);
    const agent = data.agents.find((a) => a.id === event.agentId);
    if (agent) add(byEnvironment, agent.environment);
  }
  const providerRows = useMemo(() => {
    const environments = [...new Set(data.agents.map((a) => a.environment))];
    return environments.map((environment) => ({
      environment,
      agents: data.agents.filter((agent) => agent.environment === environment)
        .length,
      usage: byEnvironment.get(environment) ?? emptyUse(),
    }));
  }, [data.agents, usageEvents]);
  const total = [...byAgent.values()].reduce(
    (sum, u) => sum + u.input + u.output,
    0,
  );
  const reportedProjects = projectIds.filter(
    (id) => (limits[id]?.usage.totalTokens ?? 0) > 0,
  ).length;
  return (
    <div
      className="scroll section usage-dashboard"
      data-testid="usage-dashboard"
    >
      <header className="usage-head">
        <div>
          <span className="eyebrow">ACCOUNTING</span>
          <h2>Usage &amp; limits</h2>
          <p>
            One view of reported model use, per-project stopping limits and what
            each provider exposes.
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => setRefreshKey((n) => n + 1)}
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      {error && (
        <p role="alert" className="limit-error">
          Could not load all usage data: {error}
        </p>
      )}
      <div className="usage-summary-cards">
        <article>
          <small>Reported model tokens</small>
          <b>{total ? fmt(total) : "No provider totals reported"}</b>
          <span>
            {reportedProjects} of {projectIds.length} projects have reported
            totals
          </span>
        </article>
        <article>
          <small>Projects and runs</small>
          <b>{projectIds.length} projects</b>
          <span>
            {data.workflows.reduce((n, w) => n + w.tasks.length, 0)} tasks ·
            totals include only provider-reported tokens
          </span>
        </article>
        <article>
          <small>Subscription quotas</small>
          <b>Not exposed by connected CLIs</b>
          <span>
            AgentTeam can’t read plan quota or remaining balance from these
            runtimes.
          </span>
        </article>
      </div>
      {truncated && (
        <p className="hint">
          Showing the latest 5,000 usage events. Older events are omitted from
          the agent and provider totals.
        </p>
      )}
      <section className="usage-section">
        <h3>Provider runtimes</h3>
        <p className="hint">
          These are the runtimes your agents use. Reported token totals are
          available when a runtime sends them; account quota windows and
          remaining subscription limits are not exposed here.
        </p>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Runtime</th>
                <th>Agents</th>
                <th>Reported input / output</th>
                <th>Subscription quota</th>
              </tr>
            </thead>
            <tbody>
              {providerRows.map((row) => (
                <tr key={row.environment}>
                  <th>{row.environment}</th>
                  <td>{row.agents}</td>
                  <td>
                    {row.usage.reports
                      ? `${fmt(row.usage.input)} / ${fmt(row.usage.output)} tokens`
                      : "Not reported"}
                  </td>
                  <td>Not exposed</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="usage-section">
        <h3>By agent</h3>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Runtime</th>
                <th>Reported input / output</th>
                <th>Reports</th>
                <th>Concurrent task cap</th>
              </tr>
            </thead>
            <tbody>
              {data.agents
                .filter((agent) => agent.kind !== "team-assistant")
                .map((agent) => {
                  const u = byAgent.get(agent.id);
                  return (
                    <tr key={agent.id}>
                      <th>{agent.name}</th>
                      <td>{agent.environment}</td>
                      <td>
                        {u?.reports
                          ? `${fmt(u.input)} / ${fmt(u.output)} tokens`
                          : "Not reported"}
                      </td>
                      <td>{u?.reports ?? 0}</td>
                      <td>{agent.maxConcurrentInvocations ?? "Unlimited"}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
        <button
          className="text-button"
          onClick={() => openFeature("capabilities")}
        >
          Approximate instruction context by agent <ExternalLink size={13} />
        </button>
      </section>
      <section className="usage-section">
        <h3>By project</h3>
        {!data.workflows.length && (
          <p className="hint">
            Assign a project to see its task limits and reported usage here.
          </p>
        )}
        {data.workflows.map((workflow) => {
          const status = limits[workflow.id];
          const u = status?.usage;
          const observed = byProject.get(workflow.id);
          return (
            <article className="usage-project" key={workflow.id}>
              <div className="usage-project-head">
                <div>
                  <b>{workflow.name}</b>
                  <small>
                    {workflow.tasks.length} tasks · {workflow.status}
                  </small>
                </div>
                <span>
                  {u?.totalTokens != null
                    ? `${fmt(u.totalTokens)} reported tokens`
                    : observed?.reports
                      ? `${fmt(observed.input + observed.output)} reported tokens`
                      : "Token use not reported"}
                </span>
              </div>
              <div className="usage-project-details">
                <span>
                  {status
                    ? `${fmt(status.counters.runtimeSeconds)}s · ${status.counters.agentTurns} turns · ${status.counters.handoffs} handoffs`
                    : "Loading project limits…"}
                </span>
                {status?.trip && (
                  <b className="usage-trip">Stopped: {status.trip.reason}</b>
                )}
                <WorkflowLimits
                  workflowId={workflow.id}
                  act={async () => undefined}
                />
              </div>
            </article>
          );
        })}
      </section>
      <p className="usage-footnote">
        Token counts are reported by the provider and may be incomplete.
        Prompt-context estimates are separate and approximate. Subscription
        quota and cost are not inferred.
      </p>
    </div>
  );
}
