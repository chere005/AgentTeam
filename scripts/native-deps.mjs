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
for (const helper of ensureSpawnHelper(entry))
  console.log("node-pty spawn-helper ready: " + helper);
