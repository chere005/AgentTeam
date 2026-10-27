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
import type { LaunchReadiness } from "../../src/launch-readiness";
import type { SetupAction } from "../../src/launch-readiness";
import { api, type Snapshot } from "../api";
import "./project-setup.css";
import { ExecutionProjectCard } from "./ExecutionProject";

type SetupView = ReturnType<ProjectSetupService["view"]>;
type NoticeView = ReturnType<LaunchReadiness["delegationReadiness"]>;
type Act = (fn: () => Promise<unknown>) => Promise<void>;
const changed =
  /^(project\.|contract\.|task\.|agent\.|workflow\.|runtime\.|execution\.)/;
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
          setError(e instanceof Error ? e.message : String(e));
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
                              [
                                "choose-project-folder",
                                "attach-folder",
                                "grant-write-access",
                              ].includes(issue.fix?.kind ?? "")
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
              />
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const selected = await window.agentteam.chooseFolder();
                    if (selected) {
                      dirty.current = true;
                      setFolder(selected);
                    }
                  })
                }
              >
                <FolderOpen size={14} /> Browse
              </button>
            </div>
            <datalist id={`${id}-folders`}>
              {view.proposal.candidates.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
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
      {error && (
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
}: {
  agentId: string;
  data: Snapshot;
  act: Act;
  repair?: (action: SetupAction) => void;
}) {
  return (
    <>
      {data.workflows
        .filter(
          (w) =>
            w.ownerId === agentId || w.tasks.some((t) => t.agentId === agentId),
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
