// Unexpected backend errors are recorded, not just printed.
//
// The desktop app's stdout is kept by nobody, so a 500 used to leave only a toast that said
// "Unexpected backend error": the failing call could not be identified afterwards. An unexpected
// error (anything that is not a validation failure or an `AppError`) now appends a
// `backend.error` event (immutable like every event) naming the route, the message and a bounded
// stack, and the response names the route and the message. The Inspector lists these events.
import type { Store } from "./store.ts";

export const STACK_LIMIT = 4096;
const MESSAGE_LIMIT = 500;
/** The same error on the same route within this window is recorded once (a failing poll must not flood the log). */
const REPEAT_WINDOW_MS = 2000;
const recentByStore = new WeakMap<Store, Map<string, number>>();

export type RecordedBackendError = {
  route: string;
  message: string;
};

export function recordBackendError(
  store: Store,
  input: { method: string; path: string; error: unknown; now?: number },
): RecordedBackendError {
  const error =
    input.error instanceof Error ? input.error : new Error(String(input.error));
  const message =
    (error.message || error.name || "Unexpected backend error").slice(
      0,
      MESSAGE_LIMIT,
    ) || "Unexpected backend error";
  const route = `${input.method} ${input.path}`;
  const now = input.now ?? Date.now();
  let recent = recentByStore.get(store);
  if (!recent) recentByStore.set(store, (recent = new Map()));
  const key = `${route}|${message}`;
  const last = recent.get(key);
  if (last === undefined || now - last >= REPEAT_WINDOW_MS) {
    recent.set(key, now);
    if (recent.size > 200)
      for (const [k, at] of recent)
        if (now - at >= REPEAT_WINDOW_MS) recent.delete(k);
    try {
      store.emit("backend.error", route, {
        method: input.method,
        path: input.path,
        message,
        stack: (error.stack ?? "").slice(0, STACK_LIMIT),
        at: new Date(now).toISOString(),
      });
    } catch {
      // The store itself failed (closing, disk full): the response still names the error.
    }
  }
  return { route, message };
}
