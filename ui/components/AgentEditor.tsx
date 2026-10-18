import { PrioritySelect } from "./PrioritySelect";
import { useEffect, useState } from "react";
import { X, Plus, FolderOpen } from "lucide-react";
import { api, agentInput, type Agent, type Snapshot } from "../api";
const defaults = {
  schedulingPriority: 50,
  name: "",
  role: "",
  environment: "codex",
  kind: "agent",
  model: "default",
  effort: null as string | null,
  maxConcurrentInvocations: null as number | null,
  instructions: "",
  tools: [] as string[],
  skills: [] as { id: string; mode: string; allowUnverified: boolean }[],
  workspaces: [] as { path: string; access: string; active: boolean }[],
  parentId: null as string | null,
};
export function AgentEditor({
  agent,
  data,
  close,
  save,
}: {
  agent?: Agent;
  data: Snapshot;
  close: () => void;
  save: (input: unknown) => Promise<void>;
}) {
  const [form, setForm] = useState(() =>
      agent ? agentInput(agent) : defaults,
    ),
    [tab, setTab] = useState("profile"),
    [catalog, setCatalog] = useState<any>(null),
    [runtimes, setRuntimes] = useState<any[]>([]),
    [customModel, setCustomModel] = useState(false),
    [search, setSearch] = useState(""),
    [source, setSource] = useState("bundled"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const update = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  useEffect(() => {
    api("/skills")
      .then(setCatalog)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const result = await api("/runtimes");
        if (alive) setRuntimes(result.runtimes);
      } catch {}
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const runtime = runtimes.find((r) => r.id === form.environment);
  const modelOptions = runtime?.models ?? [
    { id: "default", name: "Provider default", efforts: [] },
  ];
  const effortOptions =
    modelOptions.find((m: any) => m.id === form.model)?.efforts ?? [];
  const skills = (catalog?.[source]?.groups?.[form.environment] ?? []) as any[];
  async function addFolder() {
    try {
      const path = await window.agentteam.chooseFolder();
      if (path && !form.workspaces.some((w) => w.path === path))
        update("workspaces", [
          ...form.workspaces,
          { path, access: "read", active: form.workspaces.length === 0 },
        ]);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={agent ? "Configure agent" : "New agent"}
      >
        <header>
          <div>
            <span className="eyebrow">TEAM CONFIGURATION</span>
            <h2>{agent ? "Configure " + agent.name : "Create an agent"}</h2>
          </div>
          <button
            className="icon"
            aria-label="Close configuration"
            onClick={close}
          >
            <X />
          </button>
        </header>
        <div className="tabs">
          {["profile", "instructions", "skills", "workspace"].map((t) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="modal-content">
          {tab === "profile" && (
            <>
              <div className="form-grid">
                <label>
                  Role type
                  <select
                    value={form.kind}
                    onChange={(e) => update("kind", e.target.value)}
                  >
                    <option value="agent">Specialist agent</option>
                    <option value="team-assistant">Team Assistant</option>
                  </select>
                </label>
                <label>
                  Name
                  <input
                    autoFocus
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="e.g. Database Architect"
                  />
                </label>
                <label>
                  Environment
                  <select
                    value={form.environment}
                    onChange={(e) => {
                      update("environment", e.target.value);
                      update("model", "default");
                      setCustomModel(false);
                      update("effort", null);
                    }}
                  >
                    {["codex", "claude", "wolfram"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Model
                  <select
                    aria-label="Model"
                    value={customModel ? "custom" : form.model}
                    onChange={(e) => {
                      if (e.target.value === "custom") setCustomModel(true);
                      else {
                        setCustomModel(false);
                        update("model", e.target.value);
                        update("effort", null);
                      }
                    }}
                  >
                    {modelOptions.map((m: any) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                    {!modelOptions.some((m: any) => m.id === form.model) && (
                      <option value={form.model}>{form.model}</option>
                    )}
                    <option value="custom">Custom model ID…</option>
                  </select>
                  {customModel && (
                    <input
                      aria-label="Custom model ID"
                      value={form.model}
                      onChange={(e) => update("model", e.target.value)}
                    />
                  )}
                  <small>
                    {runtime?.installed
                      ? "Detected " + form.environment
                      : runtime
                        ? "Not installed · choose a path in Settings"
                        : "Detecting installation…"}
                  </small>
                </label>
                <label>
                  Effort
                  <select
                    disabled={!effortOptions.length}
                    value={form.effort ?? ""}
                    onChange={(e) => update("effort", e.target.value || null)}
                  >
                    <option value="">Provider default</option>
                    {effortOptions.map((effort: string) => (
                      <option key={effort}>{effort}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Max concurrent invoked agents
                  <select
                    value={form.maxConcurrentInvocations ?? ""}
                    onChange={(e) =>
                      update(
                        "maxConcurrentInvocations",
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">Unlimited</option>
                    {[
                      ...new Set([
                        ...Array.from({ length: 20 }, (_, i) => i + 1),
                        25,
                        50,
                        100,
                        250,
                        500,
                        1000,
                        ...(form.maxConcurrentInvocations
                          ? [form.maxConcurrentInvocations]
                          : []),
                      ]),
                    ]
                      .sort((a, b) => a - b)
                      .map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Scheduling priority
                  <PrioritySelect
                    value={form.schedulingPriority ?? 50}
                    onChange={(value) => update("schedulingPriority", value)}
                  />
                  <small>
                    Preempt gets the next free turn. Running work finishes
                    first.
                  </small>
                </label>
                <label>
                  Reports to
                  <select
                    value={form.parentId ?? ""}
                    onChange={(e) => update("parentId", e.target.value || null)}
                  >
                    <option value="">No parent</option>
                    {data.agents
                      .filter((a) => a.id !== agent?.id)
                      .map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Role / specialty
                <textarea
                  rows={3}
                  value={form.role}
                  onChange={(e) => update("role", e.target.value)}
                  placeholder="What should this agent be responsible for?"
                />
              </label>
              <p className="hint">
                Model IDs and effort are passed to your installed provider.
                Available values depend on your account and CLI version.
                Invocation limits apply to direct children; additional work
                queues.
              </p>
            </>
          )}
          {tab === "instructions" && (
            <>
              <label>
                Always-loaded instructions
                <textarea
                  className="code-input"
                  rows={16}
                  value={form.instructions}
                  onChange={(e) => update("instructions", e.target.value)}
                  placeholder="Standards, constraints, responsibilities and what a successful result looks like…"
                />
              </label>
              <label>
                Available tool identifiers
                <input
                  value={form.tools.join(", ")}
                  onChange={(e) =>
                    update(
                      "tools",
                      e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="Comma-separated identifiers required by skills"
                />
              </label>
              <p className="hint">
                Tool identifiers describe requirements; they do not install or
                grant tools. Execution capabilities depend on the runtime.
              </p>
            </>
          )}
          {tab === "skills" && (
            <>
              <div className="row">
                <select
                  aria-label="Skill source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="bundled">Recommended starter skills</option>
                  <option value="installed">
                    Installed in other harnesses
                  </option>
                </select>
                <input
                  placeholder="Search skills…"
                  aria-label="Search skills"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <p className="hint">
                Showing skills compatible with {form.environment}. Always-load
                skills are included in every launch. On-demand skills require
                runtime file tools.
              </p>
              <div className="skill-picks">
                {skills
                  .filter((s) =>
                    (s.name + " " + s.description)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((s) => {
                    const assignment = form.skills.find((x) => x.id === s.id);
                    return (
                      <div className="skill-pick" key={s.id}>
                        <label className="inline">
                          <input
                            type="checkbox"
                            checked={!!assignment}
                            onChange={(e) =>
                              update(
                                "skills",
                                e.target.checked
                                  ? [
                                      ...form.skills,
                                      {
                                        id: s.id,
                                        mode: "always",
                                        allowUnverified: false,
                                      },
                                    ]
                                  : form.skills.filter((x) => x.id !== s.id),
                              )
                            }
                          />
                          <b>{s.name}</b>
                        </label>
                        <p>{s.description}</p>
                        <small>
                          {s.harness} · {s.compatibility}
                        </small>
                        {assignment && (
                          <select
                            aria-label={"Load mode for " + s.name}
                            value={assignment.mode}
                            onChange={(e) =>
                              update(
                                "skills",
                                form.skills.map((x) =>
                                  x.id === s.id
                                    ? { ...x, mode: e.target.value }
                                    : x,
                                ),
                              )
                            }
                          >
                            <option value="always">Always load</option>
                            <option value="on-demand">On demand</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                {!skills.length && (
                  <div className="empty">
                    <p>No compatible skills in this environment.</p>
                  </div>
                )}
              </div>
              {form.skills
                .filter((s) => !skills.some((x) => x.id === s.id))
                .map((s) => (
                  <div className="row" key={s.id}>
                    <small>Assigned from another group: {s.id}</small>
                    <button
                      onClick={() =>
                        update(
                          "skills",
                          form.skills.filter((x) => x.id !== s.id),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
            </>
          )}
          {tab === "workspace" && (
            <>
              <div className="section-title">
                <div>
                  <h3>Folders & repositories</h3>
                  <p>Choose the files this agent works with.</p>
                </div>
                <button onClick={addFolder}>
                  <Plus size={15} />
                  Attach folder
                </button>
              </div>
              {form.workspaces.map((ws, i) => (
                <div className="workspace-attachment" key={ws.path}>
                  <FolderOpen size={19} />
                  <div className="grow">
                    <b>{ws.path.split(/[\\/]/).pop()}</b>
                    <code>{ws.path}</code>
                    <div className="row">
                      <select
                        aria-label={"Access for " + ws.path}
                        value={ws.access}
                        onChange={(e) =>
                          update(
                            "workspaces",
                            form.workspaces.map((w, j) =>
                              j === i ? { ...w, access: e.target.value } : w,
                            ),
                          )
                        }
                      >
                        <option value="read">Read only</option>
                        <option value="write">Read & write</option>
                      </select>
                      <label className="inline">
                        <input
                          type="radio"
                          name="active-folder"
                          checked={ws.active}
                          onChange={() =>
                            update(
                              "workspaces",
                              form.workspaces.map((w, j) => ({
                                ...w,
                                active: i === j,
                              })),
                            )
                          }
                        />
                        Working directory
                      </label>
                    </div>
                  </div>
                  <button
                    className="icon"
                    aria-label="Remove folder"
                    onClick={() =>
                      update(
                        "workspaces",
                        form.workspaces.filter((_, j) => i !== j),
                      )
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              {!form.workspaces.length && (
                <div className="empty">
                  <FolderOpen size={32} />
                  <h3>No folders attached</h3>
                  <p>Attach a project to browse files and use Git.</p>
                </div>
              )}
              <p className="hint">
                Folder access controls AgentTeam file and Git operations.
                Provider execution currently uses its own runtime restrictions.
              </p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <span className="quiet">
            {form.skills.length} skills · {form.workspaces.length} folders
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={busy || !form.name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await save(form);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
