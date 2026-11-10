import { defineConfig } from "@playwright/test";
// Hosted Windows/Linux runners (software rendering, xvfb) are several times slower than the Mac
// the budgets were set on; only the waits grow there, no assertion is relaxed.
const slowHost = Boolean(process.env.CI) && process.platform !== "darwin";
// Desktop specs exercise UI flows with fixture providers. On Windows the launch policy refuses
// program-running Claude agents because Claude's shell sandbox is unavailable on native Windows;
// that refusal is covered by backend tests with injected platforms. Here the app (AGENTTEAM_TEST=1
// only, desktop/main.ts) assumes a sandboxed host so the flows under test can be reached. A spec
// that wants the real host policy sets AGENTTEAM_TEST_RUNTIME_PLATFORM="" in its launch env.
if (
  process.platform === "win32" &&
  process.env.AGENTTEAM_TEST_RUNTIME_PLATFORM === undefined
)
  process.env.AGENTTEAM_TEST_RUNTIME_PLATFORM = "linux";
export default defineConfig({
  testDir: "./e2e",
  timeout: slowHost ? 120000 : 45000,
  expect: { timeout: slowHost ? 15000 : 5000 },
  workers: 1,
  // A hosted runner is slower and busier than a desktop: one retry there, reported as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
