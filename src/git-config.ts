import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git expects core.hooksPath to be a directory. Null-device paths are not directories on
// Windows, so use an empty per-process directory to disable hooks portably.
export const NO_GIT_HOOKS_DIR = mkdtempSync(
  join(tmpdir(), "agentteam-no-git-hooks-"),
);
process.once("exit", () =>
  rmSync(NO_GIT_HOOKS_DIR, { recursive: true, force: true }),
);
