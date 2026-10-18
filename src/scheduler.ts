import { comparePriority } from "./priorities.ts";
import { TeamService } from "./service.ts";
import { RunManager, commandFor, executeCommand } from "./runtime.ts";
import type { Task } from "./model.ts";
export class Scheduler {
  executeProvider: typeof executeCommand;
  service: TeamService;
  runs: RunManager;
  timer: ReturnType<typeof setInterval> | undefined;
  busy = false;
  stopped = false;
  constructor(
    service: TeamService,
    runs: RunManager,
    executeProvider = executeCommand,
  ) {
    this.service = service;
    this.runs = runs;
    this.executeProvider = executeProvider;
    service.limits.abortTask = (id) => {
      const controller = runs.active.get("task:" + id);
      controller?.abort();
      return !!controller;
    };
  }
  start() {
    // Completed work stays completed; running work becomes interrupted/resumable (or blocked on an
    // uncertain effect) with its checkpoint, and dead processes' leases are released.
    this.service.recovery.recover();
    this.timer = setInterval(() => void this.tick(), 750);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  async tick() {
    if (this.busy || this.stopped || !this.runs.enabled) return;
    this.busy = true;
    try {
      this.service.limits.sweep(); // runtime clock + runtime/token budget trips
      this.service.recovery.sweep(); // automatic retries whose backoff elapsed
      const tasks = this.service.store
        .list<Task>("task")
        .filter((t) => t.status === "queued");
      const requests = this.service.store.list<{
        id: string;
        agentId: string;
        queuedAt: string;
      }>("run-request");
      // One clock reading for every score so equal-age work keeps FIFO (stable sort) order.
      const now = Date.now();
      const candidates = [
        ...tasks.map((task) => ({
          kind: "task" as const,
          task,
          priority: this.service.resources.priority(task.agentId),
          score: this.service.resources.score(task, now),
        })),
        ...requests.map((request) => ({
          kind: "chat" as const,
          request,
          priority: this.service.resources.priority(request.agentId),
          score:
            this.service.resources.priority(request.agentId) +
            Math.max(0, now - Date.parse(request.queuedAt)) / 5000,
        })),
      ].sort(comparePriority);
      for (const candidate of candidates) {
        if (candidate.kind === "chat") {
          if (this.stopped || !this.runs.enabled) break;
          try {
            await this.runs.start(candidate.request.id, true);
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (
              ![
                "resource_busy",
                "agent_busy",
                "session_busy",
                "human_control",
                "runtime_resolving",
              ].includes(code ?? "")
            ) {
              this.service.store.remove("run-request", candidate.request.id);
              this.service.store.emit("session.failed", candidate.request.id, {
                message:
                  error instanceof Error ? error.message : "Unable to start",
              });
            }
          }
          continue;
        }
        const task = candidate.task;
        if (this.stopped || !this.runs.enabled) break;
        if (this.service.taskState(task.id).waitReason) continue;
        let plan;
        try {
          plan = await this.service.launchPlan(task.agentId);
          if (this.stopped || !this.runs.enabled) break;
          // Leave the task queued until its runtime is resolved; an unavailable runtime fails the task in execute().
          if (this.runs.readiness && plan.connection?.transport !== "acp")
            if (this.runs.readiness(plan.environment).state === "resolving")
              continue;
          this.service.transitionTask(task.id, { status: "running" });
        } catch {
          continue;
        }
        const controller = new AbortController();
        this.runs.active.set("task:" + task.id, controller);
        void this.execute(task, plan, controller);
      }
    } finally {
      this.busy = false;
    }
  }
  async execute(
    task: Task,
    plan: Awaited<ReturnType<TeamService["launchPlan"]>>,
    controller: AbortController,
  ) {
    let result = "";
    let effectId: string | null = null;
    try {
      this.runs.assertRuntimeReady(plan);
      const recovery = this.service.recovery;
      // Selected dependency outputs, readable shared state, artifacts and bounded workflow metadata:
      // size-limited (the task's maxContextChars), labelled untrusted, withheld for fresh memory.
      // A run the ledger will replay keeps the original run's state base versions.
      const inputs = this.service.shared.beginRun(task, {
        replay: recovery.willReplayRun(task),
      }).text;
      // Ledger: a provider run that already completed is replayed from its saved output, never repeated.
      const run = recovery.startRun(
        task,
        plan.connection?.transport === "acp" ||
          plan.workspaces.some((w) => w.access === "write"),
      );
      effectId = run.effectId;
      const prompt = `${task.title}\n${task.instructions}\nCompletion criteria: ${task.completionCriteria}\nDependency results:\n${inputs}${recovery.continuationNote(task)}`;
      let command;
      try {
        command = commandFor(plan, run.sessionId, prompt, this.runs.cwd);
      } catch (e) {
        // A recorded provider session that no longer fits the connection restarts without it.
        if (!run.sessionId) throw e;
        command = commandFor(plan, null, prompt, this.runs.cwd);
      }
      if (run.replay !== null) result = run.replay;
      else
        await this.executeProvider(
          command,
          plan.environment,
          (event) => {
            recovery.observe(task, event);
            if (event.type === "usage")
              this.service.limits.recordUsage(task, event.data);
            if (event.type === "text")
              result += String(event.data) + (command.acp ? "" : "\n");
            this.service.store.emit("task.runtime", task.id, {
              agentId: task.agentId,
              ...event,
            });
          },
          controller.signal,
          {
            profile: "task",
            permission: (request, signal) =>
              this.service.approvals.request(
                task.agentId,
                request,
                signal,
                task.id,
              ),
          },
        );
      if (!result.trim()) throw new Error("Provider returned no text");
      if (run.replay === null) recovery.finishRun(task, run.effectId, result);
      const evidence = await this.service.limits.evaluate(
        task,
        result.slice(0, 100000),
        plan.cwd ?? this.runs.cwd,
      );
      if (evidence && !evidence.passed)
        throw new Error(this.service.limits.failedChecksText(evidence));
      // Structured output (agentteam-state block): schema/permission failures fail the task with an actionable
      // message; writes and the completion commit together so a version conflict leaves nothing behind.
      const output = await this.service.shared.prepare(
        task,
        result.slice(0, 100000),
      );
      this.service.store.transaction(() => {
        this.service.shared.commit(task, output);
        this.service.transitionTask(task.id, {
          status: "completed",
          result: result.slice(0, 100000),
        });
      });
    } catch (error) {
      if (effectId) this.service.recovery.failRun(task, effectId, error);
      this.service.transitionTask(
        task.id,
        this.service.limits.finishAbnormal(
          task,
          controller.signal.aborted,
          error instanceof Error ? error.message : "Execution failed",
          result,
        ),
      );
    } finally {
      this.service.approvals.cancelAgent(task.agentId);
      this.runs.active.delete("task:" + task.id);
    }
  }
}
