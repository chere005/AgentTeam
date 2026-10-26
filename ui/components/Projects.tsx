import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { agentSelectorLabel } from "../agent-identity";
import "./pipeline.css";
import "./team-settings.css";
import "./projects.css";

/**
 * "Assign project": give the active TEAM a PROJECT (goal + workspace, plus what its project type
 * needs). Simple tasks assign the agents directly and start after readiness checks. Full projects
 * keep their paused setup flow, including the pipeline's preparation and model checks.
 */
type Info = {
  teamId: string;
  projectType: "pipeline" | "wolfram-validated" | "free-form";
  projectLabel: string;
  leadId: string | null;
  agents: {
    id: string;
    name: string;
    roleType: string;
    simpleAvailable?: boolean;
    simpleBlocker?: string | null;
    canWriteFiles?: boolean;
  }[];
  projects: { id: string; name: string; paused: boolean }[];
  defaults: {
    workspace?: string;
    implementationWorkers?: number;
    fixWorkers?: number;
    validators?: number;
  };
};

const ASSIGN_EVENT = "agentteam:assign-project";
export type AssignmentDraft = {
  goal?: string;
  workspace?: string;
  focusStart?: boolean;
};
export type AssignmentRequest = AssignmentDraft & { requestId: number };
let requestId = 0;
let pendingAssign: AssignmentRequest | null = null;
/** Ask the Projects pane to open its Assign project form (the switcher menu uses this). */
export function openAssignProject(draft: AssignmentDraft = {}) {
  pendingAssign = { ...draft, requestId: ++requestId };
  window.dispatchEvent(new CustomEvent(ASSIGN_EVENT));
}
/** Opens the form when requested, also when the request came before the pane mounted. */
export function useAssignRequest(open: (request: AssignmentRequest) => void) {
  useEffect(() => {
    const take = () => {
      if (!pendingAssign) return;
      const request = pendingAssign;
      pendingAssign = null;
      open(request);
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

function simpleOutputPath(template: string, name: string) {
  const safeName =
    name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") ||
    "Agent";
  const fileName = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(
    safeName,
  )
    ? `_${safeName}`
    : safeName;
  return template.trim().replaceAll("{agent}", () => fileName);
}

export function AssignProject({
  teamId,
  teamName,
  close,
  act,
  onAssigned,
  executionEnabled,
  initialDraft,
}: {
  teamId: string;
  teamName: string;
  close: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  onAssigned?: (id: string) => void;
  executionEnabled?: boolean;
  initialDraft?: AssignmentDraft;
}) {
  const [info, setInfo] = useState<Info | null>(null),
    [mode, setMode] = useState<"simple" | "project">("simple"),
    [selectedAgents, setSelectedAgents] = useState<string[]>([]),
    [createdId, setCreatedId] = useState<string | null>(null),
    [outputPath, setOutputPath] = useState(""),
    [outputText, setOutputText] = useState(""),
    [goal, setGoal] = useState(initialDraft?.goal ?? ""),
    [workspace, setWorkspace] = useState(initialDraft?.workspace ?? ""),
    [name, setName] = useState(""),
    [isolation, setIsolation] = useState("worktree"),
    [paths, setPaths] = useState(""),
    [impl, setImpl] = useState(0),
    [fix, setFix] = useState(0),
    [lead, setLead] = useState(""),
    [tasks, setTasks] = useState<DraftTask[]>([]),
    [sequential, setSequential] = useState(true),
    [error, setError] = useState(""),
    [waitingForExecution, setWaitingForExecution] = useState(false),
    [busy, setBusy] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const initialFocusDone = useRef(false);
  useEffect(() => {
    if (!initialDraft?.focusStart || !info || initialFocusDone.current) return;
    initialFocusDone.current = true;
    startButton.current?.focus();
    startButton.current?.scrollIntoView({ block: "nearest" });
  }, [initialDraft?.focusStart, info]);
  useEffect(() => {
    api(`/team-spaces/${teamId}/projects`)
      .then((i: Info) => {
        setInfo(i);
        setImpl(i.defaults.implementationWorkers ?? 0);
        setFix(i.defaults.fixWorkers ?? 0);
        setLead(i.leadId ?? i.agents[0]?.id ?? "");
        const available = i.agents.filter(
          (agent) => agent.simpleAvailable !== false,
        );
        setSelectedAgents(available.map((agent) => agent.id));
        setWorkspace((current) => current || i.defaults.workspace || "");
      })
      .catch((e) => setError(message(e)));
  }, [teamId]);
  useEffect(() => {
    if (!info || !outputPath.trim()) return;
    setSelectedAgents((selected) =>
      selected.filter((id) =>
        info.agents.some(
          (agent) =>
            agent.id === id &&
            agent.simpleAvailable !== false &&
            agent.canWriteFiles !== false,
        ),
      ),
    );
  }, [info, outputPath]);
  useEffect(() => {
    if (!createdId) setError("");
  }, [
    selectedAgents,
    outputPath,
    outputText,
    goal,
    workspace,
    mode,
    createdId,
  ]);
  const submit = async () => {
    if (!info) return;
    setBusy(true);
    setError("");
    if (waitingForExecution && createdId) {
      try {
        if (executionEnabled === false)
          await api("/execution", "PUT", { action: "resume" });
        await act(async () => undefined);
        onAssigned?.(createdId);
        close();
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (
      mode === "simple" &&
      outputPath.trim() &&
      (/^(?:[A-Za-z]:|[\\/])/.test(outputPath.trim()) ||
        outputPath.split(/[\\/]/).includes(".."))
    ) {
      setError(
        "Use a file path inside the chosen folder, such as {agent}.txt.",
      );
      setBusy(false);
      return;
    }
    if (mode === "simple" && outputPath.trim()) {
      const files = selectedAgents.map((id) =>
        simpleOutputPath(
          outputPath,
          info.agents.find((agent) => agent.id === id)?.name ?? "Agent",
        )
          .replace(/\\/g, "/")
          .toLowerCase(),
      );
      if (new Set(files).size !== files.length) {
        setError(
          "Selected agents would write the same file. Use {agent} in the expected file path or select one agent.",
        );
        setBusy(false);
        return;
      }
    }
    const common = {
      goal,
      workspace,
      ...(name.trim() ? { name: name.trim() } : {}),
    };
    const body =
      mode === "simple"
        ? {
            ...common,
            mode: "simple",
            ...(lead ? { ownerId: lead } : {}),
            sequential: false,
            tasks: selectedAgents.map((agentId) => {
              const agentName =
                info.agents.find((agent) => agent.id === agentId)?.name ??
                "Agent";
              const file = simpleOutputPath(outputPath, agentName);
              const content = outputText.replaceAll("{agent}", () => agentName);
              const pattern =
                "^" +
                content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                "(?:\\r?\\n)?$";
              return {
                agentId,
                title: goal.trim().slice(0, 200),
                instructions:
                  `Complete your own assignment for this simple task. Work directly with your existing permissions. Do not recreate a pipeline or delegate the whole team request. This assignment uses text and file tools without a terminal.\n\nRequest:\n${goal}` +
                  (file
                    ? `\n\nRequired file (relative to the project folder): ${file}` +
                      (outputText
                        ? `\nRequired file content (literal text):\n${content}`
                        : "")
                    : ""),
                ...(file
                  ? {
                      completionChecks: [
                        outputText
                          ? { type: "artifact-matches", path: file, pattern }
                          : { type: "artifact-exists", path: file },
                      ],
                    }
                  : {}),
              };
            }),
          }
        : info.projectType === "pipeline"
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
    let assignedId = createdId;
    try {
      const project = createdId
        ? { id: createdId }
        : await api(`/team-spaces/${teamId}/projects`, "POST", body);
      assignedId = project.id;
      if (mode === "simple") {
        setCreatedId(project.id);
        await api(`/workflows/${project.id}/pause`, "POST", { paused: false });
      }
      await act(async () => undefined);
      onAssigned?.(project.id);
      if (mode === "simple" && executionEnabled === false) {
        setWaitingForExecution(true);
        return;
      }
      close();
    } catch (e) {
      setError(message(e));
      await act(async () => undefined);
      if (assignedId) onAssigned?.(assignedId);
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
      aria-description={`Assign work to ${teamName}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Run a task with your agents</h3>
      {info && (
        <label>
          Work type
          <select
            aria-label="Work type"
            value={mode}
            disabled={busy || !!createdId}
            onChange={(e) => {
              setMode(e.target.value as "simple" | "project");
              setError("");
            }}
          >
            <option value="simple">Simple task</option>
            <option value="project">
              {info.projectType === "pipeline"
                ? "Full pipeline"
                : info.projectType === "wolfram-validated"
                  ? "Validated reasoning project"
                  : "Custom project"}
            </option>
          </select>
        </label>
      )}
      {info ? (
        <p className="quiet" data-testid="assign-project-type">
          {mode === "simple" ? (
            "Describe the work and choose a folder. Start tasks assigns each selected agent its own task and runs it automatically."
          ) : (
            <>
              This team takes: {info.projectLabel}. The project runs on the
              team’s existing {info.agents.length} agents and is created paused.
              Its models are checked automatically, and it starts when you press
              Resume
              {info.projectType === "pipeline"
                ? ", which also runs the pipeline checks and, once they pass, assigns the workers and creates their worktrees"
                : ""}
              . Anything that blocks it is named on the project with what to do.
            </>
          )}
        </p>
      ) : (
        <p className="quiet">Loading the team…</p>
      )}
      {info && mode === "simple" && (
        <div className="assign-simple-preset">
          <div>
            <b>Try it: agents write their own files</b>
            <small>
              One named text file per agent, checked before it is marked
              complete.
            </small>
          </div>
          <button
            type="button"
            className="text-button"
            disabled={busy || !!createdId}
            onClick={() => {
              setGoal(
                "Write your own reporting-for-duty text file in the selected folder.",
              );
              setName("Reporting for duty");
              setOutputPath("{agent}.txt");
              setOutputText("I am {agent}, reporting for duty.");
              setSelectedAgents(
                info.agents
                  .filter(
                    (agent) =>
                      agent.simpleAvailable !== false &&
                      agent.canWriteFiles !== false,
                  )
                  .map((agent) => agent.id),
              );
            }}
          >
            Report for duty
          </button>
        </div>
      )}
      <label>
        What should the agents do?
        <textarea
          aria-label="Project goal"
          rows={mode === "simple" ? 2 : 3}
          required
          disabled={busy || !!createdId}
          minLength={mode === "simple" ? 1 : 10}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </label>
      <label>
        Folder for the work
        <span className="row">
          <input
            aria-label="Project workspace"
            required
            disabled={busy || !!createdId}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !!createdId}
            onClick={async () => {
              const p = await window.agentteam.chooseFolder();
              if (p) setWorkspace(p);
            }}
          >
            Choose
          </button>
        </span>
      </label>
      {mode === "project" && (
        <label>
          Project name (optional)
          <input
            aria-label="Project name"
            value={name}
            disabled={busy || !!createdId}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      )}
      {info && mode === "simple" && (
        <>
          <details className="assign-simple-selection">
            <summary>
              {selectedAgents.length}{" "}
              {selectedAgents.length === 1 ? "agent" : "agents"} selected
              <span className="quiet">Change agents</span>
            </summary>
            <fieldset
              className="assign-simple-agents"
              disabled={busy || !!createdId}
            >
              <legend>Agents</legend>
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    setSelectedAgents(
                      info.agents
                        .filter(
                          (agent) =>
                            agent.simpleAvailable !== false &&
                            (!outputPath.trim() ||
                              agent.canWriteFiles !== false),
                        )
                        .map((agent) => agent.id),
                    )
                  }
                >
                  Select all available
                </button>
                <button
                  type="button"
                  disabled={
                    !info.agents.some(
                      (agent) =>
                        agent.id === lead &&
                        agent.simpleAvailable !== false &&
                        (!outputPath.trim() || agent.canWriteFiles !== false),
                    )
                  }
                  onClick={() => setSelectedAgents([lead].filter(Boolean))}
                >
                  Use lead only
                </button>
              </div>
              <div className="assign-simple-agent-list">
                {info.agents.map((agent) => (
                  <label className="check" key={agent.id}>
                    <input
                      type="checkbox"
                      aria-label={`Assign to ${agent.name}`}
                      disabled={
                        agent.simpleAvailable === false ||
                        (!!outputPath.trim() && agent.canWriteFiles === false)
                      }
                      title={
                        agent.simpleBlocker ??
                        (agent.canWriteFiles === false && outputPath.trim()
                          ? "This agent does not have permission to create files."
                          : undefined)
                      }
                      checked={selectedAgents.includes(agent.id)}
                      onChange={(event) =>
                        setSelectedAgents((selected) =>
                          event.target.checked
                            ? [...selected, agent.id]
                            : selected.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <span className="assign-simple-agent-copy">
                      {agentSelectorLabel(agent)}
                      {agent.simpleAvailable === false && (
                        <small className="quiet">
                          {agent.simpleBlocker ??
                            "Unavailable for simple tasks"}
                        </small>
                      )}
                      {agent.simpleAvailable !== false &&
                        agent.canWriteFiles === false && (
                          <small className="quiet">Read and reply only</small>
                        )}
                    </span>
                  </label>
                ))}
              </div>
              <small className="quiet">
                Each selected agent receives the request. Choose agents with
                write access when you need files created.
              </small>
            </fieldset>
          </details>
          {info.agents.some(
            (agent) =>
              agent.simpleAvailable === false ||
              (!!outputPath && agent.canWriteFiles === false),
          ) && (
            <small className="quiet" data-testid="simple-unavailable-summary">
              {
                info.agents.filter(
                  (agent) =>
                    agent.simpleAvailable === false ||
                    (!!outputPath && agent.canWriteFiles === false),
                ).length
              }{" "}
              agents cannot run this task with their current setup. Open Change
              agents for the reason.
            </small>
          )}
          {outputPath && (
            <p
              className="assign-simple-file-summary"
              data-testid="simple-file-summary"
            >
              Each agent will create <b>{outputPath}</b> in the chosen folder.
              {outputText && (
                <span>
                  File content: <q>{outputText}</q>
                </span>
              )}
            </p>
          )}
          <details className="assign-simple-output">
            <summary>Verify a file (optional)</summary>
            <label>
              Expected file
              <input
                aria-label="Expected file"
                placeholder="{agent}.txt"
                value={outputPath}
                maxLength={1000}
                disabled={busy || !!createdId}
                onChange={(event) => setOutputPath(event.target.value)}
              />
            </label>
            <small className="quiet">
              Use a path inside the chosen folder. {"{agent}"} becomes each
              agent’s name.
            </small>
            <label>
              Required text (optional)
              <textarea
                aria-label="Required file text"
                rows={2}
                value={outputText}
                maxLength={200}
                disabled={busy || !!createdId || !outputPath.trim()}
                onChange={(event) => setOutputText(event.target.value)}
              />
            </label>
            <small className="quiet">
              Completion requires the actual file and, when supplied, this text.
              {" {agent}"} becomes that agent’s name.
            </small>
          </details>
        </>
      )}
      {mode === "project" && info?.projectType === "pipeline" && (
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
      {mode === "project" && info?.projectType === "wolfram-validated" && (
        <p className="quiet">
          {info.defaults.validators} Wolfram validator(s) derive and validate;
          every reasoning step needs a passing real-kernel validation record.
        </p>
      )}
      {mode === "project" && info?.projectType === "free-form" && (
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
                  {agentSelectorLabel(a)}
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
                          {agentSelectorLabel(a)}
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
      {waitingForExecution && executionEnabled === false && (
        <p
          className="blocker"
          role="status"
          data-testid="simple-execution-paused"
        >
          Your tasks are ready. Execution is paused across AgentTeam. Resume
          execution to start these tasks and any other queued work.
        </p>
      )}
      {error && (
        <p className="err" role="alert">
          {createdId && "The task is saved but has not started. "}
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="submit"
          ref={startButton}
          className="primary"
          disabled={
            !info ||
            busy ||
            goal.trim().length < (mode === "simple" ? 1 : 10) ||
            !workspace ||
            (mode === "simple" && !selectedAgents.length)
          }
        >
          {busy
            ? mode === "simple"
              ? "Checking and starting…"
              : "Creating project…"
            : waitingForExecution
              ? executionEnabled === false
                ? "Resume execution and start"
                : "View running tasks"
              : createdId
                ? "Try starting again"
                : mode === "simple"
                  ? selectedAgents.length > 1
                    ? "Start tasks"
                    : "Start task"
                  : "Create paused project"}
        </button>
        <button type="button" onClick={close} disabled={busy}>
          {createdId ? "View saved task" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
