# AgentTeam continuation handoff

Updated October 18, 2026. Read with `AGENTS.md` (rules), `CLAUDE.md` (commands and architecture map) and `TODO.md` (remaining work). This file is the current state, not a history; completed history lives in `RELEASE_NOTES.md` and `docs/durable-execution.md`.

## Repository state

- Repository `/Users/scheren/CLAUDIO/AgentTeam`, public remote https://github.com/chere005/AgentTeam, branch `main`.
- Last commit `9b37f45` (shared state, orchestration, run inspector, layouts/inbox, Git workflow). On top of it is a large **uncommitted** change set from four parallel workstreams plus a review pass (see below). Nothing of it is committed or pushed; commit only when the user asks.
- Package version 0.1.0. No release tag or published artifacts are established by this handoff.

## What exists (all fixture-tested; see limitations)

Earlier baseline (committed): three-pane Electron workspace, agents/edges/rules, scheduler with dependencies and priorities/aging, folder leases, direct CLI adapters (Codex read-only, Claude tool-free, Wolfram `LLMSynthesize` bridge) and an ACP v1 adapter, runtime discovery and readiness gate, validation gate with a paused Wolfram sample, workflow limits and completion checks, review viewer with comments, team templates, worktrees, dev-server preview, durable checkpoints/effect ledger/recovery, shared state and artifacts, role presets and mandatory reviews, run inspector/playground/redacted export, layouts and attention inbox, Git workflow panel.

Uncommitted change set (module names in `CLAUDE.md`):

- **Team Assistant and conversations** (`assistant*.ts`, `coordination.ts`, `ownership.ts`, `conversations.ts`, `AssistantPanel`, `ConversationExtras`): proposals as strict data with diff, significance, staleness/expiry, user-only approve/apply bound to the exact operations, dry run plus atomic apply with rollback, audit trail; bounded untrusted inspection context for the assistant; explicit ownership (team/embedded/CLI/native) that refuses double driving; conversation search, summaries, links, unread and live streaming view.
- **Skills, tools, knowledge** (`skill-*.ts`, `effective-instructions.ts`, `tool-registry.ts`, `knowledge.ts`, `run-context.ts`, `capability-routes.ts`, `Capabilities` pane): on-demand skill selection per request (Claude adapter no longer rejects on-demand skills), per-run `run.context` record (versions, reasons, approximate cost; no skill or knowledge text), skill pinning (a changed skill is skipped with a warning until accepted; bundled skills that match the curated hash re-pin automatically, drifted ones are never loaded or accepted), MCP registry with env-var references only and a metadata-only test (initialize + tools/list, never tools/call), knowledge sources with cited passages.
- **Resource access and cooperation** (`access.ts`, `queue.ts`, `sharing.ts`, `declared-paths.ts`, `parallel.ts`, `repo-lock.ts`, `lock-recovery.ts`, `AccessUi`, `Cooperation`): per-attachment rules/exclusions/explicit-only, single queue for tasks and chat runs with wait reasons and a reservation guard against starvation, declared task lock paths, guided parallel assignments with integration task and conflict routing, per-repository Git mutex across worktrees, draining leases after a crash with an explicit force release.
- **Workflow graphs** (`workflow-graph*.ts`, `WorkflowGraphs` pane): task/command/condition/human/fan-out/join/loop steps, static validation, confirmed and confined argv command steps through limits, leases and the effect ledger, immutable executed path, retry from the failed step.

## Review pass on the merged change set (this session)

Defects found and fixed, each with a regression test:

- Assistant rollback restored whole entity kinds from a snapshot, reverting unrelated edits and an agent's `control` made while apply awaited; it now restores only what the completed operations wrote (`test/assistant.test.ts` "rollback restores only what the proposal wrote…").
- `resource.assign` on an already attached folder dropped its access rules/exclusions ("resource.assign on an attached folder keeps its exclusion rules").
- Workspace diff matched rules against attachment-relative instead of repository-relative paths, leaking excluded files of a subfolder attachment; `filterDiff` mis-parsed quoted, spaced and renamed headers. Both fixed, unparseable sections now dropped when restricted (`test/access.test.ts` "diff filtering handles quoted names…", "git diff of a subfolder attachment…").
- Knowledge indexing and queries ignored access rules (`test/capabilities.test.ts` "knowledge obeys attachment exclusions…"); indexing also no longer follows a file or directory swapped for a symlink mid-walk.
- Workflow-graph command steps ignored access rules (cwd, bare relative paths, shell scripts) and an unpinned command could run in a different folder than the one confirmed (`test/workflow-graph.test.ts` "command steps obey the attachment's exclusions; a run keeps the confirmed workspace").
- `workspace.changed` events named excluded files (`test/workspace-extras.test.ts` "workspace.changed never names files…"); artifact previews ignored exclusions added after registration (`test/access.test.ts` artifact test).
- `Scheduler.execute` recorded the provider run in the effect ledger before awaiting `prepareRunContext`; an abort or crash during that await (only when a knowledge source is included) could leave an uncertain mutating effect or start the provider after cancellation. Context preparation now happens before the ledger entry, with an abort check (`test/recovery.test.ts` "an abort while the run context is prepared…"). Timing in production is otherwise unchanged: without included knowledge sources the step is synchronous.
- Flaky `limits` test "completion checks: returned text alone is not success" relied on two 5 ms sleeps; it now waits for the started runs to settle. `launchPlan` no longer reads the skill catalog file for agents without skills (it ran on every scheduler tick per queued candidate).
- The Resources force-release button sent lease ids such as `git:<uuid>` unencoded, which the desktop IPC path filter rejects; now percent-encoded.
- Inspector e2e: the canvas edge click used `force` (no stability wait) while the initial fitView could still move the edge; it now waits for a stable bounding box. The earlier one-off failure could not be reproduced (8 repeated runs passed), so this is the most likely cause, not a confirmed one.
- Docs: README, RELEASE_NOTES, CLAUDE.md, TODO baseline and this file updated; new panes got distinct icons.

Reviewed without change: assistant output cannot self-apply (only `extract` sees it, it stores data; approve/apply/reject require the user actor); ownership can always be returned (a stuck CLI/native holder is released by the user; release is refused only while work runs or a lease drains) and `RunManager.start`'s guard does not affect scheduler tasks (they never call `start`); MCP test spawn is argv-only with an allow-listed env, timeouts and redacted errors; command env is allow-listed (no `AGENTTEAM_*`/token variables); `confirmCommandsHash` covers argv, cwd, workspace, shell, mutating and bounds; draining leases have a documented force release; recycled pids are documented in `lock-recovery.ts`; parallel assignments are checked pairwise for overlap and leased per worker.

## How to verify

```sh
npm run typecheck
npm test                      # backend (node --test), temp databases only
npm run build
npm run test:ui               # Playwright Electron, isolated AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1
npx prettier --check src ui test e2e desktop scripts/*.mjs
node scripts/audit-release.mjs
```

Results of this session are in the section below. They are macOS (Darwin 25, Node 26) results only.

- `npm run typecheck`: passed.
- `npm test`, run twice: 332 tests, 331 passed, 0 failed, 1 skipped (the opt-in Wolfram smoke test) both times.
- `npm run build`: passed (Vite chunk-size warning only).
- `npm run test:ui`, full suite run twice: 26 of 26 passed both times; the inspector spec also passed 8 repeated runs.
- `npx prettier --check src ui test e2e desktop scripts/*.mjs`: clean (the files of this change set were formatted; whitespace only).
- `node scripts/audit-release.mjs`: passed (27 production dependencies, 28 bundled skills, skill validation 0 errors/0 warnings, 4 team templates).

## Known limitations

- Enforcement is cooperative: rules, leases and confinement govern AgentTeam's own file, Git, knowledge and command paths. Provider CLIs, native subagents, external editors and the programs a command step runs keep the user's OS permissions. Repo-local Git filters/credential helpers still run.
- Codex adapter is read-only, Claude adapter is tool-free; granted MCP servers and the teammate tools are not exposed to providers.
- Assistant proposals are read only from fenced blocks in assistant replies or typed by the user; no provider tool applies them. Direct form edits are not audited with an actor.
- Lock draining tracks only the backend pid and direct-CLI/ACP adapter processes; a recycled pid keeps a lease draining until force-released. Parallel conflict detection is after the fact and Git-based.
- A limit trip does not abort a running graph command; graph steps cannot write shared state.
- Knowledge is a lexical index (no embeddings), bounded (400 files, 2 MB).

## Needs live accounts or other platforms

- Any real provider run (Codex, Claude, ACP adapters, Wolfram `LLMSynthesize`), session resume, usage reporting and the Team Assistant producing proposals.
- Real `wolframscript` kernel smoke test (`AGENTTEAM_WOLFRAM_SMOKE=1`, never run).
- Windows and Linux: command shims, `taskkill` tree stop, worktrees, dev servers, graph command confinement, file watcher, native-app opening (macOS only by design).
- Release publication, signing/notarization.

## Next steps

1. Get the user's go-ahead to commit the change set (never commit unasked); review `git diff` first.
2. P0 sample from `TODO.md`: the paused Opus plan → Sonnet workers → parallel Codex/Fable reviews → adjudication → second worker batch → final reviews → report workflow, with immutable Markdown handoff notes and configurable model mappings/worker caps. Model IDs for "Opus 5.5", "Sonnet 5.5" and "Fable" are unverified; never substitute silently. Workflow graphs, guided parallel assignments and shared state are now available building blocks.
3. Wolfram sample: run the opt-in real-kernel smoke test before claiming end-to-end validation.
4. Wire provider exposure (MCP grants, teammate tools, assistant proposals as a tool) with runtime enforcement; then live-provider smoke tests.
5. Desktop coverage gaps listed in `TODO.md` (guided parallel form, conversation links/streaming in the app, saved-team management).
