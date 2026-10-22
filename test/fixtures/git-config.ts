import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Git for Windows cannot use os.devNull as GIT_CONFIG_GLOBAL. Point every Git fixture at
// a real empty config file so tests stay isolated without relying on platform null devices.
const directory = mkdtempSync(join(tmpdir(), "agentteam-git-config-"));
export const emptyGitConfig = join(directory, "config");
writeFileSync(emptyGitConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
