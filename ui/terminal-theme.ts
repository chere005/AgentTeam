/**
 * Terminal tab look and pure helpers (no DOM; unit-tested in test/terminal.test.ts).
 * The canvas matches the code editor's dark surface (ui/components/CodeEditor.tsx, #1e1e1e),
 * with a softened ANSI palette drawn from the editor's token colours and a warm Sand Ink cursor.
 */

/** Nerd Font patched faces first (prompt glyphs), then common coding fonts, then the OS mono. */
export const TERMINAL_FONT_FAMILY = [
  '"JetBrainsMono Nerd Font"',
  '"JetBrainsMono NF"',
  '"MesloLGS NF"',
  '"MesloLGS Nerd Font"',
  '"FiraCode Nerd Font"',
  '"Fira Code"',
  '"JetBrains Mono"',
  '"SF Mono"',
  "Menlo",
  "Monaco",
  "Consolas",
  '"DejaVu Sans Mono"',
  '"Liberation Mono"',
  "monospace",
].join(", ");

export const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#e8b27a",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionInactiveBackground: "#3a3d41",
  scrollbarSliderBackground: "#79797966",
  scrollbarSliderHoverBackground: "#646464b3",
  scrollbarSliderActiveBackground: "#bfbfbf66",
  black: "#3b3b3b",
  red: "#f07178",
  green: "#8cc8a5",
  yellow: "#dcdcaa",
  blue: "#6aa8e0",
  magenta: "#c586c0",
  cyan: "#4ec9b0",
  white: "#d4d4d4",
  brightBlack: "#7a7a7a",
  brightRed: "#ff9a9f",
  brightGreen: "#a9e0bf",
  brightYellow: "#f0e6a8",
  brightBlue: "#8fc2f0",
  brightMagenta: "#dcaad8",
  brightCyan: "#7fe0cc",
  brightWhite: "#ffffff",
} as const;

/** Search highlights in the warm cursor hue. */
export const SEARCH_DECORATIONS = {
  matchBackground: "#614a2e",
  matchBorder: "#8a6a44",
  matchOverviewRuler: "#e8b27a",
  activeMatchBackground: "#e8b27a",
  activeMatchBorder: "#f3cfa5",
  activeMatchColorOverviewRuler: "#f3cfa5",
};

/** Canvas tokens for ui/components/terminal.css, set inline on the pane (never mirrored). */
export const TERMINAL_CANVAS = {
  "--term-bg": TERMINAL_THEME.background,
  "--term-fg": TERMINAL_THEME.foreground,
  "--term-accent": TERMINAL_THEME.cursor,
  "--term-edge": "#333333",
  "--term-muted": "#9d9d9d",
  "--term-scroll": TERMINAL_THEME.scrollbarSliderBackground,
  "--term-ended-bg": "#5a2f2f",
  "--term-ended-fg": "#ffb3b3",
  "--term-shadow": "#29241e2e",
};

/** WCAG relative-luminance contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

export type TerminalFolder = { path: string | null; label: string };

/** Last path segment, for compact folder and tab labels. */
export function folderName(path: string) {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Where a new terminal may start: home, the current project's workspace, then every folder
 * attached to an agent of this team (deduplicated, in that order). The main process re-checks
 * the choice against the same folders (src/terminal.ts).
 */
export function terminalFolders(
  data: {
    agents: readonly {
      name: string;
      nickname?: string | null;
      workspaces?: readonly { path: string }[];
    }[];
  },
  projectWorkspace?: string | null,
): TerminalFolder[] {
  const out: TerminalFolder[] = [{ path: null, label: "Home folder" }];
  const seen = new Set<string>();
  const add = (path: string | undefined | null, label: string) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, label });
  };
  add(
    projectWorkspace,
    `Current project: ${projectWorkspace ? folderName(projectWorkspace) : ""}`,
  );
  for (const agent of data.agents)
    for (const w of agent.workspaces ?? [])
      add(w.path, `${agent.nickname || agent.name}: ${folderName(w.path)}`);
  return out;
}

/** A session tab label: the folder name, numbered when several tabs share it. */
export function sessionTitle(
  cwd: string,
  home: boolean,
  taken: readonly string[],
) {
  const base = home ? "~" : folderName(cwd);
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

type Key = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};
/** What a key press in the terminal does before xterm sees it. */
export function terminalKeyAction(
  e: Key,
  mac: boolean,
): "search" | "copy" | "paste" | "pass" {
  const k = e.key.toLowerCase();
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey && k === "f") return "search";
  // Linux/Windows terminals copy and paste with Ctrl+Shift so Ctrl+C stays an interrupt.
  if (!mac && e.ctrlKey && e.shiftKey && !e.altKey && k === "c") return "copy";
  if (!mac && e.ctrlKey && e.shiftKey && !e.altKey && k === "v") return "paste";
  return "pass";
}
/**
 * App-wide shortcuts must not steal shell chords: inside a terminal, plain Ctrl chords
 * (Ctrl+K kill-line, Ctrl+P history, Ctrl+\ quit…) go to the shell. Cmd chords on macOS and
 * Ctrl+Shift chords elsewhere keep working.
 */
export function shellOwnsKey(e: Key) {
  return e.ctrlKey && !e.metaKey && !e.shiftKey;
}
