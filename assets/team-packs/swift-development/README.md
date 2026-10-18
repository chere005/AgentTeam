# Swift development (team-pack skeleton)

Status: skeleton, version 0.1.0. Structure only; it has not been run live.

## What is in the pack

- Five agents: Swift Lead (coordinator), Swift Implementer, Swift Test Engineer, Swift Reviewer, Swift Concurrency Specialist.
- Communication edges between them, grouped as "Swift team" on the canvas.
- A **required review** (mandatory rule): any task whose changed files match `**/*.swift` is held for the Swift Reviewer's approving verdict.
- An advisory specialist trigger (`swift-concurrency`) for concurrency keywords. It never blocks.
- Folders are named slots (`project`) that you map on install. No paths, credentials or permissions are embedded.

## Skills

Bundled and pinned (license text retained under `assets/skills/jeffallan--swift-expert/`):

- `swift-expert` (MIT, upstream `Jeffallan/claude-skills`). Execution is not validated on any harness.

## What is missing (not bundled — install separately)

AgentTeam does not ship these and the pack does not pretend to; they carry no id, license or revision here.

- Swift Testing / XCTest skill
- SwiftUI accessibility audit skill
- Xcode build and simulator tooling
- App Store signing and release skill

No tools are declared, so agents cannot run `xcodebuild` or `swift test` unless the harness itself allows commands. Agents are told to report only commands that actually ran.

## Licensing

The pack itself is MIT (`LICENSE.txt`). The companion skill's license is separate and is checked separately by `node scripts/audit-release.mjs`; an update that changes either license or the pinned revision must be acknowledged explicitly.
