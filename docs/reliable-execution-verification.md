# Reliable execution verification

`ExecutionVerification` in `src/execution-verification.ts` supplies backend execution evidence for the `execution-verified` completion check. A provider's successful turn, claimed output, task completion, verified execution and reviewer approval are separate facts. Verification establishes that the declared source snapshot produced the confirmed output under the recorded execution conditions; it does not establish every requirement of an arbitrary program.

## Backend API

The service is available as `service.verification`. References must come from an application action confirming expected output, or the backend's independent Pi calculation. Provider output must never create the expected reference.

```ts
const reference = service.verification.registerReference({
  label: "User-confirmed greeting",
  stdout: "Hello, world!",
  newline: "optional-one",
});

const spec = {
  entry: "python/program.py",
  language: "python" as const,
  referenceId: reference.id,
  sourceFiles: ["python/program.py", "python/helper.py"],
  args: [],
  stdin: "",
  standardLibraryOnly: true,
  timeoutMs: 20_000,
};

const record = await service.verification.verify(task.id, spec);
const check = { type: "execution-verified" as const, ...spec };
await service.verification.require(task, check);
```

`entry`, `language` and `referenceId` are required. The remaining fields above show their defaults, except `sourceFiles`, which defaults to an empty array; the entry is always included. Paths are relative to the task's authorized source root. Every imported local source/header must be declared. Traversal, Git internals, escaping paths and file symlinks are refused. Input reads recheck current grants, task scope and permanent filesystem denials; the total source set is bounded to 4 MB.

`verify` records a completed outcome with `passed` and `status` (`passed`, `failed`, `unavailable` or `cancelled`). Invalid references, inaccessible source and conflicting active work can reject before a run exists. `list(taskId)` and `latest(taskId)` expose recorded history. `latest` is for display: approval code must use `require`/`requireCurrent` and bind the returned evidence ID to the reviewed input.

## Evidence and provenance

Each run has a durable ID and an immutable database entity linked to an `execution-verification` effect-ledger entry. The visible `AgentTeam Verification` directory beside the profile database contains a run directory with read-only `Source/`, `manifest.json`, and separate writable `Output/`. The manifest records relative input paths, sizes and SHA-256 hashes. Evidence also records the canonical source root, normalized specification, request/snapshot/reference identities, toolchain executable/version, C++ binary hash, observed executable/arguments/cwd, confinement mechanism, exit status/signal, bounded stdout/stderr, timeout/cancellation flags, durations and run timestamps.

References have immutable IDs, output hashes and provenance: `user-confirmed` or `independent-pi`. `ensurePiReference(500, "significant")` computes Pi using distinct exact-integer Machin and Störmer identities with 40 guard digits and a known-prefix check. The 500-significant-digit fixture is `3.` plus 499 decimals, 501 characters, ending `48912279381830119491`. `"decimal"` means digits after the decimal point; results are truncated. Neither the candidate program nor its model supplies this reference.

Output comparison covers the entire string and its length. `newline: "exact"` permits no difference; the default `"optional-one"` additionally permits one terminal LF or CRLF. No prefix, regex or whitespace trimming proves execution success.

## Confinement and runtime constraints

| Host    | Enforcement and validation                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Mandatory `/usr/bin/sandbox-exec` default-deny profile. Actual fixture execution and containment were tested on this Mac.                                                               |
| Linux   | Mandatory `bwrap` with isolated namespaces, read-only inputs/toolchain mounts and writable output. Implemented but untested on this Mac; absent/unusable confinement refuses execution. |
| Windows | Execution verification refuses with `verifier_unavailable`.                                                                                                                             |

There is no unsandboxed fallback. Generated programs cannot access the workspace or home directory; only snapshot inputs, output and necessary runtime/system roots are readable. Writes stay in `Output/`, network access is denied, and permanent filesystem denials take precedence. macOS denies generated-process forks; the trusted C++ compiler driver may create descendants inside the same sandbox. Process groups are terminated before resources are released. Commands use a sanitized environment, bounded combined output (1,000,000 bytes), and a per-command timeout (default 20 seconds; configurable from 100 milliseconds through 60 seconds). Verification uses a dedicated single-capacity slot and the ordinary task lease.

| Language   | Current execution path                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python     | Installed Python 3, isolated mode, no site packages or bytecode writes. Standard-library mode checks imports and adds a runtime import audit; runtime replacement/dynamic loading is blocked. Declared sibling imports work for nested entries.                  |
| JavaScript | Installed native Node with its permission flags; declared local modules and Node built-ins are supported.                                                                                                                                                        |
| TypeScript | Same Node path with native type stripping; no compiler/bundler or package installation. The installed Node must support these flags.                                                                                                                             |
| C++        | Installed compiler, C++20, one entry translation unit and declared local headers. Standard-library mode uses a header allowlist. The produced executable is hashed before and after its confined run. Arbitrary build scripts/link dependencies are unsupported. |

The packaged Electron executable is never substituted for Node. Runtime discovery resolves installed native executables and macOS developer toolchains. Missing/incompatible runtimes return concrete failed/unavailable evidence. Import/header checks and confinement complement source review; passing a literal output check alone does not prove algorithm quality or general correctness.

## Cancellation and stale evidence

`verify(taskId, spec, { signal })` accepts an abort signal. `cancel(taskId)` aborts active verification; scheduler task cancellation invokes it. Cancellation preserves evidence, stops the process group and releases resources.

`require` rehashes current sources and the stored snapshot; `requireCurrent` is the synchronous final-transition gate. Changed source bytes, root, check/reference identity, missing snapshot bytes or revoked access invalidate approval. Successful cached evidence is reused only for its matching identity and intact snapshot. Review rounds must bind exact evidence IDs and schedule fresh verification/reviews after changes.

## Validation scope

The focused `test/execution-verification.test.ts` suite passed **9/9, zero skipped**, using real macOS confinement. It covers Pi precision/wrong digits, whole-output matching, fabricated run prose, external imports, immutable/stale sources, symlink/grant denial, outside reads/writes, network/fork denial, output overflow, timeout, cancellation, all four runtimes, and nested Python imports. These are fixture results. They do not claim a real installed-app run or live-provider acceptance; Linux execution has not been exercised and Windows is intentionally refused.
