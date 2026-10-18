import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import "./pipeline.css";
import "./team-settings.css";

/**
 * "Assign project": give the active TEAM a PROJECT (goal + workspace, plus what its project type
 * needs). The project runs on the team's existing agents and is created paused; its gates (model
 * verification, and for pipeline teams "Prepare and verify") apply before it can resume.
 */
type Info = {
  teamId: string;
  projectType: "pipeline" | "wolfram-validated" | "free-form";
  projectLabel: string;
  leadId: string | null;
  agents: { id: string; name: string; roleType: string }[];
  projects: { id: string; name: string; paused: boolean }[];
  defaults: {
    implementationWorkers?: number;
    fixWorkers?: number;
    validators?: number;
  };
};

const ASSIGN_EVENT = "agentteam:assign-project";
let pendingAssign = false;
/** Ask the Projects pane to open its Assign project form (the switcher menu uses this). */
export function openAssignProject() {
  pendingAssign = true;
  window.dispatchEvent(new CustomEvent(ASSIGN_EVENT));
}
/** Opens the form when requested, also when the request came before the pane mounted. */
export function useAssignRequest(open: () => void) {
  useEffect(() => {
    const take = () => {
      if (!pendingAssign) return;
      pendingAssign = false;
      open();
    };
    take();
    window.addEventListener(ASSIGN_EVENT, take);
    return () => window.removeEventListener(ASSIGN_EVENT, take);
  }, []);
}

/** One row of the free-form task list; `dependsOn` holds indexes of other rows. */
type DraftTask = {
  title: string;
  agentId: string;
  instructions: string;
  dependsOn: number[];
};
/**
 * Body tasks for the free-form project: rows without a title are dropped and the dependency
 * indexes re-numbered; with "run in order" no explicit dependencies are sent. The backend
 * (src/projects.ts planTaskOrder) validates range, self-references, duplicates and cycles.
 */
export function freeFormTasks(tasks: DraftTask[], sequential: boolean) {
  const kept = tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.title.trim() && t.agentId);
  const index = new Map(kept.map(({ i }, j) => [i, j]));
  return kept.map(({ t }) => ({
    title: t.title.trim(),
    agentId: t.agentId,
    ...(t.instructions.trim() ? { instructions: t.instructions } : {}),
    ...(sequential
      ? {}
      : {
          dependsOn: t.dependsOn
            .filter((d) => index.has(d))
            .map((d) => index.get(d)!),
        }),
  }));
}

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^.*?Error: /, "");

export function AssignProject({
  teamId,
  teamName,
  close,
  act,
}: {
  teamId: string;
  teamName: string;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [info, setInfo] = useState<Info | null>(null),
    [goal, setGoal] = useState(""),
    [workspace, setWorkspace] = useState(""),
    [name, setName] = useState(""),
    [isolation, setIsolation] = useState("worktree"),
    [paths, setPaths] = useState(""),
    [impl, setImpl] = useState(0),
    [fix, setFix] = useState(0),
    [lead, setLead] = useState(""),
    [tasks, setTasks] = useState<DraftTask[]>([]),
    [sequential, setSequential] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/team-spaces/${teamId}/projects`)
      .then((i: Info) => {
        setInfo(i);
        setImpl(i.defaults.implementationWorkers ?? 0);
        setFix(i.defaults.fixWorkers ?? 0);
        setLead(i.leadId ?? i.agents[0]?.id ?? "");
      })
      .catch((e) => setError(message(e)));
  }, [teamId]);
  const submit = async () => {
    if (!info) return;
    setBusy(true);
    setError("");
    const common = {
      goal,
      workspace,
      ...(name.trim() ? { name: name.trim() } : {}),
    };
    const body =
      info.projectType === "pipeline"
        ? {
            ...common,
            isolation,
            paths: paths
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean),
            implementationWorkers: impl,
            fixWorkers: fix,
          }
        : info.projectType === "wolfram-validated"
          ? common
          : {
              ...common,
              ...(lead ? { ownerId: lead } : {}),
              tasks: freeFormTasks(tasks, sequential),
              sequential,
            };
    try {
      await api(`/team-spaces/${teamId}/projects`, "POST", body);
      await act(async () => undefined);
      close();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const counts = (n: number) =>
    Array.from({ length: Math.max(n, 1) }, (_, i) => i + 1);
  return (
    <form
      className="pipeline-form assign-project"
      aria-label="Assign project"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Assign a project to {teamName}</h3>
      {info ? (
        <p className="quiet" data-testid="assign-project-type">
          This team takes: {info.projectLabel}. The project runs on the team’s
          existing {info.agents.length} agents and is created paused; nothing
          runs until its gates pass
          {info.projectType === "pipeline"
            ? " (model verification, then Prepare and verify)"
            : " (model verification)"}{" "}
          and you resume it.
        </p>
      ) : (
        <p className="quiet">Loading the team…</p>
      )}
      <label>
        Goal
        <textarea
          aria-label="Project goal"
          rows={3}
          required
          minLength={10}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <label>
        Workspace (absolute path)
        <span className="row">
          <input
            aria-label="Project workspace"
            required
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          />
          <button
            type="button"
            onClick={async () => {
              const p = await window.agentteam.chooseFolder();
              if (p) setWorkspace(p);
            }}
          >
            Choose
          </button>
        </span>
      </label>
      <label>
        Project name (optional)
        <input
          aria-label="Project name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {info?.projectType === "pipeline" && (
        <>
          <div className="grid2">
            <label>
              Parallel isolation
              <select
                aria-label="Project isolation"
                value={isolation}
                onChange={(e) => setIsolation(e.target.value)}
              >
                <option value="worktree">Git worktree per worker</option>
                <option value="paths">Disjoint paths in one checkout</option>
              </select>
            </label>
            <label>
              Implementation workers (team has{" "}
              {info.defaults.implementationWorkers})
              <select
                aria-label="Implementation workers"
                value={impl}
                onChange={(e) => setImpl(Number(e.target.value))}
              >
                {counts(info.defaults.implementationWorkers ?? 1).map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <label>
              Fix workers (team has {info.defaults.fixWorkers})
              <select
                aria-label="Fix workers"
                value={fix}
                onChange={(e) => setFix(Number(e.target.value))}
              >
                {counts(info.defaults.fixWorkers ?? 1).map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
          {isolation === "paths" && (
            <label>
              Worker paths (one per line, disjoint; worker N uses line N in both
              worker stages)
              <textarea
                aria-label="Worker paths"
                rows={3}
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
              />
            </label>
          )}
        </>
      )}
      {info?.projectType === "wolfram-validated" && (
        <p className="quiet">
          {info.defaults.validators} Wolfram validator(s) derive and validate;
          every reasoning step needs a passing real-kernel validation record.
        </p>
      )}
      {info?.projectType === "free-form" && (
        <>
          <label>
            Project lead
            <select
              aria-label="Project lead"
              value={lead}
              onChange={(e) => setLead(e.target.value)}
            >
              {info.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="assign-tasks">
            <legend>Tasks (optional; without any, the lead plans first)</legend>
            {tasks.map((t, i) => {
              const set = (patch: Partial<DraftTask>) =>
                setTasks(
                  tasks.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                );
              return (
                <div
                  className="task-editor"
                  key={i}
                  role="group"
                  aria-label={`Task ${i + 1}`}
                >
                  <div className="row">
                    <input
                      aria-label={`Task ${i + 1} title`}
                      placeholder="Task title"
                      value={t.title}
                      onChange={(e) => set({ title: e.target.value })}
                    />
                    <select
                      aria-label={`Task ${i + 1} agent`}
                      value={t.agentId}
                      onChange={(e) => set({ agentId: e.target.value })}
                    >
                      {info.agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="icon"
                      aria-label={`Remove task ${i + 1}`}
                      onClick={() =>
                        setTasks(
                          tasks
                            .filter((_, j) => j !== i)
                            .map((x) => ({
                              ...x,
                              dependsOn: x.dependsOn
                                .filter((d) => d !== i)
                                .map((d) => (d > i ? d - 1 : d)),
                            })),
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea
                    aria-label={`Task ${i + 1} instructions`}
                    placeholder="Instructions (optional; default: contribute to the goal)"
                    rows={2}
                    value={t.instructions}
                    onChange={(e) => set({ instructions: e.target.value })}
                  />
                  {!sequential && tasks.length > 1 && (
                    <div className="task-deps">
                      <span className="quiet">Waits for:</span>
                      {tasks.map((o, j) =>
                        j === i ? null : (
                          <label key={j}>
                            <input
                              type="checkbox"
                              aria-label={`Task ${i + 1} waits for task ${j + 1}`}
                              checked={t.dependsOn.includes(j)}
                              onChange={(e) =>
                                set({
                                  dependsOn: e.target.checked
                                    ? [...t.dependsOn, j].sort((a, b) => a - b)
                                    : t.dependsOn.filter((d) => d !== j),
                                })
                              }
                            />
                            {j + 1}. {o.title.trim() || "(untitled)"}
                          </label>
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              disabled={tasks.length >= 30}
              onClick={() =>
                setTasks([
                  ...tasks,
                  {
                    title: "",
                    agentId: info.agents[0]?.id ?? "",
                    instructions: "",
                    dependsOn: [],
                  },
                ])
              }
            >
              <Plus size={14} />
              Add task
            </button>
            <label className="inline">
              <input
                type="checkbox"
                checked={sequential}
                onChange={(e) => setSequential(e.target.checked)}
              />
              Run tasks in order (uncheck to choose what each task waits for)
            </label>
          </fieldset>
        </>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          className="primary"
          disabled={!info || busy || goal.trim().length < 10 || !workspace}
        >
          Create paused project
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
