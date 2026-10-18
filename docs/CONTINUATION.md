# AgentTeam continuation handoff

Updated October 18, 2026. Read with `AGENTS.md` (rules), `CLAUDE.md` (commands and architecture map) and `TODO.md` (remaining work). This file is the current state, not a history; completed history lives in `RELEASE_NOTES.md` and `docs/durable-execution.md`.

## Repository state

- Repository `/Users/scheren/CLAUDIO/AgentTeam`, public remote https://github.com/chere005/AgentTeam, branch `main`.
- Last commit `47ccc1e` (pipeline sample, team packs, task/rule/state editors, test-stability fixes). On top of it is the **uncommitted** active-team switcher (below). Nothing of it is committed or pushed; commit only when the user asks.
- Package version 0.1.0. No release tag or published artifacts are established by this handoff.

## Active-team switcher (uncommitted, this session)

User request: only one team or workflow set should be visible at a time. Design (details in `CLAUDE.md`, `src/team-spaces.ts` header):

- One database; agents/workflows get an optional `teamId` (missing = Main team, so old data is read through defaults, no migration write). Team Assistant is global. Active team is a backend setting (survives restarts, lets a sample/template/pack activate its own team).
- Creation: agent form → active team; workflow → given team or owner's; Wolfram sample, pipeline sample, template insert (default new team named after the template; the insert dialog can choose the active team instead), pack install (new team named after the pack; pack updates add agents to the pack's team) → own new team (unique name), activated; the UI shows a notice whenever the active team changes for a reason other than the switcher.
- Policy unchanged and global. Cross-team edges need explicit `crossTeam: true` (canvas context menu "Link to an agent in another team…"), shown in a "CROSS-TEAM" strip on both teams' canvases; moving an agent keeps its edges working (they become cross-team).
- UI: `TeamSwitcher` in the top bar (name, status dot, running/attention chips, "+N elsewhere" for other teams, menu with per-team counts, New/Rename/Delete, keyboard and Mod+Shift+T); every pane gets the filtered view; inbox lists other teams' items separately and "Switch & open" switches first; per-team canvas groups/viewport and layout presets.
- Tests: `test/team-spaces.test.ts` (8), assertions added to `test/team-packs.test.ts` and `test/pipeline.test.ts`; `e2e/teams.spec.ts` (3); updated `e2e/desktop.spec.ts` (insert into active team), `e2e/pipeline.spec.ts` (second pipeline is its own team), `e2e/team-packs.spec.ts` (per-team groups key, pack team active), `e2e/workspace-ux.spec.ts` (switcher first in tab order).
- Open items are in `TODO.md` section 15 (no move-agent UI, some views stay global).
- Also fixed: `e2e/task-editors.spec.ts` "routing rule editing" was racy (deleting the target agent deletes the rule, and the debounced snapshot refresh unmounts the open form; failed 2 of 6 repeats); the delete and the save now happen in one step and the test waits for the error before the refresh (8 of 8 repeats passed).
- Checks after this change (macOS): `npm run typecheck` passed; `npm test` twice: 373 tests, 372 passed, 0 failed, 1 skipped (opt-in Wolfram smoke) each time (in 2 of ~11 earlier runs one unrelated timing test failed once: "Git workflow locks key on the common git dir…" and once an unidentified one); `npm run build` passed; `npm run test:ui` twice: 37 of 37 passed; prettier clean; `node scripts/audit-release.mjs` passed. Screenshots of the open switcher and a filtered canvas were inspected.

## What exists (all fixture-tested; see limitations)

Committed baseline: three-pane Electron workspace, agents/edges/rules, scheduler with dependencies and priorities/aging, folder leases, direct CLI adapters (Codex read-only, Claude tool-free, Wolfram `LLMSynthesize` bridge) and an ACP v1 adapter, runtime discovery and readiness gate, validation gate with a paused Wolfram sample, workflow limits and completion checks, review viewer, team templates, worktrees, dev-server preview, durable checkpoints/effect ledger/recovery, shared state and artifacts, role presets and mandatory reviews, run inspector/playground/redacted export, layouts and attention inbox, Git workflow panel, Team Assistant proposals and ownership, skills/tools/knowledge, access rules and cooperation, workflow graphs.

Uncommitted change set (module names in `CLAUDE.md`):

- **Pipeline sample** (`pipeline.ts`, `pipeline-routes.ts`, `handoffs.ts`, `samples.ts` per-agent expectations, `Pipeline.tsx`): paused Opus plan → 1-5 Sonnet workers (guided disjoint paths or worktrees, integration step) → parallel Codex/Fable reviews → separate Fable adjudication → 1-5 Sonnet fix workers → parallel final reviews → Fable report; "Prepare and verify" resume gate bound to a configuration fingerprint; start gate for structure, assignment and the adjudication; immutable untrusted-labelled handoff notes per attempt with the exact consumed inputs.
- **Team packs** (`team-pack-manifest.ts`, `team-pack-diff.ts`, `team-packs.ts`, `team-pack-audit.ts`, `teams.ts` schema v2 groups, `TeamPacks.tsx`, `assets/team-packs/swift-development`, audit section 4b): manifest validation, grant-acknowledged atomic install, three-way explicit updates, separate pack/skill license checks.
- **Task editors** (`TaskSettings.tsx`, `StateEditor.tsx`, `RuleEditor.tsx`; `PUT /tasks/:id/requires-validation`, `PUT /rules/:id`): validation requirement, completion checks, retry policy, state/context settings, shared-state fields and checkpoint restore, rule editing.

## Review pass on the merged change set (this session)

Defects found and fixed, each with a regression test:

- Pipeline adjudication could be decided by hand: `POST /tasks/:id/status` completed it with any contract-shaped JSON and the handoff note called that an agent run. A hand completion of the adjudication now needs `humanOverride {reason, by?}` (409 `adjudication_override_required` otherwise); notes record `provenance.actor` `user`/`agent` and the override; later stages accept only the adjudicator's own run or an attributed override, and an intact note (`test/pipeline.test.ts` "a hand-completed adjudication opens later stages only with an attributed override…"; `e2e/pipeline.spec.ts` updated).
- Pipeline structure check did not verify which agent runs each stage task (the adjudication could be reassigned to a reviewer before verification), and "read-only" ignored access rules that grant write on a read folder; the fingerprint ignored instructions, skills, task text/criteria/validation and extra folders attached to writers ("verification refuses a reassigned adjudication, write rules on read-only roles, and goes stale on added folders or edited instructions").
- Pipeline workspace/paths: no `.git`/`..` refusal and a worker path symlinked outside the workspace was accepted after `realpath`; creating a pipeline overwrote an existing resource's name and priorities for the same folder; limits were set after the creation transaction ("workspace and worker paths: .git, traversal and symlink escapes are refused; an existing resource is kept as configured").
- Pipeline fix-worker assignment from the scheduler sweep failed with worktree isolation after an app restart (the worktree service was only wired by a `/pipelines` request); `createApi` now wires it ("worktree isolation through stage 5…", which also covers that fix-worker worktree attachment keeps the verification valid).
- Completion-check `output-matches` ran a user pattern on agent output on the backend thread without bounds (catastrophic backtracking could hang the API) and invalid patterns were only found at completion: patterns must compile on save, and `boundedRegexTest` stops a match after 500 ms (also used by the playground) (`test/task-edit-api.test.ts` "output-matches checks: invalid patterns are refused on save, catastrophic backtracking is bounded").
- `PUT /tasks/:id/requires-validation` could switch the requirement off after a failed/inconclusive validation, bypassing the gate; refused now (and while a validation run is active) ("requires-validation cannot be switched off after a validation attempt that did not pass").
- Rule edits: verified that a planned mandatory trigger keeps its mode, so editing the rule to advisory or disabling it never reopens the gate; the mode change is now recorded in the `rule.updated` event (`test/orchestration.test.ts` "editing a mandatory rule to advisory (PUT /rules/:id path) never reopens an existing gate").
- Flaky `e2e/git-workflow.spec.ts` (failed once in run 1: `index.lock: File exists` on the test's own `git switch`): the Git panel's background `git status` after a watched file change took Git's optional index lock, which also breaks a user's concurrent Git commands. `GIT_OPTIONAL_LOCKS=0` is now set for every Git call of the Git workflow and worktree services (`test/git-workflow.test.ts` "reading Git state never rewrites the index…", fails without the fix).
- Flaky `e2e/inspector.spec.ts` (failed in 2 of 3 full runs, on the canvas edge click): a probe showed the edge can lie entirely outside the visible canvas pane (the viewport was fitted before the agents existed), so the coordinate click hit another pane; the earlier stability wait did not address it. The test now dispatches the click on the edge element. Not a fixed-port or leftover-process problem: no spec uses a fixed port and no test-spawned processes were left behind.
- Formatting: `src/http.ts` and `src/team-packs.ts` (whitespace only).

Reviewed without change: handoff notes are trigger-protected (update/delete abort) and fenced with a fence longer than any backtick run; Codex `max` is passed unchanged (an advertised effort list without it blocks verification; Codex `default` advertises none, which is a warning); model ids come only from `DEFAULT_MODELS` (served by `/pipelines/defaults`) or the user's form; worker caps 1-5 are enforced by the schema and re-checked by the structure check; stage-2 assignment is disjoint, lease-checked and fails closed (`assigned` required at start). Team packs: credentials, absolute paths, undeclared tools/skills and pre-approved skills are refused; install requires `acknowledgeGrants`; update never overwrites fields changed locally, needs a resolution per conflict, refuses a stale `diffHash`, running sessions on changed agents and unacknowledged license/revision changes; the audit test only writes to a temp copy (`AGENTTEAM_AUDIT_ASSETS`); v1 templates import and starters/team tests pass; groups are exclusive. Task editors: completion checks, state config and the requirement toggle are refused while running or finished (retry policy deliberately stays editable until the task finishes); all new routes use UUID ids that pass the desktop IPC filter, and the checkpoint id (`uuid:n`) is percent-encoded.

## How to verify

```sh
npm run typecheck
npm test                      # backend (node --test), temp databases only
npm run build
npm run test:ui               # Playwright Electron, isolated AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1
npx prettier --check src ui test e2e desktop scripts/*.mjs
node scripts/audit-release.mjs
```

Results of this session (macOS, Darwin 25, Node 26 only):

- `npm run typecheck`: passed.
- `npm test`, run twice: 365 tests, 364 passed, 0 failed, 1 skipped (the opt-in Wolfram smoke test) both times.
- `npm run build`: passed (Vite chunk-size warning only).
- `npm run test:ui`, full suite (34 tests) three times after the fixes: 34 of 34 passed each time; the inspector spec also passed 5 repeated runs.
- `npx prettier --check src ui test e2e desktop scripts/*.mjs`: clean.
- `node scripts/audit-release.mjs`: passed (27 production dependencies, 28 bundled skills, skill validation 0 errors/0 warnings, 4 team templates, 1 team pack with 5 skill references).

## Known limitations

- Enforcement is cooperative: rules, leases and confinement govern AgentTeam's own file, Git, knowledge and command paths. Provider CLIs, native subagents, external editors and the programs a command step runs keep the user's OS permissions. Repo-local Git filters/credential helpers still run.
- Codex adapter is read-only, Claude adapter is tool-free; granted MCP servers and the teammate tools are not exposed to providers.
- Assistant proposals are read only from fenced blocks in assistant replies or typed by the user; no provider tool applies them. Direct form edits are not audited with an actor.
- Lock draining tracks only the backend pid and direct-CLI/ACP adapter processes; a recycled pid keeps a lease draining until force-released. Parallel conflict detection is after the fact and Git-based.
- A limit trip does not abort a running graph command; graph steps cannot write shared state.
- Team packs: no export/authoring UI, remote sources or signed feed; updates do not diff folders, layout or groups and never delete agents. The Swift pack is a skeleton. Pipeline: the integrator is one extra Sonnet agent beyond the caps; the e2e drives stages by hand (with an override for the adjudication).
- Knowledge is a lexical index (no embeddings), bounded (400 files, 2 MB).

## Needs live accounts or other platforms

- Any real provider run (Codex, Claude, ACP adapters, Wolfram `LLMSynthesize`), session resume, usage reporting and the Team Assistant producing proposals.
- Real `wolframscript` kernel smoke test (`AGENTTEAM_WOLFRAM_SMOKE=1`, never run).
- Windows and Linux: command shims, `taskkill` tree stop, worktrees, dev servers, graph command confinement, file watcher, native-app opening (macOS only by design).
- Release publication, signing/notarization.

## Next steps

1. Get the user's go-ahead to commit the change set (never commit unasked); review `git diff` first.
2. Pipeline sample (`src/pipeline.ts`, `src/handoffs.ts`, `test/pipeline.test.ts`, `e2e/pipeline.spec.ts`): implemented, fixture-tested only, never run against a live provider; the real model ids and Codex's top effort name are unconfirmed. Defaults: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`, Codex model `default` at effort `max`; all configurable, none substituted (an unadvertised model/effort blocks verification). Known limits: the Fable/Sonnet ids on alias-only Claude discovery are surfaced as warnings (passed unchanged), the integrator is one extra Sonnet agent beyond the worker caps, fix-worker worktrees are created after the first integration (scheduler sweep or `POST /pipelines/:id/stage2`), adjudication gating uses completion-check/dependency gates (not orchestration rules), and the pipeline adds no delegation edges to the canvas.
3. Wolfram sample: run the opt-in real-kernel smoke test before claiming end-to-end validation.
4. Wire provider exposure (MCP grants, teammate tools, assistant proposals as a tool) with runtime enforcement; then live-provider smoke tests.
5. Desktop coverage gaps listed in `TODO.md` (guided parallel form, conversation links/streaming in the app, saved-team management).
