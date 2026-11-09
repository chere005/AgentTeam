// Side-effect module: import it FIRST in a test file so `src/config.ts` (which reads
// AGENTTEAM_DATA_DIR once, at import time) resolves the data directory to a fresh temp folder
// instead of the developer's real one (e.g. its api-token).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const tempDataDir = mkdtempSync(join(tmpdir(), "agentteam-test-data-"));
process.env.AGENTTEAM_DATA_DIR = tempDataDir;
// AgentTeam proposes (and creates, on apply) new project folders in its projects folder: a test
// that applies such a proposal must never create one in the developer's real home.
process.env.AGENTTEAM_PROJECTS_DIR = join(tempDataDir, "AgentTeam Projects");
process.on("exit", () => rmSync(tempDataDir, { recursive: true, force: true }));
// Scoped Codex launches are refused where the read boundary was never verified (src/provider-filesystem.ts
// `codexReadBoundaryIssue`: everywhere but macOS). Fixture tests of the generated launch config opt in;
// test/provider-boundary.test.ts exercises the refusal itself.
if (process.platform !== "darwin")
  process.env.AGENTTEAM_UNVERIFIED_SANDBOX ??= "1";
