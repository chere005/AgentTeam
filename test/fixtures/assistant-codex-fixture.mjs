#!/usr/bin/env node
// Stand-in for `codex` acting as the Team Assistant (e2e/assistant-chat.spec.ts). Answers
// `--version` and the app-server handshake like codex-fixture.mjs; for `exec --json` it reads the
// prompt from stdin, checks the proposal protocol is there, reads agent ids from the team-state
// block and replies with a plan plus ONE agentteam-proposal block. No network, no provider.
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
            supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          },
        ],
      });
    if (message.method === "account/read")
      reply(message.id, { account: { type: "chatgpt" } });
  });
} else if (process.argv[2] === "exec") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", async () => {
    const out = (v) => console.log(JSON.stringify(v));
    out({ type: "thread.started", thread_id: "fixture-assistant-thread" });
    const request = input.slice(input.lastIndexOf("User request:\n") + 14);
    // A run carries every queued message (src/runtime.ts pendingPrompt): say so in the reply.
    const count = (request.match(/^Earlier message \d+:$/gm) ?? []).length + 1;
    const say = (body) => {
      const text = (count > 1 ? `Answering ${count} messages. ` : "") + body;
      out({ type: "item.completed", item: { type: "agent_message", text } });
      out({ type: "turn.completed", usage: { input_tokens: 1 } });
    };
    if (!input.includes("## Proposing team changes"))
      return say("NO PROPOSAL PROTOCOL IN PROMPT");
    const m = input.match(
      /<untrusted-data kind="team-state"[^>]*>\n([\s\S]*?)\n<\/untrusted-data>/,
    );
    const state = JSON.parse(m[1]);
    const id = (name) => state.agents.items.find((a) => a.name === name)?.id;
    if (/slow/i.test(request)) await new Promise((r) => setTimeout(r, 4000));
    const fence = (p) =>
      "```agentteam-proposal\n" + JSON.stringify(p, null, 2) + "\n```";
    if (/rejected by AgentTeam's validation/.test(request))
      return say(
        "That skill is not in the catalog; JavaScript Pro is the closest match. Corrected proposal for your review:\n\n" +
          fence({
            title: "Add a JavaScript skill (corrected)",
            ops: [
              {
                op: "agent.skills",
                agentId: id("Frontend Engineer"),
                add: [{ id: "curated:jeffallan--javascript-pro" }],
              },
            ],
          }),
      );
    if (/invalid/i.test(request))
      return say(
        "Plan: give the Frontend Engineer a design skill, proposed for your review.\n\n" +
          fence({
            title: "Add a design skill",
            ops: [
              {
                op: "agent.skills",
                agentId: id("Frontend Engineer"),
                add: [{ id: "curated:does-not-exist" }],
              },
            ],
          }),
      );
    if (/skills/i.test(request))
      return say(
        "Plan: the Frontend Engineer gets frontend design, TypeScript and Playwright skills; the Backend Engineer gets TypeScript and PostgreSQL; the Technical Writer needs none. All load on demand. This is a proposal for your review.\n\n" +
          fence({
            title: "Add skills to the engineers",
            rationale: "Match each engineer's work to the catalog.",
            ops: [
              {
                op: "agent.skills",
                agentId: id("Frontend Engineer"),
                add: [
                  { id: "curated:anthropic--frontend-design" },
                  { id: "curated:jeffallan--typescript-pro" },
                  { id: "curated:jeffallan--playwright-expert" },
                ],
              },
              {
                op: "agent.skills",
                agentId: id("Backend Engineer"),
                add: [
                  { id: "curated:jeffallan--typescript-pro" },
                  { id: "curated:jeffallan--postgres-pro" },
                ],
              },
            ],
          }),
      );
    say("Hello from the fixture assistant.");
  });
}
