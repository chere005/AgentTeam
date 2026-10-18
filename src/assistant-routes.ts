import { z } from "zod";
import { AssistantProposals, type ProposalOptions } from "./assistant.ts";
import { assistantContext } from "./assistant-context.ts";
import { Conversations } from "./conversations.ts";
import { Coordination } from "./coordination.ts";
import type { InspectorContext } from "./inspector.ts";
import { AppError } from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Assistant / coordination / conversation-workspace API (behind the bearer-token check in http.ts).
 * Every caller of these routes is the authenticated local user: approve, apply and reject always
 * run as `{type: "user"}`; assistant output only ever reaches `extract`, which stores data.
 *
 *   GET  /assistant/context                    bounded read-only team inspection (untrusted-data block)
 *   GET  /assistant/proposals                  GET /assistant/proposals/:id (diff, staleness, canApply)
 *   POST /assistant/proposals                  {title, rationale?, ops[]} as the user
 *   POST /assistant/proposals/extract          {messageId} reads ```agentteam-proposal blocks (data only)
 *   POST /assistant/proposals/:id/approve|apply|reject
 *   GET  /assistant/audit?proposalId           who proposed / approved / applied what
 *   GET  /coordination, GET|PUT /coordination/:workflowId, POST /coordination/:workflowId/pause|resume
 *   GET  /ownership, GET /ownership/:agentId, POST /ownership/:agentId/take|return
 *   GET  /conversations/summary, POST /conversations/search, GET /conversations/link?taskId|eventSeq|commentId
 * Returns undefined when the path is not one of these.
 */
export function createAssistantRoutes(
  service: TeamService,
  options: { context: InspectorContext; proposals?: ProposalOptions },
) {
  const proposals = new AssistantProposals(service, options.proposals);
  const coordination = new Coordination(service);
  const conversations = new Conversations(service);
  const id = (v: string) => decodeURIComponent(v);
  const USER = { type: "user" } as const;
  const route = async (
    method: string | undefined,
    url: URL,
    readBody: () => Promise<unknown>,
  ): Promise<{ data: unknown; status?: number } | undefined> => {
    const path = url.pathname;
    if (!/^\/(assistant|coordination|ownership|conversations)(\/|$)/.test(path))
      return undefined;
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/assistant/context")
      return { data: assistantContext(service, options.context) };
    if (path === "/assistant/proposals") {
      if (method === "GET") return { data: proposals.list() };
      if (method === "POST")
        return {
          data: await proposals.create(await readBody(), USER),
          status: 201,
        };
    }
    if (method === "POST" && path === "/assistant/proposals/extract") {
      const body = z
        .object({ messageId: z.string().min(1) })
        .strict()
        .parse(await readBody());
      return { data: await proposals.extract(body.messageId), status: 201 };
    }
    if (
      (m = path.match(/^\/assistant\/proposals\/([^/]+)$/)) &&
      method === "GET"
    )
      return { data: proposals.detail(id(m[1])) };
    if (
      method === "POST" &&
      (m = path.match(
        /^\/assistant\/proposals\/([^/]+)\/(approve|apply|reject)$/,
      ))
    ) {
      const body = z
        .object({
          note: z.string().max(500).optional(),
          // Applying is an explicit act; a missing flag is a client bug, not consent.
          confirm: z.literal(true).optional(),
        })
        .strict()
        .parse(await readBody());
      const pid = id(m[1]);
      if (m[2] === "approve")
        return { data: proposals.approve(pid, USER, body.note) };
      if (m[2] === "reject")
        return { data: proposals.reject(pid, USER, body.note) };
      if (body.confirm !== true)
        throw new AppError(
          400,
          "confirmation_required",
          "Applying a proposal needs confirm: true",
        );
      return { data: await proposals.apply(pid, USER) };
    }
    if (method === "GET" && path === "/assistant/audit")
      return {
        data: proposals.auditLog(
          url.searchParams.get("proposalId") ?? undefined,
        ),
      };

    if (method === "GET" && path === "/coordination")
      return { data: coordination.list() };
    if ((m = path.match(/^\/coordination\/([^/]+)$/))) {
      if (method === "GET") return { data: coordination.view(id(m[1])) };
      if (method === "PUT")
        return { data: coordination.set(id(m[1]), await readBody()) };
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/coordination\/([^/]+)\/(pause|resume)$/))
    )
      return {
        data:
          m[2] === "pause"
            ? coordination.pause(id(m[1]))
            : coordination.resume(id(m[1])),
      };

    if (method === "GET" && path === "/ownership")
      return { data: service.ownership.list() };
    if ((m = path.match(/^\/ownership\/([^/]+)$/)) && method === "GET")
      return { data: service.ownership.view(id(m[1])) };
    if (
      method === "POST" &&
      (m = path.match(/^\/ownership\/([^/]+)\/(take|return)$/))
    )
      return {
        data:
          m[2] === "take"
            ? (service.ownership.take(id(m[1]), await readBody()),
              service.ownership.view(id(m[1])))
            : service.ownership.release(id(m[1])),
      };

    if (method === "GET" && path === "/conversations/summary")
      return { data: conversations.summary() };
    if (method === "POST" && path === "/conversations/search")
      return { data: conversations.search(await readBody()) };
    if (method === "GET" && path === "/conversations/link")
      return {
        data: conversations.link({
          taskId: url.searchParams.get("taskId") ?? undefined,
          eventSeq: url.searchParams.get("eventSeq") ?? undefined,
          commentId: url.searchParams.get("commentId") ?? undefined,
        }),
      };
    throw new AppError(404, "not_found", "Unknown endpoint");
  };
  return { route, proposals, coordination, conversations };
}
