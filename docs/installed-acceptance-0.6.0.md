# Installed AgentTeam 0.6.0 acceptance — October 26, 2026

Passed the original ordinary-chat request in the actual installed application, in normal execution mode with real providers and a fresh isolated profile. The existing user profile was preserved. No fixture executor or test mode was used.

The prompt was: “have the developers make a program that computes pi to 500 digits without using any external libraries using the languages they are experts in, then have the reviewers pass it back to the developers until they are happy with the final result”.

The UI required one folder setup and explicit Start, displayed **500 significant digits, truncated (the leading 3 counts)**, and launched the application-owned implementation/review graph without a planner provider turn.

## Observed result

- Workflow: `2f0ddc02-c1f1-4c76-8f38-99444c4fc6fb`. Phase: **completed**. Correction rounds: **0 of 2**.
- Three actual source files; each confined execution matched the entire independently computed reference. Every stdout is 502 bytes including its final newline.
- Four distinct designated reviewers approved the exact verified source/evidence subject. All seven implementation/review tasks completed with real provider-run effects.
- A clean installed-app restart preserved the same eight task IDs (including the replaced preparation task), ten effect IDs and three verification IDs, with no repeated provider call or duplicate task. The UI still reported completed and all four approvals.

| Program          | Verification ID                        | Source SHA-256                                                     |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------ |
| typescript/pi.ts | `6f78c2fe-7677-42b8-a0c8-e7e841fb3b96` | `f0399fb9dea42590017dedd6a8b9bc9744f237c07b423d0374853333c274b104` |
| cpp/pi.cpp       | `ac81581d-d366-4940-8be5-54f30d2524ce` | `2bd56ca82b9ba2c9cb711735548d89bf6a22185739044b4edbf9bfa105542c02` |
| python/pi.py     | `e7e0883b-fe99-42e6-b079-260e40f9563e` | `fad32b563c12ced75abf744306323baaeee36299eb99cdefa9b489c877f8e248` |

| Required reviewer                | Review task ID                         |
| -------------------------------- | -------------------------------------- |
| Review: Codex (max effort)       | `c5c590de-f07c-424b-979e-ec87f2dc6ebd` |
| Review: Fable                    | `cc75a9be-f8fd-4df7-be80-e420d1a1ad38` |
| Final review: Codex (max effort) | `04c4de4f-e615-4d3c-94c0-90d9921a1a25` |
| Final review: Fable              | `200af15b-ac10-4e8e-a69e-ff113a29a76a` |

All reviews bind subject `743d3f4185c121dae03d5523e7cca0db0db1f08876bebb54175e519bb64df27f`. Codex inspected the full immutable source snapshots included in its prompt; its no-shell profile did not expose a local file-reader tool. The Claude reviewers also used their read-only project access.

## Build and scope

- Candidate installed archive SHA-256: `3bbd7fcab20c43a2a97161586b80e46c590668f7356b40cec4c943daf6b17ec9`.
- Claude Code: `2.1.308`; Codex CLI: `0.164.0-alpha.11.1`. Workers used configured Sonnet 5.5; reviewers used Codex default/max and configured Fable 5.1. These configured model IDs were exercised successfully, rather than treated as verified merely because they appeared in a catalog.
- Profile: `../AgentTeam-Acceptance-0.6.0/Data`; sources: `../AgentTeam-Acceptance-0.6.0/Programs`. Immutable evidence lives under that profile's visible `AgentTeam Verification` folder.
- This validates prepared ordinary-chat execution on macOS, not a live run of the separate legacy seven-stage pipeline project or native Windows confinement. Correction, rejection, inconclusive review, exhaustion and cancellation are covered by backend fixtures. Final release/preflight/deployment identifiers are recorded in CONTINUATION.md.
