import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal";
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (text) =>
  send({
    method: "session/update",
    params: {
      sessionId: "fixture",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
let promptId;
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "fixture-model",
    options: [{ value: "fixture-model", name: "Fixture" }],
  },
];
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === "permission" && !message.method) {
    update(
      message.result.outcome.outcome === "selected" ? "approved" : "denied",
    );
    reply(promptId, { stopReason: "end_turn" });
    return;
  }
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: mode !== "no-resume" },
        authMethods: [],
      });
      break;
    case "session/new":
      reply(message.id, { sessionId: "fixture", configOptions });
      break;
    case "session/load":
      update("OLD HISTORY");
      reply(message.id, { configOptions });
      break;
    case "session/set_config_option":
      reply(message.id, { configOptions });
      break;
    case "session/prompt":
      if (mode === "crash") process.exit(7);
      if (mode === "hang") break;
      if (mode === "permission") {
        promptId = message.id;
        send({
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId: "fixture",
            toolCall: {
              toolCallId: "tool-1",
              title: "Write fixture",
              kind: "edit",
            },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "deny", name: "Reject once", kind: "reject_once" },
            ],
          },
        });
      } else {
        update("Hello");
        update(" world");
        reply(message.id, { stopReason: "end_turn" });
      }
      break;
    case "session/cancel":
      reply(promptId, { stopReason: "cancelled" });
      break;
  }
});
