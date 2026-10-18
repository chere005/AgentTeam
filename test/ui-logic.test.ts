import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INSTRUCTION_SOFT_LIMIT,
  instructionLengthHint,
  sparklinePoints,
} from "../ui/instruction-length.ts";
import {
  allLayouts,
  clampWidth,
  defaultLayout,
  presetLayouts,
  removeLayout,
  sanitizeLayout,
  sanitizeStore,
  updateLayout,
  addLayout,
  renameLayout,
} from "../ui/workspace.ts";
import { buildInbox } from "../ui/inbox.ts";
import {
  FEATURES,
  FEATURE_GROUPS,
  closeTab,
  matchScore,
  openTab,
  sanitizeTabs,
  searchFeatures,
  startTabs,
} from "../ui/features.ts";
import {
  createGroup,
  descendants,
  hiddenAgents,
  relatives,
  sanitizeGroups,
  stepSibling,
  summarizeGroup,
  toggleGroup,
  visibleEdges,
} from "../ui/groups.ts";

test("layout sanitising falls back to Canvas only with the side panel (first run)", () => {
  assert.deepEqual(sanitizeLayout(undefined), defaultLayout);
  assert.deepEqual(sanitizeLayout("junk"), defaultLayout);
  assert.deepEqual(defaultLayout.tabs, []);
  assert.equal(defaultLayout.active, "canvas");
  assert.equal(defaultLayout.showRight, true);
  const l = sanitizeLayout({
    tabs: ["inbox", "nope", "inbox", "files"],
    active: "nope",
    rightWidth: 99999,
    showRight: "x",
  });
  assert.deepEqual(l.tabs, ["inbox", "files"]);
  assert.equal(l.active, "canvas");
  assert.equal(l.rightWidth, 650);
  assert.equal(l.showRight, true);
  // The active tab must be open; otherwise the canvas is shown.
  assert.equal(
    sanitizeLayout({ tabs: ["git"], active: "files" }).active,
    "canvas",
  );
  assert.equal(sanitizeLayout({ tabs: ["git"], active: "git" }).active, "git");
  assert.equal(clampWidth(NaN), 440);
});
test("four preset layouts; presets are editable and resettable, custom layouts CRUD", () => {
  assert.deepEqual(
    presetLayouts.map((p) => p.id),
    ["simple", "coding", "review", "monitoring"],
  );
  let store = sanitizeStore(null);
  const edited = {
    ...defaultLayout,
    tabs: ["capabilities" as const],
    active: "capabilities" as const,
  };
  store = updateLayout(store, "coding", edited);
  assert.deepEqual(
    allLayouts(store).find((l) => l.id === "coding")!.layout.tabs,
    ["capabilities"],
  );
  assert.ok(allLayouts(store).find((l) => l.id === "coding")!.edited);
  store = addLayout(store, "  My view ", edited, "custom-1");
  store = addLayout(store, "   ", edited, "custom-2");
  assert.equal(store.custom.length, 1);
  store = renameLayout(store, "custom-1", "Renamed");
  assert.equal(store.custom[0].name, "Renamed");
  store = removeLayout(removeLayout(store, "custom-1"), "coding");
  assert.equal(store.custom.length, 0);
  assert.deepEqual(
    allLayouts(store).find((l) => l.id === "coding")!.layout.tabs,
    ["files", "git"],
  );
  // Corrupt stored data is repaired, preset ids cannot be shadowed by custom entries.
  const bad = sanitizeStore({
    overrides: { coding: { tabs: ["zzz"], active: "zzz" }, other: {} },
    custom: [
      { id: "simple", name: "x", layout: {} },
      { id: "c", name: "ok", layout: { tabs: ["inbox"], active: "inbox" } },
      null,
    ],
  });
  assert.deepEqual(bad.overrides.coding.tabs, []);
  assert.equal(bad.overrides.coding.active, "canvas");
  assert.deepEqual(
    bad.custom.map((c) => c.id),
    ["c"],
  );
});
test("feature registry: every feature named, described and grouped; search ranks names first", () => {
  assert.equal(new Set(FEATURES.map((f) => f.id)).size, FEATURES.length);
  for (const f of FEATURES) {
    assert.ok(f.name && f.description.length > 10, f.id);
    assert.ok(f.group === null || FEATURE_GROUPS.includes(f.group), f.id);
  }
  // Only Settings lives outside the More menu groups (it has its own top-bar gear).
  assert.deepEqual(
    FEATURES.filter((f) => !f.group).map((f) => f.id),
    ["settings"],
  );
  assert.equal(searchFeatures("rev")[0].id, "review");
  assert.equal(searchFeatures("git")[0].id, "git");
  // Old pane names still find their new home.
  assert.equal(searchFeatures("saved teams")[0].id, "library");
  assert.equal(searchFeatures("run inspector")[0].id, "inspector");
  assert.equal(searchFeatures("resources")[0].id, "access");
  assert.deepEqual(searchFeatures("zzzz"), []);
  assert.equal(searchFeatures("").length, FEATURES.length);
  assert.equal(matchScore("x", "Inbox"), 1);
  assert.equal(matchScore("inbox", "Inbox") > matchScore("in", "Inbox"), true);
});
test("tabs: open appends and focuses, close falls back left, stored state is sanitised", () => {
  let t = startTabs;
  assert.deepEqual(t, { tabs: [], active: "canvas" });
  t = openTab(t, "projects");
  t = openTab(t, "inbox");
  t = openTab(t, "projects");
  assert.deepEqual(t, { tabs: ["projects", "inbox"], active: "projects" });
  t = openTab(t, "canvas");
  assert.equal(t.active, "canvas");
  t = openTab(t, "inbox");
  t = closeTab(t, "inbox");
  assert.deepEqual(t, { tabs: ["projects"], active: "projects" });
  t = closeTab(t, "projects");
  assert.deepEqual(t, { tabs: [], active: "canvas" });
  assert.deepEqual(closeTab(t, "git"), t);
  assert.deepEqual(sanitizeTabs({ tabs: ["git", 3, "git"], active: "git" }), {
    tabs: ["git"],
    active: "git",
  });
  assert.deepEqual(sanitizeTabs(null), startTabs);
});

const agents = [
  { id: "a", name: "Alice", parentId: null },
  { id: "b", name: "Bob", parentId: "a" },
  { id: "c", name: "Cy", parentId: "a" },
  { id: "d", name: "Di", parentId: "b" },
] as any[];
test("inbox lists approvals, failed/blocked/interrupted tasks, limit trips, validation gates and ready reviews", () => {
  const task = (id: string, status: string, agentId = "b") => ({
    id,
    title: "T" + id,
    status,
    agentId,
  });
  const data = {
    agents,
    edges: [{ id: "e", from: "b", to: "c", kind: "review", enabled: true }],
    workflows: [
      {
        id: "w1",
        name: "W1",
        paused: true,
        tasks: [
          task("1", "failed"),
          task("2", "interrupted"),
          task("3", "blocked"),
          task("4", "completed"),
          task("5", "queued"),
        ],
      },
      { id: "w2", name: "W2", paused: false, tasks: [task("6", "running")] },
    ],
    activity: [
      {
        agentId: "b",
        state: "idle",
        queuedTasks: [{ id: "5", waitReason: "validation-required" }],
        failedTaskIds: [],
        runningTaskIds: [],
        interruptedTaskIds: [],
        capacity: { running: 0, queued: 1, limit: null },
      },
    ],
  } as any;
  const items = buildInbox({
    data,
    approvals: [
      { id: "p", agentId: "a", request: { toolCall: { title: "Run rm" } } },
    ],
    recovery: [
      {
        task: { id: "3" },
        uncertainEffects: [{ id: "x", description: "email may be sent" }],
      },
    ],
    trips: { w1: { reason: "Maximum of 1 agent turns reached." } },
  });
  const kinds = items.map((i) => i.kind);
  assert.deepEqual(kinds, [
    "approval",
    "blocked",
    "limit",
    "failed",
    "interrupted",
    "validation",
    "review",
  ]);
  assert.match(items[1].detail, /email may be sent/);
  assert.equal(items[0].agentId, "a");
  assert.equal(items.find((i) => i.kind === "review")!.target, "workspace");
  // Paused without a trip is reported as a plain pause; dismissed ids vanish.
  const paused = buildInbox({ data, dismissed: ["failed:1"] });
  assert.ok(paused.some((i) => i.kind === "paused"));
  assert.ok(!paused.some((i) => i.id === "failed:1"));
  assert.deepEqual(
    buildInbox({ data: { agents, edges: [], workflows: [], activity: [] } }),
    [],
  );
});

test("group sanitising, exclusive membership, collapse and edge remapping", () => {
  const ids = ["a", "b", "c", "d"];
  let groups = createGroup([], "Core", ["a", "b"], "g1");
  groups = createGroup(groups, "Other", ["b", "c"], "g2");
  assert.deepEqual(groups.find((g) => g.id === "g1")!.agentIds, ["a"]);
  assert.equal(
    sanitizeGroups([{ id: "x", name: "", agentIds: ["zz"] }], ids).length,
    0,
  );
  assert.equal(sanitizeGroups(groups, ["a"]).length, 1);
  groups = toggleGroup(groups, "g2", true);
  assert.deepEqual([...hiddenAgents(groups).keys()].sort(), ["b", "c"]);
  const edges = [
    { id: "e1", from: "a", to: "b", kind: "delegate", enabled: true },
    { id: "e2", from: "a", to: "c", kind: "delegate", enabled: true },
    { id: "e3", from: "b", to: "c", kind: "review", enabled: true },
    { id: "e4", from: "c", to: "d", kind: "notify", enabled: true },
  ];
  const v = visibleEdges(edges, groups);
  assert.equal(v.length, 2); // e1+e2 merge, e3 internal dropped, e4 remapped
  assert.ok(v.every((e) => e.grouped));
  assert.deepEqual(
    visibleEdges(edges, []).map((e) => e.id),
    ["e1", "e2", "e3", "e4"],
  );
  const s = summarizeGroup(
    groups.find((g) => g.id === "g2")!,
    [
      { agentId: "b", state: "processing", failedTaskIds: [] },
      { agentId: "c", state: "idle", failedTaskIds: ["t"] },
    ],
  );
  assert.deepEqual(s, { members: 2, processing: 1, failed: 1, attention: 0 });
});
test("hierarchy navigation", () => {
  assert.deepEqual(relatives(agents, "b"), {
    parent: "a",
    children: ["d"],
    siblings: ["c"],
  });
  assert.deepEqual(descendants(agents, "a").sort(), ["b", "c", "d"]);
  assert.equal(stepSibling(agents, "b", 1), "c");
  assert.equal(stepSibling(agents, "c", 1), "b");
  assert.equal(stepSibling(agents, "d", 1), null);
  const cyc = [
    { id: "x", parentId: "y" },
    { id: "y", parentId: "x" },
  ];
  assert.deepEqual(descendants(cyc, "x"), ["y"]);
});

test("instruction length hint is soft: guidance when empty, a warning only above the threshold", () => {
  assert.equal(instructionLengthHint("   ").level, "none");
  const ok = instructionLengthHint("Review the diff. Output: JSON verdict.");
  assert.equal(ok.level, "ok");
  assert.equal(ok.approxTokens, Math.ceil(ok.chars / 4));
  assert.equal(
    instructionLengthHint("x".repeat(INSTRUCTION_SOFT_LIMIT)).level,
    "ok",
  );
  const long = instructionLengthHint("x".repeat(INSTRUCTION_SOFT_LIMIT + 1));
  assert.equal(long.level, "long");
  assert.match(long.message, /on-demand skill/);
  assert.match(long.message, /still save/);
});

test("sparkline points fit the box and handle one or no value", () => {
  assert.equal(sparklinePoints([], 100, 20), "");
  assert.equal(sparklinePoints([5], 100, 20), "50.0,0.0");
  assert.equal(sparklinePoints([0, 10], 100, 20), "0.0,20.0 100.0,0.0");
  assert.equal(sparklinePoints([0, 0], 100, 20), "0.0,20.0 100.0,20.0");
});
