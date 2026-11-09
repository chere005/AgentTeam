import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FolderOpen } from "lucide-react";
import type { ProjectSetupService } from "../../src/project-setup";
import type { FolderProbeResult } from "../../src/folder-access";
import type { LaunchReadiness } from "../../src/launch-readiness";
import type { SetupAction } from "../../src/launch-readiness";
import { api, type Snapshot } from "../api";
import { setupCardPlacement } from "../setup-placement";
import "./project-setup.css";
import { ExecutionProjectCard } from "./ExecutionProject";

type SetupView = ReturnType<ProjectSetupService["view"]>;
type NoticeView = ReturnType<LaunchReadiness["delegationReadiness"]>;
type Act = (fn: () => Promise<unknown>) => Promise<void>;
const changed =
  /^(project\.|contract\.|task\.|agent\.|workflow\.|runtime\.|execution\.|folder\.)/;
const readingLabels = {
  "response-only": "Discuss or analyze",
  "file-edit": "Create or edit files",
  "executable-implementation": "Build and run code",
};

/** One event-driven setup view; no renderer-side readiness or permission decisions. */
export function ProjectSetupCard({
  workflowId,
  act,
  repair,
  children,
}: {
  workflowId: string;
  act: Act;
  repair?: (action: SetupAction) => void;
  children?: ReactNode;
}) {
  const [view, setView] = useState<SetupView | null>(null);
  const [folder, setFolder] = useState("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [widen, setWiden] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");
  // What the system said about the folder in the field (probed when the field is left, after a
  // choice from the native picker, and for "Check again").
  const [check, setCheck] = useState<{
    path: string;
    result: FolderProbeResult;
  } | null>(null);
  const requested = useRef(new Set<string>());
  const dirty = useRef(false);
  const runLock = useRef(false);
  const started = useRef(false);
  const id = useId();
  const load = useCallback(async () => {
    const next: SetupView = await api(`/projects/${workflowId}/setup`);
    setView(next);
    if (!dirty.current) {
      setFolder(next.proposal.folder ?? "");
      setParticipants(next.proposal.participants.map((p) => p.agentId));
      const known = next.proposal.checks.find(
        (c) => c.path === next.proposal.folder,
      )?.result;
      if (known) setCheck({ path: next.proposal.folder, result: known });
    }
    if (next.start?.startedAt) started.current = true;
  }, [workflowId]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (active) void load().catch(() => {});
      }, 100);
    };
    void load().catch(() => {});
    const off = window.agentteam?.onEvent((e) => {
      if (changed.test(e.type)) refresh();
    });
    return () => {
      active = false;
      clearTimeout(timer);
      off?.();
    };
  }, [load]);
  const pendingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);
  // The folder now in the field: a repeated question for another folder is dropped.
  const fieldFolder = useRef(folder);
  fieldFolder.current = folder;
  /**
   * Ask the system about a folder (the backend probes the app process and a child program). The
   * backend decides the access level from this project's approved roles; an answer that has not
   * come yet (an unanswered macOS prompt) is shown as waiting and asked about again until it has.
   */
  const probe = async (path: string, force = false, attempt = 0) => {
    const target = path.trim();
    clearTimeout(pendingTimer.current);
    if (!target) {
      setCheck(null);
      return null;
    }
    try {
      const result: FolderProbeResult = await api(
        "/folder-access/probe",
        "POST",
        { path: target, workflowId, force, waitMs: 1500 },
      );
      if (attempt > 0 && fieldFolder.current.trim() !== target) return null;
      setCheck({ path: target, result });
      if (!result.ok && result.code === "folder-probe-pending" && attempt < 150)
        pendingTimer.current = setTimeout(
          () => void probe(target, false, attempt + 1).then(() => load()),
          2000,
        );
      return result;
    } catch {
      setCheck(null); // not a usable path at all: Apply says why
      return null;
    }
  };
  // A folder macOS protects that was never asked about is checked as soon as the card shows it,
  // so the system prompt (and a refusal) comes before Start, not after wasted provider calls.
  useEffect(() => {
    for (const item of view?.proposal.checks ?? [])
      if (item.needsCheck && !requested.current.has(item.path)) {
        requested.current.add(item.path);
        void probe(item.path).then(() => load().catch(() => {}));
      }
  }, [view]);
  const chooseNative = async () => {
    const selected = await window.agentteam.chooseFolder();
    if (selected) {
      dirty.current = true;
      setFolder(selected);
      await probe(selected);
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    if (runLock.current) return;
    runLock.current = true;
    setBusy(true);
    setError("");
    setOutcome("");
    try {
      // Expected setup refusals belong on this card; App.act otherwise consumes them into
      // the global error banner before the local handler can explain the next action.
      await act(async () => {
        try {
          await fn();
        } catch (e) {
          // The real error is always shown (a refused folder's text is shown once, beside the
          // field, so it is left out here when the field already says it); the folder is asked
          // about again so the field shows today's answer.
          setError(e instanceof Error ? e.message : String(e));
          if (folder.trim()) void probe(folder);
        }
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runLock.current = false;
      setBusy(false);
    }
  };
  if (
    !view ||
    (!children &&
      !view.blockers.length &&
      !view.unresolvedChecks.length &&
      !view.applied.length &&
      !view.start)
  )
    return null;
  const selectParticipant = (agentId: string, selected: boolean) => {
    dirty.current = true;
    setParticipants((old) =>
      selected ? [...old, agentId] : old.filter((v) => v !== agentId),
    );
  };
  return (
    <section
      className="project-setup-card"
      aria-label={`Set up ${view.name}`}
      data-testid="project-setup-card"
      data-workflow-id={workflowId}
    >
      <header className="row between">
        <h4>Project setup</h4>
        <span className={`badge ${view.state === "ready" ? "green" : ""}`}>
          {view.state === "ready" ? "Ready" : "Setup required"}
        </span>
      </header>
      <p className="setup-goal">{view.name}</p>
      {view.contract && (
        <label className="setup-reading">
          How this request will run
          <select
            aria-label="Request interpretation"
            value={view.contract.workKind}
            disabled={busy}
            onChange={(e) =>
              void run(() =>
                api(`/projects/${workflowId}/contract`, "POST", {
                  workKind: e.target.value,
                }),
              )
            }
          >
            {Object.entries(readingLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {view.blockers.length > 0 && (
        <details className="setup-details">
          <summary>{view.blockers.length} participants need setup</summary>
          <ul className="setup-blockers" data-testid="setup-blockers">
            {view.blockers.map((blocker) => (
              <li key={blocker.agentId}>
                <b>{blocker.agentName}</b>
                <ul>
                  {blocker.issues.map((issue, i) => (
                    <li key={`${issue.code}-${i}`}>
                      {issue.message}
                      {issue.fix && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            if (issue.fix?.kind === "confirm-check")
                              document
                                .getElementById(`${id}-checks`)
                                ?.scrollIntoView({ block: "nearest" });
                            else if (
                              issue.fix?.kind === "choose-project-folder"
                            )
                              // The native picker: a folder chosen in the system dialog is
                              // normally allowed for the app; the probe confirms it.
                              void run(chooseNative);
                            else if (issue.fix?.kind === "allow-folder-access")
                              // After allowing it in System Settings: ask the system again.
                              void run(async () => {
                                const again = await probe(
                                  issue.fix?.path ?? folder,
                                  true,
                                );
                                setOutcome(
                                  again?.ok
                                    ? "AgentTeam can use this folder."
                                    : "",
                                );
                              });
                            else if (
                              ["attach-folder", "grant-write-access"].includes(
                                issue.fix?.kind ?? "",
                              )
                            )
                              document.getElementById(`${id}-folder`)?.focus();
                            else if (issue.fix) repair?.(issue.fix);
                          }}
                        >
                          {issue.fix.label}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
      {view.proposal.participants.length > 0 && (
        <details className="setup-details" open={!view.start?.startedAt}>
          <summary>
            Project folder and access
            {view.start?.startedAt && folder ? ` · ${folder}` : ""}
          </summary>
          <form
            aria-label="Project folder setup"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = await api(
                  `/projects/${workflowId}/setup`,
                  "POST",
                  {
                    folder,
                    participants,
                    widen,
                  },
                );
                dirty.current = false;
                setOutcome(
                  result.outcome
                    ? `Folder applied. ${result.outcome.requeued.length} saved tasks ready to continue.`
                    : "Folder applied.",
                );
              });
            }}
          >
            <label htmlFor={`${id}-folder`}>Project folder</label>
            <div className="setup-folder">
              <input
                id={`${id}-folder`}
                list={`${id}-folders`}
                value={folder}
                disabled={busy}
                placeholder="Choose a folder for this project"
                onChange={(e) => {
                  dirty.current = true;
                  setFolder(e.target.value);
                }}
                // A typed path stays possible; the system is asked when the field is left.
                onBlur={() => void probe(folder)}
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void run(chooseNative)}
              >
                <FolderOpen size={14} /> Browse
              </button>
            </div>
            <datalist id={`${id}-folders`}>
              {[
                ...new Set([
                  ...view.proposal.candidates,
                  view.proposal.defaultFolder,
                ]),
              ].map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            {check && check.path === folder.trim() && !check.result.ok && (
              <div
                className={`setup-folder-problem${
                  check.result.code === "folder-probe-pending" ? " waiting" : ""
                }`}
                role={
                  check.result.code === "folder-probe-pending"
                    ? "status"
                    : "alert"
                }
                data-testid="setup-folder-check"
              >
                <p>{check.result.message}</p>
                <p>{check.result.fix}</p>
                <div className="row wrap">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void probe(folder, true)}
                  >
                    Check again
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(chooseNative)}
                  >
                    Choose another folder
                  </button>
                  {view.proposal.defaultFolder !== folder.trim() && (
                    <button
                      type="button"
                      className="secondary"
                      title={view.proposal.defaultFolder}
                      disabled={busy}
                      onClick={() => {
                        dirty.current = true;
                        setFolder(view.proposal.defaultFolder);
                        setCheck(null);
                      }}
                    >
                      Use AgentTeam's projects folder
                    </button>
                  )}
                </div>
              </div>
            )}
            {check && check.path === folder.trim() && check.result.ok && (
              <small className="setup-folder-ok" role="status">
                AgentTeam can use this folder.
              </small>
            )}
            {check &&
              check.path === folder.trim() &&
              check.result.ok &&
              check.result.warning && (
                <small
                  className="setup-folder-warning"
                  role="status"
                  data-testid="setup-folder-warning"
                >
                  {check.result.warning.message}
                </small>
              )}
            {view.proposal.createsFolder &&
              folder.trim() === view.proposal.folder && (
                <small>AgentTeam creates this folder when you apply.</small>
              )}
            <details className="setup-details">
              <summary>
                Access for {participants.length} participants ·{" "}
                {
                  view.proposal.participants.filter(
                    (p) =>
                      participants.includes(p.agentId) && p.access === "write",
                  ).length
                }{" "}
                can edit
              </summary>
              <fieldset disabled={busy} className="setup-participants">
                <legend>Participants and access</legend>
                {view.proposal.participants.map((p) => (
                  <div className="setup-participant" key={p.agentId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={participants.includes(p.agentId)}
                        onChange={(e) =>
                          selectParticipant(p.agentId, e.target.checked)
                        }
                      />
                      <span>
                        <b>{p.name}</b>
                        <small>
                          {p.roleClass} ·{" "}
                          {p.access === "write" ? "Read and edit" : "Read only"}
                          {p.ready ? " · Ready" : " · Setup required"}
                        </small>
                        {p.scope && (
                          <small className="setup-path">{p.scope}</small>
                        )}
                      </span>
                    </label>
                    {p.access === "write" &&
                      participants.includes(p.agentId) && (
                        <label className="setup-widen">
                          <input
                            type="checkbox"
                            checked={widen.includes(p.agentId)}
                            onChange={(e) =>
                              setWiden((old) =>
                                e.target.checked
                                  ? [...old, p.agentId]
                                  : old.filter((v) => v !== p.agentId),
                              )
                            }
                          />
                          Allow editing if this folder is currently read only
                        </label>
                      )}
                  </div>
                ))}
              </fieldset>
            </details>
            <button
              type="submit"
              disabled={busy || !folder.trim() || !participants.length}
              data-testid="setup-apply"
            >
              Apply folder and access
            </button>
          </form>
        </details>
      )}
      {view.unresolvedChecks.length > 0 && (
        <div className="setup-checks" id={`${id}-checks`}>
          <h5>Checks awaiting your decision</h5>
          {view.unresolvedChecks.map((check) => (
            <PendingCheck
              key={`${check.contractId}-${check.slot}`}
              item={check}
              disabled={busy}
              decide={(body) =>
                run(() =>
                  api(`/projects/${workflowId}/contract/checks`, "POST", {
                    contractId: check.contractId,
                    slot: check.slot,
                    ...body,
                  }),
                )
              }
            />
          ))}
        </div>
      )}
      {children}
      {view.executionPlan && (
        <ExecutionProjectCard workflowId={workflowId} act={act} />
      )}
      {view.start && (
        <div className="row wrap">
          <button
            data-testid="setup-start"
            disabled={
              busy ||
              !view.start.available ||
              started.current ||
              (!!view.executionPlan && !view.executionPlan.ready)
            }
            title={view.start.reason ?? undefined}
            onClick={() => {
              if (started.current) return;
              started.current = true;
              void run(async () => {
                try {
                  await api(`/projects/${workflowId}/setup/start`, "POST", {});
                  setOutcome("Request started.");
                } catch (e) {
                  started.current = false;
                  throw e;
                }
              });
            }}
          >
            {view.start.startedAt ? "Request started" : "Start saved request"}
          </button>
          {view.start.reason && <small>{view.start.reason}</small>}
        </div>
      )}
      {outcome && <p role="status">{outcome}</p>}
      {error &&
        !(
          check &&
          check.path === folder.trim() &&
          !check.result.ok &&
          error.includes(check.result.message)
        ) && (
          <p className="bad-text" role="alert">
            {error}
          </p>
        )}
    </section>
  );
}

function PendingCheck({
  item,
  disabled,
  decide,
}: {
  item: SetupView["unresolvedChecks"][number];
  disabled: boolean;
  decide: (body: { pattern?: string; withdraw?: boolean }) => Promise<void>;
}) {
  const pattern = "pattern" in item.check ? item.check.pattern : null;
  const [value, setValue] = useState(pattern ?? "");
  return (
    <form
      className="setup-check"
      onSubmit={(e) => {
        e.preventDefault();
        void decide(pattern === null ? {} : { pattern: value });
      }}
    >
      <b>{item.check.type}</b>
      {"path" in item.check && <code>{item.check.path}</code>}
      {item.note && <p>{item.note}</p>}
      {pattern !== null ? (
        <label>
          Expected content or pattern
          <textarea
            aria-label="Check pattern"
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      ) : (
        <pre>{JSON.stringify(item.check, null, 2)}</pre>
      )}
      <div className="row wrap">
        <button
          type="submit"
          disabled={disabled}
          data-testid="setup-confirm-check"
        >
          Confirm check
        </button>
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => void decide({ withdraw: true })}
        >
          Withdraw check
        </button>
      </div>
    </form>
  );
}

export function AgentSetupCards({
  agentId,
  data,
  act,
  repair,
  placement,
}: {
  agentId: string;
  data: Snapshot;
  act: Act;
  repair?: (action: SetupAction) => void;
  /** "active": unfinished work, shown after the messages; "history": finished, above them. */
  placement: "active" | "history";
}) {
  return (
    <>
      {data.workflows
        .filter(
          (w) =>
            (w.ownerId === agentId ||
              w.tasks.some((t) => t.agentId === agentId)) &&
            setupCardPlacement(w) === placement,
        )
        .map((w) => (
          <ProjectSetupCard
            key={w.id}
            workflowId={w.id}
            act={act}
            repair={repair}
          />
        ))}
    </>
  );
}

export function DelegationSetupNotice({
  agentId,
  open,
}: {
  agentId: string;
  open: () => void;
}) {
  const [view, setView] = useState<NoticeView | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next: NoticeView = await api(
          `/agents/${agentId}/delegation-readiness`,
        );
        if (active) setView(next);
      } catch {
        /* discovery may still be starting */
      }
    };
    setView(null);
    void load();
    const off = window.agentteam?.onEvent((e) => {
      if (changed.test(e.type)) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), 100);
      }
    });
    return () => {
      active = false;
      clearTimeout(timer);
      off?.();
    };
  }, [agentId]);
  if (!view?.notice) return null;
  return (
    <div className="setup-notice" data-testid="delegation-setup-notice">
      <span>{view.notice.text}</span>
      {view.notice.action && (
        <button type="button" className="text-button" onClick={open}>
          {view.notice.action.label}
        </button>
      )}
    </div>
  );
}
