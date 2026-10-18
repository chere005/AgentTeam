// Side-effect module: import it FIRST in a test file so `src/config.ts` (which reads
// AGENTTEAM_DATA_DIR once, at import time) resolves the data directory to a fresh temp folder
// instead of the developer's real one (e.g. its api-token).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDataDir = mkdtempSync(join(tmpdir(), "agentteam-test-data-"));
process.env.AGENTTEAM_DATA_DIR = tempDataDir;
process.on("exit", () => rmSync(tempDataDir, { recursive: true, force: true }));
