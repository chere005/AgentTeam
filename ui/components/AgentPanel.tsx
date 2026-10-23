import { PrioritySelect } from "./PrioritySelect";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Plus,
  FolderOpen,
  MessageSquare,
  ChevronRight,
  Columns2,
  PanelRight,
  GitCompare,
  AlertTriangle,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  ArrowLeftRight,
} from "lucide-react";
import {
  api,
  agentInput,
  type Agent,
  type Edge,
  type Snapshot,
  type TeamEvent,
} from "../api";
import { resolveModelState } from "../../src/model-choices";
import { InvocationPanel } from "./InvocationPanel";
import { usePersistedDetails } from "./persisted-details";
import { RoleTypeSelect } from "./RoleType";
import { RulesEditor } from "./AccessUi";
import type { AccessRule } from "../access-view";
import type { FeatureId } from "../features";
import { registerUnsaved } from "./UnsavedGuard";
import { instructionLengthHint } from "../instruction-length";
import "./runtime-ui.css";
import "./agent-panel.css";

type Workspace = {
  path: string;
  access: string;
  active: boolean;
  rules?: AccessRule[];
  explicitOnly?: boolean;
  sharing?: {
    scope: "nobody" | "selected" | "team" | "all";
    agentIds: string[];
  };
  shareRules?: {
    path: string;
    scope: "nobody" | "selected" | "team" | "all";
    agentIds: string[];
  }[];
};
type ShareScope = "nobody" | "selected" | "team" | "all";
type SkillPick = { id: string; mode: string; allowUnverified: boolean };
export type AgentForm = {
  schedulingPriority: number;
  name: string;
  role: string;
  roleType?: string;
  environment: string;
  kind: string;
  model: string;
  effort: string | null;
  maxConcurrentInvocations: number | null;
  instructions: string;
  tools: string[];
  skills: SkillPick[];
  workspaces: Workspace[];
  parentId: string | null;
  [key: string]: unknown;
};
export const newAgentDefaults: AgentForm = {
  schedulingPriority: 50,
  name: "",
  role: "",
  roleType: "custom",
  environment: "codex",
  kind: "agent",
  model: "default",
  effort: null,
  maxConcurrentInvocations: null,
  instructions: "",
  tools: [],
  skills: [],
  workspaces: [],
  parentId: null,
};
const RELATION: Record<Edge["kind"], string> = {
  delegate: "Assigns tasks",
  consult: "Asks for advice",
  review: "Requests a review",
  notify: "Sends updates",
};
const INCOMING: Record<Edge["kind"], string> = {
  delegate: "Gives this agent tasks",
  consult: "Asks this agent for advice",
  review: "Asks this agent for reviews",
  notify: "Sends this agent updates",
};
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Detected runtimes, refreshed while the form is open (installation can change in Settings). */
function useRuntimes() {
  const [runtimes, setRuntimes] = useState<any[]>([]);
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
  return runtimes;
}

/**
 * Shared by the side panel and New agent dialog. Keep identity visible; fold secondary setup
 * groups so the panel stays compact and each can be opened independently.
 */
export function AgentFormSections({
  form,
  setForm,
  data,
  agent,
  setError,
  talksTo,
  openFeature,
}: {
  form: AgentForm;
  setForm: (fn: (f: AgentForm) => AgentForm) => void;
  data: Snapshot;
  agent?: Agent;
  setError: (e: string) => void;
  /** Rendered between Skills and Advanced (existing agents only). */
  talksTo?: React.ReactNode;
  openFeature?: (id: FeatureId) => void;
}) {
  const update = (key: string, value: unknown) =>
    setForm((f) => ({ ...f, [key]: value }));
  const [identityOpen, onIdentityToggle] = usePersistedDetails(
    agent?.id,
    "identity",
    true,
  );
  const [modelOpen, onModelToggle] = usePersistedDetails(
    agent?.id,
    "model",
    true,
  );
  const [foldersOpen, onFoldersToggle] = usePersistedDetails(
    agent?.id,
    "folders",
    false,
  );
  const [skillsOpen, onSkillsToggle] = usePersistedDetails(
    agent?.id,
    "skills",
    false,
  );
  const [advancedOpen, onAdvancedToggle] = usePersistedDetails(
    agent?.id,
    "advanced",
    false,
  );
  const runtimes = useRuntimes();
  const [catalog, setCatalog] = useState<any>(null),
    [customModel, setCustomModel] = useState(false),
    [picking, setPicking] = useState(false),
    [search, setSearch] = useState(""),
    [source, setSource] = useState("bundled");
  useEffect(() => {
    api("/skills")
      .then(setCatalog)
      .catch((e) => setError(String(e)));
  }, []);
  const runtime = runtimes.find((r) => r.id === form.environment);
  const modelState = resolveModelState(runtime, form.model, form.effort);
  const modelOptions = modelState.options;
  const effortOptions = modelState.efforts;
  const savedModelLabel = {
    unavailable: " (unavailable in this installation)",
    unlisted: " (not verified)",
    unverifiable: " (installation not detected)",
    pending: "",
    ok: "",
  }[modelState.status];
  const compatible = (catalog?.[source]?.groups?.[form.environment] ??
    []) as any[];
  const allSkills = useMemo(() => {
    const out = new Map<string, any>();
    for (const src of ["bundled", "installed"])
      for (const group of Object.values(catalog?.[src]?.groups ?? {}))
        for (const s of group as any[]) out.set(s.id, s);
    return out;
  }, [catalog]);
  async function addFolder() {
    try {
      const path = await window.agentteam.chooseFolder();
      if (path && !form.workspaces.some((w) => w.path === path))
        update("workspaces", [
          ...form.workspaces,
          // New folders are read-only until the user allows edits.
          {
            path,
            access: "read",
            active: form.workspaces.length === 0,
            sharing: { scope: "nobody", agentIds: [] },
          },
        ]);
    } catch (e) {
      setError(String(e));
    }
  }
  const setWorkspace = (i: number, patch: Partial<Workspace>) =>
    update(
      "workspaces",
      form.workspaces.map((w, j) => (j === i ? { ...w, ...patch } : w)),
    );
  return (
    <>
      <details
        className="agent-section setup-group"
        open={identityOpen}
        onToggle={onIdentityToggle}
      >
        <summary>
          <h3>Identity & role</h3>
        </summary>
        <div className="form-grid">
          <RoleTypeSelect
            kind={form.kind}
            roleType={form.roleType ?? "custom"}
            form={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          />
          <label>
            Name
            <input
              autoFocus={!agent}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="e.g. Database Architect"
            />
          </label>
        </div>
        <label>
          Role / specialty
          <textarea
            rows={2}
            value={form.role}
            onChange={(e) => update("role", e.target.value)}
            placeholder="What should this agent be responsible for?"
          />
        </label>
        <label>
          Reports to
          <select
            value={form.parentId ?? ""}
            onChange={(e) => update("parentId", e.target.value || null)}
          >
            <option value="">Nobody (top of the team)</option>
            {data.agents
              .filter((a) => a.id !== agent?.id)
              .map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      </details>

      <details
        className="agent-section setup-group"
        open={modelOpen}
        onToggle={onModelToggle}
      >
        <summary>
          <h3>Model</h3>
          <small>
            {form.environment} · {form.model}
          </small>
        </summary>
        <div className="form-grid">
          <label>
            Environment
            <select
              value={form.environment}
              onChange={(e) => {
                const environment = e.target.value;
                setForm((f) => ({
                  ...f,
                  environment,
                  model: "default",
                  effort: null,
                }));
                setCustomModel(false);
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
                  const model = e.target.value;
                  setForm((f) => ({ ...f, model, effort: null }));
                }
              }}
            >
              {modelOptions.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {!modelOptions.some((m: any) => m.id === form.model) && (
                <option value={form.model}>
                  {form.model + savedModelLabel}
                </option>
              )}
              <option value="custom">Custom model ID (not validated)…</option>
            </select>
          </label>
        </div>
        {customModel && (
          <label>
            Custom model ID
            <input
              aria-label="Custom model ID"
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
            />
          </label>
        )}
        {modelState.warning && (
          <span
            className="model-warning"
            role="status"
            data-testid="model-warning"
          >
            {modelState.warning}
          </span>
        )}
        <small className="quiet">
          {runtime?.installed
            ? "Detected " + form.environment + " on this computer."
            : runtime
              ? "Not installed · choose a path in Settings."
              : "Detecting installation…"}
        </small>
      </details>

      <details
        className="agent-section setup-group"
        open={foldersOpen}
        onToggle={onFoldersToggle}
      >
        <summary>
          <h3>Folders</h3>
          <small>
            {form.workspaces.length
              ? `${form.workspaces.length} attached`
              : "None"}
          </small>
        </summary>
        <div className="section-head">
          <button onClick={() => void addFolder()}>
            <Plus size={14} />
            Add folder
          </button>
        </div>
        {!form.workspaces.length ? (
          <p className="section-empty">
            No folders yet. Add a folder so this agent can read (or edit) the
            files it works on.
          </p>
        ) : (
          <ul className="folder-list" aria-label="Folders">
            {form.workspaces.map((ws, i) => (
              <li key={ws.path} className="folder-row">
                <FolderOpen size={16} aria-hidden="true" />
                <div className="grow">
                  <b>{folderName(ws.path)}</b>
                  <code title={ws.path}>{ws.path}</code>
                  <div className="row">
                    <select
                      aria-label={"Access for " + ws.path}
                      value={ws.access}
                      onChange={(e) =>
                        setWorkspace(i, { access: e.target.value })
                      }
                    >
                      <option value="read">Can read</option>
                      <option value="write">Can read and edit</option>
                    </select>
                    <label className="inline">
                      <input
                        type="radio"
                        name={"active-folder-" + (agent?.id ?? "new")}
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
                      Working folder
                    </label>
                  </div>
                  <details className="resource-sharing">
                    <summary>Share file contents in conversations</summary>
                    <label>
                      This folder
                      <select
                        aria-label={`Share ${ws.path} with`}
                        value={ws.sharing?.scope ?? "nobody"}
                        onChange={(event) =>
                          setWorkspace(i, {
                            sharing: {
                              scope: event.target.value as ShareScope,
                              agentIds: ws.sharing?.agentIds ?? [],
                            },
                          })
                        }
                      >
                        <option value="nobody">Nobody</option>
                        <option value="selected">Specific agents</option>
                        <option value="team">All team agents</option>
                        <option value="all">All agents</option>
                      </select>
                    </label>
                    {ws.sharing?.scope === "selected" && (
                      <select
                        aria-label={`Agents allowed to share ${ws.path}`}
                        multiple
                        value={ws.sharing.agentIds}
                        onChange={(event) =>
                          setWorkspace(i, {
                            sharing: {
                              scope: "selected",
                              agentIds: Array.from(
                                event.currentTarget.selectedOptions,
                                (option) => option.value,
                              ),
                            },
                          })
                        }
                      >
                        {(data.teamView?.allAgents ?? data.agents)
                          .filter((candidate) => candidate.id !== agent?.id)
                          .map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.name}
                              {candidate.teamId !== agent?.teamId
                                ? ` · ${data.teams.find((team) => team.id === candidate.teamId)?.name ?? "Other team"}`
                                : ""}
                            </option>
                          ))}
                      </select>
                    )}
                    <small className="quiet">
                      Controls which teammates may receive file contents from
                      this folder in a conversation. It does not attach the
                      folder to them.
                    </small>
                    <SharingPathRules
                      workspace={ws}
                      agents={data.teamView?.allAgents ?? data.agents}
                      ownerId={agent?.id}
                      onChange={(shareRules) => setWorkspace(i, { shareRules })}
                    />
                  </details>
                </div>
                <button
                  className="icon"
                  aria-label={"Remove folder " + folderName(ws.path)}
                  title="Remove folder"
                  onClick={() =>
                    update(
                      "workspaces",
                      form.workspaces.filter((_, j) => i !== j),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>

      <details
        className="agent-section setup-group"
        open={skillsOpen}
        onToggle={onSkillsToggle}
      >
        <summary>
          <h3>Skills</h3>
          <small>
            {form.skills.length ? `${form.skills.length} assigned` : "None"}
          </small>
        </summary>
        <div className="section-head">
          <button aria-expanded={picking} onClick={() => setPicking(!picking)}>
            <Plus size={14} />
            Add skill
          </button>
        </div>
        {!form.skills.length && !picking && (
          <p className="section-empty">
            No skills yet. Skills give an agent reusable know-how; load them
            always, or only when a request needs them.
          </p>
        )}
        {form.skills.length > 0 && (
          <ul className="skill-list" aria-label="Assigned skills">
            {form.skills.map((s) => {
              const info = allSkills.get(s.id);
              return (
                <li key={s.id} className="skill-row">
                  <Sparkles size={15} aria-hidden="true" />
                  <div className="grow">
                    <b>{info?.name ?? s.id}</b>
                    {info?.description && (
                      <small className="clamp">{info.description}</small>
                    )}
                  </div>
                  <select
                    aria-label={"Load mode for " + (info?.name ?? s.id)}
                    value={s.mode}
                    onChange={(e) =>
                      update(
                        "skills",
                        form.skills.map((x) =>
                          x.id === s.id ? { ...x, mode: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="always">Always loaded</option>
                    <option value="on-demand">On demand</option>
                  </select>
                  <button
                    className="icon"
                    aria-label={"Remove skill " + (info?.name ?? s.id)}
                    title="Remove skill"
                    onClick={() =>
                      update(
                        "skills",
                        form.skills.filter((x) => x.id !== s.id),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {picking && (
          <div className="skill-picker" data-testid="skill-picker">
            <div className="row">
              <select
                aria-label="Skill source"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="bundled">Library (recommended)</option>
                <option value="installed">Installed on this computer</option>
              </select>
              <input
                placeholder="Search skills…"
                aria-label="Search skills"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <ul className="skill-choices" aria-label="Available skills">
              {compatible
                .filter(
                  (s) =>
                    !form.skills.some((x) => x.id === s.id) &&
                    (s.name + " " + s.description)
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                )
                .slice(0, 60)
                .map((s) => (
                  <li key={s.id}>
                    <div className="grow">
                      <b>{s.name}</b>
                      <small className="clamp">{s.description}</small>
                    </div>
                    <button
                      aria-label={"Add skill " + s.name}
                      onClick={() =>
                        update("skills", [
                          ...form.skills,
                          {
                            id: s.id,
                            mode: "on-demand",
                            allowUnverified: false,
                          },
                        ])
                      }
                    >
                      Add
                    </button>
                  </li>
                ))}
              {!compatible.length && (
                <li className="quiet">
                  No {source === "bundled" ? "library" : "installed"} skills for{" "}
                  {form.environment}.
                </li>
              )}
            </ul>
            <small className="quiet">
              Showing skills compatible with {form.environment}. On-demand
              skills are added to a run only when its request matches. Adding a
              skill never grants tools or folders.
            </small>
          </div>
        )}
      </details>

      {talksTo}

      {agent && (
        <InvocationPanel
          agent={agent}
          limit={form.maxConcurrentInvocations}
          data={data}
        />
      )}

      <details
        className="agent-section advanced"
        data-testid="agent-advanced"
        open={advancedOpen}
        onToggle={onAdvancedToggle}
      >
        <summary>
          Advanced
          <small className="quiet">
            priority, concurrency, effort, instructions, tools, access rules
          </small>
        </summary>
        <div className="form-grid">
          <label>
            Effort
            <select
              aria-label="Effort"
              disabled={!effortOptions.length && !modelState.unsupportedEffort}
              value={form.effort ?? ""}
              onChange={(e) => update("effort", e.target.value || null)}
            >
              <option value="">Provider default</option>
              {effortOptions.map((effort: string) => (
                <option key={effort}>{effort}</option>
              ))}
              {modelState.unsupportedEffort && (
                <option value={modelState.unsupportedEffort}>
                  {modelState.unsupportedEffort} (not supported)
                </option>
              )}
            </select>
            {modelState.unsupportedEffort && (
              <span
                className="effort-warning"
                role="status"
                data-testid="effort-warning"
              >
                The selected model does not offer “
                {modelState.unsupportedEffort}”. It is kept until you change it.
              </span>
            )}
            {!effortOptions.length && !modelState.unsupportedEffort && (
              <small>No effort choices for this model.</small>
            )}
          </label>
          <label>
            Scheduling priority
            <PrioritySelect
              value={form.schedulingPriority ?? 50}
              onChange={(value) => update("schedulingPriority", value)}
            />
            <small>
              Preempt gets the next free turn; running work finishes.
            </small>
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
        </div>
        <label>
          Always-loaded instructions
          <textarea
            className="code-input"
            rows={6}
            value={form.instructions}
            onChange={(e) => update("instructions", e.target.value)}
            placeholder="Standards, constraints and what a good result looks like…"
          />
        </label>
        <InstructionLength text={form.instructions} />
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
        <small className="quiet">
          Tool identifiers describe requirements; they do not install or grant
          tools. Model IDs and effort are passed to your installed provider.
        </small>
        {form.workspaces.length > 0 && (
          <div className="advanced-rules">
            <b>Folder access rules</b>
            {form.workspaces.map((ws, i) => (
              <div key={ws.path}>
                <small className="quiet">{ws.path}</small>
                <RulesEditor
                  ws={ws}
                  onChange={(next) =>
                    setWorkspace(i, {
                      rules: next.rules.length ? next.rules : undefined,
                      explicitOnly: next.explicitOnly || undefined,
                    })
                  }
                />
              </div>
            ))}
          </div>
        )}
        {openFeature && (
          <div className="row wrap">
            <button
              className="text-button"
              onClick={() => openFeature("capabilities")}
            >
              Tool grants & knowledge
              <ChevronRight size={14} />
            </button>
            <button
              className="text-button"
              onClick={() => openFeature("access")}
            >
              Effective folder access
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </details>
    </>
  );
}

function SharingPathRules({
  workspace,
  agents,
  ownerId,
  onChange,
}: {
  workspace: Workspace;
  agents: Agent[];
  ownerId?: string;
  onChange: (rules: NonNullable<Workspace["shareRules"]> | undefined) => void;
}) {
  const rules = workspace.shareRules ?? [];
  const update = (
    index: number,
    patch: Partial<NonNullable<Workspace["shareRules"]>[number]>,
  ) =>
    onChange(
      rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  return (
    <details className="sharing-path-rules">
      <summary>Exceptions for files or subfolders ({rules.length})</summary>
      {rules.map((rule, index) => (
        <div className="sharing-path-rule" key={`${rule.path}-${index}`}>
          <input
            aria-label="Shared file or folder path"
            placeholder="Relative path, e.g. docs/design.md"
            value={rule.path}
            onChange={(event) => update(index, { path: event.target.value })}
          />
          <select
            aria-label={`Sharing for ${rule.path || "path rule"}`}
            value={rule.scope}
            onChange={(event) =>
              update(index, { scope: event.target.value as ShareScope })
            }
          >
            <option value="nobody">Nobody</option>
            <option value="selected">Specific agents</option>
            <option value="team">All team agents</option>
            <option value="all">All agents</option>
          </select>
          {rule.scope === "selected" && (
            <select
              aria-label={`Agents allowed to share ${rule.path || "path"}`}
              multiple
              value={rule.agentIds}
              onChange={(event) =>
                update(index, {
                  agentIds: Array.from(
                    event.currentTarget.selectedOptions,
                    (option) => option.value,
                  ),
                })
              }
            >
              {agents
                .filter((candidate) => candidate.id !== ownerId)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
            </select>
          )}
          <button
            type="button"
            className="text-button"
            aria-label={`Remove sharing rule ${rule.path || index + 1}`}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          onChange([...rules, { path: "", scope: "nobody", agentIds: [] }])
        }
      >
        Add file or folder rule
      </button>
    </details>
  );
}

/** "Talks to": the agent's connections, in plain words, with a quick way to add one. */
function TalksTo({
  agent,
  data,
  act,
  openConnection,
}: {
  agent: Agent;
  data: Snapshot;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  openConnection: (edgeId: string) => void;
}) {
  const [open, onToggle] = usePersistedDetails(agent.id, "talks-to", false);
  const [to, setTo] = useState(""),
    [kind, setKind] = useState<Edge["kind"]>("delegate");
  const all = data.teamView?.allAgents ?? data.agents;
  const name = (id: string) => all.find((a) => a.id === id)?.name ?? "Unknown";
  const links = data.edges.filter(
    (e) => e.from === agent.id || e.to === agent.id,
  );
  return (
    <details
      className="agent-section setup-group"
      open={open}
      onToggle={onToggle}
    >
      <summary>
        <h3>Talks to</h3>
        <small>{links.length ? `${links.length} connections` : "None"}</small>
      </summary>
      {!links.length && (
        <p className="section-empty">
          Not connected yet. Connect agents so they can hand off work, ask for
          advice or request reviews.
        </p>
      )}
      {links.length > 0 && (
        <ul className="link-list" aria-label="Connections">
          {links.map((e) => {
            const out = e.from === agent.id;
            const other = out ? e.to : e.from;
            return (
              <li key={e.id}>
                <button
                  className="link-row"
                  onClick={() => openConnection(e.id)}
                  title="Edit this connection on the canvas"
                >
                  {(e as any).bidirectional ? (
                    <ArrowLeftRight size={14} aria-hidden="true" />
                  ) : out ? (
                    <ArrowRight size={14} aria-hidden="true" />
                  ) : (
                    <ArrowLeft size={14} aria-hidden="true" />
                  )}
                  <b>{name(other)}</b>
                  <span className="quiet">
                    {out ? RELATION[e.kind] : INCOMING[e.kind]}
                    {e.enabled ? "" : " · off"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="row add-link">
        <select
          aria-label="Connect to"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          <option value="">Connect to…</option>
          {data.agents
            .filter((a) => a.id !== agent.id)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
        <select
          aria-label="Relationship"
          value={kind}
          onChange={(e) => setKind(e.target.value as Edge["kind"])}
        >
          {(Object.keys(RELATION) as Edge["kind"][]).map((k) => (
            <option key={k} value={k}>
              {RELATION[k]}
            </option>
          ))}
        </select>
        <button
          disabled={!to}
          onClick={() =>
            void act(async () => {
              await api("/edges", "POST", {
                from: agent.id,
                to,
                kind,
                bidirectional: false,
                enabled: true,
              });
              setTo("");
            })
          }
        >
          Connect
        </button>
      </div>
    </details>
  );
}

/** Uncommitted changes in the agent's working (write) folder, for the "Review changes" entry. */
function useChanges(agent: Agent, events: TeamEvent[]) {
  const folder =
    agent.workspaces.find((w) => w.active && w.access === "write") ??
    agent.workspaces.find((w) => w.access === "write");
  const [count, setCount] = useState(0);
  const last = events.length ? events[events.length - 1].seq : 0;
  useEffect(() => {
    if (!folder) return setCount(0);
    let alive = true;
    const timer = setTimeout(() => {
      api("/agents/" + agent.id + "/git/status", "POST", {
        workspace: folder.path,
      })
        .then((r) => alive && setCount(r?.status?.length ?? 0))
        .catch(() => alive && setCount(0));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [agent.id, folder?.path, last]);
  return count;
}

/**
 * Side panel for the selected agent (opened by selecting it on the canvas). Edits are kept in a
 * local form until "Save changes"; the panel follows server updates while nothing is unsaved.
 */
function InstructionLength({ text }: { text: string }) {
  const hint = instructionLengthHint(text);
  return (
    <small
      className={hint.level === "long" ? "notice" : "quiet"}
      role="status"
      data-testid="instruction-length"
      data-level={hint.level}
    >
      {hint.chars.toLocaleString()} characters. {hint.message}
    </small>
  );
}

export function AgentPanel({
  agent,
  data,
  events,
  act,
  placement,
  setPlacement,
  close,
  openChat,
  openFeature,
  openConnection,
}: {
  agent: Agent;
  data: Snapshot;
  events: TeamEvent[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  placement: "replace" | "beside";
  setPlacement: (p: "replace" | "beside") => void;
  close: () => void;
  openChat: (id: string) => void;
  openFeature: (id: FeatureId) => void;
  openConnection: (edgeId: string) => void;
}) {
  const source = JSON.stringify(agentInput(agent));
  const [form, setForm] = useState<AgentForm>(
      () => agentInput(agent) as AgentForm,
    ),
    [base, setBase] = useState(source),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== base;
  // Follow server-side changes (other forms, assistant, packs) while nothing is unsaved here.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setForm(JSON.parse(source));
    setBase(source);
  }, [source]);
  const activity = data.activity.find((a) => a.agentId === agent.id);
  const failed = activity?.failedTaskIds.length ?? 0,
    interrupted = activity?.interruptedTaskIds?.length ?? 0;
  const changes = useChanges(agent, events);
  const state = activity?.state ?? "idle";
  async function save() {
    setBusy(true);
    try {
      await api("/agents/" + agent.id, "PUT", form);
      setBase(JSON.stringify(form));
      setError("");
      await act(async () => undefined);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  // Closing the panel, selecting another agent or switching team asks first (UnsavedGuard).
  const guardSource = useRef({ dirty, save, base, name: agent.name });
  guardSource.current = { dirty, save, base, name: agent.name };
  useEffect(
    () =>
      registerUnsaved({
        get name() {
          return guardSource.current.name;
        },
        dirty: () => guardSource.current.dirty,
        save: () => guardSource.current.save(),
        discard: () => {
          setForm(JSON.parse(guardSource.current.base));
          setError("");
        },
      }),
    [],
  );
  return (
    <section
      className="agent-panel"
      aria-label={`Agent: ${agent.name}`}
      data-testid="agent-panel"
    >
      <header className="agent-panel-head">
        <span className={"avatar " + agent.environment}>{agent.name[0]}</span>
        <div className="grow">
          <h2 data-testid="agent-panel-name">{agent.name}</h2>
          <small className="quiet">
            {agent.kind === "team-assistant"
              ? "Team coordinator"
              : agent.environment + " · " + agent.model}{" "}
            · <span className={"state " + state}>{state}</span>
          </small>
        </div>
        <button
          className="icon"
          aria-label={`Chat with ${agent.name}`}
          title="Open the conversation"
          onClick={() => openChat(agent.id)}
        >
          <MessageSquare size={17} />
        </button>
        <button
          className="icon"
          aria-label={
            placement === "replace"
              ? "Show agent panel beside chat"
              : "Show agent panel in place of chat"
          }
          title={
            placement === "replace"
              ? "Show beside the chat"
              : "Show in place of the chat"
          }
          onClick={() =>
            setPlacement(placement === "replace" ? "beside" : "replace")
          }
        >
          {placement === "replace" ? (
            <Columns2 size={17} />
          ) : (
            <PanelRight size={17} />
          )}
        </button>
        <button
          className="icon"
          aria-label="Close agent panel"
          title="Close (Esc)"
          onClick={close}
        >
          <X size={17} />
        </button>
      </header>
      {(changes > 0 || failed > 0 || interrupted > 0) && (
        <div className="agent-context" role="group" aria-label="Needs a look">
          {changes > 0 && (
            <button onClick={() => openFeature("review")}>
              <GitCompare size={14} />
              Review changes ({changes})
            </button>
          )}
          {(failed > 0 || interrupted > 0) && (
            <button
              className="warn"
              onClick={() => openFeature(failed ? "projects" : "recovery")}
            >
              <AlertTriangle size={14} />
              View blockers ({failed + interrupted})
            </button>
          )}
        </div>
      )}
      <div className="agent-panel-body scroll">
        <AgentFormSections
          form={form}
          setForm={setForm}
          data={data}
          agent={agent}
          setError={setError}
          openFeature={openFeature}
          talksTo={
            <TalksTo
              agent={agent}
              data={data}
              act={act}
              openConnection={openConnection}
            />
          }
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      {dirty && (
        <footer className="agent-save" data-testid="agent-save">
          <span className="quiet">Unsaved changes</span>
          <div className="row">
            <button
              onClick={() => {
                setForm(JSON.parse(base));
                setError("");
              }}
            >
              Discard
            </button>
            <button
              className="primary"
              disabled={busy || !form.name.trim()}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save changes"}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

/** New agent: the same sections in a dialog; after creation the agent's panel opens. */
export function NewAgentDialog({
  data,
  close,
  create,
}: {
  data: Snapshot;
  close: () => void;
  create: (input: AgentForm) => Promise<void>;
}) {
  const [form, setForm] = useState<AgentForm>(newAgentDefaults),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal agent-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
      >
        <header>
          <h2>New agent</h2>
          <button className="icon" aria-label="Close new agent" onClick={close}>
            <X />
          </button>
        </header>
        <div className="modal-content">
          <AgentFormSections
            form={form}
            setForm={setForm}
            data={data}
            setError={setError}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <span className="quiet">
            {form.workspaces.length} folder
            {form.workspaces.length === 1 ? "" : "s"} · {form.skills.length}{" "}
            skill{form.skills.length === 1 ? "" : "s"}
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={busy || !form.name.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  await create(form);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Creating…" : "Create agent"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
