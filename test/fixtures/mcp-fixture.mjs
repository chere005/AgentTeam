// Local stdio MCP fixture for tests: speaks just enough JSON-RPC for initialize + tools/list.
// Every received method is appended to $MCP_FIXTURE_LOG so tests can prove nothing else was sent.
// FIXTURE_MODE: ok (default) | hang | exit | leak-error (error message echoes $FIXTURE_TOKEN)
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const mode = process.env.FIXTURE_MODE ?? "ok";
const log = (m) => {
  if (process.env.MCP_FIXTURE_LOG)
    appendFileSync(process.env.MCP_FIXTURE_LOG, m + "\n");
};
if (mode === "exit") process.exit(3);
const out = (m) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log(msg.method ?? "response");
  if (mode === "hang") return;
  if (msg.method === "initialize") {
    if (mode === "leak-error")
      return out({
        id: msg.id,
        error: {
          code: -32000,
          message: "bad credential " + process.env.FIXTURE_TOKEN,
        },
      });
    return out({
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-server", version: "1.2.3" },
      },
    });
  }
  if (msg.method === "tools/list") {
    const first = !msg.params?.cursor;
    return out({
      id: msg.id,
      result: first
        ? {
            tools: [{ name: "echo", description: "Echo text" }],
            nextCursor: "p2",
          }
        : { tools: [{ name: "read_file", description: "Read a file" }] },
    });
  }
  if (msg.method === "tools/call")
    return out({
      id: msg.id,
      error: { code: -32601, message: "calls are not allowed in tests" },
    });
  if (msg.id !== undefined)
    out({ id: msg.id, error: { code: -32601, message: "unknown method" } });
});
