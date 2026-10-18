import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { RunManager } from "./runtime.ts";
import { WorkspaceService } from "./workspaces.ts";
import { recommendations } from "./config.ts";
import {
  AppError,
  type Agent,
  type Session,
  type Message,
  type Workflow,
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
export function createApi(
  service: TeamService,
  token: string,
  runs: RunManager,
) {
  const store = service.store;
  const workspaces = new WorkspaceService(store);
  return createServer(async (req, res) => {
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
      if (method === "GET" && path === "/runtimes")
        return send({
          runtimes: [
            {
              id: "codex",
              adapter: "cli",
              execution: "read-only",
              liveEnabled: runs.enabled,
            },
            {
              id: "claude",
              adapter: "cli",
              execution: "chat-only",
              liveEnabled: runs.enabled,
            },
            {
              id: "wolfram",
              adapter: "wolframscript",
              execution:
                "LLMSynthesize · requires configured Wolfram LLM access",
              liveEnabled: runs.enabled,
            },
          ],
          modelCatalog:
            "Provider model discovery pending; configured model and effort pass through without substituting another model",
        });
      if (method === "GET" && path === "/skills")
        return send({
          recommended: await recommendations(),
          bundled: service.skills.grouped("bundled"),
          installed: service.skills.grouped("installed"),
        });
      if (method === "POST" && path === "/skills/refresh")
        return send(await service.skills.scan());
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
        (match = path.match(/^\/agents\/([^/]+)\/git\/(status|diff|mutate)$/))
      ) {
        const agentId = id(match[1]),
          action = match[2],
          data = await body(req);
        return send(
          action === "status"
            ? await workspaces.gitInfo(agentId, data)
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
      if (method === "POST" && path === "/tasks")
        return send(service.task(await body(req)), 201);
      if (method === "GET" && (match = path.match(/^\/tasks\/([^/]+)$/)))
        return send(service.taskState(id(match[1])));
      if (
        method === "POST" &&
        (match = path.match(/^\/tasks\/([^/]+)\/status$/))
      )
        return send(service.transitionTask(id(match[1]), await body(req)));
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
}
