// A controllable folder probe for tests: the system "refuses" listed folders exactly as macOS
// folder privacy (or plain permissions) would, and every other folder is probed for real.
// Temporary folders only; no protected folder of the developer's machine is ever touched.
import { isAbsolute, relative } from "node:path";
import { canonicalPolicyPath } from "../../src/filesystem-policy.ts";
import {
  macosRefusal,
  probeFolderAccess,
  type FolderProbeResult,
} from "../../src/folder-access.ts";
import type { TeamService } from "../../src/service.ts";

const inside = (folder: string, path: string) => {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function controlFolders(service: Pick<TeamService, "folderAccess">) {
  const refused = new Map<string, "macos" | "permissions">();
  const calls: { path: string; write: boolean }[] = [];
  service.folderAccess.setProbe(async (path, { write }) => {
    calls.push({ path, write });
    const hit = [...refused].find(([folder]) => inside(folder, path));
    if (!hit) return probeFolderAccess(path, { write });
    if (hit[1] === "macos") return macosRefusal(path, write);
    // The same refusal without macOS: plain permissions.
    return probeFolderAccess(path, {
      write,
      fs: {
        opendir: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    });
  });
  return {
    calls,
    /** From now on the system refuses this folder (and everything inside it). */
    refuse(folder: string, kind: "macos" | "permissions" = "macos") {
      refused.set(canonicalPolicyPath(folder), kind);
    },
    /** The person opened the folder in System Settings (nothing is re-probed until asked). */
    allow(folder: string) {
      refused.delete(canonicalPolicyPath(folder));
    },
    probes(folder: string) {
      const canonical = canonicalPolicyPath(folder);
      return calls.filter((call) => inside(canonical, call.path)).length;
    },
  };
}
export type FolderControl = ReturnType<typeof controlFolders>;
export const refusalText = (result: FolderProbeResult | undefined) =>
  result && !result.ok ? `${result.message} ${result.fix}` : "";
