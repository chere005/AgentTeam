// Tiny development-server fixture. Behaviour is chosen with FIXTURE_MODE.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const mode = process.env.FIXTURE_MODE ?? "serve";
const port = Number(process.env.PORT);
const host = process.env.HOST ?? "127.0.0.1";
if (process.env.FIXTURE_ENVFILE)
  writeFileSync(
    process.env.FIXTURE_ENVFILE,
    JSON.stringify(
      Object.keys(process.env).filter((k) => k.startsWith("AGENTTEAM_")),
    ),
  );
if (mode === "child") {
  // Grandchild: only records its pid, then idles until killed.
  appendFileSync(process.env.FIXTURE_PIDFILE, process.pid + "\n");
  setInterval(() => {}, 1000);
} else if (mode === "early-exit") {
  console.error("boom: fixture crashed");
  process.exit(3);
} else if (mode === "missing-deps") {
  console.error("Error: Cannot find module 'left-pad'");
  process.exit(1);
} else if (mode === "never") {
  console.log("fixture is running but never listens");
  setInterval(() => {}, 1000);
} else {
  if (process.env.FIXTURE_PIDFILE) {
    appendFileSync(process.env.FIXTURE_PIDFILE, process.pid + "\n");
    for (let i = 0; i < 2; i++)
      spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, FIXTURE_MODE: "child" },
        stdio: "ignore",
      }).unref();
  }
  const listenPort =
    mode === "ignore-port" ? Number(process.env.FIXTURE_REAL_PORT) : port;
  const server = createServer((req, res) => {
    if (mode === "redirect" && req.url === "/") {
      res.writeHead(302, { location: "/app" });
      return res.end();
    }
    if (mode === "redirect-away" && req.url === "/") {
      res.writeHead(302, { location: "https://example.invalid/" });
      return res.end();
    }
    const headers = { "content-type": "text/html" };
    if (mode === "frame-deny") headers["x-frame-options"] = "DENY";
    res.writeHead(200, headers);
    res.end(`<h1>fixture ${mode}</h1>`);
  });
  setTimeout(
    () =>
      server.listen(listenPort, host, () =>
        console.log(`Local: http://${host}:${listenPort}/`),
      ),
    Number(process.env.FIXTURE_DELAY_MS ?? 0),
  );
  process.on("SIGTERM", () => process.exit(0));
}
