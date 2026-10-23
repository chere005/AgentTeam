import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

function windowsKey(path: string) {
  return path
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "")
    .replaceAll("/", "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/** Compare Windows paths by file identity when available, with canonical-name fallback. */
function sameWindowsPath(a: string, b: string) {
  try {
    const left = statSync(a);
    const right = statSync(b);
    if (left.ino !== 0 && right.ino !== 0 && left.dev === right.dev)
      return left.ino === right.ino;
    return windowsKey(realpathSync(a)) === windowsKey(realpathSync(b));
  } catch {
    return false;
  }
}

/** Compare existing paths by filesystem identity on Windows, where 8.3 aliases differ lexically. */
export function samePath(a: string, b: string) {
  if (process.platform !== "win32") return resolve(a) === resolve(b);
  try {
    if (lstatSync(b).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return sameWindowsPath(a, b);
}

/** Return the path from `root` to `path`, or null if it is outside the root. */
export function relativeWithin(root: string, path: string): string | null {
  if (process.platform !== "win32") {
    const rel = relative(resolve(root), resolve(path));
    return rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
      ? rel.split(/[\\/]/).filter(Boolean).join("/")
      : null;
  }

  let ancestor = win32.resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      ancestor = realpathSync(ancestor);
      break;
    } catch {
      const parent = win32.dirname(ancestor);
      if (parent === ancestor) return null;
      missing.push(win32.basename(ancestor));
      ancestor = parent;
    }
  }

  const suffix = missing.reverse();
  for (;;) {
    if (sameWindowsPath(root, ancestor)) return suffix.join("/");
    const parent = win32.dirname(ancestor);
    if (parent === ancestor) return null;
    suffix.unshift(win32.basename(ancestor));
    ancestor = parent;
  }
}
