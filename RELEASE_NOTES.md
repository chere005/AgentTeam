# AgentTeam 0.2.2

Project workspace and workflow reliability release.

## What's new in 0.2.2

- Keep work in the selected project across the four main views: Layout, Chat, Files and Diff. Switch with `Cmd/Ctrl+1–4`; `Cmd/Ctrl+Shift+P` opens the command palette, and quick search can narrow to files or chats.
- Use the Chat view as a team conversation list: personal chats appear first, followed by agent roots and their agent-to-agent subchats. Add your own comments to group conversations and invite more agents.
- Open and edit project files in the Files view, including plain folders that are not Git repositories. Review pending edits and suggested changes in Diff without requiring Git.
- Review project communication and results through the project trace, with a conversation graph, event timeline, task reports and produced files.
- See task progress based on actual evidence. A failed attempt can be explicitly linked to a successful replacement while keeping its report; undoing the link restores its attention state and dependency gate.
- See reported token usage and configured execution limits by project. Provider subscription quotas remain unavailable when the provider does not report them.

Installers are unsigned and the macOS app is not notarized. Your OS may ask you to approve the application.

## Earlier release notes: 0.2.1

Reliability and workflow update for macOS, Windows and Linux.

## 0.2.1 changes

- Fix unsigned macOS installer generation when signing secrets are unset.
- Harden repository operations by neutralizing attached-repository clean/smudge filters and repository-local credential helpers.
- Improve Windows portability in Git configuration, workspace paths and process fixtures; expose provider failures more clearly in conversations.
- Refine parallel and pipeline workflows, group advanced agent setup options, and add a local-sockets example with a TypeScript server and C++/Python clients.
- Preserve the existing orchestration, access-control and durable-execution limits described below; examples remain fixture-tested and are not evidence of live-provider compatibility.

This release's installers are unsigned and the macOS app is not notarized. Your OS may ask you to approve the application.

## Product capabilities

## Highlights

- Teams and projects are separate. A team is the persistent org of agents (lead, workers, reviewers, adjudicators with roles, models, links, rules, required reviews and caps); a project is one unit of work assigned to a team (goal, workspace, tasks, stage gates) and runs on the team's existing agents; a workflow graph is an executable step graph inside a project. The Saved teams library has an "Example teams" section with the plan → implement → review pipeline team, the Wolfram-validated reasoning team and a new product feature team, each with its shape, an org-chart preview and Insert (configure worker counts and models, model check at insert, no project created). "Assign project" in the Projects pane (formerly Workflows) and in the team menu creates a paused project for the active team; models are verified again for every project. Team templates use schema v3 (agent role types and a project profile; v1/v2 files still import). The one-shot `/samples/wolfram-validated-reasoning` and `/pipelines` routes remain for compatibility.
- The canvas Arrange lays the team out as a top-down org chart (leads on top, reports centered below, siblings spaced by subtree width, no overlaps, the Team Assistant aside) and runs automatically for inserted and new teams; manual positions are kept until you click Arrange.

- Active-team switcher: one team or workflow set is shown at a time, named in the top bar with status and running/attention counts; other teams' running work and inbox items stay visible and opening one switches the team. Example teams, templates and packs create their own team. Existing data becomes the "Main team" without migration (records without a team belong to Main). Cross-team links need an explicit choice; all policy (permissions, locks, limits, gates, scheduling) stays global.

- Flexible three-pane workspace, opening with canvas in the center and conversation on the right.
- Contextual connection editor: assign tasks, ask for advice, request reviews or send updates.
- Enter sends chat; Shift+Enter adds a newline.
- Agent profiles with model/effort, skills, persistent instructions and concurrent-invocation limits.
- Directed communication graph, activity indicators and directional transfer animation.
- Workflow scheduler with dependencies, pause, retry and cancellation.
- Exclusive shared-folder locks, configurable priorities and waiting-time fairness.
- Guided parallel workflows with a coordinating agent and resource-specific concurrency settings.
- Explicit access inventory, bounded typed file previews (text, JSON, CSV, images, PDF), live refresh after external edits, and Sublime Text defaults with configurable editor paths.
- Git workflow: branch switch with safety confirmations, fetch, fast-forward pull, push with explicit set-upstream (never force), commit history, pull-request compare links (no hosting API calls), confirmed merge/rebase with a chosen branch (never forced), rename pairing when staging, and merge/rebase conflict resolution.
- Team settings (roles, worker counts with retire/reinstate, model re-check) and a project lifecycle (complete, archive, reopen, detach only the folders a project attached; free-form task dependencies).
- Light theme (Settings → Appearance: System, Light, Dark) and a diagnostic bundle "Save as…" through the desktop main process.
- 28 bundled skills and separate discovery of installed harness skills.
- Required validation gate: tasks that require validation wait for an immutable record of a real Wolfram kernel run with passing assertions for their exact inputs (at most two concurrent runs). Projects of the Wolfram-validated reasoning team use it and start paused.
- Per-workflow limits (runtime, turns, handoffs, retries, spawned agents, reported tokens, children, delegation depth) that pause the workflow and abort running tasks when tripped, plus backend-enforced task completion checks.
- Code review with staged/unstaged and branch compare views, line comments that go outdated when code changes, per-file reviewed marks and an approve/request-changes decision.
- Portable team templates with export/import, atomic insertion with ID remapping, four bundled starter teams and three example teams; template schema v2 keeps canvas groups and v3 adds role types and a project profile (v1/v2 files still import).
- Team packs: versioned manifests with attribution, pack and companion-skill licenses checked separately, pinned skills, harness/tool/model compatibility, a grant-acknowledged atomic install and explicit three-way updates that never overwrite local edits. Bundled Swift development pack (skeleton).
- Multi-stage pipeline team (Opus planner, Sonnet integrator over 1-5 implementation and 1-5 fix workers, Fable adjudicator over parallel Codex/Fable reviewers, Fable reporter) whose projects run plan → implement → parallel reviews → separate adjudication → fixes → final reviews → report, each paused behind a verified resume gate, with immutable handoff notes in a scrollable history. Fixture-tested only.
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

These installers are unsigned and the macOS app is not notarized. Your OS may ask you to approve the application. See README for platform-specific installation and provider configuration.

## Important limitations

Direct Claude and Codex CLI runs receive run-scoped AgentTeam teammate tools. Built-in file tools require an attached unrestricted workspace and role-granted access; live provider authentication and subscription compatibility remain unverified. ACP does not yet expose teammate tools or granted provider MCP servers. Provider-native subagents remain outside AgentTeam's limits. Wolfram uses a local LLMSynthesize bridge requiring Wolfram LLM configuration. The Team Assistant can propose configuration changes; you review and apply them in the Assistant changes pane (it cannot apply them itself). CLI view shows resume commands rather than an embedded terminal. Native provider-app opening is implemented for macOS.

Attached-folder access rules and resource locks govern AgentTeam operations. They do not sandbox external editors, native apps or independently launched CLI sessions. The Access pane distinguishes provider access from AgentTeam access.

Restart recovery is fixture- and crash-simulation-tested; resuming a provider session has not been verified against live providers. Worktree and development-server handling is verified on macOS only, and servers that daemonize themselves are not stopped. The validation gate and the Wolfram-validated team's projects were tested with a fake kernel; the opt-in real-kernel smoke test has not been run, and nothing has run against live providers. None of the example teams (pipeline, Wolfram-validated, product feature) or their projects has run against live providers; the pipeline team's default model ids and Codex's "max" effort are unconfirmed. Token usage appears only when providers report it, and cost is shown as unavailable. Windows command-shim launching is fixture-tested only. There are no versioned database migrations or backup/restore tools yet.

Provider runtimes, accounts and subscriptions are not included. Pull is fast-forward only by default; merges/rebases need an explicit confirmation and are never forced; pull-request status is recorded manually. See the repository README for all current limits and test instructions.
