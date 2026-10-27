import { z } from "zod";
import { assert } from "./model.ts";
import type { TeamService } from "./service.ts";

/** Application-only routes: provider MCP tokens cannot register trusted references or Start work. */
export async function executionProjectRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  body: () => Promise<unknown>,
  enabled: () => boolean,
) {
  const path = url.pathname;
  if (method === "GET" && path === "/execution-projects")
    return {
      data: service.executionProjects
        .list()
        .map((r) => service.executionProjects.view(r.id)),
    };
  let match = path.match(
    /^\/projects\/([^/]+)\/execution(?:\/(configure|start|cancel|retry))?$/,
  );
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (method === "GET" && !match[2])
      return { data: service.executionProjects.view(id) };
    if (method === "POST" && match[2] === "configure")
      return { data: service.executionProjects.configure(id, await body()) };
    if (method === "POST" && match[2] === "cancel")
      return { data: service.executionProjects.cancel(id) };
    if (method === "POST" && match[2] === "retry") {
      assert(
        enabled(),
        "execution_paused",
        "Resume execution before starting another correction attempt",
      );
      return { data: service.executionProjects.retry(id) };
    }
    if (method === "POST" && match[2] === "start") {
      assert(
        enabled(),
        "execution_paused",
        "Resume execution before starting the prepared assignment",
      );
      return { data: await service.executionProjects.startPrepared(id) };
    }
  }
  if (method === "POST" && path === "/verification/references")
    return {
      data: service.verification.registerReference(await body()),
      status: 201,
    };
  if (method === "GET" && path === "/verification/references")
    return { data: service.verification.references() };
  if ((match = path.match(/^\/tasks\/([^/]+)\/verification$/))) {
    const id = decodeURIComponent(match[1]);
    if (method === "GET") return { data: service.verification.list(id) };
    if (method === "POST") {
      assert(enabled(), "execution_paused", "Execution is paused");
      return { data: await service.verification.verify(id, await body()) };
    }
  }
  if (method === "POST" && path === "/verification/pi-reference") {
    const data = z
      .object({
        digits: z.number().int().min(1).max(1000),
        mode: z.enum(["significant", "decimal"]).default("significant"),
      })
      .strict()
      .parse(await body());
    return {
      data: service.verification.ensurePiReference(data.digits, data.mode),
    };
  }
  return undefined;
}
