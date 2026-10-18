import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { decideBoth } from "./access.ts";
import { AppError, type Agent } from "./model.ts";
import { contains } from "./resources.ts";

/** Canonicalize a path that may not exist yet: real path of the nearest existing ancestor + the rest. */
function canonicalize(path: string) {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.push(existing.slice(parent.length).replace(/^[\\/]+/, ""));
      existing = parent;
    }
  }
}

/**
 * Validate and canonicalize a task's declared resource paths: each must be absolute, inside one of
 * the agent's attached folders (symlinks resolved, so a link cannot smuggle in outside paths), not
 * inside `.git`, and not excluded by that attachment's access rules. Returns undefined when the
 * task declares nothing, which keeps the default of leasing every attached folder.
 */
export function canonicalDeclaredPaths(agent: Agent, raw?: string[]) {
  if (!raw?.length) return undefined;
  const out = new Set<string>();
  for (const p of raw) {
    if (!isAbsolute(p) || p.includes("\0"))
      throw new AppError(
        400,
        "invalid_resource_path",
        `Declared resource path "${p}" must be absolute`,
      );
    const real = canonicalize(p);
    const ws = agent.workspaces
      .filter((w) => contains(w.path, real))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!ws)
      throw new AppError(
        400,
        "resource_path_outside",
        `Declared resource path "${p}" is outside every folder attached to ${agent.name}`,
      );
    const rel = relative(ws.path, real).replace(/\\/g, "/");
    if (rel.split("/").some((s) => s.toLowerCase() === ".git"))
      throw new AppError(
        400,
        "git_internal",
        "Git internals cannot be declared as a resource",
      );
    const d = decideBoth(ws, rel, rel);
    if (d.access === "none")
      throw new AppError(
        400,
        "access_denied",
        `Declared resource path "${p}" is not accessible: ${d.reason}`,
      );
    out.add(real);
  }
  // Drop paths already covered by a declared ancestor so the lease stays minimal and exact.
  const all = [...out];
  return all.filter((p) => !all.some((q) => q !== p && contains(q, p)));
}
