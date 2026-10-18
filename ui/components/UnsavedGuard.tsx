import { useEffect, useRef, useState } from "react";

/**
 * Unsaved-changes guard for the agent panel. The open panel registers what it would lose
 * (`registerUnsaved`); the App runs every action that closes the panel or replaces its agent
 * (close, Esc, Chat tab, hide side panel, select another agent, switch team) through
 * `useUnsavedGuard().guard(action)`. With unsaved edits it asks Save / Discard / Cancel first.
 */
export type UnsavedSource = {
  name: string;
  dirty: () => boolean;
  /** Resolves true when saved (false keeps the panel open with its error). */
  save: () => Promise<boolean>;
  discard: () => void;
};
let current: UnsavedSource | null = null;
export function registerUnsaved(source: UnsavedSource) {
  current = source;
  return () => {
    if (current === source) current = null;
  };
}
export const hasUnsaved = () => !!current?.dirty();

export function useUnsavedGuard() {
  const [pending, setPending] = useState<{
    name: string;
    run: () => void;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // The question currently open: Cancel/Esc clear it, so a save that finishes afterwards never
  // runs the cancelled action.
  const open = useRef<{ name: string; run: () => void } | null>(null);
  const ask = (p: { name: string; run: () => void } | null) => {
    open.current = p;
    setPending(p);
  };
  const guardRef = useRef((run: () => void) => {
    if (!current?.dirty()) return run();
    ask({ name: current.name, run });
  });
  const finish = (
    go: boolean,
    p: { name: string; run: () => void } | null = open.current,
  ) => {
    if (!p || open.current !== p) return;
    ask(null);
    if (go) p.run();
  };
  // Esc = Cancel, wherever focus is while the question is open (also while saving).
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      ask(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pending]);
  // Closing or reloading the window with unsaved edits: the desktop main process asks
  // "Discard changes / Keep editing" (desktop/main.ts will-prevent-unload); never a trap.
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!hasUnsaved()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
  const dialog = pending && (
    <div className="modal-backdrop">
      <section
        className="modal unsaved-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        aria-describedby="unsaved-text"
      >
        <div className="modal-content">
          <h2 id="unsaved-title">Save changes to {pending.name}?</h2>
          <p id="unsaved-text">
            This agent has edits that are not saved yet. Save them, discard
            them, or keep editing.
          </p>
        </div>
        <footer>
          <button onClick={() => finish(false)}>Cancel</button>
          <div className="row">
            <button
              disabled={busy}
              onClick={() => {
                current?.discard();
                finish(true);
              }}
            >
              Discard
            </button>
            <button
              className="primary"
              data-autofocus
              disabled={busy}
              onClick={async () => {
                const p = open.current;
                setBusy(true);
                const ok = await (
                  current?.save() ?? Promise.resolve(true)
                ).catch(() => false);
                setBusy(false);
                finish(ok, p);
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
  return { guard: guardRef.current, dialog };
}
