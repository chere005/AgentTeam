import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import {
  copyLineDown,
  deleteLine,
  indentWithTab,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  selectLine,
  simplifySelection,
  temporarilySetTabFocusMode,
  toggleComment,
} from "@codemirror/commands";
import {
  gotoLine,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches,
} from "@codemirror/search";
import {
  HighlightStyle,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { markdown } from "@codemirror/lang-markdown";

export function editorLanguage(path: string): {
  name: string;
  extension: Extension;
} {
  const ext = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? ""))
    return {
      name: ext === "ts" || ext === "tsx" ? "TypeScript" : "JavaScript",
      extension: javascript({
        typescript: ext === "ts" || ext === "tsx",
        jsx: ext === "jsx" || ext === "tsx",
      }),
    };
  if (ext === "json") return { name: "JSON", extension: json() };
  if (ext === "py") return { name: "Python", extension: python() };
  if (["c", "h", "cc", "cpp", "hpp"].includes(ext ?? ""))
    return { name: "C / C++", extension: cpp() };
  if (ext === "md" || ext === "markdown")
    return { name: "Markdown", extension: markdown() };
  return { name: "Plain text", extension: [] };
}

const highlighting = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier],
    color: "var(--editor-keyword, #dca5ec)",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--editor-string, #d8c58a)",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "var(--editor-number, #dba586)",
  },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    color: "var(--editor-function, #8fd9ce)",
  },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  {
    tag: tags.heading,
    color: "var(--editor-function, #8fd9ce)",
    fontWeight: "bold",
  },
  { tag: tags.link, textDecoration: "underline" },
]);

export type EditorStatus = {
  line: number;
  column: number;
  selections: number;
  selected: number;
};

/** Keep one EditorView alive per document, so React renders and saving never erase undo/selections. */
export function CodeEditor({
  value,
  path,
  readOnly,
  wrap,
  onChange,
  onSave,
  onStatus,
}: {
  value: string;
  path: string;
  readOnly: boolean;
  wrap: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onStatus: (status: EditorStatus) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onStatus });
  callbacks.current = { onChange, onSave, onStatus };
  const config = useRef({
    language: new Compartment(),
    access: new Compartment(),
    wrapping: new Compartment(),
  });

  useEffect(() => {
    const report = (state: EditorState) => {
      const selection = state.selection;
      const line = state.doc.lineAt(selection.main.head);
      callbacks.current.onStatus({
        line: line.number,
        column: selection.main.head - line.from + 1,
        selections: selection.ranges.length,
        selected: selection.ranges.reduce((n, r) => n + r.to - r.from, 0),
      });
    };
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Before the defaults: Sublime's duplicate-line binding differs from CodeMirror's.
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                callbacks.current.onSave();
                return true;
              },
            },
            { key: "Mod-d", run: selectNextOccurrence },
            { key: "Mod-Shift-l", run: selectSelectionMatches },
            { key: "Mod-Shift-d", run: copyLineDown },
            { key: "Mod-l", run: selectLine },
            { key: "Mod-Shift-k", run: deleteLine },
            { key: "Mod-Enter", run: insertBlankLine },
            { key: "Mod-/", run: toggleComment },
            { key: "Ctrl-Shift-ArrowUp", run: moveLineUp },
            { key: "Ctrl-Shift-ArrowDown", run: moveLineDown },
            { key: "Mod-f", run: openSearchPanel },
            { key: "Ctrl-g", run: gotoLine },
            {
              key: "Escape",
              run: (editor) =>
                simplifySelection(editor) || temporarilySetTabFocusMode(editor),
            },
            indentWithTab,
          ]),
          basicSetup,
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(2),
          indentUnit.of("  "),
          syntaxHighlighting(highlighting),
          config.current.language.of(editorLanguage(path).extension),
          config.current.access.of(EditorState.readOnly.of(readOnly)),
          config.current.wrapping.of(wrap ? EditorView.lineWrapping : []),
          EditorView.contentAttributes.of({
            "aria-label": "File contents",
            "aria-multiline": "true",
            role: "textbox",
            spellcheck: "false",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              callbacks.current.onChange(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) report(update.state);
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              color: "var(--text)",
              backgroundColor: "var(--surface-0, #11151c)",
            },
            ".cm-scroller": {
              fontFamily:
                "'Sublime Text', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
              fontSize: "13px",
              lineHeight: "1.65",
              overflow: "auto",
            },
            ".cm-content": { padding: "12px 0", caretColor: "var(--text)" },
            ".cm-line": { padding: "0 16px" },
            ".cm-gutters": {
              backgroundColor: "var(--surface-1)",
              color: "var(--muted)",
              borderRight: "1px solid var(--line)",
              userSelect: "none",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "var(--editor-active, #8296b112)",
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
              {
                backgroundColor:
                  "var(--editor-selection, #688db84d) !important",
              },
            ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
            ".cm-panels": {
              backgroundColor: "var(--surface-1)",
              color: "var(--text)",
              borderColor: "var(--line)",
            },
            ".cm-textfield": {
              backgroundColor: "var(--surface-0)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              borderRadius: "4px",
            },
            ".cm-button": {
              backgroundImage: "none",
              backgroundColor: "var(--surface-1)",
              color: "var(--text)",
              border: "1px solid var(--line)",
              borderRadius: "4px",
            },
            "&.cm-focused": { outline: "none" },
          }),
        ],
      }),
    });
    view.current = editor;
    report(editor.state);
    return () => {
      view.current = null;
      editor.destroy();
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: [
        config.current.language.reconfigure(editorLanguage(path).extension),
        config.current.access.reconfigure(EditorState.readOnly.of(readOnly)),
        config.current.wrapping.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
      ],
    });
  }, [path, readOnly, wrap]);
  return <div ref={host} className="code-editor" data-testid="code-editor" />;
}
