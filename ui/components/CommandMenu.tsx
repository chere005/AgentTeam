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
  | { type: "agent"; id: string; name: string; description: string }
  | {
      type: "action";
      id: string;
      name: string;
      description: string;
      run: () => void;
    };

/**
 * The single entry to everything beyond the canvas and chat: opened by the top-bar "More" button
 * or Ctrl/Cmd+K. With an empty query it is the grouped "More" menu (every feature with a one-line
 * description); typing searches features, agents and actions. Arrow keys move, Enter opens,
 * Escape closes and returns focus to the opener.
 */
export function CommandMenu({
  open: openFeature,
  agents,
  actions,
  selectAgent,
  close,
  openTabs,
}: {
  open: (id: FeatureId) => void;
  agents: PaletteAgent[];
  actions: PaletteAction[];
  selectAgent: (id: string) => void;
  close: () => void;
  /** Feature tabs already open (marked in the list). */
  openTabs: FeatureId[];
}) {
  const [query, setQuery] = useState(""),
    [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLUListElement>(null);
  const searching = query.trim().length > 0;
  const entries: Entry[] = useMemo(() => {
    if (!searching)
      return FEATURE_GROUPS.flatMap((g) =>
        FEATURES.filter((f) => f.group === g).map((f) => ({
          type: "feature" as const,
          id: f.id,
          name: f.name,
          description: f.description,
        })),
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
    return [...features, ...acts, ...people];
  }, [query, agents, actions, searching]);
  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = (e: Entry) => {
    close();
    if (e.type === "feature") openFeature(e.id);
    else if (e.type === "agent") selectAgent(e.id);
    else e.run();
  };
  const optionId = (i: number) => "palette-option-" + i;
  // Section headings: the feature groups when browsing, result kinds when searching.
  const heading = (e: Entry, i: number) => {
    const prev = entries[i - 1];
    if (!searching) {
      const g = FEATURES.find((f) => f.id === e.id)?.group;
      const pg = prev && FEATURES.find((f) => f.id === prev.id)?.group;
      return !prev || g !== pg ? g : null;
    }
    if (prev && prev.type === e.type) return null;
    return e.type === "feature"
      ? "Views"
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
