# Windows work on release-0.8: handoff (branch `windows/0.8`)

Cut from `origin/release-0.8` (0b976a0, AgentTeam 0.8.0) on the Windows 10 PC. Work was paused by Sean mid-run; nothing here was merged to main and no tag was made. No GitHub Actions run was started (`ci.yml` only triggers on `main` and `preflight/**`, so a push of this branch does not run it).

## State in one paragraph

Windows-only breakage in the backend tests, worktrees and the Electron specs is fixed on the branch. On this PC (uncommitted second pass, 2026-11-10): `npm run typecheck` passes, `npm test` is 806 pass, 0 fail, 34 skipped (Windows/macOS-only gates), and these specs pass hidden at the default 45 s timeout: folder-access, simple-task, assistant-chat, agent-work-panel, desktop, workspace-ux, worktrees, main-views, runtime-settings, blocked-work, ui-polish. The rest of `e2e/` was not run here.

## Done on this branch

- **Folder-access / regexp / EBUSY (#164 #88 #97 #101):** the 0.8.0 fixes (`escapeRegExp`, execution-world store closing, Playwright waits) were kept as they are on release-0.8; this branch adds the Windows fixes that were still missing (below).
- **Windows backend test failures:** `access.test.ts` and `execution-verification.test.ts` no longer need file-symlink privilege (they always check a directory junction, and the file symlink when it can be made); `inspector.test.ts` uses a private temp dir (it raced another file in the shared temp); four Git security tests (repo hooks, filter drivers, credential helper, askpass/sshCommand) are no longer skipped on Windows.
- **`test/core.test.ts` "provider file tools are limited to the attached workspace and assigned access":** it failed on Windows/Linux preflight because 0.8.0 refuses task-scoped Codex off macOS (`codexReadBoundaryIssue`). It now asserts the refusal (`provider_access_unsupported`) off macOS, then sets `AGENTTEAM_UNVERIFIED_SANDBOX=1` to check the generated profile. It passes on Windows. The refusal itself is **unchanged**.
- **Worktrees (#42), `src/worktrees.ts`:** removal no longer runs Git from inside the folder being deleted ("Permission denied"); per-repository overrides now match a folder spelled with another drive-letter case or forward slashes. New HTTP test in `test/worktrees.test.ts` covers create, attach, reuse, override, failure plus recovery, cleanup (file: 15 pass, 1 skipped).
- **Native Windows execution:** new `test/windows-native.test.ts` (real processes: args with spaces/quotes/cmd metacharacters through `.cmd` shims, `.bat`, plain executables; grandchild kill through both launch routes; cancel; `killTree`). 7/7 pass. Part of `npm test`, plus `npm run test:native`.
- **Electron UI:** `agent-work-panel` and `blocked-work` now pass on Windows via a test-only setting (honoured only with `AGENTTEAM_TEST=1`, `desktop/main.ts`, set in `playwright.config.ts`). `runtime-settings` and `assistant-chat` are un-skipped on Windows with an `installFixtureExecutable` helper for npm-style `.cmd` shims.
- **Main views (#90):** new `e2e/main-views.spec.ts` (Git project in a folder with a space and non-ASCII name, CRLF file, Ctrl+1-4 through Layout, Chat, Files, Diff, then the Projects tab with the project's card and task; no page errors). Passes on Windows.
- **Hidden test window was slow on Windows:** a never-shown window got about one animation frame a second, and Playwright waits for two frames before each click, so every click took 2 s and `desktop` and `workspace-ux` ran past 45 s. `desktop/main.ts` adds Chromium's `disable-frame-rate-limit` in hidden test mode on Windows only (clicks now about 45 ms). macOS and Linux unchanged.
- **Window sizing in specs:** at 200 % display scaling, `setContentSize` on the hidden window gave 1095x585 for 1100x600. New `setContentSize` helper in `e2e/helpers.ts` measures and corrects once; used by `agent-work-panel` and `ui-polish`.
- **File editor leave guard race (`ui/components/TextEditor.tsx`):** Ctrl+1-4 right after a save could still meet the "Discard your unsaved file changes?" confirm, because the guard was removed only by a React effect cleanup that runs after "Saved" is shown. The guard now reads the current dirty state. This was the intermittent `workspace-ux` Diff-not-selected failure (line 335); 12 repeats plus 2 full runs passed.
- **`test/installer-gates.test.ts` preflight test:** it spawned `bash` (not on PATH here) and, with Git's `bin/bash.exe`, that launcher put the real git ahead of the stub, so `scripts/preflight.sh` tried a real `git push` (refused by the pre-push hook; nothing was pushed). The test now finds Git Bash from `git --exec-path` on Windows (skips if none), puts the stubs first again inside the shell, and runs in the temp folder with `GIT_DIR` on its empty `.git`, so a real git cannot reach this checkout. 6/6 pass.
- **`.githooks/pre-push`:** finds a working Python 3.8+ among `python3`, `python`, `py -3` (same as AgentSuite's hook) instead of calling `python3`. Dry run on this PC picked `py -3` and the workflow check passed.
- **Scoped Codex probe:** `AGENTTEAM_BOUNDARY_PROBE=1 node --test test/provider-boundary.test.ts` was run: 2 pass, the real probe itself skips off macOS (it is gated on `darwin`), so there is still no Windows evidence and the win32 refusal stays.

## Not done / open

- The full `npm run test:ui` (every spec in `e2e/`) was not run on this PC; only the specs listed above.
- **Scoped Codex on Windows (item 5):** the boundary probe only runs on macOS, so scoped Codex on Windows has no evidence; enabling it needs a Windows probe design. The win32 refusal stays.
- **Native Windows execution verification (#123):** the independent verifier still returns "unavailable" on Windows (checked again: the sandbox tests skip with "mandatory verification sandbox unavailable on this host"). Needs Sean's design decision. Confinement (AppContainer, restricted token, job objects with an ACL'd working dir) was not attempted; do not add a weaker substitute.
- Remaining POSIX-only specs (`validation`, `folder-access`, `pipeline`, `project-setup`) not looked at on Windows. Linux is untested for everything here.
- Not code: #46 (sign/notarize; needs Sean's certificates).
- **File-tab editors in `ui/components/Panes.tsx` still have the close-after-save race (not fixed):** closing a file tab right after a save can still meet a stale "Discard your unsaved file changes?" confirm. Those editors run `TextEditor` with `guardLeave=false`, and the parent sets its dirty state in a `useEffect` (around Panes.tsx lines 1767, 2333, 2382), so its close check can read a dirty value one render old. Only `TextEditor`'s own leave guard was fixed (its `dirtyNow` ref is now updated in a layout effect, not during render).
- **`disable-frame-rate-limit` (`desktop/main.ts`)** is applied on every hidden-test run on win32, not only when a spec needs it. It was validated on one Windows 10 PC at 200 % scaling, with only the specs listed above. A hidden window on Linux was not looked at.
- **`setContentSize` helper (`e2e/helpers.ts`)** measures and corrects only on win32; on other platforms it is the plain `setContentSize` call (on Linux/X11 the size can apply asynchronously, so an immediate read-back could overshoot).
- **`test/installer-gates.test.ts` preflight test** now skips on Windows when Git Bash cannot be found, and its changed harness (stubs first, temp cwd, `GIT_DIR`) was not run on macOS or Linux.
- **`.githooks/pre-push` full workflow check** needs AgentSuite's `windows/pc-prepush-hook` fix merged or checked out: AgentSuite `main` on this PC skips extensionless scripts under backslash paths, so the check is incomplete with it.

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
- AgentTeam's own `.githooks/pre-push` now picks a working interpreter (`py -3` here), so the temp `python3` shim used for the first `windows/0.8` push is no longer needed.
- Git refuses `C:\GIT\NoteMind` and `C:\GIT\WriteMind-private-updates` ("dubious ownership": they belong to the `CodexSandboxOffline` user). Not touched.
- Toolchain present: rustup stable on the MSVC host, VS Build Tools 2022 with C++, Windows SDK 10.0.26100, WebView2, Node 24.
- A push to a plain branch starts no Actions run for AgentTeam (`ci.yml` runs on `main` and `preflight/**` only) or PlanMind (`workflow_dispatch` only). AgentSuite runs on every push, hence `[skip ci]`.

## Windows tickets on the TaskMind board (state at the end of this session)

| Ticket | State |
| --- | --- |
| Windows CI: 6 folder-access tests fail (RegExp path, EBUSY restart DB) | Fixed on `windows/0.8` (uncommitted second pass): folder-access specs pass, `npm test` 0 failures on this PC |
| Fix remaining Windows optional CI path and knowledge failures | Partial: same |
| Fix Windows and Linux optional CI test failures | Partial: Windows backend fixes done; Linux not touched |
| Stabilize Windows/Linux Electron UI CI runs | Partial: on Windows the listed specs pass at the default timeout (hidden-window frame rate, sizing and editor-guard fixes); full `e2e/` not run; Linux untested |
| Add native Windows execution verification | Partial: native process tests (7/7); confinement not attempted, verifier still "unavailable" |
| Worktree auto-setup beyond POST /tasks; test on Windows and Linux | Partial: Windows bugs fixed, HTTP test and `e2e/worktrees.spec.ts` pass; Linux untested |
| Verify the four main views on Windows and Linux | Partial: Layout, Chat, Files, Diff and Projects pass on Windows; Linux untested |
| Windows native shell build (PlanMind) | Built and pushed on `windows/native-shell-build`; install step not added |
| Turn on the quiet-CI pre-push hook on the other Mac and the PC | Partial: hook fixed and pushed; not enabled in other checkouts; Mac half not done here |
| Sign and notarize the macOS build; sign the Windows installer | Needs Sean's certificates |
| GitHub Actions billing blocks Windows preflight | Needs Sean (billing) |
| Restore GitHub Actions artifact uploads for Windows installers | Blocked on the billing item; would use Actions minutes |

Nothing was proposed as done on the board: this PC has no todo token.
