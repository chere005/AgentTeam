# AgentTeam feature backlog

Updated October 18, 2026. This is the remaining work for the desktop application, including the approved additions from AutoGen Studio, Flowise, Happy, and Vibe Kanban. A feature is complete only when its interface, backend behavior, persistence, and relevant tests work together.

**Maintenance:** remove completed tasks after verification; keep this file focused on remaining work. Record completed behavior in release notes or implementation documentation.

**Status:** unchecked items remain open, including partial implementations. **P0** means required for a dependable first release; **P1** means the next complete workflow; **P2** means an approved expansion after the local workflow works. These priorities describe implementation order, not agent scheduling priority.

## Current baseline

**Continuation checkpoint:** see [docs/CONTINUATION.md](docs/CONTINUATION.md) for the current handoff: what exists, how it was verified, limitations and next steps. Teams and projects are separate (a team is the persistent org of agents, a project is work assigned to it; see `CLAUDE.md` glossary). The plan/implement/review/adjudicate pipeline team and its projects (`src/pipeline.ts`, `src/handoffs.ts`) are implemented and fixture-tested only:

- [ ] Run a pipeline team's project once against real installed providers (Opus 5.5, Sonnet 5.5, Fable 5.1, Codex max effort; never run live yet). Confirm the real model ids and Codex's top effort name (the default `max` is blocked at verification if the install does not advertise it), that integration steps really merge worktrees, and that fix-worker worktrees (created after the first integration) contain the integrated result.

The local application already has a three-pane layout; compact and detailed agent cards; a communication graph; agent configuration; persistent conversations; workflow tasks and dependencies; resource locks with waiting-time aging; skill inventories; a file browser; basic Git operations; and cross-platform packaging configuration.

The code review viewer now has changed-file navigation, staged and unstaged views, colored unified diffs, and old/new line numbers. Backend tests cover new files and deleted directories. It still needs desktop interaction testing and the review actions below.

Automatic harness discovery, model choices, and manual executable overrides need real-installation verification. Worktree creation, inline feedback, and basic development-server controls/preview now have desktop implementations and a passing combined fixture test. Their advanced behavior and platform coverage remain open below. ACP v1 has a working protocol-fixture integration; real provider adapters still need validation.

Current check results are recorded in docs/CONTINUATION.md (fixture and desktop tests on macOS). Live-provider and other-platform ACP validation remain pending. Release workflow configuration exists; publication and downloadable artifacts still need verification.

## Wolfram-validated math/physics team — projects of the Wolfram-validated reasoning team

- [ ] Whenever mathematical reasoning/calculation is needed, invoke one or two Wolfram agents (hard concurrency cap of two) to derive and independently validate the result where appropriate.
- [ ] Require executable Wolfram Language validation code and actual kernel execution; agent agreement, generated code, or prose alone must never satisfy the gate.
- [ ] Block every dependent reasoning step until its exact mathematical inputs pass validation. Failure, unresolved symbolic conditions, missing kernel, timeout, disagreement, or changed inputs keep the gate closed and trigger bounded correction/revalidation.
- [ ] Validation state, blockers, attempts and scrollable Markdown notes are in the workflow UI; still open: links from notes to evidence records, and checking the final-answer step with a real Opus run (example team and its projects exist, paused; nothing run live).
- [ ] Remaining: real-kernel smoke test (`AGENTTEAM_WOLFRAM_SMOKE=1`, never run yet) before claiming end-to-end validation. Fake-kernel tests cover wrong/correct math, stale evidence, cancellation/restart, unavailable runtime and the two-run cap.

## 1 Complete the current development tools — P0

### Code review viewer

- [ ] Verify the Review tab in the running desktop app in the right pane too (Playwright e2e/review.spec.ts covers one pane with narrow layout and keyboard navigation).
- [ ] Finish inline comments: select a changed line, show its file and old/new line anchor, write feedback, and choose a recipient agent.
- [ ] Show whether feedback was sent, queued, or scheduled; offer Open conversation for the recipient.
- [ ] Persist review comments and expose unresolved/resolved status; mark outdated anchors when the diff changes.
- [ ] Add an overall review summary and explicit Request changes / Approve review actions. Approval must not silently commit or merge.
- [ ] Add desktop (Playwright) coverage for the binary, truncated-diff, deleted-tree and unusual-name notices; backend fixtures and the rename/mode UI are already covered.
- [ ] Add per-file reviewed markers tied to the current diff snapshot so changed content becomes unreviewed again.
- [ ] Scope review to an agent's task (worktree/shared-checkout attribution is done; tasks do not record a base revision or workspace yet).

### Automatic worktree setup

- [ ] Auto-create setting (`/worktrees/settings`, global toggle in the Git pane, per-repository overrides API-only) runs only for tasks created through `POST /tasks`; tasks created by templates/samples/service calls, a per-project UI, and an HTTP-level test of the auto path remain.
- [ ] Test creation, attachment, failure recovery, and cleanup on macOS, Windows, and Linux (verified on macOS only; `/dev/null`-style and permission assumptions are untested elsewhere).

### Development server and preview

Implemented and verified on macOS (`src/devserver*.ts`, `ui/components/DevServer.tsx`, `test/devserver.test.ts`, `e2e/preview.spec.ts`): settings, suggestions, lifecycle/readiness, port/early-exit/redirect/PORT-ignoring handling, process-group tree stop incl. shutdown, isolated iframe preview, viewports, console capture, resource-lock warning.

- [ ] Run `test/devserver.test.ts` and `e2e/preview.spec.ts` on Windows (`taskkill /T`; a wrapper that exits before its children leaves them unreachable) and Linux; fix platform differences.
- [ ] Add desktop coverage that the blocked-embedding fallback (`X-Frame-Options`) renders and that Open in browser launches the system browser (only the link target and backend detection are tested today).
- [ ] Console capture needs the desktop shell (webContents `console-message`); the standalone backend has no embedded preview. Decide whether a browser-only preview is needed.
- [ ] Descendants that detach themselves (`setsid`/daemonizing servers) escape the process group; consider a recorded child-pid sweep if this shows up in real projects.

## 2 Finish the requested agent editor changes — P0

No open items. Invocation-limit display, installation-validated model/effort choices and unavailable-model warnings are implemented and covered by `e2e/runtime-settings.spec.ts`; this heading is kept so section numbers stay stable.

## 3 Provider installations and useful agent execution — P0

### Hybrid architecture and ACP integration

**Decision:** use a hybrid backend. Keep AgentTeam's product-specific orchestration in TypeScript: TeamService owns routing and communication permissions; Scheduler chooses eligible work; ResourceCoordinator handles priority, fairness, locks, and concurrency; SQLite stores tasks, sessions, and events. Use the standard ACP SDK for client-to-agent transport. Retain direct CLI adapters and the Wolfram bridge. Do not introduce Redis or Temporal infrastructure for the local desktop release.

**Workflow engine decision remains open:** prototype XState versus LangGraph before implementing durable checkpoint/resume. XState is a candidate for explicit lifecycle transitions; LangGraph is a candidate for executable workflow state/checkpoints. Do not install both by default or mistake database persistence for recoverable execution.

Remaining ACP and orchestration work:

- [ ] Evaluate released Codex ACP and Claude Agent ACP adapters, including version compatibility, licenses, installation/distribution, and actual account authentication. The SDK fixture passing does not establish live-provider compatibility.
- [ ] Verify existing subscription authentication and installed-runtime selection for each adapter; do not assume an SDK-based adapter inherits CLI login or billing behavior.
- [ ] Add metadata-only Test connection and show negotiated capabilities/configuration choices in the agent editor. Current editor choices still come from direct runtime discovery.
- [ ] Expand the adapter interface into reusable session lifecycle operations, avoiding per-turn process startup where persistent connections are supported.
- [ ] Map usage, rich tool output, files, and other negotiated event types into the UI. Show supported versus unavailable optional/draft/provider extensions explicitly.
- [ ] Implement ACP filesystem/terminal client services within AgentTeam's access policy. They are currently advertised as unavailable; adapters can still use their own native tools and permissions.
- [ ] Constrain or account for native subagents so they cannot bypass communication rules, resource locks, and invocation limits. Do not advertise native subagent support before this works.
- [ ] Implement teammate invocation as AgentTeam-controlled tools/actions; ACP alone does not route arbitrary teammates.
- [ ] Harden adapter process-tree shutdown, configurable timeouts, reconnect, and uncertain-outcome handling without blind replay of external side effects.
- [ ] Add opt-in real-provider smoke tests and cross-platform ACP packaging tests before making ACP the preferred default.
- [ ] Integrate the internal Wolfram ACP project later. The user has access; obtain its repository/documentation when this work begins and verify capabilities, authentication, session behavior, and distribution permissions. Do not publish internal code/artifacts without authorization; retain the current bridge in the interim.
- [ ] Prototype the same Builder → tests → Reviewer → approval workflow with XState and LangGraph, including interruption/restart. Compare dependency/packaging size, state migrations, effect idempotency, and fit with ACP and custom resource scheduling; record the chosen execution engine.

References: [ACP protocol](https://agentclientprotocol.com/protocol/overview), [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp), [Claude Agent ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp). MIT/Apache-2.0 licenses apply to the proposed libraries; provider services and internal Wolfram distribution rights remain separate.

### Installation and runtime validation

- [ ] Verify automatic discovery of existing Codex, Claude Code, and Wolfram installations on all supported platforms.
- [ ] Reuse provider-managed authentication without importing or displaying raw credentials.
- [ ] Verify Windows command-shim launching (`.cmd`/`.bat`, src/runtime-spawn.ts) on a real Windows machine with npm-installed Codex/Claude; it is fixture-tested only. Removal, stale manual paths, upgrades, diagnostics, reset/rescan and startup waiting are implemented and tested with fixtures.
- [ ] Validate CLI flags and model/effort discovery against actual supported provider versions.
- [ ] Move beyond the current read-only Codex adapter and tool-free Claude adapter so agents can perform authorized coding work.
- [ ] Implement provider permission/approval handling and expose pending approvals in the UI.
- [ ] Map attached folders and read/write settings to real provider restrictions where supported; state remaining limits clearly.
- [ ] Validate Wolfram execution with a configured local installation, evaluator selection, error handling, and session context.
- [ ] Preserve provider session identity and verify resume after restart, model changes, and human takeover.
- [ ] Provide a guided first-run check that does not require an Enable execution checkbox and does not unexpectedly drain old queued work.

## 4 Saved teams and reusable configurations — P1

- [ ] Teams vs projects (example teams in the library, `src/example-teams.ts`, `src/team-profiles.ts`, `src/projects.ts`, "Assign project"; Team settings `src/team-settings.ts`; project lifecycle `src/project-lifecycle.ts`): remaining: a project cannot be moved to another team's agents; Team settings resizes only the pipeline (implementation/fix) and Wolfram (validators) worker roles (no editing of models, efforts, lead, role mapping, expectations or workspace access defaults; free-form teams have no countable roles); a worker removed while finished history refers to it is retired (kept on the canvas, out of the role) because tasks keep their agent id; new workers are copies of the role's last agent without folders (routing rules where it is the source and its connections are copied; rules targeting it are not); new agents are ordered after existing siblings by creation, so a new implementation worker sits after the fix workers under the integrator until moved; worktrees created for a project are not removed or detached by "Detach folders" (managed worktrees stay; only the recorded project workspace attachments are detached); projects created before attachment tracking have nothing recorded and offer no detach; pipeline workers keep the shared checkout attached next to their worktrees, read-only while they have a worktree of it (AgentTeam-mediated writes are refused; a provider writing there on its own is still only detected, as per-folder OS sandboxing is not implemented), and such a worker can no longer manage that checkout's worktrees itself (an agent with write access, e.g. the integrator, removes them; removing the last one restores the worker's write access); the scoped fingerprint leaves out only the agent/folder pairs another project recorded and that do not overlap this project's workspace; two pipeline projects on one team still share worker agents (one run per agent at a time); none of the three example teams or their projects has run against live providers, and the product feature team's mandatory-review/security rules were checked with the routing preview and backend tests only.
- [ ] Swift development pack: a skeleton exists (`assets/team-packs/swift-development`, manifest/agents/required review/groups; only bundled skill is `swift-expert`, nothing live-run). Remaining: a validated Swift workflow and live run, and the skills it lists as "not bundled — install separately" (Swift Testing/XCTest, SwiftUI accessibility, Xcode/simulator tooling, signing/release). Other specialist packs beyond Swift are not started.
- [ ] Team packs: no UI for pack export/authoring, remote pack sources, or a signed/hashed pack feed; updates diff agents/connections/rules (not folders, canvas layout or groups) and never delete agents.
- [ ] Save agent roles, instructions, models/effort, skills, limits, priorities, internal communication edges, routing rules, and relative layout.
- [ ] Keep live sessions, credentials, running tasks, leases, and transient process state out of templates.
- [ ] Provide a saved-team library with preview, rename, update/version, duplicate, insert, and delete. (UI built; only preview and insert are covered by the desktop test — rename/duplicate/delete/export/import UI and a starter-gallery insert are not yet exercised in the app; version bump is automatic on rename, no explicit update flow.)
- [ ] Prompt for workspace/resource mappings when inserting a team; copying absolute paths must be explicit.
- [ ] Preserve the single global Team Assistant rule when saving/inserting groups.
- [ ] Export/import portable team configurations with a schema version, compatibility checks, and no secrets.
- [ ] Add a small starter gallery: implementation/review, database work, research, and Wolfram computation teams.

## 5 AgentTeam assistant and conversation workspace — P1

- [ ] Widen the Team Assistant's change tools: proposals (`src/assistant.ts`) cover agent create/update, agent skills add/remove, edge create/update, rule create, workflow create + stopping limits and folder attach/detach, applied only by the user. Missing: saved-team insertion, rule edit/delete, deleting agents/edges/workflows, `resources.save` and workflow coordination operations. Assistant output reaches the backend only as a fenced `agentteam-proposal` block read by `/assistant/proposals/extract` (automatically from the chat card); no provider tool endpoint (MCP/ACP) exposes it.
- [ ] Live-check the Team Assistant proposal protocol (`src/assistant-protocol.ts`) with real Codex and Claude: "Add appropriate skills to all the other agents" should yield a plan plus one valid block. Only a fixture CLI (`test/fixtures/assistant-codex-fixture.mjs`) has been tested; prompt size is ~9k chars of protocol plus up to 40k of team state. Direct form edits are not audited with an actor (only proposal steps are).
- [ ] Complete the three agent-opening modes: embedded conversation and CLI/native ownership are explicit (`src/ownership.ts`), but CLI is still copy-a-command instructions and native launch is `open -a` on macOS only (other platforms refuse); a native app's separate conversation is flagged, never imported.
- [ ] Replace CLI instructions-only behavior with an embedded terminal when the provider supports it.
- [ ] Verify the conversation workspace in the app with real replies: unread badges/divider (`useUnread`) and streamed partial text/tool activity (`LiveActivity`, from `runtime.text`/`runtime.tool` events) are unit-tested only; direct CLI adapters emit whole messages and only ACP emits chunks/tool calls.
- [ ] Exercise the task/event/review-comment links to a conversation point in the app (`/conversations/link`, backend-tested): a background task run is not stored as conversation messages, so a task link opens the nearest message in time and says so.

## 6 Real agent-to-agent orchestration — P1

- [ ] Make specialist/required-review file evidence independent of the invoking agent: today `changedFiles` is declared on the task or reported in the result JSON, not measured from Git; a task that omits it can dodge a files-only rule (text/tag/catch-all rules still match).
- [ ] Expose the `invoke_teammate`/`teammate_result` tools (definitions, handlers and a per-run-token JSON-RPC handler exist in `src/orchestration.ts`/`src/tool-endpoint.ts`) to actual provider runs: mount the endpoint in the loopback server, issue a token per task run in `Scheduler.execute`, and inject URL+token (never logged, never in argv) into Claude `--mcp-config`, Codex MCP config and ACP `session/new` `mcpServers`; not done or live-verified for any adapter. Native provider subagents are not covered and do not obey AgentTeam limits.
- [ ] Enforce directed/bidirectional communication permissions on notifications (invocation, result reads and required/specialist reviews are enforced and tested; notifications are not routed through the new action).
- [ ] Surface cancellation propagation, `delegation.returned` events and partial results in the UI/canvas, and deliver a child's partial result back into the parent's context (backend propagation and persistence are done).
- [ ] Show pending, running, returning, failed, and blocked communication on the canvas, with actual direction and correlated messages.

## 7 Checkpoints and reliable workflow recovery — P1

Implemented and fixture-tested (see `docs/durable-execution.md`): immutable checkpoints, effect ledger, interrupted/blocked recovery, retry policy, persisted approvals, recovery API and panel. Remaining:

- [ ] Human-input steps exist as workflow-graph nodes (persisted approval record, free-text answer, answerable after restart); still open: agent- or provider-initiated free-form questions inside a running task with resume at the same point.
- [ ] Verify resume with a live provider: the recorded provider session id is passed to Codex/Claude/ACP on resume, but only fixture adapters were exercised. Record ACP `session/load` support before relying on it.
- [ ] Route AgentTeam-controlled teammate/tool invocations through the effect ledger when they exist (today the ledger covers provider runs, chat runs and ACP mutating tool calls).
- [ ] Decide the execution engine (XState or LangGraph) using the prototype task in section 3; the checkpoint/ledger entities are engine-agnostic.

## 8 Stopping conditions and usage limits — P1

- [ ] Verify token-usage parsing against live Codex/Claude/ACP output (fixture-tested only; Wolfram and ACP report no usage today, shown as unavailable).
- [ ] Detect subscription-quota vs API-key access per provider; today cost is always shown as unavailable and tokens are never converted to dollars.

## 9 Team playground and run inspector — P1

Implemented and fixture-tested (`src/inspector.ts`, `src/playground.ts`, `src/diagnostics.ts`, `src/redact.ts`, `src/inspector-routes.ts`, `ui/components/Inspector.tsx`; tests `test/inspector.test.ts`, `e2e/inspector.spec.ts`). Remaining:

- [ ] Optional, explicitly user-enabled live-provider playground run; today playground runs are fixture-only by design.
- [ ] Diagnostic export now saves through a main-process "Save as…" IPC (`save-diagnostics`, `src/diagnostic-save.ts`: the renderer names only the format; main fetches the bundle, shows the dialog and writes the one chosen file; test mode records it). Only the stubbed dialog path is tested; open the native dialog by hand in a packaged build (also Windows/Linux).

## 10 Shared workflow state and artifacts — P1

Implemented and fixture-tested (`src/shared-state.ts`, `src/artifacts.ts`, `src/shared-routes.ts`, `ui/components/SharedState.tsx`; see `docs/durable-execution.md`). Remaining:

- [ ] Verify the `agentteam-state` structured-output block with a live provider (fixture-tested only) and add a provider-tool path (ACP/MCP) that writes state through `SharedStateService.write` with the same permission and version checks.

## 11 Conditional workflows and deterministic steps — P1

**P0 exception — required validation gates, before autonomous sample execution:**

- [ ] Bind gate evidence to exact inputs/revisions and require the configured check/review outcome; missing, failed, inconclusive, cancelled, or stale evidence keeps the gate closed. Surface blockers and retain decisions across restart. Use this mechanism for the Wolfram sample's actual kernel-validation requirement.
- [ ] Test gate bypass attempts and stale evidence with controlled fixtures, then verify provider/kernel execution separately. Preserve mock-based orchestration tests; do not adopt a blanket ban on mocks or treat fixture success as live-provider validation.

Workflow graphs are implemented and fixture-tested (`src/workflow-graph*.ts`, `ui/components/WorkflowGraphs.tsx`, `test/workflow-graph.test.ts`, `e2e/workflow-graph.spec.ts`; see `docs/durable-execution.md`). Remaining:

- [ ] Let graph steps write typed outputs into shared state/artifacts through `SharedStateService.write` (steps can only read state today).
- [ ] Abort a running command step when a limit trip or runtime budget pauses the workflow (today it ends by its own timeout or a run cancel).
- [ ] Join early exit (continue after N branches and cancel the rest), graph delete/archive, templates/import, and a graph-aware card on the canvas.
- [ ] Verify agent steps of a graph with a live provider (fixture-tested only) and the command step on Windows (path confinement and `taskkill` tree stop are unverified there).

## 12 Skills, tools, and reference knowledge — P1

- [ ] Expand useful coverage of popular languages, frameworks, databases, testing, security review, and Wolfram work where gaps remain.
- [ ] Keep curated defaults and locally installed harness skills in separate sections, grouped/filterable by environment.
- [ ] Keep permanent role instructions short and focused on responsibilities/output contracts. The agent panel shows a soft length hint (above 1500 characters) and the Skills view charts the approximate context cost of recent runs; remaining is editorial: review bundled team/pack role instructions against that threshold.
- [ ] MCP/tool registry follow-up: registry, per-agent grants, env-var-reference auth and metadata-only test exist, but no adapter passes granted servers to a provider (ACP `mcpServers: []`, Claude `--strict-mcp-config`); wire exposure with runtime enforcement, and add OS-keychain auth if wanted.

## 13 Resource access and cooperative work — P1

- [ ] Guided parallel work (assignment of disjoint paths/worktrees, integration step, conflict routing; `src/parallel.ts`) is backend-tested only: add Playwright coverage for the Resources > "Guided parallel assignments" form, a real scheduler-driven parallel run with fixture providers, and detection for workers editing non-Git folders (currently reported as "unavailable"). Manual `POST /tasks/:id/status` completions skip conflict detection.
- [ ] Register provider process ids for ACP-native subagents (only the direct-CLI and ACP adapter processes are recorded for lock draining).

## 14 Git and file workspace polish — P1

Implemented and verified on macOS with temp repos/local bare remotes (see `src/git-workflow.ts`, `git-remote.ts`, `git-stage.ts`, `editors.ts`, `previews.ts`, `fs-watch.ts`, `workspace-routes.ts`): branch switch/create with safety confirmations, fetch/pull(ff-only)/push, bounded history, compare-URL PR links with manually recorded PR status, conflict visibility/resolution/abort/continue, deleted-tree/rename/unborn staging, typed previews, editor executable paths, debounced `fs.watch` refresh with poll fallback.

- [ ] Fetch live PR status (checks, merged/closed) from hosting APIs; today PR status is only what the user records manually (no tokens or API calls by design).
- [ ] Verify Open file, Open project, Reveal and Open with on real Windows and Linux machines, and `fs.watch` recursion there (those paths are fixture-tested only; macOS launch is verified through stub executables, not by opening GUI apps).

## 15 Layout and interaction quality — P1

- [ ] Progressive-disclosure shell (`docs/ui-design.md`; canvas + chat at start, agent panel, More/Ctrl+K palette, feature tabs per team) is checked on macOS at 1440 and 1100 px wide only, in both themes (`e2e/ui-polish.spec.ts` screenshots in `test-results/ui-polish/`); remaining: the "Review changes" entry polls Git status of the agent's write folder on events (no backend summary); the agent panel's skill picker lists at most 60 matches; the unsaved-changes guard covers the UI's own close/switch actions, but a team change the backend makes on its own (an insert elsewhere activating its new team) still closes the panel without asking; closing or reloading the window with unsaved edits asks natively (Discard changes / Keep editing, `will-prevent-unload`), which test mode skips, so that dialog itself is untested.
- [ ] Canvas fit and light theme (`ui/canvas-fit.ts`, `ui/theme.ts`, `ui/theme-light.ts` + `ui/theme-light.css`, compact org layout `fitOrgLayout` in `ui/org-layout.ts`): an automatic arrangement reflows wide leaf-sibling rows into staggered lines when the regular chart would not fit the canvas at zoom 0.4, and re-flows on canvas resize while nobody moved a card; a hand-placed arrangement wider than the canvas is still cut until panned, Arrange or Fit; wide rows whose siblings have their own reports are not wrapped. The light theme is derived from the dark rules at build time plus hand-tuned exceptions; rendered text contrast is checked (WCAG AA) on the canvas, agent panel, Projects, Team settings and Settings only (`e2e/ui-polish.spec.ts`), other panes were looked at in screenshots only; the first-paint theme (preload + window background from the stored setting) is checked through the main process state, not by capturing the first frame.

- [ ] Active-team switcher (`src/team-spaces.ts`, `ui/team-view.ts`, `TeamSwitcher.tsx`): no UI to move an existing agent or workflow to another team (API `POST /team-spaces/:id/members` only); the approval popup, the diagnostic bundle and the Resources "shared resources" choice list stay global; the Run inspector's Transfers/Playground sections use the team's agents but the backend `/inspector/transfers` is not team-filtered; the switcher was checked at one window width only (screenshots at the default test window size).

- [ ] Org-chart arrangement (`ui/org-layout.ts`): canvas positions are one global map, so the Team Assistant (shown in every team) moves with each team's Arrange; subtrees are spaced by full subtree width (no contour packing), so very wide teams fit at far zoom; collapsed groups are laid out as their members; agents added to an arranged team are placed relative to their parent and can overlap manually moved cards until Arrange; checked on macOS at one window size.
- [ ] Make detailed cards' configuration summary (read-only grid added) visually verified at several widths, and verify the busy/failure/flow animations and `prefers-reduced-motion` behavior in a running app (CSS added in `canvas-cards.css`, only far-zoom card layout was inspected; large-graph "calm" mode above 40 agents is untested).
- [ ] Attention inbox: "ready review" is a heuristic (completed task whose agent has an enabled outgoing review edge) because review state is per agent/git diff and not in the snapshot; consider a backend summary endpoint.
- [ ] Groups now travel with saved teams/packs (template schema v2, `groups`), but live canvas group membership is still renderer localStorage, not a team entity; the saved-team Save dialog group path is backend-tested only (the desktop test covers pack insert).

## 16 Mobile continuation — P2

- [ ] Design a paired-device protocol that continues the same session from a phone while execution stays on the host.
- [ ] Provide secure pairing, device revocation, authentication, and encrypted transport/storage for synchronized content.
- [ ] If promising end-to-end encryption, implement and test client-held keys and encrypted relay payloads before making that claim.
- [ ] Show host connectivity and distinguish offline queued input from delivered/executing requests.
- [ ] Support mobile conversation, status inspection, approvals, pause/cancel, and takeover/return.
- [ ] Prevent concurrent devices from issuing conflicting commands to the same session.
- [ ] Add opt-in notifications for actionable events and completion, with privacy controls.
- [ ] Decide whether the first mobile client is responsive web/PWA or native based on the required background and notification behavior.

## 17 Shared sessions with other people — P2

- [ ] Invite a collaborator to a specific session/team with viewer or controller permissions.
- [ ] Require explicit sharing scope; do not expose every local project, file, credential, or agent.
- [ ] Synchronize transcript, task state, and review feedback with clear participant attribution.
- [ ] Implement an exclusive steering/control owner with explicit handoff and host override.
- [ ] Add invite expiration, revocation, participant presence, and an audit history of shared-session actions.
- [ ] Prevent duplicate commands after disconnect/reconnect and reconcile offline changes.
- [ ] Keep shared access separate from model-provider account credentials and subscription authorization.

## 18 Packaging, release, and maintenance — P0 then P1

- [ ] Make Windows and Linux CI deciding again (`optional` in `.github/workflows/ci.yml`, continue-on-error test steps in `release.yml`): Windows fixes for Git config paths, CRLF fixtures, URL-pathname paths, path casing and unsupported filenames are on `fix-windows-tests`, awaiting another Windows CI run; Linux Playwright remains slow and has a contrast-test timeout (see docs/CONTINUATION.md).
- [ ] `e2e/workflow-graph.spec.ts` is intermittent (`flow-node-check` not visible, about 1 run in 4 locally).

- [ ] Finish and test the current local changes before including them in release claims.
- [ ] Push the completed source changes to the public chere005/AgentTeam repository.
- [ ] Verify the v0.1.0 tag and GitHub Release, including actual downloadable artifacts rather than only workflow configuration.
- [ ] Build macOS arm64/x64 DMG and ZIP, Windows x64 installer, and Linux x64 AppImage/deb, with published checksums.
- [ ] Run desktop smoke tests on all supported OS targets and installation tests for packaged applications.
- [ ] Test Developer ID signing and notarization using the other Mac's credentials or configured GitHub secrets; never commit credentials.
- [ ] Clearly distinguish signed/notarized builds from unsigned builds in download and installation instructions.
- [ ] Verify bundled notices and licenses for application dependencies and every distributed skill. `scripts/audit-release.mjs` (run in CI) now checks the lockfile, production-dependency license allow-list, per-skill license text and `SKILL.md` hashes; still open: confirm Electron/Chromium notices inside a built package and legal review of the allow-list.
- [ ] Add versioned database migrations, backup/export, import/restore, and recovery from migration failure.
- [ ] Add safe update distribution, release notes in-app, and restart behavior that respects active work.
- [ ] Keep README, release notes, screenshots, and this backlog aligned with the behavior actually shipped.
- [ ] Follow [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for each release; README/release notes were re-checked against the code on October 18, 2026 (execution default, limits, validation gate, review, templates, diagnostics), but `docs/team-canvas.png` has not been re-captured.

## Suggested implementation order

1. Finish Review, inline feedback, worktree setup, and dev-server preview as one tested coding workflow.
2. Finish editor refinements, then establish the common runtime interface and validate ACP adapters before expanding provider-specific execution. Verify discovery, model/effort choices, existing account authentication, and real coding permissions.
3. Implement scheduler-enforced validation gates and durable handoff evidence before running either requested sample autonomously. Add role presets and explainable conditional specialist routing alongside actual teammate invocation.
4. Add checkpoints, stopping conditions, and the run inspector before expanding autonomous workflows.
5. Add saved-team packs and their versioned manifests, lean instructions/on-demand skills, and Team Assistant configuration actions; extend shared state, conditional/tool steps, MCP, and reference knowledge. Pack distribution follows gate correctness and local template validation.
6. Harden resource coordination, Git integration, packaging, and cross-platform behavior throughout the above work.
7. Add mobile continuation and shared human sessions once local session ownership/recovery is reliable.

## Design references

These are references for the approved features, not dependencies selected for AgentTeam:

- [AutoGen Studio](https://microsoft.github.io/autogen/dev/user-guide/autogenstudio-user-guide/index.html): team playground, component gallery, message-flow inspection, termination conditions.
- [Flowise Agentflow](https://docs.flowiseai.com/using-flowise/agentflowv2): checkpoints, human input, shared state, conditional/tool steps, MCP and knowledge sources.
- [Happy](https://github.com/slopus/happy): subscription-backed sessions, encrypted mobile continuation, shared sessions with other people.
- [Swift Agents](https://github.com/Techopolis/swift-agents): approved inspiration for specialist team packs, lean role prompts/on-demand skills, conditional specialist reviews, and coordinator separation. Keep the cross-platform Electron/TypeScript and hybrid ACP architecture; enforce required gates in AgentTeam rather than relying on prompt hooks. Repository is MIT; verify each companion skill separately before redistribution.
- [Vibe Kanban](https://www.vibekanban.com/): worktree setup, code review/feedback, development preview. Its website currently announces sunsetting with community maintenance continuing.
