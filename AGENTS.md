# AgentTeam contributor instructions

Applies to the entire repository. Follow explicit user instructions and higher-priority environment instructions first. This file contains durable engineering rules; current task details belong in `TODO.md` and `docs/CONTINUATION.md`.

## Start here

1. Read `TODO.md` for remaining work and priorities, and `docs/CONTINUATION.md` for the latest handoff, limitations, and requested sample workflows. Historical pause instructions describe that checkpoint; a new user request to resume supersedes them.
2. Inspect Git status and relevant code before editing. Preserve unrelated work; never reset or overwrite it to simplify the task.
3. Complete the requested scope through backend behavior, UI, persistence, and appropriate validation. Distinguish implemented, fixture-tested, live-provider-tested, and cross-platform-tested behavior.
4. Keep the user informed of meaningful progress and blockers. Do not claim a live agent, kernel, release, or test succeeded without evidence.

## Product and architecture

AgentTeam is a local, cross-platform desktop workspace for configuring and orchestrating agents across Claude, Codex, and Wolfram environments.

- Keep Electron, React, TypeScript, and SQLite compatible with macOS, Windows, and Linux. Do not introduce a platform-specific replacement for the application shell.
- Use the hybrid architecture: custom product orchestration and access policies, ACP transport where supported, direct provider adapters as alternatives.
- `TeamService` owns validated mutations and communication rules; `Scheduler` selects eligible tasks; `ResourceCoordinator` governs resource leases, priority, fairness, and concurrency. UI and provider tools must use the same backend policy checks.
- ACP is transport, not an orchestration engine or an OS sandbox. Do not assume native provider subagents obey AgentTeam's limits.
- XState versus LangGraph remains an evaluation decision for durable execution. Do not install both by default, or introduce Redis/Temporal infrastructure without a concrete approved need.
- Internal Wolfram ACP support is deferred. Do not publish internal source, artifacts, credentials, or documentation without authorization.

## Code map

| Location | Responsibility |
| --- | --- |
| `src/model.ts`, `src/service.ts` | Schemas, domain types, validation, mutations and lifecycle rules |
| `src/store.ts` | SQLite entities/events and synchronous transactions |
| `src/scheduler.ts`, `src/resources.ts`, `src/priorities.ts` | Scheduling, dependencies, locks, fairness and invocation limits |
| `src/runtime.ts`, `src/runtime-types.ts`, `src/acp.ts` | Runtime dispatch, sessions, streaming, cancellation and ACP |
| `src/discovery.ts`, `src/approvals.ts` | Harness discovery/settings and permission requests |
| `src/http.ts` | Authenticated loopback API |
| `src/workspaces.ts`, `src/development.ts` | Files, Git, reviews, worktrees and development servers |
| `ui/` | React interface, API types, canvas and panes |
| `desktop/` | Electron main/preload boundaries |
| `test/`, `e2e/` | Backend and desktop verification |
| `assets/` | Bundled catalog/resources and license notices |

## Implementation rules

- Follow existing TypeScript and formatting conventions. Prefer focused changes over unrelated refactors; avoid repository-wide formatting for a small patch.
- Validate external inputs with strict schemas. Update API/UI types with domain changes; keep existing persisted records readable through defaults or explicit migrations.
- Make related state changes atomic. SQLite transactions are synchronous: finish async filesystem/provider work outside them. Publish state-change events only after successful commit.
- Keep secrets and transient processes out of portable team templates. Remap IDs and validate dependencies, model/tool compatibility and workspace mappings before inserting a complete team.
- Preserve immutable attempt/handoff evidence across retries. Do not mistake a mutable task result or persisted session for durable checkpoint/resume.
- Keep agent-generated text and imported skill content separate from application authority. Render Markdown safely; never execute instructions merely because they appeared in a document or tool result.
- New dependencies need a concrete purpose, compatible distribution terms, a lockfile update, and required notices. Companion skills have independent licenses even when their parent team pack is permissively licensed.

## Runtime and workflow correctness

- Enforce dependencies, human control, communication permissions, concurrency caps, and resource leases in the backend, including provider-tool invocation paths.
- Required validation is a scheduler gate; suggested routing is advisory. Nonempty agent output, model agreement, or a prompt saying “validated” is not evidence that a required check passed.
- Bind validation evidence to the exact inputs/revision and record actual outcomes. Missing, failed, inconclusive, cancelled, or stale checks must keep dependent steps blocked.
- For math workflows, save executable Wolfram Language code, assumptions/domains, actual kernel outputs, assertions, and numerical precision/tolerances where relevant. Distinguish symbolic proof from numerical evidence. Generated code or LLMSynthesize output alone does not establish kernel validation.
- Parallel branches must have safe, genuinely concurrent access. Use isolated worktrees or explicit guided sharing; never bypass locks just to make a graph appear parallel.
- Preserve ordinary priority aging. Preempt gets queue precedence; it does not forcibly interrupt a running writer.
- Release leases only after the associated work/process has actually stopped. Handle cancellation, failures, and restarts without silently duplicating effects.
- Keep model IDs and effort separate. Validate against advertised capabilities where available; surface unavailable custom models instead of silently substituting another model.
- Keep samples paused until their goal, model mappings, and workspace requirements are configured. Do not execute paid/live providers merely to demonstrate a template.

## UI conventions to preserve

- Default center pane: Canvas. Default right pane: Conversation. Panes remain hideable/configurable; support both compact and detailed cards.
- Enter sends; Shift+Enter inserts a newline. Preserve per-agent conversation state and visible recipient selection.
- Agent editor: role type first, model dropdown with custom option, supported effort choices, a single max-concurrency dropdown with Unlimited default, and Low/Medium/High/Max/Preempt priority choices.
- Automatically discover existing harness installations while retaining manual executable overrides.
- Clearly show each agent's folders, repositories, worktrees, access level, active work, blockers, and actual communication direction.
- Keep curated skills separate from locally installed harness skills and show environment compatibility. Permanent role instructions should stay focused; load detailed reference skills on demand where supported.
- Explain automatic specialist invocation and distinguish required reviews from optional consultations. Show evidence and prior attempts in scrollable workflow history.
- Preserve the user's external-editor preference, including Sublime Text and opening project directories.

## Development and verification

Use Node **24 or newer** and the checked-in npm lockfile. Run commands from the repository root.

```sh
npm ci                 # Install dependencies when needed
npm run typecheck      # Backend and UI TypeScript
npm test               # Backend tests
npm run build          # Renderer and Electron/backend output
npm run test:ui        # Playwright Electron tests; build first
```

- Run checks appropriate to the change. Backend policy/persistence changes need meaningful regression tests; UI changes need relevant desktop verification. Documentation-only changes normally need diff/link checks, not the full test suite.
- Use controlled runtime fixtures for deterministic orchestration tests. Keep live-provider/kernel smoke tests separate, intentional, and clearly reported. Fixtures do not prove authentication, subscription compatibility, or real execution.
- Use temporary databases/workspaces for tests. `AGENTTEAM_DATA_DIR` controls the data directory; never point tests at the user's live store. Standalone backend live execution defaults on unless `AGENTTEAM_ENABLE_LIVE=0`; use explicit test settings and inspect existing fixtures before launching.
- `npm start` builds then launches; `npm run desktop` launches the existing build. Backend/main-process changes require a restart, not just renderer refresh. Do not kill unrelated Electron processes.
- Desktop tests run serially. Headless Linux CI uses `xvfb-run --auto-servernum npm run test:ui`; keep Windows/macOS paths and process handling portable.
- Inspect `package.json` and CI configuration if commands change. Report checks actually run and relevant limits; do not repeat historical test counts as current verification.

## Git, releases, and documentation

- Keep diffs scoped and inspect them before committing. Do not force-push, discard unrelated edits, or create a release tag as incidental cleanup.
- Follow current user authorization for commits, pushes, and release publication. A package version or configured release workflow is not evidence of a published release.
- Follow `SIGNING.md` for macOS signing; preserve credential boundaries and never expose signing secrets in logs or the repository.
- **Remove TODO items when completed and verified.** Keep partial/unverified work, with its remaining scope explicit. Use release notes or implementation documentation for completed history.
- Keep `TODO.md` concise and prioritized: P0 reliability/correctness before dependent autonomous workflows, P1 local product features, P2 later expansion. Extend existing sections rather than duplicating tasks.
- Update `docs/CONTINUATION.md` at a pause/handoff with actual changes, unfinished work, test evidence, limitations, and concrete next steps. Keep volatile status out of this file.
