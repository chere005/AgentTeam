import { useEffect, useState } from "react";
import { api } from "../api";
import type { FilesystemBlock } from "../../src/filesystem-policy";

export function FilesystemSettings({
  act,
}: {
  act: (action: () => Promise<unknown>) => unknown;
}) {
  const [blocks, setBlocks] = useState<FilesystemBlock[]>([]);
  const [path, setPath] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void act(async () => setBlocks((await api("/filesystem-policy")).blocks));
  }, []);
  return (
    <section className="settings-card" aria-label="Global filesystem blocks">
      <h3>Global filesystem blocks</h3>
      <p>
        Block a whole drive or folder for every team, agent and user action.
        Blocks take priority over all grants and approvals.
      </p>
      <p className="hint">
        Blocks are permanent in this data profile. They cannot be removed or
        overridden in AgentTeam. Folder blocks also prevent operations on an
        enclosing workspace; attach allowed subfolders separately.
      </p>
      {blocks.length > 0 && (
        <p role="status">
          Global blocks are active. Provider runs, kernel runs, Git, workflow
          commands, development servers and external apps are disabled until
          they have an enforceable filesystem sandbox. In-app file editing in
          unblocked workspaces remains available.
        </p>
      )}
      <ul>
        {blocks.map((block) => (
          <li key={block.id}>
            <code>{block.path}</code> · blocked permanently
          </li>
        ))}
      </ul>
      <label>
        Drive or folder to block
        <input
          aria-label="Drive or folder to block"
          placeholder="Absolute drive or folder path"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setAcknowledged(false);
          }}
        />
      </label>
      <label className="row">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
        />
        I understand this block is permanent and cannot be approved away.
      </label>
      <button
        disabled={busy || !path.trim() || !acknowledged}
        onClick={() => {
          setBusy(true);
          void act(async () => {
            try {
              const result = await api("/filesystem-policy/blocks", "POST", {
                paths: [path.trim()],
                acknowledgePermanent: true,
              });
              setBlocks(result.blocks);
              setPath("");
              setAcknowledged(false);
            } finally {
              setBusy(false);
            }
          });
        }}
      >
        {busy ? "Blocking…" : "Block permanently"}
      </button>
    </section>
  );
}
