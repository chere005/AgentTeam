import { z } from "zod";
import { AppError, type Task } from "./model.ts";
import { DEFAULT_PREVIEW_BYTES } from "./artifacts.ts";
import { keySchema } from "./shared-state.ts";
import type { TeamService } from "./service.ts";

/**
 * Shared state and artifact API (behind the bearer-token check in http.ts). The HTTP caller is the
 * user; naming `agentId` evaluates the request as that agent so per-field/artifact permissions apply
 * exactly as they do for agents (the same service methods back the scheduler's structured output path).
 *   GET  /workflows/:id/state[?agentId=]                       readable fields with current values
 *   PUT  /workflows/:id/state/fields/:key                      define/update a field (kind, schema, readers, writers)
 *   GET  /workflows/:id/state/fields/:key[?agentId=]           one field
 *   GET  /workflows/:id/state/fields/:key/history[?limit=&agentId=]   immutable change history
 *   POST /workflows/:id/state/fields/:key/value                {value, expectedVersion, agentId?, taskId?, note?}; 409 on stale writes
 *   GET  /workflows/:id/state/restore-preview?checkpointId=    what restoring a checkpoint would change
 *   POST /workflows/:id/state/restore                          {checkpointId, expectedVersions?}
 *   GET|PUT /tasks/:id/state-config                            memory mode, selected inputs, context budget, required writes
 *   GET  /tasks/:id/context-preview                            the shared context the task's prompt would receive
 *   GET|POST /workflows/:id/artifacts[?taskId=&kind=&agentId=] list / register an artifact
 *   GET  /artifacts/:id[?agentId=]                             metadata + provenance
 *   GET  /artifacts/:id/preview[?maxBytes=&agentId=]           bounded text preview
 * Returns undefined when the path is not one of these routes.
 */
export async function sharedRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  const shared = service.shared;
  const dec = (v: string) => decodeURIComponent(v);
  const actor = () => shared.actor(url.searchParams.get("agentId"));
  let m: RegExpMatchArray | null;
  if (
    (m = path.match(
      /^\/workflows\/([^/]+)\/state\/fields\/([^/]+)(\/history|\/value)?$/,
    ))
  ) {
    const wf = dec(m[1]),
      key = dec(m[2]);
    keySchema.parse(key);
    if (!m[3] && method === "GET")
      return { data: shared.read(wf, key, actor()) };
    if (!m[3] && method === "PUT")
      return { data: shared.defineField(wf, key, await readBody()) };
    if (m[3] === "/history" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return {
        data: shared.history(
          wf,
          key,
          actor(),
          Number.isFinite(limit) ? limit : 100,
        ),
      };
    }
    if (m[3] === "/value" && method === "POST") {
      const body = z
        .object({
          value: z.unknown(),
          expectedVersion: z.number().int().min(0),
          agentId: z.string().optional(),
          taskId: z.string().optional(),
          note: z.string().max(500).optional(),
        })
        .strict()
        .parse(await readBody());
      if (body.value === undefined)
        throw new AppError(400, "invalid_request", "`value` is required");
      const change = shared.write({
        workflowId: wf,
        key,
        value: body.value,
        expectedVersion: body.expectedVersion,
        actor: shared.actor(body.agentId),
        taskId: body.taskId,
        note: body.note,
      });
      return { data: change, status: 201 };
    }
    return undefined;
  }
  if (method === "GET" && (m = path.match(/^\/workflows\/([^/]+)\/state$/)))
    return { data: shared.view(dec(m[1]), actor()) };
  if (
    method === "GET" &&
    (m = path.match(/^\/workflows\/([^/]+)\/state\/restore-preview$/))
  ) {
    const checkpointId = url.searchParams.get("checkpointId");
    if (!checkpointId)
      throw new AppError(400, "invalid_request", "checkpointId is required");
    return { data: shared.planRestore(dec(m[1]), checkpointId) };
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/workflows\/([^/]+)\/state\/restore$/))
  )
    return { data: shared.restore(dec(m[1]), await readBody()) };
  if ((m = path.match(/^\/tasks\/([^/]+)\/state-config$/))) {
    const taskId = dec(m[1]);
    if (method === "GET") {
      service.store.get<Task>("task", taskId);
      return { data: shared.config(taskId) };
    }
    if (method === "PUT")
      return { data: shared.setConfig(taskId, await readBody()) };
    return undefined;
  }
  if (
    method === "GET" &&
    (m = path.match(/^\/tasks\/([^/]+)\/context-preview$/))
  )
    return { data: shared.previewContext(dec(m[1])) };
  if ((m = path.match(/^\/workflows\/([^/]+)\/artifacts$/))) {
    const wf = dec(m[1]);
    if (method === "GET")
      return {
        data: service.artifacts.list(wf, actor(), {
          taskId: url.searchParams.get("taskId") ?? undefined,
          kind: url.searchParams.get("kind") ?? undefined,
        }),
      };
    if (method === "POST")
      return {
        data: service.artifacts.view(
          await service.artifacts.register(wf, await readBody()),
        ),
        status: 201,
      };
    return undefined;
  }
  if (method === "GET" && (m = path.match(/^\/artifacts\/([^/]+)$/)))
    return {
      data: service.artifacts.view(service.artifacts.get(dec(m[1]), actor())),
    };
  if (method === "GET" && (m = path.match(/^\/artifacts\/([^/]+)\/preview$/))) {
    const max = Number(
      url.searchParams.get("maxBytes") ?? DEFAULT_PREVIEW_BYTES,
    );
    return {
      data: await service.artifacts.preview(
        dec(m[1]),
        actor(),
        Number.isFinite(max) ? max : DEFAULT_PREVIEW_BYTES,
      ),
    };
  }
  return undefined;
}
