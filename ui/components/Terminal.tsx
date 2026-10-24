import type React from "react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import type { Snapshot } from "../api";
import {
  SEARCH_DECORATIONS,
  TERMINAL_CANVAS,
  terminalFolders,
} from "../terminal-theme";
import {
  activeSession,
  closeSession,
  copyOnSelect,
  fitSession,
  listSessions,
  openSession,
  setActive,
  snapshotVersion,
  subscribe,
} from "../terminal-sessions";
import "./terminal.css";

/**
 * Terminal tab: the user's own shells as sub-tabs (xterm.js renderer, node-pty in the main
 * process). Sessions outlive this component (ui/terminal-sessions.ts), so switching feature
 * tabs keeps scrollback and running programs.
 */
export function TerminalView({
  data,
  currentProject,
}: {
  data: Snapshot;
  currentProject?: Snapshot["workflows"][number] | null;
}) {
  useSyncExternalStore(subscribe, snapshotVersion);
  const sessions = listSessions();
  const current = activeSession();
  const stage = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  const projectWorkspace = currentProject?.setup?.workspace ?? null;
  const folders = useMemo(
    () => terminalFolders(data, projectWorkspace),
    [data, projectWorkspace],
  );
  const [folder, setFolder] = useState<string>(projectWorkspace ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchFocus, setSearchFocus] = useState(0);
  useEffect(() => {
    if (searchFocus) searchInput.current?.select();
  }, [searchFocus]);
  const available = !!window.agentteam?.terminal;

  const start = async () => {
    if (!stage.current || busy) return;
    setBusy(true);
    setError("");
    try {
      const chosen = folders.some((f) => f.path === folder) ? folder : "";
      const s = await openSession(stage.current, chosen || null);
      s.term.focus();
    } catch (e) {
      setError(
        String(e instanceof Error ? e.message : e).replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  // First visit: open one shell in the current project's folder (or home).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !available) return;
    opened.current = true;
    if (!listSessions().length) void start();
  }, []);

  // Re-attach the live sessions' DOM to this view; only the active one is visible.
  useLayoutEffect(() => {
    const host = stage.current;
    if (!host) return;
    for (const s of sessions) {
      if (s.host.parentElement !== host) host.appendChild(s.host);
      s.host.hidden = s !== current;
    }
    if (current) {
      fitSession(current);
      // Focus a session when it becomes the visible one, not on every render.
      if (focused.current !== current.id && !searching) current.term.focus();
      focused.current = current.id;
    }
  });
  useEffect(
    () => () => {
      for (const s of listSessions()) s.host.remove();
    },
    [],
  );

  // Resize-to-fit: follow the stage size (window resize, side panel toggles).
  useEffect(() => {
    const host = stage.current;
    if (!host) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const s = activeSession();
        if (s) fitSession(s);
      });
    });
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // Cmd/Ctrl+F inside the terminal (ui/terminal-sessions.ts key handler).
  useEffect(() => {
    const open = () => {
      setSearching(true);
      setSearchFocus((n) => n + 1);
    };
    window.addEventListener("agentteam:terminal-search", open);
    return () => window.removeEventListener("agentteam:terminal-search", open);
  }, []);
  useEffect(() => {
    if (!current) return;
    const sub = current.search.onDidChangeResults(
      ({ resultIndex, resultCount }) =>
        setResults({ index: resultIndex, count: resultCount }),
    );
    return () => sub.dispose();
  }, [current?.id]);

  const decorations = SEARCH_DECORATIONS;
  const find = (backwards = false, incremental = false) => {
    if (!current || !query) {
      current?.search.clearDecorations();
      setResults({ index: -1, count: 0 });
      return;
    }
    const options = { decorations, incremental };
    if (backwards) current.search.findPrevious(query, options);
    else current.search.findNext(query, options);
  };
  const closeSearch = () => {
    setSearching(false);
    current?.search.clearDecorations();
    current?.term.clearSelection();
    current?.term.focus();
  };
  const mod = window.agentteam?.platform === "darwin" ? "⌘" : "Ctrl+";

  return (
    <div
      className="terminal-pane"
      data-testid="terminal-pane"
      // Canvas colours as inline custom properties: the light-theme PostCSS twin
      // (ui/theme-light.ts) would otherwise mirror the dark canvas to white.
      style={TERMINAL_CANVAS as React.CSSProperties}
    >
      <div className="terminal-toolbar">
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label="Terminal sessions"
        >
          {sessions.map((s) => (
            <div
              key={s.id}
              className={"terminal-tab" + (s === current ? " active" : "")}
            >
              <button
                role="tab"
                aria-selected={s === current}
                title={`${s.shell} in ${s.cwd}`}
                onClick={() => setActive(s.id)}
              >
                <SquareTerminal size={13} aria-hidden />
                <span>{s.title}</span>
                {s.exited && <em className="terminal-ended">ended</em>}
              </button>
              <button
                className="terminal-tab-close"
                aria-label={`Close terminal ${s.title}`}
                title="Close (ends the shell)"
                onClick={() => void closeSession(s.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <select
            aria-label="Folder for new terminals"
            value={folders.some((f) => f.path === folder) ? folder : ""}
            onChange={(e) => setFolder(e.target.value)}
          >
            {folders.map((f) => (
              <option key={f.path ?? ""} value={f.path ?? ""}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => void start()}
            disabled={busy || !available}
            title="Open a new shell in the chosen folder"
          >
            <Plus size={14} /> New terminal
          </button>
          <button
            className={"icon" + (searching ? " active" : "")}
            aria-label="Find in terminal"
            title={`Find (${mod}F)`}
            onClick={() =>
              searching
                ? closeSearch()
                : window.dispatchEvent(
                    new CustomEvent("agentteam:terminal-search"),
                  )
            }
          >
            <Search size={15} />
          </button>
          <label className="inline terminal-check">
            <input
              type="checkbox"
              checked={copyOnSelect.get()}
              onChange={(e) => copyOnSelect.set(e.target.checked)}
            />
            Copy on select
          </label>
        </div>
      </div>
      {searching && (
        <div className="terminal-search" role="search">
          <input
            ref={searchInput}
            aria-label="Search terminal output"
            placeholder="Find in output"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (current && e.target.value)
                current.search.findNext(e.target.value, {
                  decorations,
                  incremental: true,
                });
              else {
                current?.search.clearDecorations();
                setResults({ index: -1, count: 0 });
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                find(e.shiftKey);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeSearch();
              }
            }}
          />
          <span className="terminal-count" aria-live="polite">
            {query
              ? results.count
                ? `${results.index + 1} of ${results.count}`
                : "No matches"
              : ""}
          </span>
          <button
            className="icon"
            aria-label="Previous match"
            onClick={() => find(true)}
          >
            <ChevronUp size={15} />
          </button>
          <button
            className="icon"
            aria-label="Next match"
            onClick={() => find()}
          >
            <ChevronDown size={15} />
          </button>
          <button
            className="icon"
            aria-label="Close search"
            onClick={closeSearch}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {error && (
        <p className="terminal-error" role="alert">
          {error}
        </p>
      )}
      <div className="terminal-stage" ref={stage}>
        {!available && (
          <p className="terminal-empty">
            The terminal is only available in the AgentTeam desktop app.
          </p>
        )}
        {available && !sessions.length && !busy && (
          <p className="terminal-empty">
            No terminal open. Choose a folder and press New terminal.
          </p>
        )}
      </div>
      <p className="terminal-note">
        This is your own shell, running with your permissions. AgentTeam's agent
        locks, folder leases and access rules do not apply to it. {mod}click
        opens a link
        {window.agentteam?.platform === "darwin"
          ? ""
          : "; Ctrl+Shift+C / Ctrl+Shift+V copy and paste"}
        .
      </p>
    </div>
  );
}
