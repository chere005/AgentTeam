import { useCallback, useEffect, useState } from "react";
import type { ExecutionProjects } from "../../src/execution-projects";
import { api } from "../api";

type View = ReturnType<ExecutionProjects["view"]>;
const LANGUAGE_NAMES: Record<string, string> = {
  "c++": "cpp",
  js: "javascript",
  ts: "typescript",
};
/** The configure body for one answered planner question. */
const answerPayload = (id: string, text: string) =>
  id === "digits"
    ? { digits: Number(text) }
    : id === "languages"
      ? {
          languages: text
            .split(/[,\s]+/)
            .filter(Boolean)
            .map((l) => LANGUAGE_NAMES[l.toLowerCase()] ?? l.toLowerCase()),
        }
      : { expectedStdout: text };
export function ExecutionProjectCard({
  workflowId,
  act,
}: {
  workflowId: string;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<View | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async () => setView(await api(`/projects/${workflowId}/execution`)),
    [workflowId],
  );
  useEffect(() => {
    void load().catch(() => {});
    const off = window.agentteam?.onEvent((event) => {
      if (/^(execution|verification|project|contract|task)[.]/.test(event.type))
        void load().catch(() => {});
    });
    return () => off?.();
  }, [load]);
  if (!view?.plan.supported) return null;
  const project = view.project;
  const perform = async (suffix: string, data: unknown = {}) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await act(async () => {
        try {
          await api(
            `/projects/${workflowId}/execution/${suffix}`,
            "POST",
            data,
          );
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
      await load();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="execution-project-summary"
      aria-label="Implementation and review"
      data-testid="execution-project"
    >
      <h4>
        {project ? "Implementation and review" : "Prepared implementation"}
      </h4>
      <ul>
        {view.plan.outputs.map((output) => (
          <li key={output.entry}>
            <strong>{output.entry}</strong> · {output.language} ·{" "}
            {output.agentName}
          </li>
        ))}
      </ul>
      <p>{view.plan.verification.description}</p>
      {!project && (
        <p>
          Start assignment authorizes AgentTeam to execute these saved programs
          in its restricted verification sandbox and send the verified source to
          the listed reviewers.
        </p>
      )}
      <p>
        {view.plan.reviewers.length
          ? `Required reviewers: ${view.plan.reviewers.map((r) => r.name).join(", ")}`
          : "Independent execution verification is required."}
      </p>
      <p data-testid="planner-reading">
        {(project?.reading ?? view.plan.reading).summary}
      </p>
      {(project?.reading ?? view.plan.reading).questions.map((q) => (
        <div key={q.id} data-testid={`planner-question-${q.id}`}>
          <label>
            {q.prompt}
            <input
              aria-label={q.prompt}
              disabled={!!project || !!q.answer}
              placeholder={q.suggestion ?? ""}
              value={q.answer ?? answers[q.id] ?? ""}
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
            />
          </label>
          {!project && !q.answer && (
            <>
              <button
                disabled={busy || !(answers[q.id] ?? q.suggestion)}
                onClick={() =>
                  void perform(
                    "configure",
                    answerPayload(q.id, answers[q.id] ?? q.suggestion!),
                  )
                }
              >
                {answers[q.id] ? "Answer" : "Use suggestion"}
              </button>
            </>
          )}
        </div>
      ))}
      {!project && view.plan.issues.length > 0 && (
        <ul>
          {view.plan.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {project && (
        <>
          <p role="status">
            <strong>{project.phase.replaceAll("-", " ")}</strong> · correction
            round {project.round} of {project.maxCorrectionRounds}
          </p>
          {project.message && <p>{project.message}</p>}
          {view.evidence
            .filter((e) => e !== null)
            .map((e) => (
              <details key={e.id}>
                <summary>
                  {e.passed ? "Execution verified" : "Execution not verified"} ·{" "}
                  {e.spec.entry}
                </summary>
                <p>{e.reason}</p>
                <p>
                  Source snapshot: <code>{e.snapshotHash}</code>
                </p>
                <pre>{e.stdout}</pre>
                {e.stderr && <pre>{e.stderr}</pre>}
              </details>
            ))}
          {view.reviews.map((review) => (
            <p key={review.taskId}>
              {view.plan.reviewers.find(
                (person) => person.id === review.reviewerId,
              )?.name ?? "Review"}
              : {review.verdict?.verdict ?? review.task.status}
            </p>
          ))}
          {project.phase === "needs-attention" && (
            <button
              disabled={busy || project.round >= project.maxCorrectionRounds}
              onClick={() => void perform("retry")}
            >
              Start correction attempt
            </button>
          )}
          {!["completed", "cancelled"].includes(project.phase) && (
            <button disabled={busy} onClick={() => void perform("cancel")}>
              Cancel execution project
            </button>
          )}
        </>
      )}
      {error && (
        <p className="bad-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
