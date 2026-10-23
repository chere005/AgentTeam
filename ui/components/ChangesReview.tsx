import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, type Agent } from "../api";
import { ReviewComments, type ReviewScope } from "./ReviewComments";
import { diffRows, splitRows, type Cell, type Row } from "./diffRows";
import { highlightLine, languageFor } from "./highlight";
import { agentSelectorLabel } from "../agent-identity";

type Change = { path: string; status: string; from?: string };
type Meta = {
  kind: "modified" | "added" | "deleted" | "renamed" | "copied" | "mode";
  binary: boolean;
  submodule: boolean;
  oldMode?: string;
  newMode?: string;
  renameFrom?: string;
  renameTo?: string;
  similarity?: number;
  noHunks: boolean;
};
type Review = {
  source?: "git" | "folder";
  diffHash: string;
  branch: string;
  baselineAt?: string;
  files: Change[];
  filesTruncated?: boolean;
  diff: string;
  truncated?: boolean;
  truncatedReason?: string;
  unreadable?: string;
  meta: Meta | null;
  refs?: string[];
  defaultBase?: string;
  compare: {
    base: string;
    head: string;
    mergeBase: boolean;
    baseSha: string;
    headSha: string;
    mergeBaseSha: string | null;
  } | null;
  attribution?: { kind: "worktree" | "shared"; note: string };
};
type Mode = "unstaged" | "staged" | "compare";
type Compare = { base: string; head: string; mergeBase: boolean };
type CommentTarget = {
  path: string;
  scope: ReviewScope;
  diffHash: string;
  line: string;
  side: "old" | "new";
  lineNo: number;
  requestId: string;
};

const NARROW = 640;
const STATUS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type changed",
  U: "conflict",
  "?": "untracked",
};
const short = (sha?: string | null) => (sha ?? "").slice(0, 8);

function Code({ text, lang }: { text: string; lang: string | null }) {
  return (
    <code>
      {highlightLine(text, lang).map((t, i) =>
        t.cls ? (
          <span key={i} className={`tok-${t.cls}`}>
            {t.text}
          </span>
        ) : (
          <Fragment key={i}>{t.text}</Fragment>
        ),
      )}
    </code>
  );
}

function MetaNotes({ review, path }: { review: Review; path: string }) {
  const m = review.meta;
  const notes: string[] = [];
  if (m?.kind === "renamed" || m?.kind === "copied")
    notes.push(
      `${m.kind === "renamed" ? "Renamed" : "Copied"} from ${m.renameFrom ?? "?"} to ${m.renameTo ?? path}${m.similarity !== undefined ? ` (${m.similarity}% similar)` : ""}.`,
    );
  if (m?.oldMode && m.newMode && m.oldMode !== m.newMode)
    notes.push(`File mode changed ${m.oldMode} → ${m.newMode}.`);
  if (m?.kind === "added" && !m.noHunks) notes.push("New file.");
  if (m?.kind === "added" && m.noHunks && !m.binary)
    notes.push("New empty file.");
  if (m?.kind === "deleted") notes.push("File deleted.");
  if (m?.binary)
    notes.push("Binary file: contents are not shown, only that it changed.");
  if (m?.submodule) notes.push("Submodule pointer changed.");
  if (review.unreadable) notes.push(review.unreadable);
  if (!notes.length && !review.diff)
    notes.push("No text changes to show for this file.");
  return (
    <ul className="review-meta" aria-label="File change details">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}

export function ChangesReview({
  agentId,
  workspace,
  agents,
  onOpenConversation,
}: {
  agentId: string;
  workspace: string;
  agents: Agent[];
  onOpenConversation?: (agentId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("unstaged"),
    [path, setPath] = useState("");
  const [cmp, setCmp] = useState<Compare | null>(null),
    [form, setForm] = useState<Compare>({
      base: "",
      head: "",
      mergeBase: true,
    });
  const [refs, setRefs] = useState<string[]>([]);
  const [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState("");
  const [revision, refresh] = useState(0),
    [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<"split" | "unified">("split"),
    [width, setWidth] = useState(1000),
    [hunk, setHunk] = useState(0);
  const [comment, setComment] = useState<CommentTarget | null>(null);
  const [text, setText] = useState(""),
    [recipient, setRecipient] = useState(agentId);
  const [sending, setSending] = useState(false),
    [sent, setSent] = useState(""),
    [sentTo, setSentTo] = useState("");
  const [baselineNotice, setBaselineNotice] = useState("");
  const root = useRef<HTMLElement>(null),
    scroller = useRef<HTMLDivElement>(null);

  const scope: ReviewScope = useMemo(
    () =>
      mode === "compare" && cmp
        ? { staged: false, ...cmp }
        : { staged: mode === "staged" },
    [mode, cmp],
  );
  const scopeKey = JSON.stringify(scope);
  const narrow = width < NARROW;
  const split = view === "split" && !narrow && review?.source !== "folder";

  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (mode === "compare" && !cmp) {
      setReview(null);
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    setError("");
    void api(`/agents/${agentId}/git/review`, "POST", {
      workspace,
      ...scope,
      ...(path ? { path } : {}),
    })
      .then((result: Review) => {
        if (!current) return;
        setReview(result);
        if (result.refs) setRefs(result.refs);
        if (!path && result.files.length) setPath(result.files[0].path);
      })
      .catch((e) => {
        if (!current) return;
        setReview(null);
        setError(String(e.message ?? e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agentId, workspace, scopeKey, path, revision]);

  useEffect(() => setHunk(0), [path, scopeKey]);

  const rows = useMemo(() => diffRows(review?.diff ?? ""), [review?.diff]);
  const pairs = useMemo(() => splitRows(rows), [rows]);
  const hunkCount = rows.filter((r) => r.kind === "hunk").length;
  const added = rows.filter((r) => r.kind === "added").length;
  const removed = rows.filter((r) => r.kind === "removed").length;
  const lang = languageFor(path);
  const visibleFiles = (review?.files ?? []).filter((f) =>
    f.path.toLowerCase().includes(filter.toLowerCase()),
  );

  function go(next: number) {
    const n = Math.max(0, Math.min(hunkCount - 1, next));
    setHunk(n);
    scroller.current
      ?.querySelector(`[data-hunk="${n}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }
  function goFile(delta: number) {
    const i = visibleFiles.findIndex((f) => f.path === path);
    const f =
      visibleFiles[Math.max(0, Math.min(visibleFiles.length - 1, i + delta))];
    if (f && f.path !== path) setPath(f.path);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
      t.isContentEditable
    )
      return;
    const actions: Record<string, () => void> = {
      "]": () => goFile(1),
      "[": () => goFile(-1),
      n: () => go(hunk + 1),
      p: () => go(hunk - 1),
    };
    if (actions[e.key]) {
      e.preventDefault();
      actions[e.key]();
    }
  }
  function switchMode(next: Mode) {
    setPath("");
    setMode(next);
    setComment(null);
    if (next === "compare" && !form.base && review?.defaultBase)
      setForm((f) => ({ ...f, base: review.defaultBase! }));
  }
  function startComment(row: Row, side: "old" | "new", lineNo: number) {
    if (!review) return;
    setSent("");
    setComment({
      path,
      scope,
      diffHash: review.diffHash,
      line: row.line,
      side,
      lineNo,
      requestId: crypto.randomUUID(),
    });
  }
  async function sendFeedback() {
    if (!comment) return;
    setSending(true);
    setError("");
    try {
      const result = await api(`/agents/${agentId}/reviews/comment`, "POST", {
        workspace,
        path: comment.path,
        ...comment.scope,
        side: comment.side,
        line: comment.lineNo,
        diffHash: comment.diffHash,
        requestId: comment.requestId,
        targetId: recipient,
        text,
      });
      setSent(
        `Feedback ${result.execution} for ${agents.find((a) => a.id === recipient)?.name}. It is available in their conversation.`,
      );
      setSentTo(recipient);
      setComment(null);
      setText("");
      refresh((n) => n + 1);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSending(false);
    }
  }

  const commentButton = (c: Cell) =>
    c &&
    review?.source !== "folder" && (
      <button
        className="diff-comment"
        disabled={!!comment}
        aria-label={`Comment on ${c.side} line ${c.no}`}
        onClick={() => startComment(c.row, c.side, c.no)}
      >
        +
      </button>
    );
  const cellClass = (c: Cell) => (c ? `diff-${c.row.kind}` : "diff-empty");
  const body = (line: string) => line.slice(1);

  return (
    <section
      className="changes-review"
      aria-label="Code review"
      ref={root}
      onKeyDown={onKeyDown}
    >
      <div className="row between">
        <h3>
          {review?.source === "folder" ? "Pending changes" : "Review changes"}
        </h3>
        <button
          onClick={() => {
            setPath("");
            refresh(revision + 1);
          }}
        >
          Refresh
        </button>
      </div>
      <p className="hint">
        {review?.source === "folder" ? (
          <>
            Folder snapshot · no Git required · {workspace}
            {review.baselineAt &&
              ` · tracking edits since ${new Date(review.baselineAt).toLocaleString()}`}
          </>
        ) : (
          <>
            {review?.branch} · {workspace}
            <br />
            {review?.attribution?.note ??
              "Changes in this folder may come from any agent or editor."}
          </>
        )}
      </p>
      {review?.source === "folder" && (
        <div className="row wrap folder-diff-baseline">
          <button
            onClick={() => {
              setError("");
              void api(`/agents/${agentId}/files/changes/reset`, "POST", {
                workspace,
              })
                .then(() => {
                  setBaselineNotice("Current files are now the baseline.");
                  setPath("");
                  refresh((value) => value + 1);
                })
                .catch((reason) => setError(String(reason?.message ?? reason)));
            }}
          >
            Set current files as baseline
          </button>
          {baselineNotice && <span role="status">{baselineNotice}</span>}
        </div>
      )}
      {review?.source !== "folder" && (
        <div className="tabs">
          {(
            [
              ["unstaged", "Unstaged"],
              ["staged", "Staged"],
              ["compare", "Compare branches"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              onClick={() => switchMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {review?.source !== "folder" && mode === "compare" && (
        <form
          className="review-compare"
          aria-label="Branch comparison"
          onSubmit={(e) => {
            e.preventDefault();
            setComment(null);
            setPath("");
            setCmp({
              base: form.base.trim(),
              head: form.head.trim(),
              mergeBase: form.mergeBase,
            });
          }}
        >
          <label>
            Base branch or commit
            <input
              list="review-refs"
              value={form.base}
              onChange={(e) => setForm({ ...form, base: e.target.value })}
              placeholder="main"
            />
          </label>
          <label>
            Head (default HEAD)
            <input
              list="review-refs"
              value={form.head}
              onChange={(e) => setForm({ ...form, head: e.target.value })}
              placeholder={review?.branch ?? "HEAD"}
            />
          </label>
          <datalist id="review-refs">
            {refs.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
          <label className="inline">
            <input
              type="checkbox"
              checked={form.mergeBase}
              onChange={(e) =>
                setForm({ ...form, mergeBase: e.target.checked })
              }
            />{" "}
            Compare from the merge base (only changes made on the head)
          </label>
          <button type="submit" disabled={!form.base.trim()}>
            Compare
          </button>
        </form>
      )}
      {review?.compare && mode === "compare" && (
        <p className="hint" role="status">
          {review.compare.head} ({short(review.compare.headSha)}) against{" "}
          {review.compare.mergeBase
            ? `merge base ${short(review.compare.mergeBaseSha)} with ${review.compare.base}`
            : `${review.compare.base} (${short(review.compare.baseSha)}), direct`}
          . Committed changes only; uncommitted edits are not included.
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {sent && (
        <p role="status">
          {sent}{" "}
          {onOpenConversation && sentTo && (
            <button onClick={() => onOpenConversation(sentTo)}>
              Open conversation
            </button>
          )}
        </p>
      )}
      {review?.source !== "folder" && (mode !== "compare" || cmp) && !error && (
        <ReviewComments
          agentId={agentId}
          workspace={workspace}
          scope={scope}
          path={path}
          agents={agents}
          revision={revision}
          onOpenConversation={onOpenConversation}
        />
      )}
      {comment && (
        <section className="review-comment">
          <strong>
            {comment.path} ·{" "}
            {comment.scope.base
              ? `${comment.scope.head || "HEAD"} vs ${comment.scope.base}`
              : comment.scope.staged
                ? "staged"
                : "unstaged"}{" "}
            · {comment.side} line {comment.lineNo}
          </strong>
          <pre>{comment.line}</pre>
          <label>
            Feedback recipient
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {agentSelectorLabel(a)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Review feedback
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Describe what should change…"
            />
          </label>
          <button
            disabled={sending || !text.trim()}
            onClick={() => void sendFeedback()}
          >
            {sending ? "Sending…" : "Send feedback to agent"}
          </button>
          <button
            disabled={sending}
            onClick={() => {
              setComment(null);
              setText("");
            }}
          >
            Cancel feedback
          </button>
        </section>
      )}
      {loading && <p role="status">Loading changes…</p>}
      {review?.source !== "folder" && mode === "compare" && !cmp && (
        <p className="hint">Choose a base and press Compare.</p>
      )}
      {review && (
        <>
          <input
            aria-label="Filter changed files"
            placeholder="Filter changed files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {review.filesTruncated && (
            <p className="notice">
              Too many changed files: showing the first {review.files.length}.
              Narrow the workspace folder to see the rest.
            </p>
          )}
          <div className="review-layout">
            <nav className="review-files" aria-label="Changed files">
              {visibleFiles.map((file) => (
                <button
                  key={file.path}
                  className={path === file.path ? "active" : ""}
                  aria-current={path === file.path ? "true" : undefined}
                  title={STATUS[file.status.trim()[0] ?? ""] ?? file.status}
                  onClick={() => setPath(file.path)}
                >
                  <code>{file.status.trim()}</code>
                  <span>
                    {file.path}
                    {file.from && <small> ← {file.from}</small>}
                  </span>
                </button>
              ))}
              {!review.files.length && (
                <p className="hint">
                  {review.source === "folder"
                    ? "No pending changes."
                    : `No ${mode === "compare" ? "committed differences between these revisions" : `${mode} changes`}.`}
                </p>
              )}
            </nav>
            {path && review.files.length > 0 && (
              <div className="review-diff">
                <div className="row between">
                  <strong>{path}</strong>
                  <span>
                    <span className="diff-count-add">+{added}</span> /{" "}
                    <span className="diff-count-remove">−{removed}</span>
                  </span>
                </div>
                <div
                  className="row review-toolbar"
                  role="toolbar"
                  aria-label="Diff navigation"
                >
                  <button onClick={() => goFile(-1)} title="Previous file ([)">
                    Previous file
                  </button>
                  <button onClick={() => goFile(1)} title="Next file (])">
                    Next file
                  </button>
                  <button
                    disabled={!hunkCount}
                    onClick={() => go(hunk - 1)}
                    title="Previous hunk (p)"
                  >
                    Previous hunk
                  </button>
                  <button
                    disabled={!hunkCount}
                    onClick={() => go(hunk + 1)}
                    title="Next hunk (n)"
                  >
                    Next hunk
                  </button>
                  <span className="hint" data-testid="hunk-position">
                    {hunkCount
                      ? `Hunk ${hunk + 1} of ${hunkCount}`
                      : "No hunks"}
                  </span>
                  <span className="tabs" role="group" aria-label="Diff layout">
                    <button
                      className={split ? "active" : ""}
                      disabled={narrow}
                      title={
                        narrow
                          ? "Side by side needs a wider pane"
                          : "Two columns"
                      }
                      aria-pressed={split}
                      onClick={() => setView("split")}
                    >
                      Side by side
                    </button>
                    <button
                      className={!split ? "active" : ""}
                      aria-pressed={!split}
                      onClick={() => setView("unified")}
                    >
                      Unified
                    </button>
                  </span>
                </div>
                <p className="hint">
                  Keys: ] next file, [ previous file, n next hunk, p previous
                  hunk.
                </p>
                {review.truncated && (
                  <p className="notice" role="note">
                    Truncated: {review.truncatedReason ?? "output was bounded"}.
                    Open the file in an editor or use Git for the full diff.
                  </p>
                )}
                <MetaNotes review={review} path={path} />
                {rows.length > 0 && (
                  <div
                    className="diff-scroll"
                    ref={scroller}
                    tabIndex={0}
                    aria-label="Diff content"
                  >
                    {split ? (
                      <table
                        className="diff-table diff-split"
                        aria-label="Side-by-side diff"
                      >
                        <colgroup>
                          <col className="no" />
                          <col />
                          <col className="btn" />
                          <col className="no" />
                          <col />
                          <col className="btn" />
                        </colgroup>
                        <tbody>
                          {pairs.map((p, i) =>
                            p.type === "full" ? (
                              <tr
                                key={i}
                                className={`diff-${p.row.kind}${p.row.kind === "hunk" && p.row.hunk === hunk ? " current-hunk" : ""}`}
                                data-hunk={
                                  p.row.kind === "hunk" ? p.row.hunk : undefined
                                }
                              >
                                <td colSpan={6}>
                                  <code>{p.row.line}</code>
                                </td>
                              </tr>
                            ) : (
                              <tr key={i}>
                                <td className={cellClass(p.left)}>
                                  {p.left?.no}
                                </td>
                                <td className={cellClass(p.left)}>
                                  {p.left && (
                                    <Code
                                      text={body(p.left.row.line)}
                                      lang={lang}
                                    />
                                  )}
                                </td>
                                <td className={cellClass(p.left)}>
                                  {commentButton(p.left)}
                                </td>
                                <td className={cellClass(p.right)}>
                                  {p.right?.no}
                                </td>
                                <td className={cellClass(p.right)}>
                                  {p.right && (
                                    <Code
                                      text={body(p.right.row.line)}
                                      lang={lang}
                                    />
                                  )}
                                </td>
                                <td className={cellClass(p.right)}>
                                  {commentButton(p.right)}
                                </td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <table className="diff-table" aria-label="Unified diff">
                        <thead>
                          <tr>
                            <th>Old</th>
                            <th>New</th>
                            <th>Change</th>
                            <th>Review</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr
                              key={i}
                              className={`diff-${r.kind}${r.kind === "hunk" && r.hunk === hunk ? " current-hunk" : ""}`}
                              data-hunk={r.kind === "hunk" ? r.hunk : undefined}
                            >
                              <td>{r.old ?? ""}</td>
                              <td>{r.next ?? ""}</td>
                              <td>
                                {r.kind === "meta" || r.kind === "hunk" ? (
                                  <code>{r.line}</code>
                                ) : (
                                  <>
                                    <code className="diff-prefix">
                                      {r.line[0]}
                                    </code>
                                    <Code text={body(r.line)} lang={lang} />
                                  </>
                                )}
                              </td>
                              <td>
                                {r.kind !== "meta" && r.kind !== "hunk" && (
                                  <button
                                    disabled={!!comment}
                                    aria-label={`Comment on ${r.kind === "removed" ? "old" : "new"} line ${r.kind === "removed" ? r.old : r.next}`}
                                    onClick={() =>
                                      startComment(
                                        r,
                                        r.kind === "removed" ? "old" : "new",
                                        (r.kind === "removed"
                                          ? r.old
                                          : r.next) as number,
                                      )
                                    }
                                  >
                                    +
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
