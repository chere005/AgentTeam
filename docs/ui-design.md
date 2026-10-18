# UI design: progressive disclosure

User feedback (October 2026): the workspace was cluttered and it was hard to tell which page does what. Starting out it should show the team graph and the chat, plus how to give agents folders and skills; everything else should appear when navigated to or asked for.

## What was wrong (screenshots of the previous UI, default layout / agent selected / example team / 1100 px)

- A permanent left navigation of 13 panes plus an agent list, a "New agent" button and Settings, about 20 entries, several overlapping: Skills library vs Skills, tools & knowledge; Resources vs Workspace → Access; Attention inbox in the list and as a top-bar icon; Saved teams in the list and as a canvas button; Workflow graphs in the list and as a canvas button; Activity vs the Run inspector timeline.
- Two pane headers with dropdowns ("Team canvas ▾", "Conversations ▾") and the labels "Workspace" / "Side pane", plus top-bar buttons for Layouts, inbox, navigation toggle, swap panes and right-pane toggle (icon-only), plus a status line and a footer status bar.
- Two toolbars above the canvas (6 buttons and a hint, then group name / group selected / parent / child / sibling) and a help footer below it; at 1100 px they wrapped to four rows and the minimap covered most of the remaining canvas.
- On an empty team the "No agents" message was drawn over the Team Assistant card (zoomed to 2×), so both were hard to read.
- The chat stacked four layers before the first message: "Talking to" picker, "Driven by / Take control", Chat / CLI / Native app tabs and the execution notice.
- Folders and skills were the third and fourth tab of a modal editor whose first tab was an 8-field grid (priority, concurrency, effort, invocation limit box, ...).
- Simple cards still showed folder access lines, invocation counts and "Legacy priority" strings.

## Principles

1. At start: the team canvas (centre) and the chat (right). Nothing else is on screen until it is needed.
2. Setting up an agent is the main secondary task: select it on the canvas and a focused panel opens with plain sections.
3. Every other feature is one search or one click away (More / Ctrl/Cmd+K) and opens as a closable tab. Contextual buttons open the right tab when something needs you.
4. Fewer borders, one type scale (11.5/12.5/13/16/18 px), muted secondary text, headings that say what a section is for.
5. Keyboard and screen-reader parity: landmarks (banner, main, side panel, agent setup), visible focus, palette with arrow keys / Enter / Esc and focus return, dialog focus trap (`ui/components/A11y.tsx`).

## Information architecture

**Top bar** (`ui/App.tsx`): logo mark and name · team switcher · "Assign project" (only when the team has agents) · "Execution paused" (only while paused; opens Settings) · attention button (only when something needs you; count of the active team, "in other teams" otherwise) · **More** (Ctrl/Cmd+K) · Settings gear. A screen-reader-only status says "Workspace connected".

**Main area**: the canvas. Opened views appear as tabs ("Canvas" is always first and cannot be closed); with no feature open there is no tab strip at all. Tabs are remembered per team (`agentteam.tabs[.team-<id>]`); first run and new teams start with Canvas only.

**Side panel** (right, resizable, Ctrl/Cmd+\\ hides it): "Chat" and, when an agent is selected, "Agent setup". The agent panel can instead be shown as its own column beside the chat (toggle in the panel header or Settings → Agent panel).

**Canvas toolbar**: + Agent · Arrange · Detailed cards · Groups (shows grouping and parent/child/sibling navigation) · "Save as team" only while agents are selected. An empty team shows a getting-started card ("Add an agent", "Insert an example team", three steps); a team without connections shows a one-line tip. Simple cards show name, role, model and status; detailed cards add folders, invocations, priority, effort and quick actions. A failed or interrupted task makes the card show "View blockers".

**Agent panel** (`ui/components/AgentPanel.tsx`, also the New agent dialog): Identity & role (role type first, name, role, reports to) · Model (environment, model dropdown with custom ID) · Folders (Add folder; "Can read" / "Can read and edit"; working folder; remove) · Skills (Add skill from the library or installed skills; "Always loaded" / "On demand"; remove) · Talks to (connections in words, connect to another agent) · **Advanced**, collapsed: effort, scheduling priority (Low…Preempt), max concurrent invoked agents (Unlimited default), invocation limit details, always-loaded instructions, tool identifiers, per-folder access rules, links to tool grants/knowledge and effective access. Edits are kept until "Save changes" (or Discard). Contextual buttons: "Review changes (N)" when the agent's write folder has uncommitted changes, "View blockers (N)" when it has failed or interrupted tasks.

**More menu / command palette** (`ui/components/CommandMenu.tsx`, registry `ui/features.ts`): with an empty query it lists every feature by group with a one-line description; typing searches features, actions (New agent, Insert an example team, Assign project, Canvas, Show chat, Hide side panel, Switch team, Layouts, Keyboard shortcuts) and agents.

| Group      | Feature (tab)                                                                  | What it is for                                                                                                           |
| ---------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Work       | Projects                                                                       | Assign work to the team; tasks, gates, routing rules                                                                     |
| Work       | Review changes                                                                 | Diffs, comments, approve / request changes                                                                               |
| Work       | Workflow graphs                                                                | Step graphs inside a project                                                                                             |
| Work       | Assistant changes                                                              | Approve or reject Team Assistant proposals                                                                               |
| Workspace  | Files · Git · Preview                                                          | One agent folder: browse, Git and worktrees, dev server preview                                                          |
| Team setup | Team library                                                                   | Example teams, saved teams, team packs                                                                                   |
| Team setup | Skills, tools & knowledge                                                      | Skill library, tool grants, knowledge                                                                                    |
| Team setup | Access & resources                                                             | An agent's effective access, shared resources, locks, parallel work                                                      |
| Monitoring | Inbox · Timeline & inspector · Limits · Recovery · Shared state · Activity log | Attention items; timeline/waiting/transfers/playground/export; per-project limits, recovery and shared state; raw events |
| (gear)     | Settings                                                                       | Execution, agent connections, editors, agent panel placement, layouts, reset                                             |

## What moved where

| Before                                                                        | Now                                                                                                                                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Left navigation (13 panes + agent list)                                       | Removed. Panes are features in More / Ctrl+K; agents are on the canvas, in the chat picker and in the palette                                   |
| Pane dropdowns, swap panes, nav toggle, Layouts button                        | Removed. Tabs + side panel; Layouts are in Settings (presets: Canvas & chat, Coding, Review, Monitoring, plus your own; they open sets of tabs) |
| Workspace pane with Access / Files / Git / Review / Preview tabs              | Files, Git, Review changes, Preview tabs; Access joined Resources (+ Cooperation) as "Access & resources"                                       |
| Skills library pane (add skill to agent)                                      | Agent panel → Skills → Add skill; the catalog itself is in "Skills, tools & knowledge"                                                          |
| Agent editor modal (Profile / Instructions / Skills / Workspace tabs)         | Agent panel sections; New agent dialog uses the same sections                                                                                   |
| Limits, Recovery, Shared state (+ state editor) inside every project card     | Their own tabs (per project); project cards link to them                                                                                        |
| Inbox in navigation + top-bar icon                                            | Attention button only when needed → Inbox tab; the permission-request panel links to it; Ctrl/Cmd+Shift+I                                       |
| Canvas: Insert team, Workflow graphs buttons, group bar, help footer, minimap | Library from the empty state/palette; graphs from palette/project cards; group bar behind "Groups"; minimap only above 12 agents                |
| Chat: ownership bar and Chat/CLI/Native app always shown                      | Behind "Conversation options" (shown automatically when someone other than the team drives the agent)                                           |
| Status bar footer, top status line                                            | Removed (execution state is a top-bar chip only while paused)                                                                                   |

Layout presets that only juggled the old pane list (Planning) were replaced by "Canvas & chat". Ctrl/Cmd+B (navigation toggle) is gone; Ctrl/Cmd+K now opens the palette instead of the agent filter.

## Theme

The app is dark-only (React Flow runs in dark mode and colours are fixed dark tokens in `ui/style.css`); there is no light mode to respect yet. New styles use the `--surface-*`, `--line*`, `--text`, `--muted`, `--faint` tokens so a light theme can be added by redefining them.
