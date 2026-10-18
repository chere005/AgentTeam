/** Pure workspace-layout logic: presets, sanitising stored state, user edits. No React/DOM. */
export const PANE_IDS = [
  "chat",
  "team",
  "workflows",
  "workspace",
  "skills",
  "settings",
  "activity",
  "resources",
  "teams",
  "inbox",
  "inspector",
  "capabilities",
  "assistant",
  "graphs",
] as const;
export type PaneId = (typeof PANE_IDS)[number];
export type PaneLayout = {
  main: PaneId;
  right: PaneId;
  showLeft: boolean;
  showRight: boolean;
  rightWidth: number;
};
export type NamedLayout = { id: string; name: string; layout: PaneLayout };
export const MIN_WIDTH = 300,
  MAX_WIDTH = 650;
/** New layouts: canvas in the middle, conversation on the right. */
export const defaultLayout: PaneLayout = {
  main: "team",
  right: "chat",
  showLeft: true,
  showRight: true,
  rightWidth: 440,
};
export const clampWidth = (w: unknown) =>
  typeof w === "number" && Number.isFinite(w)
    ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
    : defaultLayout.rightWidth;
const isPane = (v: unknown): v is PaneId =>
  typeof v === "string" && (PANE_IDS as readonly string[]).includes(v);
/** Accepts anything read from storage; invalid fields fall back to `base`. */
export function sanitizeLayout(
  value: unknown,
  base: PaneLayout = defaultLayout,
): PaneLayout {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    main: isPane(v.main) ? v.main : base.main,
    right: isPane(v.right) ? v.right : base.right,
    showLeft: typeof v.showLeft === "boolean" ? v.showLeft : base.showLeft,
    showRight: typeof v.showRight === "boolean" ? v.showRight : base.showRight,
    rightWidth: "rightWidth" in v ? clampWidth(v.rightWidth) : base.rightWidth,
  };
}
export const presetLayouts: NamedLayout[] = [
  {
    id: "planning",
    name: "Planning",
    layout: { ...defaultLayout, main: "team", right: "chat" },
  },
  {
    id: "coding",
    name: "Coding",
    layout: {
      main: "workspace",
      right: "chat",
      showLeft: false,
      showRight: true,
      rightWidth: 480,
    },
  },
  {
    id: "review",
    name: "Review",
    layout: {
      main: "workspace",
      right: "workflows",
      showLeft: false,
      showRight: true,
      rightWidth: 520,
    },
  },
  {
    id: "monitoring",
    name: "Monitoring",
    layout: {
      main: "team",
      right: "inbox",
      showLeft: false,
      showRight: true,
      rightWidth: 420,
    },
  },
];
export type LayoutStore = {
  /** Edited copies of built-in presets, by preset id. */
  overrides: Record<string, PaneLayout>;
  /** User-created layouts. */
  custom: NamedLayout[];
};
export const emptyStore: LayoutStore = { overrides: {}, custom: [] };
export function sanitizeStore(value: unknown): LayoutStore {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    any
  >;
  const overrides: Record<string, PaneLayout> = {};
  for (const p of presetLayouts)
    if (v.overrides?.[p.id])
      overrides[p.id] = sanitizeLayout(v.overrides[p.id], p.layout);
  const seen = new Set<string>(presetLayouts.map((p) => p.id));
  const custom: NamedLayout[] = [];
  if (Array.isArray(v.custom))
    for (const c of v.custom) {
      if (!c || typeof c.id !== "string" || typeof c.name !== "string")
        continue;
      const name = c.name.trim().slice(0, 40);
      if (!name || seen.has(c.id)) continue;
      seen.add(c.id);
      custom.push({ id: c.id, name, layout: sanitizeLayout(c.layout) });
    }
  return { overrides, custom };
}
/** Presets (with edits applied) followed by custom layouts. */
export function allLayouts(store: LayoutStore): (NamedLayout & {
  builtin: boolean;
  edited: boolean;
})[] {
  return [
    ...presetLayouts.map((p) => ({
      ...p,
      layout: store.overrides[p.id] ?? p.layout,
      builtin: true,
      edited: p.id in store.overrides,
    })),
    ...store.custom.map((c) => ({ ...c, builtin: false, edited: false })),
  ];
}
/** Overwrite a layout with the current panes (editing a preset stores an override). */
export function updateLayout(
  store: LayoutStore,
  id: string,
  layout: PaneLayout,
): LayoutStore {
  if (presetLayouts.some((p) => p.id === id))
    return { ...store, overrides: { ...store.overrides, [id]: layout } };
  return {
    ...store,
    custom: store.custom.map((c) => (c.id === id ? { ...c, layout } : c)),
  };
}
export function addLayout(
  store: LayoutStore,
  name: string,
  layout: PaneLayout,
  id: string,
): LayoutStore {
  const clean = name.trim().slice(0, 40);
  if (!clean) return store;
  return { ...store, custom: [...store.custom, { id, name: clean, layout }] };
}
export function renameLayout(
  store: LayoutStore,
  id: string,
  name: string,
): LayoutStore {
  const clean = name.trim().slice(0, 40);
  if (!clean) return store;
  return {
    ...store,
    custom: store.custom.map((c) => (c.id === id ? { ...c, name: clean } : c)),
  };
}
/** Custom layouts are deleted; presets are reset to their built-in definition. */
export function removeLayout(store: LayoutStore, id: string): LayoutStore {
  const overrides = { ...store.overrides };
  delete overrides[id];
  return { overrides, custom: store.custom.filter((c) => c.id !== id) };
}
