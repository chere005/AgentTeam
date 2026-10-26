/**
 * Pure readiness wording (no React/DOM; node tests import this file): what the top-bar strip says
 * about each runtime the active team uses, and how an automatic check is described. Every line
 * names the missing thing and the action that fixes it.
 */
import {
  sandboxUnavailable,
  type InvocationTask,
} from "../src/invocation-view.ts";
export type RuntimeLike = {
  id: string;
  installed: boolean;
  authenticated: boolean | null;
  staleOverride?: { path: string; reason: string };
  diagnostics?: { code: string }[];
};
export const RUNTIME_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  wolfram: "Wolfram",
};
export const runtimeLabel = (id: string) => RUNTIME_LABELS[id] ?? id;
export type ReadinessLine = {
  id: string;
  kind:
    | "checking"
    | "not-found"
    | "path-missing"
    | "detection-failed"
    | "signed-out"
    | "sandbox-unavailable"
    | "waiting";
  text: string;
  /** The button next to the line. */
  action: "settings" | "sign-in" | "recovery" | null;
};
const ORDER = ["claude", "codex", "wolfram"];

/**
 * One line per runtime in `used` that blocks work, in a fixed order. Nothing while a runtime is
 * ready, and nothing before the first scan has started (test mode never scans by itself).
 */
export function readinessLines(
  status: {
    runtimes: RuntimeLike[];
    scanning: boolean;
    settled: boolean;
  } | null,
  used: Iterable<string>,
  waiting: (id: string) => boolean = () => false,
): ReadinessLine[] {
  if (!status) return [];
  const ids = [...new Set(used)].sort(
    (a, b) =>
      (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99) ||
      a.localeCompare(b),
  );
  const lines: ReadinessLine[] = [];
  for (const id of ids) {
    const label = runtimeLabel(id);
    if (!status.settled) {
      if (status.scanning)
        lines.push({
          id,
          kind: "checking",
          text: `${label}: checking…`,
          action: null,
        });
      continue;
    }
    const r = status.runtimes.find((x) => x.id === id);
    if (!r) continue;
    if (r.staleOverride)
      lines.push({
        id,
        kind: "path-missing",
        text: `${label}: the executable chosen in Settings is missing`,
        action: "settings",
      });
    else if (!r.installed)
      lines.push(
        r.diagnostics?.some((d) => d.code === "discovery_failed")
          ? {
              id,
              kind: "detection-failed",
              text: `${label}: detection failed`,
              action: "settings",
            }
          : {
              id,
              kind: "not-found",
              text: `${label}: not found`,
              action: "settings",
            },
      );
    else if (r.authenticated === false)
      lines.push(
        waiting(id)
          ? {
              id,
              kind: "waiting",
              text: `${label}: waiting for sign-in…`,
              action: null,
            }
          : {
              id,
              kind: "signed-out",
              text: `${label}: sign in needed`,
              action: "sign-in",
            },
      );
  }
  return lines;
}
/** Installation/auth readiness does not establish that a task's required sandbox can run. */
export function taskReadinessLines(
  tasks: InvocationTask[],
  agentNames: Record<string, string>,
): ReadinessLine[] {
  const affected = new Map<string, number>();
  for (const task of tasks) {
    if (!["failed", "blocked", "interrupted"].includes(task.status)) continue;
    if (
      task.runtimeBlocker?.code !== "sandbox_unavailable" &&
      !sandboxUnavailable(task.result)
    )
      continue;
    affected.set(task.agentId, (affected.get(task.agentId) ?? 0) + 1);
  }
  return [...affected].map(([agentId, count]) => ({
    id: `sandbox:${agentId}`,
    kind: "sandbox-unavailable",
    text: `${agentNames[agentId] ?? agentId}: required sandbox unavailable (${count} assignment${count === 1 ? "" : "s"})`,
    action: "recovery",
  }));
}
/** Changes whenever a line appears, disappears or changes kind (a dismissal lasts until then). */
export const linesSignature = (lines: ReadinessLine[]) =>
  lines.map((l) => `${l.id}:${l.kind}`).join("|");

/** "just now", "5 min ago", "2 h ago", else the date. */
export function ago(iso: string, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}
/** "Checked automatically just now · verified" for a model check (null: not checked yet). */
export function checkedText(
  check: {
    verified: boolean;
    checkedAt: string | null;
    trigger?: "auto" | "manual";
  },
  now = Date.now(),
) {
  if (!check.checkedAt) return null;
  return `Checked ${check.trigger === "auto" ? "automatically " : ""}${ago(check.checkedAt, now)} · ${check.verified ? "verified" : "not verified"}`;
}
