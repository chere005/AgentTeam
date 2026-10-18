# AgentTeam feature backlog

Updated October 18, 2026. This is the remaining work for the desktop application, including the approved additions from AutoGen Studio, Flowise, Happy, and Vibe Kanban. A feature is complete only when its interface, backend behavior, persistence, and relevant tests work together.

**Maintenance:** remove completed tasks after verification; keep this file focused on remaining work. Record completed behavior in release notes or implementation documentation.

**Status:** unchecked items remain open, including partial implementations. **P0** means required for a dependable first release; **P1** means the next complete workflow; **P2** means an approved expansion after the local workflow works. These priorities describe implementation order, not agent scheduling priority.

## Current baseline

**Continuation checkpoint:** see [docs/CONTINUATION.md](docs/CONTINUATION.md) for the detailed code map, verified baseline, limitations, and next implementation steps. Work is paused at the user's request. The newest requested deliverable is still unimplemented:

- [ ] Create a paused sample: Opus 5.5 plan → Sonnet 5.5 implementation with up to five workers → parallel Codex max/Fable reviews → separate Fable adjudication → up to five additional Sonnet workers → parallel final reviews → concise Fable stage report.
- [ ] Preserve immutable Markdown handoff/attempt notes across stages and retries, with a scrollable workflow history and references to the exact inputs consumed.
- [ ] Make model mappings and worker caps configurable; validate provider availability and real parallel resource access before running the sample.

The local application already has a three-pane layout; compact and detailed agent cards; a communication graph; agent configuration; persistent conversations; workflow tasks and dependencies; resource locks with waiting-time aging; skill inventories; a file browser; basic Git operations; and cross-platform packaging configuration.

The code review viewer now has changed-file navigation, staged and unstaged views, colored unified diffs, and old/new line numbers. Backend tests cover new files and deleted directories. It still needs desktop interaction testing and the review actions below.

Automatic harness discovery, model choices, and manual executable overrides need real-installation verification. Worktree creation, inline feedback, and basic development-server controls/preview now have desktop implementations and a passing combined fixture test. Their advanced behavior and platform coverage remain open below. ACP v1 has a working protocol-fixture integration; real provider adapters still need validation.

At this checkpoint, type checking and the production build pass. All 43 backend tests pass, including ACP protocol and permission tests. Desktop tests pass for agent configuration/chat, review/preview/worktree flow, and ACP settings/approval/conversation delivery. Live-provider and other-platform ACP validation remain pending. Release workflow configuration exists; publication and downloadable artifacts still need verification.

## Wolfram-validated math/physics sample — next sample workflow

- [ ] Whenever mathematical reasoning/calculation is needed, invoke one or two Wolfram agents (hard concurrency cap of two) to derive and independently validate the result where appropriate.
- [ ] Require executable Wolfram Language validation code and actual kernel execution; agent agreement, generated code, or prose alone must never satisfy the gate.
- [ ] Block every dependent reasoning step until its exact mathematical inputs pass validation. Failure, unresolved symbolic conditions, missing kernel, timeout, disagreement, or changed inputs keep the gate closed and trigger bounded correction/revalidation.
- [ ] Validation state, blockers, attempts and scrollable Markdown notes are in the workflow UI; still open: links from notes to evidence records, and checking the final-answer step with a real Opus run (sample exists, paused; nothing run live).
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

- [ ] Package reusable specialist teams with agents, lead, skills, internal rules, and required reviews; start with a Swift development pack alongside the existing starter gallery.
- [ ] Add a versioned team-pack manifest with source attribution, licenses, pinned skill dependencies, supported harnesses/tools, and model mappings. Preview compatibility and installation changes before atomic insertion; never import credentials or silently grant permissions.
- [ ] Support explicit pack updates with a configuration diff while preserving local customizations; check companion-skill licenses separately and retain required upstream notices.
- [ ] Save agent roles, instructions, models/effort, skills, limits, priorities, internal communication edges, routing rules, and relative layout.
- [ ] Keep live sessions, credentials, running tasks, leases, and transient process state out of templates.
- [ ] Provide a saved-team library with preview, rename, update/version, duplicate, insert, and delete. (UI built; only preview and insert are covered by the desktop test — rename/duplicate/delete/export/import UI and a starter-gallery insert are not yet exercised in the app; version bump is automatic on rename, no explicit update flow.)
- [ ] Prompt for workspace/resource mappings when inserting a team; copying absolute paths must be explicit.
- [ ] Preserve the single global Team Assistant rule when saving/inserting groups.
- [ ] Export/import portable team configurations with a schema version, compatibility checks, and no secrets.
- [ ] Add a small starter gallery: implementation/review, database work, research, and Wolfram computation teams.

## 5 AgentTeam assistant and conversation workspace — P1

- [ ] Give the background Team Assistant tools to create/edit agents, teams, edges, rules, workflows, and resource assignments.
- [ ] Show proposed configuration changes in a reviewable diff before applying changes with significant effects.
- [ ] Validate all assistant changes through the same backend rules as the forms; log who changed what.
- [ ] Let the assistant inspect current workflow states, queues, leases, failures, and available skills/tools.
- [ ] Make long-lived background coordination explicit: status, current goal, pause/resume, and stopping conditions.
- [ ] Complete the three agent-opening modes: embedded conversation, interactive CLI/terminal, and native application where supported.
- [ ] Replace CLI instructions-only behavior with an embedded terminal when the provider supports it.
- [ ] Preserve drafts and scroll state per agent and show unread responses without losing the current conversation.
- [ ] Stream partial text and tool activity into conversations instead of showing only completed output.
- [ ] Add message search and links from a task/event/review comment to the relevant conversation point.
- [ ] Make Take control and Return ownership explicit across embedded chat, CLI, native apps, and background tasks.
- [ ] Prevent duplicate driving of the same session and clearly show when a native app opens a separate session.

## 6 Real agent-to-agent orchestration — P1

- [ ] Add coordinator, implementer, reviewer, and adjudicator role presets with suitable default tool grants and output contracts; coordinators delegate/synthesize and reviewers/adjudicators default to read-only access.
- [ ] Trigger specialist reviews from task scope and changed files: UI → accessibility, concurrency → concurrency review, sensitive data → security, migrations → database review. Allow multiple specialists and show the evidence, matched rule, and reason for each invocation.
- [ ] Expose teammate invocation as actual provider tools, rather than relying only on routing preview and manually configured tasks.
- [ ] Enforce directed/bidirectional communication permissions on every invocation, result, review, and notification.
- [ ] Pass structured request context and return results to the invoking agent with traceable parent/child IDs.
- [ ] Complete agent-level intake rules such as “bring database tasks to me.”
- [ ] Complete action rules such as “when a database review is needed, invoke this agent.”
- [ ] Resolve competing rules by priority; show ties and the winning rule in the UI.
- [ ] Support explicit recipient overrides and sensible fallback routing for unaddressed requests.
- [ ] Route the future provider-tool teammate invocation path through `TeamService.task` so the max-children cap, depth/loop checks and limits (`src/limits.ts`) apply to it; today only workflow-task invocation exists and is enforced (per-parent `maxChildrenPerTask` plus agent `maxConcurrentInvocations`).
- [ ] Surface cancellation propagation, `delegation.returned` events and partial results in the UI/canvas, and deliver a child's partial result back into the parent's context (backend propagation and persistence are done).
- [ ] Show pending, running, returning, failed, and blocked communication on the canvas, with actual direction and correlated messages.

## 7 Checkpoints and reliable workflow recovery — P1

Implemented and fixture-tested (see `docs/durable-execution.md`): immutable checkpoints, effect ledger, interrupted/blocked recovery, retry policy, persisted approvals, recovery API and panel. Remaining:

- [ ] Add human-input steps (free-form questions to the user, not only provider permission requests) with the same persisted pending request, answer history and resume-at-same-point behavior as approvals.
- [ ] Carry shared workflow state and artifacts through recovery once they exist (section 10); dependencies, provider session ids, leases and approvals already recover consistently.
- [ ] Verify resume with a live provider: the recorded provider session id is passed to Codex/Claude/ACP on resume, but only fixture adapters were exercised. Record ACP `session/load` support before relying on it.
- [ ] Route AgentTeam-controlled teammate/tool invocations through the effect ledger when they exist (today the ledger covers provider runs, chat runs and ACP mutating tool calls).
- [ ] Add a retry-policy editor (max attempts, backoff, automatic retry) to the Recovery panel; it is API-only (`PUT /tasks/:id/retry-policy`).
- [ ] Decide the execution engine (XState or LangGraph) using the prototype task in section 3; the checkpoint/ledger entities are engine-agnostic.

## 8 Stopping conditions and usage limits — P1

- [ ] Add a UI editor for per-task completion checks (backend, API `PUT /tasks/:id/completion-checks` and scheduler enforcement are done; only workflow limits have UI).
- [ ] Verify token-usage parsing against live Codex/Claude/ACP output (fixture-tested only; Wolfram and ACP report no usage today, shown as unavailable).
- [ ] Detect subscription-quota vs API-key access per provider; today cost is always shown as unavailable and tokens are never converted to dollars.

## 9 Team playground and run inspector — P1

- [ ] Run a team against a sample task in an isolated test workspace with controlled inputs.
- [ ] Preview routing and access decisions before starting a live run.
- [ ] Inspect a correlated timeline of messages, tool calls, model/effort settings, task transitions, locks, approvals, and results.
- [ ] Click any canvas transfer to see its request, response, duration, and originating rule.
- [ ] Explain “why is this agent waiting?” with dependency, capacity, resource, priority, and ownership details.
- [ ] Filter by agent, workflow, task, severity, and event type; link events to files and conversations.
- [ ] Compare test runs after changing prompts, skills, models, or routing rules.
- [ ] Save example tasks and expected outcomes for repeatable team evaluations.
- [ ] Export a redacted diagnostic bundle without credentials or unrestricted private file contents.

## 10 Shared workflow state and artifacts — P1

- [ ] Add typed shared state for decisions, requirements, outputs, and task handoffs.
- [ ] Define which agents may read/write each shared-state field or artifact.
- [ ] Validate structured outputs and show schema failures as actionable task errors.
- [ ] Version state changes and attribute them to an agent, task, and run.
- [ ] Support conflict handling for concurrent state updates instead of silently overwriting them.
- [ ] Provide an artifact list for generated files, reports, diffs, logs, and Wolfram results, with preview and provenance.
- [ ] Pass selected dependency outputs to downstream steps with size limits and clear context summaries.
- [ ] Persist state with checkpoints and support intentional fresh-memory runs.

## 11 Conditional workflows and deterministic steps — P1

**P0 exception — required validation gates, before autonomous sample execution:**

- [ ] Distinguish advisory routing from mandatory validation in the rule editor and scheduler. Required reviews/checks block dependent steps; prompt instructions alone cannot satisfy them, and explicit recipient overrides cannot bypass them.
- [ ] Bind gate evidence to exact inputs/revisions and require the configured check/review outcome; missing, failed, inconclusive, cancelled, or stale evidence keeps the gate closed. Surface blockers and retain decisions across restart. Use this mechanism for the Wolfram sample's actual kernel-validation requirement.
- [ ] Test gate bypass attempts and stale evidence with controlled fixtures, then verify provider/kernel execution separately. Preserve mock-based orchestration tests; do not adopt a blanket ban on mocks or treat fixture success as live-provider validation.

- [ ] Add workflow nodes for conditions, tool/command calls, human input, parallel fan-out, join, and bounded loops.
- [ ] Keep the agent communication graph distinct from an executable workflow graph while letting users navigate between them.
- [ ] Support rules such as “tests fail → Builder; tests pass → Reviewer.”
- [ ] Define typed inputs/outputs and reference previous step results or shared state.
- [ ] Run deterministic checks without paying for another model call.
- [ ] Configure branch/join behavior for failed, cancelled, skipped, and partially completed tasks.
- [ ] Validate invalid cycles, unreachable steps, missing inputs, and loops without limits before execution.
- [ ] Show the actual executed path and allow retry from the failed step.

## 12 Skills, tools, and reference knowledge — P1

- [ ] Verify the bundled skill catalog against supported environments and required tools; keep upstream licenses and revisions visible.
- [ ] Expand useful coverage of popular languages, frameworks, databases, testing, security review, and Wolfram work where gaps remain.
- [ ] Keep curated defaults and locally installed harness skills in separate sections, grouped/filterable by environment.
- [ ] Show Always load versus On demand accurately for each adapter; implement on-demand loading where it is currently unsupported.
- [ ] Keep permanent role instructions short and focused on responsibilities/output contracts; load deep reference skills only when relevant. Record which skill versions loaded and why, expose their context cost, and disclose adapters that cannot support on-demand loading.
- [ ] Provide effective-instructions preview showing role, persistent instructions, loaded skills, and tool requirements.
- [ ] Detect skill changes, missing files, duplicates, and incompatible versions; let the user control updates.
- [ ] Add an MCP/tool registry with per-agent grants, connection state, authentication configuration, and test connection.
- [ ] Distinguish skills (instructions), tools (actions), and knowledge sources (reference material) in the UI.
- [ ] Add per-agent/project knowledge sources with indexing status, source citations, refresh/removal, and access controls.
- [ ] Ensure importing a skill does not automatically grant its requested tool or filesystem permissions.

## 13 Resource access and cooperative work — P1

- [ ] Extend folder-only access to explicit files, exclusions, and inherited read/write rules.
- [ ] Make effective access obvious on cards, agent details, Workspace, and task launch review.
- [ ] Show resources shared by multiple agents and the exact overlapping paths causing a conflict.
- [ ] Finish named scheduling priorities and Preempt behavior consistently across tasks and chat runs.
- [ ] Display queue position, aging, current owner, wait reason, and pending higher-priority requests.
- [ ] Test starvation prevention under sustained normal-priority load and explain Preempt exceptions.
- [ ] Reserve resources at the granularity needed for a task instead of always locking every attached folder.
- [ ] Extend guided parallel work from a prerequisite plan to actual assignment of disjoint files/worktrees and a final integration step.
- [ ] Detect conflicting writes in approved parallel workflows and route them to the coordinator.
- [ ] Coordinate Git operations that share repository metadata across separate worktrees.
- [ ] Reconcile locks after crashes and ownership transfers without permitting two writers during process shutdown.
- [ ] Keep external editors/native agents clearly identified as outside AgentTeam's cooperative lock enforcement.

## 14 Git and file workspace polish — P1

- [ ] Add branch/base selection, fetch, pull, push, and commit-history browsing with explicit action feedback.
- [ ] Add PR creation/opening and links between work items, branches, reviews, and PR status.
- [ ] Provide merge/rebase conflict visibility and a deliberate resolution workflow.
- [ ] Improve staging/unstaging for deleted files, nested deleted directories, renames, and new repositories.
- [ ] Preview more useful artifact types while keeping bounded loading and clear binary/large-file behavior.
- [ ] Support configurable editor executable paths, preserving Sublime Text as the default.
- [ ] Verify Open file, Open project in Sublime, Reveal in file manager, and Open with across macOS, Windows, and Linux.
- [ ] Maintain accurate folder listings and Git status after external edits without excessive polling.

## 15 Layout and interaction quality — P1

- [ ] Preserve hide/show, pane choice, widths, selections, and canvas position reliably across restarts.
- [ ] Keep canvas in the middle and conversation on the right for new layouts.
- [ ] Add saved workspace layouts for planning, coding, review, and monitoring.
- [ ] Support team grouping, selection, collapse/expand, hierarchy navigation, and inserting saved teams on the canvas.
- [ ] Keep compact cards readable when zoomed out: identity/role, environment/model, status, priority, and capacity.
- [ ] Make detailed cards expose configuration without turning every card into a full form.
- [ ] Improve busy/flow animations for concurrent runs, failure states, reduced motion, and large graphs.
- [ ] Add keyboard shortcuts, accessible labels/focus handling, and usable screen-reader navigation for core forms and lists.
- [ ] Verify Enter-to-send, Shift+Enter-newline, IME composition, duplicate-send protection, and draft recovery throughout chat surfaces.
- [ ] Add an attention inbox for agents awaiting approval, failed tasks, blocked workflows, and ready reviews.

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
