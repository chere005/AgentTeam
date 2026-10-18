import { useEffect, useRef, useState } from "react";
import { LayoutDashboard } from "lucide-react";
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
import { teamKey, MAIN_TEAM_ID } from "../team-view";
import "./layout-menu.css";

/** The layout preset a team last chose (layouts are per team), or null. */
export function rememberedLayout(teamId: string): PaneLayout | null {
  const id = saved<string>(teamKey("layouts.active", teamId), "");
  if (!id) return null;
  return (
    allLayouts(sanitizeStore(saved(teamKey("layouts", teamId), null))).find(
      (l) => l.id === id,
    )?.layout ?? null
  );
}

/** Menu of saved workspace layouts (planning/coding/review/monitoring plus user-defined). */
export function LayoutMenu({
  current,
  apply,
  teamId = MAIN_TEAM_ID,
}: {
  current: PaneLayout;
  apply: (l: PaneLayout) => void;
  /** Layouts and the chosen preset are remembered per team (Main keeps the legacy keys). */
  teamId?: string;
}) {
  const storeKey = teamKey("layouts", teamId),
    activeKey = teamKey("layouts.active", teamId);
  const [store, setStore] = useState<LayoutStore>(() =>
      sanitizeStore(saved(storeKey, null)),
    ),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(() => saved<string>(activeKey, "")),
    [name, setName] = useState(""),
    [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
      null,
    );
  const root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null);
  const commit = (next: LayoutStore) => {
    setStore(next);
    try {
      persist(storeKey, next);
    } catch {
      /* storage unavailable */
    }
  };
  const choose = (id: string) => {
    setActive(id);
    try {
      persist(activeKey, id);
    } catch {
      /* storage unavailable */
    }
  };
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const layouts = allLayouts(store);
  return (
    <div className="layout-menu" ref={root}>
      <button
        ref={button}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <LayoutDashboard size={16} />
        Layouts
      </button>
      {open && (
        <div
          className="layout-popup"
          role="group"
          aria-label="Workspace layouts"
        >
          <ul>
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
                        setOpen(false);
                        button.current?.focus();
                      }}
                    >
                      {l.name}
                      {l.edited ? " (edited)" : ""}
                    </button>
                    <button
                      aria-label={`Update ${l.name} from current panes`}
                      title="Replace this layout with the current panes"
                      onClick={() => {
                        commit(updateLayout(store, l.id, current));
                        choose(l.id);
                      }}
                    >
                      Update
                    </button>
                    {!l.builtin && (
                      <button
                        aria-label={`Rename ${l.name}`}
                        onClick={() => setRenaming({ id: l.id, name: l.name })}
                      >
                        Rename
                      </button>
                    )}
                    {(!l.builtin || l.edited) && (
                      <button
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
              placeholder="Save current panes as…"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={!name.trim()}>
              Save
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
