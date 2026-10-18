import { z } from "zod";
import { join } from "node:path";
import { dataDir } from "./config.ts";
import { exportBundle } from "./diagnostics.ts";
import {
  buildTimeline,
  explainWaiting,
  previewAccess,
  previewRun,
  timelineFilterSchema,
  transfers,
  type InspectorContext,
} from "./inspector.ts";
import { Playground } from "./playground.ts";
import { Redactor } from "./redact.ts";
import { AppError, type Task } from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Run inspector API (behind the bearer-token check in http.ts):
 *   GET  /inspector/timeline?agentId&workflowId&taskId&severity&minSeverity&type&q&file&after&limit
 *   GET  /inspector/tasks/:id/waiting      structured "why is this waiting?" reasons
 *   GET  /inspector/agents/:id/waiting     same reason list for an agent (all its pending work)
 *   GET  /inspector/waiting                headline per queued/interrupted/blocked task
 *   GET  /inspector/transfers?edgeId&taskId&workflowId   request/response/duration/rule per transfer
 *   POST /inspector/preview                {route, access?} routing + access decisions
 *   POST /inspector/access-preview         access decisions only
 *   GET/POST /inspector/examples, GET/PUT/DELETE /inspector/examples/:id
 *   POST /inspector/examples/:id/run, POST /inspector/playground/run   fixture-only isolated run
 *   GET  /inspector/runs, GET/DELETE /inspector/runs/:id, POST /inspector/compare {a,b}
 *   POST /inspector/bundle                 {format: json|zip, timeline?} redacted diagnostic export
 * Returns undefined when the path is not an inspector route.
 */
export type InspectorOptions = {
  token: string;
  context: InspectorContext;
  /** Files whose contents count as secrets (defaults to the data dir's api-token). */
  secretFiles?: string[];
  runtimes?: () => unknown;
};
export function createInspector(
  service: TeamService,
  options: InspectorOptions,
) {
  const redaction = () => ({
    literals: [options.token],
    secretFiles: options.secretFiles ?? [join(dataDir, "api-token")],
  });
  const redactor = () => new Redactor(redaction());
  const playground = new Playground(service, redactor);
  const id = (v: string) => decodeURIComponent(v);
  const route = async (
    method: string | undefined,
    url: URL,
    readBody: () => Promise<unknown>,
  ): Promise<{ data: unknown; status?: number } | undefined> => {
    const path = url.pathname;
    if (!path.startsWith("/inspector/")) return undefined;
    const ctx = options.context;
    const query = Object.fromEntries(url.searchParams);
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/inspector/timeline") {
      const filter = timelineFilterSchema.parse(query);
      return { data: buildTimeline(service, filter, redactor()) };
    }
    if (
      method === "GET" &&
      (m = path.match(/^\/inspector\/(tasks|agents)\/([^/]+)\/waiting$/))
    ) {
      const subject = id(m[2]);
      service.store.get(m[1] === "tasks" ? "task" : "agent", subject);
      return {
        data: explainWaiting(
          service,
          ctx,
          m[1] === "tasks" ? { taskId: subject } : { agentId: subject },
        ),
      };
    }
    if (method === "GET" && path === "/inspector/waiting")
      return {
        data: service.store
          .list<Task>("task")
          .filter((t) =>
            ["queued", "interrupted", "blocked"].includes(t.status),
          )
          .map((t) => {
            const e = explainWaiting(service, ctx, { taskId: t.id });
            return {
              taskId: t.id,
              title: t.title,
              status: t.status,
              headline: e.headline,
              waiting: e.waiting,
              codes: e.reasons.filter((r) => r.blocking).map((r) => r.code),
            };
          }),
      };
    if (method === "GET" && path === "/inspector/transfers")
      return {
        data: transfers(
          service,
          {
            edgeId: query.edgeId,
            taskId: query.taskId,
            workflowId: query.workflowId,
          },
          redactor(),
        ),
      };
    if (method === "POST" && path === "/inspector/preview")
      return { data: await previewRun(service, ctx, await readBody()) };
    if (method === "POST" && path === "/inspector/access-preview")
      return { data: await previewAccess(service, ctx, await readBody()) };
    if (path === "/inspector/examples") {
      if (method === "GET") return { data: playground.examples() };
      if (method === "POST")
        return { data: playground.saveExample(await readBody()), status: 201 };
    }
    if ((m = path.match(/^\/inspector\/examples\/([^/]+)$/))) {
      if (method === "GET") return { data: playground.example(id(m[1])) };
      if (method === "PUT")
        return { data: playground.saveExample(await readBody(), id(m[1])) };
      if (method === "DELETE") {
        playground.deleteExample(id(m[1]));
        return { data: { status: "deleted" } };
      }
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/inspector\/examples\/([^/]+)\/run$/))
    ) {
      const extra = z
        .object({
          label: z.string().optional(),
          overrides: z.unknown().optional(),
          maxSeconds: z.number().optional(),
        })
        .strict()
        .parse(await readBody());
      return {
        data: await playground.execute({ ...extra, exampleId: id(m[1]) }),
        status: 201,
      };
    }
    if (method === "POST" && path === "/inspector/playground/run")
      return { data: await playground.execute(await readBody()), status: 201 };
    if (method === "GET" && path === "/inspector/runs")
      return { data: playground.runs() };
    if ((m = path.match(/^\/inspector\/runs\/([^/]+)$/))) {
      if (method === "GET") return { data: playground.run(id(m[1])) };
      if (method === "DELETE") {
        playground.deleteRun(id(m[1]));
        return { data: { status: "deleted" } };
      }
    }
    if (method === "POST" && path === "/inspector/compare") {
      const body = z
        .object({ a: z.string(), b: z.string() })
        .strict()
        .parse(await readBody());
      return { data: playground.compare(body.a, body.b) };
    }
    if (method === "POST" && path === "/inspector/bundle") {
      const body = z
        .object({
          format: z.enum(["json", "zip"]).default("zip"),
          timeline: timelineFilterSchema.partial().optional(),
        })
        .strict()
        .parse(await readBody());
      return {
        data: exportBundle(service, ctx, {
          format: body.format,
          timeline: body.timeline,
          redaction: redaction(),
          runtimes: options.runtimes,
        }),
      };
    }
    throw new AppError(404, "not_found", "Unknown inspector endpoint");
  };
  return { route, playground };
}
