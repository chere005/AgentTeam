# AgentTeam continuation handoff

Prepared October 18, 2026. The user requested detailed continuation instructions and a good pause point. **Stop after saving this handoff; resume implementation when asked.**

## Read this first

- Repository: `/Users/scheren/CLAUDIO/AgentTeam`.
- Public repository: https://github.com/chere005/AgentTeam . Current branch at handoff: `main`.
- Implementation baseline: `09ccd10` (`Add hybrid ACP runtime and desktop development workflows`), previously pushed to origin. Working tree was clean before this documentation change.
- No code for the newest sample-workflow request has been implemented. Do not describe the sample, persistent Markdown handoffs, or its worker batches as finished.
- This handoff and `TODO.md` are the starting points. Check actual code and Git status before editing. Some older TODO checkboxes lag the implementation; the baseline paragraph and tests give additional context.
- The user has authorized building the whole application and previously authorized making the repository public and pushing it. Do not force-push. Do not publish internal Wolfram code.
- Do not spawn coding subagents just because the app supports subagents. Current session instructions require explicit delegation authorization or applicable repository instructions.

## Immediate next deliverable: sample workflow

The user requested this sequence:

1. **Claude Opus 5.5** writes the plan.
2. **Sonnet 5.5** implements the features, using **up to five subagents** at this stage.
3. **Codex max** and **Claude Fable** review the implementation **in parallel**.
4. A **different Fable agent** selects/reconciles the best findings from both reviews.
5. It passes the resulting work to **up to five more Sonnet agents**.
6. **Codex max and Claude** perform the final review in parallel, ideally converging.
7. A **Fable reporter** produces the briefest useful report of what happened at every stage.
8. **Preserve Markdown notes passed from iteration to iteration and make their history scrollable.**

The user then asked to pause with this handoff, so implementation of that deliverable is the next work, not work to continue during this pause.

### Interpretations and unresolved details

- Preserve requested display names. Exact provider IDs and availability for “Opus 5.5,” “Sonnet 5.5,” and “Fable” are **not verified**. Existing discovery does not establish these IDs. Do not invent IDs or silently substitute another model.
- “Codex max” likely describes reasoning effort; model and effort must remain separate settings. Validate effort support for the selected runtime/model.
- Reuse Fable for the final Claude reviewer unless the user specifies otherwise, and make this visible/configurable. This is a proposed default, not a confirmed model selection.
- The user supplied no concrete feature specification or target workspace to execute against. Create a reusable, **paused** sample/template with an obvious goal/project setup step. Do not launch paid/live model calls against a made-up task.
- “Up to five” is a cap, not a requirement to invent five tasks. Offer a batch-size/cap control from one to five, default five, and allow fewer partitions when the plan warrants it.
- The second batch should consist of distinct worker agents from the first batch, as requested by “five more.” Reviewers can be reused between review rounds, but the adjudicator must be a separate agent. Keep the final reporter separate for clear ownership.
- Convergence is a desired outcome, not a guarantee. Report unresolved findings and contradictory reviews honestly. Do not add an unbounded review loop.

### Proposed executable graph

Use explicit task dependencies so parallel branches join before the next stage:

```text
Opus plan
  -> Sonnet implementation lead / partition plan
  -> first Sonnet worker batch (1..5 independent assignments)
  -> Sonnet integration + verification
  -> [Codex review 1 || Fable review 1]
  -> separate Fable adjudicator / remediation plan
  -> second Sonnet worker batch (1..5 independent assignments)
  -> integration + verification
  -> [Codex final review || Fable final review]
  -> Fable concise report
```

Integration/partition tasks are proposed implementation details to prevent reviews of unfinished or unmerged work. They should be visible, rather than concealed in prompts. Prefer actual AgentTeam tasks over telling a provider to secretly spawn workers: the scheduler must account for capacity, cancellation, access, and status.

### Instructions to put on the agents/tasks

- Planner: restate goal, constraints, acceptance criteria, architecture, dependencies, risks, and test strategy; identify separable work and file ownership. Output Markdown.
- Implementation lead: partition the approved plan into at most the configured cap; avoid overlapping writes; assign clear outputs and verification; do not expand scope without explaining why.
- Workers: act only on assigned scope; record files changed, tests run with actual outcomes, decisions, and remaining blockers. Do not fabricate successful tests or rely on another worker's unfinished changes.
- Integrator: combine worker outputs, resolve integration issues, run meaningful validation, and produce the exact revision/diff context the reviewers must examine.
- Both reviewers: independently examine the same implementation snapshot against the original plan and acceptance criteria. Produce actionable findings with severity, file/line or other concrete evidence, rationale, suggested correction, and validation gaps. An empty findings list must be explicit.
- Adjudicator: deduplicate findings, resolve disagreement by evidence rather than model prestige, preserve rejected findings with a short reason, and produce bounded remediation assignments. Do not merely concatenate reviews.
- Remediation workers: address accepted findings and preserve intentional behavior; reference finding IDs and report verification.
- Final reviewers: validate fixes, regressions, original acceptance criteria, and unresolved prior findings. Distinguish confirmed fixes, remaining blockers, and optional improvements.
- Reporter: one short line per stage plus final outcome, key tests, and unresolved blockers; link to detailed notes instead of reproducing them. Never claim completion merely because all agents returned text.

### Markdown handoff persistence and UI

Recommended implementation, subject to normal code review:

1. Add an append-only handoff/attempt record with ID, workflow ID, task ID, stage/round, attempt number, author agent ID, creation time, outcome, Markdown body, and input-note references. Include revision/worktree context when available.
2. Write the note atomically with the terminal task transition. Retrying must not overwrite earlier notes. Preserve failed/cancelled attempt diagnostics; do not present these as successful handoffs.
3. Capture partial output on failure where practical; the current scheduler loses it when replacing the result with an error. Bound sizes and disclose truncation.
4. Pass the appropriate completed dependency notes forward, retaining original plan/acceptance criteria. Record which versions were consumed. Avoid injecting the entire growing workflow and duplicated notes into every prompt.
5. Keep `Task.result` for compatibility if useful, but do not use that mutable field as the only historical record.
6. Add a workflow notes view with a scrollable chronological list, stage/agent/round/attempt labels, outcome badges, and selection of individual notes. Preserve raw Markdown; offer readable rendering plus copy/download if practical.
7. Never render arbitrary raw HTML from agent output. If adding a Markdown library, check its license and sanitize/disable raw HTML and unsafe URL handling.
8. Reload/restart must preserve history and ordering. Empty, running, failed, retried, and long-note states need usable UI.

### Resource safety and actual concurrency

- Existing shared-path locks can serialize tasks even when the graph branches. A parallel-looking canvas alone is insufficient.
- Inspect `src/resources.ts` before choosing workspaces. Current leases track paths; do not assume read/read concurrency is already implemented.
- Coding workers should use isolated Git worktrees or explicit, bounded guided coordination with clear ownership and integration. Do not silently disable locks for the sample.
- Reviewers must see the same frozen revision/diff and need actual concurrent access without modifying it. Consider read-only snapshot workspaces or correctly modeled read leases.
- Set the invoking lead/adjudicator's `maxConcurrentInvocations` and every worker task's `invokedBy`; create the required delegation edges. Merely setting `parentId` does not enforce task capacity.
- Provider-native hidden subagents are not currently governed by AgentTeam's scheduler. Do not claim the five-agent cap covers them.
- Create the complete sample atomically and paused, so an enabled scheduler cannot start a half-created graph. Avoid async filesystem work inside the synchronous SQLite transaction.

## Current architecture and code map

| File | Responsibility / continuation relevance |
| --- | --- |
| `src/model.ts` | Strict Zod schemas and types for agents, workflows, tasks. Add compatible optional/defaulted fields if extending stored entities. |
| `src/service.ts` | `TeamService`: agent/edge validation, workflow creation, task dependencies, transitions, capacity, human control, launch plans. |
| `src/scheduler.ts` | Schedules eligible tasks and chats; builds dependency prompts, executes providers, saves results. Natural place to connect handoff capture and input selection. |
| `src/store.ts` | Synchronous SQLite JSON entities and durable events; buffered events publish after transaction commit. Nested transactions reuse the outer transaction. |
| `src/resources.ts` | Resource leases, overlap checks, guided parallel coordination, priority and waiting-time aging. |
| `src/priorities.ts` | Low=0, Medium=50, High=75, Max=100, Preempt=101. Preempt takes queue precedence, not forcible interruption of active writers. |
| `src/http.ts` | Authenticated loopback API, snapshots, workflows/tasks, runtime connections, development tools and approvals. Add template creation/history endpoints here. |
| `ui/api.ts` | Frontend snapshot types and API client. Keep new note/template types synchronized. |
| `ui/components/Panes.tsx` | `Workflows` starts around line 352. Current tasks show `result` in a plain `pre`; no historical handoff viewer. |
| `src/runtime.ts` | Commands, direct/ACP dispatch, conversation run manager, cancellation and resource gating. |
| `src/runtime-types.ts` | Shared adapter command/event/permission types. |
| `src/acp.ts` | Stable ACP v1 SDK transport, sessions, model/effort config, streaming, approvals, child lifecycle. |
| `src/approvals.ts` | Pending permission promises and response validation; pending requests are not durably resumable. |
| `src/discovery.ts` | Existing provider installation/model discovery and manual overrides. |
| `src/development.ts` | Worktree creation, idempotent inline review feedback, dev-server lifecycle. |
| `src/workspaces.ts` | Bounded file access, Git operations, diff/review data. |
| `desktop/` | Electron main/preload integration. New backend APIs require restarting an old desktop process. |
| `test/`, `e2e/desktop.spec.ts` | Backend fixtures and desktop flows; no paid provider calls required. |

### Important current behavior

- `workflow()` creates an unpaused workflow. A sample creator must explicitly ensure it is paused within its creation transaction.
- `task()` validates same-workflow dependencies; `invokedBy` requires a permitted delegation edge. Guided coordination can inject a coordinator plan dependency.
- Task states: queued -> running/cancelled; running -> completed/failed/cancelled; failed -> queued/cancelled. Completed and cancelled tasks cannot currently be retried.
- `taskState()` gates pause, human control, dependencies, invoker capacity, and resource conflicts. The running transition performs further agent/resource checks.
- Scheduler passes dependency `result` strings plus serialized workflow context, truncates successful results to 100,000 characters, and treats nonempty provider output as task completion. This is not proof that acceptance criteria passed.
- Restart recovery currently marks interrupted running tasks failed with an explicit retry message. Persistence is not checkpoint/resume.
- Store `put()` upserts entities. A handoff history should use unique immutable IDs and a service API that prevents accidental replacement.
- Workflow status is derived from task states, with pause taking precedence. No sample/template or versioned Markdown history exists yet.

## Hybrid backend decision already approved

Keep AgentTeam's routing, graph permissions, scheduling, locks, priority/fairness, access policy, and SQLite product state custom. Use ACP for agent transport where supported, retaining direct CLI and Wolfram bridge paths.

- `@agentclientprotocol/sdk` is pinned at **1.9.0**, stable v1, Apache-2.0. License is in `assets/licenses/ACP-SDK-LICENSE.txt`.
- ACP is wired into chat and scheduled tasks, with manual per-provider adapter executable/argument settings, model/effort validation against advertised options, session identity isolation, streaming, and approval UI.
- ACP protocol fixture tests pass; **real Codex/Claude ACP adapters and account compatibility have not been validated**. Do not claim production provider compatibility from mocks.
- ACP client filesystem/terminal services are advertised unavailable. Adapter-native tools may have access outside those declarations; current access inventory is not a complete OS sandbox.
- Teammate invocation tools are still pending. ACP does not itself orchestrate teammates.
- Evaluate **XState versus LangGraph** for durable execution/checkpoints before choosing one. Neither is currently installed. Do not add Redis/Temporal infrastructure for the local release.
- **Wolfram ACP is an internal project the user can access**, intentionally deferred until its repository/docs and distribution rights are available. Keep the existing Wolfram bridge.

## Existing functionality and user preferences to preserve

- Cross-platform macOS/Windows/Linux Electron app; default center pane Canvas, right pane Conversation; panes hideable and configurable.
- Compact/detailed cards, hierarchy/communication graph, directional activity visualization, dropdown conversation recipient including general AgentTeam assistant.
- Role type at top of agent editor; model dropdown with custom option; effort when supported; one max-concurrency dropdown, default unlimited.
- Named scheduling priority and starvation-resistant ordinary queues; shared-resource access inventory must remain clear per agent.
- Enter sends, Shift+Enter inserts newline. Automatic installed harness discovery, with manual path overrides in settings.
- Skills catalog and installed-harness skills are separate; skills carry environment compatibility.
- Saved teams, workspace/file preview, basic Git UI, external editor preferences including Sublime/project opening.
- Code review diff navigation, line feedback with recipient, stale-diff rejection and idempotency.
- Worktree creation/attachment and basic development-server logs, stop controls and sandboxed preview.
- Human Take control / Return semantics, workflow/task visibility, guided parallel resource settings.
- Broader approved backlog remains in `TODO.md`: run inspector, stopping conditions, checkpoints, shared state, conditional/tool nodes, MCP/knowledge, eventual mobile/shared-human sessions and encryption. Do not conflate backlog with shipped behavior.

## Validation baseline and next tests

Before this documentation-only pause, the previous implementation checkpoint recorded:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: **43 backend tests passed**.
- Desktop fixture flows passed for (1) agent configuration/chat, (2) review/feedback/preview/worktree, and (3) ACP settings/permissions/conversation.
- These checks were **not rerun for this handoff**. Live-provider ACP, other-platform behavior and published release artifacts remain unverified.

Use Node **24+** (native TypeScript and `node:sqlite`). Commands from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run test:ui
```

Follow the active environment's permission rules for local listeners/GUI/network. Fixture tests should not need provider credentials. Inspect `playwright.config.ts` before running desktop tests; use temporary databases and workspaces, never the user's live database.

For the new sample, add meaningful tests for:

1. Atomic creation, unique agent/task IDs, paused initial state, correct stage joins and delegation edges; no execution before launch/setup.
2. Both review branches can run concurrently under the chosen access model; adjudication waits for both; final report waits for both final reviews.
3. At most five workers per batch, fewer allowed, dependency/lease/capacity gates respected, and cancellation/failure blocks downstream work appropriately.
4. Notes survive retry and restart, failed attempts remain visible, ordering is stable, and consumers reference the correct successful note versions.
5. Missing/unsupported model IDs and effort are clearly surfaced without substitution or paid calls.
6. Desktop creation/configuration, stage statuses, scrollable long Markdown history, and concise final report with links to detailed notes.

## Delivery and release context

- Version in package metadata is 0.1.0. **No release tag/publication is established by this handoff.** Check remote releases before making claims or publishing.
- Cross-platform release/signing workflow and `SIGNING.md` exist. macOS signing credentials may be on the user's other Mac. A prior credential-inspection approval was declined; do not repeat it without need/authorization.
- Most recent source commit was pushed successfully; CI for that exact commit was not checked at the last checkpoint.
- A previously launched desktop app may still use old main-process code. Inspect before restarting; do not kill arbitrary Electron processes. `npm start` rebuilds and launches; `npm run desktop` only launches existing build output.
- Do not overwrite the user's persistent app database to install the sample. Prefer a normal template/creation API and UI. A library entry alone is not a created runnable sample; communicate exactly what is available.

## Suggested next working order

1. Read this file, `TODO.md`, repository instructions if present, and Git status; verify the relevant code above.
2. Implement durable attempt/handoff records and dependency note selection with tests.
3. Implement the paused sample template and configurable model mappings/worker caps with explicit resource strategy.
4. Add workflow stage/notes UI and a normal creation path. Preserve the user's existing layout preferences.
5. Validate the complete graph with fake runtimes, including parallel reviews and retries, then desktop interaction tests.
6. Update TODO/README only to reflect verified behavior; fix stale baseline descriptions as appropriate.
7. Report what is runnable, what requires model/workspace configuration, what was tested, and any remaining provider limitation. Continue the broader prioritized backlog only after completing this deliverable.

Do not start live providers or automatically publish a release merely to demonstrate the sample. The immediate task is a coherent sample and durable, inspectable handoff history.

## Additional user request during handoff: Wolfram-gated problem solving

This is a second requested sample, added to TODO and **not implemented**. Preserve it alongside the software-development sample. Start a math/physics/problem-solving workflow in Opus 5.5. Whenever it needs mathematics, it must invoke up to two Wolfram agents, save proper executable Wolfram Language validation code and explicit mathematical evidence, and wait until the mathematics actually validates in Wolfram before continuing dependent steps.

Implementation requirements:

- Model this as a scheduler-enforced validation dependency, not only a prompt instruction. Ordinary task completion or a reviewer saying “correct” cannot open the gate.
- A Wolfram agent can formulate checks; the actual Wolfram kernel must execute them. The current LLMSynthesize bridge by itself does not prove that validation code executed. Add an auditable execution/result path using the available runtime. Internal Wolfram ACP integration remains deferred.
- Require one or two validators, never more than two concurrently for this workflow. If two are used, reconcile disagreements with executable evidence; neither can simply outvote the other.
- Persist a validation artifact bundle per attempt: exact claim and input hashes/revisions; assumptions, variable domains and units; derivation; `.wl` code; actual output; kernel version; explicit assertions/TestReport or equivalent; precision/tolerances for numerical tests; outcome and timestamps. Exportable files should accompany durable metadata and Markdown notes.
- Use symbolic validation when suitable (identities under explicit assumptions, equation residuals, boundary/initial conditions). Numeric checks must state their scope and must not be labeled a general proof. A non-True unresolved expression is inconclusive, not a pass. Define expected checks before seeing output to avoid vacuous “True” assertions.
- Fail closed on failed assertions, missing execution, timeout, invalid output, unresolved conditions, disagreement, or stale inputs. Keep dependent steps blocked, display the reason, and allow bounded correction/revalidation. Changed code/assumptions/inputs invalidate earlier evidence.
- Preserve failed attempts and final evidence across restart. Reuse the proposed append-only Markdown handoff/history design; show validation badges and artifact links in the workflow view.
- No concrete problem was supplied. Offer a paused editable example, such as a harmonic oscillator solution checked against its differential equation, initial conditions, and energy conservation under stated assumptions. This is a suggested example, not a user-selected problem or permission to start live execution during the pause.
- Test the hard dependency gate, invalid/stale evidence, cap of two, restart/cancellation and unavailable runtime with fixtures. Add a real-kernel smoke test before claiming the whole validation path works.

The user also requested that completed TODO items be **removed as they are accomplished**, keeping the backlog brief. Completed checkbox entries were removed during this handoff. Retain partial/unverified work; put completion history in release notes or other documentation, rather than growing TODO into a changelog.

## Approved Swift Agents ideas and priorities

The user approved all recommendations from reviewing https://github.com/Techopolis/swift-agents . They are now requirements in TODO, not implemented functionality:

- **P0 before autonomous samples:** scheduler-enforced mandatory validation gates, distinct from advisory routing. Bind evidence to exact inputs/revisions, retain it across restart, and block on stale/missing/failed/inconclusive evidence. Reuse this for Wolfram execution and required specialist reviews.
- **P1 with orchestration:** explainable conditional specialist routing based on task and changed-file evidence; multiple reviewers where appropriate; coordinator/implementer/reviewer/adjudicator presets with suitable tools and explicit output contracts.
- **P1 with skills:** slim permanent role instructions, on-demand reference skills, loaded-version/reason/context-cost visibility, and honest adapter capability reporting.
- **P1 after local templates and gates:** installable specialist team packs containing lead/specialists, skills, rules and required reviews; versioned manifests, pinned dependencies, environment compatibility, model mappings, source/license attribution, atomic insertion and reviewed updates preserving customizations. Include a Swift starter pack. Check companion licenses independently.
- Retain the cross-platform Electron/TypeScript hybrid ACP design. Keep controlled mocks/fixtures for deterministic orchestration tests and separate live-provider validation; do not copy the reference project's blanket no-mocks policy.

These additions refine the existing saved-team, orchestration, conditional-workflow and skills sections rather than introducing a competing backend. Implementation remains paused at the user's request.
