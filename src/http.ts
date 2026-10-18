import { DevelopmentService } from "./development.ts";
import { DevServerService } from "./devserver-service.ts";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { RuntimeDiscovery } from "./discovery.ts";
import { runtimeCapabilities } from "./capabilities.ts";
import { TeamTemplates } from "./teams.ts";
import {
  createWolframSample,
  sampleCatalog,
  verifySampleModels,
} from "./samples.ts";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { completionCheckSchema } from "./limits-schema.ts";
import { TeamService } from "./service.ts";
import { RunManager } from "./runtime.ts";
import { WorkspaceService } from "./workspaces.ts";
import { ReviewService } from "./reviews.ts";
import { recommendations } from "./config.ts";
import { recoveryRoute } from "./recovery-routes.ts";
import { WorkspaceExtras } from "./workspace-routes.ts";
import { createInspector } from "./inspector-routes.ts";
import { sharedRoute } from "./shared-routes.ts";
import { orchestrationRoute } from "./orchestration.ts";
import {
  AppError,
  type Agent,
  type Session,
  type Message,
  type Workflow,
  type Task,
} from "./model.ts";
async function body(req: IncomingMessage) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1_000_000)
      throw new AppError(413, "body_too_large", "Maximum request size is 1 MB");
    chunks.push(chunk);
  }
  if (!bytes) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON");
  }
}
const id = (value: string) => decodeURIComponent(value);
/** External launches requested through the API (recorded instead of run when AGENTTEAM_TEST=1). */
export type LaunchRecord =
  | { kind: "editor"; executable: string; args: string[]; application: string }
  | { kind: "url"; url: string };
export function createApi(
  service: TeamService,
  token: string,
  runs: RunManager,
  discovery = new RuntimeDiscovery(),
) {
  const store = service.store;
  // Test mode never starts editors, file managers or browsers: launches are recorded instead and
  // exposed at GET /test/launches (and as server.launches for in-process tests).
  const testMode = process.env.AGENTTEAM_TEST === "1";
  const launches: LaunchRecord[] = [];
  const workspaces = new WorkspaceService(store);
  const development = new DevelopmentService(service);
  const devservers = new DevServerService(service);
  const teams = new TeamTemplates(service, () => discovery.runtimes);
  const reviews = new ReviewService(service, workspaces);
  const extras = new WorkspaceExtras(
    store,
    workspaces,
    testMode
      ? {
          git: {
            openUrl: async (url) => {
              launches.push({ kind: "url", url });
            },
          },
          editors: {
            launcher: async (plan) => {
              launches.push({
                kind: "editor",
                executable: plan.executable,
                args: [...plan.args],
                application: plan.application,
              });
            },
          },
        }
      : {},
  );
  const inspector = createInspector(service, {
    token,
    context: {
      liveEnabled: () => runs.enabled,
      readiness: (environment) =>
        runs.readiness?.(environment) ?? { state: "ready" },
    },
    runtimes: () =>
      discovery.runtimes.map((r) => ({
        id: r.id,
        installed: r.installed,
        version: (r as { version?: string }).version,
        path: (r as { path?: string }).path,
      })),
  });
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const send = (data: unknown, status = 200) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(data));
    };
    try {
      // Local API is not a public web endpoint. No cross-origin browser access.
      if (req.headers.origin)
        throw new AppError(
          403,
          "origin_denied",
          "Use a trusted desktop bridge or same-origin proxy",
        );
      const auth = Buffer.from(req.headers.authorization ?? ""),
        expected = Buffer.from("Bearer " + token);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
        throw new AppError(
          401,
          "unauthorized",
          "Local API bearer token required",
        );
      const url = new URL(req.url ?? "/", "http://127.0.0.1"),
        path = url.pathname,
        method = req.method;
      let match: RegExpMatchArray | null;
      if (
        path === "/worktrees/settings" &&
        (method === "GET" || method === "PUT")
      )
        return send(
          method === "GET"
            ? development.worktrees.settings()
            : development.worktrees.saveSettings(await body(req)),
        );
      if (
        method === "POST" &&
        (match = path.match(
          /^\/agents\/([^/]+)\/worktrees\/(suggest|list|create|attach|setup|remove)$/,
        ))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        store.get<Agent>("agent", agentId);
        const wt = development.worktrees;
        if (action === "suggest") return send(await wt.suggest(agentId, data));
        if (action === "list") return send(await wt.list(agentId, data));
        if (action === "create")
          return send(await wt.create(agentId, data), 201);
        if (action === "attach") return send(await wt.attach(agentId, data));
        if (action === "remove") return send(await wt.remove(agentId, data));
        const { worktreeId, ...command } = data as { worktreeId?: string };
        if (typeof worktreeId !== "string")
          throw new AppError(400, "invalid_request", "worktreeId is required");
        return send(
          wt.runSetup(
            agentId,
            worktreeId,
            Object.keys(command).length ? command : undefined,
          ).setup,
        );
      }
      const devResult = await devservers.route(method, path, () => body(req));
      if (devResult !== undefined) return send(devResult);
      if (
        method === "POST" &&
        (match = path.match(
          /^\/agents\/([^/]+)\/development\/(worktree|feedback)$/,
        ))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        store.get<Agent>("agent", agentId);
        if (action === "worktree")
          return send(await development.worktree(agentId, data));
        if (action === "feedback") {
          const feedback = await development.feedback(agentId, data);
          let execution = "queued";
          if (runs.enabled) {
            try {
              await runs.start(feedback.sessionId);
              execution = "scheduled";
            } catch {
              execution = "queued — open the conversation to run it";
            }
          }
          return send({ ...feedback, execution });
        }
        throw new AppError(404, "not_found", "Unknown API endpoint");
      }
      if (
        method === "POST" &&
        (match = path.match(
          /^\/agents\/([^/]+)\/reviews\/(state|comment|resolve|reviewed|decide)$/,
        ))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        store.get<Agent>("agent", agentId);
        if (action === "state") return send(await reviews.state(agentId, data));
        if (action === "resolve") return send(reviews.resolve(agentId, data));
        if (action === "reviewed")
          return send(await reviews.setReviewed(agentId, data));
        const result: any =
          action === "comment"
            ? await reviews.comment(agentId, data)
            : await reviews.decide(agentId, data);
        const sessionId = result.sessionId;
        let execution = "queued";
        // Idempotent comment replays that were already scheduled/sent must not start a second run.
        if (
          sessionId &&
          runs.enabled &&
          result.delivery !== "sent" &&
          result.delivery !== "scheduled"
        ) {
          try {
            await runs.start(sessionId);
            execution = "scheduled";
            if (action === "comment") reviews.markScheduled(result.id);
          } catch {
            execution = "queued — open the conversation to run it";
          }
        }
        return send({ ...result, execution });
      }
      const inspected = await inspector.route(method, url, () => body(req));
      if (inspected) return send(inspected.data, inspected.status);
      const recovered = await recoveryRoute(service, method, url, () =>
        body(req),
      );
      if (recovered) return send(recovered.data, recovered.status);
      const sharedResult = await sharedRoute(service, method, url, () =>
        body(req),
      );
      if (sharedResult) return send(sharedResult.data, sharedResult.status);
      const orchestrated = await orchestrationRoute(service, method, url, () =>
        body(req),
      );
      if (orchestrated) return send(orchestrated.data, orchestrated.status);
      if (method === "GET" && path === "/approvals")
        return send(service.approvals.list());
      if (method === "POST" && (match = path.match(/^\/approvals\/([^/]+)$/))) {
        const data = z
          .object({ optionId: z.string().nullable() })
          .strict()
          .parse(await body(req));
        return send(service.approvals.respond(id(match[1]), data.optionId));
      }
      if (method === "GET" && path === "/connections")
        return send(
          Object.fromEntries(
            ["codex", "claude", "wolfram"].map((p) => [
              p,
              service.connection(p),
            ]),
          ),
        );
      if (
        method === "PUT" &&
        (match = path.match(/^\/connections\/(codex|claude|wolfram)$/))
      ) {
        const data = z
          .object({
            transport: z.enum(["direct", "acp"]),
            executable: z.string(),
            args: z.array(z.string()).max(30),
          })
          .strict()
          .parse(await body(req));
        if (
          data.transport === "acp" &&
          (!isAbsolute(data.executable) || !data.executable.trim())
        )
          throw new AppError(
            400,
            "invalid_executable",
            "Choose an absolute path to an installed ACP adapter executable",
          );
        if (
          store
            .list<Session>("session")
            .some(
              (s) =>
                s.state === "running" &&
                store.get<Agent>("agent", s.agentId).environment === match![1],
            ) ||
          store
            .list<any>("task")
            .some(
              (t) =>
                t.status === "running" &&
                store.get<Agent>("agent", t.agentId).environment === match![1],
            )
        )
          throw new AppError(
            409,
            "runtime_busy",
            "Finish active work before changing the connection",
          );
        const providers = Object.fromEntries(
          ["codex", "claude", "wolfram"].map((p) => [p, service.connection(p)]),
        );
        providers[match[1]] = data;
        store.put("settings", { id: "connections", providers });
        store.emit("connections.updated", match[1]);
        return send(data);
      }
      if (method === "GET" && path === "/resources")
        return send(service.resources.snapshot());
      if (method === "POST" && path === "/resources")
        return send(await service.resources.save(await body(req)));
      if (
        method === "PUT" &&
        (match = path.match(/^\/workflows\/([^/]+)\/coordination$/))
      )
        return send(
          service.resources.configureWorkflow(id(match[1]), await body(req)),
        );
      if (method === "GET" && path === "/snapshot")
        return send({
          agents: store.list<Agent>("agent"),
          edges: store.list("edge"),
          rules: store.list("rule"),
          workflows: store
            .list<Workflow>("workflow")
            .map((w) => service.workflowStatus(w.id)),
          sessions: store.list("session"),
          activity: store
            .list<Agent>("agent")
            .map((a) => service.activity(a.id)),
          liveExecution: runs.enabled,
        });
      if (method === "PUT" && path === "/execution") {
        const data = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(await body(req));
        runs.enabled = data.enabled;
        store.put("settings", { id: "execution", ...data });
        store.emit("execution.changed", "execution", data);
        return send(data);
      }
      if (
        method === "DELETE" &&
        (match = path.match(/^\/(edges|rules)\/([^/]+)$/))
      ) {
        const kind = match[1] === "edges" ? "edge" : "rule";
        store.get(kind, id(match[2]));
        store.remove(kind, id(match[2]));
        store.emit(kind + ".deleted", id(match[2]));
        return send({ status: "deleted" });
      }
      if (method === "DELETE" && (match = path.match(/^\/agents\/([^/]+)$/))) {
        const aid = id(match[1]);
        store.get("agent", aid);
        if (
          store.list<any>("task").some((t) => t.agentId === aid) ||
          store.list<Session>("session").some((s) => s.agentId === aid) ||
          store.list<Agent>("agent").some((a) => a.parentId === aid) ||
          store.list<Workflow>("workflow").some((w) => w.ownerId === aid)
        )
          throw new AppError(
            409,
            "agent_in_use",
            "Agents with sessions, tasks, child agents or workflows cannot be deleted",
          );
        store.transaction(() => {
          store.remove("agent", aid);
          for (const e of store.list<any>("edge"))
            if (e.from === aid || e.to === aid) store.remove("edge", e.id);
          for (const r of store.list<any>("rule"))
            if (r.agentId === aid || r.targetId === aid)
              store.remove("rule", r.id);
          store.emit("agent.deleted", aid);
        });
        return send({ status: "deleted" });
      }
      if (method === "GET" && path === "/health")
        return send({
          status: "ok",
          version: "0.1.0",
          liveExecution: runs.enabled,
        });
      if (
        method === "PUT" &&
        (match = path.match(/^\/runtimes\/(codex|claude|wolfram)$/))
      ) {
        const data = z
          .object({ path: z.string().trim().min(1).nullable() })
          .strict()
          .parse(await body(req));
        if (data.path && !isAbsolute(data.path))
          throw new AppError(
            400,
            "invalid_path",
            "Harness overrides must be absolute executable paths",
          );
        discovery.setOverride(match[1], data.path);
        store.put("settings", { id: "harnesses", paths: discovery.overrides });
        await discovery.refresh();
        store.emit("runtimes.discovered", "runtimes");
        return send({
          runtimes: discovery.runtimes,
          overrides: discovery.overrides,
        });
      }
      if (method === "GET" && path === "/runtimes")
        return send({
          runtimes: discovery.runtimes.map((r) => ({
            ...r,
            liveEnabled: runs.enabled,
          })),
          scanning: discovery.scanning,
          settled: discovery.settled,
          overrides: discovery.overrides,
        });
      if (method === "GET" && path === "/runtime-capabilities")
        return send({ capabilities: runtimeCapabilities() });
      if (method === "POST" && path === "/runtimes/refresh") {
        await discovery.refresh();
        return send({ runtimes: discovery.runtimes });
      }
      if (method === "GET" && path === "/skills")
        return send({
          recommended: await recommendations(),
          bundled: service.skills.grouped("bundled"),
          installed: service.skills.grouped("installed"),
        });
      if (method === "POST" && path === "/skills/refresh")
        return send(await service.skills.scan());
      if (testMode && method === "GET" && path === "/test/launches")
        return send({ launches });
      const extra = await extras.route(method, url, () => body(req));
      if (extra) return send(extra.data, extra.status);
      if (method === "GET" && path === "/settings")
        return send(workspaces.settings());
      if (method === "PUT" && path === "/settings")
        return send(workspaces.setEditor(await body(req)));
      if (
        method === "POST" &&
        (match = path.match(
          /^\/agents\/([^/]+)\/files\/(browse|preview|open-plan|open)$/,
        ))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        return send(
          action === "browse"
            ? await workspaces.browse(agentId, data)
            : action === "preview"
              ? await workspaces.preview(agentId, data)
              : await workspaces.openExternal(agentId, data, action === "open"),
        );
      }
      if (
        method === "POST" &&
        (match = path.match(
          /^\/agents\/([^/]+)\/git\/(status|diff|review|mutate)$/,
        ))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        return send(
          action === "status"
            ? await workspaces.gitInfo(agentId, data)
            : action === "review"
              ? await workspaces.review(agentId, data).then((r) => ({
                  ...r,
                  diffHash: createHash("sha256").update(r.diff).digest("hex"),
                }))
              : action === "diff"
                ? await workspaces.diff(agentId, data)
                : await workspaces.mutateGit(agentId, data),
        );
      }
      if (method === "GET" && path === "/agents")
        return send(store.list("agent"));
      if (method === "POST" && path === "/agents")
        return send(await service.saveAgent(await body(req)), 201);
      if ((match = path.match(/^\/agents\/([^/]+)$/))) {
        if (method === "GET") return send(store.get("agent", id(match[1])));
        if (method === "PUT")
          return send(await service.saveAgent(await body(req), id(match[1])));
      }
      if (
        method === "POST" &&
        (match = path.match(/^\/agents\/([^/]+)\/control$/))
      ) {
        const data = z
          .object({ owner: z.enum(["team", "human"]) })
          .strict()
          .parse(await body(req));
        return send(service.control(id(match[1]), data.owner));
      }
      if (
        method === "GET" &&
        (match = path.match(/^\/agents\/([^/]+)\/launch-plan$/))
      )
        return send(await service.launchPlan(id(match[1])));
      if (
        method === "GET" &&
        (match = path.match(/^\/agents\/([^/]+)\/workspace$/))
      ) {
        const agent = store.get<Agent>("agent", id(match[1]));
        return send({
          agentId: agent.id,
          workspaces: agent.workspaces,
          permissionEnforcement:
            "Configuration intent; runtime capabilities are reported by /runtimes. Per-folder sandbox enforcement is not implemented.",
        });
      }
      if (
        method === "POST" &&
        (match = path.match(/^\/agents\/([^/]+)\/session$/))
      )
        return send(service.session(id(match[1])));
      if (
        method === "GET" &&
        (match = path.match(/^\/agents\/([^/]+)\/capacity$/))
      )
        return send(service.capacity(id(match[1])));
      if (
        method === "GET" &&
        (match = path.match(/^\/agents\/([^/]+)\/activity$/))
      )
        return send(service.activity(id(match[1])));
      if (
        (match = path.match(/^\/tasks\/([^/]+)\/validations$/)) &&
        (method === "GET" || method === "POST")
      ) {
        const taskId = id(match[1]);
        const task = store.get<Task>("task", taskId);
        if (method === "GET")
          return send({
            gate: service.validation.gate(task),
            records: service.validation.records(taskId),
            active: service.validation
              .activeRuns()
              .filter((r) => r.taskId === taskId),
          });
        const spec = await body(req);
        // Kernel runs are live execution: honor the same switch as provider runs.
        if (!runs.enabled)
          throw new AppError(
            403,
            "live_disabled",
            "Live execution is disabled; enable it before running a Wolfram validation",
          );
        const started = service.validation.start(taskId, spec);
        if (url.searchParams.get("wait") === "1")
          return send(await started.done, 201);
        started.done.catch(() => undefined);
        return send({ runId: started.runId, state: "queued" }, 202);
      }
      if (method === "GET" && path === "/validations/runs")
        return send(service.validation.activeRuns());
      if (
        method === "POST" &&
        (match = path.match(/^\/validations\/runs\/([^/]+)\/cancel$/))
      )
        return send(service.validation.cancel(id(match[1])));
      if (method === "GET" && (match = path.match(/^\/validations\/([^/]+)$/)))
        return send(service.validation.record(id(match[1])));
      if (method === "PUT" && (match = path.match(/^\/edges\/([^/]+)$/)))
        return send(service.saveEdge(await body(req), id(match[1])));
      if (method === "GET" && path === "/edges")
        return send(store.list("edge"));
      if (method === "POST" && path === "/edges")
        return send(service.saveEdge(await body(req)), 201);
      if (method === "GET" && path === "/rules")
        return send(store.list("rule"));
      if (method === "POST" && path === "/rules")
        return send(service.saveRule(await body(req)), 201);
      if (method === "POST" && path === "/routing/preview")
        return send(service.route(await body(req)));
      if (method === "GET" && path === "/workflows")
        return send(
          store
            .list<Workflow>("workflow")
            .map((w) => service.workflowStatus(w.id)),
        );
      if (method === "POST" && path === "/workflows")
        return send(service.workflow(await body(req)), 201);
      if (method === "GET" && (match = path.match(/^\/workflows\/([^/]+)$/)))
        return send(service.workflowStatus(id(match[1])));
      if (
        method === "POST" &&
        (match = path.match(/^\/workflows\/([^/]+)\/pause$/))
      ) {
        const data = z
          .object({ paused: z.boolean() })
          .strict()
          .parse(await body(req));
        return send(service.pauseWorkflow(id(match[1]), data.paused));
      }
      if (
        method === "POST" &&
        (match = path.match(/^\/tasks\/([^/]+)\/cancel$/))
      )
        return send(runs.cancel("task:" + id(match[1])), 202);
      if ((match = path.match(/^\/workflows\/([^/]+)\/limits$/))) {
        if (method === "GET") return send(service.limits.status(id(match[1])));
        if (method === "PUT")
          return send(service.limits.setLimits(id(match[1]), await body(req)));
      }
      if (
        method === "POST" &&
        (match = path.match(/^\/workflows\/([^/]+)\/limits\/resume$/))
      ) {
        const data = z
          .object({
            limits: z.unknown().optional(),
            requeueStopped: z.boolean().optional(),
          })
          .strict()
          .parse(await body(req));
        return send(service.limits.resume(id(match[1]), data));
      }
      if (
        method === "PUT" &&
        (match = path.match(/^\/tasks\/([^/]+)\/completion-checks$/))
      ) {
        const data = z
          .object({ checks: z.array(completionCheckSchema).max(20) })
          .strict()
          .parse(await body(req));
        return send(service.limits.setChecks(id(match[1]), data.checks));
      }
      if (method === "POST" && path === "/tasks") {
        const input = await body(req);
        // Optional per-project setting: isolate coding work in a fresh worktree first.
        const auto =
          typeof (input as any)?.agentId === "string"
            ? await development.worktrees.autoForTask((input as any).agentId)
            : null;
        const task = service.task(input);
        return send(auto ? { ...task, autoWorktree: auto } : task, 201);
      }
      if (method === "GET" && (match = path.match(/^\/tasks\/([^/]+)$/)))
        return send(service.taskState(id(match[1])));
      if (
        method === "POST" &&
        (match = path.match(/^\/tasks\/([^/]+)\/status$/))
      ) {
        if (runs.active.has("task:" + id(match[1])))
          throw new AppError(
            409,
            "task_running",
            "Stop the running task before manually changing its status",
          );
        const raw = (await body(req)) as {
          status?: string;
          result?: string;
          humanOverride?: unknown;
        };
        const { humanOverride: rawOverride, ...change } = raw ?? {};
        // Explicit, attributed override for completing a required-review task by hand (see
        // CLAUDE.md, orchestration); without it a hand-completed review never opens a gate.
        const override =
          rawOverride === undefined
            ? undefined
            : z
                .object({
                  reason: z.string().trim().min(10).max(2000),
                  by: z.string().trim().min(1).max(200).optional(),
                })
                .strict()
                .parse(rawOverride);
        const taskId = id(match[1]);
        if (change?.status !== "completed") {
          if (override)
            throw new AppError(
              400,
              "override_not_applicable",
              "humanOverride is only accepted when completing a review task",
            );
          return send(service.transitionTask(taskId, change));
        }
        // Manual completion runs the same gates as the scheduler: declared completion checks for
        // exactly this result text (evaluated against the agent's active folder, else the app cwd),
        // then the task's structured output (required shared-state writes), committed atomically
        // with the transition.
        const task = store.get<Task>("task", taskId);
        const result = typeof change.result === "string" ? change.result : "";
        if (typeof change.result === "string") {
          const agent = store.get<Agent>("agent", task.agentId);
          await service.limits.evaluate(
            task,
            change.result,
            agent.workspaces.find((w) => w.active)?.path ?? runs.cwd,
          );
        }
        const output = await service.shared.prepare(task, result);
        return send(
          store.transaction(() => {
            service.orchestration.recordManualCompletion(taskId, override);
            service.shared.commit(task, output);
            return service.transitionTask(taskId, change);
          }),
        );
      }
      if (method === "GET" && path === "/sessions")
        return send(store.list("session"));
      if ((match = path.match(/^\/sessions\/([^/]+)\/messages$/))) {
        const sid = id(match[1]);
        store.get<Session>("session", sid);
        if (method === "GET")
          return send(
            store.list<Message>("message").filter((m) => m.sessionId === sid),
          );
        if (method === "POST")
          return send(service.message(sid, await body(req)), 201);
      }
      if (
        method === "POST" &&
        (match = path.match(/^\/sessions\/([^/]+)\/run$/))
      )
        return send(await runs.start(id(match[1])), 202);
      if (
        method === "POST" &&
        (match = path.match(/^\/sessions\/([^/]+)\/cancel$/))
      )
        return send(runs.cancel(id(match[1])), 202);
      if (method === "GET" && path === "/events") {
        const after = z.coerce
          .number()
          .int()
          .min(0)
          .parse(url.searchParams.get("after") ?? "0");
        return send(store.history(after));
      }
      if (method === "GET" && path === "/events/stream") {
        let after = z.coerce
          .number()
          .int()
          .min(0)
          .parse(
            req.headers["last-event-id"] ??
              url.searchParams.get("after") ??
              "0",
          );
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          Connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const write = (event: any) => {
          if (event.seq <= after) return;
          after = event.seq;
          if (res.writableLength > 1_000_000) {
            res.destroy();
            return;
          }
          res.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        };
        // Synchronous replay + listener registration avoids a delivery gap.
        let page;
        do {
          page = store.history(after);
          for (const event of page) write(event);
        } while (page.length === 500 && !res.destroyed);
        store.events.on("event", write);
        const heartbeat = setInterval(
          () => res.write(": heartbeat\n\n"),
          15_000,
        );
        res.on("close", () => {
          clearInterval(heartbeat);
          store.events.off("event", write);
        });
        return;
      }
      if (method === "GET" && path === "/samples") return send(sampleCatalog());
      if (method === "POST" && path === "/samples/wolfram-validated-reasoning")
        return send(createWolframSample(service, await body(req)), 201);
      if (
        method === "POST" &&
        (match = path.match(/^\/samples\/workflows\/([^/]+)\/verify-models$/))
      )
        return send(
          verifySampleModels(service, id(match[1]), discovery.runtimes),
        );
      if (path === "/teams" || path.startsWith("/teams/")) {
        const t = path.split("/").slice(2).map(id);
        if (method === "GET" && !t.length) return send(teams.list());
        if (method === "POST" && !t.length)
          return send(teams.create(await body(req)), 201);
        if (method === "POST" && t[0] === "import")
          return send(teams.import(await body(req)), 201);
        if (method === "POST" && t[0] === "insert" && !t[1])
          return send(await teams.insert(await body(req)), 201);
        if (method === "POST" && t[0] === "preview" && !t[1])
          return send(await teams.preview(await body(req)));
        if (t.length === 1) {
          if (method === "GET") return send(teams.get(t[0]));
          if (method === "PUT")
            return send(teams.update(t[0], await body(req)));
          if (method === "DELETE") {
            teams.delete(t[0]);
            return send({ status: "deleted" });
          }
        }
        if (t.length === 2 && method === "GET" && t[1] === "export")
          return send(teams.export(t[0]));
        if (t.length === 2 && method === "POST" && t[1] === "duplicate")
          return send(teams.duplicate(t[0]), 201);
      }
      throw new AppError(404, "not_found", "Unknown API endpoint");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof z.ZodError)
        return send({ error: "validation_error", issues: error.issues }, 400);
      if (error instanceof AppError)
        return send(
          { error: error.code, message: error.message },
          error.status,
        );
      if (error instanceof URIError)
        return send({ error: "invalid_path" }, 400);
      console.error(error);
      send(
        { error: "internal_error", message: "Unexpected backend error" },
        500,
      );
    }
  });
  server.on("close", () => {
    void development.close();
    void devservers.close();
    extras.close();
  });
  return Object.assign(server, { launches });
}
