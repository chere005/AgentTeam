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
import {
  clike,
  csharp,
  dart,
  kotlin,
  objectiveC,
  scala,
} from "@codemirror/legacy-modes/mode/clike";
import { cmake } from "@codemirror/legacy-modes/mode/cmake";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { mathematica } from "@codemirror/legacy-modes/mode/mathematica";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { languageForPath, type LanguageId } from "../editor-languages";
import {
  defaultSublimePreferences,
  type SublimeEditorPreferences,
} from "../editor-preferences";

/** Grammars bundled with the editor (already part of the main chunk). */
const eager: Partial<Record<LanguageId, () => Extension>> = {
  typescript: () => javascript({ typescript: true }),
  javascript: () => javascript(),
  json: () => json(),
  python: () => python(),
  html: () => html(),
  css: () => css(),
  sql: () => sql(),
  yaml: () => yaml(),
  toml: () => StreamLanguage.define(toml),
  rust: () => rust(),
  go: () => go(),
  java: () => java(),
  csharp: () => StreamLanguage.define(csharp),
  kotlin: () => StreamLanguage.define(kotlin),
  scala: () => StreamLanguage.define(scala),
  dart: () => StreamLanguage.define(dart),
  objc: () => StreamLanguage.define(objectiveC),
  php: () => StreamLanguage.define(phpMode),
  shell: () => StreamLanguage.define(shell),
  diff: () => StreamLanguage.define(diff),
  dockerfile: () => StreamLanguage.define(dockerFile),
  wolfram: () => StreamLanguage.define(mathematica),
  verilog: () => StreamLanguage.define(verilog),
  cmake: () => StreamLanguage.define(cmake),
  xml: () => xml(),
  cpp: () => cpp(),
  markdown: () => markdown(),
};
/** Small legacy grammars loaded on first use (a separate chunk each) so the main bundle does not grow. */
const lazy: Partial<Record<LanguageId, () => Promise<Extension>>> = {
  swift: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/swift")).swift,
    ),
  ruby: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/ruby")).ruby,
    ),
  lua: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/lua")).lua,
    ),
  perl: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/perl")).perl,
    ),
  r: async () =>
    StreamLanguage.define((await import("@codemirror/legacy-modes/mode/r")).r),
  julia: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/julia")).julia,
    ),
  haskell: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/haskell")).haskell,
    ),
  groovy: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/groovy")).groovy,
    ),
  powershell: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/powershell")).powerShell,
    ),
  protobuf: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/protobuf")).protobuf,
    ),
  properties: async () =>
    StreamLanguage.define(
      (await import("@codemirror/legacy-modes/mode/properties")).properties,
    ),
};

/** PHP as a C-like stream grammar ($variables, # comments, the usual keywords); no HTML embedding. */
const phpMode = clike({
  name: "php",
  keywords: words(
    "abstract and array as break callable case catch class clone const continue declare default do else elseif enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface match namespace new or print private protected public readonly require require_once return static switch throw trait try use var while xor yield echo isset unset empty die exit list enum",
  ),
  blockKeywords: words(
    "catch class do else elseif for foreach if interface namespace switch try while finally",
  ),
  atoms: words(
    "true false null self parent __FILE__ __LINE__ __DIR__ __CLASS__ __FUNCTION__ __METHOD__ __NAMESPACE__",
  ),
  types: words(
    "int float string bool array object mixed void never iterable callable",
  ),
  hooks: {
    $: (stream: any) => {
      stream.eatWhile(/[\w$]/);
      return "variable";
    },
    "#": (stream: any) => {
      if (stream.peek() === "[") return null;
      stream.skipToEnd();
      return "comment";
    },
  },
});
function words(list: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const word of list.split(" ")) out[word] = true;
  return out;
}

export function editorLanguage(path: string): {
  name: string;
  extension: Extension;
  /** Present when the grammar is a separate chunk: resolve it, then reconfigure the editor with the result. */
  load?: () => Promise<Extension>;
} {
  const { id, name } = languageForPath(path);
  if (id === "typescript" || id === "javascript") {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return {
      name,
      extension: javascript({
        typescript: id === "typescript",
        jsx: ext === "jsx" || ext === "tsx",
      }),
    };
  }
  const make = eager[id];
  if (make) return { name, extension: make() };
  const load = lazy[id];
  if (load) return { name, extension: [], load };
  return { name, extension: [] };
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
    // A grammar that is its own chunk arrives after the first paint; a path change meanwhile discards it.
    let current = true;
    const language = editorLanguage(path);
    language.load?.().then(
      (extension) => {
        if (current)
          view.current?.dispatch({
            effects: config.current.language.reconfigure(extension),
          });
      },
      () => undefined,
    );
    view.current?.dispatch({
      effects: [
        config.current.language.reconfigure(language.extension),
        config.current.access.reconfigure(EditorState.readOnly.of(readOnly)),
        config.current.editable.reconfigure(EditorView.editable.of(!readOnly)),
        config.current.wrapping.reconfigure(
          wrap ? EditorView.lineWrapping : [],
        ),
        config.current.formatting.reconfigure(formatting(preferences)),
      ],
    });
    return () => {
      current = false;
    };
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
