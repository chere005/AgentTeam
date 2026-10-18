import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { WorkspaceService } from "./workspaces.ts";
import { assert, type Agent, type Message } from "./model.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export type DiffLine = {
  hunk: string;
  side: "old" | "new";
  line: number;
  text: string;
};
/** Parse a unified diff into anchorable lines, each tagged with a hash of its hunk body. */
export function parseDiffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  const rows = diff.split("\n");
  let i = 0;
  while (i < rows.length) {
    const h = HUNK.exec(rows[i]);
    if (!h) {
      i++;
      continue;
    }
    let old = +h[1],
      next = +h[2];
    const body: string[] = [];
    let j = i + 1;
    while (
      j < rows.length &&
      !HUNK.test(rows[j]) &&
      !/^diff --git /.test(rows[j])
    )
      body.push(rows[j++]);
    const hunk = sha(body.join("\n"));
    for (const r of body) {
      if (r.startsWith("+"))
        out.push({ hunk, side: "new", line: next++, text: r });
      else if (r.startsWith("-"))
        out.push({ hunk, side: "old", line: old++, text: r });
      else if (r.startsWith(" ")) {
        out.push({ hunk, side: "new", line: next++, text: r });
        out.push({ hunk, side: "old", line: old++, text: r });
      }
    }
    i = j;
  }
  return out;
}

export type ReviewComment = {
  id: string;
  agentId: string;
  workspace: string;
  path: string;
  staged: boolean;
  /** Branch-compare scope identity ("" for staged/unstaged); absent on older records. */
  compare?: string;
  side: "old" | "new";
  line: number;
  lineText: string;
  hunkHash: string;
  diffHash: string;
  targetId: string;
  text: string;
  resolved: boolean;
  sessionId: string;
  messageId: string;
  delivery: "queued" | "scheduled";
  createdAt: string;
};
type FileMark = {
  id: string;
  agentId: string;
  workspace: string;
  staged: boolean;
  compare?: string;
  path: string;
  diffHash: string;
  at: string;
};
type Decision = {
  id: string;
  agentId: string;
  workspace: string;
  staged: boolean;
  compare?: string;
  decision: "changes_requested" | "approved";
  note: string;
  snapshot: string;
  at: string;
};

const scope = z.object({
  workspace: z.string(),
  staged: z.boolean().default(false),
  /** Compare `head` (default HEAD) with `base`, or with merge-base(base, head) when mergeBase. */
  base: z.string().max(200).optional(),
  head: z.string().max(200).optional(),
  mergeBase: z.boolean().default(true),
});
type Scope = z.infer<typeof scope>;
/** Stable identity for a compare scope; empty for the staged/unstaged views. */
export function compareId(s: {
  base?: string;
  head?: string;
  mergeBase?: boolean;
}) {
  return s.base
    ? `${s.base.trim()}\0${s.head?.trim() || "HEAD"}\0${s.mergeBase === false ? "direct" : "merge-base"}`
    : "";
}
const scopeLabel = (s: Scope) =>
  s.base
    ? `compare ${s.head?.trim() || "HEAD"} against ${s.base.trim()}${s.mergeBase === false ? " (direct)" : " (merge base)"}`
    : s.staged
      ? "staged"
      : "unstaged";
const pathField = z.string().min(1).max(4096);

/** Lexical path check; the workspace service additionally verifies the path is a current change. */
function safePath(path: string) {
  assert(
    !isAbsolute(path) &&
      !path.includes("\0") &&
      !/^[A-Za-z]:/.test(path) &&
      !path.split(/[\\/]/).includes(".."),
    "path_escape",
    "Path escapes the attached workspace",
    403,
  );
  assert(
    !path.split(/[\\/]/).includes(".git"),
    "git_internal",
    "Direct access to Git internals is not supported",
    403,
  );
  return path;
}

export class ReviewService {
  team: TeamService;
  ws: WorkspaceService;
  constructor(team: TeamService, ws: WorkspaceService) {
    this.team = team;
    this.ws = ws;
  }
  private get store() {
    return this.team.store;
  }
  private key(
    agentId: string,
    workspace: string,
    staged: boolean,
    compare = "",
  ) {
    return sha(
      `${agentId}\0${workspace}\0${staged}${compare ? "\0" + compare : ""}`,
    ).slice(0, 24);
  }
  /** Current per-file diffs for a scope (read-only Git; never mutates). */
  private async snapshot(agentId: string, s: Scope) {
    const base = await this.ws.review(agentId, s);
    const files = new Map<string, { diff: string; hash: string }>();
    for (const f of base.files) {
      const r = await this.ws.review(agentId, { ...s, path: f.path });
      files.set(f.path, { diff: r.diff, hash: sha(r.diff) });
    }
    const overall = sha(
      [...files]
        .map(([p, v]) => `${p}\0${v.hash}`)
        .sort()
        .join("\n"),
    );
    return { files, overall };
  }
  private status(c: ReviewComment) {
    const m = this.store
      .list<Message>("message")
      .find((x) => x.id === c.messageId);
    return m && m.status !== "queued" ? "sent" : c.delivery;
  }
  async state(agentId: string, input: unknown) {
    const s = scope.strict().parse(input);
    this.store.get<Agent>("agent", agentId);
    const snap = await this.snapshot(agentId, s);
    const lines = new Map<string, DiffLine[]>();
    for (const [p, v] of snap.files) lines.set(p, parseDiffLines(v.diff));
    const comments = this.store
      .list<ReviewComment>("review-comment")
      .filter(
        (c) =>
          c.agentId === agentId &&
          c.workspace === s.workspace &&
          c.staged === s.staged &&
          (c.compare ?? "") === compareId(s),
      )
      .map((c) => ({
        ...c,
        delivery: this.status(c),
        outdated: !(lines.get(c.path) ?? []).some(
          (l) =>
            l.hunk === c.hunkHash &&
            l.side === c.side &&
            l.line === c.line &&
            l.text === c.lineText,
        ),
      }));
    const marks = this.store
      .list<FileMark>("review-file")
      .filter(
        (m) =>
          m.agentId === agentId &&
          m.workspace === s.workspace &&
          m.staged === s.staged &&
          (m.compare ?? "") === compareId(s),
      );
    const reviewed: Record<string, boolean> = {};
    for (const [p, v] of snap.files)
      reviewed[p] = marks.some((m) => m.path === p && m.diffHash === v.hash);
    const decision =
      this.store
        .list<Decision>("review-decision")
        .find(
          (d) =>
            d.id === this.key(agentId, s.workspace, s.staged, compareId(s)),
        ) ?? null;
    const active = comments.filter((c) => !c.outdated);
    return {
      comments,
      reviewed,
      decision: decision && {
        ...decision,
        stale: decision.snapshot !== snap.overall,
      },
      summary: {
        files: snap.files.size,
        reviewedFiles: Object.values(reviewed).filter(Boolean).length,
        unresolved: active.filter((c) => !c.resolved).length,
        resolved: active.filter((c) => c.resolved).length,
        outdated: comments.filter((c) => c.outdated).length,
      },
      snapshot: snap.overall,
    };
  }
  async comment(agentId: string, input: unknown) {
    const d = scope
      .extend({
        path: pathField,
        side: z.enum(["old", "new"]),
        line: z.number().int().min(0),
        targetId: z.string(),
        text: z.string().trim().min(1).max(10000),
        requestId: z.string().uuid(),
        /** Hash of the diff the user commented on; a mismatch means the diff changed (409). */
        diffHash: z.string().optional(),
      })
      .strict()
      .parse(input);
    const existing = this.store
      .list<ReviewComment>("review-comment")
      .find((c) => c.id === d.requestId);
    if (existing) return { ...existing, delivery: this.status(existing) };
    safePath(d.path);
    this.store.get<Agent>("agent", d.targetId);
    const r = await this.ws.review(agentId, {
      workspace: d.workspace,
      staged: d.staged,
      base: d.base,
      head: d.head,
      mergeBase: d.mergeBase,
      path: d.path,
    }); // rejects paths that are not current changes
    assert(
      !d.diffHash || d.diffHash === sha(r.diff),
      "review_changed",
      "This diff changed. Refresh and review it before sending feedback",
      409,
    );
    const anchor = parseDiffLines(r.diff).find(
      (l) => l.side === d.side && l.line === d.line,
    );
    assert(anchor, "invalid_line", "Choose a line from this diff", 400);
    return this.store.transaction(() => {
      const session = this.team.session(d.targetId);
      const message = this.team.message(session.id, {
        text: `Code review feedback\nWorkspace: ${d.workspace}\nFile: ${d.path} (${scopeLabel(d)}, ${d.side} line ${d.line})\nDiff snapshot: ${sha(r.diff)}\n\n${d.text}\n\nQuoted line:\n${anchor.text}\n\nInspect the current file before applying changes; the quoted line is a snapshot.`,
      });
      const comment: ReviewComment = {
        id: d.requestId,
        agentId,
        workspace: d.workspace,
        path: d.path,
        staged: d.staged,
        compare: compareId(d),
        side: d.side,
        line: d.line,
        lineText: anchor.text,
        hunkHash: anchor.hunk,
        diffHash: sha(r.diff),
        targetId: d.targetId,
        text: d.text,
        resolved: false,
        sessionId: session.id,
        messageId: message.id,
        delivery: "queued",
        createdAt: new Date().toISOString(),
      };
      this.store.put("review-comment", comment);
      this.store.emit("review.comment_created", agentId, { id: comment.id });
      return comment;
    });
  }
  markScheduled(commentId: string) {
    const c = this.store.get<ReviewComment>("review-comment", commentId);
    this.store.put("review-comment", { ...c, delivery: "scheduled" });
  }
  resolve(agentId: string, input: unknown) {
    const d = z
      .object({ id: z.string(), resolved: z.boolean() })
      .strict()
      .parse(input);
    const c = this.store.get<ReviewComment>("review-comment", d.id);
    assert(c.agentId === agentId, "not_found", "Comment not found", 404);
    this.store.transaction(() => {
      this.store.put("review-comment", { ...c, resolved: d.resolved });
      this.store.emit("review.comment_resolved", agentId, d);
    });
    return { ...c, resolved: d.resolved };
  }
  async setReviewed(agentId: string, input: unknown) {
    const d = scope
      .extend({ path: pathField, reviewed: z.boolean() })
      .strict()
      .parse(input);
    safePath(d.path);
    const r = await this.ws.review(agentId, {
      workspace: d.workspace,
      staged: d.staged,
      base: d.base,
      head: d.head,
      mergeBase: d.mergeBase,
      path: d.path,
    });
    const id = sha(
      `${agentId}\0${d.workspace}\0${d.staged}\0${d.path}${compareId(d) ? "\0" + compareId(d) : ""}`,
    ).slice(0, 24);
    this.store.transaction(() => {
      if (d.reviewed)
        this.store.put<FileMark>("review-file", {
          id,
          agentId,
          workspace: d.workspace,
          staged: d.staged,
          compare: compareId(d),
          path: d.path,
          diffHash: sha(r.diff),
          at: new Date().toISOString(),
        });
      else this.store.remove("review-file", id);
    });
    return { path: d.path, reviewed: d.reviewed };
  }
  /**
   * Record the overall decision. Never stages, commits, merges or otherwise runs Git mutations.
   * Request changes also sends a summary to the recipient through the normal message path.
   */
  async decide(agentId: string, input: unknown) {
    const d = scope
      .extend({
        decision: z.enum(["changes_requested", "approved"]),
        note: z.string().max(10000).default(""),
        targetId: z.string().optional(),
      })
      .strict()
      .parse(input);
    const st = await this.state(agentId, {
      workspace: d.workspace,
      staged: d.staged,
      base: d.base,
      head: d.head,
      mergeBase: d.mergeBase,
    });
    const open = st.comments.filter((c) => !c.outdated && !c.resolved);
    let messageId: string | undefined, sessionId: string | undefined;
    if (d.decision === "approved") {
      assert(
        !open.length,
        "unresolved_comments",
        "Resolve or remove unresolved comments before approving",
        409,
      );
    } else {
      assert(d.targetId, "recipient_required", "Choose a recipient agent", 400);
      this.store.get<Agent>("agent", d.targetId);
    }
    const decision: Decision = {
      id: this.key(agentId, d.workspace, d.staged, compareId(d)),
      agentId,
      workspace: d.workspace,
      staged: d.staged,
      compare: compareId(d),
      decision: d.decision,
      note: d.note,
      snapshot: st.snapshot,
      at: new Date().toISOString(),
    };
    this.store.transaction(() => {
      if (d.decision === "changes_requested") {
        const session = this.team.session(d.targetId!);
        const message = this.team.message(session.id, {
          text: `Review: changes requested\nWorkspace: ${d.workspace} (${scopeLabel(d)})\n\n${d.note || "(no summary)"}\n\nUnresolved comments: ${open.length}\n${open.map((c) => `- ${c.path} ${c.side} line ${c.line}: ${c.text}`).join("\n")}`,
        });
        messageId = message.id;
        sessionId = session.id;
      }
      this.store.put("review-decision", decision);
      this.store.emit("review.decision", agentId, { decision: d.decision });
    });
    return { ...decision, messageId, sessionId };
  }
}
