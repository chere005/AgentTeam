import { symlink } from "node:fs/promises";

const WINDOWS_FILE_SYMLINK_SKIP_REASON =
  "Windows denied file-symlink creation; this check requires Developer Mode or symlink privilege";

/** Create a directory alias with the Windows link type that needs no elevated privilege. */
export async function createDirectoryAlias(
  target: string,
  path: string,
): Promise<void> {
  await symlink(
    target,
    path,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/**
 * Create a real file symlink. Return false only when Windows denies the privilege;
 * callers can then skip just the assertion whose semantics require a file symlink.
 */
export async function createFileSymlink(
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      ["EACCES", "EPERM"].includes(code ?? "")
    )
      return false;
    throw error;
  }
}

export { WINDOWS_FILE_SYMLINK_SKIP_REASON };
