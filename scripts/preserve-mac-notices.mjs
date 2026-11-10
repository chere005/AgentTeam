import { copyFile } from "node:fs/promises";
import { join } from "node:path";

// electron-builder removes the original top-level notices when it renames Electron.app.
// Preserve the notices from this target's distribution inside the bundle before signing.
export default async function preserveMacNotices({
  appOutDir,
  electronPlatformName,
}) {
  if (electronPlatformName !== "darwin") return;
  const resources = join(appOutDir, "Electron.app", "Contents", "Resources");
  await Promise.all([
    copyFile(
      join(appOutDir, "LICENSE"),
      join(resources, "LICENSE.electron.txt"),
    ),
    copyFile(
      join(appOutDir, "LICENSES.chromium.html"),
      join(resources, "LICENSES.chromium.html"),
    ),
  ]);
}
