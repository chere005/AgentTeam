# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` holds the durable engineering rules (runtime correctness, UI conventions, Git/release policy) and is authoritative; read it first. `TODO.md` has remaining work and `docs/CONTINUATION.md` the latest handoff. This file only adds commands and the architectural big picture.

## Commands

Node 24+ is required (TypeScript runs directly via `node`, no transpile step for backend tests/dev). Run from the repo root.

```sh
npm ci
npm run typecheck                 # tsc for backend + tsconfig.ui.json for UI
npm test                          # node --test test/*.test.ts
node --test test/scheduler.test.ts                          # single test file
node --test --test-name-pattern="<regex>" test/core.test.ts # single test by name
npm run build                     # vite build (renderer) + scripts/build.mjs (Electron/backend → dist/)
npm run test:ui                   # Playwright Electron tests (serial; build first)
npx playwright test -g "<title>"  # single UI test
xvfb-run --auto-servernum npm run test:ui   # headless Linux
npm start                         # build + launch Electron; `npm run desktop` launches existing build
npm run backend                   # standalone API (src/server.ts); `npm run dev` = same with --watch
npm run dev:ui                    # Vite dev server; then launch Electron with AGENTTEAM_DEV=1
npm run package -- --publish never   # installers for current platform
npm run format                    # prettier (no lint script exists)
```

- Backend/main-process changes need an Electron restart, not just a renderer refresh.
- Tests must use temp databases/workspaces; `AGENTTEAM_DATA_DIR` sets the data dir. Never point at the user's live store. Standalone backend live execution is on by default unless `AGENTTEAM_ENABLE_LIVE=0`.
- Desktop/UI tests use fixtures and never call live providers.

## Architecture

Electron + React (React Flow canvas) + TypeScript + SQLite desktop app for orchestrating agent teams across Claude, Codex and Wolfram. The Electron main process (`desktop/main.ts`) hosts the backend in `src/`, which exposes an authenticated loopback HTTP API (`src/http.ts`, bearer token held in the main process; browser origins rejected). The sandboxed renderer (`ui/`) talks to it only through the preload/IPC boundary (`desktop/preload.ts`). `src/server.ts` runs the same backend standalone.

Backend layering (all policy lives here; UI and provider tool paths must hit the same checks):

- `model.ts` (zod schemas/types) → `service.ts` (`TeamService`: validated mutations, communication rules, lifecycle) → `store.ts` (SQLite entities + events; transactions are synchronous, so do async fs/provider work outside them and publish events only after commit).
- `scheduler.ts` selects eligible tasks (dependencies, required-validation gates); `resources.ts` (`ResourceCoordinator`) grants folder leases, enforces priority aging/fairness and concurrency caps; `priorities.ts` defines Low/Medium/High/Max/Preempt (Preempt = 101, queue precedence only, never interrupts a running writer).
- `runtime.ts` / `runtime-types.ts` dispatch to provider adapters: direct CLI adapters (`codex`, `claude`, `wolframscript` with `LLMSynthesize`) or the ACP v1 adapter in `acp.ts` (transport only — not an orchestrator or OS sandbox). Conversations are bound to an adapter identity.
- `discovery.ts` finds installed harnesses/skills (manual overrides retained; per-runtime scan and diagnostics in `runtime-scan.ts`; `.cmd`/`.bat` shims launched without a shell via `runtime-spawn.ts`). Readiness gate: `RunManager.readiness` (wired in `desktop/main.ts`/`server.ts`) keeps direct-CLI tasks and chat runs queued (`runtime_resolving`) until a scan has settled, then fails them with `runtime_unavailable`; ACP is not gated. With `AGENTTEAM_TEST=1` the desktop never scans at startup, so direct-CLI work stays queued; tests that scan set `AGENTTEAM_DISCOVERY_PATH_ONLY=1` so only `PATH` is searched.
- `limits.ts` (`TeamService.limits`, schemas in `limits-schema.ts`): per-workflow limits (runtime, turns, handoffs, retries, spawned, reported tokens, children per task, delegation depth/loops) stored as `workflow-limits`/`task-meta` entities. A trip pauses the workflow with the recorded reason, aborts running tasks via the scheduler (leases release when the provider process closes) and needs `POST /workflows/:id/limits/resume` with raised limits. Task `completionChecks` are a hard gate in `transitionTask`: completion requires passing evidence for the exact result hash (the `validation-gate` check reuses `validation.gate`).
- `diff.ts` holds pure review-diff helpers (revision validation, header metadata, name-status parsing, size caps) used by `workspaces.ts` `review()`; branch compare resolves user revisions with `rev-parse --verify` to SHAs before diffing, with literal pathspecs.
- `approvals.ts` surfaces provider permission requests; `workspaces.ts`/`development.ts` handle sandboxed file browsing, Git, worktrees, dev servers (path traversal, symlink escapes and `.git` access blocked); `skills.ts` + `assets/` carry curated skills (separate from locally installed harness skills) with preserved licenses.
- `validation.ts` (`TeamService.validation`): tasks with `requiresValidation` stay queued (`waitReason: "validation-required"`, `transitionTask` → `validation_required`) until an immutable `validation` record (SQLite triggers forbid update/delete) passes for the hash of the task's current inputs. Only a real kernel run (version, output, exit 0, all assertions passing) counts; runs share a `ResourceCoordinator` slot pool capped at two and obey the live-execution switch. The `wolframscript` smoke test is opt-in (`AGENTTEAM_WOLFRAM_SMOKE=1`).
- `provider-errors.ts`: `executeCommand` rethrows every failure as a `ProviderError` (original `AppError` code kept, message prefixed `[kind]`); `config.ts` `providerLimits()` picks chat vs task timeout/output bounds (`AGENTTEAM_{CHAT,TASK}_{TIMEOUT_SECONDS,MAX_OUTPUT_MB}`); the scheduler uses the `task` profile.
- `reviews.ts` (`/agents/:id/reviews/*`) persists line comments anchored by side/line/hunk hash (outdated when the hunk changes), per-file reviewed marks and the approve/request-changes decision; it never runs Git mutations. `teams.ts` (`/teams*`) holds portable team templates and inserts them atomically with ID remapping and workspace-slot mapping; the UI lives in `ui/components/Teams.tsx` with bundled starters in `assets/team-templates/`. `samples.ts` creates the paused Wolfram-validated sample and gates resume on verified model mappings.

Resource locks cover only AgentTeam-run work, not external CLI/native sessions or editors.

## Release

`.github/workflows` checks macOS/Windows/Linux and builds installers on release tags; macOS signing is in `SIGNING.md`. A configured workflow or version bump is not evidence of a published release.
