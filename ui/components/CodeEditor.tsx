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
  StreamLanguage,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { csharp } from "@codemirror/legacy-modes/mode/clike";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import {
  defaultSublimePreferences,
  type SublimeEditorPreferences,
} from "../editor-preferences";

export function editorLanguage(path: string): {
  name: string;
  extension: Extension;
} {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = filename.split(".").pop();
  if (
    ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext ?? "")
  )
    return {
      name: ext === "ts" || ext === "tsx" ? "TypeScript" : "JavaScript",
      extension: javascript({
        typescript: ext === "ts" || ext === "tsx",
        jsx: ext === "jsx" || ext === "tsx",
      }),
    };
  if (ext === "json") return { name: "JSON", extension: json() };
  if (ext === "py") return { name: "Python", extension: python() };
  if (["html", "htm", "xhtml"].includes(ext ?? ""))
    return { name: "HTML", extension: html() };
  if (ext === "css") return { name: "CSS", extension: css() };
  if (ext === "sql") return { name: "SQL", extension: sql() };
  if (["yaml", "yml"].includes(ext ?? ""))
    return { name: "YAML", extension: yaml() };
  if (ext === "toml")
    return { name: "TOML", extension: StreamLanguage.define(toml) };
  if (ext === "rs") return { name: "Rust", extension: rust() };
  if (ext === "go") return { name: "Go", extension: go() };
  if (ext === "java") return { name: "Java", extension: java() };
  if (ext === "cs")
    return { name: "C#", extension: StreamLanguage.define(csharp) };
  if (
    ["sh", "bash", "zsh", "ksh"].includes(ext ?? "") ||
    filename === "pkgbuild"
  )
    return { name: "Shell", extension: StreamLanguage.define(shell) };
  if (["diff", "patch"].includes(ext ?? ""))
    return { name: "Diff", extension: StreamLanguage.define(diff) };
  if (filename === "dockerfile" || filename.startsWith("dockerfile."))
    return {
      name: "Dockerfile",
      extension: StreamLanguage.define(dockerFile),
    };
  if (["wl", "wls", "nb"].includes(ext ?? ""))
    return {
      name: "Wolfram Language",
      extension: StreamLanguage.define(mathematica),
    };
  if (["v", "sv", "svh"].includes(ext ?? ""))
    return { name: "Verilog", extension: StreamLanguage.define(verilog) };
  if (
    filename === "cmakelists.txt" ||
    filename === "cmakelists.txt.in" ||
    ext === "cmake" ||
    filename.endsWith(".cmake.in")
  )
    return { name: "CMake", extension: StreamLanguage.define(cmake) };
  if (["xml", "xsl", "xsd", "svg", "xhtml"].includes(ext ?? ""))
    return { name: "XML", extension: xml() };
  if (["c", "h", "cc", "cpp", "hpp"].includes(ext ?? ""))
    return { name: "C / C++", extension: cpp() };
  if (ext === "md" || ext === "markdown")
    return { name: "Markdown", extension: markdown() };
  return { name: "Plain text", extension: [] };
}

const highlighting = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier],
    color: "#c586c0",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "#ce9178",
  },
  {
    tag: [tags.number, tags.bool, tags.null],
    color: "#b5cea8",
  },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    color: "#dcdcaa",
  },
  { tag: tags.comment, color: "#7f9a83", fontStyle: "italic" },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "#4ec9b0",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "#9cdcfe" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: [tags.regexp, tags.escape], color: "#d7ba7d" },
  { tag: tags.inserted, color: "#8cc8a5" },
  { tag: tags.deleted, color: "#d88a8a" },
  { tag: tags.meta, color: "#858585" },
  {
    tag: tags.heading,
    color: "#569cd6",
    fontWeight: "bold",
  },
  { tag: tags.link, textDecoration: "underline" },
]);

const editorColors = {
  foreground: "#d4d4d4",
  background: "#1e1e1e",
  gutter: "#858585",
  border: "#333333",
  activeLine: "rgba(255, 255, 255, 0.04)",
  selection: "#264f78",
  panel: "#252526",
};

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
  active = true,
  preferences = defaultSublimePreferences,
}: {
  value: string;
  path: string;
  readOnly: boolean;
  wrap: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onStatus: (status: EditorStatus) => void;
  active?: boolean;
  preferences?: SublimeEditorPreferences;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onSave, onStatus });
  callbacks.current = { onChange, onSave, onStatus };
  const formatting = (settings: SublimeEditorPreferences) => {
    const rulers = settings.rulers;
    const rulerStyle = {
      backgroundImage: rulers.length
        ? rulers
            .map(
              () => "linear-gradient(var(--editor-ruler), var(--editor-ruler))",
            )
            .join(",")
        : "none",
      backgroundSize: rulers.map(() => "1px 100%").join(","),
      backgroundPosition: rulers
        .map((column) => `calc(12px + ${column}ch) 0`)
        .join(","),
      backgroundRepeat: rulers.map(() => "no-repeat").join(","),
    };
    return [
      EditorState.tabSize.of(settings.tabSize),
      indentUnit.of(
        settings.translateTabsToSpaces ? " ".repeat(settings.tabSize) : "\t",
      ),
      EditorView.theme({
        ".cm-scroller": { fontSize: `${settings.fontSize}px` },
        ".cm-content": rulerStyle,
      }),
    ];
  };
  const config = useRef({
    language: new Compartment(),
    access: new Compartment(),
    editable: new Compartment(),
    wrapping: new Compartment(),
    formatting: new Compartment(),
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
          config.current.formatting.of(formatting(preferences)),
          syntaxHighlighting(highlighting),
          config.current.language.of(editorLanguage(path).extension),
          config.current.access.of(EditorState.readOnly.of(readOnly)),
          config.current.editable.of(EditorView.editable.of(!readOnly)),
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
              color: editorColors.foreground,
              backgroundColor: editorColors.background,
              "--editor-ruler": "rgba(255, 255, 255, 0.16)",
            },
            ".cm-scroller": {
              fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
              lineHeight: "1.55",
              overflow: "auto",
            },
            ".cm-content": {
              padding: "10px 0",
              caretColor: editorColors.foreground,
            },
            ".cm-line": { padding: "0 12px" },
            ".cm-gutters": {
              backgroundColor: editorColors.background,
              color: editorColors.gutter,
              borderRight: `1px solid ${editorColors.border}`,
              userSelect: "none",
            },
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: editorColors.activeLine,
            },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
              {
                backgroundColor: `${editorColors.selection} !important`,
              },
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: editorColors.foreground,
            },
            ".cm-panels": {
              backgroundColor: editorColors.panel,
              color: editorColors.foreground,
              borderColor: editorColors.border,
            },
            ".cm-textfield": {
              backgroundColor: editorColors.background,
              color: editorColors.foreground,
              border: `1px solid ${editorColors.border}`,
              borderRadius: "4px",
            },
            ".cm-button": {
              backgroundImage: "none",
              backgroundColor: editorColors.panel,
              color: editorColors.foreground,
              border: `1px solid ${editorColors.border}`,
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
    if (active) view.current?.requestMeasure();
  }, [active]);

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
        config.current.editable.reconfigure(EditorView.editable.of(!readOnly)),
        config.current.wrapping.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
        config.current.formatting.reconfigure(formatting(preferences)),
      ],
    });
  }, [path, readOnly, wrap, preferences]);
  return <div ref={host} className="code-editor" data-testid="code-editor" />;
}

/** Read-only CodeMirror view used for source previews, sharing editor grammars and colors. */
export function CodePreview({
  value,
  path,
  preferences = defaultSublimePreferences,
}: {
  value: string;
  path: string;
  preferences?: SublimeEditorPreferences;
}) {
  const language = editorLanguage(path);
  if (language.name === "Plain text")
    return <pre className="file-plain-preview">{value}</pre>;
  return (
    <div className="file-code-preview">
      <CodeEditor
        value={value}
        path={path}
        readOnly
        wrap={false}
        onChange={() => undefined}
        onSave={() => undefined}
        onStatus={() => undefined}
        preferences={preferences}
      />
    </div>
  );
}
