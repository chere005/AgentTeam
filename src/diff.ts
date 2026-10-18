/** Pure helpers for review diffs: header metadata, revision validation and output bounds. */

export const DIFF_MAX_BYTES = 600_000;
export const DIFF_MAX_LINES = 6000;
export const DIFF_MAX_LINE_CHARS = 5000;
export const REVIEW_MAX_FILES = 2000;

/** Lexical revision check. Git still resolves it; this keeps option-like or control input out of argv. */
export function revisionProblem(rev: string): string | null {
  if (!rev || rev.length > 200) return "Enter a branch, tag or commit";
  if (rev.startsWith("-")) return "A revision cannot start with '-'";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f:?*[\\]/.test(rev))
    return "Revision contains characters Git does not allow";
  if (rev.includes("..") || rev.includes("@{"))
    return "Use a single revision; ranges and reflog selectors are not supported";
  return null;
}

/** Decode a C-style quoted path from a diff header ("a\tb", octal bytes). */
export function unquoteGitPath(raw: string): string {
  if (!(raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2))
    return raw;
  const bytes: number[] = [];
  const s = raw.slice(1, -1);
  const esc: Record<string, number> = {
    n: 10,
    t: 9,
    r: 13,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
    '"': 34,
    "\\": 92,
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "\\") {
      bytes.push(...Buffer.from(s[i], "utf8"));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += oct[0].length;
    } else if (s[i + 1] in esc) bytes.push(esc[s[++i]]);
    else bytes.push(92);
  }
  return Buffer.from(bytes).toString("utf8");
}

export type DiffMeta = {
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "mode";
  binary: boolean;
  submodule: boolean;
  oldMode?: string;
  newMode?: string;
  renameFrom?: string;
  renameTo?: string;
  similarity?: number;
  /** True when the diff has no text hunks (rename-only, mode-only, binary, empty). */
  noHunks: boolean;
};

/** Read git's extended header lines (everything before the first hunk). */
export function parseDiffMeta(diff: string): DiffMeta {
  const meta: DiffMeta = {
    kind: "modified",
    binary: false,
    submodule: false,
    noHunks: !/^@@ /m.test(diff),
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) break;
    let m: RegExpExecArray | null;
    if ((m = /^old mode (\d+)/.exec(line))) meta.oldMode = m[1];
    else if ((m = /^new mode (\d+)/.exec(line))) meta.newMode = m[1];
    else if ((m = /^new file mode (\d+)/.exec(line))) {
      meta.kind = "added";
      meta.newMode = m[1];
    } else if ((m = /^deleted file mode (\d+)/.exec(line))) {
      meta.kind = "deleted";
      meta.oldMode = m[1];
    } else if ((m = /^(rename|copy) from (.*)$/.exec(line))) {
      meta.kind = m[1] === "rename" ? "renamed" : "copied";
      meta.renameFrom = unquoteGitPath(m[2]);
    } else if ((m = /^(?:rename|copy) to (.*)$/.exec(line)))
      meta.renameTo = unquoteGitPath(m[1]);
    else if ((m = /^similarity index (\d+)%/.exec(line)))
      meta.similarity = Number(m[1]);
    else if (
      /^Binary files .* differ$/.test(line) ||
      line === "GIT binary patch"
    )
      meta.binary = true;
  }
  if (/^[-+ ]?Subproject commit /m.test(diff)) meta.submodule = true;
  if (
    meta.kind === "modified" &&
    meta.oldMode &&
    meta.newMode &&
    meta.oldMode !== meta.newMode
  )
    meta.kind = "mode";
  return meta;
}

/** Parse `git diff --name-status -z -M` output into change entries. */
export function parseNameStatus(raw: string) {
  const r = raw.split("\0");
  const out: {
    status: string;
    path: string;
    from?: string;
    similarity?: number;
  }[] = [];
  for (let i = 0; i < r.length; i++) {
    const code = r[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const from = r[++i],
        path = r[++i];
      if (path === undefined) break;
      out.push({
        status: letter + " ",
        path,
        from,
        similarity: Number(code.slice(1)) || undefined,
      });
    } else {
      const path = r[++i];
      if (path === undefined) break;
      out.push({ status: letter + " ", path });
    }
  }
  return out;
}

export type Capped = { text: string; truncated: boolean; reason?: string };
/** Bound a diff by lines and line length; `byteCapped` means the producer stopped early. */
export function capDiff(text: string, byteCapped: boolean): Capped {
  let lines = text.split("\n");
  let reason: string | undefined;
  if (byteCapped) {
    lines.pop(); // possibly partial final line
    reason = `Diff exceeds ${Math.round(DIFF_MAX_BYTES / 1000)} KB`;
  }
  if (lines.length > DIFF_MAX_LINES) {
    lines = lines.slice(0, DIFF_MAX_LINES);
    reason = `Diff exceeds ${DIFF_MAX_LINES} lines`;
  }
  let longLines = false;
  lines = lines.map((l) => {
    if (l.length <= DIFF_MAX_LINE_CHARS) return l;
    longLines = true;
    return l.slice(0, DIFF_MAX_LINE_CHARS) + " …[line truncated]";
  });
  if (longLines && !reason)
    reason = `Some lines exceed ${DIFF_MAX_LINE_CHARS} characters and were shortened`;
  const out = lines.join("\n");
  return {
    text: byteCapped || reason ? out + (out.endsWith("\n") ? "" : "\n") : out,
    truncated: !!reason,
    reason,
  };
}
