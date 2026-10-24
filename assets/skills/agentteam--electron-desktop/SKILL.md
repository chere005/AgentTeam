---
name: electron-desktop
description: Build or review an Electron desktop app's main process, preload bridge, renderer security, IPC, window lifecycle, packaging and Playwright desktop tests.
---

# Electron desktop apps

Three trust zones; keep them separate. The **main process** owns the OS, files, processes and secrets. The **preload** script is the only bridge. The **renderer** is untrusted web content even when you wrote it.

- Every `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. Never enable `webSecurity: false`, `allowRunningInsecureContent` or the `remote` module.
- Preload exposes a small, named API with `contextBridge.exposeInMainWorld`: one function per capability, typed arguments, never `ipcRenderer` itself or a generic "send anything" channel. Return an unsubscribe function from every listener you register.
- Main-side `ipcMain.handle` checks the sender (`event.senderFrame` URL/origin is your app) and validates every argument with a schema or allowlist before acting. Treat file paths, URLs and commands from the renderer as hostile: resolve, check containment, refuse traversal and symlink escapes.
- Lock navigation: `setWindowOpenHandler` denies by default (open allowed http(s) links with `shell.openExternal` only after checking the origin), `will-navigate` is prevented, and a Content-Security-Policy forbids remote script. Embedded third-party content goes in a separate, restricted frame or view.
- Secrets (API tokens, provider keys) stay in the main process; the renderer gets results, not credentials. Prefer the OS keychain (`safeStorage`) over plain files.
- Lifecycle: request a single-instance lock, keep the window reference, and on quit stop child processes before exiting (process groups on POSIX, `taskkill /T` on Windows). Main-process or preload changes need an app restart; a renderer reload is not enough.
- Cross-platform: no shell strings (`spawn` with argv, `shell: false`), `path` APIs instead of `/` joins, `.cmd` shims on Windows, `darwin`-only APIs (Dock, `setActivationPolicy`) guarded by platform checks.
- Packaging: electron-builder/forge config in the repo; unsigned builds are labelled as such. macOS distribution needs Developer ID signing, hardened runtime and notarization; an ad-hoc signature (`codesign -s -`) only runs locally.

Testing: drive the real app with Playwright's `_electron.launch`, a temporary user-data directory per test, and a test-mode flag that disables live network/providers. Desktop tests must not take over the user's screen: create the window hidden (`show: false`, `paintWhenInitiallyHidden: true`, `backgroundThrottling: false`) and, on macOS, `app.setActivationPolicy("accessory")`. A hosted macOS runner has a ~1024 px display that clamps windows; call `win.setBounds` after creation (with `enableLargerThanScreen`) when layouts depend on width.

Read [references/security-checklist.md](references/security-checklist.md) before adding a new IPC channel, window, protocol handler or external launch.
