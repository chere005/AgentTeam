# AgentTeam 0.1.0

First functional desktop release for macOS, Windows and Linux.

## Highlights

- Active-team switcher: one team or workflow set is shown at a time, named in the top bar with status and running/attention counts; other teams' running work and inbox items stay visible and opening one switches the team. Samples, templates and packs create their own team. Existing data becomes the "Main team" without migration (records without a team belong to Main). Cross-team links need an explicit choice; all policy (permissions, locks, limits, gates, scheduling) stays global.

- Flexible three-pane workspace, opening with canvas in the center and conversation on the right.
- Contextual connection editor: assign tasks, ask for advice, request reviews or send updates.
- Enter sends chat; Shift+Enter adds a newline.
- Agent profiles with model/effort, skills, persistent instructions and concurrent-invocation limits.
- Directed communication graph, activity indicators and directional transfer animation.
- Workflow scheduler with dependencies, pause, retry and cancellation.
- Exclusive shared-folder locks, configurable priorities and waiting-time fairness.
- Guided parallel workflows with a coordinating agent and resource-specific concurrency settings.
- Explicit access inventory, bounded typed file previews (text, JSON, CSV, images, PDF), live refresh after external edits, and Sublime Text defaults with configurable editor paths.
- Git workflow: branch switch with safety confirmations, fetch, fast-forward pull, push with explicit set-upstream (never force), commit history, pull-request compare links (no hosting API calls) and merge/rebase conflict resolution.
- 28 bundled skills and separate discovery of installed harness skills.
- Required validation gate: tasks that require validation wait for an immutable record of a real Wolfram kernel run with passing assertions for their exact inputs (at most two concurrent runs). A paused Wolfram-validated sample workflow is included.
- Per-workflow limits (runtime, turns, handoffs, retries, spawned agents, reported tokens, children, delegation depth) that pause the workflow and abort running tasks when tripped, plus backend-enforced task completion checks.
- Code review with staged/unstaged and branch compare views, line comments that go outdated when code changes, per-file reviewed marks and an approve/request-changes decision.
- Portable team templates with export/import, atomic insertion with ID remapping, and four bundled starter teams; template schema v2 keeps canvas groups (v1 files still import).
- Team packs: versioned manifests with attribution, pack and companion-skill licenses checked separately, pinned skills, harness/tool/model compatibility, a grant-acknowledged atomic install and explicit three-way updates that never overwrite local edits. Bundled Swift development pack (skeleton).
- Paused multi-stage pipeline sample (Opus plan → Sonnet workers → parallel Codex/Fable reviews → separate Fable adjudication → Sonnet fixes → final reviews → Fable report) with configurable models and 1-5 workers per stage, a verified resume gate, and immutable handoff notes in a scrollable history. Fixture-tested only.
- Task settings editors: validation requirement, completion checks, retry policy, state/context settings, shared-state field definitions and checkpoint restore, and in-place rule editing.
- Runtime diagnostics, reset/rescan, a capability table for each adapter, and a readiness gate that holds direct-CLI work until runtime discovery has settled.
- Provider timeouts and output limits configurable through `AGENTTEAM_{CHAT,TASK}_*` environment variables.
- Isolated Git worktrees: create, attach, optional setup command, inventory, archive and remove without losing uncommitted work.
- Development-server preview: per-folder settings, readiness checks, bounded logs, process-tree stop, and an isolated preview with viewport sizes and console errors.
- Role presets (coordinator, implementer, reviewer, adjudicator), specialist rules matched on text, tags or changed-file globs with visible ties, and mandatory required reviews that block dependent tasks until the reviewer approves the exact result.
- Shared workflow state and artifacts: typed, permissioned, versioned fields with conflict detection, state committed atomically with task completion and carried in checkpoints, and a size-limited untrusted context for downstream tasks.
- Run inspector: correlated timeline with filters, "why is this waiting?" explanations, transfer details, routing/access previews, a fixture-only team playground with run comparison, and a redacted diagnostic export.
- Saved workspace layouts, an attention inbox, canvas groups and hierarchy navigation, keyboard shortcuts and accessibility improvements.
- Team Assistant change proposals with a reviewable diff, significance flags, user-only approval/apply (bound to the exact operations), staleness detection, atomic apply with rollback and an audit trail; explicit session ownership (team, embedded chat, CLI, native app).
- Skills, tools and knowledge: on-demand skill selection with recorded reasons and context cost, user-accepted skill updates, an effective-instructions preview, an MCP tool registry with grants and a metadata-only connection test, and cited knowledge sources from attached folders.
- File-level access rules and exclusions, one queue ordering for tasks and chat runs with visible wait reasons, per-task declared lock paths, guided parallel assignments with conflict detection, per-repository Git serialization across worktrees, and draining leases after a crash.
- Executable workflow graphs: task, command, condition, human-input, fan-out/join and bounded-loop steps with static validation, confirmed and confined command steps, an immutable executed path and retry from the failed step.
- Durable checkpoints and an effect ledger: interrupted tasks resume after a restart without re-running completed work; uncertain external effects wait for your decision; permission requests survive a restart; per-task retry policy with backoff.

## Install and first run

Choose the archive/installer for your OS and CPU architecture. Execution is on by default: queued work can start as soon as a provider runtime is found, so use Settings Pause first if you do not want that. Existing provider installations are detected automatically. Authenticate your provider tools separately; Settings provides Pause/Resume controls and manual executable overrides. ACP v1 connections are optional and currently validated with protocol fixtures.

This initial release is unsigned and the macOS app is not notarized. Your OS may ask you to approve the application. See README for platform-specific installation and provider configuration.

## Important limitations

The Codex adapter is read-only; Claude is currently tool-free chat. Wolfram uses a new LLMSynthesize bridge requiring local Wolfram LLM configuration. Live subscription-backed execution is not fully validated. The Team Assistant can propose configuration changes; you review and apply them in the Assistant changes pane (it cannot apply them itself). Granted MCP servers are not yet passed to providers. CLI view shows resume commands rather than an embedded terminal. Native provider-app opening is implemented for macOS.

Attached-folder access rules and resource locks govern AgentTeam operations. They do not sandbox external editors, native apps or independently launched CLI sessions. The Access pane distinguishes provider access from AgentTeam access.

Restart recovery is fixture- and crash-simulation-tested; resuming a provider session has not been verified against live providers. Worktree and development-server handling is verified on macOS only, and servers that daemonize themselves are not stopped. The validation gate and sample were tested with a fake kernel; the opt-in real-kernel smoke test has not been run, and nothing has run against live providers. The pipeline sample has never run against live providers; its default model ids and Codex's "max" effort are unconfirmed. Token usage appears only when providers report it, and cost is shown as unavailable. Windows command-shim launching is fixture-tested only. There are no versioned database migrations or backup/restore tools yet.

Provider runtimes, accounts and subscriptions are not included. Pull is fast-forward only by default and merges/rebases are not started from the UI (their conflicts can be resolved there); pull-request status is recorded manually. Teammate-invocation tools are defined but not yet exposed to provider runs. See the repository README for all current limits and test instructions.
