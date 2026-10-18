import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "./store.ts";
import { SkillCatalog } from "./skills.ts";
import { TeamService } from "./service.ts";
import { RunManager } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createApi } from "./http.ts";
import { dataDir, roots, projectRoot } from "./config.ts";
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const tokenPath = join(dataDir, "api-token");
let token: string;
try {
  token = (await readFile(tokenPath, "utf8")).trim();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, token + "\n", { mode: 0o600, flag: "wx" });
}
await chmod(tokenPath, 0o600);
const store = new Store(join(dataDir, "agentteam.sqlite"));
const catalog = new SkillCatalog(roots());
await catalog.scan();
const service = new TeamService(store, catalog);
const runs = new RunManager(
  service,
  process.env.AGENTTEAM_ENABLE_LIVE === "1",
  projectRoot,
);
runs.recover();
const scheduler = new Scheduler(service, runs);
scheduler.start();
const server = createApi(service, token, runs);
const port = Number(process.env.AGENTTEAM_PORT ?? 4317);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid port");
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.log(
    `AgentTeam backend: http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`,
  );
  console.log(`Bearer token file: ${tokenPath}`);
  console.log(
    `Skills: ${catalog.items.size}; live execution: ${runs.enabled ? "enabled" : "disabled"}`,
  );
});
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  scheduler.stop();
  runs.close();
  server.closeAllConnections();
  server.close();
  for (let i = 0; i < 100 && runs.active.size; i++)
    await new Promise((r) => setTimeout(r, 50));
  if (!runs.active.size) store.close();
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
