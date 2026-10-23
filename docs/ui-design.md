# UI design: progressive disclosure

User feedback (October 2026): keep the workspace uncluttered and make the active project obvious. The four main viewer modes are Layout, Chat, Files and Diff; the top bar always names the current project (or says “No current project”).

## What was wrong (screenshots of the previous UI, default layout / agent selected / example team / 1100 px)

- A permanent left navigation of 13 panes plus an agent list, a "New agent" button and Settings, about 20 entries, several overlapping: Skills library vs Skills, tools & knowledge; Resources vs Workspace → Access; Attention inbox in the list and as a top-bar icon; Saved teams in the list and as a canvas button; Workflow graphs in the list and as a canvas button; Activity vs the Run inspector timeline.
- Two pane headers with dropdowns ("Team canvas ▾", "Conversations ▾") and the labels "Workspace" / "Side pane", plus top-bar buttons for Layouts, inbox, navigation toggle, swap panes and right-pane toggle (icon-only), plus a status line and a footer status bar.
- Two toolbars above the canvas (6 buttons and a hint, then group name / group selected / parent / child / sibling) and a help footer below it; at 1100 px they wrapped to four rows and the minimap covered most of the remaining canvas.
- On an empty team the "No agents" message was drawn over the Team Assistant card (zoomed to 2×), so both were hard to read.
- The chat stacked four layers before the first message: "Talking to" picker, "Driven by / Take control", Chat / CLI / Native app tabs and the execution notice.
- Folders and skills were the third and fourth tab of a modal editor whose first tab was an 8-field grid (priority, concurrency, effort, invocation limit box, ...).
- Simple cards still showed folder access lines, invocation counts and "Legacy priority" strings.

## Principles

1. The main viewer order is Layout, Chat, Files, Diff. Switch with ⌘1–⌘4 (Ctrl+1–4 on Windows/Linux); the selected project stays in context.
2. Setting up an agent is the main secondary task: select it on the canvas and a focused panel opens with plain sections.
3. Other features are one search or one click away (More / Ctrl/Cmd+K) and open as closable tabs. Contextual buttons open the right feature when something needs you.
4. Fewer borders, one type scale (11.5/12.5/13/16/18 px), muted secondary text, headings that say what a section is for.
5. Keyboard and screen-reader parity: landmarks (banner, main, side panel, agent setup), visible focus, palette with arrow keys / Enter / Esc and focus return, dialog focus trap (`ui/components/A11y.tsx`).

## Information architecture

**Top bar** (`ui/App.tsx`): logo mark and name · team switcher · **Current project** picker (per team; explicitly shows “No current project” when empty) · "Assign project" (only when the team has agents) · "Execution paused" (only while paused; opens Settings) · attention button (only when something needs you) · **More** (Ctrl/Cmd+K) · Settings gear.

**Main area**: four permanent tabs, in order: Layout, Chat, Files, Diff. Layout is the team graph; Chat is the conversation-first team view; Files is a project file browser with preview and a bounded text/Markdown editor; Diff is the side-by-side review viewer. Feature tabs appear after these and are remembered per team. The current-project choice is remembered per team and does not change when switching views.

**Side panel** (right, resizable, Ctrl/Cmd+\\ hides it): "Chat" and, when an agent is selected, "Agent setup". The agent panel can instead be shown as its own column beside the chat (toggle in the panel header or Settings → Agent panel).

**Canvas toolbar**: + Agent · Arrange · Detailed cards · Groups (shows grouping and parent/child/sibling navigation) · "Save as team" only while agents are selected. An empty team shows a getting-started card ("Add an agent", "Insert an example team", three steps); a team without connections shows a one-line tip. Simple cards show name, role, model and status; detailed cards add folders, invocations, priority, effort and quick actions. A failed or interrupted task makes the card show "View blockers".

**Agent panel** (`ui/components/AgentPanel.tsx`, also the New agent dialog): Identity & role (role type first, name, role, reports to) · Model (environment, model dropdown with custom ID) · Folders (Add folder; "Can read" / "Can read and edit"; working folder; remove) · Skills (Add skill from the library or installed skills; "Always loaded" / "On demand"; remove) · Talks to (connections in words, connect to another agent) · **Advanced**, collapsed: effort, scheduling priority (Low…Preempt), max concurrent invoked agents (Unlimited default), invocation limit details, always-loaded instructions, tool identifiers, per-folder access rules, links to tool grants/knowledge and effective access. Edits are kept until "Save changes" (or Discard). Contextual buttons: "Review changes (N)" when the agent's write folder has uncommitted changes, "View blockers (N)" when it has failed or interrupted tasks.

**More menu / command palette** (`ui/components/CommandMenu.tsx`, registry `ui/features.ts`): with an empty query it lists every feature by group with a one-line description; typing searches features, actions (New agent, Insert an example team, Assign project, Canvas, Show chat, Hide side panel, Switch team, Layouts, Keyboard shortcuts) and agents.

| Group      | Feature (tab)                                                                  | What it is for                                                                                                           |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Work       | Projects                                                                       | Assign work to the team; tasks, gates, routing rules                                                                     |
| Work       | Diff                                                                            | Side-by-side project changes, comments, approve / request changes                                                        |
| Work       | Workflow graphs                                                                | Step graphs inside a project                                                                                             |
| Work       | Assistant changes                                                              | Approve or reject Team Assistant proposals                                                                               |
| Workspace  | Git · Preview                                                                  | Git and worktrees, dev server preview                                                                                    |
| Team setup | Team library                                                                   | Example teams, saved teams, team packs                                                                                   |
| Team setup | Team settings                                                                  | The active team's profile: roles, worker counts, model check, name and description                                       |
| Team setup | Skills, tools & knowledge                                                      | Skill library, tool grants, knowledge                                                                                    |
| Team setup | Access & resources                                                             | An agent's effective access, shared resources, locks, parallel work                                                      |
| Monitoring | Inbox · Timeline & inspector · Limits · Recovery · Shared state · Activity log | Attention items; timeline/waiting/transfers/playground/export; per-project limits, recovery and shared state; raw events |
| (gear)     | Settings                                                                       | Execution, agent connections, editors, agent panel placement, layouts, reset                                             |

## What moved where

| Before                                                                        | Now                                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Left navigation (13 panes + agent list)                                       | Removed. Panes are features in More / Ctrl+K; agents are on the canvas, in the chat picker and in the palette                                   |
| Pane dropdowns, swap panes, nav toggle, Layouts button                        | Removed. Four main view tabs + side panel; other features are closable tabs. Layout presets are in Settings.                                  |
| Workspace pane with Access / Files / Git / Review / Preview tabs              | Files and Diff are main viewer modes; Git and Preview remain feature tabs. Access joined Resources (+ Cooperation) as "Access & resources"     |
| Skills library pane (add skill to agent)                                      | Agent panel → Skills → Add skill; the catalog itself is in "Skills, tools & knowledge"                                                          |
| Agent editor modal (Profile / Instructions / Skills / Workspace tabs)         | Agent panel sections; New agent dialog uses the same sections                                                                                   |
| Limits, Recovery, Shared state (+ state editor) inside every project card     | Their own tabs (per project); project cards link to them                                                                                        |
| Inbox in navigation + top-bar icon                                            | Attention button only when needed → Inbox tab; the permission-request panel links to it; Ctrl/Cmd+Shift+I                                       |
| Canvas: Insert team, Workflow graphs buttons, group bar, help footer, minimap | Library from the empty state/palette; graphs from palette/project cards; group bar behind "Groups"; minimap only above 12 agents                |
| Chat: ownership bar and Chat/CLI/Native app always shown                      | Behind "Conversation options" (shown automatically when someone other than the team drives the agent)                                           |
| Status bar footer, top status line                                            | Removed (execution state is a top-bar chip only while paused)                                                                                   |

The default layout preset is "Layout & chat". Ctrl/Cmd+B (navigation toggle) is gone; Ctrl/Cmd+K opens the palette instead of the agent filter.

## Theme

Settings → Appearance: System (follows the OS `prefers-color-scheme`, live), Light or Dark; stored per computer (`agentteam.theme`) and applied as `data-theme` on `<html>` before the first render (`ui/theme.ts`). The renderer mirrors the setting to the desktop main process (`set-theme` IPC, stored as the `appearance` setting), which sets the window background colour and `nativeTheme.themeSource` from it and passes it to the preload, which marks `<html>` before the page paints, so light mode never flashes dark. The dark rules are the source: at build time a PostCSS plugin (`ui/theme-light.ts`, wired in `vite.config.ts`) inserts after every app rule that sets a colour a light twin, `:where(:root[data-theme="light"]) <selector>`, whose colours are mirrored in OKLCH lightness (dark background → near white, light text → dark text, hue kept, the slight blue of the dark greys muted, raised surfaces lifted towards white, shadows kept dark but lighter). `:where()` adds no specificity, so the cascade between rules is exactly the dark one. `ui/theme-light.css` (skipped by the plugin, loaded last) holds the hand-tuned exceptions: page/canvas greys, white cards, dialogs and menus, the primary button (white on teal `#23735f`), selected tabs, backdrops. React Flow gets `colorMode` from the theme; canvas inline colours (grid, arrows, minimap) pick per theme. New styles keep using the `--surface-*`, `--line*`, `--text`, `--muted`, `--faint` tokens; a colour written only in TSX inline styles does not get a light twin.

## Canvas fit and edges

- **Fit** (`ui/canvas-fit.ts`, pure, `test/ui-polish.test.ts`): the canvas fits the visible cards with 40 px padding, never above zoom 1 and never below 0.4. Below 0.6 cards use the glance layout (name on up to two lines, role · environment) whose text is scaled by 1/zoom, so down to 0.4 it keeps its on-screen size; a team still too wide stays centred and top-aligned. It re-fits (debounced 150 ms) when the canvas changes size (side panel opened/closed/resized, window resized) and when the visible cards change, until the user pans or zooms by hand; after that an automatic re-fit only shows a small "Fit" button (top right of the canvas). Fit, Arrange and the Controls fit button fit again and resume auto-fitting. Only a hand-placed viewport is stored per team (`manual: true`) and restored on relaunch. **Compact layout**: an automatic arrangement (Arrange, an insert, a new team) uses `fitOrgLayout`: when the regular org chart would be wider than the canvas at zoom 0.4, rows of leaf siblings are wrapped into lines (every other line shifted by half a column so connectors drop through the gaps; tree connectors share one bus under the parent). A canvas resize re-flows such an arrangement (compact or regular) as long as no card was moved since (`agentteam.arranged` per team); a hand-placed arrangement is never re-flowed.
- **Edges**: a parent → child edge (the org-chart tree, `resolveParents`) is a solid orthogonal step connector; other communication links are thinner, lighter and dashed. The kind label ("Tasks", "Review", ...) is hidden until the edge is hovered or selected (it is always in the edge's accessible name and in the connection dialog); captions keep their on-screen size when zoomed out; arrowheads are small and muted. Clicking an edge still opens the connection dialog with its transfers.
- **Unsaved agent edits** (`ui/components/UnsavedGuard.tsx`): closing the agent panel (×, Esc, the Chat tab, hiding the side panel, moving the panel beside/in place of the chat), selecting another agent or switching team with unsaved edits asks "Save changes to <agent>?" with Save (focused) / Discard / Cancel; Esc is Cancel (also while saving; a cancelled save never runs the action afterwards); focus returns to where it was. Closing or reloading the window with unsaved edits asks natively (Discard changes / Keep editing; Esc keeps editing); test mode never shows that dialog.
