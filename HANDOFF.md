# AgentTeam handoff — October 26, 2026

## macOS continuation (October 26, 2026)

Continued this branch in `/Users/s/GIT/AgentTeam-handoff` from `b15cbc8`. The effective-instructions preview omitted shared runtime guidance that `TeamService.launchPlan` appended to every provider launch, so the preview did not match the actual prompt. Moved that guidance to `src/runtime-instructions.ts` and included it in both paths; updated `test/capabilities.test.ts` to assert the guidance. Verification: `npm run typecheck` passed; `npm test` passed **588**, failed **0**, skipped **1** (opt-in Wolfram smoke); `npm run build` passed with the existing large-chunk advisory; release audit, focused capabilities suite (**13/13**), Prettier and `git diff --check` passed. No desktop UI suite or live provider run was performed.

Preflight [40293308193](https://github.com/chere005/AgentTeam/actions/runs/40293308193) found existing cross-platform verification failures. Fixed the simulated macOS Sublime path to use POSIX separators on Windows; corrected two Projects test expectations to match the UI's `Needs attention` label; scoped the ACP approval assertion to the final rendered message; and refreshed the snapshot before a proposal's new project is selected, preventing stale-project cleanup from clearing it. Focused tests pass: Sublime config **4/4**, Projects **5/5**, and the three affected desktop files **10/10**. Full typecheck and backend tests pass after these follow-ups; rebuild passed. The run's GitHub desktop suite has not yet been repeated after these fixes.

The Windows-only installed-app check below cannot be completed from this macOS host. No live app profile was opened or modified, and no provider calls were made.

Branch: `fix/team-task-execution-and-diff`

Base: `694cace` on `main`

Repository: https://github.com/chere005/AgentTeam

The user requested a handoff file and a branch push while we were fixing the Diff tab. Preserve the existing working changes; this branch includes the accumulated task execution, runtime readiness, UI and Diff fixes. Detailed earlier evidence is in [docs/CONTINUATION.md](docs/CONTINUATION.md).

## What the user is trying to do

Give every agent a small file-writing assignment without managing pipelines, delegation chains, checkpoints or repeated status requests. The latest problem was an empty Diff tab despite agent-created files in `C:\GIT`.

## Implemented

- Simple assignments create independent file-only tasks on selected compatible agents. The **Report for duty** preset declares a separate filename and personally identifying content for each agent; actual files/content are verified.
- **Assign to team** beside chat carries the draft and current folder into the same task form. Ordinary chat remains directed to the selected agent. **Start tasks** creates executable work; the assistant's `project.start` proposal uses the same startup checks and retries the same saved project after setup failures.
- Setup checks validate installation/authentication, model choices, actual task-scoped tools/folders, output paths and provider capabilities before unpausing. Shell tools stay disabled for simple file tasks; unsupported adapters are refused without weakening isolation. The two scoped Codex agents remain unavailable on this Windows 10 host.
- Delegating agents receive actual nested worker failures instead of a generic blocked status. Safe in-scope absolute artifact paths are normalized before delegation; invalid contracts fail before child work is recorded. Ordinary waits are separate from interruptions; child evidence gates bounded parent continuations.
- Progress uses a single activity indicator with elapsed time. No timeout-derived completion bar or ETA. Empty projects say **No tasks assigned** instead of pretending to be queued work. Current-project context now matches the picker.
- Diff scans prioritize shallow files instead of exhausting the 2,000-file budget inside one child project. Coverage and incomplete snapshots are explicit. Saved paths are rechecked to prevent scan limits from inventing deletions, and current access rules filter both old and current content.
- Files absent from an incomplete historical baseline appear as **Not compared**, with a neutral preview of current contents and an explanation that the original was not saved. They are not presented as definite additions. Existing baselines are preserved.
- Diff subscribes to workspace changes. Shared watcher subscriptions are reference-counted and serialized so switching from Files to Diff cannot accidentally stop its lease. The fallback fingerprint also scans shallow files first.

## Current installation versus this branch

The installed app at `C:\Users\S\AppData\Local\Programs\AgentTeam` already includes the task/chat/runtime/blocker fixes from the preceding increment. Its installed archive SHA256 is `8cc935907033e10f9eb26554375df978152f74a17a48b75821e0ba725ff7f45f`.

**The latest Diff scan/watch/preview fixes have not been installed into that copy.** They are saved on this branch and included in the rebuilt development output. Backend changes require a complete app restart after deploying the new build; a renderer refresh alone is insufficient. Do not launch a second app against the same profile.

Last known installed main process: PID `18408`, with CDP at `http://127.0.0.1:9429`. The installed page is inside `resources/app.asar/dist/ui/index.html`. Recheck current processes and active/queued work before any restart; the user has been interacting with the app during development.

Backups from the previous installed update are in `C:\CLAUDIO\agentteam-local-update-1793001947285\backup`. No Electron sandbox/fuse was weakened. No installer release or version bump was made.

## Live state and important limits

- Last filesystem inspection found **10 duty text files** at the top of `C:\GIT`. This does not establish completion of all 14 agents.
- All 14 old per-agent folder baselines contain exactly 2,000 entries, no top-level files, and an incorrectly saved `truncated:false` flag. They were captured before the duty files. The old depth-first scanner exhausted its budget inside child projects and never reached those files. Do not reset these baselines to make the list appear clean; missing historical originals cannot be reconstructed reliably.
- Earlier failed task contracts/evidence remain unchanged. A provider can have written a file before its bad completion check failed. Do not blindly replay or relabel those attempts as successful.
- Several persistent role instructions still describe read-only reviewers/planners, although the user explicitly granted write tools and `C:\GIT` write access. Role prose supplies behavior; actual tools/folder grants enforce access. Direct declared file assignments include a task-specific instruction without rewriting saved roles or grants.
- Review-only communication edges are not delegation edges. Direct human team assignments avoid requiring reviewers/reporters to recursively dispatch work.
- No new paid/live provider run was started to demonstrate these changes. The 14-agent execution regression uses controlled providers that write real files in a temporary test folder.

## Validation

- Prior task/chat/blocker increment: **85 focused backend tests passed** and **3 hidden desktop workflows passed**. Includes 14 compatible agents independently writing/verifying their own files, with no delegation edges and unchanged permanent grants.
- Latest Diff backend scanner set: **15 passed, 1 Windows file-symlink test skipped**. Existing workspace regressions included.
- Latest watcher regressions: **3 passed** (overlapping views, slow stop/start handoff, top-level external edits beside an oversized child folder).
- Final full typecheck/build passed. All **3 distinct desktop Diff workflows passed**: incomplete legacy baseline with automatic external edits, ordinary folder diffs, and Git comparison/keyboard/narrow layout. The last needed a portable Git executable-bit fixture correction on Windows. Additional details are in [docs/CONTINUATION.md](docs/CONTINUATION.md).
- Earlier full backend run was **not green**: 529 passed, 3 failed, 13 skipped out of 545. Known Windows failures involved a file-symlink fixture, simulated macOS path separators, and an intermittent knowledge-filter test. That result predates subsequent tests; do not present it as a current full-suite pass. Full details remain in the continuation log.

## Where to continue

1. Read `AGENTS.md`, `TODO.md` and the latest continuation entry. Check branch/status before editing.
2. Deploy/restart the latest build only after checking active and queued work and preserving the user profile. Open Diff on the planner's `C:\GIT` folder. Confirm the top-level duty files appear, an unknown original is labelled honestly, and an external edit refreshes the view without clicking Refresh.
3. Keep the two unsupported Codex agents visible as unavailable until there is a supported scoped runtime; do not disable confinement or silently substitute a model.
4. Reconcile any old failed attempts explicitly if requested. Keep durable attempt/effect evidence and verify real file contents; do not claim a full live 14-agent success from fixture tests or an agent's prose.

Relevant source: `src/projects.ts`, `src/readiness.ts`, `src/service.ts`, `src/orchestration.ts`, `src/delegated-work.ts`, `src/workspace-changes.ts`, `src/fs-watch.ts`, `ui/components/Projects.tsx`, `ui/components/ChangesReview.tsx`, `ui/components/useWorkspaceWatch.ts`, and `ui/workspace-watches.ts`.

Use Node 24+. Relevant checks:

```sh
npm run typecheck
npm run build
node --test test/workspace-changes.test.ts test/workspace-fingerprint.test.ts test/workspace-watch-subscriptions.test.ts test/workspaces.test.ts test/workspace-extras.test.ts test/review-diffs.test.ts
node node_modules/@playwright/test/cli.js test e2e/review-incomplete.spec.ts e2e/review.spec.ts
```

Desktop tests use hidden isolated profiles. On this machine the managed command sandbox prevents Electron startup through AppContainer ACLs; the test harness needed approved execution outside that sandbox while Electron's own sandbox remained enabled. Never point tests at the user's live database.
