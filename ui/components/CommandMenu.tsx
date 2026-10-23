import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Bot, Zap } from "lucide-react";
import {
  FEATURE_GROUPS,
  FEATURES,
  matchScore,
  searchFeatures,
  type FeatureId,
} from "../features";
import "./command-menu.css";

export type PaletteAction = {
  id: string;
  name: string;
  description: string;
  keywords?: string;
  run: () => void;
};
export type PaletteAgent = { id: string; name: string; detail: string };
type Entry =
  | { type: "feature"; id: FeatureId; name: string; description: string }
  | {
      type: "mainView";
      id: string;
      name: string;
      description: string;
      shortcut: string;
    }
  | { type: "agent"; id: string; name: string; description: string }
  | {
      type: "action";
      id: string;
      name: string;
      description: string;
      run: () => void;
    };

/**
 * Search every main view, feature, agent and action from one palette. With an empty query it lists
 * main views first; typing searches across all entries. Arrow keys move, Enter opens,
 * Escape closes and returns focus to the opener.
 */
export function CommandMenu({
  open: openFeature,
  agents,
  actions,
  selectAgent,
  selectMainView,
  currentMainView,
  close,
  openTabs,
}: {
  open: (id: FeatureId) => void;
  agents: PaletteAgent[];
  actions: PaletteAction[];
  selectAgent: (id: string) => void;
  selectMainView: (id: string) => void;
  currentMainView: string;
  close: () => void;
  /** Feature tabs already open (marked in the list). */
  openTabs: FeatureId[];
}) {
  const [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLUListElement>(null);
  const searching = query.trim().length > 0;
  const modKey = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";
  const mainViews = useMemo<Extract<Entry, { type: "mainView" }>[]>(
    () => [
      { type: "mainView", id: "canvas", name: "Layout", description: "Team graph and agent setup", shortcut: `${modKey}1` },
      { type: "mainView", id: "team-chat", name: "Chat", description: "Agent and group conversations", shortcut: `${modKey}2` },
      { type: "mainView", id: "files", name: "Files", description: "Browse and edit project files", shortcut: `${modKey}3` },
      { type: "mainView", id: "review", name: "Diff", description: "Review pending file changes", shortcut: `${modKey}4` },
    ],
    [modKey],
  );
  const entries: Entry[] = useMemo(() => {
    if (!searching)
      return [...mainViews, ...FEATURE_GROUPS.flatMap((g) =>
        FEATURES.filter((f) => f.group === g).map((f) => ({
          type: "feature" as const,
          id: f.id,
          name: f.name,
          description: f.description,
        })),
      )];
    const main: Entry[] = mainViews.filter((v) =>
      matchScore(query, v.name, `${v.description} ${v.shortcut}`) > 0,
    );
    const features: Entry[] = searchFeatures(query).map((f) => ({
      type: "feature",
      id: f.id,
      name: f.name,
      description: f.description,
    }));
    const people: Entry[] = agents
      .map((a) => ({ a, s: matchScore(query, a.name, a.detail) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 8)
      .map(({ a }) => ({
        type: "agent",
        id: a.id,
        name: a.name,
        description: a.detail,
      }));
    const acts: Entry[] = actions
      .map((a) => ({
        a,
        s: matchScore(query, a.name, a.description + " " + (a.keywords ?? "")),
      }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .map(({ a }) => ({
        type: "action",
        id: a.id,
        name: a.name,
        description: a.description,
        run: a.run,
      }));
    return [...main, ...features, ...acts, ...people];
  }, [query, agents, actions, searching, mainViews]);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = (e: Entry) => {
    close();
    if (e.type === "feature") openFeature(e.id);
    else if (e.type === "mainView") selectMainView(e.id);
    else if (e.type === "agent") selectAgent(e.id);
    else e.run();
  };
  const optionId = (i: number) => "palette-option-" + i;
  // Section headings: the feature groups when browsing, result kinds when searching.
  const heading = (e: Entry, i: number) => {
    const prev = entries[i - 1];
    if (!searching) {
      if (e.type === "mainView")
        return !prev || prev.type !== "mainView" ? "Main views" : null;
      const g = FEATURES.find((f) => f.id === e.id)?.group;
      const pg = prev?.type === "feature"
        ? FEATURES.find((f) => f.id === prev.id)?.group
        : null;
      return !prev || g !== pg ? g : null;
    }
    if (prev && prev.type === e.type) return null;
    return e.type === "mainView"
      ? "Main views"
      : e.type === "feature"
        ? "Features"
        : e.type === "action"
          ? "Actions"
          : "Agents";
  };
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
      >
        <div className="palette-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            data-autofocus
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={
              entries.length ? optionId(cursor) : undefined
            }
            aria-label="Search views, agents and actions"
            placeholder="Search views, agents and actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!entries.length) return;
                setCursor(
                  (c) =>
                    (c + (e.key === "ArrowDown" ? 1 : -1) + entries.length) %
                    entries.length,
                );
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (entries[cursor]) choose(entries[cursor]);
              }
            }}
          />
          <button
            className="icon"
            aria-label="Close command palette"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>
        <ul
          id="palette-list"
          ref={list}
          role="listbox"
          aria-label={searching ? "Results" : "All views"}
          className="palette-list"
        >
          {entries.map((e, i) => {
            const h = heading(e, i);
            return (
              <li key={e.type + e.id} role="presentation">
                {h && (
                  <div className="palette-group" role="presentation">
                    {h}
                  </div>
                )}
                <div
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === cursor}
                  aria-label={e.type === "agent" ? `${e.name} (agent)` : e.name}
                  className={"palette-option" + (i === cursor ? " active" : "")}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => choose(e)}
                >
                  {e.type === "agent" ? (
                    <Bot size={15} aria-hidden="true" />
                  ) : e.type === "action" ? (
                    <Zap size={15} aria-hidden="true" />
                  ) : null}
                  <span className="palette-text">
                    <b>{e.name}</b>
                    <small>{e.description}</small>
                  </span>
                  {e.type === "feature" && openTabs.includes(e.id) && (
                    <span className="palette-open">open</span>
                  )}
                  {e.type === "mainView" && (
                    <>
                      {currentMainView === e.id && (
                        <span className="palette-open">current</span>
                      )}
                      <kbd className="palette-shortcut">{e.shortcut}</kbd>
                    </>
                  )}
                </div>
              </li>
            );
          })}
          {!entries.length && (
            <li className="palette-empty" role="presentation">
              Nothing matches “{query}”.
            </li>
          )}
        </ul>
        <footer className="palette-foot" aria-hidden="true">
          <span>↑↓ move</span>
          <span>Enter open</span>
          <span>Esc close</span>
        </footer>
      </section>
    </div>
  );
}
