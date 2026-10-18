/** Row models for unified and side-by-side diff rendering; anchors match src/reviews.ts parseDiffLines. */
export type Kind = "meta" | "hunk" | "added" | "removed" | "context";
export type Row = {
  /** Raw diff line including its +/-/space prefix (used as the comment quote). */
  line: string;
  kind: Kind;
  old: number | null;
  next: number | null;
  hunk: number; // index of the enclosing hunk, -1 before the first hunk
};
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffRows(diff: string): Row[] {
  let old = 0,
    next = 0,
    hunk = -1;
  return diff
    .split("\n")
    .filter((line, i, all) => i < all.length - 1 || line !== "")
    .map((line) => {
      const h = HUNK.exec(line);
      if (h) {
        old = Number(h[1]);
        next = Number(h[2]);
        hunk++;
        return { line, kind: "hunk" as const, old: null, next: null, hunk };
      }
      if (hunk < 0 || line.startsWith("\\"))
        return { line, kind: "meta" as const, old: null, next: null, hunk };
      if (line.startsWith("+"))
        return { line, kind: "added" as const, old: null, next: next++, hunk };
      if (line.startsWith("-"))
        return { line, kind: "removed" as const, old: old++, next: null, hunk };
      return { line, kind: "context" as const, old: old++, next: next++, hunk };
    });
}

export type Cell = { row: Row; side: "old" | "new"; no: number } | null;
export type SplitRow =
  | { type: "full"; row: Row }
  | { type: "pair"; left: Cell; right: Cell; hunk: number };

/** Pair each run of removed lines with the added run that follows it. */
export function splitRows(rows: Row[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.kind === "meta" || r.kind === "hunk") {
      out.push({ type: "full", row: r });
      i++;
    } else if (r.kind === "context") {
      out.push({
        type: "pair",
        hunk: r.hunk,
        left: { row: r, side: "old", no: r.old! },
        right: { row: r, side: "new", no: r.next! },
      });
      i++;
    } else {
      const del: Row[] = [],
        add: Row[] = [];
      while (i < rows.length && rows[i].kind === "removed") del.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "added") add.push(rows[i++]);
      for (let k = 0; k < Math.max(del.length, add.length); k++)
        out.push({
          type: "pair",
          hunk: (del[k] ?? add[k]).hunk,
          left: del[k] ? { row: del[k], side: "old", no: del[k].old! } : null,
          right: add[k] ? { row: add[k], side: "new", no: add[k].next! } : null,
        });
    }
  }
  return out;
}
