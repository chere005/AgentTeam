import {
  FEATURES,
  FEATURE_GROUPS,
  type FeatureId,
  type TabId,
} from "../features";
import { X } from "lucide-react";
import "./help-menu.css";

const tryIt: Record<FeatureId, string> = {
  projects: "Assign a project, then add a task and inspect its status.",
  review: "Choose an agent with a workspace and inspect its changed files.",
  graphs: "Open a project workflow to see its steps and gates.",
  trace:
    "Select a project, click a timeline event, then open its ⓘ summary or an agent node.",
  assistant:
    "Ask the Team Assistant for a small change and review its proposal.",
  files: "Select an agent with a folder and open a file.",
  git: "Attach a Git repository to an agent, then inspect its branch and changes.",
  preview: "Start a local dev server from an agent’s workspace.",
  library: "Insert an example team to explore a ready-made setup.",
  "team-settings": "Review the team’s roles, models and worker limits.",
  capabilities: "Open an agent’s skills, tools or knowledge section.",
  access: "Select an agent and inspect folder access and sharing rules.",
  inbox: "Open an approval, failure or waiting item.",
  inspector: "Select a recent run and follow its events and tool activity.",
  usage:
    "Review reported token use by project and agent, then expand a project for its limits.",
  recovery: "Open a stopped task and inspect its resume options.",
  shared: "Assign a project and inspect its shared fields and artifacts.",
  activity: "Run a small task and watch the event stream update.",
  settings: "Check provider connections, execution and saved layouts.",
};
const viewKeys = /Mac/i.test(navigator.platform)
  ? ["⌘1", "⌘2", "⌘3", "⌘4"]
  : ["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4"];

export function HelpMenu({
  close,
  open,
}: {
  close: () => void;
  open: (id: TabId | "team-chat") => void;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className="modal help-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Help and feature guide"
      >
        <header>
          <div>
            <span className="eyebrow">QUICK GUIDE</span>
            <h2>What can I do here?</h2>
          </div>
          <button className="icon" aria-label="Close help" onClick={close}>
            <X size={19} />
          </button>
        </header>
        <div className="modal-content help-menu-content">
          <p className="help-intro">
            Pick a view to open it. Each “Try” hint is a quick first step.
          </p>
          <section className="help-main-views">
            <article>
              <div>
                <b>Layout</b>
                <p>
                  Build and inspect the team graph and agent setup.{" "}
                  <kbd>{viewKeys[0]}</kbd>
                </p>
              </div>
              <button className="secondary" onClick={() => open("canvas")}>
                Open
              </button>
            </article>
            <article>
              <div>
                <b>Chat</b>
                <p>
                  Your shared chats appear first; agent roots open direct chats
                  and nest their side chats.
                </p>
                <small>
                  Try: open an agent chat, expand a handoff, then invite a
                  teammate.
                  <br />
                  <kbd>{viewKeys[1]}</kbd>
                </small>
              </div>
              <button className="secondary" onClick={() => open("team-chat")}>
                Open
              </button>
            </article>
            <article>
              <div>
                <b>Files</b>
                <p>
                  Browse, preview and edit text files in the current project.
                </p>
                <small>
                  Try: choose a project, open Files, select a text or Markdown
                  file. <kbd>{viewKeys[2]}</kbd>
                </small>
              </div>
              <button className="secondary" onClick={() => open("files")}>
                Open
              </button>
            </article>
            <article>
              <div>
                <b>Diff</b>
                <p>Review the current project’s code changes side by side.</p>
                <small>
                  Try: choose a project and open Diff. <kbd>{viewKeys[3]}</kbd>
                </small>
              </div>
              <button className="secondary" onClick={() => open("review")}>
                Open
              </button>
            </article>
          </section>
          {FEATURE_GROUPS.map((group) => (
            <section className="help-feature-group" key={group}>
              <h3>{group}</h3>
              {FEATURES.filter(
                (feature) =>
                  feature.group === group &&
                  feature.id !== "files" &&
                  feature.id !== "review",
              ).map((feature) => (
                <article key={feature.id}>
                  <div>
                    <b>{feature.name}</b>
                    <p>{feature.description}</p>
                    <small>Try: {tryIt[feature.id]}</small>
                  </div>
                  <button
                    className="secondary"
                    data-testid={`help-open-${feature.id}`}
                    onClick={() => open(feature.id)}
                  >
                    Open
                  </button>
                </article>
              ))}
            </section>
          ))}
          <section className="help-feature-group">
            <h3>Other</h3>
            {FEATURES.filter((feature) => feature.group === null).map(
              (feature) => (
                <article key={feature.id}>
                  <div>
                    <b>{feature.name}</b>
                    <p>{feature.description}</p>
                    <small>Try: {tryIt[feature.id]}</small>
                  </div>
                  <button
                    className="secondary"
                    data-testid={`help-open-${feature.id}`}
                    onClick={() => open(feature.id)}
                  >
                    Open
                  </button>
                </article>
              ),
            )}
          </section>
          <p className="help-footer">
            Press <kbd>⌘⇧P</kbd> for views and actions, or <kbd>⌘P</kbd> to
            fuzzy-search files and chats. Use <kbd>?</kbd> for shortcuts.
          </p>
        </div>
      </section>
    </div>
  );
}
