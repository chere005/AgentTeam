import { defineConfig } from "@playwright/test";
// Hosted Windows/Linux runners (software rendering, xvfb) are several times slower than the Mac
// the budgets were set on; only the waits grow there, no assertion is relaxed.
const slowHost = Boolean(process.env.CI) && process.platform !== "darwin";
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
