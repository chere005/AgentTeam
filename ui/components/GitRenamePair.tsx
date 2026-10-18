import { useState } from "react";

type GitFile = { path: string; status: string };

/**
 * Pair a deleted file with a new one and stage both as one rename. Shown only when the working
 * tree has at least one unstaged deletion and one untracked file; the backend stages both sides
 * together (`renames` on /git/mutate) so Git records a rename instead of delete + add.
 */
export function GitRenamePair({
  files,
  disabled,
  onStage,
}: {
  files: GitFile[];
  disabled: boolean;
  onStage: (from: string, to: string) => Promise<void> | void;
}) {
  const deleted = files.filter((f) => f.status === " D");
  const added = files.filter((f) => f.status === "??");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  if (!deleted.length || !added.length) return null;
  const f = deleted.some((d) => d.path === from) ? from : "";
  const t = added.some((a) => a.path === to) ? to : "";
  return (
    <details className="section rename-pair">
      <summary>Stage a rename</summary>
      <p className="hint">
        Pair a deleted file with its new name so both are staged together.
      </p>
      <div className="row">
        <select
          aria-label="Deleted file (old name)"
          value={f}
          onChange={(e) => setFrom(e.target.value)}
        >
          <option value="">Old name…</option>
          {deleted.map((d) => (
            <option key={d.path} value={d.path}>
              {d.path}
            </option>
          ))}
        </select>
        <select
          aria-label="New file (new name)"
          value={t}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">New name…</option>
          {added.map((a) => (
            <option key={a.path} value={a.path}>
              {a.path}
            </option>
          ))}
        </select>
        <button
          disabled={disabled || !f || !t}
          onClick={async () => {
            await onStage(f, t);
            setFrom("");
            setTo("");
          }}
        >
          Stage rename
        </button>
      </div>
    </details>
  );
}
