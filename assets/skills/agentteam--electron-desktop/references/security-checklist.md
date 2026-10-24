# Electron security checklist (new channel, window or launch)

1. Is the capability needed in the renderer at all? Prefer doing the work in main and returning a result.
2. Channel name is specific (`save-diagnostics`, not `fs`). Arguments are primitives or validated objects.
3. Handler calls a sender check first, then schema-validates input, then authorizes the action (folder access, user consent).
4. Paths: `realpath` both the root and the target, require containment, block `.git` and other internals where relevant.
5. Processes: argv only, explicit `cwd`, minimal `env`, timeout and output caps, tree-kill on cancel.
6. URLs: allowlist schemes and origins before `shell.openExternal`; never open `file:` or custom schemes from renderer input.
7. New windows/views: same webPreferences as the main window; deny `window.open` unless allowlisted.
8. Errors returned to the renderer carry a message, not stack traces with secrets or full paths you would not show.
9. A test proves the refusal path (bad sender, bad path, bad URL), not only the happy path.
