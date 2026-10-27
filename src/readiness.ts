/**
 * Getting ready without clicks (desktop/main.ts and src/server.ts construct one service):
 *
 * - Rescans. `RuntimeDiscovery.refresh()` used to run once at startup and on Rescan. Now a scan
 *   also runs when the window regains focus while a runtime some agent uses is missing or signed
 *   out (at most one per 15 s), every 60 s while that stays so (never while everything is ready),
 *   and every 5 s for up to 5 min after a sign-in was started from the app, stopping as soon as
 *   that runtime reports `authenticated`. Scans never overlap (refresh() coalesces; so does the
 *   scheduler). `runtimes.discovered` is emitted only when the result changed (always for the
 *   startup scan and Rescan). Timer-driven scans are off unless `auto` (desktop/server outside
 *   AGENTTEAM_TEST=1, or a test that opts in).
 * - Model checks. After `runtimes.discovered`, a new project or task, and an agent whose
 *   runtime/model/effort changed, the model check (`verifySampleModels`) of every non-archived
 *   project that requires one and involves the change runs again (debounced, one at a time,
 *   errors logged). The gate itself is unchanged: nothing is substituted, only the clicking is gone.
 * - Re-queue. Work that failed only with `runtime_unavailable` (src/runtime-waits.ts) is
 *   re-queued once its runtime is ready. Pre-process capability refusals stay blocked until
 *   the current execution configuration can support the capability; scans alone cannot retry them.
 * - One-click resume (`resumeProject`) and the sign-in command (`signInCommand`).
 */
import { resolve, win32 } from "node:path";
import type { TeamService } from "./service.ts";
import { commandFor, type RunManager } from "./runtime.ts";
import type { DetectedRuntime, RuntimeDiscovery } from "./discovery.ts";
import { verifySampleModels, type WorkflowSetup } from "./samples.ts";
import { resolveShell } from "./terminal.ts";
import {
  AppError,
  assert,
  type Agent,
  type Message,
  type Task,
  type Workflow,
} from "./model.ts";
import {
  RUNTIME_WAIT,
  RUNTIME_WAIT_MAX_AGE_MS,
  type RuntimeWait,
} from "./runtime-waits.ts";
import { normalizeRelPath } from "./access.ts";
import { canonicalPolicyPath, filesystemPolicy } from "./filesystem-policy.ts";
import { contains } from "./resources.ts";
import { assertProviderCapabilities } from "./provider-capabilities.ts";

// ---- clock and rescan scheduling (pure; unit-tested with a fake clock) -------------------------

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export const RESCAN_TIMING = {
  /** A focus rescan waits at least this long after the previous scan. */
  focusDebounceMs: 15_000,
  /** While a used runtime is missing or signed out. */
  periodicMs: 60_000,
  /** After a sign-in was started from the app ... */
  fastPollMs: 5_000,
  /** ... for at most this long. */
  fastPollForMs: 5 * 60_000,
};

export class RescanScheduler {
  private o: {
    clock: Clock;
    /** One full scan; must not throw. */
    scan: () => Promise<void>;
    /** True while a runtime some agent uses is missing or signed out. */
    blocked: () => boolean;
    authenticated: (runtimeId: string) => boolean;
  };
  private inflight: Promise<void> | undefined;
  private lastScanAt = Number.NEGATIVE_INFINITY;
  private periodic: unknown;
  private fast: unknown;
  /** Runtime id → time the fast poll for it ends. */
  private polls = new Map<string, number>();
  private stopped = false;
  /** Scans started (for tests and diagnostics). */
  scans = 0;
  constructor(o: RescanScheduler["o"]) {
    this.o = o;
  }
  /** A scan started elsewhere (startup, Rescan button) also counts for the debounce and the periodic timer. */
  noteScan() {
    this.lastScanAt = this.o.clock.now();
  }
  /** Scan now unless one is running (then join it). */
  scanNow(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastScanAt = this.o.clock.now();
    this.scans++;
    const run = this.o
      .scan()
      .catch(() => undefined)
      .finally(() => {
        this.inflight = undefined;
        this.update();
      });
    return (this.inflight = run);
  }
  /** Window focus: rescan when something is blocked and the last scan is at least 15 s old. */
  focus(): boolean {
    if (this.stopped || !this.o.blocked()) return false;
    if (this.inflight) return false;
    if (this.o.clock.now() - this.lastScanAt < RESCAN_TIMING.focusDebounceMs)
      return false;
    void this.scanNow();
    return true;
  }
  /** A sign-in was started for `runtimeId`: poll every 5 s for up to 5 min. */
  signInStarted(runtimeId: string) {
    if (this.stopped) return;
    this.polls.set(runtimeId, this.o.clock.now() + RESCAN_TIMING.fastPollForMs);
    this.clear("fast");
    this.update();
  }
  /** Whether a fast poll is running for `runtimeId`. */
  polling(runtimeId: string) {
    return this.polls.has(runtimeId);
  }
  /** Recompute timers: called after every scan and whenever the blocked state may have changed. */
  update() {
    if (this.stopped) return;
    const now = this.o.clock.now();
    for (const [id, until] of this.polls)
      if (now >= until || this.o.authenticated(id)) this.polls.delete(id);
    if (!this.inflight) {
      // Periodic: 60 s after the latest scan, only while blocked.
      this.clear("periodic");
      if (this.o.blocked())
        this.periodic = this.o.clock.setTimeout(
          () => {
            this.periodic = undefined;
            if (this.o.blocked()) void this.scanNow();
          },
          Math.max(0, this.lastScanAt + RESCAN_TIMING.periodicMs - now),
        );
    }
    if (!this.polls.size) this.clear("fast");
    else if (!this.fast && !this.inflight)
      this.fast = this.o.clock.setTimeout(() => {
        this.fast = undefined;
        void this.scanNow();
      }, RESCAN_TIMING.fastPollMs);
  }
  stop() {
    this.stopped = true;
    this.clear("periodic");
    this.clear("fast");
    this.polls.clear();
  }
  private clear(which: "periodic" | "fast") {
    const handle = this[which];
    if (handle !== undefined) this.o.clock.clearTimeout(handle);
    this[which] = undefined;
  }
}

// ---- the service ------------------------------------------------------------------------------

/** What the service needs from `RuntimeDiscovery` (a real one with fake scan deps in tests). */
export type DiscoveryLike = Pick<
  RuntimeDiscovery,
  "refresh" | "readiness" | "runtimes" | "settled" | "scanning"
>;
type ProjectRecord = Workflow & {
  setup?: WorkflowSetup;
  lifecycle?: { state: string };
};
/** Fields of a scan result that matter to the user or a gate (a changed digest emits the event). */
function digestOf(runtimes: DetectedRuntime[]) {
  return JSON.stringify(
    runtimes.map((r) => [
      r.id,
      r.installed,
      r.authenticated,
      r.executable,
      r.version ?? null,
      r.models.map((m) => [m.id, m.efforts]),
      (r.diagnostics ?? []).map((d) => d.code),
    ]),
  );
}
const agentSignature = (a: Agent) =>
  JSON.stringify([
    a.environment,
    a.model,
    a.effort ?? null,
    a.tools,
    a.workspaces,
  ]);

export type ReadinessOptions = {
  service: TeamService;
  discovery: DiscoveryLike;
  /** Chat re-queue goes through `RunManager.start` (omit to leave chats failed). */
  runs?: Pick<RunManager, "start">;
  clock?: Clock;
  /** Host compatibility metadata, injectable for controlled cross-platform fixtures. */
  platform?: NodeJS.Platform;
  /** Timer-driven rescans (focus, periodic, sign-in poll). */
  auto?: boolean;
  /** Debounce for model checks and re-queues after an event. */
  delayMs?: number;
  log?: (message: string, error?: unknown) => void;
};

export class ReadinessService {
  readonly scheduler: RescanScheduler;
  readonly auto: boolean;
  private o: ReadinessOptions;
  private clock: Clock;
  private digest: string | null = null;
  private agents = new Map<string, string>();
  private pending = {
    all: false,
    requeue: false,
    workflows: new Set<string>(),
    agents: new Set<string>(),
  };
  private timer: unknown;
  private listener:
    ((event: { type: string; entityId: string }) => void) | null = null;
  constructor(o: ReadinessOptions) {
    this.o = o;
    this.clock = o.clock ?? systemClock;
    this.auto = o.auto ?? false;
    this.scheduler = new RescanScheduler({
      clock: this.clock,
      scan: () =>
        this.rescan().then(
          () => undefined,
          (error) => this.log("Automatic runtime rescan failed", error),
        ),
      blocked: () => this.blocked().length > 0,
      authenticated: (id) =>
        this.o.discovery.runtimes.find((r) => r.id === id)?.authenticated ===
        true,
    });
  }
  private get store() {
    return this.o.service.store;
  }
  private log(message: string, error?: unknown) {
    (this.o.log ?? ((m, e) => console.warn(m, e ?? "")))(message, error);
  }
  start() {
    for (const a of this.store.list<Agent>("agent"))
      this.agents.set(a.id, agentSignature(a));
    this.listener = (event) => {
      try {
        this.onEvent(event);
      } catch (error) {
        this.log("Readiness event handling failed", error);
      }
    };
    this.store.events.on("event", this.listener);
    if (this.auto) this.scheduler.update();
    return this;
  }
  stop() {
    if (this.listener) this.store.events.off("event", this.listener);
    this.listener = null;
    this.scheduler.stop();
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** Runtimes some agent uses. */
  usedEnvironments() {
    return [
      ...new Set(this.store.list<Agent>("agent").map((a) => a.environment)),
    ];
  }
  /** Used runtimes that are missing or signed out (empty until a scan has settled). */
  blocked() {
    const d = this.o.discovery;
    if (!d.settled) return [];
    return this.usedEnvironments().filter(
      (env) => d.readiness(env).state === "unavailable",
    );
  }
  /**
   * One scan. Emits `runtimes.discovered` when the result changed, or always with `always`
   * (startup and the Rescan button); a failure with `always` emits `runtimes.discovery_blocked`.
   */
  async rescan(o: { always?: boolean } = {}) {
    let runtimes: DetectedRuntime[];
    this.scheduler.noteScan();
    try {
      runtimes = await this.o.discovery.refresh();
    } catch (error) {
      if (o.always)
        this.store.emit("runtimes.discovery_blocked", "runtimes", {
          message: String((error as Error)?.message ?? error),
        });
      throw error;
    }
    if (o.always || digestOf(runtimes) !== this.digest)
      this.store.emit("runtimes.discovered", "runtimes");
    return runtimes;
  }
  /** Window focus (desktop/main.ts). */
  windowFocused() {
    return this.auto ? this.scheduler.focus() : false;
  }
  /** A sign-in for `runtimeId` was started from the app (POST /runtimes/:id/sign-in). */
  signInStarted(runtimeId: string) {
    if (this.auto) this.scheduler.signInStarted(runtimeId);
  }
  private onEvent(event: { type: string; entityId: string }) {
    switch (event.type) {
      case "runtimes.discovered":
        this.digest = digestOf(this.o.discovery.runtimes);
        this.pending.all = true;
        this.pending.requeue = true;
        this.schedule();
        if (this.auto) this.scheduler.update();
        return;
      case "agent.created":
      case "agent.updated": {
        const agent = this.store
          .list<Agent>("agent")
          .find((a) => a.id === event.entityId);
        if (!agent) return;
        const signature = agentSignature(agent);
        const before = this.agents.get(agent.id);
        this.agents.set(agent.id, signature);
        if (event.type === "agent.updated" && before !== signature) {
          this.pending.agents.add(agent.id);
          this.pending.requeue = true;
          this.schedule();
        }
        if (this.auto) this.scheduler.update();
        return;
      }
      case "agent.deleted":
        this.agents.delete(event.entityId);
        return;
      case "workflow.created":
      case "workflow.lifecycle":
        this.pending.workflows.add(event.entityId);
        this.schedule();
        return;
      case "task.created": {
        const task = this.store
          .list<Task>("task")
          .find((t) => t.id === event.entityId);
        if (task) {
          this.pending.workflows.add(task.workflowId);
          this.schedule();
        }
        return;
      }
    }
  }
  private schedule() {
    if (this.timer !== undefined) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.o.delayMs ?? 200);
  }
  /** Run the pending model checks and re-queues now (the debounce timer calls this). */
  flush() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    const { all, requeue, workflows, agents } = this.pending;
    this.pending = {
      all: false,
      requeue: false,
      workflows: new Set(),
      agents: new Set(),
    };
    if (requeue) this.requeueReady();
    if (!this.o.discovery.settled) return [];
    if (!all && !workflows.size && !agents.size) return [];
    const participants = new Map<string, Set<string>>();
    for (const t of this.store.list<Task>("task")) {
      if (!participants.has(t.workflowId))
        participants.set(t.workflowId, new Set());
      participants.get(t.workflowId)!.add(t.agentId);
    }
    const checked: string[] = [];
    for (const wf of this.store.list<ProjectRecord>("workflow")) {
      if (!wf.setup?.requiresModelVerification) continue;
      if (wf.lifecycle?.state === "archived") continue;
      const involved = new Set([
        wf.ownerId,
        ...(participants.get(wf.id) ?? []),
      ]);
      if (
        !all &&
        !workflows.has(wf.id) &&
        ![...agents].some((id) => involved.has(id))
      )
        continue;
      try {
        verifySampleModels(
          this.o.service,
          wf.id,
          this.o.discovery.runtimes,
          "auto",
        );
        checked.push(wf.id);
      } catch (error) {
        this.log(`Automatic model check of project ${wf.id} failed`, error);
      }
    }
    return checked;
  }
  /** Re-queue only known pre-process failures whose runtime/capability is ready now. */
  requeueReady() {
    const now = this.clock.now();
    const requeued: string[] = [];
    for (const wait of this.store.list<RuntimeWait>(RUNTIME_WAIT)) {
      // Missing tools or folders and unverified required checks are repaired by their own setup
      // steps; the evaluator below re-checks them against the current configuration.
      if (
        wait.reason === "capability-missing" ||
        wait.reason === "check-unconfirmed" ||
        wait.reason === "assignment-preparation"
      )
        continue;
      const age = now - Date.parse(wait.at);
      const capabilityWait = wait.reason === "sandbox-unavailable";
      // Capability blockers remain visible across restarts and long waits. Unlike an old
      // sign-in failure, a still-blocked assignment must retain its actionable explanation.
      if (!capabilityWait && !(age <= RUNTIME_WAIT_MAX_AGE_MS)) {
        this.store.remove(RUNTIME_WAIT, wait.id);
        continue;
      }
      const task =
        wait.kind === "task"
          ? this.store.list<Task>("task").find((t) => t.id === wait.targetId)
          : undefined;
      const agentId =
        task?.agentId ??
        (wait.kind === "chat"
          ? this.store
              .list<{ id: string; agentId: string }>("session")
              .find((s) => s.id === wait.targetId)?.agentId
          : undefined);
      const agent = this.store
        .list<Agent>("agent")
        .find((a) => a.id === agentId);
      if (capabilityWait) {
        if (
          !agent ||
          (wait.kind === "task" &&
            (task?.status !== "blocked" ||
              this.o.service.recovery.state(task.id).attempt !== wait.attempt))
        ) {
          this.store.remove(RUNTIME_WAIT, wait.id);
          continue;
        }
        // Do not infer that an executable/version rescan activates a feature-gated native
        // Windows sandbox. Removing an unnecessary shell grant or changing to a ready
        // runtime is an explicit configuration repair. Other launch policies still run.
        if (
          (this.o.platform ?? process.platform) === "win32" &&
          agent.environment === "claude" &&
          agent.tools.includes("shell") &&
          agent.tools.includes("read") &&
          (agent.tools.includes("edit") || agent.tools.includes("write")) &&
          agent.workspaces.some((workspace) => workspace.access === "write")
        )
          continue;
      }
      const environment = capabilityWait
        ? agent!.environment
        : wait.environment;
      if (this.o.discovery.readiness(environment).state !== "ready") continue;
      this.store.remove(RUNTIME_WAIT, wait.id);
      try {
        if (wait.kind === "task") {
          // Only the same failed attempt: a retry made meanwhile (or any other change) wins.
          if (
            task?.status !== (capabilityWait ? "blocked" : "failed") ||
            this.o.service.recovery.state(task.id).attempt !== wait.attempt
          )
            continue;
          this.o.service.recovery.requeue(task.id);
          this.store.emit("task.runtime_requeued", task.id, {
            agentId: task.agentId,
            environment,
          });
          requeued.push(wait.id);
        } else {
          const runs = this.o.runs;
          if (!runs) continue;
          const queued = this.store
            .list<Message>("message")
            .some(
              (m) =>
                m.sessionId === wait.targetId &&
                m.role === "user" &&
                m.status === "queued",
            );
          const requested = this.store
            .list<{ id: string }>("run-request")
            .some((r) => r.id === wait.targetId);
          if (!queued || requested) continue;
          requeued.push(wait.id);
          void runs.start(wait.targetId).then(
            () =>
              this.store.emit("session.runtime_requeued", wait.targetId, {
                environment,
              }),
            (error) =>
              this.log(`Could not re-queue chat ${wait.targetId}`, error),
          );
        }
      } catch (error) {
        // Attempts exhausted, an uncertain effect or a pending decision: stays failed (Retry).
        this.log(`Could not re-queue ${wait.id}`, error);
      }
    }
    requeued.push(...this.o.service.launchReadiness.requeueWaiting());
    return requeued;
  }
}

// ---- one-click resume ---------------------------------------------------------------------------

const preparing = new Map<string, Promise<unknown>>();

/** Prepare the actual provider contract without spawning a process or recording an effect. */
async function checkSimpleTaskPlans(service: TeamService, workflowId: string) {
  const pendingTasks = () =>
    service.store
      .list<Task>("task")
      .filter(
        (task) =>
          task.workflowId === workflowId &&
          !["completed", "cancelled", "running"].includes(task.status),
      );
  const inputs = () =>
    JSON.stringify(
      pendingTasks().map((task) => ({
        task,
        agent: service.store.get<Agent>("agent", task.agentId),
      })),
    );
  const before = inputs();
  for (const task of pendingTasks()) {
    const agent = service.store.get<Agent>("agent", task.agentId);
    try {
      const plan = await service.launchPlan(agent.id, task.id);
      const artifacts = (task.completionChecks ?? []).filter(
        (check) =>
          check.type === "artifact-exists" || check.type === "artifact-matches",
      );
      if (artifacts.length) {
        assert(
          plan.cwd &&
            plan.tools.includes("read") &&
            (plan.tools.includes("write") || plan.tools.includes("edit")) &&
            plan.providerRoots.length > 0 &&
            plan.providerRoots.every(
              (root) => root.access === "write" && !root.restricted,
            ),
          "simple_task_write_required",
          "The assigned file output needs read and write tools and write access to this task's folder. Update this agent's access or choose another agent.",
          409,
        );
        for (const artifact of artifacts) {
          // Check an existing parent too: a not-yet-created file can still point through a symlink.
          const relativePath = normalizeRelPath(artifact.path);
          const target = canonicalPolicyPath(resolve(plan.cwd, relativePath));
          filesystemPolicy(service.store).assertPath(target, false);
          assert(
            contains(plan.cwd, target),
            "artifact_path_escape",
            `The output ${artifact.path} points outside the task's folder. Choose a file inside it.`,
            403,
          );
        }
      }
      const command = commandFor(plan, null, task.instructions, plan.cwd ?? "");
      assertProviderCapabilities(command, plan.environment);
    } catch (error) {
      throw new AppError(
        error instanceof AppError ? error.status : 409,
        error instanceof AppError ? error.code : "simple_task_not_ready",
        `${agent.name}: ${error instanceof Error ? error.message : String(error)} The project is saved and paused; no new agent has started.`,
      );
    }
  }
  assert(
    inputs() === before,
    "simple_task_setup_changed",
    "An assignment or agent changed during the setup check. Start the saved task again with the current configuration.",
    409,
  );
}
/**
 * The shared readiness gate for Start: every task still to run is held against the actual launch
 * plan of its agent (folder grants, command capability, adapter support, sandbox) and the
 * project's contract. A project that cannot do its work stays paused and saved, the setup state
 * names each affected worker with one repair, and nothing starts; repeating Start after the
 * repair resumes the same saved assignment (src/launch-readiness.ts).
 */
async function checkProjectReadiness(service: TeamService, workflowId: string) {
  const tasks = service.store
    .list<Task>("task")
    .filter(
      (task) =>
        task.workflowId === workflowId &&
        !["completed", "cancelled", "running"].includes(task.status),
    );
  const contract = service.contracts.project(workflowId);
  const decisions = [];
  for (const task of tasks) {
    const agent = service.store.get<Agent>("agent", task.agentId);
    let decision;
    try {
      const plan = await service.launchPlan(agent.id, task.id);
      decision = service.launchReadiness.evaluatePlan(agent, plan, {
        task,
        contract: service.contracts.effective(task) ?? contract,
      });
    } catch (error) {
      const issue = service.launchReadiness.issueFromError(
        agent,
        error,
        task.id,
      );
      if (!issue) throw error;
      decision = service.launchReadiness.evaluateProspective(agent, { task });
      if (decision.ready)
        decision = {
          ...decision,
          ready: false,
          issues: [issue],
          message: issue.message,
        };
    }
    if (!decision.ready) decisions.push(decision);
  }
  if (!decisions.length) {
    service.setups.refresh(workflowId);
    return;
  }
  for (const decision of decisions)
    service.setups.noteBlocked(workflowId, decision);
  throw new AppError(
    409,
    "capability_missing",
    `${decisions
      .slice(0, 3)
      .map((d) => d.message)
      .join(
        " ",
      )}${decisions.length > 3 ? ` ${decisions.length - 3} more workers need setup.` : ""} The project is saved and paused; no agent has started. Repeat Start after the setup is done.`,
  );
}
/**
 * Resume a paused project (POST /workflows/:id/pause {paused:false}). Before the gates in
 * `TeamService.pauseWorkflow` run, the checks they need run here: a pipeline project whose
 * preflight is missing, failed or stale is prepared exactly like "Prepare and verify" (which
 * assigns workers and creates worktrees only after every check passed), any other project that
 * requires a model check gets a fresh one. Nothing runs before the providers were detected; the
 * gates then answer with their own 409 and the failed checks named.
 */
export async function resumeProject(
  service: TeamService,
  discovery: Pick<DiscoveryLike, "runtimes" | "settled">,
  workflowId: string,
) {
  const wf = service.store.get<ProjectRecord>("workflow", workflowId);
  if (
    wf.paused &&
    wf.setup?.executionMode === "file-only" &&
    wf.lifecycle?.state !== "archived"
  ) {
    if (!discovery.settled)
      throw new AppError(
        409,
        "runtime_resolving",
        "Checking the selected agents' runtimes. Try starting the saved task once the check finishes.",
      );
    const participants = new Set(
      service.store
        .list<Task>("task")
        .filter((task) => task.workflowId === workflowId)
        .map((task) => task.agentId),
    );
    for (const agentId of participants) {
      const agent = service.store.get<Agent>("agent", agentId);
      const runtime = discovery.runtimes.find(
        (item) => item.id === agent.environment,
      );
      if (!runtime?.installed || runtime.authenticated !== true)
        throw new AppError(
          424,
          "runtime_unavailable",
          `${agent.name}: ${
            !runtime?.installed
              ? `${agent.environment} is not installed or detected. Open Settings to select its runtime.`
              : `Sign in to ${agent.environment} before starting this task.`
          } The project is saved and paused; no agent has started.`,
        );
    }
  }
  if (
    discovery.settled &&
    wf.paused &&
    wf.setup &&
    wf.lifecycle?.state !== "archived"
  ) {
    if (wf.setup.requiresPreflight && service.pipelines.maybeRecord(wf.id)) {
      if (service.pipelines.verification(wf.id).state !== "verified") {
        let run = preparing.get(wf.id);
        if (!run) {
          run = service.pipelines
            .prepare(wf.id, discovery.runtimes, "auto")
            .finally(() => preparing.delete(wf.id));
          preparing.set(wf.id, run);
        }
        await run;
      }
    } else if (wf.setup.requiresModelVerification)
      verifySampleModels(service, wf.id, discovery.runtimes, "auto");
  }
  if (
    wf.paused &&
    wf.setup?.executionMode === "file-only" &&
    wf.lifecycle?.state !== "archived"
  )
    await checkSimpleTaskPlans(service, workflowId);
  // A pipeline project's readiness is part of "Prepare and verify" and its resume gate.
  if (
    wf.paused &&
    wf.lifecycle?.state !== "archived" &&
    !wf.setup?.requiresPreflight
  )
    await checkProjectReadiness(service, workflowId);
  return service.pauseWorkflow(workflowId, false);
}

// ---- sign-in command ---------------------------------------------------------------------------

export type ShellKind = "powershell" | "cmd" | "posix";
/** The family of a shell executable (PowerShell/pwsh, cmd.exe, everything else POSIX-like). */
export function shellKind(shell: string): ShellKind {
  const name = win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (name === "powershell" || name === "pwsh") return "powershell";
  if (name === "cmd") return "cmd";
  return "posix";
}
const unsafe = (what: string) =>
  new AppError(
    400,
    "sign_in_unsafe",
    `${what} cannot be typed into a terminal safely; run the sign-in yourself`,
  );
/** One argument quoted for `shell`. Control characters (a typed line break would run the line early) are refused. */
export function quoteArg(arg: string, shell: ShellKind, always = false) {
  if (!arg || /[\u0000-\u001f\u007f]/.test(arg))
    throw unsafe("An argument with control characters");
  if (shell === "posix")
    return !always && /^[A-Za-z0-9_+:,./-]+$/.test(arg)
      ? arg
      : `'${arg.replace(/'/g, `'\\''`)}'`;
  if (shell === "cmd") {
    // Inside quotes cmd.exe still expands %VAR%; a quote cannot be escaped at all.
    if (/[%"]/.test(arg)) throw unsafe(`“${arg}”`);
    return !always && /^[A-Za-z0-9_+:,./\\-]+$/.test(arg) ? arg : `"${arg}"`;
  }
  // PowerShell: a double-quoted string expands $ and backtick escapes and also ends at the
  // typographic double quotes, so each of those is escaped with a backtick.
  return !always && /^[A-Za-z0-9_+:,./\\-]+$/.test(arg)
    ? arg
    : `"${arg.replace(/[`$"“”„]/g, (c) => "`" + c)}"`;
}
/** A command line for `argv` (argv[0] is an absolute executable path) in `shell`. */
export function commandLine(argv: string[], shell: ShellKind) {
  const [executable, ...args] = argv;
  const rest = args.map((a) => quoteArg(a, shell));
  if (shell === "powershell")
    return ["&", quoteArg(executable, shell, true), ...rest].join(" ");
  if (shell === "cmd")
    return [quoteArg(executable, shell, true), ...rest].join(" ");
  return [quoteArg(executable, shell), ...rest].join(" ");
}
const RUNTIME_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  wolfram: "wolframscript",
};
/**
 * The interactive sign-in for a detected runtime, using the executable AgentTeam itself runs (so
 * the user signs in to the same installation): `claude auth login` or `codex login`. The renderer
 * types the line into a new terminal of the user's own shell; it never names an executable.
 */
export function signInCommand(
  runtime: Pick<DetectedRuntime, "id" | "installed" | "executable">,
  shell: string = resolveShell().file,
) {
  const name = RUNTIME_NAMES[runtime.id] ?? runtime.id;
  if (runtime.id !== "claude" && runtime.id !== "codex")
    throw new AppError(
      400,
      "sign_in_unsupported",
      `${name} has no sign-in command; it uses your existing Wolfram account configuration`,
    );
  if (!runtime.installed || !runtime.executable)
    throw new AppError(
      409,
      "runtime_not_installed",
      `${name} is not installed: install it or choose its executable in Settings, then sign in`,
    );
  const argv =
    runtime.id === "claude"
      ? [runtime.executable, "auth", "login"]
      : [runtime.executable, "login"];
  const kind = shellKind(shell);
  return {
    runtime: runtime.id,
    argv,
    shell: kind,
    commandLine: commandLine(argv, kind),
  };
}
