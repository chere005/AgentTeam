import { useEffect, useState } from "react";
import { api } from "../api";
import { FILE_EDITOR_LEAVE_EVENT } from "../file-editor-guard";
import { CodeEditor, editorLanguage, type EditorStatus } from "./CodeEditor";

type Document = { content: string; hash: string; access: string };
const saveShortcut = /Mac/i.test(navigator.platform) ? "⌘S" : "Ctrl+S";

export function TextEditor({
  agentId,
  workspace,
  path,
  isNew = false,
  onCancel,
  onSaved,
  onCreated,
}: {
  agentId: string;
  workspace: string;
  path: string;
  isNew?: boolean;
  onCancel: () => void;
  onSaved: (content: string, bytes: number) => void;
  onCreated?: (path: string, content: string, bytes: number) => void;
}) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [newPath, setNewPath] = useState(path);
  const [wrap, setWrap] = useState(false);
  const [cursor, setCursor] = useState<EditorStatus>({
    line: 1,
    column: 1,
    selections: 1,
    selected: 0,
  });
  const dirty = doc !== null && draft !== doc.content;
  const cancel = () => {
    if (dirty && !window.confirm("Discard your unsaved file changes?")) return;
    onCancel();
  };

  useEffect(() => {
    let alive = true;
    if (isNew) {
      setDoc(
        (previous) => previous ?? { content: "", hash: "", access: "write" },
      );
      return () => {
        alive = false;
      };
    }
    setDoc(null);
    setDraft("");
    setError("");
    setNewPath(path);
    api(`/agents/${agentId}/files/read`, "POST", { workspace, path })
      .then((result: Document & { path: string }) => {
        if (!alive) return;
        setDoc(result);
        setDraft(result.content);
      })
      .catch((reason) => alive && setError(String(reason?.message ?? reason)));
    return () => {
      alive = false;
    };
  }, [agentId, workspace, path, isNew]);

  useEffect(() => {
    if (!dirty) return;
    const confirmLeave = (event: Event) => {
      if (!window.confirm("Discard your unsaved file changes?"))
        event.preventDefault();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener(FILE_EDITOR_LEAVE_EVENT, confirmLeave);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener(FILE_EDITOR_LEAVE_EVENT, confirmLeave);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty]);

  const save = async () => {
    if (!doc || (!dirty && !isNew) || saving) return;
    setSaving(true);
    setError("");
    try {
      const result = isNew
        ? await api(`/agents/${agentId}/files/create`, "POST", {
            workspace,
            path: newPath,
            content: draft,
          })
        : await api(`/agents/${agentId}/files/save`, "POST", {
            workspace,
            path,
            content: draft,
            expectedHash: doc.hash,
          });
      setDoc({ ...doc, content: draft, hash: result.hash });
      setSavedAt(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
      if (isNew) onCreated?.(result.path, draft, result.bytes);
      else onSaved(draft, result.bytes);
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="text-editor" aria-label={`Editor for ${path}`}>
      <div className="text-editor-toolbar">
        {isNew ? (
          <label className="text-editor-new-name">
            File name
            <input
              aria-label="New file name"
              value={newPath.split(/[\\/]/).pop() ?? "untitled.txt"}
              onChange={(event) => {
                const folder = newPath.includes("/")
                  ? newPath.slice(0, newPath.lastIndexOf("/") + 1)
                  : "";
                setNewPath(folder + event.target.value);
              }}
            />
          </label>
        ) : (
          <span className="text-editor-status">
            <i className={dirty ? "dirty" : ""} />
            {dirty ? "Unsaved changes" : savedAt ? `Saved ${savedAt}` : "Ready"}
          </span>
        )}
        <div className="row">
          <button
            aria-pressed={wrap}
            title="Wrap long lines"
            onClick={() => setWrap((value) => !value)}
          >
            Word wrap
          </button>
          <details className="text-editor-shortcuts">
            <summary>Shortcuts</summary>
            <div role="note">
              <p>Ctrl/Cmd+D · select next occurrence</p>
              <p>Ctrl/Cmd+Shift+D · duplicate line</p>
              <p>Ctrl/Cmd+L · select line</p>
              <p>Ctrl/Cmd+/ · toggle comment</p>
              <p>Ctrl/Cmd+F · find and replace</p>
              <p>Ctrl+G · go to line</p>
              <p>Tab / Shift+Tab · indent / unindent</p>
              <p>Ctrl/Cmd+Z · undo · Shift+Ctrl/Cmd+Z · redo</p>
              <p>Escape, then Tab · leave the editor with the keyboard</p>
            </div>
          </details>
          {isNew && (
            <button
              onClick={async () => {
                if (!window.agentteam.saveTextFile) return;
                setError("");
                try {
                  const saved = await window.agentteam.saveTextFile(
                    newPath.split(/[\\/]/).pop() ?? "untitled.txt",
                    draft,
                  );
                  if (saved) setSavedAt("to computer");
                } catch (reason) {
                  setError(String((reason as Error)?.message ?? reason));
                }
              }}
            >
              Save to computer…
            </button>
          )}
          <button onClick={cancel}>Preview</button>
          <button
            className="primary"
            disabled={
              (!dirty && !isNew) ||
              saving ||
              doc?.access !== "write" ||
              !workspace ||
              !newPath.trim()
            }
            onClick={() => void save()}
          >
            {saving ? "Saving…" : isNew ? "Save in workspace" : "Save"}
            <kbd>{saveShortcut}</kbd>
          </button>
        </div>
      </div>
      {error && (
        <p className="text-editor-error" role="alert">
          {error}
        </p>
      )}
      {!doc && !error ? (
        <div className="empty compact">Opening file…</div>
      ) : (
        <div className="text-editor-surface">
          <CodeEditor
            value={draft}
            path={newPath}
            readOnly={doc?.access !== "write"}
            wrap={wrap}
            onChange={setDraft}
            onSave={() => void save()}
            onStatus={setCursor}
          />
        </div>
      )}
      <footer className="text-editor-footer">
        {doc?.access === "write"
          ? isNew
            ? `New file in ${workspace}`
            : "Writable folder · UTF-8"
          : "Read-only folder"}
        <span>
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selections > 1
            ? ` · ${cursor.selections} selections`
            : cursor.selected
              ? ` · ${cursor.selected} selected`
              : ""}{" "}
          · {editorLanguage(newPath).name} · Spaces: 2 ·{" "}
          {draft.split("\n").length} lines ·{" "}
          {new TextEncoder().encode(draft).length.toLocaleString()} bytes
        </span>
      </footer>
    </section>
  );
}
