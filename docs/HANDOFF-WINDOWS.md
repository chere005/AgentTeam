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
