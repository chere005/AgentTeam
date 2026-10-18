# AgentTeam 0.1.0

First functional desktop release for macOS, Windows and Linux.

## Highlights

- Flexible three-pane workspace with chat, team canvas, workflows, resources, skills and files.
- Agent profiles with model/effort, skills, persistent instructions and concurrent-invocation limits.
- Directed communication graph, activity indicators and directional transfer animation.
- Workflow scheduler with dependencies, pause, retry and cancellation.
- Exclusive shared-folder locks, configurable priorities and waiting-time fairness.
- Guided parallel workflows with a coordinating agent and resource-specific concurrency settings.
- Explicit access inventory, text file previews, basic Git operations and Sublime Text defaults.
- 28 bundled skills and separate discovery of installed harness skills.

## Install and first run

Choose the archive/installer for your OS and CPU architecture. Enable provider execution only after installing and authenticating your provider CLI. Execution is off by default.

This initial release is unsigned and the macOS app is not notarized. Your OS may ask you to approve the application. See README for platform-specific installation and provider configuration.

## Important limitations

The Codex adapter is read-only; Claude is currently tool-free chat. Wolfram uses a new LLMSynthesize bridge requiring local Wolfram LLM configuration. Live subscription-backed execution is not fully validated. The Team Assistant can see and advise on the team; applying its suggestions is currently done through the UI. CLI view shows resume commands rather than an embedded terminal. Native provider-app opening is implemented for macOS.

Attached-folder access rules and resource locks govern AgentTeam operations. They do not sandbox external editors, native apps or independently launched CLI sessions. The Access pane distinguishes provider access from AgentTeam access.

Provider runtimes, accounts and subscriptions are not included. Git UI currently covers local status, diffs, staging and commits. See the repository README for all current limits and test instructions.
