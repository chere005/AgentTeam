import { useEffect, useRef, useState } from "react";
import {
  Briefcase,
  Check,
  ChevronDown,
  Plus,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import { teamActivityLabel, MAIN_TEAM_ID } from "../team-view";
import type { TeamSummary } from "../api";
import "./team-switcher.css";

const statusText = (t: TeamSummary) =>
  t.status === "running"
    ? "running"
    : t.status === "attention"
      ? "needs attention"
      : "idle";

/**
 * Top-bar switcher naming the single active team. Lists every team with counts and status so
 * work in other teams is never silently out of sight, and manages teams (new, rename, delete).
 * Keyboard: Enter/Space opens, Up/Down move between teams, Escape closes and returns focus.
 */
export function TeamSwitcher({
  teams,
  active,
  switchTo,
  create,
  rename,
  remove,
  assignProject,
}: {
  teams: TeamSummary[];
  active: TeamSummary;
  switchTo: (id: string) => void;
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  /** Open the Projects pane's "Assign project" form for the active team. */
  assignProject?: () => void;
  remove: (
    id: string,
    options: { agents: "move" | "delete"; moveTo: string },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [mode, setMode] = useState<"list" | "new" | "rename" | "delete">("list"),
    [name, setName] = useState(""),
    [agentsChoice, setAgentsChoice] = useState<"move" | "delete">("move"),
    [moveTo, setMoveTo] = useState(MAIN_TEAM_ID),
    [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLUListElement>(null);
  const others = teams.filter((t) => t.id !== active.id);
  const otherRunning = others.reduce((n, t) => n + t.running, 0),
    otherAttention = others.reduce((n, t) => n + t.attention, 0);
  const close = () => {
    setOpen(false);
    setMode("list");
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setMode("list");
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    // Focus the active team so arrow keys start from it.
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
      ?.focus();
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setMode("list");
      setName("");
      setOpen(false);
      button.current?.focus();
    } catch {
      /* reported by the caller; the form stays open to retry */
    } finally {
      setBusy(false);
    }
  };
  const activity = teamActivityLabel(active);
  const othersLabel = [
    otherRunning ? `${otherRunning} running` : "",
    otherAttention ? `${otherAttention} need attention` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div className="team-switcher" ref={root}>
      <button
        ref={button}
        className={"team-switcher-button status-" + active.status}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Active team: ${active.name}, ${statusText(active)}${activity ? ", " + activity : ""}${othersLabel ? `. Other teams: ${othersLabel}` : ""}. Switch team`}
        data-testid="team-switcher"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={"team-dot " + active.status} aria-hidden="true" />
        <span className="team-switcher-text">
          <small>ACTIVE TEAM</small>
          <b data-testid="active-team-name">{active.name}</b>
        </span>
        <span className="team-counts" aria-hidden="true">
          {active.running > 0 && (
            <span className="team-chip running">{active.running} running</span>
          )}
          {active.attention > 0 && (
            <span className="team-chip attention">
              {active.attention} need{active.attention === 1 ? "s" : ""}{" "}
              attention
            </span>
          )}
        </span>
        {(otherRunning > 0 || otherAttention > 0) && (
          <span
            className={
              "team-others " + (otherAttention ? "attention" : "running")
            }
            data-testid="other-teams-indicator"
            aria-hidden="true"
            title={`Other teams: ${othersLabel}`}
          >
            +{otherRunning + otherAttention} elsewhere
          </span>
        )}
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="team-popup" role="group" aria-label="Teams">
          {mode === "list" && (
            <>
              <div className="team-popup-head">
                <span className="eyebrow">SWITCH TEAM</span>
                <small>
                  Work keeps running in every team; only the view changes.
                </small>
              </div>
              <ul
                ref={list}
                aria-label="Teams"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const items = [
                    ...(list.current?.querySelectorAll<HTMLButtonElement>(
                      "button.team-row",
                    ) ?? []),
                  ];
                  const at = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const next =
                    items[
                      (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                        items.length
                    ];
                  next?.focus();
                }}
              >
                {teams.map((t) => {
                  const label = teamActivityLabel(t);
                  return (
                    <li key={t.id}>
                      <button
                        className={
                          "team-row" + (t.id === active.id ? " current" : "")
                        }
                        aria-current={t.id === active.id ? "true" : undefined}
                        aria-label={`${t.name}: ${t.agents} agent${t.agents === 1 ? "" : "s"}, ${t.workflows} project${t.workflows === 1 ? "" : "s"}, ${statusText(t)}${label ? ", " + label : ""}${t.id === active.id ? " (active)" : ""}`}
                        onClick={() => {
                          if (t.id !== active.id) switchTo(t.id);
                          close();
                        }}
                      >
                        <span className={"team-dot " + t.status} />
                        <span className="team-row-text">
                          <b>{t.name}</b>
                          <small>
                            {t.agents} agent{t.agents === 1 ? "" : "s"} ·{" "}
                            {t.workflows} project
                            {t.workflows === 1 ? "" : "s"}
                            {label ? " · " + label : ""}
                          </small>
                        </span>
                        {t.id === active.id && <Check size={15} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="team-popup-actions">
                {assignProject && (
                  <button
                    className="primary"
                    aria-label={`Assign a project to ${active.name}`}
                    onClick={() => {
                      close();
                      assignProject();
                    }}
                  >
                    <Briefcase size={14} />
                    Assign project
                  </button>
                )}
                <button
                  onClick={() => {
                    setName("");
                    setMode("new");
                  }}
                >
                  <Plus size={14} />
                  New team
                </button>
                <button
                  aria-label={`Rename ${active.name}`}
                  onClick={() => {
                    setName(active.name);
                    setMode("rename");
                  }}
                >
                  <Pencil size={14} />
                  Rename
                </button>
                <button
                  className="danger"
                  aria-label={`Delete ${active.name}`}
                  disabled={active.id === MAIN_TEAM_ID}
                  title={
                    active.id === MAIN_TEAM_ID
                      ? "The Main team cannot be deleted"
                      : undefined
                  }
                  onClick={() => {
                    setAgentsChoice("move");
                    setMoveTo(MAIN_TEAM_ID);
                    setMode("delete");
                  }}
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              </div>
            </>
          )}
          {(mode === "new" || mode === "rename") && (
            <form
              className="team-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void run(() =>
                  mode === "new"
                    ? create(name.trim())
                    : rename(active.id, name.trim()),
                );
              }}
            >
              <label>
                {mode === "new" ? "New team name" : `Rename “${active.name}”`}
                <input
                  autoFocus
                  aria-label="Team name"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {mode === "new" && (
                <small>
                  The new team starts empty and becomes the active team.
                </small>
              )}
              <div className="row">
                <button type="button" onClick={() => setMode("list")}>
                  Cancel
                </button>
                <button
                  className="primary"
                  type="submit"
                  disabled={!name.trim() || busy}
                >
                  {mode === "new" ? "Create team" : "Save name"}
                </button>
              </div>
            </form>
          )}
          {mode === "delete" && (
            <form
              className="team-form"
              aria-label={`Delete ${active.name}`}
              onSubmit={(e) => {
                e.preventDefault();
                void run(() =>
                  remove(active.id, { agents: agentsChoice, moveTo }),
                );
              }}
            >
              <b>Delete “{active.name}”?</b>
              {active.running > 0 && (
                <p className="team-warn" role="alert">
                  This team has running work. Wait for it or stop it first;
                  deleting is refused while anything runs.
                </p>
              )}
              <label>
                Move its projects{agentsChoice === "move" ? " and agents" : ""}{" "}
                to
                <select
                  value={moveTo}
                  onChange={(e) => setMoveTo(e.target.value)}
                >
                  {others.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend>Agents ({active.agents})</legend>
                <label className="inline">
                  <input
                    type="radio"
                    name="team-agents"
                    checked={agentsChoice === "move"}
                    onChange={() => setAgentsChoice("move")}
                  />
                  Move them (recommended)
                </label>
                <label className="inline">
                  <input
                    type="radio"
                    name="team-agents"
                    checked={agentsChoice === "delete"}
                    onChange={() => setAgentsChoice("delete")}
                  />
                  Delete them (refused if any has tasks, conversations, child
                  agents or projects)
                </label>
              </fieldset>
              <div className="row">
                <button type="button" onClick={() => setMode("list")}>
                  Cancel
                </button>
                <button
                  className="danger"
                  type="submit"
                  disabled={busy || active.running > 0}
                >
                  Delete team
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Banner shown whenever the active team changed for a reason other than the switcher. */
export function TeamNotice({
  text,
  dismiss,
}: {
  text: string;
  dismiss: () => void;
}) {
  return (
    <div
      className="team-notice"
      role="note"
      aria-live="polite"
      data-testid="team-notice"
    >
      <Users size={15} aria-hidden="true" />
      <span>{text}</span>
      <button className="text-button" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
