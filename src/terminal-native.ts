/**
 * node-pty native-module housekeeping. node-pty 1.1 ships N-API prebuilds (macOS, Windows) that
 * load in Node and Electron alike, but its macOS `spawn-helper` is unpacked without the execute
 * bit, which makes every spawn fail with "posix_spawnp failed". `npm ci` (scripts/native-deps.mjs
 * via `prepare`) and the desktop main process both restore it.
 */
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** `entry` is require.resolve("node-pty"); returns the helpers that are (now) executable. */
export function ensureSpawnHelper(entry: string): string[] {
  if (process.platform === "win32") return [];
  const root = dirname(dirname(entry)).replace("app.asar", "app.asar.unpacked");
  const fixed: string[] = [];
  for (const dir of [
    join(root, "build", "Release"),
    join(root, "prebuilds", `${process.platform}-${process.arch}`),
  ]) {
    const helper = join(dir, "spawn-helper");
    if (!existsSync(helper)) continue;
    try {
      if ((statSync(helper).mode & 0o111) !== 0o111) chmodSync(helper, 0o755);
      fixed.push(helper);
    } catch {
      /* read-only install (a packaged app): packaging kept the mode set at npm ci */
    }
  }
  return fixed;
}
