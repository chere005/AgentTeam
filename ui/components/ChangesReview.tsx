import { useEffect, useState } from "react";
import { api, type Agent } from "../api";

type Change = { path: string; status: string; from?: string };
type Review = {
  diffHash: string;
  branch: string;
  files: Change[];
  diff: string;
  truncated?: boolean;
};

function diffRows(diff: string) {
  let old = 0,
    next = 0,
    inHunk = false;
  return diff
    .split("\n")
    .filter((line, i, all) => i < all.length - 1 || line !== "")
    .map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        old = Number(hunk[1]);
        next = Number(hunk[2]);
        inHunk = true;
      }
      const kind =
        !inHunk || hunk || line.startsWith("\\")
          ? "meta"
          : line.startsWith("+")
            ? "added"
            : line.startsWith("-")
              ? "removed"
              : "context";
      return {
        line,
        kind,
        old: kind === "removed" || kind === "context" ? old++ : "",
        next: kind === "added" || kind === "context" ? next++ : "",
      };
    });
}

export function ChangesReview({
  agentId,
  workspace,
  agents,
}: {
  agentId: string;
  workspace: string;
  agents: Agent[];
}) {
  const [staged, setStaged] = useState(false),
    [path, setPath] = useState("");
  const [review, setReview] = useState<Review | null>(null),
    [error, setError] = useState("");
  const [revision, refresh] = useState(0),
    [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [comment, setComment] = useState<{
    row: number;
    path: string;
    staged: boolean;
    diffHash: string;
    line: string;
    requestId: string;
  } | null>(null);
  const [text, setText] = useState(""),
    [recipient, setRecipient] = useState(agentId);
  const [sending, setSending] = useState(false),
    [sent, setSent] = useState("");
  async function sendFeedback() {
    if (!comment) return;
    setSending(true);
    setError("");
    try {
      const result = await api(
        `/agents/${agentId}/development/feedback`,
        "POST",
        {
          workspace,
          path: comment.path,
          staged: comment.staged,
          diffHash: comment.diffHash,
          row: comment.row,
          requestId: comment.requestId,
          targetId: recipient,
          text,
        },
      );
      setSent(
        `Feedback ${result.execution} for ${agents.find((a) => a.id === recipient)?.name}. It is available in their conversation.`,
      );
      setComment(null);
      setText("");
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setReview(null);
    void api(`/agents/${agentId}/git/review`, "POST", {
      workspace,
      staged,
      ...(path ? { path } : {}),
    })
      .then((result: Review) => {
        if (!current) return;
        setReview(result);
        if (!path && result.files.length) setPath(result.files[0].path);
      })
      .catch((e) => {
        if (current) setError(String(e.message ?? e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agentId, workspace, staged, path, revision]);
  const rows = diffRows(review?.diff ?? "");
  const added = rows.filter((r) => r.kind === "added").length;
  const removed = rows.filter((r) => r.kind === "removed").length;
  return (
    <section className="changes-review" aria-label="Code review">
      <div className="row between">
        <h3>Review changes</h3>
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
        {review?.branch} · {workspace}
        <br />
        Changes in this folder may come from any agent or editor.
      </p>
      <div className="tabs">
        <button
          className={!staged ? "active" : ""}
          onClick={() => {
            setPath("");
            setStaged(false);
          }}
        >
          Unstaged
        </button>
        <button
          className={staged ? "active" : ""}
          onClick={() => {
            setPath("");
            setStaged(true);
          }}
        >
          Staged
        </button>
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {sent && <p role="status">{sent}</p>}
      {comment && (
        <section className="review-comment">
          <strong>
            {comment.path} · {comment.staged ? "staged" : "unstaged"}
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
                  {a.name}
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
      {review && (
        <>
          <input
            aria-label="Filter changed files"
            placeholder="Filter changed files…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="review-layout">
            <nav className="review-files" aria-label="Changed files">
              {review.files
                .filter((f) =>
                  f.path.toLowerCase().includes(filter.toLowerCase()),
                )
                .map((file) => (
                  <button
                    key={file.path}
                    className={path === file.path ? "active" : ""}
                    onClick={() => setPath(file.path)}
                  >
                    <code>{file.status}</code>
                    <span>
                      {file.path}
                      {file.from && <small> ← {file.from}</small>}
                    </span>
                  </button>
                ))}
              {!review.files.length && (
                <p className="hint">
                  No {staged ? "staged" : "unstaged"} changes.
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
                {review.truncated && (
                  <p className="notice">
                    Large file: showing only the first 256 KB.
                  </p>
                )}
                {!review.diff ? (
                  <p className="hint">
                    No text changes (the change may only affect the file mode or
                    name).
                  </p>
                ) : (
                  <div className="diff-scroll">
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
                          <tr key={i} className={`diff-${r.kind}`}>
                            <td>{r.old}</td>
                            <td>{r.next}</td>
                            <td>
                              <code>{r.line}</code>
                            </td>
                            <td>
                              {r.kind !== "meta" && (
                                <button
                                  disabled={!!comment}
                                  aria-label={`Comment on ${r.kind === "removed" ? "old" : "new"} line ${r.kind === "removed" ? r.old : r.next}`}
                                  onClick={() => {
                                    setSent("");
                                    setComment({
                                      row: i,
                                      path,
                                      staged,
                                      diffHash: review.diffHash,
                                      line: r.line,
                                      requestId: crypto.randomUUID(),
                                    });
                                  }}
                                >
                                  +
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
