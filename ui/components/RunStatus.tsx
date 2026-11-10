import type { Snapshot } from "../api";
import {
  projectRunStatus,
  runStatusLabel,
  type RunStatus,
} from "../run-status";
import "./run-status.css";

/** The single status indicator for a run, task, agent or project. */
export function RunStatusBadge({
  status,
  title,
}: {
  status: RunStatus;
  title?: string;
}) {
  return (
    <span
      className={
        "badge run-status run-status-" +
        status +
        (status === "running" ? " green" : "")
      }
      data-run-status={status}
      title={title}
    >
      {runStatusLabel(status)}
    </span>
  );
}

type Project = Snapshot["workflows"][number];

/** The one project-context header, shown above every work view (canvas, chat, files, diff, tabs). */
export function ProjectContextBar({ project }: { project: Project | null }) {
  // No project: the top bar's Current project picker already says so; no empty bar in every view.
  if (!project) return null;
  const done = project.tasks.filter((t) => t.status === "completed").length;
  const folder = project.setup?.workspace?.split(/[\\/]/).filter(Boolean).pop();
  return (
    <div
      className="project-context-bar projects-current-context"
      data-testid="project-context"
      data-project-id={project.id}
    >
      <span>Current project</span>
      <b title={project.name}>{project.name}</b>
      <RunStatusBadge
        status={projectRunStatus(project.status)}
        title={project.status}
      />
      <small>
        {project.tasks.length
          ? `${done}/${project.tasks.length} tasks done`
          : "No tasks assigned"}
        {folder ? ` · ${folder}` : ""}
      </small>
    </div>
  );
}
