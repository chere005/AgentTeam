/**
 * Terminal sessions of the renderer. Feature tabs unmount when another tab is shown, so the
 * xterm instances, their DOM and scrollback live here (module scope) and the Terminal tab only
 * re-attaches them. The PTYs themselves run in the main process (src/terminal.ts).
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_THEME,
  sessionTitle,
  terminalKeyAction,
} from "./terminal-theme";
import { persist, saved } from "./api";

export type TerminalSession = {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
  renderer: "webgl" | "dom";
  exited: { exitCode: number; signal: number | null } | null;
  /** The shell printed something (it is reading input). */
  sawOutput: boolean;
};
type Bridge = NonNullable<Window["agentteam"]["terminal"]>;

const sessions: TerminalSession[] = [];
let active: string | null = null;
let version = 0;
const listeners = new Set<() => void>();
/** Output that arrived before `create` resolved (the PTY can print first). */
const early = new Map<string, string[]>();
let wired = false;
const mac = () => window.agentteam?.platform === "darwin";

function changed() {
  version++;
  for (const l of listeners) l();
}
export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const snapshotVersion = () => version;
export const listSessions = () => sessions;
export const activeSession = () =>
  sessions.find((s) => s.id === active) ??
  sessions[sessions.length - 1] ??
  null;
export function setActive(id: string) {
  active = id;
  changed();
}

export const copyOnSelect = {
  get: () => saved<boolean>("terminal.copyOnSelect", false) === true,
  set: (value: boolean) => {
    persist("terminal.copyOnSelect", value);
    changed();
  },
};

function bridge(): Bridge {
  const b = window.agentteam?.terminal;
  if (!b) throw new Error("The terminal is only available in the desktop app");
  if (!wired) {
    wired = true;
    b.onData(({ id, data }) => {
      const s = sessions.find((x) => x.id === id);
      if (s) {
        s.term.write(data);
        s.sawOutput = true;
      } else early.set(id, [...(early.get(id) ?? []), data]);
    });
    b.onExit(({ id, exitCode, signal }) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      s.exited = { exitCode, signal };
      s.term.write(
        `\r\n\x1b[2m[shell exited${signal ? ` by signal ${signal}` : ` with code ${exitCode}`}; close this tab or open a new one]\x1b[0m\r\n`,
      );
      changed();
    });
  }
  return b;
}

/**
 * Opens a new shell in `cwd` (null = home), rendering into a host element first placed in
 * `container` so xterm can measure the font and fit the PTY to the visible area.
 */
export async function openSession(
  container: HTMLElement,
  cwd: string | null,
): Promise<TerminalSession> {
  const b = bridge();
  const host = document.createElement("div");
  host.className = "terminal-host";
  container.appendChild(host);
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: 13,
    lineHeight: 1.2,
    fontWeight: "normal",
    fontWeightBold: "bold",
    cursorStyle: "bar",
    cursorWidth: 2,
    cursorBlink: true,
    cursorInactiveStyle: "outline",
    scrollback: 10_000,
    smoothScrollDuration: 80,
    macOptionClickForcesSelection: true,
    drawBoldTextInBrightColors: true,
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon(),
    search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  // Links open in the system browser on Cmd/Ctrl+click only, so a stray click never navigates.
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      if (mac() ? event.metaKey : event.ctrlKey) void b.openLink(uri);
    }),
  );
  term.open(host);
  let renderer: TerminalSession["renderer"] = "dom";
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      session.renderer = "dom";
      changed();
    });
    term.loadAddon(webgl);
    renderer = "webgl";
  } catch {
    /* no WebGL2 (VM, remote desktop): xterm keeps its DOM renderer */
  }
  try {
    fit.fit();
  } catch {
    /* hidden container: keep 80x24 until the first resize */
  }
  let info: { id: string; cwd: string; shell: string };
  try {
    info = await b.create({ cwd, cols: term.cols, rows: term.rows });
  } catch (error) {
    term.dispose();
    host.remove();
    throw error;
  }
  const session: TerminalSession = {
    id: info.id,
    title: sessionTitle(
      info.cwd,
      cwd === null,
      sessions.map((s) => s.title),
    ),
    cwd: info.cwd,
    shell: info.shell,
    term,
    fit,
    search,
    host,
    renderer,
    exited: null,
    sawOutput: false,
  };
  sessions.push(session);
  active = session.id;
  for (const chunk of early.get(info.id) ?? []) {
    term.write(chunk);
    session.sawOutput = true;
  }
  early.delete(info.id);
  term.onData((data) => {
    if (!session.exited) b.write(session.id, data);
  });
  term.onBinary((data) => {
    if (!session.exited) b.write(session.id, data);
  });
  term.onResize(({ cols, rows }) => {
    if (!session.exited) b.resize(session.id, cols, rows);
  });
  term.onTitleChange((title) => {
    host.dataset.title = title;
  });
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text && copyOnSelect.get())
      void navigator.clipboard?.writeText(text).catch(() => undefined);
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const action = terminalKeyAction(e, mac());
    if (action === "pass") return true;
    e.preventDefault();
    if (action === "search")
      window.dispatchEvent(new CustomEvent("agentteam:terminal-search"));
    else if (action === "copy") {
      const text = term.getSelection();
      if (text)
        void navigator.clipboard?.writeText(text).catch(() => undefined);
    } else if (action === "paste")
      void navigator.clipboard
        ?.readText()
        .then((text) => text && term.paste(text))
        .catch(() => undefined);
    return false;
  });
  changed();
  return session;
}

/**
 * Types `data` into the session's shell, as if from the keyboard (the sign-in command line from
 * the backend). Nothing else is sent; the renderer never chooses an executable.
 */
export function sendInput(session: TerminalSession, data: string) {
  if (!session.exited) bridge().write(session.id, data);
}
/** Resolves once the shell printed something (plus `settle` ms for its prompt), or after `timeout` ms. */
export async function waitForOutput(
  session: TerminalSession,
  timeout = 4000,
  settle = 300,
) {
  const end = Date.now() + timeout;
  while (!session.sawOutput && !session.exited && Date.now() < end)
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, settle));
}

/** Ends the shell (if still running) and forgets the session. */
export async function closeSession(id: string) {
  const at = sessions.findIndex((s) => s.id === id);
  if (at < 0) return;
  const [s] = sessions.splice(at, 1);
  if (active === id) active = sessions[Math.max(0, at - 1)]?.id ?? null;
  if (!s.exited)
    await bridge()
      .kill(id)
      .catch(() => undefined);
  s.term.dispose();
  s.host.remove();
  changed();
}

/** Re-fits a session to its container (after a tab switch or window resize). */
export function fitSession(s: TerminalSession) {
  if (!s.host.isConnected || !s.host.clientWidth) return;
  try {
    s.fit.fit();
  } catch {
    /* not measurable yet */
  }
}
