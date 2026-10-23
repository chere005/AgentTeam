# Live workflow verification

Verified 2026-10-23 with isolated AgentTeam data profiles under
`/private/tmp/agentteam-live-20261023/`. No existing user profile or project was modified.

## Results

| Workflow                        | Team work completed                                                                                                                   | Verification                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi, 300 significant digits      | Opus coordinator, C++/Python/TypeScript builders, Codex reviewer                                                                      | **PASS.** All three programs ran; each emitted exactly 301 bytes (`3.` plus 299 decimals), matched byte-for-byte, and matched an independent 360-decimal-place mpmath 1.3.0 reference. SHA-256 for each output: `c497457fc60be73209bba04364c186ace5856f7b26ad74fdcfcb32328cf6a10e`.                                          |
| Product Feature, health service | Manager delegated implementation, review, focused tests, and docs; final reviewer approved all five files with zero blocking findings | **PASS on host.** `npm test`: 9 passed, 0 failed. This includes real HTTP requests to a server bound to `127.0.0.1`. Codex's restricted task sandbox could not run Node and skipped its socket tests; those are not counted as passing provider-side checks.                                                                 |
| Fresh sequential smoke project  | Manager, backend engineer, required Codex review, QA, technical writer; manager delegated source → review → tests → docs in sequence  | **PASS on host.** `node --check src/server.js` passed; `node --test test/server.test.js`: 5 passed, 0 failed. Tests make live loopback requests, check the exact health response, 404s, loopback binding, and require-without-listen behavior. Codex's sandbox denied Node execution, so the agent's tests were unrun there. |

## Artifacts

- Pi source and independent verifier: `/private/tmp/agentteam-live-20261023/workspace/pi-300/`; detailed output report: `/private/tmp/agentteam-live-20261023/workspace/pi-300/verification/REPORT.md`.
- Reviewed Product Feature service: `/private/tmp/agentteam-live-20261023/workspace/product-feature-fixed/`.
- Sequential workflow service: `/private/tmp/agentteam-live-20261023/workspace/sequenced-smoke/`.

## App verification

- Full backend suite: **478 total, 477 passed, 0 failed, 1 skipped** (opt-in Wolfram smoke test).
- Local Electron UI suite: **68/68 passed**.
- Typecheck, production build, release audit, Prettier, and `git diff --check`: passed.
- GitHub release `v0.2.2` completed all four installer jobs and published all platform assets. The downloadable Apple Silicon ZIP and DMG matched `SHA256SUMS.txt`; ZIP and DMG integrity checks passed.
- Required macOS preflight passed. Optional Windows UI checks had 54 passed, 10 failed, and 4 skipped; Linux had 61 passed, 6 failed, and 1 flaky test. Several failures hit Playwright's 45-second per-test timeout. These optional CI results do not establish cross-platform UI reliability.
- The production build reports Vite's advisory that its largest minified UI chunk is about 1.69 MB (500 KB advisory threshold). The app remains usable; code-splitting is a separate optimization.

## Limits observed

Codex task sandboxing on this Mac denies access to the host's Node executable and loopback sockets, even though task files are writable. AgentTeam correctly records these as unverified instead of claiming the tests ran. Host-side verification currently supplies the runtime evidence. Windows OS-level sandbox enforcement remains unfinished. The latest preflight exposed slow/flaky Windows and Linux UI tests; their details are in Actions run [40007628041](https://github.com/chere005/AgentTeam/actions/runs/40007628041).
