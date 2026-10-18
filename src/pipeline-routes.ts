import type { DetectedRuntime } from "./discovery.ts";
import { assert } from "./model.ts";
import {
  PIPELINE_SAMPLE_ID,
  createPipelineSample,
  pipelineDefaults,
} from "./pipeline.ts";
import type { TeamService } from "./service.ts";
import type { WorktreeService } from "./worktrees.ts";

/**
 * Pipeline sample API (behind the bearer-token check in http.ts):
 *   GET  /pipelines/defaults              configurable defaults, hard caps
 *   POST /pipelines                       create the paused sample {goal, workspace, models, caps, ...}
 *   POST /pipelines/:id/prepare           verify providers/models/caps/read-only roles and assign
 *                                         disjoint paths or worktrees (resume is refused until it passes)
 *   POST /pipelines/:id/stage2            assign (or retry) the fix workers once the first integration step completed
 *   GET  /pipelines/:id/history           stages, preflight and the immutable handoff notes
 * Returns undefined when the path is not one of these routes.
 */
export async function pipelineRoute(
  service: TeamService,
  deps: { worktrees?: WorktreeService; runtimes: () => DetectedRuntime[] },
  method: string | undefined,
  url: URL | string | undefined,
  readBody: () => Promise<unknown>,
) {
  const path =
    typeof url === "string" ? url.split("?")[0] : (url?.pathname ?? "");
  if (path !== "/pipelines" && !path.startsWith("/pipelines/"))
    return undefined;
  service.pipelines.worktrees ??= deps.worktrees;
  const dec = (s: string) => decodeURIComponent(s);
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/pipelines/defaults")
    return { data: pipelineDefaults() };
  if (method === "POST" && path === "/pipelines")
    return {
      data: await createPipelineSample(service, await readBody()),
      status: 201,
    };
  if ((m = path.match(/^\/pipelines\/([^/]+)\/(prepare|stage2|history)$/))) {
    const id = dec(m[1]);
    const wf = service.store.get<{ setup?: { sample?: string } }>(
      "workflow",
      id,
    );
    assert(
      wf.setup?.sample === PIPELINE_SAMPLE_ID,
      "not_a_pipeline",
      "Workflow is not a pipeline sample",
      404,
    );
    if (method === "GET" && m[2] === "history")
      return { data: service.pipelines.view(id) };
    if (method === "POST" && m[2] === "prepare") {
      await service.pipelines.prepare(id, deps.runtimes());
      return { data: service.pipelines.view(id) };
    }
    if (method === "POST" && m[2] === "stage2") {
      await service.pipelines.assignStage2(id);
      return { data: service.pipelines.view(id) };
    }
  }
  return undefined;
}
