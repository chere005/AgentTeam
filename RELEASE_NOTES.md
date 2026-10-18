# AgentTeam 0.1.0

First functional desktop release for macOS, Windows and Linux.

## Highlights

- Flexible three-pane workspace, opening with canvas in the center and conversation on the right.
- Contextual connection editor: assign tasks, ask for advice, request reviews or send updates.
- Enter sends chat; Shift+Enter adds a newline.
- Agent profiles with model/effort, skills, persistent instructions and concurrent-invocation limits.
- Directed communication graph, activity indicators and directional transfer animation.
- Workflow scheduler with dependencies, pause, retry and cancellation.
- Exclusive shared-folder locks, configurable priorities and waiting-time fairness.
- Guided parallel workflows with a coordinating agent and resource-specific concurrency settings.
- Explicit access inventory, text file previews, basic Git operations and Sublime Text defaults.
- 28 bundled skills and separate discovery of installed harness skills.
- Required validation gate: tasks that require validation wait for an immutable record of a real Wolfram kernel run with passing assertions for their exact inputs (at most two concurrent runs). A paused Wolfram-validated sample workflow is included.
- Per-workflow limits (runtime, turns, handoffs, retries, spawned agents, reported tokens, children, delegation depth) that pause the workflow and abort running tasks when tripped, plus backend-enforced task completion checks.
- Code review with staged/unstaged and branch compare views, line comments that go outdated when code changes, per-file reviewed marks and an approve/request-changes decision.
- Portable team templates with export/import, atomic insertion with ID remapping, and four bundled starter teams.
- Runtime diagnostics, reset/rescan, a capability table for each adapter, and a readiness gate that holds direct-CLI work until runtime discovery has settled.
- Provider timeouts and output limits configurable through `AGENTTEAM_{CHAT,TASK}_*` environment variables.
- Isolated Git worktrees: create, attach, optional setup command, inventory, archive and remove without losing uncommitted work.
- Development-server preview: per-folder settings, readiness checks, bounded logs, process-tree stop, and an isolated preview with viewport sizes and console errors.
- Durable checkpoints and an effect ledger: interrupted tasks resume after a restart without re-running completed work; uncertain external effects wait for your decision; permission requests survive a restart; per-task retry policy with backoff (API only for now).

## Install and first run

Choose the archive/installer for your OS and CPU architecture. Execution is on by default: queued work can start as soon as a provider runtime is found, so use Settings Pause first if you do not want that. Existing provider installations are detected automatically. Authenticate your provider tools separately; Settings provides Pause/Resume controls and manual executable overrides. ACP v1 connections are optional and currently validated with protocol fixtures.

This initial release is unsigned and the macOS app is not notarized. Your OS may ask you to approve the application. See README for platform-specific installation and provider configuration.

## Important limitations

The Codex adapter is read-only; Claude is currently tool-free chat. Wolfram uses a new LLMSynthesize bridge requiring local Wolfram LLM configuration. Live subscription-backed execution is not fully validated. The Team Assistant can see and advise on the team; applying its suggestions is currently done through the UI. CLI view shows resume commands rather than an embedded terminal. Native provider-app opening is implemented for macOS.

Attached-folder access rules and resource locks govern AgentTeam operations. They do not sandbox external editors, native apps or independently launched CLI sessions. The Access pane distinguishes provider access from AgentTeam access.

Restart recovery is fixture- and crash-simulation-tested; resuming a provider session has not been verified against live providers. Worktree and development-server handling is verified on macOS only, and servers that daemonize themselves are not stopped. The validation gate and sample were tested with a fake kernel; the opt-in real-kernel smoke test has not been run, and nothing has run against live providers. Token usage appears only when providers report it, and cost is shown as unavailable. Windows command-shim launching is fixture-tested only. There are no versioned database migrations or backup/restore tools yet.

Provider runtimes, accounts and subscriptions are not included. Git UI covers local status, diffs, staging, commits, branch compare and worktree management; push, pull and merge are not included. See the repository README for all current limits and test instructions.
