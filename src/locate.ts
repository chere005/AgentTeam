import { AppError } from "./model.ts";
import type { WorkspaceService } from "./workspaces.ts";

/**
 * `WorkspaceService.location` with friendlier failures for the read-only/launch routes: parent
 * traversal is refused lexically before any filesystem access (so a missing target cannot leak
 * its absence or surface as a raw ENOENT), and a missing path is a 404 rather than a 500.
 */
export async function locate(
  ws: WorkspaceService,
  agentId: string,
  input: { workspace: string; path?: string },
  write = false,
) {
  if (
    typeof input.path === "string" &&
    input.path.split(/[\\/]+/).includes("..")
  )
    throw new AppError(
      403,
      "path_escape",
      "Path escapes the attached workspace",
    );
  try {
    return await ws.location(agentId, input, write);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new AppError(404, "not_found", "No such file or folder");
    throw e;
  }
}
