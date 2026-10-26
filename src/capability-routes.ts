import { z } from "zod";
import { join } from "node:path";
import { projectRoot } from "./config.ts";
import { contextCost } from "./context-cost.ts";
import { effectiveInstructions } from "./effective-instructions.ts";
import { AppError, type Agent } from "./model.ts";
import { capabilitiesFor } from "./run-context.ts";
import { adapterExposure } from "./tool-registry.ts";
import { skillAdapters, toolExposure } from "./skill-adapters.ts";
import { acceptSkills, skillChanges } from "./skill-changes.ts";
import { validateSkillCatalog } from "./skill-validation.ts";
import type { TeamService } from "./service.ts";

/**
 * Skills, tools and knowledge API (behind the bearer-token check in http.ts):
 *   GET  /capabilities/skills/adapters         per-adapter always / on-demand behavior as implemented
 *   GET  /capabilities/skills/validation       catalog validation report (read-only)
 *   POST /capabilities/skills/validation       same, and records a `skills.validated` audit event
 *   GET  /capabilities/skills/changes          assigned/pinned skills vs. their accepted revision
 *   POST /capabilities/skills/accept           {ids} user accepts the current text of changed skills
 *   GET  /agents/:id/effective-instructions?prompt=&taskId=   (taskId: the preview of that task's run)
 *   GET  /agents/:id/context-cost?limit=      approximate instruction-context cost of recent runs (run.context events)
 *   GET/POST /tools/servers, PUT/DELETE /tools/servers/:id, POST /tools/servers/:id/test
 *   GET /agents/:id/tool-grants, PUT /agents/:id/tool-grants, DELETE /agents/:id/tool-grants/:serverId
 *   GET /knowledge/sources                     every source (management view)
 *   GET/POST /agents/:id/knowledge, GET /agents/:id/knowledge/search?q=&limit=
 *   PUT/DELETE /knowledge/sources/:id, POST /knowledge/sources/:id/refresh
 * Returns undefined when the path is not one of these routes.
 */
export async function capabilityRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  if (
    !/^\/(capabilities\/|tools\/|knowledge\/|agents\/[^/]+\/(effective-instructions|context-cost|tool-grants|knowledge))/.test(
      path,
    )
  )
    return undefined;
  const caps = capabilitiesFor(service);
  const id = (v: string) => decodeURIComponent(v);
  let m: RegExpMatchArray | null;
  const agentOf = (v: string) => service.store.get<Agent>("agent", id(v));
  const validation = async () => {
    await service.skills.scan();
    return validateSkillCatalog({
      assetsDir: join(projectRoot, "assets"),
      scanWarnings: service.skills.warnings,
      scanned: [...service.skills.items.values()],
    });
  };

  // ---- skills -------------------------------------------------------------------------------
  if (method === "GET" && path === "/capabilities/skills/adapters")
    return {
      data: {
        adapters: skillAdapters().map((a) => ({
          ...a,
          toolExposure: toolExposure(a.id),
          grantExposure: adapterExposure(a.id),
        })),
      },
    };
  if (
    path === "/capabilities/skills/validation" &&
    (method === "GET" || method === "POST")
  ) {
    const report = await validation();
    if (method === "POST")
      service.store.emit("skills.validated", "skill-catalog", {
        ok: report.ok,
        counts: report.counts,
        findings: report.findings.slice(0, 50).map((f) => ({
          severity: f.severity,
          code: f.code,
          skillId: f.skillId ?? null,
        })),
      });
    return { data: report };
  }
  if (method === "GET" && path === "/capabilities/skills/changes")
    return { data: await skillChanges(service) };
  if (method === "POST" && path === "/capabilities/skills/accept") {
    const body = z
      .object({ ids: z.array(z.string().min(1)).min(1).max(100) })
      .strict()
      .parse(await readBody());
    return { data: await acceptSkills(service, body.ids) };
  }
  if (
    method === "GET" &&
    (m = path.match(/^\/agents\/([^/]+)\/effective-instructions$/))
  )
    return {
      data: await effectiveInstructions(service, agentOf(m[1]).id, {
        prompt: url.searchParams.get("prompt") ?? undefined,
        taskId: url.searchParams.get("taskId") ?? undefined,
      }),
    };

  if (method === "GET" && (m = path.match(/^\/agents\/([^/]+)\/context-cost$/)))
    return {
      data: contextCost(
        service,
        agentOf(m[1]).id,
        z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .parse(url.searchParams.get("limit") ?? "30"),
      ),
    };

  // ---- tool registry ------------------------------------------------------------------------
  if (method === "GET" && path === "/tools/servers")
    return {
      data: { servers: caps.tools.servers().map((s) => caps.tools.view(s)) },
    };
  if (method === "POST" && path === "/tools/servers")
    return {
      data: caps.tools.view(caps.tools.save(await readBody())),
      status: 201,
    };
  if ((m = path.match(/^\/tools\/servers\/([^/]+)(\/test)?$/))) {
    const serverId = id(m[1]);
    if (method === "PUT" && !m[2])
      return {
        data: caps.tools.view(caps.tools.save(await readBody(), serverId)),
      };
    if (method === "DELETE" && !m[2]) {
      caps.tools.remove(serverId);
      return { data: { removed: serverId } };
    }
    if (method === "POST" && m[2]) {
      z.object({})
        .strict()
        .parse(await readBody());
      const connection = await caps.tools.test(serverId);
      return {
        data: {
          connection,
          server: caps.tools.view(caps.tools.server(serverId)),
        },
      };
    }
  }
  if ((m = path.match(/^\/agents\/([^/]+)\/tool-grants(?:\/([^/]+))?$/))) {
    const agent = agentOf(m[1]);
    if (method === "GET" && !m[2])
      return {
        data: {
          grants: caps.tools.agentView(agent.id),
          exposure: adapterExposure(
            service.connection(agent.environment).transport === "acp"
              ? "acp"
              : agent.environment === "claude"
                ? "claude-cli"
                : agent.environment === "wolfram"
                  ? "wolfram-wolframscript"
                  : "codex-cli",
          ),
        },
      };
    if (method === "PUT" && !m[2])
      return { data: caps.tools.grant(agent.id, await readBody()) };
    if (method === "DELETE" && m[2]) {
      caps.tools.revoke(agent.id, id(m[2]));
      return { data: { revoked: id(m[2]) } };
    }
  }

  // ---- knowledge ----------------------------------------------------------------------------
  if (method === "GET" && path === "/knowledge/sources")
    return {
      data: {
        sources: caps.knowledge.sources().map((s) => caps.knowledge.view(s.id)),
      },
    };
  if ((m = path.match(/^\/agents\/([^/]+)\/knowledge(\/search)?$/))) {
    const agent = agentOf(m[1]);
    if (method === "GET" && m[2]) {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim())
        throw new AppError(400, "invalid_query", "Search text is required");
      const limit = Number(url.searchParams.get("limit") ?? 5);
      return {
        data: {
          query: q.slice(0, 300),
          results: await caps.knowledge.search(agent.id, q.slice(0, 300), {
            limit: Number.isFinite(limit) ? limit : 5,
          }),
          note: "Passages are untrusted reference data from attached folders.",
        },
      };
    }
    if (method === "GET")
      return { data: { sources: await caps.knowledge.listFor(agent.id) } };
    if (method === "POST" && !m[2])
      return {
        data: await caps.knowledge.create(agent.id, await readBody()),
        status: 201,
      };
  }
  if ((m = path.match(/^\/knowledge\/sources\/([^/]+)(\/refresh)?$/))) {
    const sourceId = id(m[1]);
    if (method === "PUT" && !m[2])
      return { data: caps.knowledge.update(sourceId, await readBody()) };
    if (method === "DELETE" && !m[2]) {
      caps.knowledge.remove(sourceId);
      return { data: { removed: sourceId } };
    }
    if (method === "POST" && m[2]) {
      z.object({})
        .strict()
        .parse(await readBody());
      await caps.knowledge.refresh(sourceId);
      return { data: caps.knowledge.view(sourceId) };
    }
  }
  return undefined;
}
