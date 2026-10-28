// Unexpected backend errors are recorded, not just printed.
//
// The desktop app's stdout is kept by nobody, so a 500 used to leave only a toast that said
// "Unexpected backend error": the failing call could not be identified afterwards. An unexpected
// error (anything that is not a validation failure or an `AppError`) now appends a
// `backend.error` event (immutable like every event) naming the route, the message and a bounded
// stack, and the response names the route and the message. The Inspector lists these events in
// every team's view (they belong to no team) under "System".
//
// What is stored, served by `/events` and sent in the response is redacted first (src/redact.ts):
// the API token, secret-looking environment values and credential shapes never appear in it.
import { Redactor } from "./redact.ts";
import type { Store } from "./store.ts";

export const STACK_LIMIT = 4096;
const MESSAGE_LIMIT = 500;
/**
 * The same error on the same route within this window is recorded once, however often it
 * repeats (a failing poll must not flood the log); the next record that is written says how many
 * were left out before it.
 */
export const REPEAT_WINDOW_MS = 60_000;
const recentByStore = new WeakMap<
  Store,
  Map<string, { at: number; repeats: number }>
>();

/** A redactor that knows the live API token on top of the environment and credential shapes. */
export function backendErrorRedactor(secrets: (string | undefined)[] = []) {
  return new Redactor({
    literals: secrets.filter((s): s is string => !!s),
    // The bounds are applied after redaction (a secret must never be cut in half and left behind).
    maxString: 200_000,
  });
}

/**
 * The text a failed API response becomes in the desktop bridge, and so in the toast: an unexpected
 * backend error names the route that failed, everything else keeps its own message.
 */
export function apiFailureText(result: {
  error?: string;
  message?: string;
  route?: string;
  issues?: { message?: string }[];
}) {
  return result.error === "internal_error" && result.route
    ? `${result.route}: ${result.message ?? "Unexpected backend error"}`
    : (result.message ??
        result.issues?.map((i) => i.message).join("; ") ??
        result.error);
}

export type RecordedBackendError = {
  route: string;
  message: string;
  /** The redacted, bounded stack (what the event holds), for the console line. */
  stack: string;
};

export function recordBackendError(
  store: Store,
  input: {
    method: string;
    path: string;
    error: unknown;
    now?: number;
    /** Removes secrets before anything is stored or returned; the default knows the environment only. */
    redactor?: Redactor;
    /** `after-headers`: the response had started, so the person saw a cut-off answer, not a 500. */
    phase?: "after-headers";
  },
): RecordedBackendError {
  const redactor = input.redactor ?? backendErrorRedactor();
  const error =
    input.error instanceof Error ? input.error : new Error(String(input.error));
  const message =
    redactor
      .string(error.message || error.name || "Unexpected backend error")
      .slice(0, MESSAGE_LIMIT) || "Unexpected backend error";
  const path = redactor.string(input.path).slice(0, 300);
  const route = `${input.method} ${path}`;
  const stack = redactor.string(error.stack ?? "").slice(0, STACK_LIMIT);
  const now = input.now ?? Date.now();
  let recent = recentByStore.get(store);
  if (!recent) recentByStore.set(store, (recent = new Map()));
  const key = `${route}|${message}`;
  const last = recent.get(key);
  if (last && now - last.at < REPEAT_WINDOW_MS) {
    last.repeats++;
    return { route, message, stack };
  }
  recent.set(key, { at: now, repeats: 0 });
  if (recent.size > 200)
    for (const [k, seen] of recent)
      if (now - seen.at >= REPEAT_WINDOW_MS) recent.delete(k);
  try {
    store.emit("backend.error", route, {
      method: input.method,
      path,
      message,
      stack,
      at: new Date(now).toISOString(),
      ...(input.phase ? { phase: input.phase } : {}),
      // How many identical failures within the window were left out before this record.
      ...(last && last.repeats ? { repeats: last.repeats } : {}),
    });
  } catch {
    // The store itself failed (closing, disk full): the response still names the error.
  }
  return { route, message, stack };
}
