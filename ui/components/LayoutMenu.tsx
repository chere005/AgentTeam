import { useState } from "react";
import { saved, persist } from "../api";
import {
  addLayout,
  allLayouts,
  removeLayout,
  renameLayout,
  sanitizeStore,
  updateLayout,
  type LayoutStore,
  type PaneLayout,
} from "../workspace";
import { tabName } from "../features";
import { teamKey, MAIN_TEAM_ID } from "../team-view";
import "./layout-menu.css";

const describe = (l: PaneLayout) =>
  ["Canvas", ...l.tabs.map(tabName)].join(", ") +
  (l.showRight ? " · side panel" : "");

/**
 * Settings → Layouts: saved sets of open tabs (per team). Built-in presets can be edited and
 * reset; custom layouts can be added, renamed and deleted. Nothing here is needed to reach a
 * feature; layouts only reopen a set of tabs in one step.
 */
export function LayoutSettings({
  current,
  apply,
  teamId = MAIN_TEAM_ID,
}: {
  current: PaneLayout;
  apply: (l: PaneLayout) => void;
  teamId?: string;
}) {
  const storeKey = teamKey("layouts", teamId),
    activeKey = teamKey("layouts.active", teamId);
  const [store, setStore] = useState<LayoutStore>(() =>
      sanitizeStore(saved(storeKey, null)),
    ),
    [active, setActive] = useState(() => saved<string>(activeKey, "")),
    [name, setName] = useState(""),
    [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
      null,
    );
  const commit = (next: LayoutStore) => {
    setStore(next);
    persist(storeKey, next);
  };
  const choose = (id: string) => {
    setActive(id);
    persist(activeKey, id);
  };
  const layouts = allLayouts(store);
  return (
    <section
      className="settings-card layout-settings"
      aria-labelledby="layouts-heading"
    >
      <h3 id="layouts-heading">Layouts</h3>
      <p>
        A layout reopens a set of tabs in one step. Layouts are saved for this
        team.
      </p>
      <ul className="layout-list" aria-label="Workspace layouts">
        {layouts.map((l) => (
          <li key={l.id} className={active === l.id ? "active" : ""}>
            {renaming?.id === l.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  commit(renameLayout(store, l.id, renaming.name));
                  setRenaming(null);
                }}
              >
                <input
                  aria-label="Layout name"
                  autoFocus
                  value={renaming.name}
                  onChange={(e) =>
                    setRenaming({ id: l.id, name: e.target.value })
                  }
                />
                <button type="submit">Save</button>
              </form>
            ) : (
              <>
                <button
                  className="layout-apply"
                  aria-pressed={active === l.id}
                  onClick={() => {
                    apply(l.layout);
                    choose(l.id);
                  }}
                >
                  {l.name}
                  {l.edited ? " (edited)" : ""}
                </button>
                <small className="quiet layout-desc">
                  {describe(l.layout)}
                </small>
                <button
                  className="text-button"
                  aria-label={`Update ${l.name} from current tabs`}
                  title="Replace this layout with the tabs open now"
                  onClick={() => {
                    commit(updateLayout(store, l.id, current));
                    choose(l.id);
                  }}
                >
                  Update
                </button>
                {!l.builtin && (
                  <button
                    className="text-button"
                    aria-label={`Rename ${l.name}`}
                    onClick={() => setRenaming({ id: l.id, name: l.name })}
                  >
                    Rename
                  </button>
                )}
                {(!l.builtin || l.edited) && (
                  <button
                    className="text-button"
                    aria-label={
                      l.builtin ? `Reset ${l.name}` : `Delete ${l.name}`
                    }
                    onClick={() => commit(removeLayout(store, l.id))}
                  >
                    {l.builtin ? "Reset" : "Delete"}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="layout-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          const id = "custom-" + Date.now().toString(36);
          commit(addLayout(store, name, current, id));
          choose(id);
          setName("");
        }}
      >
        <input
          aria-label="New layout name"
          placeholder="Save the open tabs as…"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          Save layout
        </button>
      </form>
    </section>
  );
}
