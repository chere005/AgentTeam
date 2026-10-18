import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { RunManager } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { SkillCatalog } from "./skills.ts";
import { Store } from "./store.ts";
import { TeamService } from "./service.ts";
import {
  buildTimeline,
  explainWaiting,
  type TimelineEntry,
} from "./inspector.ts";
import { Redactor } from "./redact.ts";
import { boundedRegexTest } from "./limits.ts";
import { AppError, agentSchema, assert } from "./model.ts";
import type { Agent, Edge, Rule, Task } from "./model.ts";

/**
 * Team playground: run a saved example against a COPY of the team in an isolated in-memory
 * store and a throw-away workspace directory, with the scripted fixture runtime only. No live
 * provider is ever started and the user's store, folders and leases are never touched. Runs are
 * persisted (redacted) as `playground-run` entities so two of them can be compared.
 */
const key = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
export const fixtureScriptSchema = z
  .object({
    text: z.string().max(20_000).optional(),
    tools: z
      .array(
        z
          .object({
            title: z.string().max(200),
            kind: z.string().max(40).default("other"),
            locations: z.array(z.string().max(500)).max(10).default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    fail: z.string().max(2000).optional(),
    usage: z
      .object({
        input_tokens: z.number().int().min(0).default(0),
        output_tokens: z.number().int().min(0).default(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FixtureScript = z.infer<typeof fixtureScriptSchema>;
const taskStep = z
  .object({
    key,
    title: z.string().min(1).max(300),
    /** Agent name (stable across copies of the team). */
    agent: z.string().min(1).max(120),
    instructions: z.string().max(20_000).default(""),
    completionCriteria: z.string().min(1).max(2000).default("A response"),
    dependsOn: z.array(key).max(20).default([]),
    invokedBy: z.string().max(120).optional(),
    requiresValidation: z.boolean().optional(),
  })
  .strict();
const expectation = z
  .object({
    status: z
      .enum(["completed", "failed", "cancelled", "queued", "running"])
      .optional(),
    resultIncludes: z.array(z.string().min(1).max(500)).max(20).default([]),
    resultExcludes: z.array(z.string().min(1).max(500)).max(20).default([]),
    resultMatches: z.string().max(300).optional(),
  })
  .strict();
export const exampleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    tasks: z.array(taskStep).min(1).max(30),
    /** Controlled inputs: relative path -> text written into the isolated workspace. */
    files: z.record(z.string().max(200), z.string().max(100_000)).default({}),
    /** Scripted runtime output per agent name (array = one entry per invocation, last repeats) or "task:<key>". */
    fixture: z
      .record(
        z.string().max(130),
        z.union([
          fixtureScriptSchema,
          z.array(fixtureScriptSchema).min(1).max(10),
        ]),
      )
      .default({}),
    expected: z
      .object({
        workflowStatus: z
          .enum(["completed", "needs-attention", "paused", "running", "queued"])
          .optional(),
        tasks: z.record(key, expectation).default({}),
        maxTurns: z.number().int().min(0).optional(),
      })
      .strict()
      .default({ tasks: {} }),
  })
  .strict();
export type Example = z.infer<typeof exampleSchema> & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
const overridesSchema = z
  .object({
    /** Per agent name: fields to change for this run only (prompts, models, effort, tools, priority). */
    agents: z
      .record(
        z.string(),
        z
          .object({
            model: z.string().min(1).optional(),
            effort: z.string().min(1).nullable().optional(),
            role: z.string().max(4000).optional(),
            instructions: z.string().max(100_000).optional(),
            schedulingPriority: z.number().int().min(0).max(101).optional(),
            tools: z.array(z.string().min(1)).optional(),
            skills: agentSchema.shape.skills.optional(),
          })
          .strict(),
      )
      .default({}),
    fixture: exampleSchema.shape.fixture.optional(),
  })
  .strict();
export const runRequestSchema = z
  .object({
    exampleId: z.string().optional(),
    example: exampleSchema.optional(),
    label: z.string().max(120).optional(),
    overrides: overridesSchema.default({ agents: {} }),
    maxSeconds: z.number().min(1).max(60).default(20),
  })
  .strict()
  .refine((r) => !!r.exampleId !== !!r.example, {
    message: "Provide exactly one of exampleId or example",
  });

export type ConfigSnapshot = {
  agents: Record<string, Record<string, unknown>>;
  edges: string[];
  rules: Record<string, unknown>[];
  fixture: unknown;
};
export type RunOutcome = {
  key: string;
  title: string;
  agent: string;
  status: string;
  result: string;
  resultHash: string;
  waiting: string | null;
};
export type RunTimelineEntry = {
  i: number;
  sig: string;
  type: string;
  category: string;
  severity: string;
  summary: string;
  agentName: string | null;
  taskKey: string | null;
  offsetMs: number;
  data: unknown;
};
export type PlaygroundRun = {
  id: string;
  exampleId: string | null;
  exampleName: string;
  label: string;
  mode: "fixture";
  startedAt: string;
  durationMs: number;
  stalled: boolean;
  workflowStatus: string;
  turns: number;
  config: ConfigSnapshot;
  outcomes: RunOutcome[];
  timeline: RunTimelineEntry[];
  workspace: { files: { path: string; bytes: number }[] };
  expectations: {
    passed: boolean;
    checks: { name: string; passed: boolean; detail: string }[];
  };
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const als = new AsyncLocalStorage<{
  task: Task;
  key: string;
  agent: Agent;
  attempt: number;
}>();

function safeRelative(p: string) {
  const n = normalize(p);
  assert(
    !isAbsolute(n) &&
      n !== ".." &&
      !n.startsWith(".." + sep) &&
      !n.split(sep).includes(".git"),
    "invalid_path",
    `Example file path "${p}" must be relative to the workspace`,
    400,
  );
  return n;
}

export class Playground {
  service: TeamService;
  redactor: () => Redactor;
  running = false;
  /** Test seam: observes the sandbox copy (service, run manager) before it is driven. */
  onSandbox?: (sandbox: { service: TeamService; runs: RunManager }) => void;
  constructor(service: TeamService, redactor: () => Redactor) {
    this.service = service;
    this.redactor = redactor;
  }
  private get store() {
    return this.service.store;
  }
  // ---- saved examples -------------------------------------------------------------------------
  examples(): Example[] {
    return this.store.list<Example>("playground-example");
  }
  example(id: string) {
    return this.store.get<Example>("playground-example", id);
  }
  saveExample(input: unknown, id?: string) {
    const data = exampleSchema.parse(input);
    for (const path of Object.keys(data.files)) safeRelative(path);
    const keys = new Set(data.tasks.map((t) => t.key));
    assert(
      keys.size === data.tasks.length,
      "duplicate_key",
      "Task keys must be unique",
      400,
    );
    for (const t of data.tasks)
      for (const d of t.dependsOn)
        assert(
          keys.has(d) && d !== t.key,
          "invalid_dependency",
          `Task ${t.key} depends on unknown task ${d}`,
          400,
        );
    for (const k of Object.keys(data.expected.tasks))
      assert(
        keys.has(k),
        "invalid_expectation",
        `Expectation names unknown task ${k}`,
        400,
      );
    const previous = id ? this.example(id) : undefined;
    const now = new Date().toISOString();
    const example: Example = {
      ...data,
      id: id ?? randomUUID(),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.transaction(() => {
      this.store.put("playground-example", example);
      this.store.emit(
        previous ? "playground.example_updated" : "playground.example_created",
        example.id,
      );
      return example;
    });
  }
  deleteExample(id: string) {
    this.example(id);
    this.store.transaction(() => {
      this.store.remove("playground-example", id);
      this.store.emit("playground.example_deleted", id);
    });
  }
  // ---- runs -----------------------------------------------------------------------------------
  runs(): Omit<PlaygroundRun, "timeline" | "outcomes" | "config">[] {
    return this.store.list<PlaygroundRun>("playground-run").map((r) => {
      const { timeline, outcomes, config, ...rest } = r;
      void timeline;
      void outcomes;
      void config;
      return rest;
    });
  }
  run(id: string) {
    return this.store.get<PlaygroundRun>("playground-run", id);
  }
  deleteRun(id: string) {
    this.run(id);
    this.store.remove("playground-run", id);
  }
  async execute(input: unknown): Promise<PlaygroundRun> {
    const req = runRequestSchema.parse(input);
    assert(
      !this.running,
      "playground_busy",
      "A playground run is already in progress",
      409,
    );
    const example: Omit<Example, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    } = req.example
      ? { ...exampleSchema.parse(req.example) }
      : this.example(req.exampleId!);
    for (const path of Object.keys(example.files)) safeRelative(path);
    this.running = true;
    const live = this.service;
    const started = Date.now();
    let made: string | undefined;
    let opened: Store | undefined;
    let scheduler: Scheduler | undefined;
    // Everything after `running = true` sits inside try so a setup failure cannot wedge the
    // playground at playground_busy.
    try {
      made = await mkdtemp(join(tmpdir(), "agentteam-playground-"));
      // realpath: launchPlan insists the active workspace path is canonical (macOS /var -> /private/var).
      const root = await realpath(made);
      const workspace = join(root, "workspace");
      const store = (opened = new Store(":memory:"));
      await mkdir(workspace, { recursive: true });
      for (const [path, text] of Object.entries(example.files)) {
        const target = join(workspace, safeRelative(path));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, text);
      }
      const catalog = new SkillCatalog([]);
      catalog.items = new Map(live.skills.items);
      // The copy never rescans the user's skill folders.
      catalog.scan = async () => catalog.items as never;
      const sandbox = new TeamService(store, catalog);
      const fixture = { ...example.fixture, ...(req.overrides.fixture ?? {}) };
      // ---- copy the team configuration (IDs preserved so snapshots line up) -------------------
      const liveAgents = live.store
        .list<Agent>("agent")
        .filter((a) => a.kind !== "team-assistant");
      const byName = new Map<string, Agent>();
      for (const a of liveAgents) {
        const patch = req.overrides.agents[a.name] ?? {};
        const { id, createdAt, control, teamId, ...rest } = a;
        void createdAt;
        void control;
        void teamId;
        const parsed = agentSchema.parse({ ...rest, ...patch });
        const workspaces = a.workspaces.length
          ? [
              {
                path: workspace,
                access: a.workspaces.some((w) => w.access === "write")
                  ? ("write" as const)
                  : ("read" as const),
                active: true,
              },
            ]
          : [];
        const copy: Agent = {
          ...parsed,
          workspaces,
          id,
          control: "team",
          createdAt: new Date().toISOString(),
        };
        store.put("agent", copy);
        byName.set(copy.name, copy);
      }
      for (const name of Object.keys(req.overrides.agents))
        assert(
          byName.has(name),
          "unknown_agent",
          `Override names unknown agent "${name}"`,
          400,
        );
      for (const step of example.tasks)
        assert(
          byName.has(step.agent),
          "unknown_agent",
          `Example task ${step.key} needs agent "${step.agent}", which is not on the team`,
          400,
        );
      const ids = new Set([...byName.values()].map((a) => a.id));
      for (const e of live.store.list<Edge>("edge"))
        if (ids.has(e.from) && ids.has(e.to)) store.put("edge", e);
      for (const r of live.store.list<Rule>("rule"))
        if (ids.has(r.agentId) && (!r.targetId || ids.has(r.targetId)))
          store.put("rule", r);
      // ---- workflow and tasks ---------------------------------------------------------------
      const owner = byName.get(example.tasks[0].agent)!;
      const wf = sandbox.workflow({
        name: `Playground: ${example.name}`,
        goal: example.description || example.name,
        ownerId: owner.id,
        completionCriteria: "All example tasks reach a final state",
      });
      const idByKey = new Map<string, string>();
      const keyById = new Map<string, string>();
      const pending = [...example.tasks];
      while (pending.length) {
        const i = pending.findIndex((t) =>
          t.dependsOn.every((d) => idByKey.has(d)),
        );
        assert(
          i >= 0,
          "dependency_cycle",
          "Example tasks contain a dependency cycle",
          400,
        );
        const step = pending.splice(i, 1)[0];
        const task = sandbox.task({
          workflowId: wf.id,
          agentId: byName.get(step.agent)!.id,
          title: step.title,
          instructions: step.instructions,
          completionCriteria: step.completionCriteria,
          dependsOn: step.dependsOn.map((d) => idByKey.get(d)!),
          ...(step.invokedBy
            ? { invokedBy: byName.get(step.invokedBy)?.id }
            : {}),
          ...(step.requiresValidation ? { requiresValidation: true } : {}),
        });
        idByKey.set(step.key, task.id);
        keyById.set(task.id, step.key);
      }
      // ---- fixture runtime ------------------------------------------------------------------
      const calls = new Map<string, number>();
      const runs = new RunManager(sandbox, true, workspace);
      // Chat runs in the copy must never reach a real provider: the sandbox has no live executor.
      runs.execute = async () => {
        throw new AppError(
          403,
          "playground_no_chat",
          "Conversation runs are not available in the playground",
        );
      };
      scheduler = new Scheduler(
        sandbox,
        runs,
        async (_command, _env, emit, signal) => {
          const ctx = als.getStore();
          assert(
            ctx,
            "fixture_context",
            "Fixture runtime used outside a playground task",
          );
          const script = pick(
            fixture[`task:${ctx.key}`] ?? fixture[ctx.agent.name],
            calls,
            ctx,
          );
          emit({ type: "session", data: `fixture-${ctx.task.id.slice(0, 8)}` });
          for (const [n, tool] of (script?.tools ?? []).entries()) {
            const base = {
              toolCallId: `fx-${n}`,
              kind: tool.kind,
              title: tool.title,
              locations: tool.locations.map((path) => ({ path })),
            };
            emit({ type: "tool", data: { ...base, status: "pending" } });
            emit({ type: "tool", data: { ...base, status: "completed" } });
          }
          if (script?.usage) emit({ type: "usage", data: script.usage });
          if (signal.aborted) throw new Error("aborted");
          if (script?.fail) throw new Error(script.fail);
          emit({
            type: "text",
            data:
              script?.text ??
              `Fixture response from ${ctx.agent.name} for "${ctx.task.title}"`,
          });
        },
      );
      this.onSandbox?.({ service: sandbox, runs });
      const execute = scheduler.execute.bind(scheduler);
      scheduler.execute = (task, plan, controller) =>
        als.run(
          {
            task,
            key: keyById.get(task.id) ?? task.id,
            agent: byName.get(
              sandbox.store.get<Agent>("agent", task.agentId).name,
            )!,
            attempt: 1,
          },
          () => execute(task, plan, controller),
        );
      // ---- drive to quiescence --------------------------------------------------------------
      const deadline = started + req.maxSeconds * 1000;
      let idle = 0,
        stalled = false;
      for (;;) {
        await scheduler.tick();
        await new Promise((r) => setTimeout(r, 5));
        const tasks = store.list<Task>("task");
        const live_ = tasks.filter(
          (t) => t.status === "running" || runs.active.size,
        ).length;
        const open = tasks.filter((t) =>
          ["queued", "running"].includes(t.status),
        );
        if (!open.length) break;
        idle = live_ ? 0 : idle + 1;
        if (idle > 8) {
          stalled = true;
          break;
        }
        if (Date.now() > deadline) {
          stalled = true;
          break;
        }
      }
      while (runs.active.size && Date.now() < deadline + 5000)
        await new Promise((r) => setTimeout(r, 10));
      // ---- collect --------------------------------------------------------------------------
      const redactor = this.redactor();
      const ctx = { liveEnabled: () => true };
      const tasks = store.list<Task>("task");
      const outcomes: RunOutcome[] = example.tasks.map((step) => {
        const t = tasks.find((x) => x.id === idByKey.get(step.key))!;
        const waiting =
          t.status === "queued"
            ? explainWaiting(sandbox, ctx, { taskId: t.id }).headline
            : null;
        const result = redactor.string(t.result ?? "");
        return {
          key: step.key,
          title: step.title,
          agent: step.agent,
          status: t.status,
          result,
          resultHash: sha(t.result ?? ""),
          waiting,
        };
      });
      const firstSeq = store.history(0, 1)[0]?.seq ?? 0;
      void firstSeq;
      const tl = buildTimeline(sandbox, { limit: 5000 }, redactor).entries;
      const t0 = tl.length ? Date.parse(tl[0].at) : started;
      const timeline = tl.map((e, i) => compactEntry(e, i, t0, keyById));
      const workflowStatus = sandbox.workflowStatus(wf.id).status;
      const turns = sandbox.limits.status(wf.id).counters.agentTurns;
      const files = await listFiles(workspace);
      const snapshot = configSnapshot(sandbox, redactor, fixture);
      const run: PlaygroundRun = {
        id: randomUUID(),
        exampleId: "id" in example && example.id ? example.id : null,
        exampleName: example.name,
        label: req.label ?? "",
        mode: "fixture",
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        stalled,
        workflowStatus,
        turns,
        config: snapshot,
        outcomes,
        timeline,
        workspace: { files },
        expectations: evaluate(
          example.expected,
          outcomes,
          workflowStatus,
          turns,
        ),
      };
      this.store.put("playground-run", run);
      return run;
    } finally {
      try {
        scheduler?.stop();
        opened?.close();
        if (made) await rm(made, { recursive: true, force: true });
      } finally {
        this.running = false;
      }
    }
  }
  compare(aId: string, bId: string) {
    return compareRuns(this.run(aId), this.run(bId));
  }
}

function pick(
  script: FixtureScript | FixtureScript[] | undefined,
  calls: Map<string, number>,
  ctx: { task: Task },
): FixtureScript | undefined {
  if (!Array.isArray(script)) return script;
  const n = calls.get(ctx.task.id) ?? 0;
  calls.set(ctx.task.id, n + 1);
  return script[Math.min(n, script.length - 1)];
}
async function listFiles(
  root: string,
  rel = "",
  out: { path: string; bytes: number }[] = [],
) {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = join(rel, entry.name);
    if (entry.isDirectory()) await listFiles(root, p, out);
    else if (entry.isFile())
      out.push({
        path: p.split(sep).join("/"),
        bytes: (await stat(join(root, p))).size,
      });
    if (out.length > 200) break;
  }
  return out;
}
function compactEntry(
  e: TimelineEntry,
  i: number,
  t0: number,
  keyById: Map<string, string>,
): RunTimelineEntry {
  const taskKey = e.taskId ? (keyById.get(e.taskId) ?? null) : null;
  const d = (e.data ?? {}) as Record<string, unknown>;
  const detail =
    e.type === "task.status"
      ? String(d.status ?? "")
      : e.type === "task.runtime"
        ? `${String(d.type ?? "")}:${String(((d.data ?? {}) as Record<string, unknown>).title ?? "")}:${String(((d.data ?? {}) as Record<string, unknown>).status ?? "")}`
        : e.type === "flow.transferred"
          ? String(d.kind ?? "")
          : e.type === "task.settings"
            ? [d.environment, d.model, d.effort, d.priority].join("/")
            : "";
  return {
    i,
    // Identity of a step independent of ids and clocks, for run-to-run diffs.
    sig: [e.category, e.type, e.agentName ?? "", taskKey ?? "", detail].join(
      "|",
    ),
    type: e.type,
    category: e.category,
    severity: e.severity,
    summary: e.summary,
    agentName: e.agentName,
    taskKey,
    offsetMs: Date.parse(e.at) - t0,
    data:
      e.severity === "debug" && e.type === "task.runtime" ? undefined : e.data,
  };
}
function configSnapshot(
  sandbox: TeamService,
  redactor: Redactor,
  fixture: unknown,
): ConfigSnapshot {
  const agents = sandbox.store.list<Agent>("agent");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return {
    agents: Object.fromEntries(
      agents.map((a) => [
        a.name,
        {
          environment: a.environment,
          model: a.model,
          effort: a.effort,
          schedulingPriority: a.schedulingPriority,
          maxConcurrentInvocations: a.maxConcurrentInvocations,
          tools: [...a.tools].sort(),
          skills: a.skills.map((s) => `${s.id}:${s.mode}`).sort(),
          role: redactor.string(a.role),
          instructions: redactor.string(a.instructions),
          instructionsHash: sha(a.instructions).slice(0, 12),
          access: a.workspaces.map((w) => w.access).join(",") || "none",
        },
      ]),
    ),
    edges: sandbox.store
      .list<Edge>("edge")
      .map(
        (e) =>
          `${name(e.from)} ${e.bidirectional ? "<->" : "->"} ${name(e.to)} [${e.kind}${e.enabled ? "" : ", disabled"}]`,
      )
      .sort(),
    rules: sandbox.store.list<Rule>("rule").map((r) => ({
      agent: name(r.agentId),
      target: r.targetId ? name(r.targetId) : null,
      scope: r.scope,
      kind: r.kind,
      priority: r.priority,
      enabled: r.enabled,
      match: r.match,
    })),
    fixture: redactor.value(fixture),
  };
}
function evaluate(
  expected: Example["expected"],
  outcomes: RunOutcome[],
  workflowStatus: string,
  turns: number,
) {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  const check = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail });
  if (expected.workflowStatus)
    check(
      "workflow status",
      workflowStatus === expected.workflowStatus,
      `expected ${expected.workflowStatus}, got ${workflowStatus}`,
    );
  if (expected.maxTurns !== undefined)
    check(
      "agent turns",
      turns <= expected.maxTurns,
      `${turns} used, at most ${expected.maxTurns}`,
    );
  for (const [k, e] of Object.entries(expected.tasks)) {
    const o = outcomes.find((x) => x.key === k);
    if (!o) continue;
    if (e.status)
      check(
        `${k}: status`,
        o.status === e.status,
        `expected ${e.status}, got ${o.status}`,
      );
    for (const s of e.resultIncludes)
      check(
        `${k}: includes "${s}"`,
        o.result.includes(s),
        o.result.includes(s) ? "found" : "missing from result",
      );
    for (const s of e.resultExcludes)
      check(
        `${k}: excludes "${s}"`,
        !o.result.includes(s),
        o.result.includes(s) ? "present in result" : "absent",
      );
    if (e.resultMatches) {
      let ok = false;
      try {
        ok = boundedRegexTest(e.resultMatches, "", o.result) === true;
      } catch {
        /* invalid pattern fails the check */
      }
      check(
        `${k}: matches /${e.resultMatches}/`,
        ok,
        ok ? "matched" : "no match",
      );
    }
  }
  return { passed: checks.every((c) => c.passed), checks };
}

// ---- comparison -----------------------------------------------------------------------------
type Change = { field: string; before: unknown; after: unknown };
function diffObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Change[] {
  const out: Change[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      out.push({ field: k, before: a[k], after: b[k] });
  return out;
}
export function diffSequences(a: string[], b: string[]) {
  // Longest common subsequence; capped so a pathological pair cannot stall the backend.
  const A = a.slice(0, 2000),
    B = b.slice(0, 2000);
  const w = B.length + 1;
  const t = new Uint16Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      t[i * w + j] =
        A[i] === B[j]
          ? t[(i + 1) * w + j + 1] + 1
          : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const ops: { op: "same" | "removed" | "added"; sig: string }[] = [];
  let i = 0,
    j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) (ops.push({ op: "same", sig: A[i++] }), j++);
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1])
      ops.push({ op: "removed", sig: A[i++] });
    else ops.push({ op: "added", sig: B[j++] });
  }
  while (i < A.length) ops.push({ op: "removed", sig: A[i++] });
  while (j < B.length) ops.push({ op: "added", sig: B[j++] });
  return ops;
}
export function compareRuns(a: PlaygroundRun, b: PlaygroundRun) {
  const names = new Set([
    ...Object.keys(a.config.agents),
    ...Object.keys(b.config.agents),
  ]);
  const agents = [...names]
    .map((n) => ({
      name: n,
      state: !a.config.agents[n]
        ? "added"
        : !b.config.agents[n]
          ? "removed"
          : "kept",
      changes:
        a.config.agents[n] && b.config.agents[n]
          ? diffObject(a.config.agents[n], b.config.agents[n])
          : [],
    }))
    .filter((x) => x.state !== "kept" || x.changes.length);
  const set = (x: string[]) => new Set(x);
  const edges = {
    added: b.config.edges.filter((e) => !set(a.config.edges).has(e)),
    removed: a.config.edges.filter((e) => !set(b.config.edges).has(e)),
  };
  const ruleKey = (r: unknown) => JSON.stringify(r);
  const rules = {
    added: b.config.rules.filter(
      (r) => !a.config.rules.some((x) => ruleKey(x) === ruleKey(r)),
    ),
    removed: a.config.rules.filter(
      (r) => !b.config.rules.some((x) => ruleKey(x) === ruleKey(r)),
    ),
  };
  const fixtureChanged =
    JSON.stringify(a.config.fixture) !== JSON.stringify(b.config.fixture);
  const keys = [
    ...new Set([
      ...a.outcomes.map((o) => o.key),
      ...b.outcomes.map((o) => o.key),
    ]),
  ];
  const outcomes = keys.map((k) => {
    const x = a.outcomes.find((o) => o.key === k),
      y = b.outcomes.find((o) => o.key === k);
    return {
      key: k,
      a: x ? { status: x.status, result: x.result.slice(0, 600) } : null,
      b: y ? { status: y.status, result: y.result.slice(0, 600) } : null,
      statusChanged: x?.status !== y?.status,
      resultChanged: x?.resultHash !== y?.resultHash,
    };
  });
  const sigs = (r: PlaygroundRun) =>
    r.timeline.filter((e) => e.severity !== "debug").map((e) => e.sig);
  const ops = diffSequences(sigs(a), sigs(b));
  const timeline = {
    same: ops.filter((o) => o.op === "same").length,
    removed: ops.filter((o) => o.op === "removed").map((o) => o.sig),
    added: ops.filter((o) => o.op === "added").map((o) => o.sig),
    ops: ops.slice(0, 600),
  };
  const configChanged = !!(
    agents.length ||
    edges.added.length ||
    edges.removed.length ||
    rules.added.length ||
    rules.removed.length ||
    fixtureChanged
  );
  const outcomesChanged = outcomes.filter(
    (o) => o.statusChanged || o.resultChanged,
  ).length;
  return {
    a: {
      id: a.id,
      name: a.exampleName,
      label: a.label,
      startedAt: a.startedAt,
    },
    b: {
      id: b.id,
      name: b.exampleName,
      label: b.label,
      startedAt: b.startedAt,
    },
    config: { changed: configChanged, agents, edges, rules, fixtureChanged },
    outcomes: {
      changed: outcomesChanged,
      workflow: { a: a.workflowStatus, b: b.workflowStatus },
      tasks: outcomes,
    },
    expectations: { a: a.expectations.passed, b: b.expectations.passed },
    timeline,
    summary: `${configChanged ? "Configuration changed" : "Configuration identical"}; ${outcomesChanged} of ${outcomes.length} task outcome(s) differ; timeline has ${timeline.added.length} added and ${timeline.removed.length} removed step(s); expectations ${a.expectations.passed ? "passed" : "failed"} -> ${b.expectations.passed ? "passed" : "failed"}.`,
  };
}
