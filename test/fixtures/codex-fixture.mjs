#!/usr/bin/env node
// Minimal stand-in for `codex`: answers `--version` and the app-server model/account handshake.
// Signed in by default. CODEX_FIXTURE_SIGNED_OUT=1 reports no account, unless the file named by
// CODEX_FIXTURE_AUTH_FILE exists; `codex login` creates that file (a fixture "sign-in").
import { createInterface } from "node:readline";
import { existsSync, writeFileSync } from "node:fs";
const authFile = process.env.CODEX_FIXTURE_AUTH_FILE;
const signedIn = () =>
  process.env.CODEX_FIXTURE_SIGNED_OUT !== "1" ||
  (!!authFile && existsSync(authFile));
if (process.argv.includes("--version")) {
  console.log("codex-fixture 1.2.3");
  process.exit(0);
}
if (process.argv[2] === "login") {
  if (authFile) writeFileSync(authFile, "signed in\n");
  console.log("codex-fixture: signed in");
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
      reply(message.id, { account: signedIn() ? { type: "chatgpt" } : null });
  });
}
