import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  timeout: 45000,
  workers: 1,
  // A hosted runner is slower and busier than a desktop: one retry there, reported as flaky.
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
