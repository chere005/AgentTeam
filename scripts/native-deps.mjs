// Runs from `npm run prepare` after install: makes node-pty's spawn-helper executable
// (src/terminal-native.ts). Harmless when node-pty is absent or already fixed.
import { createRequire } from "node:module";
import { ensureSpawnHelper } from "../src/terminal-native.ts";
const require = createRequire(import.meta.url);
let entry;
try {
  entry = require.resolve("node-pty");
} catch {
  process.exit(0);
}
// A Mac can package either target architecture regardless of the Node host.
const architectures =
  process.platform === "darwin" ? ["arm64", "x64"] : undefined;
for (const helper of ensureSpawnHelper(entry, architectures))
  console.log("node-pty spawn-helper ready: " + helper);
