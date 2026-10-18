import { Connections } from "./Connections";
import { useEffect, useState } from "react";
import { api } from "../api";
import { FolderOpen, RefreshCw } from "lucide-react";
export function HarnessSettings({
  act,
}: {
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [state, setState] = useState<any>(null),
    [paths, setPaths] = useState<Record<string, string>>({});
  async function load() {
    const result = await api("/runtimes");
    setState(result);
    setPaths(
      Object.fromEntries(
        result.runtimes.map((r: any) => [
          r.id,
          result.overrides?.[r.id] ?? r.executable ?? "",
        ]),
      ),
    );
  }
  useEffect(() => {
    void act(load);
  }, []);
  return (
    <>
      <Connections />
      <section className="settings-card">
        <div className="section-title">
          <div>
            <h3>Harness installations</h3>
            <p>Auto-detected by default. Override any executable below.</p>
          </div>
          <button
            title="Detect installations again"
            onClick={() =>
              void act(async () => {
                await api("/runtimes/refresh", "POST");
                await load();
              })
            }
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {state?.runtimes.map((r: any) => (
          <div className="harness-setting" key={r.id}>
            <div className="row between">
              <b>{r.id}</b>
              <span className={"badge " + (r.installed ? "green" : "")}>
                {!r.installed
                  ? "Not found"
                  : r.authenticated === true
                    ? "Installed · signed in"
                    : r.authenticated === false
                      ? "Installed · sign in needed"
                      : "Installed"}
              </span>
            </div>
            <label>
              Executable path
              <div className="row">
                <input
                  aria-label={r.id + " executable path"}
                  value={paths[r.id] ?? ""}
                  onChange={(e) =>
                    setPaths({ ...paths, [r.id]: e.target.value })
                  }
                  placeholder="Automatic discovery"
                />
                <button
                  title={"Choose " + r.id + " executable"}
                  onClick={() =>
                    void act(async () => {
                      const path = await window.agentteam.chooseExecutable();
                      if (path) setPaths({ ...paths, [r.id]: path });
                    })
                  }
                >
                  <FolderOpen size={16} />
                </button>
              </div>
            </label>
            <div className="row">
              <button
                disabled={!paths[r.id]?.trim()}
                onClick={() =>
                  void act(async () => {
                    await api("/runtimes/" + r.id, "PUT", {
                      path: paths[r.id].trim(),
                    });
                    await load();
                  })
                }
              >
                Use this executable
              </button>
              <button
                onClick={() =>
                  void act(async () => {
                    await api("/runtimes/" + r.id, "PUT", { path: null });
                    await load();
                  })
                }
              >
                Auto-detect
              </button>
              <small>
                {state.overrides?.[r.id] ? "Manual override" : "Automatic"}
              </small>
            </div>
            <p className="hint">
              {r.note ?? `${r.models.length} model choices · ${r.modelSource}`}
            </p>
          </div>
        ))}
      </section>
    </>
  );
}
