import { useState } from "react";
import { Pause, Play } from "lucide-react";
import { api, type WorkflowSetup } from "../api";
import "./readiness.css";

type Project = {
  id: string;
  paused: boolean;
  setup?: WorkflowSetup;
};
/**
 * Pause/Resume of one project card. Resume runs the checks its gates need first (backend
 * `resumeProject`): an unprepared pipeline project is prepared (which assigns workers and creates
 * worktrees once every check passed), others get a fresh model check. A refusal is shown right
 * here with each failed check on its own line.
 */
export function ProjectResume({
  workflow,
  refresh,
}: {
  workflow: Project;
  refresh: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const preflight = workflow.setup?.preflight as
    { verified?: boolean } | null | undefined;
  const prepares =
    workflow.paused &&
    !!workflow.setup?.requiresPreflight &&
    !preflight?.verified;
  const label = !workflow.paused
    ? "Pause project"
    : prepares
      ? "Prepare and resume"
      : "Resume project";
  const title = !workflow.paused
    ? "Pause project"
    : prepares
      ? "Prepare and resume: checks providers, models, caps, read-only roles, the workspace and parallel access; only if every check passes are workers assigned, worktrees created and the project started"
      : workflow.setup?.requiresModelVerification
        ? "Resume project (its models are checked again first)"
        : "Resume project";
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/workflows/" + workflow.id + "/pause", "POST", {
        paused: !workflow.paused,
      });
      await refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // "The … did not pass: a; b; c" → a heading and one line per failed check.
      const at = message.indexOf(": ");
      const head = at > 0 ? message.slice(0, at) : message;
      const rest = at > 0 ? message.slice(at + 2).split("; ") : [];
      setError([head, ...rest]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        className="icon"
        title={title}
        aria-label={label}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {workflow.paused ? <Play size={15} /> : <Pause size={15} />}
      </button>
      {busy && prepares && (
        <small className="project-resume-error quiet" role="status">
          Preparing: running the checks…
        </small>
      )}
      {error && (
        <div
          className="project-resume-error blocker"
          role="alert"
          data-testid="resume-error"
        >
          <span>{error[0]}</span>
          {error.length > 1 && (
            <ul>
              {error.slice(1).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
