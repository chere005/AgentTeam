// Validation-evidence gate: persisted, immutable Wolfram validation records bound to
// the exact inputs of a task, plus the runner/concurrency machinery that produces them.
// Agent prose, generated code and nonempty output are never evidence; only a record
// whose kernel run produced a version, output and all-passing assertions can be "pass".
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppError, assert, type Task } from "./model.ts";
import type { ResourceCoordinator } from "./resources.ts";
import type { Store } from "./store.ts";

export const MAX_CONCURRENT_VALIDATIONS = 2;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const VALIDATION_POOL = "wolfram-validation";

export const validationStatuses = [
  "pass",
  "fail",
  "inconclusive",
  "stale",
  "cancelled",
] as const;
export type ValidationStatus = (typeof validationStatuses)[number];

const tolerance = z
  .object({
    absolute: z.number().positive().optional(),
    relative: z.number().positive().optional(),
    precision: z.number().positive().optional(),
  })
  .strict()
  .refine(
    (t) => t.absolute || t.relative || t.precision,
    "Give an absolute or relative tolerance, or a working precision",
  );

/** What a caller submits. Status, kernel output and hashes are never caller-supplied. */
export const validationSpecSchema = z
  .object({
    claim: z.string().trim().min(1),
    assumptions: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    units: z.string().optional(),
    derivation: z.string().default(""),
    source: z.string().trim().min(1).max(200_000),
    inputs: z.record(z.string(), z.string()).default({}),
    evidenceKind: z.enum(["symbolic-proof", "numerical-evidence"]),
    tolerance: tolerance.optional(),
  })
  .strict()
  .refine((s) => s.evidenceKind !== "numerical-evidence" || s.tolerance, {
    message: "Numerical evidence must state tolerances or precision",
    path: ["tolerance"],
  });
export type ValidationSpec = z.infer<typeof validationSpecSchema>;

const assertionSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type KernelAssertion = z.infer<typeof assertionSchema>;

export type KernelRunRequest = {
  source: string;
  timeoutMs: number;
  signal: AbortSignal;
};
export type KernelResult = {
  kernelVersion: string;
  stdout: string;
  stderr?: string;
  exitCode: number;
  durationMs: number;
  assertions: KernelAssertion[];
  timedOut?: boolean;
};
/** Injectable so tests use a fake; the real implementation shells out to wolframscript. */
export interface KernelRunner {
  run(request: KernelRunRequest): Promise<KernelResult>;
}
export class KernelUnavailableError extends Error {
  constructor(message = "Wolfram kernel is unavailable") {
    super(message);
  }
}

const kernelSchema = z
  .object({
    version: z.string(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int(),
    durationMs: z.number(),
    timedOut: z.boolean(),
  })
  .strict();

export const validationRecordSchema = z
  .object({
    id: z.string(),
    seq: z.number().int().positive(),
    taskId: z.string(),
    attempt: z.number().int().positive(),
    inputHash: z.string(),
    sourceHash: z.string(),
    spec: validationSpecSchema,
    kernel: kernelSchema.nullable(),
    assertions: z.array(assertionSchema),
    status: z.enum(validationStatuses),
    reason: z.string(),
    startedAt: z.string(),
    finishedAt: z.string(),
  })
  .strict();
export type ValidationRecord = z.infer<typeof validationRecordSchema>;

/** The only definition of "real evidence" for a pass. Re-checked on every gate read. */
export function isKernelEvidence(r: {
  kernel: ValidationRecord["kernel"];
  assertions: KernelAssertion[];
}) {
  return (
    !!r.kernel &&
    r.kernel.version.trim().length > 0 &&
    r.kernel.stdout.trim().length > 0 &&
    r.kernel.exitCode === 0 &&
    !r.kernel.timedOut &&
    r.assertions.length > 0 &&
    r.assertions.every((a) => a.passed)
  );
}

export function judge(result: KernelResult | null): {
  status: ValidationStatus;
  reason: string;
} {
  if (!result)
    return { status: "inconclusive", reason: "No kernel result was produced" };
  if (result.timedOut)
    return { status: "inconclusive", reason: "Kernel run timed out" };
  if (!result.kernelVersion.trim())
    return { status: "inconclusive", reason: "Kernel reported no version" };
  if (result.exitCode !== 0)
    return {
      status: "inconclusive",
      reason: `Kernel exited with code ${result.exitCode}`,
    };
  if (!result.stdout.trim())
    return { status: "inconclusive", reason: "Kernel produced no output" };
  if (!result.assertions.length)
    return {
      status: "inconclusive",
      reason: "No assertions were reported by the kernel run",
    };
  const failed = result.assertions.filter((a) => !a.passed);
  if (failed.length)
    return {
      status: "fail",
      reason: "Failed assertions: " + failed.map((a) => a.name).join(", "),
    };
  return { status: "pass", reason: "All assertions passed in the kernel run" };
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Hash of everything the task's reasoning depends on: its own definition and dependency results. */
export function taskInputHash(store: Store, task: Task) {
  const deps = [...task.dependsOn].sort().map((id) => {
    const d = store.get<Task>("task", id);
    return { id, status: d.status, result: d.result ?? "" };
  });
  return sha(
    JSON.stringify({
      title: task.title,
      instructions: task.instructions,
      completionCriteria: task.completionCriteria,
      deps,
    }),
  );
}

export type GateState = {
  required: boolean;
  open: boolean;
  /** not-required | pass | missing | failed | inconclusive | cancelled | stale | attempts-exhausted */
  reason: string;
  inputHash: string;
  latestRecordId: string | null;
  attemptsUsed: number;
  maxAttempts: number;
};

type Active = {
  runId: string;
  taskId: string;
  inputHash: string;
  state: "waiting" | "running";
  controller: AbortController;
  startedAt: string;
};

export class ValidationService {
  store: Store;
  resources: ResourceCoordinator;
  runner: KernelRunner;
  maxAttempts: number;
  maxConcurrent: number;
  timeoutMs: number;
  active = new Map<string, Active>();
  private waiters: (() => void)[] = [];
  constructor(
    store: Store,
    resources: ResourceCoordinator,
    options: {
      runner?: KernelRunner;
      maxAttempts?: number;
      maxConcurrent?: number;
      timeoutMs?: number;
    } = {},
  ) {
    this.store = store;
    this.resources = resources;
    this.runner = options.runner ?? new WolframscriptRunner();
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    // Hard cap: configuration may lower it but never raise it above two.
    this.maxConcurrent = Math.max(
      1,
      Math.min(options.maxConcurrent ?? MAX_CONCURRENT_VALIDATIONS, 2),
    );
    this.timeoutMs = options.timeoutMs ?? 120_000;
    // Attempts are immutable evidence: forbid rewriting or deleting them at the database level.
    store.db.exec(`
      CREATE TRIGGER IF NOT EXISTS validation_no_update BEFORE UPDATE ON entities
        WHEN OLD.kind='validation' BEGIN SELECT RAISE(ABORT,'validation records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS validation_no_delete BEFORE DELETE ON entities
        WHEN OLD.kind='validation' BEGIN SELECT RAISE(ABORT,'validation records are immutable'); END;`);
    // Runs do not survive a restart; drop any slots they held.
    this.resources.releasePool(VALIDATION_POOL);
  }

  records(taskId?: string): ValidationRecord[] {
    const all = this.store
      .list<unknown>("validation")
      .map((r) => validationRecordSchema.parse(r));
    return taskId ? all.filter((r) => r.taskId === taskId) : all;
  }
  record(id: string) {
    return validationRecordSchema.parse(this.store.get("validation", id));
  }
  /** Status as seen against the task's current inputs: older-hash records read as stale. */
  effectiveStatus(record: ValidationRecord, currentHash: string) {
    if (record.inputHash !== currentHash) return "stale" as const;
    if (record.status === "pass" && !isKernelEvidence(record))
      return "inconclusive" as const;
    return record.status;
  }

  gate(task: Task): GateState {
    // taskState() calls this for every queued task; skip hashing/record scans when not required.
    if (!task.requiresValidation)
      return {
        inputHash: "",
        latestRecordId: null,
        attemptsUsed: 0,
        maxAttempts: this.maxAttempts,
        required: false,
        open: true,
        reason: "not-required",
      };
    const inputHash = taskInputHash(this.store, task);
    const base = {
      inputHash,
      latestRecordId: null as string | null,
      attemptsUsed: 0,
      maxAttempts: this.maxAttempts,
    };
    const all = this.records(task.id);
    const current = all.filter((r) => r.inputHash === inputHash);
    const latest = current[current.length - 1];
    const attemptsUsed = this.attemptsFor(task.id, inputHash);
    if (!latest)
      return {
        ...base,
        attemptsUsed,
        required: true,
        open: false,
        reason: all.length ? "stale" : "missing",
      };
    const status = this.effectiveStatus(latest, inputHash);
    return {
      ...base,
      attemptsUsed,
      latestRecordId: latest.id,
      required: true,
      open: status === "pass",
      reason:
        status === "pass"
          ? "pass"
          : attemptsUsed >= this.maxAttempts
            ? "attempts-exhausted"
            : status === "fail"
              ? "failed"
              : status,
    };
  }
  private attemptsFor(taskId: string, inputHash: string) {
    return this.records(taskId).filter(
      (r) => r.inputHash === inputHash && r.status !== "cancelled",
    ).length;
  }

  /** Begin a validation attempt. Resolves `done` with the immutable record once finished. */
  start(taskId: string, input: unknown) {
    filesystemPolicy(this.store).assertConfinedExecution();
    const spec = validationSpecSchema.parse(input);
    const task = this.store.get<Task>("task", taskId);
    const inputHash = taskInputHash(this.store, task);
    assert(
      ![...this.active.values()].some((a) => a.taskId === taskId),
      "validation_active",
      "A validation for this task is already running",
    );
    const used = this.attemptsFor(taskId, inputHash);
    assert(
      used < this.maxAttempts,
      "attempts_exhausted",
      `Validation attempts for these inputs are exhausted (${this.maxAttempts}); change the inputs or escalate to a human`,
    );
    const run: Active = {
      runId: randomUUID(),
      taskId,
      inputHash,
      state: "waiting",
      controller: new AbortController(),
      startedAt: new Date().toISOString(),
    };
    this.active.set(run.runId, run);
    this.store.emit("validation.queued", run.runId, { taskId });
    const done = this.execute(run, spec, used + 1);
    return { runId: run.runId, done };
  }
  cancel(runId: string) {
    const run = this.active.get(runId);
    assert(run, "not_found", `validation run ${runId} not found`, 404);
    run.controller.abort();
    this.wake();
    return { runId, state: "cancelling" };
  }
  activeRuns() {
    return [...this.active.values()].map(({ controller: _c, ...rest }) => rest);
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  private async acquire(run: Active) {
    for (;;) {
      if (run.controller.signal.aborted) return false;
      try {
        this.resources.acquireSlot(
          VALIDATION_POOL,
          run.runId,
          this.maxConcurrent,
        );
        return true;
      } catch (error) {
        if ((error as AppError).code !== "resource_busy") throw error;
        await new Promise<void>((resolve) => {
          this.waiters.push(resolve);
          run.controller.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    }
  }

  private async execute(run: Active, spec: ValidationSpec, attempt: number) {
    let result: KernelResult | null = null;
    let reason = "";
    let status: ValidationStatus;
    let held = false;
    try {
      held = await this.acquire(run);
      if (held) {
        run.state = "running";
        this.store.emit("validation.started", run.runId, {
          taskId: run.taskId,
        });
        try {
          result = await this.runner.run({
            source: spec.source,
            timeoutMs: this.timeoutMs,
            signal: run.controller.signal,
          });
        } catch (error) {
          reason =
            error instanceof KernelUnavailableError
              ? "Wolfram kernel unavailable: " + error.message
              : "Kernel run failed: " +
                (error instanceof Error ? error.message : String(error));
        }
      }
      if (run.controller.signal.aborted) {
        status = "cancelled";
        reason = "Validation was cancelled";
        // A cancelled run's output is not evidence, but keep what the kernel printed.
      } else if (result) {
        ({ status, reason } = judge(result));
      } else {
        status = "inconclusive";
        reason ||= "No kernel result was produced";
      }
      const kernel = result
        ? {
            version: result.kernelVersion,
            stdout: result.stdout,
            stderr: result.stderr ?? "",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: !!result.timedOut,
          }
        : null;
      const assertions = result?.assertions ?? [];
      if (status === "pass" && !isKernelEvidence({ kernel, assertions })) {
        status = "inconclusive";
        reason = "Result lacked genuine kernel evidence";
      }
      return this.store.transaction(() => {
        const record = validationRecordSchema.parse({
          id: randomUUID(),
          seq: this.store.list("validation").length + 1,
          taskId: run.taskId,
          attempt,
          inputHash: run.inputHash,
          sourceHash: sha(spec.source),
          spec,
          kernel,
          assertions,
          status,
          reason,
          startedAt: run.startedAt,
          finishedAt: new Date().toISOString(),
        });
        this.store.put("validation", record);
        this.store.emit("validation.recorded", record.id, {
          taskId: record.taskId,
          status: record.status,
        });
        return record;
      });
    } finally {
      // The slot is released only after the runner has actually settled.
      if (held) this.resources.releaseSlot(run.runId);
      this.active.delete(run.runId);
      this.wake();
    }
  }
}

const MARK_VERSION = "@@AGENTTEAM-VERSION@@";
const MARK_ASSERT = "@@AGENTTEAM-ASSERTIONS@@";

/**
 * Runs `wolframscript`. The submitted source must set `validationAssertions` to a list of
 * <|"name" -> _String, "passed" -> True|False|> associations; the wrapper prints the kernel
 * version and that list as JSON so the record contains what the kernel actually produced.
 */
export class WolframscriptRunner implements KernelRunner {
  command: string;
  constructor(
    command = process.env.AGENTTEAM_WOLFRAMSCRIPT || "wolframscript",
  ) {
    this.command = command;
  }
  async run({ source, timeoutMs, signal }: KernelRunRequest) {
    if (process.env.AGENTTEAM_ENABLE_LIVE === "0")
      throw new KernelUnavailableError("kernel execution disabled by settings");
    const dir = await mkdtemp(join(tmpdir(), "agentteam-wl-"));
    try {
      const src = join(dir, "validation.wl").replace(/\\/g, "/");
      await writeFile(src, source);
      const wrapper = join(dir, "wrapper.wl");
      await writeFile(
        wrapper,
        `Print["${MARK_VERSION}" <> $Version];\nvalidationAssertions = {};\nGet["${src}"];\nPrint["${MARK_ASSERT}" <> ExportString[validationAssertions, "RawJSON", "Compact" -> True]];\n`,
      );
      return await new Promise<KernelResult>((resolve, reject) => {
        const started = Date.now();
        const child = spawn(this.command, ["-file", wrapper], {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        const onAbort = () => child.kill("SIGKILL");
        if (signal.aborted) onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (e) => {
          clearTimeout(timer);
          reject(
            (e as NodeJS.ErrnoException).code === "ENOENT"
              ? new KernelUnavailableError(`${this.command} not found`)
              : e,
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          const lines = stdout.split(/\r?\n/);
          const version =
            lines
              .find((l) => l.startsWith(MARK_VERSION))
              ?.slice(MARK_VERSION.length) ?? "";
          let assertions: KernelAssertion[] = [];
          const line = lines.find((l) => l.startsWith(MARK_ASSERT));
          if (line)
            try {
              assertions = z
                .array(assertionSchema)
                .parse(JSON.parse(line.slice(MARK_ASSERT.length)));
            } catch {
              assertions = [];
            }
          resolve({
            kernelVersion: version,
            stdout,
            stderr,
            exitCode: code ?? -1,
            durationMs: Date.now() - started,
            assertions,
            timedOut,
          });
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
