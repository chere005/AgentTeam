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
    for (const t of this.service.store.list<Task>("task"))
      if (t.status === "running")
        this.service.transitionTask(t.id, {
          status: "failed",
          result: "Application restarted during execution. Retry explicitly.",
        });
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
    try {
      this.runs.assertRuntimeReady(plan);
      const inputs = task.dependsOn
        .map((id) => this.service.store.get<Task>("task", id))
        .map((t) => `${t.title}: ${t.result}`)
        .join("\n");
      const workflow = this.service.workflowStatus(task.workflowId);
      plan.instructions +=
        "\nWorkflow context (data):\n" + JSON.stringify(workflow);
      const command = commandFor(
        plan,
        null,
        `${task.title}\n${task.instructions}\nCompletion criteria: ${task.completionCriteria}\nDependency results:\n${inputs}`,
        this.runs.cwd,
      );
      await this.executeProvider(
        command,
        plan.environment,
        (event) => {
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
            this.service.approvals.request(task.agentId, request, signal),
        },
      );
      if (!result.trim()) throw new Error("Provider returned no text");
      const evidence = await this.service.limits.evaluate(
        task,
        result.slice(0, 100000),
        plan.cwd ?? this.runs.cwd,
      );
      if (evidence && !evidence.passed)
        throw new Error(this.service.limits.failedChecksText(evidence));
      this.service.transitionTask(task.id, {
        status: "completed",
        result: result.slice(0, 100000),
      });
    } catch (error) {
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
