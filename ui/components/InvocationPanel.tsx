import { useEffect, useState } from "react";
import type { Agent, Snapshot } from "../api";
import { api } from "../api";
import { invocationSummary, waitReasonText } from "../../src/invocation-view";
import { usePersistedDetails } from "./persisted-details";
import "./runtime-ui.css";

type InvocationRecord = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  request: { title: string; instructions?: string };
  createdAt: string;
};

export function InvocationPanel({
  agent,
  limit,
  data,
}: {
  agent: Agent;
  limit: number | null;
  data: Snapshot;
}) {
  const names = Object.fromEntries(data.agents.map((a) => [a.id, a.name]));
  const reasons: Record<string, string | null> = {};
  const tasks = data.workflows.flatMap((w) => w.tasks);
  for (const a of data.activity)
    for (const t of a.queuedTasks) reasons[t.id] = t.waitReason;
  const summary = invocationSummary(agent.id, limit, tasks, names, reasons);
  const [records, setRecords] = useState<InvocationRecord[]>([]);
  const active = summary.running.length > 0 || summary.waiting.length > 0;
  const [open, onToggle] = usePersistedDetails(
    agent.id,
    "conversations",
    active,
  );

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = () =>
      api("/orchestration/invocations")
        .then((items) => {
          if (alive) setRecords(items);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open]);

  const own = records
    .filter((record) => record.fromAgentId === agent.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const byTask = new Map(tasks.map((task) => [task.id, task]));
  return (
    <details
      className="agent-section invocation-history"
      open={open}
      onToggle={onToggle}
    >
      <summary>
        <b>Agent conversations</b>
        <small>
          {own.length ? `${own.length} handoffs` : "No handoffs yet"}
        </small>
      </summary>
      <section
        className="invocation-panel"
        aria-label="Invocation limit"
        data-testid="invocation-panel"
      >
        <h4>
          Invocation limit: {limit === null ? "Unlimited" : limit} · running{" "}
          {summary.running.length}
          {limit === null ? "" : " / " + limit}
        </h4>
        <span>{summary.explanation}</span>
        {summary.running.length > 0 && (
          <ul aria-label="Running children">
            {summary.running.map((t) => (
              <li key={t.id}>
                Running · {t.agentName}: {t.title}
              </li>
            ))}
          </ul>
        )}
        {summary.waiting.length > 0 && (
          <ul aria-label="Waiting invocations">
            {summary.waiting.map((t) => (
              <li key={t.id}>
                Waiting · {t.agentName}: {t.title} (
                {waitReasonText[t.reason] ?? t.reason})
              </li>
            ))}
          </ul>
        )}
        {own.map((record) => {
          const task = byTask.get(record.id);
          return (
            <article className="invocation-exchange" key={record.id}>
              <b>
                {names[record.fromAgentId] ?? "Agent"} →{" "}
                {names[record.toAgentId] ?? "Teammate"}: {record.request.title}
              </b>
              <small className="quiet">{task?.status ?? "queued"}</small>
              {record.request.instructions && (
                <p>
                  <b>Request</b>
                  <br />
                  {record.request.instructions}
                </p>
              )}
              {task?.result && (
                <p>
                  <b>
                    {task.status === "completed" ? "Reply" : "Latest result"}
                  </b>
                  <br />
                  {task.result}
                </p>
              )}
            </article>
          );
        })}
        <small className="quiet">
          Requests and teammate results are recorded here. Native provider
          subagents remain outside AgentTeam's task tracking.
        </small>
      </section>
    </details>
  );
}
