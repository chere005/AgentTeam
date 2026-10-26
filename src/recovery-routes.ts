import { z } from "zod";
import type { TeamService } from "./service.ts";

/**
 * Recovery API (all routes sit behind the bearer-token check in http.ts):
 *   GET  /recovery                     resumable/blocked/failed tasks, pending approvals, uncertain effects
 *   GET  /tasks/:id/recovery           one task: checkpoint, what runs next, retry gate
 *   GET  /tasks/:id/checkpoints        immutable checkpoint history
 *   PUT  /tasks/:id/retry-policy       max attempts, backoff, automatic retry
 *   POST /tasks/:id/resume             interrupted/blocked/failed -> queued from its checkpoint (response: view + `executed` decision)
 *   POST /tasks/:id/retry-from-checkpoint   same action, named for failed tasks
 *   (every view carries `decision`: the typed recovery decision the preview and the action share)
 *   GET  /effects[?taskId=]            effect ledger
 *   POST /effects/:id/decision         user decision on an uncertain effect
 *   GET  /approvals/history            persisted approval requests and answers
 * Returns undefined when the path is not a recovery route.
 */
export async function recoveryRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  const recovery = service.recovery;
  const id = (v: string) => decodeURIComponent(v);
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/recovery")
    return { data: recovery.overview() };
  if (method === "GET" && path === "/approvals/history")
    return { data: service.approvals.history() };
  if (method === "GET" && path === "/effects") {
    const taskId = url.searchParams.get("taskId");
    return { data: recovery.ledger.list(taskId ?? undefined) };
  }
  if (method === "POST" && (m = path.match(/^\/effects\/([^/]+)\/decision$/)))
    return { data: recovery.ledger.decide(id(m[1]), await readBody()) };
  if (
    !(m = path.match(
      /^\/tasks\/([^/]+)\/(recovery|checkpoints|retry-policy|resume|retry-from-checkpoint)$/,
    ))
  )
    return undefined;
  const taskId = id(m[1]),
    action = m[2];
  if (method === "GET" && action === "recovery")
    return { data: recovery.view(taskId) };
  if (method === "GET" && action === "checkpoints") {
    service.store.get("task", taskId);
    return { data: recovery.checkpoints(taskId) };
  }
  if (method === "PUT" && action === "retry-policy")
    return { data: recovery.setPolicy(taskId, await readBody()) };
  if (
    method === "POST" &&
    (action === "resume" || action === "retry-from-checkpoint")
  ) {
    z.object({})
      .strict()
      .parse(await readBody());
    // The response carries the decision that was executed (the one the preview showed), then
    // the task's view as it is now.
    const { decision } = recovery.requeueWithDecision(taskId);
    return {
      data: { ...recovery.view(taskId), executed: decision },
      status: 202,
    };
  }
  return undefined;
}
