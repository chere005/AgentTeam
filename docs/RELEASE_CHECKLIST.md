# Release checklist

Work through this before tagging. A configured workflow, a version bump or a green check on one platform is not evidence of a published release; record what you actually observed.

## Automated checks (any machine)

- [ ] `node scripts/audit-release.mjs` passes: lockfile matches `package.json`, every lock entry has an integrity hash, production dependency licenses are on the allow-list, each bundled skill has its upstream license text and an unmodified `SKILL.md` (SHA-256 matches the catalog), team templates parse, workflow YAML parses and actions are version-pinned. It is also the first check step in `ci.yml` and in the macOS jobs of `release.yml`.
- [ ] `npm ci && npm run typecheck && npm test && npm run build`
- [ ] `npm run test:ui` (Linux: `xvfb-run --auto-servernum npm run test:ui`)
- [ ] `npx prettier --check` on the files you changed (`npm run format` rewrites the whole tree; avoid it for small patches).
- [ ] `npm run preflight` passed for the exact commit (Desktop checks and the Release workflow in preflight mode).
- [ ] The `Desktop checks` workflow is green on macOS, Windows and Linux for the exact commit.

## Notices and licenses

- [ ] New dependency: purpose recorded, lockfile updated, license on the allow-list in `scripts/audit-release.mjs`, notice added under `assets/licenses/` when its license requires distribution of the text (the ACP SDK is Apache-2.0).
- [ ] New or updated bundled skill: `UPSTREAM-LICENSE.txt` from the upstream commit, catalog entry (`source`, `commit`, `license`, `skillSha256`) regenerated with `node scripts/curate-skills.mjs` (it reads locally checked-out, pinned upstream sources). Companion skills keep their own licenses.
- [ ] Electron's and Chromium's notices ship inside packaged applications; confirm they are present in at least one built artifact.

## Documentation

- [ ] `README.md` and `RELEASE_NOTES.md` describe the behavior in the code (execution default, limits, known gaps); `TODO.md` lists only open work.
- [ ] The annotated tag message is the GitHub release body (the workflow appends the install notes); write it from `RELEASE_NOTES.md`.
- [ ] `RELEASE_NOTES.md` states whether the artifacts are signed/notarized. Unsigned builds say so and explain OS approval prompts.

## Packaging and publication (needs real machines or credentials)

- [ ] Install and launch the packaged app on macOS arm64/x64, Windows x64 and Linux x64 (AppImage and deb); open a team, start the backend, quit cleanly.
- [ ] macOS: signing and notarization per `SIGNING.md`; verify with `codesign --verify --deep --strict` and `spctl --assess`. Never commit or print credentials.
- [ ] Only after explicit authorization: push, create the `v*` tag, let `release.yml` build and publish (README "Releases"; `npm run preflight` first), then download the actual assets and compare against `SHA256SUMS.txt`.
