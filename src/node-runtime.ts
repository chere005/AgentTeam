import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";

/**
 * Read-only roots a sandboxed task needs to EXECUTE Node: the install that `node` resolves to,
 * nothing else. Package-manager installs (Homebrew) load shared libraries and OpenSSL config from
 * sibling formulae, so the whole prefix is granted read-only; any other install (nvm, fnm, volta,
 * a tarball) gets its own `<prefix>` (the folder holding `bin/`). System locations (/usr, /bin)
 * are already covered by the provider's minimal read set and return nothing. Never a home folder.
 */
export type NodeRootsDeps = {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
};
const SYSTEM = ["/usr", "/bin", "/sbin", "/System", "/Library", "/lib"];
const BREW_PREFIXES = [
  "/opt/homebrew",
  "/usr/local",
  "/home/linuxbrew/.linuxbrew",
];

export function nodeReadRoots(deps: NodeRootsDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return [];
  const exists = deps.exists ?? existsSync;
  const real = deps.realpath ?? realpathSync;
  const dirs = [
    ...(deps.pathEnv ?? process.env.PATH ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "node");
    if (!exists(candidate)) continue;
    let target: string;
    try {
      target = real(candidate);
    } catch {
      continue;
    }
    const under = (root: string) =>
      target === root || target.startsWith(root + sep);
    // /usr/local also holds plain tarball installs; only treat it as a prefix when brew's Cellar exists.
    const brew = BREW_PREFIXES.find(
      (prefix) => under(prefix) && exists(join(prefix, "Cellar")),
    );
    if (brew) return [brew];
    if (SYSTEM.some(under) && !under("/usr/local")) return [];
    const prefix = dirname(dirname(target));
    return prefix.split(sep).filter(Boolean).length >= 2 ? [prefix] : [];
  }
  return [];
}
