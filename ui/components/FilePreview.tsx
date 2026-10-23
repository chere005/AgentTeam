import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../api";
import { Markdown } from "./Markdown";
import { TextEditor } from "./TextEditor";
import type { RichPreview } from "../../src/previews";

/** Typed, bounded file preview. Text is shown in <pre>, Markdown through the safe renderer, tables as cells. */
export function FilePreview({
  agentId,
  workspace,
  path,
  access,
  refreshKey = 0,
}: {
  agentId: string;
  workspace: string;
  path: string;
  access: string;
  refreshKey?: number;
}) {
  const [view, setView] = useState<RichPreview | null>(null),
    [error, setError] = useState(""),
    [raw, setRaw] = useState(false),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    let live = true;
    setError("");
    api(`/agents/${agentId}/files/inspect`, "POST", { workspace, path })
      .then((v) => live && setView(v))
      .catch((e) => live && (setView(null), setError(String(e.message ?? e))));
    return () => {
      live = false;
    };
  }, [agentId, workspace, path, refreshKey]);
  return (
    <section className="file-preview" aria-label="File preview">
      <div className="row between">
        <b>{view?.name ?? path}</b>
        <OpenWith agentId={agentId} workspace={workspace} path={path} />
      </div>
      <div className="access-banner">
        <b>{access === "write" ? "READ & WRITE" : "READ ONLY"}</b>
        <code>
          {workspace}/{path}
        </code>
        <small>
          {access === "write"
            ? "Folder allows edits; file rules are checked again when saving"
            : "Read-only folder"}
        </small>
      </div>
      {error && <p role="alert">{error}</p>}
      {view && (
        <>
          <small>
            {view.size} bytes · {view.kind}
            {view.truncated ? " · truncated" : ""}
          </small>
          {view.note && (
            <p className="hint" role="status">
              {view.note}
            </p>
          )}
          {editing ? (
            <TextEditor
              agentId={agentId}
              workspace={workspace}
              path={path}
              onCancel={() => setEditing(false)}
              onSaved={(content, bytes) =>
                setView((previous) =>
                  previous
                    ? { ...previous, content, size: bytes, truncated: false }
                    : previous,
                )
              }
            />
          ) : (
            <>
              {!view.truncated &&
                ["markdown", "text", "json"].includes(view.kind) && (
                  <button
                    className="file-edit-button"
                    onClick={() => setEditing(true)}
                  >
                    Edit file
                  </button>
                )}
              {view.kind === "image" && view.image && (
                <img
                  className="preview-image"
                  alt={`Preview of ${view.name}`}
                  src={view.image.dataUrl}
                />
              )}
              {view.kind === "markdown" && view.content !== undefined && (
                <>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={raw}
                      onChange={(e) => setRaw(e.target.checked)}
                    />
                    Show source
                  </label>
                  {raw ? (
                    <pre>{view.content}</pre>
                  ) : (
                    <Markdown text={view.content} />
                  )}
                </>
              )}
              {view.kind === "text" && <pre>{view.content}</pre>}
              {view.kind === "json" && view.json && (
                <>
                  {!view.json.valid && view.json.error && (
                    <p role="alert">Invalid JSON: {view.json.error}</p>
                  )}
                  <pre>{view.json.formatted}</pre>
                </>
              )}
              {view.kind === "csv" && view.table && (
                <div className="table-scroll">
                  <table aria-label="Table preview">
                    <tbody>
                      {view.table.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((cell, c) =>
                            r === 0 ? (
                              <th key={c}>{cell}</th>
                            ) : (
                              <td key={c}>{cell}</td>
                            ),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {view.externalOnly && (
                <p>
                  <button
                    onClick={() =>
                      void api(`/agents/${agentId}/editors/open`, "POST", {
                        workspace,
                        path,
                        action: "with",
                        editor: "system",
                      }).catch((e) => setError(String(e.message ?? e)))
                    }
                  >
                    <ExternalLink size={14} /> Open in default application
                  </button>
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Open file / project / reveal / open with, via the configured editors (argv, no shell). */
export function OpenWith({
  agentId,
  workspace,
  path,
  project = false,
}: {
  agentId: string;
  workspace: string;
  path: string;
  project?: boolean;
}) {
  const [message, setMessage] = useState(""),
    [failed, setFailed] = useState(false);
  const go = async (action: string, editor?: string) => {
    setMessage("");
    setFailed(false);
    try {
      const r = await api(`/agents/${agentId}/editors/open`, "POST", {
        workspace,
        path,
        action,
        ...(editor ? { editor } : {}),
      });
      setMessage(`Opened with ${r.application}`);
    } catch (e) {
      setFailed(true);
      setMessage(String((e as Error).message ?? e));
    }
  };
  return (
    <span className="open-with">
      <button
        title={project ? "Open project in editor" : "Open file in editor"}
        onClick={() => void go(project ? "project" : "file")}
      >
        <ExternalLink size={14} /> {project ? "Open project" : "Open"}
      </button>
      <button onClick={() => void go("reveal")}>Reveal</button>
      <select
        aria-label="Open with"
        value=""
        onChange={(e) => e.target.value && void go("with", e.target.value)}
      >
        <option value="">Open with…</option>
        <option value="sublime">Sublime Text</option>
        <option value="vscode">Visual Studio Code</option>
        <option value="system">System default</option>
        <option value="custom">Custom application</option>
      </select>
      {message && <small role={failed ? "alert" : "status"}>{message}</small>}
    </span>
  );
}
