import { useEffect, useState } from "react";
import { api } from "../api";
import "./team-settings.css";

/**
 * Lifecycle of one project card (src/project-lifecycle.ts): Complete / Archive / Reopen, the
 * "needs re-verify" reason of a pipeline project, and, once the project ended (archived,
 * completed, or every task finished), the OFFER to detach the folders this project attached to
 * the team's agents. Nothing is detached without the user's click; folders attached before the
 * project or used by another active project of the team are listed as kept, with the reason.
 */
type Item = {
  agentId: string;
  agentName: string;
  path: string;
  access: string;
};
type ProjectView = {
  id: string;
  state: "active" | "completed" | "archived";
  finished: boolean;
  verification: { state: string; reasons: string[] } | null;
  detach: {
    offer: boolean;
    dismissed: boolean;
    recorded: boolean;
    candidates: Item[];
    kept: (Item & { reason: string })[];
  };
};

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^.*?Error: /, "");

export function ProjectLifecycle({
  workflow,
  act,
}: {
  workflow: { id: string; name: string; status: string; paused: boolean };
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [view, setView] = useState<ProjectView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const state = (workflow as { lifecycle?: { state: string } }).lifecycle
    ?.state;
  const load = () =>
    api(`/projects/${workflow.id}`)
      .then((v: ProjectView) => setView(v))
      .catch((e) => setError(message(e)));
  useEffect(() => {
    void load();
  }, [workflow.id, workflow.status, workflow.paused, state]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await act(async () => undefined);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (!view) return null;
  const life = (action: string) =>
    run(() => api(`/projects/${workflow.id}/lifecycle`, "POST", { action }));
  const v = view.verification;
  return (
    <div className="project-lifecycle" data-testid="project-lifecycle">
      <div className="row wrap">
        {view.state !== "active" && (
          <span className="badge" data-testid="project-state">
            {view.state === "archived" ? "Archived" : "Completed"}
          </span>
        )}
        {view.state === "active" && view.finished && (
          <button
            disabled={busy}
            title="Mark this project as done (every task finished)"
            onClick={() => life("complete")}
          >
            Complete project
          </button>
        )}
        {view.state !== "archived" && (
          <button
            disabled={busy}
            title="Hide this project and keep it paused until reopened"
            onClick={() => life("archive")}
          >
            Archive
          </button>
        )}
        {view.state !== "active" && (
          <button
            disabled={busy}
            title="Make the project active again (it stays paused until you resume it)"
            onClick={() => life("reopen")}
          >
            Reopen
          </button>
        )}
      </div>
      {v && v.state === "stale" && (
        <p className="bad" data-testid="needs-reverify">
          Needs re-verify: {v.reasons.join("; ")}. Run “Prepare and verify”
          again before resuming.
        </p>
      )}
      {view.detach.offer && (
        <section
          className="detach-offer"
          role="region"
          aria-label="Detach project folders"
        >
          <p>
            <b>This project has ended.</b> Detach the folders it attached to{" "}
            {new Set(view.detach.candidates.map((c) => c.agentId)).size}{" "}
            agent(s)? Folders that were attached before the project, or that
            another active project of this team uses, stay attached.
          </p>
          <ul className="ts-list">
            {view.detach.candidates.map((c) => (
              <li key={c.agentId + c.path}>
                {c.agentName}: {c.path}{" "}
                <small className="quiet">
                  ({c.access === "write" ? "can read and edit" : "can read"})
                </small>
              </li>
            ))}
            {view.detach.kept.map((c) => (
              <li key={"k" + c.agentId + c.path} className="quiet">
                {c.agentName}: {c.path} stays attached — {c.reason}
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/projects/${workflow.id}/detach`, "POST", {
                    items: view.detach.candidates.map((c) => ({
                      agentId: c.agentId,
                      path: c.path,
                    })),
                  }),
                )
              }
            >
              Detach folders
            </button>
            <button
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/projects/${workflow.id}/detach`, "POST", {
                    dismiss: true,
                  }),
                )
              }
            >
              Keep attached
            </button>
          </div>
        </section>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
