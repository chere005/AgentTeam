// Points Git at the repository's hooks (.githooks: pre-push asks for a passed preflight before
// main or a v* tag). Runs from `npm ci`/`npm install` ("prepare"); a no-op outside a Git checkout
// and in CI, and never fails the install.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
if (!process.env.CI && existsSync(".git")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"]);
    if (process.platform !== "win32") {
      chmodSync(".githooks/pre-push", 0o755);
      chmodSync("scripts/preflight.sh", 0o755);
    }
  } catch {
    // Hooks are a safeguard, not a requirement of the install.
  }
}
