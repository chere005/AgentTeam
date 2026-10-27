import { createHash, randomUUID } from "node:crypto";
import { builtinModules } from "node:module";
import { constants, readFileSync, realpathSync, lstatSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { decideBoth } from "./access.ts";
import { filesystemPolicy } from "./filesystem-policy.ts";
import { AppError, assert, type Agent, type Task } from "./model.ts";
import { contains, pidAlive, type Lease } from "./resources.ts";
import type { TeamService } from "./service.ts";
import {
  executionVerificationSpecSchema,
  type CompletionCheck,
  type ExecutionVerificationSpec,
} from "./limits-schema.ts";
import {
  runVerificationCommand,
  verificationExecutable,
  verificationRuntimeRoots,
  type ConfinedResult,
} from "./verification-confinement.ts";

export type VerificationReference = {
  id: string;
  label: string;
  stdout: string;
  hash: string;
  newline: "exact" | "optional-one";
  origin: "user-confirmed" | "independent-pi";
  provenance: string;
  createdAt: string;
};
export type VerificationInput = { path: string; sha256: string; bytes: number };
export type ExecutionVerificationRecord = {
  id: string;
  taskId: string;
  workflowId: string;
  spec: ExecutionVerificationSpec;
  requestHash: string;
  sourceRoot: string;
  sourceFiles: VerificationInput[];
  snapshotHash: string;
  snapshotDirectory: string;
  referenceId: string;
  referenceHash: string;
  passed: boolean;
  status: "passed" | "failed" | "unavailable" | "cancelled";
  reason: string;
  errorCode?: string;
  stdout: string;
  stderr: string;
  commands: ConfinedResult[];
  binaryHash: string | null;
  toolchain: { executable: string; version: string } | null;
  startedAt: string;
  finishedAt: string;
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const MAX_SOURCE_BYTES = 4_000_000;
const pool = "execution-verification";
const referenceSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    stdout: z.string().max(200_000),
    newline: z.enum(["exact", "optional-one"]).default("optional-one"),
  })
  .strict();

/** Two distinct exact-integer identities, with guard digits; no provider-generated reference. */
export function independentPi(
  digits: number,
  mode: "significant" | "decimal" = "significant",
) {
  assert(
    Number.isInteger(digits) && digits >= 1 && digits <= 5000,
    "invalid_precision",
    "Pi precision must be between 1 and 5000 digits",
    400,
  );
  const decimals = mode === "significant" ? digits - 1 : digits;
  const guard = 40;
  const scale = 10n ** BigInt(decimals + guard);
  const atan = (inverse: bigint) => {
    let power = scale / inverse,
      sum = power,
      denominator = 3n,
      sign = -1n;
    while (power) {
      power /= inverse * inverse;
      const term = power / denominator;
      if (!term) break;
      sum += sign * term;
      denominator += 2n;
      sign = -sign;
    }
    return sum;
  };
  const first = (16n * atan(5n) - 4n * atan(239n)) / 10n ** BigInt(guard);
  const second =
    (4n *
      (44n * atan(57n) +
        7n * atan(239n) -
        12n * atan(682n) +
        24n * atan(12943n))) /
    10n ** BigInt(guard);
  assert(
    first === second,
    "reference_disagreement",
    "Independent Pi calculations disagree; no reference was accepted",
    500,
  );
  const text = first.toString();
  assert(
    text.startsWith(decimals >= 15 ? "3141592653589793" : "3"),
    "reference_invalid",
    "Independent reference failed its known prefix",
    500,
  );
  return decimals
    ? `${text[0]}.${text.slice(1).padStart(decimals, "0")}`
    : text;
}

function sourcePath(path: string) {
  assert(
    !isAbsolute(path) &&
      !/^[A-Za-z]:/.test(path) &&
      !path.startsWith("\\") &&
      !/[\0\r\n]/.test(path) &&
      !path
        .split(/[\\/]/)
        .some((part) => part === ".." || part.toLowerCase() === ".git"),
    "invalid_verification_path",
    "Verification sources must be relative paths outside Git internals",
    400,
  );
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
function normalizedSpec(input: unknown) {
  const spec = executionVerificationSpecSchema.parse(input);
  spec.entry = sourcePath(spec.entry);
  spec.sourceFiles = [
    ...new Set([spec.entry, ...spec.sourceFiles.map(sourcePath)]),
  ].sort();
  return spec;
}

export class ExecutionVerification {
  readonly service: TeamService;
  readonly directory: string;
  private active = new Set<string>();
  private controllers = new Map<string, AbortController>();
  constructor(service: TeamService, directory?: string) {
    this.service = service;
    const database = service.store.db
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main");
    this.directory = resolve(
      directory ??
        join(
          database?.file ? dirname(String(database.file)) : tmpdir(),
          "AgentTeam Verification",
        ),
    );
    service.store.db
      .exec(`CREATE TRIGGER IF NOT EXISTS verification_reference_no_update BEFORE UPDATE ON entities WHEN OLD.kind='verification-reference' BEGIN SELECT RAISE(ABORT, 'verification references are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS verification_reference_no_delete BEFORE DELETE ON entities WHEN OLD.kind='verification-reference' BEGIN SELECT RAISE(ABORT, 'verification references are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS execution_verification_no_update BEFORE UPDATE ON entities WHEN OLD.kind='execution-verification' BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS execution_verification_no_delete BEFORE DELETE ON entities WHEN OLD.kind='execution-verification' BEGIN SELECT RAISE(ABORT, 'execution evidence is immutable'); END;`);
  }
  /** User-facing routes may call this; provider tools must never create or edit references. */
  registerReference(input: unknown): VerificationReference {
    const data = referenceSchema.parse(input);
    return this.saveReference({
      ...data,
      origin: "user-confirmed",
      provenance: "Literal expected output confirmed through the application",
    });
  }
  private saveReference(
    data: Omit<VerificationReference, "id" | "hash" | "createdAt">,
  ) {
    const identity = hash(JSON.stringify(data));
    const id = `reference:${identity}`;
    const existing = this.service.store
      .list<VerificationReference>("verification-reference")
      .find((r) => r.id === id);
    if (existing) return existing;
    const record = {
      ...data,
      id,
      hash: hash(data.stdout),
      createdAt: new Date().toISOString(),
    };
    this.service.store.put("verification-reference", record);
    this.service.store.emit("verification.reference", id, {
      label: record.label,
      origin: record.origin,
      hash: record.hash,
      characters: record.stdout.length,
    });
    return record;
  }
  ensurePiReference(
    digits: number,
    mode: "significant" | "decimal" = "significant",
  ) {
    return this.saveReference({
      label: `Pi: ${digits} ${mode === "significant" ? "significant digits" : "decimal places"}, truncated`,
      stdout: independentPi(digits, mode),
      newline: "optional-one",
      origin: "independent-pi",
      provenance:
        "Exact integer Machin and Störmer identities, independently agreeing with 40 guard digits",
    });
  }
  references() {
    return this.service.store.list<VerificationReference>(
      "verification-reference",
    );
  }
  list(taskId: string) {
    return this.service.store
      .list<ExecutionVerificationRecord>("execution-verification")
      .filter((r) => r.taskId === taskId);
  }
  latest(taskId: string) {
    return this.list(taskId).at(-1) ?? null;
  }
  cancel(taskId: string) {
    const controller = this.controllers.get(taskId);
    controller?.abort();
    return !!controller;
  }

  private async root(task: Task) {
    const plan = await this.service.launchPlan(task.agentId, task.id);
    assert(
      plan.cwd,
      "verification_workspace_required",
      "Verification needs the task's readable source folder",
      409,
    );
    const root = await realpath(plan.cwd);
    const contract = this.service.contracts.effective(task);
    if (contract?.projectFolder)
      assert(
        contains(await realpath(contract.projectFolder), root),
        "verification_scope_denied",
        "The task folder leaves the confirmed project folder",
        403,
      );
    return root;
  }
  private async readSources(
    task: Task,
    root: string,
    spec: ExecutionVerificationSpec,
  ) {
    const agent = this.service.store.get<Agent>("agent", task.agentId);
    const policy = filesystemPolicy(this.service.store);
    let total = 0;
    const inputs: { manifest: VerificationInput; content: Buffer }[] = [];
    for (const rel of spec.sourceFiles) {
      const lexical = resolve(root, sourcePath(rel));
      policy.assertPath(lexical, false);
      assert(
        contains(root, lexical),
        "verification_scope_denied",
        "Verification input leaves the task folder",
        403,
      );
      const actual = await realpath(lexical);
      policy.assertPath(actual, false);
      assert(
        contains(root, actual) && !(await lstat(lexical)).isSymbolicLink(),
        "verification_symlink",
        "Verification sources cannot traverse outside the task or use file symlinks",
        403,
      );
      assert(
        !task.resourcePaths?.length ||
          task.resourcePaths.some(
            (scope) => contains(scope, lexical) && contains(scope, actual),
          ),
        "verification_scope_denied",
        "Verification input leaves the task's declared scope",
        403,
      );
      const workspace = agent.workspaces
        .filter((w) => contains(w.path, lexical) && contains(w.path, actual))
        .sort((a, b) => b.path.length - a.path.length)[0];
      assert(
        workspace,
        "verification_access_denied",
        "Verification input has no readable workspace grant",
        403,
      );
      const grant = decideBoth(
        workspace,
        relative(workspace.path, lexical).split(sep).join("/"),
        relative(workspace.path, actual).split(sep).join("/"),
      );
      assert(
        grant.access !== "none",
        "verification_access_denied",
        `Verification cannot read ${rel}: ${grant.reason}`,
        403,
      );
      const file = await open(
        actual,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const before = await file.stat();
        assert(
          before.isFile() && before.size <= MAX_SOURCE_BYTES,
          "verification_source_limit",
          "Verification sources must be bounded regular files",
          400,
        );
        const content = await file.readFile();
        const after = await file.stat();
        assert(
          before.size === after.size &&
            before.mtimeMs === after.mtimeMs &&
            content.length === after.size,
          "verification_source_changed",
          "Source changed while creating its verification snapshot",
          409,
        );
        total += content.length;
        assert(
          total <= MAX_SOURCE_BYTES,
          "verification_source_limit",
          "Verification source set exceeds 4 MB",
          400,
        );
        inputs.push({
          manifest: { path: rel, sha256: hash(content), bytes: content.length },
          content,
        });
      } finally {
        await file.close();
      }
    }
    return inputs;
  }
  /** Recheck current files as well as immutable evidence; a successful old run never approves edits. */
  async require(
    task: Task,
    check: Extract<CompletionCheck, { type: "execution-verified" }>,
  ) {
    const { type: _type, ...raw } = check;
    const spec = normalizedSpec(raw);
    const root = await this.root(task);
    const inputs = await this.readSources(task, root, spec);
    const snapshotHash = hash(
      JSON.stringify(inputs.map((input) => input.manifest)),
    );
    const reference = this.service.store.get<VerificationReference>(
      "verification-reference",
      spec.referenceId,
    );
    assert(
      reference.hash === hash(reference.stdout),
      "verification_reference_invalid",
      "Stored verification reference failed its identity check",
      500,
    );
    const requestHash = hash(
      JSON.stringify({
        spec,
        sourceRoot: root,
        snapshotHash,
        referenceHash: reference.hash,
      }),
    );
    const record = this.list(task.id).findLast(
      (r) => r.requestHash === requestHash,
    );
    assert(
      record?.passed &&
        record.snapshotHash === snapshotHash &&
        record.referenceHash === reference.hash,
      "execution_not_verified",
      "No successful confined execution verifies the current source and reference",
      409,
    );
    assert(
      await snapshotMatches(
        join(record.snapshotDirectory, "Source"),
        record.sourceFiles,
      ),
      "execution_verification_stale",
      "The stored immutable snapshot has changed",
      409,
    );
    return record;
  }

  /** Synchronous final transition gate: current files/grants still identify the verified snapshot. */
  requireCurrent(
    task: Task,
    check: Extract<CompletionCheck, { type: "execution-verified" }>,
  ) {
    const { type: _type, ...raw } = check;
    const spec = normalizedSpec(raw);
    const reference = this.service.store.get<VerificationReference>(
      "verification-reference",
      spec.referenceId,
    );
    assert(
      reference.hash === hash(reference.stdout),
      "verification_reference_invalid",
      "Stored verification reference failed its identity check",
      500,
    );
    const record = this.list(task.id).findLast(
      (r) =>
        r.passed &&
        JSON.stringify(r.spec) === JSON.stringify(spec) &&
        r.referenceHash === reference.hash,
    );
    assert(
      record,
      "execution_not_verified",
      "No successful execution evidence exists for this check",
      409,
    );
    const agent = this.service.store.get<Agent>("agent", task.agentId);
    const contract = this.service.contracts.effective(task);
    const currentRoot =
      task.resourcePaths?.[0] ?? agent.workspaces.find((w) => w.active)?.path;
    assert(
      currentRoot && realpathSync(currentRoot) === record.sourceRoot,
      "execution_verification_stale",
      "The current task root differs from its verified source snapshot",
      409,
    );
    if (contract?.projectFolder)
      assert(
        contains(realpathSync(contract.projectFolder), record.sourceRoot),
        "execution_verification_stale",
        "Verified source is outside the confirmed project folder",
        403,
      );
    const policy = filesystemPolicy(this.service.store);
    for (const source of record.sourceFiles) {
      const lexical = resolve(record.sourceRoot, source.path);
      const actual = realpathSync(lexical);
      policy.assertPath(lexical, false);
      policy.assertPath(actual, false);
      assert(
        !lstatSync(lexical).isSymbolicLink() &&
          contains(record.sourceRoot, actual),
        "execution_verification_stale",
        "Verified source changed its filesystem target",
        409,
      );
      const workspace = agent.workspaces
        .filter((w) => contains(w.path, lexical) && contains(w.path, actual))
        .sort((a, b) => b.path.length - a.path.length)[0];
      assert(
        workspace &&
          decideBoth(
            workspace,
            relative(workspace.path, lexical).split(sep).join("/"),
            relative(workspace.path, actual).split(sep).join("/"),
          ).access !== "none",
        "execution_verification_stale",
        "Read access to the verified source has changed",
        403,
      );
      assert(
        hash(readFileSync(actual)) === source.sha256,
        "execution_verification_stale",
        "Source changed after execution verification; a new run and reviews are required",
        409,
      );
      assert(
        hash(
          readFileSync(join(record.snapshotDirectory, "Source", source.path)),
        ) === source.sha256,
        "execution_verification_stale",
        "The stored immutable snapshot has changed",
        409,
      );
    }
    return record;
  }

  async verify(
    taskId: string,
    input: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<ExecutionVerificationRecord> {
    const spec = normalizedSpec(input);
    const task = this.service.store.get<Task>("task", taskId);
    const reference = this.service.store.get<VerificationReference>(
      "verification-reference",
      spec.referenceId,
    );
    assert(
      reference.hash === hash(reference.stdout),
      "verification_reference_invalid",
      "Stored verification reference failed its identity check",
      500,
    );
    const root = await this.root(task);
    const inputs = await this.readSources(task, root, spec);
    const snapshotHash = hash(JSON.stringify(inputs.map((r) => r.manifest)));
    const requestHash = hash(
      JSON.stringify({
        spec,
        sourceRoot: root,
        snapshotHash,
        referenceHash: reference.hash,
      }),
    );
    const previous = this.list(taskId).findLast(
      (r) =>
        r.requestHash === requestHash &&
        ["passed", "failed"].includes(r.status),
    );
    if (previous) {
      if (previous.passed)
        assert(
          await snapshotMatches(
            join(previous.snapshotDirectory, "Source"),
            previous.sourceFiles,
          ),
          "execution_verification_stale",
          "The stored immutable snapshot has changed",
          409,
        );
      return previous;
    }
    assert(
      !this.active.has(taskId),
      "verification_busy",
      "This task already has an execution verification in progress",
      409,
    );
    const existingLease = this.service.store
      .list<Lease>("lease")
      .find((lease) => lease.id === task.id);
    assert(
      !existingLease?.processPids?.some(pidAlive),
      "verification_busy",
      "Wait until this task's provider process has stopped before verifying its source",
      409,
    );
    const id = randomUUID();
    this.service.resources.acquireSlot(pool, id, 1);
    let acquired = false;
    try {
      if (!existingLease) {
        this.service.resources.acquire(task.id, task.agentId, task.workflowId);
        acquired = true;
      }
    } catch (error) {
      this.service.resources.releaseSlot(id);
      throw error;
    }
    this.active.add(taskId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    this.controllers.set(taskId, controller);
    const startedAt = new Date().toISOString();
    const snapshotDirectory = join(this.directory, id);
    const inputDirectory = join(snapshotDirectory, "Source");
    const outputDirectory = join(snapshotDirectory, "Output");
    let record: ExecutionVerificationRecord = {
      id,
      taskId,
      workflowId: task.workflowId,
      spec,
      requestHash,
      sourceRoot: root,
      sourceFiles: inputs.map((r) => r.manifest),
      snapshotHash,
      snapshotDirectory,
      referenceId: reference.id,
      referenceHash: reference.hash,
      passed: false,
      status: "failed",
      reason: "Verification has not run",
      stdout: "",
      stderr: "",
      commands: [],
      binaryHash: null,
      toolchain: null,
      startedAt,
      finishedAt: startedAt,
    };
    const ledger = this.service.recovery.ledger;
    let effect: ReturnType<typeof ledger.begin>;
    try {
      effect = ledger.begin({
        taskId,
        key: `execution-verification:${taskId}:${requestHash}`,
        kind: "execution-verification",
        description: `Confined execution verification of ${spec.entry}`,
        mutating: false,
        ref: { verificationId: id, snapshotHash, referenceId: reference.id },
      });
    } catch (error) {
      this.active.delete(taskId);
      this.controllers.delete(taskId);
      options.signal?.removeEventListener("abort", abort);
      if (acquired) this.service.resources.release(task.id);
      this.service.resources.releaseSlot(id);
      throw error;
    }
    try {
      assert(
        process.platform === "darwin" || process.platform === "linux",
        "verifier_unavailable",
        "Confined execution verification is unavailable on this platform",
        409,
      );
      assert(
        effect.action !== "replay",
        "verification_evidence_missing",
        "The completed verification effect has no corresponding evidence record",
        409,
      );
      const policy = filesystemPolicy(this.service.store);
      policy.assertPath(snapshotDirectory);
      await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
      await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
      for (const source of inputs) {
        const target = join(inputDirectory, source.manifest.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, source.content, { flag: "wx", mode: 0o400 });
      }
      const manifest = {
        id,
        taskId,
        sourceRoot: root,
        requestHash,
        snapshotHash,
        sources: record.sourceFiles,
        referenceId: reference.id,
        referenceHash: reference.hash,
        spec,
      };
      await writeFile(
        join(snapshotDirectory, "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
        { flag: "wx", mode: 0o400 },
      );
      await freezeDirectory(inputDirectory);
      const executable = await verificationExecutable(
        spec.language === "python"
          ? ["python3"]
          : spec.language === "cpp"
            ? ["clang++", "g++"]
            : ["node"],
      );
      const roots = verificationRuntimeRoots(executable);
      for (const path of roots) policy.assertPath(path);
      const run = async (
        program: string,
        args: string[],
        allowFork = false,
      ) => {
        const result = await runVerificationCommand({
          executable: program,
          args,
          inputDirectory,
          outputDirectory,
          readRoots: roots,
          deniedRoots: policy.paths(),
          timeoutMs: spec.timeoutMs,
          signal: controller.signal,
          stdin: spec.stdin,
          allowFork,
          onSpawn: (pid) => this.service.resources.attachProcess(task.id, pid),
        });
        record.commands.push(result);
        return result;
      };
      const version = await run(executable, [
        spec.language === "python" ? "--version" : "--version",
      ]);
      assert(
        version.exitCode === 0 && !version.timedOut && !version.truncated,
        "verifier_unavailable",
        "The installed toolchain cannot start inside mandatory confinement",
        409,
      );
      record.toolchain = {
        executable,
        version: (version.stdout || version.stderr).trim().slice(0, 2000),
      };
      const entry = join(inputDirectory, spec.entry);
      let result: ConfinedResult;
      if (spec.language === "python") {
        const bootstrap = join(outputDirectory, "python-verifier.py");
        await writeFile(bootstrap, pythonBootstrap(spec.standardLibraryOnly), {
          flag: "wx",
          mode: 0o400,
        });
        result = await run(executable, [
          "-I",
          "-S",
          "-B",
          bootstrap,
          inputDirectory,
          entry,
          ...spec.args,
        ]);
      } else if (spec.language === "cpp") {
        if (spec.standardLibraryOnly) assertCppStandardOnly(inputs);
        const binary = join(outputDirectory, "verified-program");
        const sdkArguments: string[] = [];
        if (process.platform === "darwin") {
          const developer =
            executable.match(/^(.*\.app\/Contents\/Developer)\//)?.[1] ??
            "/Library/Developer/CommandLineTools";
          const sdk = join(
            developer,
            developer.includes(".app/")
              ? "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
              : "SDKs/MacOSX.sdk",
          );
          sdkArguments.push("-isysroot", await realpath(sdk));
        }
        const build = await run(
          executable,
          [
            "-std=c++20",
            "-O0",
            ...sdkArguments,
            entry,
            "-o",
            binary,
            process.platform === "darwin" ? "-lc++" : "-lstdc++",
          ],
          true,
        );
        assert(
          build.exitCode === 0 && !build.timedOut && !build.truncated,
          "verification_build_failed",
          `Compiler failed: ${build.stderr.slice(0, 1000)}`,
          409,
        );
        record.binaryHash = hash(await readFile(binary));
        result = await run(binary, spec.args);
        assert(
          hash(await readFile(binary)) === record.binaryHash,
          "verification_binary_changed",
          "The compiled program changed during execution",
          409,
        );
      } else {
        if (spec.standardLibraryOnly) assertJavaScriptStandardOnly(inputs);
        result = await run(executable, [
          "--permission",
          `--allow-fs-read=${inputDirectory}`,
          `--allow-fs-read=${outputDirectory}`,
          `--allow-fs-write=${outputDirectory}`,
          "--max-old-space-size=128",
          ...(spec.language === "typescript"
            ? ["--experimental-strip-types"]
            : []),
          entry,
          ...spec.args,
        ]);
      }
      record.stdout = result.stdout;
      record.stderr = result.stderr;
      const snapshotIntact = await snapshotMatches(
        inputDirectory,
        record.sourceFiles,
      );
      const current = await this.readSources(task, root, spec);
      const unchanged =
        hash(JSON.stringify(current.map((r) => r.manifest))) === snapshotHash;
      record.passed =
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.cancelled &&
        !result.truncated &&
        snapshotIntact &&
        unchanged &&
        matchesOutput(result.stdout, reference);
      record.status = result.cancelled
        ? "cancelled"
        : record.passed
          ? "passed"
          : "failed";
      record.reason = result.cancelled
        ? "Verification cancelled"
        : result.timedOut
          ? "Verification timed out"
          : result.truncated
            ? "Verification output exceeded its limit"
            : !snapshotIntact
              ? "Immutable snapshot changed during verification"
              : !unchanged
                ? "Current source changed after the verified snapshot was taken"
                : result.exitCode !== 0
                  ? `Program exited with code ${result.exitCode}`
                  : !matchesOutput(result.stdout, reference)
                    ? "Entire program output or its length does not match the independent reference"
                    : "Confined execution matched the entire independent reference for the current immutable source snapshot";
    } catch (error) {
      const code = (error as { code?: string }).code;
      record.errorCode = controller.signal.aborted
        ? "verification_cancelled"
        : (code ?? "verification_failed");
      record.status = controller.signal.aborted
        ? "cancelled"
        : code === "verifier_unavailable" ||
            code === "filesystem_sandbox_required"
          ? "unavailable"
          : "failed";
      record.reason =
        error instanceof Error ? error.message : "Verification failed";
      record.stderr ||= record.commands.at(-1)?.stderr ?? "";
      record.stdout ||= record.commands.at(-1)?.stdout ?? "";
    } finally {
      record.finishedAt = new Date().toISOString();
      try {
        this.service.store.put("execution-verification", record);
        if (record.status === "unavailable" || record.status === "cancelled")
          ledger.fail(effect.effect.id, record.reason);
        else ledger.complete(effect.effect.id, record.id);
        this.service.store.emit("task.execution_verified", task.id, {
          verificationId: record.id,
          passed: record.passed,
          status: record.status,
          snapshotHash,
          referenceId: reference.id,
          reason: record.reason,
        });
      } finally {
        this.active.delete(taskId);
        this.controllers.delete(taskId);
        options.signal?.removeEventListener("abort", abort);
        try {
          if (acquired) this.service.resources.release(task.id);
        } finally {
          this.service.resources.releaseSlot(id);
        }
      }
    }
    return record;
  }
}

export function matchesOutput(
  stdout: string,
  reference: VerificationReference,
) {
  return (
    stdout === reference.stdout ||
    (reference.newline === "optional-one" &&
      (stdout === reference.stdout + "\n" ||
        stdout === reference.stdout + "\r\n"))
  );
}
async function freezeDirectory(path: string) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await freezeDirectory(join(path, entry.name));
  await chmod(path, 0o500);
}
async function snapshotMatches(root: string, sources: VerificationInput[]) {
  for (const source of sources)
    if (hash(await readFile(join(root, source.path))) !== source.sha256)
      return false;
  return true;
}
function pythonBootstrap(standardOnly: boolean) {
  return `import ast, os, runpy, sys, resource\nroot, entry = sys.argv[1:3]\nsys.argv = sys.argv[2:]\nsys.path.insert(0, root)\nsys.path.insert(0, os.path.dirname(entry))\nresource.setrlimit(resource.RLIMIT_CPU, (60,60))\nresource.setrlimit(resource.RLIMIT_FSIZE, (16000000,16000000))\n${standardOnly ? `import pkgutil, sysconfig\nstdlib = sysconfig.get_path('stdlib')\nstandard = getattr(sys, 'stdlib_module_names', None)\nif standard is None: standard = set(sys.builtin_module_names) | {m.name for m in pkgutil.iter_modules([stdlib, os.path.join(stdlib, 'lib-dynload')]) if m.name.isidentifier()}\nlocal_roots = {root, os.path.dirname(entry)}\nallowed = set(standard) | {os.path.splitext(f)[0] for local in local_roots for f in os.listdir(local) if f.endswith('.py') or os.path.isdir(os.path.join(local, f))}\nfor base, dirs, files in os.walk(root):\n for filename in files:\n  if filename.endswith('.py'):\n   filename = os.path.join(base, filename)\n   tree = ast.parse(open(filename, encoding='utf-8').read(), filename)\n   for node in ast.walk(tree):\n    names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) and node.level == 0 else []\n    for name in names:\n     if name.split('.')[0] not in allowed: raise RuntimeError('External import is forbidden: ' + name)\ndef audit(event, args):\n if event in ('os.exec', 'os.posix_spawn', 'os.system', 'subprocess.Popen', 'ctypes.dlopen'): raise PermissionError('Launching another runtime or dynamic library is forbidden')\n if event == 'import' and args[0].split('.')[0] not in allowed: raise RuntimeError('External import is forbidden: ' + args[0])\nsys.addaudithook(audit)\n` : ""}runpy.run_path(entry, run_name='__main__')\n`;
}
const CPP_STANDARD_HEADERS = new Set(
  "algorithm any array atomic barrier bit bitset cassert cctype cerrno cfenv cfloat charconv chrono cinttypes ciso646 climits clocale cmath codecvt compare complex concepts condition_variable coroutine csetjmp csignal cstdarg cstddef cstdint cstdio cstdlib cstring ctgmath ctime cuchar cwchar cwctype deque exception execution expected filesystem format forward_list fstream functional future initializer_list iomanip ios iosfwd iostream istream iterator latch limits list map memory memory_resource mutex new numbers numeric optional ostream queue random ranges ratio regex scoped_allocator semaphore set shared_mutex source_location span sstream stack stdexcept stop_token streambuf string string_view strstream syncstream system_error thread tuple type_traits typeindex typeinfo unordered_map unordered_set utility valarray variant vector version".split(
    " ",
  ),
);
function assertCppStandardOnly(
  inputs: { manifest: VerificationInput; content: Buffer }[],
) {
  const files = new Set(inputs.map((r) => r.manifest.path));
  for (const source of inputs)
    for (const match of source.content
      .toString("utf8")
      .matchAll(/^\s*#\s*include\s*([<"])([^>"\n]+)[>"]/gm)) {
      const include = match[2];
      assert(
        match[1] === "<"
          ? CPP_STANDARD_HEADERS.has(include)
          : files.has(
              join(dirname(source.manifest.path), include).split(sep).join("/"),
            ),
        "verification_external_dependency",
        `External or undeclared include is forbidden: ${include}`,
        409,
      );
    }
}
function assertJavaScriptStandardOnly(
  inputs: { manifest: VerificationInput; content: Buffer }[],
) {
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/, "")),
  );
  for (const source of inputs) {
    const text = source.content.toString("utf8");
    for (const match of text.matchAll(
      /(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s+|\bimport\s+)["']([^"']+)["']/g,
    ))
      assert(
        builtins.has(match[1].replace(/^node:/, "")) ||
          match[1].startsWith("./") ||
          match[1].startsWith("../"),
        "verification_external_dependency",
        `External import is forbidden: ${match[1]}`,
        409,
      );
  }
}
