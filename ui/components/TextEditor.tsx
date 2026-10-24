import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { FILE_EDITOR_LEAVE_EVENT } from "../file-editor-guard";
import { CodeEditor, editorLanguage, type EditorStatus } from "./CodeEditor";
import {
  defaultSublimePreferences,
  type SublimeEditorConfig,
} from "../editor-preferences";

type Document = { content: string; hash: string; access: string };
const saveShortcut = /Mac/i.test(navigator.platform) ? "⌘S" : "Ctrl+S";

export function TextEditor({
  agentId,
  workspace,
  path,
  isNew = false,
  saveTargetLabel,
  active = true,
  guardLeave = true,
  onDirtyChange,
  onCancel,
  onSaved,
  onCreated,
}: {
  agentId: string;
  workspace: string;
  path: string;
  isNew?: boolean;
  saveTargetLabel?: string;
  active?: boolean;
  guardLeave?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
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
  const [wrap, setWrap] = useState<boolean | null>(null);
  const [sublimeConfig, setSublimeConfig] = useState<SublimeEditorConfig>({
    preferences: defaultSublimePreferences,
    globalSettings: "missing",
    projectFile: null,
  });
  const [cursor, setCursor] = useState<EditorStatus>({
    line: 1,
    column: 1,
    selections: 1,
    selected: 0,
  });
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirty = doc !== null && draft !== doc.content;
  const cancel = () => {
    if (dirty && !window.confirm("Discard your unsaved file changes?")) return;
    onCancel();
  };

  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);

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
    let alive = true;
    const request = workspace
      ? api(`/agents/${agentId}/editors/preferences`, "POST", { workspace })
      : api("/editors/sublime-config");
    request
      .then((config: SublimeEditorConfig) => alive && setSublimeConfig(config))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [agentId, workspace]);

  const preferences = sublimeConfig.preferences;
  const wordWrap = wrap ?? preferences.wordWrap;
  const settingsSource =
    [
      sublimeConfig.globalSettings === "loaded"
        ? "Preferences.sublime-settings"
        : "",
      sublimeConfig.projectFile,
    ]
      .filter(Boolean)
      .join(" + ") || "Sublime defaults";

  useEffect(() => {
    if (!dirty || !guardLeave || !active) return;
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
  }, [dirty, guardLeave, active]);

  const save = async () => {
    if (!doc || (!dirty && !isNew) || saving) return;
    setSaving(true);
    setError("");
    try {
      const activity = await api(`/agents/${agentId}/files/activity`, "POST", {
        workspace,
        path: isNew ? newPath : path,
        create: isNew,
      });
      if (activity.activities.length) {
        const rows = activity.activities
          .slice(0, 5)
          .map(
            (item: { agentName: string; state: string; title: string }) =>
              `• ${item.agentName} · ${item.state}: ${item.title}`,
          );
        const more = activity.activities.length > rows.length;
        const message = [
          "AgentTeam work overlaps this file or its folder:",
          "",
          ...rows,
          ...(more
            ? [`• and ${activity.activities.length - rows.length} more`]
            : []),
          "",
          "Save your changes anyway?",
        ].join("\n");
        if (!window.confirm(message)) return;
      }
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
          <div className="text-editor-new-details">
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
            <span className="text-editor-target">
              {workspace
                ? `Save target: ${saveTargetLabel ?? "selected folder"}`
                : "No project folder · save to your computer"}
            </span>
          </div>
        ) : (
          <span className="text-editor-status">
            <i className={dirty ? "dirty" : ""} />
            {dirty ? "Unsaved changes" : savedAt ? `Saved ${savedAt}` : "Ready"}
          </span>
        )}
        <div className="row">
          <button
            aria-pressed={wordWrap}
            title="Wrap long lines"
            onClick={() => setWrap((value) => !(value ?? preferences.wordWrap))}
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
              (!dirty && !isNew) || saving || !workspace || !newPath.trim()
            }
            onClick={() => void save()}
          >
            {saving
              ? "Saving…"
              : isNew
                ? `Save in ${saveTargetLabel ?? "workspace"}`
                : "Save"}
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
            readOnly={false}
            wrap={wordWrap}
            active={active}
            preferences={preferences}
            onChange={setDraft}
            onSave={() => void save()}
            onStatus={setCursor}
          />
        </div>
      )}
      <footer className="text-editor-footer">
        {isNew
          ? `New file in ${workspace}`
          : `You can edit · agent access: ${doc?.access === "write" ? "write" : "read only"}`}
        <span title={`Sublime settings: ${settingsSource}`}>
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selections > 1
            ? ` · ${cursor.selections} selections`
            : cursor.selected
              ? ` · ${cursor.selected} selected`
              : ""}{" "}
          · {editorLanguage(newPath).name} ·{" "}
          {preferences.translateTabsToSpaces ? "Spaces" : "Tabs"}:{" "}
          {preferences.tabSize} · {draft.split("\n").length} lines ·{" "}
          {new TextEncoder().encode(draft).length.toLocaleString()} bytes
        </span>
      </footer>
    </section>
  );
}
