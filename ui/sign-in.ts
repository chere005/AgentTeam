/**
 * "Sign in" from the readiness strip or Settings: the request waits here until the Terminal tab
 * (ui/components/Terminal.tsx) takes it, opens a new shell in the home folder, asks the backend
 * for the sign-in command line for that shell (POST /runtimes/:id/sign-in, which also starts the
 * 5 s rescan) and types it. The backend chooses the executable; the renderer only forwards
 * keystrokes. Anywhere: `window.dispatchEvent(new CustomEvent(SIGN_IN_EVENT, {detail: id}))`.
 */
import { markSignIn } from "./use-runtimes";

export const SIGN_IN_EVENT = "agentteam:sign-in";
let pending: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function requestSignIn(runtime: string) {
  pending = runtime;
  version++;
  markSignIn(runtime);
  for (const l of listeners) l();
}
/** The waiting request, if any, without taking it. */
export const peekSignIn = () => pending;
/** Take the waiting request (the Terminal tab handles it once). */
export function takeSignIn() {
  const runtime = pending;
  pending = null;
  return runtime;
}
export function subscribeSignIn(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const signInVersion = () => version;
