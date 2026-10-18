# AgentTeam

A local desktop workspace for building and coordinating teams of AI agents. Built with Electron, React, React Flow, TypeScript and SQLite. Targets **macOS, Windows and Linux**.

**0.1.0 is the first functional release.** The desktop UI and orchestration are implemented and tested with fixtures. Live provider integrations require your own installed runtimes and accounts; they have not all been validated against live subscriptions. Read the limitations below before enabling execution.

![AgentTeam canvas and conversation workspace](docs/team-canvas.png)

See [the detailed feature backlog](TODO.md) for remaining work, partial implementations, and the planned implementation order.

## Install

Download the appropriate artifact from [GitHub Releases](https://github.com/chere005/AgentTeam/releases).

- **macOS:** open the DMG and drag AgentTeam to Applications, or unpack the ZIP. Choose arm64 for Apple Silicon and x64 for Intel. This initial release is unsigned and not notarized; macOS may require approval in Privacy & Security after an initial launch attempt.
- **Windows:** run the x64 setup executable. This initial installer is unsigned; Windows may display a publisher warning.
- **Linux:** use the x64 AppImage (`chmod +x AgentTeam-*.AppImage`) or install the `.deb`. AppImage execution may require your distribution's FUSE package.

No provider credentials or subscriptions are bundled. AgentTeam does not replace the provider's terms, installation, login or billing.

## What is included

- A hideable navigation pane, main pane and resizable right pane. Canvas opens in the center and conversation on the right. Either content pane can show chat, cards, workflows, folders, skills, resource coordination or activity.
- Persistent agent profiles: environment, model, effort, role, instructions, skills, parent agent, scheduling priority and concurrent-invocation limit (Unlimited by default).
- An interactive team canvas with a plain-language connection editor and directed/bidirectional communication links, compact/detailed cards, hierarchy arrangement, zoom and directional activity pulses.
- Conversations with Enter-to-send / Shift+Enter-newline, a recipient dropdown, a persistent Team Assistant, queued messages, cancellation, CLI resume instructions and native-app opening on macOS.
- Workflow tasks, dependencies, completion criteria, pause/resume, retries, cancellation, and an automatic scheduler when execution is enabled.
- Priority-based routing rules, explicit routing previews and communication permissions.
- Shared-resource locks for attached folders and overlapping subfolders. Workflow tasks and requested chat runs share the lock boundary. Priority ages while waiting so lower-priority agents eventually get a turn.
- Guided parallel workflow configuration: choose resources, a coordinator and a concurrency cap. The coordinator creates a plan that becomes a prerequisite for workers.
- An explicit Access view showing full folder paths, descendant access, read-only/read-write permissions, active directory, sharing, and provider permission limitations.
- File browsing and text previews; basic Git status/diff/stage/unstage/commit; worktree inventory; opening files and project directories in Sublime Text, VS Code or the system application.
- 28 bundled starter skills, plus three metadata-only recommendations. Installed harness skills are inventoried separately and grouped by environment. Sources, pinned revisions and licenses are preserved.
- Local persistence, authenticated loopback API, durable activity events and restart recovery.

## Run from source

Install Node.js 24 or newer, then:

```sh
npm ci
node node_modules/electron/install.js
npm start
```

`npm start` builds and launches the desktop app. `npm run build` only builds. `npm run backend` starts the standalone API. `npm run package -- --publish never` creates installers for the current platform. GitHub Actions checks macOS, Windows and Linux and builds installers for release tags.

Development UI: run `npm run dev:ui`, build the desktop entry once, then launch Electron with `AGENTTEAM_DEV=1`. Windows PowerShell uses `$env:AGENTTEAM_DEV="1"; npm run desktop`.

## Hybrid backend

AgentTeam owns routing, scheduling, priorities, resource locks, and persistent team/workflow state in TypeScript and SQLite. Provider execution has direct CLI adapters and an optional ACP v1 adapter using the pinned `@agentclientprotocol/sdk` 1.9.0 (Apache-2.0). ACP is a connection layer, not a replacement for orchestration. XState/LangGraph evaluation for durable workflows is planned; neither is installed yet.

Settings → Agent connections selects Direct CLI or ACP for each provider. ACP requires an installed adapter executable (or Node plus an adapter script argument). It negotiates capabilities, streams output, handles permission requests, and reloads sessions where supported. Existing conversations are bound to their adapter identity: create a new agent when changing transports or adapter commands. ACP fixture tests pass; live Codex/Claude account compatibility is not yet verified. Internal Wolfram ACP support is deferred.

ACP client filesystem/terminal capabilities are currently disabled. The adapter's native tools still use its own local permissions; this is not an OS sandbox or enforcement of native-subagent limits. AgentTeam shows pending permissions and maintains its own scheduling/resource gates. Provider-native background jobs and crash recovery need further work.

## Provider setup

Execution is available by default outside test mode, with Pause/Resume controls in Settings. Existing provider installations are discovered automatically; manual executable overrides remain available. Authenticate the chosen provider separately. Eligible queued tasks run when execution is active; chat requests are scheduled when sent or explicitly run.

- **Codex:** install/authenticate the Codex CLI and make `codex` available on PATH. The initial adapter uses read-only execution. Model and effort values pass through to the installed CLI.
- **Claude:** install/authenticate Claude Code and expose `claude` on PATH. The initial adapter is tool-free chat; assigned skills must use Always load. Its CLI flags require a sufficiently recent installation.
- **Wolfram:** install `wolframscript` and configure Wolfram LLM access. The adapter uses a fixed `LLMSynthesize` script with a private temporary JSON request file. Model `default` uses the installation default; a named evaluator such as `WolframAIAssistant` can be configured if available. `AGENTTEAM_WOLFRAMSCRIPT` can override the executable path. This bridge has not been live-account validated.

On Windows and Linux, Sublime's `subl` or VS Code's `code` command must be on PATH for editor launching. Native provider-app launch is currently implemented for macOS; CLI resume instructions are cross-platform. The CLI view provides commands, not an embedded interactive terminal.

## Resource access and coordination

AgentTeam's file browser and Git operations enforce the attached folder boundaries and read/write setting, block path traversal and symlink escapes, and exclude direct `.git` access. Folder permissions include descendants. External editor opening is a user action.

The scheduler locks each agent's attached folders for the duration of a run. Overlapping paths conflict by default. A named resource can override an agent's scheduling priority: Low, Medium, High, Max, or Preempt. Normal priorities gain one effective point per five seconds waiting; Preempt gets the next available turn ahead of normal work. Running work is never interrupted. Existing numeric priorities retain their values; old 100 remains Max, while Preempt uses 101. Continuous Preempt traffic can delay normal work. This provides eventual priority over newer work, not a fixed wall-clock start guarantee.

In Resources, configure a workflow for parallel access by naming a coordinator, shared resources and a cap. Its coordination task runs first and passes a work-allocation plan to the workers. Parallel access does not merge files or prevent two workers from editing the same file; separate worktrees remain a useful way to isolate changes.

These locks do **not** control external CLI/native-app sessions or external editors. Provider filesystem scope is also separate: Codex's current sandbox may read outside attached folders; Claude's current adapter disables tools. The Access pane states these differences explicitly.

## Current limitations

- This is an early release, not a fully isolated agent sandbox. No per-file deny rules, OS-level enforcement for external processes, or automatic conflict merging.
- Team Assistant receives team context but cannot yet directly apply configuration changes. Use the forms to apply its recommendations.
- Routing rules select recipients through the routing API/preview; providers do not yet autonomously invoke arbitrary teammates as native tools.
- Native-app handoff may open a separate conversation. CLI resume continuity depends on the provider. Wolfram uses recent transcript context instead of a persistent remote session.
- Provider execution has a 180-second timeout and a 4 MB output limit. No automatic retries after a restart or interrupted request.
- Text previews are bounded to 256 KB. Binary files open externally. Git UI does not yet include push, pull, merge or worktree creation.
- Developer ID signing and notarization are supported; see [SIGNING.md](SIGNING.md). Builds without configured credentials are unsigned. No automatic update distribution yet. Windows/Linux validation is performed in CI, not on this macOS development machine.

## Data and security

Desktop state uses Electron's application-data directory (`~/Library/Application Support/AgentTeam` on macOS, `%APPDATA%/AgentTeam` on Windows, `$XDG_CONFIG_HOME/AgentTeam` or `~/.config/AgentTeam` on Linux). `AGENTTEAM_DATA_DIR` overrides it. The standalone backend defaults to `.agentteam/` in the project and writes its bearer token to `.agentteam/api-token`. Do not publish these directories.

The renderer is sandboxed with context isolation, no Node integration, a restricted content security policy and sender-validated IPC. The local API rejects browser origins and requires a bearer token kept in the main process. Prompts are passed as data, not shell commands. Git commits disable repository hooks in this initial interface.

## Tests

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
```

Desktop tests launch Electron with an isolated temporary database and never call live providers. Linux UI tests need a display, e.g. `xvfb-run --auto-servernum npm run test:ui`.

## Licensing

AgentTeam source is MIT. Bundled skills retain their upstream MIT or Apache-2.0 notices under `assets/skills`. `assets/recommended-skills.json` records source and compatibility information. Electron includes its own third-party notices in packaged applications. Claude, Codex-hosted services and Wolfram runtimes/accounts are separate products; an open-source app license does not grant access to them.
