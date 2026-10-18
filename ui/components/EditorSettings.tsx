import { useEffect, useState } from "react";
import { api } from "../api";

type Settings = {
  defaultEditor: string;
  paths: Record<string, string | undefined>;
  detected: Record<string, { found: boolean; path: string | null }>;
  platform: string;
};
const LABEL: Record<string, string> = {
  sublime: "Sublime Text",
  vscode: "Visual Studio Code",
  custom: "Custom application",
};

/** Editor executable overrides; blank keeps automatic detection (Sublime Text remains the default). */
export function EditorSettings() {
  const [s, setS] = useState<Settings | null>(null),
    [error, setError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({});
  const load = () =>
    api("/editors/settings").then(setS, (e) => setError(String(e.message)));
  useEffect(() => {
    void load();
  }, []);
  const save = async (key: string, value: string | null) => {
    setError("");
    try {
      setS(await api("/editors/settings", "PUT", { [key]: value }));
      setDrafts((d) => ({ ...d, [key]: "" }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  if (!s) return null;
  const keys = ["sublime", "vscode", "custom"];
  return (
    <section className="settings-card" aria-label="Editor paths">
      <h3>Editor executables</h3>
      <p>
        Leave a path empty to use automatic detection ({s.platform}). Paths must
        be absolute and are launched directly, never through a shell.
      </p>
      {keys.map((key) => {
        const det = s.detected[key];
        return (
          <div key={key} className="editor-path">
            <label>
              {LABEL[key]}
              <input
                aria-label={`${LABEL[key]} path`}
                value={drafts[key] ?? s.paths[key] ?? ""}
                placeholder={det?.path ?? "Not detected"}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [key]: e.target.value }))
                }
              />
            </label>
            <div className="row">
              <button
                disabled={drafts[key] === undefined || drafts[key] === ""}
                onClick={() => void save(key, drafts[key])}
              >
                Save
              </button>
              {window.agentteam?.chooseExecutable && (
                <button
                  onClick={async () => {
                    const p = await window.agentteam.chooseExecutable();
                    if (p) void save(key, p);
                  }}
                >
                  Browse…
                </button>
              )}
              {s.paths[key] && (
                <button onClick={() => void save(key, null)}>Clear</button>
              )}
              {det && key !== "custom" && (
                <small>
                  {det.found
                    ? `Found${det.path ? `: ${det.path}` : ""}`
                    : "Not found on this machine"}
                </small>
              )}
            </div>
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
