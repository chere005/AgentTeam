# Claude vs Codex: Codex review of the AgentTeam repair plans

Reviewed October 26, 2026 against source at `272138e` (implementation unchanged from `c2ffd37`).

## Sources and scope

| Plan | Reviewed file | SHA256 |
| --- | --- | --- |
| Claude | `/Users/s/CLAUDIO/AGENTTEAM-PI500-RECOVERY-PLAN.md` | `5bd818e3b8bee8a0b3a0a821b483dd7515982f773277f45941b20c2ca5001ff0` |
| Codex | [Reliable execution from a fresh install](docs/reliable-prompt-execution-plan.md) | `43c989bef467fc14e33910cd1030b4fd1745774e59ba0d5ee27dc691abeed7d6` |

Both diagnose the same installed-profile incident. I checked their claims against the implementation and existing test source, and independently recalculated Claude's numerical reference. No repository tests, provider calls, application changes, task cancellation or profile resets were performed for this review. Existing test assertions cited below were read, not rerun.

## Recommendation

Adopt a combined plan. Claude provides the clearer incident explanation and smaller initial stabilization steps. Codex provides the stronger completion contract for the original request: prepared workspaces, required effective capabilities, trusted execution evidence, designated reviewers and bounded corrections.

Claude's proposed empty-tool guard is too weak to be the execution policy, and its cancellation diagnosis is factually wrong. Codex's proposed verifier needs an explicit confinement design and immutable inputs before implementation. Neither plan is ready to be treated as proof that the basic installed-app workflow works.

Use the three delivery milestones below. The first can safely prevent the demonstrated failure; fulfilling the original implementation-and-review request requires all three.

## Findings requiring changes

### 1. [P1] Claude F1/F2 checks for any tools, rather than the tools this assignment requires

**Claude:** §5 F1–F2, especially the condition allowing a task with a file tool, shell **or reachable teammate**.

A worker with Read/Glob but no Write/Bash passes a nonempty-tool test while still being unable to create and execute its program. A reachable coordinator can delegate into an entirely incapable subtree. Conversely, F2's alternative of rejecting “simply any request” without tools would block legitimate summaries and reviews of inline material.

The suggested reuse of `src/task-results.ts:46` is also unsuitable as the launch authority. That function is an honest-failure detector built around execution keywords and a coordination-title exemption; it is not a validated assignment classifier.

**Keep from Claude:** the effective-tool helper, persisted setup blocker and existing readiness/requeue integration. F1 should prove no provider effect or consumed attempt for the blocked task. F2 should prove refusal creates no new task, invocation or counter changes.

**Use from Codex:** §1–2's required-capability contract and shared readiness evaluator. Compare the assignment's required capabilities with the actual scoped launch plan, preserve inherited requirements when a model omits checks, and keep response-only work available. This directly closes the current early return at `src/orchestration.ts:643`.

### 2. [P1] Claude RC4/F8 incorrectly says cancellation does not cascade

**Claude:** §3 RC4, §4.1 and §5 F8 claim cancelling the chat root leaves four orphaned tasks and propose adding `cancelTree`.

Cascade cancellation already exists. `src/service.ts:1038` calls `limits.onTransition`. At `src/limits.ts:712`, cancellation recursively transitions queued/interrupted/blocked children and requests termination of running children. The existing descendant/partial-result coverage is in `test/limits.test.ts:539`.

In this recorded chain, cancelling the blocked root propagates to the blocked integrator and the queued reviews. The failed worker remains a historical failed task. Keeping a failed/completed record is different from leaving executable work queued.

**Correction:** remove the proposed duplicate cancellation mechanism and the “four orphans” claim. Check the actual cancellation UI and any uncovered edge cases using the existing implementation. A separate Cancel/dismiss affordance for historical failed tasks may be useful, but it needs its own product semantics. Neither plan should erase failed evidence to tidy Recovery.

### 3. [P1] Claude F5 fixes the observed wording but leaves the general recovery decision underspecified

**Claude:** §5 F5 proposes putting the failed-task/new-attempt description first and retaining “no provider call” for interrupted/blocked tasks.

The first change addresses this screenshot's failed-task mismatch. Task status alone cannot establish whether a resumed task will call a provider. Delegation continuation increments `state.continuation` at `src/checkpoints.ts:802`; `runKey` at line 576 includes that continuation. A blocked parent can therefore require a new provider turn within the same attempt. Interrupted work can also need a provider resume/restart.

**Use Codex §6's approach:** compute one typed recovery decision consumed by both preview and action. Distinguish setup repair, new attempt, delegation continuation, completion-only replay and uncertain-effect resolution. A no-call claim requires the exact completed ledger key and a valid finalization path, including completion checks. Preserve the existing `willReplayRun` concept at `src/checkpoints.ts:584`, with the decision evaluated for the state the action will actually execute.

### 4. [P1] Claude leaves trusted correctness gates and repeated approval outside its immediate fix

**Claude:** §5 F9 labels model-authored expectations “unverified” and defers verified references to the longer term. Route B explicitly has one fixed correction round. Its proposed verification then switches from the original chat path to Route A/B.

Labeling a wrong enforced regex does not prevent rejection of correct output. Likewise, making one worker execute does not fulfill “pass it back until the reviewers are happy.” Current pipeline tests deliberately allow a final `request-changes` verdict followed by a report (`test/pipeline.test.ts:493`). That report can truthfully describe remaining defects; its completion does not establish approval of the requested result.

**Use Codex §4–5:** independently verified execution results and current artifact-bound approvals are part of the requested workflow's completion criteria. Add bounded correction rounds, invalidate old approvals after edits, and end exhausted/inconclusive work as Needs attention. Keep reports available to explain unsuccessful outcomes.

**Priority correction:** implement these gates before claiming the original request is fixed. The initial setup barrier may ship earlier with a narrower claim.

### 5. [P1] Codex §4 does not define a safe verification process boundary

**Codex:** reuse existing command/effect/resource infrastructure for backend-observed execution.

That supplies useful accounting and evidence, but the existing command runner directly spawns the executable at `src/workflow-graph-command.ts:319`. Its working-directory/path-argument checks at lines 115 and 220 cannot confine filesystem or network access performed by generated Python, C++ or TypeScript code and its descendants.

**Required amendment to my plan:** define the verifier's enforceable OS/provider sandbox, authorized read/write roots, network policy, descendant containment, resource/output limits and unsupported-platform behavior. Preserve global denials. Reuse the ledger and resource coordinator, but require a proven confinement mechanism before adding automatic execution of generated code. Refuse a verification launch on a platform where the required policy cannot be enforced.

### 6. [P1] Codex needs an immutable verification input, not only before/after hashes

**Codex:** §4 records hashes before and after execution; §5 binds approval to source hashes and verification identity.

Equal endpoint hashes do not establish that the bytes remained unchanged during execution. Multiple files, generated binaries, build inputs and concurrent writers complicate that claim further. Existing result-text completion evidence in `src/limits.ts` does not supply an immutable source identity.

**Required amendment to my plan:** verify a defined immutable source snapshot in an isolated build/output scope. Record its input manifest, toolchain/options, reference/input hashes, produced binary hash and durable verification-run identity. Reviewers approve that exact snapshot and its evidence. Changed current source requires a new snapshot, execution and review. Keep the existing lease/concurrency safeguards as part of this design.

### 7. [P1] Codex does not fully specify how the first chat message acquires a binding contract

**Codex:** §1 says the planning model proposes a contract and the application retains approved requirements.

This is the right boundary after the contract exists, but the initial transition is missing. Today's chat root is a generic conversation task whose criterion is to return a direct response (`src/runtime.ts:844`). If the model can initially classify the whole coding request as response-only or omit its contract, merely preventing later downgrades leaves an entry path open.

**Required amendment to my plan:** define an explicit preparation state for actionable assignments, retain original user intent, validate the proposed work kind and requirements, and persist the accepted execution contract before executable children can start. A model's omission or an analysis subtask must not count as fulfillment of the requested implementation. Include initial contract omission/misclassification in acceptance coverage, alongside the existing repeated-call downgrade case.

### 8. [P2] Claude F6 cannot reuse the current `project.start` unchanged for a pipeline

**Claude:** §5 F6 suggests letting the pipeline planner propose the existing Team Assistant `project.start` operation.

Two integration boundaries need explicit changes. Proposal extraction currently accepts only the global Team Assistant (`src/assistant.ts:1161`). Also, `project.start` calls `assignProject` with `mode: "simple"` and `sequential: false` (`src/assistant.ts:318`): independent file tasks, rather than executable multi-stage pipeline work.

**Correction:** specify the prepared-project API/state transition and authorized proposal source. Extend the typed proposal protocol or deliberately route through the Team Assistant, retaining user review where required. A new planner instruction alone cannot turn this operation into a staged execution-and-review loop.

## What to take from each plan

| Area | Claude contribution | Codex contribution | Combined decision |
| --- | --- | --- | --- |
| Incident diagnosis | Exact chain, timeline, usage and retry warning | Confirms contract-downgrade path and distinguishes source inference from recorded launch facts | Keep Claude's incident narrative; correct cancellation and “no project” wording. |
| First safe increment | Concrete helpers, existing runtime-wait hooks and focused assertions | Shared readiness across chat, API, delegation, resume and scheduler | Ship capability-specific readiness and one project setup action first. |
| Model context | F3 explicitly tells the model its effective tools, folders and reachable agents | Redacted launch manifest | Use one task-aware, side-effect-free assembler for model context, diagnostics and preview. |
| User guidance | F4 places setup information at the composer | Setup comes from actual readiness | Keep the prominent notice, but derive it from participating workers' readiness. |
| Routing | Explains why chat used adjudicator/reporter | Requires designated role-correct participants | Route through prepared project roles and validate permissions plus capability. |
| Execution and review | Independent 500-decimal reference and concrete symptoms | Trusted evidence, source identity and bounded fresh approvals | Retain Claude's numeric diagnosis; implement the stronger gates with the verifier amendments above. |
| Recovery | Pinpoints the failed-attempt copy bug | Typed action shared by preview and execution | Use both; retain existing cascade cancellation. |
| Delivery and acceptance | Smaller proposed changes and explicit unknowns | Full original-path packaged-install acceptance | Deliver the milestones below and qualify each success claim. |

### Two useful Claude suggestions need careful predicates

F3 is more actionable than my diagnostic-only manifest: put effective capabilities into the model's instructions as well. The current preview accepts an agent ID and optional prompt (`src/effective-instructions.ts:22`) and reports saved `agent.tools` at line 120. Task execution narrows those grants through `launchPlan(agentId, taskId)`. The shared assembler must accept task context and preserve preview's lack of mutating preparation side effects.

F4's proposed message incorrectly infers that all teammates cannot write simply because the selected planner has no folders. A folderless coordinator can delegate to correctly attached workers. Base the notice on the actual participating workers and contract; name the affected scope/capability and preserve ordinary chat.

F7's alias-warning cleanup is lower priority. Separate advertised aliases, exact IDs successfully used on this installation, and unverified models. Adding IDs to a static list must not fabricate installed-runtime capability or suppress a genuine incompatibility.

## Numerical and operational fact checks

- **Claude's Appendix A is useful and checks out.** I independently recalculated Pi with Decimal Gauss–Legendre arithmetic at 650 and 750 digits of working precision. Both calculations matched all 500 fractional digits in the appendix. Its last ten fractional digits are `8301194912`; the next digit is `9`; the planner's `2164201989` suffix does not occur in those 500 fractional digits. This is a reference calculation for review, not a run of an AgentTeam-generated program.
- **Both numerical findings matter.** My plan identified the persisted regex's length error: 20 + 458 + 10 = 488 fractional digits. Claude also identified the wrong suffix. A changed suffix alone would leave the length error; a changed length alone would leave the wrong expectation.
- **Preserve precision semantics.** Claude's reproduction asks for 500 decimal places. The historical demo uses 300 significant digits, counting the leading 3. My plan proposes an explicit 500-significant-digit acceptance case as well. These are different contracts and must be labeled before execution. Blindly replacing “300” with “500” in existing role instructions also leaves other hard-coded details, including 299 fractional digits.
- **Qualify Quickstart evidence.** `docs/WORKFLOW-VERIFICATION.md:9` records historical live success for 300 significant digits. It does not verify the edited 500-decimal workflow on today's installed executable and CLI versions. Claude acknowledges several of those runtime unknowns later; Route A should carry the same qualification.
- **Route C is an unverified workaround.** Attaching folders should change effective capabilities, but it preserves the wrong review route and bypassed pipeline preparation. Its “it works” wording is stronger than the evidence supplied.
- **Use precise project wording.** The team had no prepared pipeline project/workspace setup. Chat did create a conversation workflow. “No project” without that distinction is misleading.
- **Do not transfer verification to Sean.** Claude's manual cleanup and run commands can guide an implementation agent, but Sean's standing instructions require the agent to perform authorized verification. This review has not executed those operational steps.

## Recommended delivery milestones

### A. Prevent incapable launches and explain the repair

Implement the root preparation transition, persistent required-capability contract, common effective-readiness evaluator, single scoped project-folder setup, task-aware capability context, accurate composer notice and ledger-aware Recovery action. Reuse existing cancellation. Preserve the failed run as evidence and avoid automatic retries until setup is repaired.

**Claim allowed after acceptance:** the app catches the demonstrated missing setup without launching incapable implementation workers or consuming their attempts. This milestone alone does not establish that the requested program/review workflow completes.

### B. Complete and prove one implementation

Use one explicit language, folder and precision contract. Produce real source, execute an immutable snapshot under the defined confinement policy, and compare the full output with an independent reference. Record source/build/run identity and actual outputs. Reject fabricated execution prose, stale artifacts, wrong precision and a deliberately wrong digit. Expand to every language selected by the assignment after the single-language path works.

**Claim allowed after acceptance:** the application produced and verified the requested implementation on the recorded platform/provider versions.

### C. Complete the requested review loop from the installed app

Route to designated reviewers, require current artifact-bound approvals, run bounded corrections, invalidate stale evidence, and preserve state across restart and uncertain effects. Exercise disagreement, inconclusive review, exhaustion and cancellation. Then repeat the original ordinary-chat path through the packaged installed application with a fresh isolated profile, real providers and the single project-setup step.

**Claim allowed after acceptance:** the original implementation-and-review request completed through AgentTeam, with actual files, successful verified execution and current required approvals. Record unsupported or untested platform behavior explicitly.

The implementation agent owns all fixture, hidden desktop, preflight, installer and installed-provider verification. Time estimates should follow this split; Claude's two-to-three-day estimate does not cover the complete contract/evidence/review work defined here. Both original plans remain unchanged by this review.
