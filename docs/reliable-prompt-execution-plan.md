# Reliable execution from a fresh AgentTeam install

Date: October 26, 2026. Investigation baseline: `c2ffd37`, installed AgentTeam 0.5.0 with the local reply-layout update.

Status: repair plan. No execution fixes have been implemented or verified by this investigation. The current user profile was inspected read-only; no tasks were retried, provider calls started, files generated on behalf of workers, or user data reset.

## Goal

A user can insert a team and give it an ordinary implementation request through chat. AgentTeam resolves the project folder once, verifies that the selected workers can actually perform the assignment, creates and runs the programs, routes real artifacts to the designated reviewers, and performs bounded corrections until approval or a concrete blocker.

The implementation agent owns the changes, verification, installation and evidence collection in this plan. Sean should not have to configure fifteen agents individually, run the generated commands himself, or keep asking whether work actually started.

## What happened

The fresh installed profile and screenshot show this sequence:

1. The inserted pipeline team has 14 team agents plus the global Team Assistant. All 15 agents have **zero attached workspaces**. Implementation agents have saved read/write/shell tool settings, but no folder in which those tools can be enabled.
2. Chat created an ordinary conversation project and launched the planner, integrator and an implementation worker. The persisted project has no project-workspace setup. At inspection, its five tasks were two blocked parents, one failed implementation task and two queued reviews.
3. Delegation initially rejected the missing folder and file checks. The planner and integrator then submitted work without file checks. Their saved replies explicitly describe this workaround.
4. The implementation worker reported that it had only teammate tools, no reachable teammate, and no file or shell access. It returned unexecuted Python source. The app correctly retained a failed task and blocked its parents; no successful program execution or review is established by this run.
5. The planner assigned reviews to the reachable Adjudicator and Stage Reporter. The template's actual reviewer agents were not the recipients of these review tasks.
6. Recovery offered to finalize saved provider output without another provider call, although the saved output says execution was impossible. A completed provider invocation is being presented beside an unfinished deliverable without explaining the distinction.
7. The integrator's persisted acceptance regex also specifies the wrong length: 20 fractional prefix digits + 458 middle digits + 10 suffix digits = **488 fractional digits**, while its prose asks for 500 decimal places. Matching model-generated prose cannot establish numerical correctness.

The installed archive SHA256 is `ccfbf5aa16c0f3a5f88da382c4bf177a5c85909130f68220ffd682fb7042c510`, matching the app installed in the preceding task. These findings come from the current installed profile and source, rather than an assumption about an older executable. Exact launch arguments and the provider's effective tool inventory are not durably recorded today; recording them is part of the repair.

## Why the application allowed it

| Boundary | Current behavior and source | Required change |
| --- | --- | --- |
| Team insertion | Implementation agents intentionally start with empty folders in `src/pipeline.ts`, around lines 447–452. Pipeline project creation supplies workspace setup around lines 690–705. | Make missing project setup visible before implementation starts. |
| Chat delegation | `src/runtime.ts:844` creates a conversation workflow/task directly. It does not pass through project preparation in `src/readiness.ts:606`. | Prepare executable chat assignments through the same project contract and startup gate. |
| Effective tools | `src/runtime.ts:31` returns no filesystem capabilities when `cwd` is missing; `claudeFileTools` at line 75 returns an empty list. Scheduled tasks still receive teammate MCP tools at `src/scheduler.ts:242`. | Reject a coding launch whose actual capabilities cannot satisfy its required work. |
| Delegation checks | `src/orchestration.ts:643` returns early when artifact checks are omitted. `TeamService.task` accepts tasks without declared resource paths. | Persist required capabilities and evidence independently of the next model tool call. |
| Existing readiness | `checkSimpleTaskPlans` in `src/readiness.ts:529` performs stronger checks for explicit artifact outputs, but only on the existing simple-task preparation path. | Extract and reuse effective readiness across every execution entry point. |
| Review completion | The pipeline checks verdict fields and has one fixed correction stage. `test/pipeline.test.ts:493` allows a final `request-changes` verdict followed by a report. | Add an explicit bounded approval loop and distinguish reporting a failure from completing the requested goal. |
| Recovery | `src/checkpoints.ts:949` selects saved-output finalization from a completed provider effect. Failed-task requeue changes the attempt and run key elsewhere in the same module. | Derive the advertised next step and the action executed from one typed recovery decision. |

## Implementation order

### 1. Establish an application-owned execution contract — P0

Persist a validated assignment contract on the project and participating tasks. It must describe:

- Work kind: response-only discussion, file creation/editing, or executable implementation.
- Authorized project folder, narrower task scopes, language/toolchain assignments and required effective tools.
- Expected files, trusted execution checks, designated reviewers and required approval conditions.
- Maximum correction rounds and existing time, token, concurrency and retry limits.

The planning model can propose this contract. The application validates and retains the approved requirements. Child requests may narrow permissions or split work, but cannot silently remove required artifacts, execution evidence or review gates. Explicit analysis subtasks can remain response-only without weakening their executable parent's obligations.

Keep response-only chat usable without a workspace. Existing saved projects with unknown requirements need explicit setup/revalidation before executable work resumes; migration must not infer broad access or mark old prose as evidence.

**Exit condition:** omitting `resourcePaths` or `completionChecks` after a rejected implementation delegation cannot turn it into accepted execution without the original requirements.

### 2. Resolve one project folder and enforce one readiness gate — P0

Use existing project/workspace services to select or explicitly create a visible project folder. Present one setup card with the proposed folder, participants and scoped permissions. Apply approved grants to the project roles automatically: writers receive their assigned scope; reviewers receive read access to the required artifacts. Preserve existing attachments and global denials.

Extract a shared readiness evaluator from the existing launch-plan checks. Evaluate the actual `LaunchPlan` and provider tool configuration, including folder grants, command capability, adapter support, authentication and sandbox availability. Saved role names or saved tool checkboxes are insufficient.

Use this evaluator for chat assignment preparation, Assign to team, pipeline preparation, task API/delegation, resume and the scheduler immediately before launch. Recheck after folder detachment, permission changes, symlink resolution, runtime changes or participant additions. Validate queued work against the current contract so a stale preview cannot authorize a different launch.

Return a structured setup blocker with the affected worker and one relevant action, such as **Choose project folder**. Missing setup must not consume a provider attempt, start an execution effect, or create repeated worker tasks. Preserve valid saved setup state so repeated Start clicks resume the same assignment.

For provider diagnostics, record a redacted effective launch manifest: adapter/version, task root, allowed roots, tool names, sandbox mode and readiness result. Exclude tokens, environment secrets and unrelated filesystem contents. Leaf workers should not advertise unusable delegation routes.

**Exit condition:** a fresh folderless coding request stops at setup before any implementation provider call. Choosing a valid folder makes the unchanged saved assignment ready. Unsupported confinement remains blocked.

### 3. Route work through the configured roles — P0

Resolve the team profile's actual implementation, integration, review, adjudication and reporting roles. Validate both communication permission and suitability for each assignment. A reachable recipient is not automatically an implementation worker or a reviewer.

For a requested development/review loop, create the prepared project and its task graph through backend services. Give each intended language an explicit capable worker and an available toolchain. The current generic pipeline workers do not establish distinct language expertise merely through their names; show the selected languages in the prepared assignment.

Actual reviewers inspect the produced artifacts. Adjudication resolves findings according to the configured policy; the reporter summarizes the resulting state. Ordinary implementation work should reach a capable worker directly, with additional coordination stages only when the prepared workflow requires them.

**Exit condition:** the exact prompt cannot silently route review responsibilities to the reporter or replace the configured reviewers with whichever agents are reachable first.

### 4. Require files and trusted execution evidence — P0

Extend completion checks beyond output-field/regex checks in `src/limits-schema.ts`. Reuse the existing command, effect-ledger, access and resource infrastructure for a verification task or narrowly scoped execution check. Record backend-observed executable/argv, working directory, exit status, stdout/stderr, timestamps and source hashes. A pasted command, claimed exit code or copied digits is agent data until corroborated by this execution record.

For the Pi acceptance case:

- Normalize precision visibly before execution. The default acceptance scenario should explicitly request 500 significant digits, with the leading 3 counting as digit one. Also cover an explicit request for 500 digits after the decimal point.
- Require standard-library-only source in every selected language and actual execution of that source.
- Compare the entire output and its length against an independently established reference appropriate to the chosen precision and truncation/rounding rule. Agreement among generated implementations alone is insufficient.
- Verify source hashes before and after the command; edits invalidate previous run evidence. Compiler outputs and multi-file inputs must be associated with the exact tested source set.
- Record the external-dependency inspection and return the actual files, output and evidence locations in the final result.

Provider exit success, task success, verification success and reviewer approval remain separate recorded facts. Retain the existing honest-refusal detection and blocked-parent propagation.

**Exit condition:** an unexecuted source reply, stale output, incorrect digit count or plausible-looking wrong digit cannot satisfy implementation completion.

### 5. Implement bounded review and correction rounds — P0

Reuse or unify the existing strict reviewer/verdict machinery in `src/orchestration.ts` rather than introduce another free-text approval path. Bind each review to reviewer identity, the precise artifact/source hashes, verification-run identity and current round.

An `approve` verdict counts only for that current input. `request-changes` creates targeted correction work, reruns execution checks and schedules fresh reviews. `inconclusive` retains a concrete blocker. A source edit invalidates previous approvals. Both designated required reviewers must approve the same current result before the goal can be reported complete.

Persist round state and enforce the approved round/time/token limits across restart. Exhaustion, cancellation and unresolved disagreement produce **Needs attention** with the reason. Reports may describe these outcomes, but a finished report must not turn them into an approved project.

**Exit condition:** a deliberate implementation defect triggers correction and fresh approval; exhausted rounds and final change requests never produce a success claim.

### 6. Make recovery actionable and truthful — P0

Introduce typed recovery actions shared by preview and execution: repair setup, retry execution, resume an interrupted run, validate/finalize saved output, or resolve an uncertain effect. Include the affected attempt and whether a provider call will occur.

Only offer completion-only replay when the saved output and required evidence can actually be finalized without another provider invocation. A refusal or missing execution evidence must lead to setup repair or an explicit new attempt. Attaching a folder must not make an old folderless provider session inherit broader access implicitly; revalidate and use a fresh session where scope changes require it.

Preserve immutable checkpoints and uncertain-effect decisions. Never replay a possibly applied write automatically. Disable retries that cannot resolve the current setup blocker.

In the UI, lead with the failing leaf, the affected parents and one useful repair action. Collapse checkpoint numbers, provider session identifiers, historical attempts and repeated ancestor error text. Explain completed provider invocations separately from completed deliverables. Setup failures should appear as setup, rather than force users through the crash-recovery vocabulary.

**Exit condition:** the advertised next step matches the actual action, including provider calls and attempt increments, and resolving one root setup issue updates every affected parent.

## Verification and release gates

These are implementation-agent acceptance criteria; verification must be performed and recorded by the agent doing the repair.

| Scenario | Required evidence |
| --- | --- |
| Empty installed profile and inserted team | Coding request presents one setup action; zero implementation provider calls or consumed attempts before readiness. |
| Same request via chat, form, API and nested delegation | The same contract and readiness decision apply to every route. |
| Retry with omitted paths/checks | Required files and execution checks remain enforced; no downgraded child is dispatched. |
| Valid folder and compatible runtime | Workers receive the intended effective tools and scoped roots; actual files and execution records exist. |
| Detached folder, revoked grant, unsupported adapter or symlink escape | Launch is blocked with the actual cause; permissions and sandbox restrictions remain enforced. |
| Incorrect output, stale source or fabricated execution prose | Verification fails and dependent success/approval gates remain closed. |
| Reviewer disagreement, source edits and round exhaustion | Correct fix/review transitions, invalidated old approvals and truthful terminal state. |
| Saved refusal versus crash after valid saved output | Recovery previews and actions agree about replay, new provider calls and attempts. |
| Restart and repeated Start/Resume | No duplicate children, unintended effects, lost review rounds or accidental replay of uncertain writes. |

First add focused backend and hidden desktop fixture coverage for these cases, including the exact no-folder/dropped-check sequence. Run typecheck, relevant regressions and repository preflight. Preserve the ordinary no-folder discussion path and existing file-only task restrictions.

Then verify the packaged **installed application**, using a fresh isolated profile and the actual installed providers. Submit the original request through ordinary chat, resolve its one project-folder step, and collect the created programs, observed outputs and review/correction history. Include a controlled incorrect-output case and restart boundaries. Fixture success and development Electron startup do not establish this installed-app result. Record provider versions, platform, installation source and the precise scopes actually exercised.

Only after those results pass should the implementation be merged, packaged and installed for Sean to retry. Run the required installer preflight separately if the helper still omits it. If publishing a new release, use the required minor version bump and verify the actual release assets. Preserve and describe any platform limitation that has not been verified.

## Delivery boundaries

The immediate deliverable is the shared executable-assignment contract, setup barrier and effective launch gate. Execution evidence, role-correct review loops and recovery must then pass together before claiming the requested workflow works.

Keep the existing TypeScript/Electron/SQLite architecture and reuse its orchestration, policies, limits and effect ledger. No workflow-engine replacement is needed to repair the demonstrated path. Do not weaken confinement, grant home-directory access, copy a solution into the user's workspace as a substitute for AgentTeam execution, or erase failed-run evidence to make acceptance appear clean.

The release claim should be narrow and evidenced: a fresh installed profile completed the ordinary implementation-and-review request through the application, with actual files, successful execution, independently checked results and current required approvals.
