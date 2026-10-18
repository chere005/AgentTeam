import type { Agent, Snapshot } from "../api";
import { invocationSummary, waitReasonText } from "../../src/invocation-view";
import "./runtime-ui.css";
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
  for (const a of data.activity)
    for (const t of a.queuedTasks) reasons[t.id] = t.waitReason;
  const summary = invocationSummary(
    agent.id,
    limit,
    data.workflows.flatMap((w) => w.tasks),
    names,
    reasons,
  );
  return (
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
      <small className="quiet">
        Only tasks this agent invoked count. Native provider subagents are not
        tracked. The displayed limit is the unsaved value above.
      </small>
    </section>
  );
}
