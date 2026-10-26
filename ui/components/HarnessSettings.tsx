import { Connections } from "./Connections";
import { RuntimeCapabilities } from "./RuntimeCapabilities";
import "./runtime-ui.css";
import { useEffect, useState } from "react";
import { api } from "../api";
import { FolderOpen, RefreshCw } from "lucide-react";
import {
  reloadRuntimes,
  signInWaiting,
  useRuntimeStatus,
} from "../use-runtimes";
import { SIGN_IN_EVENT } from "../sign-in";
export function HarnessSettings({
  act,
}: {
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [state, setState] = useState<any>(null),
    [paths, setPaths] = useState<Record<string, string>>({});
  // Badges and diagnostics follow the shared 2 s poll, so a sign-in or an automatic rescan shows
  // up without pressing Rescan; the path fields keep the user's edits.
  const live = useRuntimeStatus();
  const shown: any = live.status ?? state;
  async function load() {
    const result = await api("/runtimes");
    setState(result);
    void reloadRuntimes();
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
            <p>
              Detected automatically (PATH, the usual install folders and the
              Claude and Codex desktop apps) and checked again by themselves
              while something is missing or signed out. Override any executable
              below.
            </p>
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
        {shown?.runtimes.map((r: any) => {
          const waiting =
            r.authenticated === false && signInWaiting(live.signIns, r.id);
          return (
            <div className="harness-setting" key={r.id} data-runtime={r.id}>
              <div className="row between">
                <b>{r.id}</b>
                <span className="row">
                  <span
                    className={"badge " + (r.installed ? "green" : "")}
                    data-testid={"runtime-badge-" + r.id}
                  >
                    {r.staleOverride
                      ? "Manual path unavailable"
                      : !r.installed
                        ? "Not found"
                        : r.authenticated === true
                          ? "Installed · signed in"
                          : waiting
                            ? "Installed · waiting for sign-in…"
                            : r.authenticated === false
                              ? "Installed · sign in needed"
                              : "Installed"}
                  </span>
                  {r.installed &&
                    r.authenticated === false &&
                    r.id !== "wolfram" &&
                    !waiting && (
                      <button
                        title="Opens a new terminal in your home folder and starts the sign-in there"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent(SIGN_IN_EVENT, { detail: r.id }),
                          )
                        }
                      >
                        Sign in
                      </button>
                    )}
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
                  Reset to auto-detect
                </button>
                <small>
                  {shown.overrides?.[r.id] ? "Manual override" : "Automatic"}
                  {r.version ? " · " + r.version : ""}
                </small>
              </div>
              <ul className="diagnostics" aria-label={r.id + " diagnostics"}>
                {(r.diagnostics ?? []).map((d: any) => (
                  <li key={d.code} className={d.level} data-code={d.code}>
                    {d.message}
                  </li>
                ))}
              </ul>
              <p className="hint">
                {`${r.models.length} model choices · ${r.modelSource}`}
              </p>
            </div>
          );
        })}
      </section>
      <RuntimeCapabilities />
    </>
  );
}
