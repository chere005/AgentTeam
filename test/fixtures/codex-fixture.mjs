#!/usr/bin/env node
// Minimal stand-in for `codex`: answers `--version` and the app-server model/account handshake.
import { createInterface } from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-fixture 1.2.3");
  process.exit(0);
}
if (process.argv[2] === "app-server") {
  const reply = (id, result) => console.log(JSON.stringify({ id, result }));
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(message.id, {});
    if (message.method === "model/list")
      reply(message.id, {
        data: [
          {
            model: "gpt-fixture",
            displayName: "GPT Fixture",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
            ],
          },
          {
            model: "gpt-mini",
            displayName: "GPT Mini",
            supportedReasoningEfforts: [],
          },
        ],
      });
    if (message.method === "account/read")
      reply(message.id, { account: { type: "chatgpt" } });
  });
}
