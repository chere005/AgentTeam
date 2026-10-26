import { useState } from "react";
import { PlugZap } from "lucide-react";
import {
  linesSignature,
  readinessLines,
  taskReadinessLines,
} from "../readiness";
import type { InvocationTask } from "../../src/invocation-view";
import { signInWaiting, useRuntimeStatus } from "../use-runtimes";
import "./readiness.css";

/**
 * Top-bar strip: one line per runtime the active team uses that blocks work, each with the action
 * that fixes it ("Codex: sign in needed · Sign in", "Claude Code: not found · Open Settings").
 * Includes required-sandbox failures even when the runtime is installed and signed in. Dismissing hides it until the set of
 * blockers changes; the runtimes are polled every 2 s (ui/use-runtimes.ts).
 */
export function ReadinessStrip({
  environments,
  openSettings,
  signIn,
  tasks = [],
  agentNames = {},
  openRecovery,
}: {
  /** Runtimes the active team's agents use. */
  environments: string[];
  openSettings: () => void;
  signIn: (runtime: string) => void;
  tasks?: InvocationTask[];
  agentNames?: Record<string, string>;
  openRecovery?: () => void;
}) {
  const { status, signIns } = useRuntimeStatus();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const lines = [
    ...readinessLines(status, environments, (id) => signInWaiting(signIns, id)),
    ...taskReadinessLines(tasks, agentNames),
  ];
  const signature = linesSignature(lines);
  if (!lines.length || dismissed === signature) return null;
  return (
    <div
      className="readiness-strip"
      role="status"
      aria-label="Runtime readiness"
      data-testid="readiness-strip"
    >
      <PlugZap size={15} aria-hidden="true" />
      <ul>
        {lines.map((line) => (
          <li key={line.id} data-runtime={line.id} data-kind={line.kind}>
            <span>{line.text}</span>
            {line.action && <span aria-hidden="true">·</span>}
            {line.action === "settings" && (
              <button
                onClick={openSettings}
                title="Settings → Harness installations: install, choose the executable or rescan"
              >
                Open Settings
              </button>
            )}
            {line.action === "sign-in" && (
              <button
                onClick={() => signIn(line.id)}
                title="Opens a new terminal in your home folder and starts the sign-in there"
              >
                Sign in
              </button>
            )}
            {line.action === "recovery" && openRecovery && (
              <button onClick={openRecovery}>Open Recovery</button>
            )}
          </li>
        ))}
      </ul>
      <button className="text-button" onClick={() => setDismissed(signature)}>
        Dismiss
      </button>
    </div>
  );
}
