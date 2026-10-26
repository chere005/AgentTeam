/**
 * Live runtime status for the readiness strip and Settings → Harness installations: one shared
 * `/runtimes` poll (every 2 s while something is subscribed, and at once on `runtimes.*` events)
 * plus the sign-ins started from the app that are still waiting for the runtime to report
 * `authenticated` (dropped after five minutes, like the backend's fast rescan).
 */
import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { RuntimeLike } from "./readiness";

export type RuntimeStatus = {
  runtimes: (RuntimeLike & {
    executable: string | null;
    version?: string;
    models: { id: string; name: string; efforts: string[] }[];
    modelSource: string;
    source?: string;
    note?: string;
    diagnostics?: { level: string; code: string; message: string }[];
  })[];
  scanning: boolean;
  settled: boolean;
  overrides?: Record<string, string>;
};
type Snapshot = {
  status: RuntimeStatus | null;
  /** Runtime id → when its sign-in was started from the app. */
  signIns: ReadonlyMap<string, number>;
};
export const SIGN_IN_WAIT_MS = 5 * 60_000;

let snapshot: Snapshot = { status: null, signIns: new Map() };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;
let loading: Promise<void> | undefined;

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const l of listeners) l();
}
/** Fetch `/runtimes` now (shared by concurrent callers). */
export function reloadRuntimes(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const status: RuntimeStatus = await api("/runtimes");
      const signIns = new Map(snapshot.signIns);
      const now = Date.now();
      for (const [id, at] of signIns)
        if (
          now - at > SIGN_IN_WAIT_MS ||
          status.runtimes.find((r) => r.id === id)?.authenticated === true
        )
          signIns.delete(id);
      publish({ status, signIns });
    } catch {
      /* no bridge (browser preview) or backend restarting: keep the last state */
    } finally {
      loading = undefined;
    }
  })();
  return loading;
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    void reloadRuntimes();
    timer = setInterval(() => void reloadRuntimes(), 2000);
    unsubscribe = window.agentteam?.onEvent((e) => {
      if (e.type.startsWith("runtimes.")) void reloadRuntimes();
    });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
const read = () => snapshot;
/** The shared runtime status and pending sign-ins (re-renders on every change). */
export function useRuntimeStatus() {
  return useSyncExternalStore(subscribe, read);
}
/** A sign-in was started from the app for `runtime` ("Waiting for sign-in…" until it reports signed in). */
export function markSignIn(runtime: string) {
  const signIns = new Map(snapshot.signIns);
  signIns.set(runtime, Date.now());
  publish({ signIns });
}
export function clearSignIn(runtime: string) {
  if (!snapshot.signIns.has(runtime)) return;
  const signIns = new Map(snapshot.signIns);
  signIns.delete(runtime);
  publish({ signIns });
}
export function signInWaiting(
  signIns: ReadonlyMap<string, number>,
  runtime: string,
  now = Date.now(),
) {
  const at = signIns.get(runtime);
  return at !== undefined && now - at <= SIGN_IN_WAIT_MS;
}
