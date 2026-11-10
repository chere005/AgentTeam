# Windows work on release-0.8: handoff (branch `windows/0.8`)

Cut from `origin/release-0.8` (0b976a0, AgentTeam 0.8.0) on the Windows 10 PC. Work was paused by Sean mid-run; nothing here was merged to main and no tag was made. No GitHub Actions run was started (`ci.yml` only triggers on `main` and `preflight/**`, so a push of this branch does not run it).

## State in one paragraph

Windows-only breakage in the backend tests, worktrees and the Electron specs is fixed on the branch. `npm run typecheck` passes. The full `npm test` and the full desktop-spec set were **not** re-run on 0.8.0 after the last edits, so treat the counts below as partial.

## Done on this branch

- **Folder-access / regexp / EBUSY (#164 #88 #97 #101):** the 0.8.0 fixes (`escapeRegExp`, execution-world store closing, Playwright waits) were kept as they are on release-0.8; this branch adds the Windows fixes that were still missing (below).
- **Windows backend test failures:** `access.test.ts` and `execution-verification.test.ts` no longer need file-symlink privilege (they always check a directory junction, and the file symlink when it can be made); `inspector.test.ts` uses a private temp dir (it raced another file in the shared temp); four Git security tests (repo hooks, filter drivers, credential helper, askpass/sshCommand) are no longer skipped on Windows.
- **`test/core.test.ts` "provider file tools are limited to the attached workspace and assigned access":** it failed on Windows/Linux preflight because 0.8.0 refuses task-scoped Codex off macOS (`codexReadBoundaryIssue`). It now asserts the refusal (`provider_access_unsupported`) off macOS, then sets `AGENTTEAM_UNVERIFIED_SANDBOX=1` to check the generated profile. It passes on Windows. The refusal itself is **unchanged**.
- **Worktrees (#42), `src/worktrees.ts`:** removal no longer runs Git from inside the folder being deleted ("Permission denied"); per-repository overrides now match a folder spelled with another drive-letter case or forward slashes. New HTTP test in `test/worktrees.test.ts` covers create, attach, reuse, override, failure plus recovery, cleanup (file: 15 pass, 1 skipped).
- **Native Windows execution:** new `test/windows-native.test.ts` (real processes: args with spaces/quotes/cmd metacharacters through `.cmd` shims, `.bat`, plain executables; grandchild kill through both launch routes; cancel; `killTree`). 7/7 pass. Part of `npm test`, plus `npm run test:native`.
- **Electron UI:** `agent-work-panel` and `blocked-work` now pass on Windows via a test-only setting (honoured only with `AGENTTEAM_TEST=1`, `desktop/main.ts`, set in `playwright.config.ts`). `runtime-settings` and `assistant-chat` are un-skipped on Windows with an `installFixtureExecutable` helper for npm-style `.cmd` shims.
- **Main views (#90):** new `e2e/main-views.spec.ts` (Git project in a folder with a space and non-ASCII name, CRLF file, Ctrl+1-4 through Layout, Chat, Files, Diff; no page errors). Passed on Windows (6.0 s). **Projects is not covered yet.**

## Not done / open

- Full `npm test` and `npm run test:ui` were not completed on 0.8.0 (the first full Playwright run took about 1.5 minutes per test and was stopped). Run the specs one at a time, hidden: folder-access, simple-task, assistant-chat, agent-work-panel, desktop, workspace-ux, worktrees, main-views, runtime-settings.
- `runtime-settings` and `assistant-chat` un-skipped specs and `e2e/worktrees.spec.ts` have never been run.
- Projects view is missing from `main-views.spec.ts`.
- **Scoped Codex on Windows (item 5):** the model-free probe (`AGENTTEAM_BOUNDARY_PROBE=1 node --test test/provider-boundary.test.ts`) was not run. The win32 refusal stays.
- **Native Windows execution verification (#123):** the independent verifier still returns "unavailable" on Windows. Confinement (AppContainer, restricted token, job objects with an ACL'd working dir) was not attempted; do not add a weaker substitute.
- Remaining POSIX-only specs (`validation`, `folder-access`, `pipeline`, `project-setup`) not looked at on Windows. Linux is untested for everything here.
- Not code: #46 (sign/notarize; needs Sean's certificates).

## AgentSuite (#160), separate repo: branch `windows/pc-prepush-hook` (pushed, not merged)

`githooks/pre-push` and `tools/check-workflows.py` were fixed for Windows (the hook now finds a real Python 3 among `python3`, `python`, `py -3`; the checker no longer skips scripts because of backslash paths). The branch commit carries `[skip ci]` because AgentSuite's `check.yml` runs on every push.

PyYAML is now installed for the PC's `py -3` (Python 3.14, 32-bit). The hook is still **not enabled** in other checkouts: run `git config core.hooksPath ../AgentSuite/githooks` per checkout with workflows (not AgentTeam or WriteMind, which have their own `.githooks`). The "other Mac" half of #160 cannot be done from this PC.

## PlanMind, separate repo: branch `windows/native-shell-build` (pushed, not merged)

`tools/build-platforms.sh --windows` built `PlanMind_0.2.0_x64_en-US.msi` and `PlanMind_0.2.0_x64-setup.exe` on this PC (about 33 s, nothing installed). The script now fails early on a missing Git Bash, non-MSVC Rust host or missing C++ Build Tools, and fails unless both installers exist. `cargo test` for the shell passes (4), typecheck and vitest pass. Open there:
- `tools/heavy-lock.sh` cannot detect a live lock holder under Git Bash (`ps -o` is rejected), so two heavy builds could run at once. It is an exact copy from CoreMind, so fix it there and copy it.
- The Windows lane builds but does not install (the Mac lane installs). A silent msi install is a system change, not added.
- The full `npm run test:deploy` harness fails on Windows (170 of 632 checks), because it emulates a POSIX host. `test:deploy:mutations` was not run.

## This PC (Windows 10), facts that bite

- `python`/`python3` are only the Microsoft Store shortcut; use `py -3` (Python 3.14, PyYAML installed).
- AgentTeam's own `.githooks/pre-push` calls `python3`, so a push from this PC is refused ("a workflow breaks the quiet-CI contract") unless a `python3` that works is first on PATH. The workaround used for the `windows/0.8` push was a one-line bash script named `python3` containing `exec py -3 "$@"` in a temp folder prepended to PATH. The better fix is to make `.githooks/pre-push` pick a working interpreter the way AgentSuite's hook now does.
- Git refuses `C:\GIT\NoteMind` and `C:\GIT\WriteMind-private-updates` ("dubious ownership": they belong to the `CodexSandboxOffline` user). Not touched.
- Toolchain present: rustup stable on the MSVC host, VS Build Tools 2022 with C++, Windows SDK 10.0.26100, WebView2, Node 24.
- A push to a plain branch starts no Actions run for AgentTeam (`ci.yml` runs on `main` and `preflight/**` only) or PlanMind (`workflow_dispatch` only). AgentSuite runs on every push, hence `[skip ci]`.

## Windows tickets on the TaskMind board (state at the end of this session)

| Ticket | State |
| --- | --- |
| Windows CI: 6 folder-access tests fail (RegExp path, EBUSY restart DB) | Partial: fixed on `windows/0.8`, folder-access specs pass; full suite not re-run on 0.8.0 |
| Fix remaining Windows optional CI path and knowledge failures | Partial: same |
| Fix Windows and Linux optional CI test failures | Partial: Windows backend fixes done; Linux not touched |
| Stabilize Windows/Linux Electron UI CI runs | Partial: agent-work-panel and blocked-work pass; runtime-settings and assistant-chat un-skipped but not yet run |
| Add native Windows execution verification | Partial: native process tests (7/7); confinement not attempted, verifier still "unavailable" |
| Worktree auto-setup beyond POST /tasks; test on Windows and Linux | Partial: Windows bugs fixed and HTTP test passes; e2e spec not run; Linux untested |
| Verify the four main views on Windows and Linux | Partial: Layout, Chat, Files, Diff pass on Windows; Projects missing; Linux untested |
| Windows native shell build (PlanMind) | Built and pushed on `windows/native-shell-build`; install step not added |
| Turn on the quiet-CI pre-push hook on the other Mac and the PC | Partial: hook fixed and pushed; not enabled in other checkouts; Mac half not done here |
| Sign and notarize the macOS build; sign the Windows installer | Needs Sean's certificates |
| GitHub Actions billing blocks Windows preflight | Needs Sean (billing) |
| Restore GitHub Actions artifact uploads for Windows installers | Blocked on the billing item; would use Actions minutes |

Nothing was proposed as done on the board: this PC has no todo token.
