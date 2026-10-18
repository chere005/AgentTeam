import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { AppError } from "./model.ts";

/**
 * Per-attachment access rules that refine the folder-level `read`/`write` grant.
 *
 * Precedence (documented in the UI and covered by test/access.test.ts):
 *  1. An exclusion (`none`) that covers the path (the rule path equals the path or is an ancestor)
 *     always wins, even over a more specific explicit rule. Exclusions beat inclusions.
 *  2. Otherwise the most specific (longest) explicit `read`/`write` rule covering the path decides;
 *     at equal specificity `read` beats `write`.
 *  3. Otherwise `explicitOnly` attachments grant nothing; normal attachments inherit the folder access.
 * Rules are matched against the real (symlink-resolved) path AND the lexical path the caller used;
 * the stricter result applies. `.git` stays blocked regardless of any rule.
 */
export type AccessLevel = "none" | "read" | "write";
export type AccessRule = { path: string; access: AccessLevel };
export type AccessSubject = {
  path: string;
  access: "read" | "write";
  rules?: AccessRule[];
  explicitOnly?: boolean;
};
export const MAX_ACCESS_RULES = 200;
export const accessRuleSchema = z
  .object({
    path: z.string().min(1).max(500),
    access: z.enum(["none", "read", "write"]),
  })
  .strict();
const rank: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };
export const minAccess = (a: AccessLevel, b: AccessLevel): AccessLevel =>
  rank[a] <= rank[b] ? a : b;

/** Rule/relative path -> canonical POSIX relative path ("" is the attachment root). */
export function normalizeRelPath(raw: string, allowRoot = false): string {
  const bad = (message: string, code = "invalid_rule") => {
    throw new AppError(400, code, message);
  };
  if (raw.includes("\0")) bad("Access rule paths cannot contain NUL");
  const text = raw.replace(/\\/g, "/");
  if (text.startsWith("/") || /^[A-Za-z]:/.test(text) || isAbsolute(raw))
    bad(
      `Access rule path "${raw}" must be relative to the attached folder`,
      "invalid_rule",
    );
  const parts = text.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes(".."))
    bad(`Access rule path "${raw}" must stay inside the attached folder`);
  if (parts.some((p) => p.toLowerCase() === ".git"))
    bad("Git internals are always blocked and cannot be named in a rule");
  if (!parts.length && !allowRoot)
    bad(
      "A rule must name a file or subfolder; use the folder's own access for the whole attachment",
    );
  return parts.join("/");
}
export function normalizeRules(input: unknown): AccessRule[] {
  const rules = z
    .array(accessRuleSchema)
    .max(MAX_ACCESS_RULES)
    .parse(input ?? []);
  const seen = new Map<string, AccessLevel>();
  for (const r of rules) {
    const path = normalizeRelPath(r.path);
    const previous = seen.get(path.toLowerCase());
    if (previous && previous !== r.access)
      throw new AppError(
        400,
        "conflicting_rules",
        `Conflicting rules for "${path}" (${previous} and ${r.access}); keep one`,
      );
    seen.set(path.toLowerCase(), r.access);
  }
  const unique = new Map<string, AccessRule>();
  for (const r of rules) {
    const path = normalizeRelPath(r.path);
    unique.set(path.toLowerCase(), { path, access: r.access });
  }
  return [...unique.values()];
}
/** Lexical (no filesystem) normalisation of a caller-supplied relative path; never throws. */
export function lexicalRelative(raw: string): string {
  const out: string[] = [];
  for (const part of raw.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}
function covers(rulePath: string, rel: string, ci: boolean) {
  const a = ci ? rulePath.toLowerCase() : rulePath;
  const b = ci ? rel.toLowerCase() : rel;
  return a === "" || b === a || b.startsWith(a + "/");
}
export const hasRestrictions = (ws: AccessSubject) =>
  !!ws.explicitOnly || (ws.rules ?? []).length > 0;

export type Decision = {
  access: AccessLevel;
  source: "exclusion" | "rule" | "inherited" | "unlisted";
  rule?: AccessRule;
  reason: string;
};
/** Decision for one workspace-relative POSIX path (use "" for the root). */
export function decide(ws: AccessSubject, relRaw: string): Decision {
  const rel = relRaw.replace(/\\/g, "/").replace(/^\.\/?$/, "");
  const rules = ws.rules ?? [];
  const excluded = rules
    .filter((r) => r.access === "none" && covers(r.path, rel, true))
    .sort((a, b) => a.path.length - b.path.length)[0];
  if (excluded)
    return {
      access: "none",
      source: "exclusion",
      rule: excluded,
      reason: `Excluded by rule "${excluded.path}" (exclusions beat every other rule)`,
    };
  const matching = rules
    .filter((r) => r.access !== "none" && covers(r.path, rel, false))
    .sort(
      (a, b) =>
        b.path.length - a.path.length || rank[a.access] - rank[b.access],
    );
  if (matching.length)
    return {
      access: matching[0].access,
      source: "rule",
      rule: matching[0],
      reason: `${matching[0].access} access from the most specific rule "${matching[0].path}"`,
    };
  if (ws.explicitOnly)
    return {
      access: "none",
      source: "unlisted",
      reason:
        "Not listed: this attachment grants only the explicitly listed files and folders",
    };
  return {
    access: ws.access,
    source: "inherited",
    reason: `Inherited ${ws.access} access of the attached folder`,
  };
}
/** Stricter of the lexical and real-path decisions (symlink and case games cannot loosen a rule). */
export function decideBoth(
  ws: AccessSubject,
  lexical: string,
  real: string,
): Decision {
  const a = decide(ws, lexical),
    b = decide(ws, real);
  return rank[a.access] <= rank[b.access] ? a : b;
}
/** A directory that can be listed/entered: not excluded and either accessible or leading to an allowed path. */
export function traversable(ws: AccessSubject, relRaw: string): boolean {
  const rel = relRaw.replace(/\\/g, "/").replace(/^\.\/?$/, "");
  const d = decide(ws, rel);
  if (d.source === "exclusion") return false;
  if (d.access !== "none") return true;
  return (ws.rules ?? []).some(
    (r) =>
      r.access !== "none" &&
      (rel === "" ||
        r.path.toLowerCase().startsWith(rel.toLowerCase() + "/")) &&
      decide(ws, r.path).access !== "none",
  );
}
/** Predicate over repository-relative paths (as printed by Git) for one attachment. */
export function repoPathFilter(
  ws: AccessSubject,
  repoTop: string,
  attachmentRoot = ws.path,
) {
  return (repoRelative: string) => {
    if (repoRelative.includes("\0")) return false; // undeterminable path: fail closed
    const abs = resolve(repoTop, repoRelative);
    const rel = relative(attachmentRoot, abs).replace(/\\/g, "/");
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return true; // scoped by pathspec already
    return decide(ws, rel).access !== "none";
  };
}
/** Git C-style quoted path ("a/x\\303\\251") -> text; unquoted input is returned as is. */
export function unquoteGitPath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')))
    return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const simple: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = body[++i];
    if (/[0-7]/.test(next ?? "")) {
      const oct = body.slice(i, i + 3);
      bytes.push(parseInt(oct, 8));
      i += 2;
    } else if (next !== undefined && next in simple) bytes.push(simple[next]);
    else bytes.push(92, ...Buffer.from(next ?? "", "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
/**
 * Paths a `diff --git` section touches, or null when they cannot be determined unambiguously.
 * Handles quoted names, names with spaces (unquoted headers are split by symmetry) and
 * rename/copy headers.
 */
export function diffSectionPaths(section: string): string[] | null {
  const header = section.split("\n", 1)[0].replace(/\r$/, "");
  const prefix = "diff --git ";
  if (!header.startsWith(prefix)) return null;
  const rest = header.slice(prefix.length);
  const paths: string[] = [];
  const quoted = /^("(?:[^"\\]|\\.)*"|a\/\S*) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(
    rest,
  );
  const strip = (p: string, side: "a/" | "b/") => {
    const text = unquoteGitPath(p);
    return text.startsWith(side) ? text.slice(2) : null;
  };
  if (rest.startsWith('"') || / "b\//.test(rest)) {
    if (!quoted) return null;
    const a = strip(quoted[1], "a/"),
      b = strip(quoted[2], "b/");
    if (a === null || b === null) return null;
    paths.push(a, b);
  } else {
    // Unquoted: "a/P b/P" for an ordinary change; a rename/copy names both sides below.
    const n = (rest.length - 5) / 2; // "a/" + P + " b/" + P
    if (
      Number.isInteger(n) &&
      n > 0 &&
      rest.startsWith("a/") &&
      rest.slice(2 + n, 5 + n) === " b/" &&
      rest.slice(2, 2 + n) === rest.slice(5 + n)
    )
      paths.push(rest.slice(2, 2 + n));
  }
  for (const line of section.split("\n")) {
    const m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(
      line.replace(/\r$/, ""),
    );
    if (m) paths.push(unquoteGitPath(m[1]));
    if (line.startsWith("@@")) break;
  }
  return paths.length ? paths : null;
}
/**
 * Drop whole-file sections of a unified diff whose path (or rename source) is not visible. A
 * section whose paths cannot be determined is dropped too (fail closed) unless every path is
 * visible anyway (`visible("")` true means the attachment has no restrictions).
 */
export function filterDiff(text: string, visible: (path: string) => boolean) {
  if (!text) return text;
  const sections = text.split(/^(?=diff --git )/m);
  return sections
    .filter((section) => {
      if (!section.startsWith("diff --git ")) return true;
      const paths = diffSectionPaths(section);
      if (!paths) return visible("\0unknown");
      return paths.every((p) => visible(p));
    })
    .join("");
}

export type AccessReport = {
  workspace: string;
  access: "read" | "write";
  explicitOnly: boolean;
  restricted: boolean;
  allowed: { path: string; access: AccessLevel; reason: string }[];
  denied: { path: string; reason: string }[];
  notes: string[];
};
export const ENFORCEMENT_NOTE =
  "Enforced by AgentTeam: file browsing and preview, Git actions, artifact registration and resource locks. Provider CLI processes, native subagents and external editors run with your own OS permissions and are outside this cooperative enforcement.";
export function accessReport(ws: AccessSubject): AccessReport {
  const rules = ws.rules ?? [];
  const allowed: AccessReport["allowed"] = [];
  const denied: AccessReport["denied"] = [];
  if (!ws.explicitOnly)
    allowed.push({
      path: ".",
      access: ws.access,
      reason: `Whole folder, ${ws.access} access (inherited)`,
    });
  for (const r of rules) {
    if (r.access === "none") {
      denied.push({
        path: r.path,
        reason: `Excluded by rule "${r.path}"`,
      });
      continue;
    }
    const d = decide(ws, r.path);
    if (d.access === "none")
      denied.push({
        path: r.path,
        reason: `${r.access} rule is overridden: ${d.reason}`,
      });
    else
      allowed.push({
        path: r.path,
        access: d.access,
        reason:
          d.access === r.access
            ? `Explicit ${r.access} rule${ws.access === r.access && !ws.explicitOnly ? " (same as the folder)" : ""}`
            : d.reason,
      });
  }
  denied.push({
    path: ".git",
    reason: "Git internals are always blocked (use the Git tools)",
  });
  const notes = [ENFORCEMENT_NOTE];
  if (hasRestrictions(ws))
    notes.push(
      "Git actions that rewrite the whole working tree (commit, pull, branch switch) are refused while this attachment has exclusions or explicit-only rules; staging checks each path.",
    );
  return {
    workspace: ws.path,
    access: ws.access,
    explicitOnly: !!ws.explicitOnly,
    restricted: hasRestrictions(ws),
    allowed,
    denied,
    notes,
  };
}
/** One-line description used on compact cards. */
export function accessSummary(ws: AccessSubject) {
  const rules = ws.rules ?? [];
  const ex = rules.filter((r) => r.access === "none").length;
  const inc = rules.length - ex;
  const base = ws.explicitOnly ? "listed paths only" : ws.access;
  return (
    base +
    (inc ? ` +${inc} rule${inc === 1 ? "" : "s"}` : "") +
    (ex ? ` −${ex} excluded` : "")
  );
}
