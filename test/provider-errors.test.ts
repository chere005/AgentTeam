import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProviderFailure,
  toProviderError,
  ProviderError,
} from "../src/provider-errors.ts";
import { AppError } from "../src/model.ts";
import { providerLimits } from "../src/config.ts";

const cases: [string, Parameters<typeof classifyProviderFailure>[0], string][] =
  [
    [
      "auth login",
      { message: "Provider exited 1: Please run codex login" },
      "authentication",
    ],
    ["auth 401", { message: "API Error: 401 Unauthorized" }, "authentication"],
    ["invalid key", { message: "invalid api key provided" }, "authentication"],
    [
      "rate limit",
      { message: "Provider exited 1: rate limit exceeded" },
      "quota",
    ],
    ["429", { message: "HTTP 429 Too Many Requests" }, "quota"],
    ["usage limit", { message: "Claude usage limit reached" }, "quota"],
    [
      "model missing",
      { message: "The model `gpt-9` does not exist" },
      "model-unavailable",
    ],
    [
      "unknown model",
      { message: "Error: unknown model foo" },
      "model-unavailable",
    ],
    ["timeout code", { code: "runtime_timeout", message: "x" }, "timeout"],
    ["timeout status", { status: 504, message: "x" }, "timeout"],
    ["cancel flag", { cancelled: true, message: "boom" }, "cancellation"],
    [
      "cancel code",
      { code: "cancelled", message: "Request cancelled" },
      "cancellation",
    ],
    [
      "exit",
      { code: "runtime_exit", message: "Provider exited 2: segfault" },
      "process-failure",
    ],
    ["empty", {}, "process-failure"],
  ];
for (const [name, input, kind] of cases)
  test(`classify ${name}`, () =>
    assert.equal(classifyProviderFailure(input), kind));

test("cancellation wins over timeout text", () =>
  assert.equal(
    classifyProviderFailure({ cancelled: true, code: "runtime_timeout" }),
    "cancellation",
  ));

test("toProviderError tags message, keeps status, is idempotent", () => {
  const e = toProviderError(
    new AppError(502, "runtime_exit", "Provider exited 1: 401 Unauthorized"),
  );
  assert.ok(e instanceof ProviderError);
  assert.equal(e.kind, "authentication");
  assert.equal(e.status, 502);
  assert.equal(e.code, "runtime_exit");
  assert.equal(
    toProviderError(new Error("x")).code,
    "provider_process_failure",
  );
  assert.match(e.message, /^\[authentication\] /);
  assert.equal(toProviderError(e), e);
  assert.equal(toProviderError("weird").kind, "process-failure");
  assert.equal(
    toProviderError(new Error("x"), { cancelled: true }).status,
    499,
  );
});

test("provider limits defaults preserve prior chat behavior", () => {
  assert.deepEqual(providerLimits("chat", {}), {
    timeoutMs: 180_000,
    maxOutputBytes: 4_000_000,
  });
  assert.ok(providerLimits("task", {}).timeoutMs > 180_000);
});

test("provider limits parse env and reject invalid values", () => {
  const env = {
    AGENTTEAM_CHAT_TIMEOUT_SECONDS: "30",
    AGENTTEAM_CHAT_MAX_OUTPUT_MB: "1",
    AGENTTEAM_TASK_TIMEOUT_SECONDS: "-5",
    AGENTTEAM_TASK_MAX_OUTPUT_MB: "abc",
  };
  assert.deepEqual(providerLimits("chat", env), {
    timeoutMs: 30_000,
    maxOutputBytes: 1_000_000,
  });
  assert.deepEqual(providerLimits("task", env), providerLimits("task", {}));
  assert.equal(
    providerLimits("chat", { AGENTTEAM_CHAT_TIMEOUT_SECONDS: "" }).timeoutMs,
    180_000,
  );
});
