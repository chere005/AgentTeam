# Durable execution: checkpoints, effect ledger and recovery

Status: implemented in `src/checkpoints.ts` (fixture and crash-simulation tested; not live-provider tested). The workflow engine decision (XState vs LangGraph) stays open; nothing here installs either.

## Why engine-agnostic

Both candidates are state-transition engines. XState models lifecycle transitions; LangGraph models graph execution with its own checkpointer. What neither gives us is the product-specific part that makes recovery safe: which external effects might have happened, which lease/session/approval belongs to which attempt, and the user's decision when the outcome is unknown. Those facts must live in our SQLite store whichever engine drives transitions, so they are plain entities with no engine types:

- `checkpoint` (append-only; SQLite triggers forbid update and delete, like `validation`). One row per boundary: task started/completed/failed/cancelled/interrupted/blocked/requeued, provider session id, terminal tool call, approval requested/resolved, saved provider output. It stores attempt number, dependency status+result hashes, lease paths, the result text of every terminal attempt (so retries never erase prior evidence) and a human-readable `nextStep`.
- `effect` (ledger). Idempotency-keyed external effects with states `attempted`, `completed`, `uncertain`, `failed` (known not applied). `begin(key)` on a completed key replays the recorded result instead of running; on an in-flight or uncertain key it refuses; only a failed key (or one the user decided to retry) may run again.
- `task-recovery` (mutable cursor): attempt number, provider session id, retry policy, backoff deadline.
- `approval` (persisted request, answer, replay memo).

An XState machine could use `checkpoint.boundary` as its state value and `beforeTransition`/`onTransition` as guards/actions; a LangGraph checkpointer could store its own state blob as `checkpoint.data` and keep using the ledger for effects. Replacing the engine would not change the persisted facts or the API.

## Recovery rules (startup, `RecoveryService.recover`)

- Completed tasks stay completed; nothing re-runs them.
- `attempted` effects lose their process: mutating ones become `uncertain`, non-mutating ones `failed` (safe to retry).
- Leases of the dead process are released (owners are re-derived from state, never double-held); validation slots are released by `ValidationService`.
- A `running` task becomes `interrupted` (resumable, nothing runs by itself) or, if it owns an uncertain effect, `blocked` until the user decides: retry (not applied), mark applied (a provider-run needs the result text and is then replayed without a provider call), or abandon (cancels the task).
- A provider run is mutating when the agent has a write folder or uses ACP. A failure after the run could have started leaves the effect uncertain, except authentication, quota and model-unavailable errors, which prove the provider refused first. Mutating ACP tool calls (`edit`, `delete`, `move`, `execute`) get their own ledger entries.
- Run requests that never started (queued feedback) survive a restart and run once. A chat message that was mid-run still fails, with a ledger entry for mutating runs.
- Pending approvals persist; after a restart they are marked orphaned but stay answerable. The answer is recorded and applied once to the identical request (fingerprint of agent, task, tool title/kind/input, options) raised by the resumed run. A task cannot resume while one of its approvals is unanswered. Chat requests (no task id) never inherit an earlier answer. When a task completes or is cancelled, its still-pending restored approvals are closed (`approval.expired`) since nothing will resume them.

## Retry and resume

`POST /tasks/:id/resume` (interrupted/blocked) and `/retry-from-checkpoint` (failed) requeue through the normal `transitionTask` gates: dependencies, validation gate, workflow pause and limits, resource leases and the invocation cap all apply. Resuming does not spend retry budget; a retry of a failed task starts the next attempt and is bounded by the per-task policy (`PUT /tasks/:id/retry-policy`: `maxAttempts` default 5, exponential backoff `backoffMs`/`backoffFactor` capped by `maxBackoffMs`, opt-in `auto`). Explicit user retries ignore the backoff wait but not `maxAttempts` or an undecided uncertain effect. Resuming a workflow after a limit trip (`/workflows/:id/limits/resume`) requeues only limit-stopped failed tasks whose retry gate allows it; a task whose aborted mutating run left an uncertain effect stays failed for a decision in the Recovery panel. The next run receives a recovery note listing already applied effects and, when recorded, resumes the provider session id (falling back to a fresh session if the connection no longer matches).

Known limits: effects are only recorded where AgentTeam observes them (provider runs, chat runs, ACP tool updates); shared workflow state and artifacts do not exist yet; live provider session resume is unverified.
