/**
 * Feature registry for progressive disclosure (pure, no React/DOM; unit-tested in
 * test/ui-logic.test.ts). Layout, Chat, Files and Diff are the permanent main views; other pages
 * are features opened on request (More menu, command palette, contextual buttons) as closable tabs.
 */
export const FEATURE_IDS = [
  "projects",
  "review",
  "graphs",
  "trace",
  "assistant",
  "files",
  "git",
  "preview",
  "terminal",
  "library",
  "team-settings",
  "capabilities",
  "access",
  "inbox",
  "inspector",
  "usage",
  "recovery",
  "shared",
  "activity",
  "settings",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
/** The permanent first tab. */
export const CANVAS = "canvas";
export type TabId = FeatureId | typeof CANVAS;
export type FeatureGroup = "Work" | "Workspace" | "Team setup" | "Monitoring";
export type Feature = {
  id: FeatureId;
  name: string;
  group: FeatureGroup | null;
  /** One line: what this page is for. */
  description: string;
  /** Extra search words (old pane names, synonyms). */
  keywords: string;
};
export const FEATURES: readonly Feature[] = [
  {
    id: "projects",
    name: "Projects",
    group: "Work",
    description: "Assign work to this team and follow its tasks and gates.",
    keywords: "workflows tasks assign project routing rules",
  },
  {
    id: "review",
    name: "Diff",
    group: "Work",
    description: "Compare and review changes in the current project workspace.",
    keywords: "diff review changes comments approve",
  },
  {
    id: "graphs",
    name: "Step-by-step runs",
    group: "Work",
    description:
      "Build a reusable sequence of agent tasks, approvals and checks.",
    keywords: "workflow graphs graph steps commands approvals gates run",
  },
  {
    id: "trace",
    name: "Project trace",
    group: "Work",
    description:
      "Explore project communications, events and produced files on one timeline.",
    keywords:
      "trace communication graph timeline quick look evaluation project",
  },
  {
    id: "assistant",
    name: "Assistant changes",
    group: "Work",
    description:
      "Approve or reject team changes proposed by the Team Assistant.",
    keywords: "proposals assistant apply",
  },
  {
    id: "files",
    name: "Files",
    group: "Workspace",
    description:
      "Browse, preview and edit files in the current project workspace.",
    keywords: "workspace browse folder open editor",
  },
  {
    id: "git",
    name: "Git",
    group: "Workspace",
    description: "Branches, staging, commits, push and pull, worktrees.",
    keywords: "commit branch worktree push pull repository",
  },
  {
    id: "preview",
    name: "Preview",
    group: "Workspace",
    description: "Run a local dev server and preview the app it serves.",
    keywords: "dev server browser localhost",
  },
  {
    id: "terminal",
    name: "Terminal",
    group: "Workspace",
    description:
      "Your own shell in a home, project or agent folder, with tabs and search.",
    keywords: "shell console command line pty bash zsh powershell",
  },
  {
    id: "library",
    name: "Team library",
    group: "Team setup",
    description: "Example teams, saved teams and team packs to insert.",
    keywords: "saved teams templates examples packs insert",
  },
  {
    id: "team-settings",
    name: "Team settings",
    group: "Team setup",
    description:
      "This team's roles, worker counts, model check, name and description.",
    keywords: "team profile workers count roles lead model check rename",
  },
  {
    id: "capabilities",
    name: "Skills, tools & knowledge",
    group: "Team setup",
    description: "The skill library, tool grants and knowledge sources.",
    keywords: "skills library tools mcp knowledge instructions",
  },
  {
    id: "access",
    name: "Access & resources",
    group: "Team setup",
    description:
      "Who may read or edit which folders, shared locks, parallel work.",
    keywords: "resources access permissions locks cooperation parallel",
  },
  {
    id: "inbox",
    name: "Inbox",
    group: "Monitoring",
    description: "Approvals, failures and anything else waiting for you.",
    keywords: "attention approvals notifications",
  },
  {
    id: "inspector",
    name: "Timeline & inspector",
    group: "Monitoring",
    description:
      "What happened and why something waits; playground and export.",
    keywords: "run inspector timeline waiting transfers playground diagnostics",
  },
  {
    id: "usage",
    name: "Usage & limits",
    group: "Monitoring",
    description:
      "Reported token use by project and agent, plus project limits and provider reporting status.",
    keywords:
      "tokens usage subscription quota provider limits cost agent project",
  },
  {
    id: "recovery",
    name: "Recovery",
    group: "Monitoring",
    description: "Resume interrupted or blocked tasks after a restart.",
    keywords: "checkpoint interrupted blocked resume",
  },
  {
    id: "shared",
    name: "Shared state",
    group: "Monitoring",
    description: "Shared project fields, their history and saved artifacts.",
    keywords: "state memory artifacts fields",
  },
  {
    id: "activity",
    name: "Activity log",
    group: "Monitoring",
    description: "The raw event stream of this team.",
    keywords: "events log",
  },
  {
    id: "settings",
    name: "Settings",
    group: null,
    description: "Execution, agent connections, editors and layouts.",
    keywords: "preferences layouts harness runtime editor execution",
  },
];
export const FEATURE_GROUPS: FeatureGroup[] = [
  "Work",
  "Workspace",
  "Team setup",
  "Monitoring",
];
export const isFeature = (v: unknown): v is FeatureId =>
  typeof v === "string" && (FEATURE_IDS as readonly string[]).includes(v);
export const feature = (id: FeatureId) => FEATURES.find((f) => f.id === id)!;
export const tabName = (id: TabId) =>
  id === CANVAS ? "Layout" : feature(id).name;

/**
 * Match score of `query` against a name (+ extra text); 0 = no match. Prefix of the name beats
 * a word start, which beats a substring; every query word must match somewhere.
 */
export function matchScore(query: string, name: string, extra = ""): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const n = name.toLowerCase(),
    all = (name + " " + extra).toLowerCase();
  let score = 0;
  for (const word of q.split(/\s+/)) {
    if (n.startsWith(word)) score += 3;
    else if (
      new RegExp("\\b" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(all)
    )
      score += 2;
    else if (all.includes(word)) score += 1;
    else return 0;
  }
  return score + (n === q ? 5 : 0);
}
export function searchFeatures(query: string): Feature[] {
  return FEATURES.map((f, i) => ({
    f,
    i,
    s: matchScore(query, f.name, f.description + " " + f.keywords),
  }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}

/** Open feature tabs of one team. Layout is always first and never stored. */
export type TabState = { tabs: FeatureId[]; active: TabId };
export const startTabs: TabState = { tabs: [], active: CANVAS };
export function sanitizeTabs(value: unknown): TabState {
  const v = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const tabs = Array.isArray(v.tabs)
    ? [...new Set(v.tabs.filter(isFeature))].slice(0, FEATURE_IDS.length)
    : [];
  const active =
    v.active === CANVAS || (isFeature(v.active) && tabs.includes(v.active))
      ? (v.active as TabId)
      : CANVAS;
  return { tabs, active };
}
/** Open (or focus) a feature tab; new tabs are appended. */
export function openTab(state: TabState, id: TabId): TabState {
  if (id === CANVAS) return { ...state, active: CANVAS };
  return {
    tabs: state.tabs.includes(id) ? state.tabs : [...state.tabs, id],
    active: id,
  };
}
/** Close a tab; when it was active, its left neighbour (or the canvas) becomes active. */
export function closeTab(state: TabState, id: FeatureId): TabState {
  const at = state.tabs.indexOf(id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((t) => t !== id);
  const active =
    state.active === id ? (at > 0 ? tabs[at - 1] : CANVAS) : state.active;
  return { tabs, active };
}
