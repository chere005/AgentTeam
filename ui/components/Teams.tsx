import { useEffect, useRef, useState } from "react";
import { X, Download, Upload, Copy, Trash2, Pencil, Plus } from "lucide-react";
import { api, type TeamEvent } from "../api";
import { starterTeams } from "./starterTeams";
import { TeamPacks, applyInsertedGroups } from "./TeamPacks";
import { requestArrange } from "../arrange-request";
import { ModelPicker, useRuntimeList } from "./ModelPicker";
import "./teams.css";

export type Point = { x: number; y: number };
export type TemplateAgent = {
  key: string;
  name: string;
  role: string;
  roleType?: string;
  environment: string;
  model: string;
  effort: string | null;
  parentKey?: string | null;
  workspaces: {
    slot: string;
    label: string;
    access: string;
    path?: string;
  }[];
};
export type TemplateView = {
  name: string;
  description: string;
  version: number;
  agents: TemplateAgent[];
  edges: unknown[];
  rules: unknown[];
  externalDependencies: ExternalDependency[];
  includesAbsolutePaths: boolean;
  project?: { type: string };
};
type ExampleField =
  | {
      key: string;
      label: string;
      kind: "count";
      min: number;
      max: number;
      default: number;
    }
  | {
      key: string;
      label: string;
      kind: "text";
      default: string;
      /** A model ID field: offered as a dropdown of this environment's models. */
      environment?: string;
    };
type Example = {
  id: string;
  name: string;
  shape: string;
  description: string;
  projectType: string;
  projectLabel: string;
  fields: ExampleField[];
  template: TemplateView;
};
type ModelCheck = {
  verified: boolean;
  issues: string[];
  warnings: string[];
};
export type ExternalDependency = {
  type: string;
  agentKey: string;
  direction: string;
  kind?: string;
  externalName: string;
};
type Issue = { code: string; message: string; agentKey?: string };
type Preview = {
  ok: boolean;
  issues: Issue[];
  warnings: string[];
  workspaceSlots: {
    agentKey: string;
    slot: string;
    label: string;
    access: string;
    embeddedPath: boolean;
  }[];
  externalDependencies: ExternalDependency[];
  counts: { agents: number; edges: number; rules: number };
};
type Summary = {
  id: string;
  name: string;
  description: string;
  version: number;
  agents: number;
  updatedAt: string;
  /** Live team the selection was saved from (library metadata only). */
  sourceTeam?: { id: string; name: string };
};
type Source = { templateId: string } | { envelope: unknown };
type InsertResult = {
  teamId: string;
  teamName: string;
  groups?: { name: string; agentIds: string[] }[];
  layout: Record<string, Point>;
  agents: { id: string }[];
  warnings: string[];
  externalDependencies: ExternalDependency[];
};

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");

function describeDependency(d: ExternalDependency, t?: TemplateView) {
  const who = t?.agents.find((a) => a.key === d.agentKey)?.name ?? d.agentKey;
  const what =
    d.type === "parent"
      ? "reports to"
      : d.type === "edge"
        ? `${d.kind ?? "connection"} connection ${d.direction === "outgoing" ? "to" : "from"}`
        : `${d.kind ?? "routing"} rule ${d.direction === "outgoing" ? "targeting" : "from"}`;
  return `${who} ${what} "${d.externalName}" (not included; reconnect after insertion if needed)`;
}

function Dependencies({
  items,
  template,
}: {
  items: ExternalDependency[];
  template?: TemplateView;
}) {
  if (!items.length) return null;
  return (
    <div className="team-note warn" data-testid="external-dependencies">
      <b>External dependencies ({items.length})</b>
      <p>
        These relationships pointed outside the saved group. They are recorded
        by name only and are never recreated.
      </p>
      <ul>
        {items.map((d, i) => (
          <li key={i}>{describeDependency(d, template)}</li>
        ))}
      </ul>
    </div>
  );
}

export function Modal({
  title,
  eyebrow,
  close,
  children,
  footer,
}: {
  title: string;
  eyebrow: string;
  close: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="modal team-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <button
            className="icon"
            aria-label={`Close ${title}`}
            onClick={close}
          >
            <X size={19} />
          </button>
        </header>
        <div className="modal-content">{children}</div>
        <footer>{footer}</footer>
      </section>
    </div>
  );
}

/** Save the selected canvas agents as a template (the backend flags external dependencies). */
export function SaveTeamDialog({
  agentIds,
  names,
  omittedAssistant,
  positions,
  groups = [],
  close,
}: {
  groups?: { name: string; agentIds: string[] }[];
  agentIds: string[];
  names: string[];
  omittedAssistant: boolean;
  positions: Record<string, Point>;
  close: () => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [paths, setPaths] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState<(TemplateView & { id: string }) | null>(null);
  async function save() {
    setBusy(true);
    setError("");
    try {
      setSaved(
        await api("/teams", "POST", {
          name,
          description,
          agentIds,
          positions: Object.fromEntries(
            agentIds
              .filter((id) => positions[id])
              .map((id) => [id, positions[id]]),
          ),
          includeAbsolutePaths: paths,
          groups: groups
            .map((g) => ({
              name: g.name,
              agentIds: g.agentIds.filter((id) => agentIds.includes(id)),
            }))
            .filter((g) => g.agentIds.length),
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Save as team"
      eyebrow="REUSABLE TEAM"
      close={close}
      footer={
        saved ? (
          <>
            <span />
            <button className="primary" onClick={close}>
              Done
            </button>
          </>
        ) : (
          <>
            <span />
            <div className="row">
              <button onClick={close}>Cancel</button>
              <button
                className="primary"
                disabled={!name.trim() || busy || !agentIds.length}
                onClick={() => void save()}
              >
                Save team
              </button>
            </div>
          </>
        )
      }
    >
      {saved ? (
        <>
          <div className="team-note ok" role="status">
            Saved “{saved.name}” with {saved.agents.length} agent(s),{" "}
            {saved.edges.length} connection(s) and {saved.rules.length} rule(s).
            Find it in the Saved teams library.
          </div>
          <Dependencies items={saved.externalDependencies} template={saved} />
          {saved.includesAbsolutePaths && (
            <div className="team-note warn">
              This template contains absolute folder paths from this computer.
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">
            Saving {names.length} agent{names.length === 1 ? "" : "s"}:{" "}
            {names.join(", ")}. Only relationships inside the selection are
            kept. Sessions, tasks, credentials and leases are never saved.
          </p>
          {omittedAssistant && (
            <div className="team-note warn">
              The Team Assistant is global and is not included.
            </div>
          )}
          <label>
            Team name
            <input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="inline team-check">
            <input
              type="checkbox"
              checked={paths}
              onChange={(e) => setPaths(e.target.checked)}
            />
            <span>
              Include absolute folder paths from this computer
              <small>
                Off by default. Folders are saved as named slots that you map
                when inserting. Paths may reveal your username or directory
                layout if you share the exported file.
              </small>
            </span>
          </label>
          {error && (
            <div className="team-note bad" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/** Map slots, choose explicit overrides, see validation, then insert atomically. */
export function InsertTeamDialog({
  source,
  template,
  agentIds,
  team,
  close,
  inserted,
}: {
  source: Source;
  agentIds: string[];
  template: TemplateView;
  /** The active team: the alternative destination to a new team of its own. */
  team?: { id: string; name: string };
  close: () => void;
  inserted: (r: InsertResult) => void;
}) {
  // Default: the template gets its own new team (named after it, made unique by the backend).
  const [destination, setDestination] = useState<"new" | "current">("new"),
    [teamName, setTeamName] = useState(template.name.slice(0, 80));
  const [mapping, setMapping] = useState<Record<string, string>>({}),
    [models, setModels] = useState<Record<string, string>>({}),
    [unknownModels, setUnknownModels] = useState(false),
    [uninstalled, setUninstalled] = useState(false),
    [embedded, setEmbedded] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const runtimes = useRuntimeList();
  const body = () => ({
    ...source,
    workspaces: Object.fromEntries(
      Object.entries(mapping).filter(([, v]) => v.trim()),
    ),
    useEmbeddedPaths: embedded,
    modelMap: Object.fromEntries(
      Object.entries(models).filter(([, v]) => v.trim()),
    ),
    allowUnknownModels: unknownModels,
    allowUninstalledEnvironments: uninstalled,
    ...(destination === "current" && team
      ? { teamId: team.id, offset: nextOffset(agentIds) }
      : { teamName: teamName.trim() || template.name, offset: { x: 0, y: 0 } }),
  });
  const latest = useRef(0);
  useEffect(() => {
    const run = ++latest.current;
    const timer = setTimeout(() => {
      api("/teams/preview", "POST", body())
        .then((p) => {
          if (run === latest.current) {
            setPreview(p);
            setError("");
          }
        })
        .catch((e) => run === latest.current && setError(message(e)));
    }, 200);
    return () => clearTimeout(timer);
  }, [mapping, models, unknownModels, uninstalled, embedded]);
  const slots = template.agents.flatMap((a) =>
    a.workspaces.map((w) => ({ agent: a, w, id: `${a.key}/${w.slot}` })),
  );
  const pairs = [
    ...new Set(template.agents.map((a) => `${a.environment}:${a.model}`)),
  ];
  const hasEmbedded = slots.some((s) => s.w.path);
  async function insert() {
    setBusy(true);
    try {
      inserted(await api("/teams/insert", "POST", body()));
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Insert “${template.name}”`}
      eyebrow="INSERT TEAM"
      close={close}
      footer={
        <>
          <span className="hint">
            {preview
              ? `${preview.counts.agents} agents · ${preview.counts.edges} connections · ${preview.counts.rules} rules`
              : "Checking…"}
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={!preview?.ok || busy}
              onClick={() => void insert()}
            >
              {destination === "new" ? "Insert as new team" : "Insert team"}
            </button>
          </div>
        </>
      }
    >
      {template.description && <p className="hint">{template.description}</p>}
      <h3>Destination</h3>
      <div className="team-slots" role="radiogroup" aria-label="Destination">
        <label className="inline team-check">
          <input
            type="radio"
            name="insert-destination"
            checked={destination === "new"}
            onChange={() => setDestination("new")}
          />
          <span>
            A new team of its own (becomes the active team)
            <input
              aria-label="New team name"
              value={teamName}
              maxLength={80}
              disabled={destination !== "new"}
              onChange={(e) => setTeamName(e.target.value)}
            />
          </span>
        </label>
        {team && (
          <label className="inline team-check">
            <input
              type="radio"
              name="insert-destination"
              checked={destination === "current"}
              onChange={() => setDestination("current")}
            />
            <span>Add to the active team “{team.name}”</span>
          </label>
        )}
      </div>
      <h3>Folders</h3>
      {slots.length ? (
        <div className="team-slots">
          {slots.map(({ agent, w, id }) => (
            <div className="team-slot" key={id}>
              <div>
                <b>{agent.name}</b>
                <small>
                  {w.label || w.slot} ·{" "}
                  {w.access === "write" ? "read & write" : "read only"}
                </small>
              </div>
              <input
                aria-label={`Folder for ${agent.name} ${w.label || w.slot}`}
                placeholder="Absolute folder path"
                value={mapping[id] ?? ""}
                onChange={(e) =>
                  setMapping({ ...mapping, [id]: e.target.value })
                }
              />
              <button
                onClick={async () => {
                  const path = await window.agentteam.chooseFolder();
                  if (path) setMapping((m) => ({ ...m, [id]: path }));
                }}
              >
                Browse…
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="hint">This team has no folder slots.</p>
      )}
      {hasEmbedded && (
        <label className="inline team-check">
          <input
            type="checkbox"
            checked={embedded}
            onChange={(e) => setEmbedded(e.target.checked)}
          />
          <span>
            Use the absolute paths embedded in this template
            <small>
              {slots
                .filter((s) => s.w.path)
                .map((s) => s.w.path)
                .join(", ")}
              . Off unless you opt in; folders you map above take precedence.
            </small>
          </span>
        </label>
      )}
      <h3>Models and environments</h3>
      <p className="hint">
        Keep the template’s model or pick a replacement. Nothing is substituted
        unless you choose it; grayed-out models are not available in the
        detected installation.
      </p>
      <div className="team-slots">
        {pairs.map((pair) => {
          const [env, model] = [
            pair.split(":")[0],
            pair.slice(pair.indexOf(":") + 1),
          ];
          return (
            <div className="team-slot models" key={pair}>
              <div>
                <b>{env}</b>
                <small>template model: {model}</small>
              </div>
              <ModelPicker
                label={`Replacement model for ${pair}`}
                environment={env}
                runtimes={runtimes}
                keepLabel={`Keep template model (${model})`}
                value={models[pair] ?? ""}
                onChange={(m) => setModels({ ...models, [pair]: m })}
              />
            </div>
          );
        })}
      </div>
      <label className="inline team-check">
        <input
          type="checkbox"
          checked={unknownModels}
          onChange={(e) => setUnknownModels(e.target.checked)}
        />
        <span>Allow models that the environment does not advertise</span>
      </label>
      <label className="inline team-check">
        <input
          type="checkbox"
          checked={uninstalled}
          onChange={(e) => setUninstalled(e.target.checked)}
        />
        <span>Allow environments that are not installed or detected</span>
      </label>
      <h3>Validation</h3>
      {error && (
        <div className="team-note bad" role="alert">
          {error}
        </div>
      )}
      {preview?.issues.length ? (
        <div className="team-note bad" data-testid="insert-issues">
          <b>Fix before inserting ({preview.issues.length})</b>
          <ul>
            {preview.issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : preview ? (
        <div className="team-note ok">No blocking issues.</div>
      ) : null}
      {preview?.warnings.length ? (
        <div className="team-note warn">
          <b>Warnings</b>
          <ul>
            {preview.warnings.map((w, n) => (
              <li key={n}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Dependencies items={template.externalDependencies} template={template} />
    </Modal>
  );
}

/** Indented org tree of a template (from parentKey): leads first, reports nested below. */
export function OrgTreePreview({
  agents,
  label = "Org chart preview",
}: {
  agents: TemplateAgent[];
  label?: string;
}) {
  const keys = new Set(agents.map((a) => a.key));
  const kids = (key: string | null) =>
    agents.filter((a) =>
      key === null
        ? !a.parentKey || !keys.has(a.parentKey)
        : a.parentKey === key && a.key !== key,
    );
  const seen = new Set<string>();
  const branch = (list: TemplateAgent[]): React.ReactNode =>
    list.length ? (
      <ul>
        {list
          .filter((a) => !seen.has(a.key) && seen.add(a.key))
          .map((a) => (
            <li key={a.key}>
              <span className="org-node">
                <b>{a.name}</b>
                <small>
                  {a.roleType && a.roleType !== "custom"
                    ? a.roleType + " · "
                    : ""}
                  {a.environment} · {a.model}
                </small>
              </span>
              {branch(kids(a.key))}
            </li>
          ))}
      </ul>
    ) : null;
  return (
    <div className="org-tree" aria-label={label} data-testid="org-tree-preview">
      {branch(kids(null))}
    </div>
  );
}

/**
 * Configure an example team (worker caps, model mappings), see the model check, then insert it as
 * a new active team. No goal, workspace or project: those come with "Assign project".
 */
export function ExampleInsertDialog({
  example,
  close,
  inserted,
}: {
  example: Example;
  close: () => void;
  inserted: (r: InsertResult) => void;
}) {
  const [options, setOptions] = useState<Record<string, string | number>>(() =>
      Object.fromEntries(example.fields.map((f) => [f.key, f.default])),
    ),
    [teamName, setTeamName] = useState(example.name.slice(0, 80)),
    [accept, setAccept] = useState(false),
    [state, setState] = useState<{
      template: TemplateView;
      modelCheck: ModelCheck;
      preview: Preview;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const runtimes = useRuntimeList();
  const latest = useRef(0);
  useEffect(() => {
    const run = ++latest.current;
    const timer = setTimeout(() => {
      api(`/teams/examples/${example.id}/preview`, "POST", { options })
        .then((r) => {
          if (run !== latest.current) return;
          setState(r);
          setError("");
        })
        .catch((e) => run === latest.current && setError(message(e)));
    }, 200);
    return () => clearTimeout(timer);
  }, [options]);
  const check = state?.modelCheck;
  const blocked =
    !state || !state.preview.ok || busy || (!check?.verified && !accept);
  async function insert() {
    setBusy(true);
    try {
      inserted(
        await api(`/teams/examples/${example.id}/insert`, "POST", {
          options,
          teamName: teamName.trim() || example.name,
          acceptUnverifiedModels: accept,
        }),
      );
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Insert “${example.name}”`}
      eyebrow="EXAMPLE TEAM"
      close={close}
      footer={
        <>
          <span className="hint">
            {state
              ? `${state.preview.counts.agents} agents · ${state.preview.counts.edges} connections · ${state.preview.counts.rules} rules`
              : "Checking…"}
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={blocked}
              onClick={() => void insert()}
            >
              Insert as new team
            </button>
          </div>
        </>
      }
    >
      <p className="hint">{example.description}</p>
      <div className="team-note">
        <b>A team, not a project.</b> Inserting creates the agents, their
        hierarchy, connections and rules as a new active team. Nothing runs.
        Give it work later with <b>Assign project</b> (goal and workspace); each
        project starts paused and re-verifies the models.
      </div>
      <label>
        Team name
        <input
          aria-label="New team name"
          value={teamName}
          maxLength={80}
          onChange={(e) => setTeamName(e.target.value)}
        />
      </label>
      <h3>Team settings</h3>
      <div className="team-slots example-fields">
        {example.fields.map((f) => (
          <label key={f.key} className="team-slot models">
            <span>
              <b>{f.label}</b>
              {f.kind === "count" && (
                <small>
                  {f.min}-{f.max}
                </small>
              )}
            </span>
            {f.kind === "count" ? (
              <select
                aria-label={f.label}
                value={options[f.key]}
                onChange={(e) =>
                  setOptions({ ...options, [f.key]: Number(e.target.value) })
                }
              >
                {Array.from({ length: f.max - f.min + 1 }, (_, i) => (
                  <option key={i}>{f.min + i}</option>
                ))}
              </select>
            ) : f.environment ? (
              <ModelPicker
                label={f.label}
                environment={f.environment}
                runtimes={runtimes}
                value={String(options[f.key] ?? "")}
                onChange={(m) => setOptions({ ...options, [f.key]: m })}
              />
            ) : (
              <input
                aria-label={f.label}
                value={options[f.key]}
                onChange={(e) =>
                  setOptions({ ...options, [f.key]: e.target.value })
                }
              />
            )}
          </label>
        ))}
      </div>
      {state && <OrgTreePreview agents={state.template.agents} />}
      <h3>Model verification</h3>
      {error && (
        <div className="team-note bad" role="alert">
          {error}
        </div>
      )}
      {check && (
        <div
          className={"team-note " + (check.verified ? "ok" : "warn")}
          data-testid="example-model-check"
        >
          <b>
            {check.verified
              ? "Models verified against the installed environments."
              : `Not verified (${check.issues.length})`}
          </b>
          {check.issues.length > 0 && (
            <ul>
              {check.issues.slice(0, 8).map((i, n) => (
                <li key={n}>{i}</li>
              ))}
              {check.issues.length > 8 && (
                <li>…and {check.issues.length - 8} more</li>
              )}
            </ul>
          )}
          {check.warnings.length > 0 && (
            <ul>
              {check.warnings.map((w, n) => (
                <li key={n}>Note: {w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {check && !check.verified && (
        <label className="inline team-check">
          <input
            type="checkbox"
            checked={accept}
            onChange={(e) => setAccept(e.target.checked)}
          />
          <span>
            Insert with unverified models
            <small>
              Projects assigned to this team stay paused until their models
              verify; nothing is substituted.
            </small>
          </span>
        </label>
      )}
      {state?.preview.issues.length ? (
        <div className="team-note bad">
          <ul>
            {state.preview.issues.map((i, n) => (
              <li key={n}>{i.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Modal>
  );
}

/** Place inserted teams to the right of everything already on the canvas. */
export function nextOffset(agentIds: string[]): Point {
  try {
    const all: Record<string, Point> = JSON.parse(
      localStorage.getItem("agentteam.positions") ?? "{}",
    );
    // Mirrors the canvas default grid for agents that were never moved.
    const xs = agentIds.map((id, i) => all[id]?.x ?? (i % 3) * 310);
    return { x: xs.length ? Math.max(...xs) + 340 : 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** Merge returned layout into the canvas' persisted positions. */
export function applyLayout(layout: Record<string, Point>) {
  let current: Record<string, Point> = {};
  try {
    current = JSON.parse(localStorage.getItem("agentteam.positions") ?? "{}");
  } catch {}
  localStorage.setItem(
    "agentteam.positions",
    JSON.stringify({ ...current, ...layout }),
  );
}

export function TeamLibrary({
  events,
  act,
  goCanvas,
  agentIds,
  team,
}: {
  events: TeamEvent[];
  agentIds: string[];
  /** Active team (insert destination alternative); the library itself is global. */
  team?: { id: string; name: string };
  act: (fn: () => Promise<unknown>) => Promise<void>;
  goCanvas: () => void;
}) {
  const [list, setList] = useState<Summary[]>([]),
    [examples, setExamples] = useState<Example[]>([]),
    [insertingExample, setInsertingExample] = useState<Example | null>(null),
    [current, setCurrent] = useState<{
      kind: "saved" | "starter" | "example";
      id: string;
    } | null>(null),
    [detail, setDetail] = useState<TemplateView | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [inserting, setInserting] = useState(false),
    [editing, setEditing] = useState<{
      name: string;
      description: string;
    } | null>(null),
    [confirmDelete, setConfirmDelete] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    file = useRef<HTMLInputElement>(null);
  const load = () => api("/teams").then(setList);
  useEffect(() => {
    load().catch((e) => setError(message(e)));
  }, [events.length]);
  useEffect(() => {
    api("/teams/examples")
      .then(setExamples)
      .catch((e) => setError(message(e)));
  }, []);
  const example =
    current?.kind === "example"
      ? examples.find((x) => x.id === current.id)
      : undefined;
  const starter =
    current?.kind === "starter"
      ? starterTeams.find((s) => s.id === current.id)
      : undefined;
  const source: Source | null =
    current && current.kind !== "example"
      ? current.kind === "saved"
        ? { templateId: current.id }
        : { envelope: starter?.envelope }
      : null;
  useEffect(() => {
    setDetail(null);
    setPreview(null);
    setEditing(null);
    setConfirmDelete(false);
    if (current?.kind === "example") {
      if (example) setDetail(example.template);
      return;
    }
    if (!current || !source) return;
    let live = true;
    (async () => {
      try {
        setDetail(
          current.kind === "saved"
            ? await api("/teams/" + current.id)
            : (starter!.envelope.template as TemplateView),
        );
        const p = await api("/teams/preview", "POST", source);
        if (live) setPreview(p);
      } catch (e) {
        if (live) setError(message(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [current?.kind, current?.id, events.length, examples.length]);
  async function exportFile(id: string, name: string) {
    const envelope = await api(`/teams/${id}/export`);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(envelope, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w.-]+/g, "-").toLowerCase() || "team"}.agentteam-team.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importFile(f: File) {
    let json: unknown;
    try {
      json = JSON.parse(await f.text());
    } catch {
      throw new Error("The selected file is not valid JSON");
    }
    const t = await api("/teams/import", "POST", json);
    setCurrent({ kind: "saved", id: t.id });
    setNotice(
      `Imported “${t.name}”. No agents were created; insert it to use it.`,
    );
  }
  return (
    <div className="section scroll team-library">
      <div className="section-title">
        <div>
          <span className="eyebrow">REUSABLE TEAMS</span>
          <h2>Saved teams</h2>
        </div>
        <div className="row">
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Team file to import"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void act(() => importFile(f));
            }}
          />
          <button onClick={() => file.current?.click()}>
            <Upload size={15} />
            Import
          </button>
        </div>
      </div>
      {notice && (
        <div className="team-note ok" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="team-note bad" role="alert">
          {error}{" "}
          <button className="text-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      <div className="team-columns">
        <div className="team-lists">
          <h3>Example teams</h3>
          <ul className="team-list" aria-label="Example teams">
            {examples.map((x) => (
              <li key={x.id}>
                <button
                  className={current?.id === x.id ? "selected" : ""}
                  onClick={() => setCurrent({ kind: "example", id: x.id })}
                >
                  <b>{x.name}</b>
                  <small data-testid="example-shape">{x.shape}</small>
                </button>
              </li>
            ))}
          </ul>
          <h3>Your teams</h3>
          {list.length ? (
            <ul className="team-list" aria-label="Saved teams">
              {list.map((t) => (
                <li key={t.id}>
                  <button
                    className={current?.id === t.id ? "selected" : ""}
                    onClick={() => setCurrent({ kind: "saved", id: t.id })}
                  >
                    <b>{t.name}</b>
                    <small>
                      {t.agents} agents · v{t.version}
                      {t.sourceTeam ? ` · from ${t.sourceTeam.name}` : ""}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              None yet. Select agents on the canvas and choose “Save as team”,
              or import a file.
            </p>
          )}
          <h3>Starter gallery</h3>
          <ul className="team-list" aria-label="Starter teams">
            {starterTeams.map((s) => (
              <li key={s.id}>
                <button
                  className={current?.id === s.id ? "selected" : ""}
                  onClick={() => setCurrent({ kind: "starter", id: s.id })}
                >
                  <b>{s.envelope.template.name}</b>
                  <small>
                    {s.envelope.template.agents.length} agents · bundled
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="team-detail">
          {!current || !detail ? (
            <p className="hint">Select a team to preview it.</p>
          ) : (
            <>
              <div className="section-title">
                <div>
                  {editing ? (
                    <div className="team-edit">
                      <input
                        aria-label="Team name"
                        value={editing.name}
                        onChange={(e) =>
                          setEditing({ ...editing, name: e.target.value })
                        }
                      />
                      <textarea
                        aria-label="Team description"
                        rows={2}
                        value={editing.description}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            description: e.target.value,
                          })
                        }
                      />
                      <div className="row">
                        <button
                          className="primary"
                          disabled={!editing.name.trim()}
                          onClick={() =>
                            void act(async () => {
                              await api("/teams/" + current.id, "PUT", editing);
                              setEditing(null);
                            })
                          }
                        >
                          Save
                        </button>
                        <button onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h3>{detail.name}</h3>
                      <p className="hint">{detail.description}</p>
                    </>
                  )}
                </div>
                {!editing && (
                  <div className="row team-actions">
                    <button
                      className="primary"
                      onClick={() =>
                        example
                          ? setInsertingExample(example)
                          : setInserting(true)
                      }
                    >
                      <Plus size={15} />
                      Insert…
                    </button>
                    {current.kind === "example" ? null : current.kind ===
                      "saved" ? (
                      <>
                        <button
                          onClick={() =>
                            setEditing({
                              name: detail.name,
                              description: detail.description,
                            })
                          }
                        >
                          <Pencil size={14} />
                          Rename
                        </button>
                        <button
                          onClick={() =>
                            void act(async () => {
                              const c = await api(
                                `/teams/${current.id}/duplicate`,
                                "POST",
                              );
                              setCurrent({ kind: "saved", id: c.id });
                            })
                          }
                        >
                          <Copy size={14} />
                          Duplicate
                        </button>
                        <button
                          onClick={() =>
                            void act(() => exportFile(current.id, detail.name))
                          }
                        >
                          <Download size={14} />
                          Export
                        </button>
                        {confirmDelete ? (
                          <button
                            className="danger"
                            onClick={() =>
                              void act(async () => {
                                await api("/teams/" + current.id, "DELETE");
                                setCurrent(null);
                              })
                            }
                          >
                            Confirm delete
                          </button>
                        ) : (
                          <button
                            className="danger"
                            onClick={() => setConfirmDelete(true)}
                          >
                            <Trash2 size={14} />
                            Delete
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() =>
                          void act(async () => {
                            const t = await api(
                              "/teams/import",
                              "POST",
                              starter!.envelope,
                            );
                            setCurrent({ kind: "saved", id: t.id });
                            setNotice(`Added “${t.name}” to your teams.`);
                          })
                        }
                      >
                        Add to my teams
                      </button>
                    )}
                  </div>
                )}
              </div>
              {example && (
                <div className="team-note" data-testid="example-projects">
                  <b>Takes projects:</b> {example.projectLabel}. Insert it once,
                  then use <b>Assign project</b> for each piece of work.
                </div>
              )}
              <OrgTreePreview agents={detail.agents} />
              <div className="team-agents">
                {detail.agents.map((a) => (
                  <div className="team-agent" key={a.key}>
                    <b>{a.name}</b>
                    <small>
                      {a.environment} · {a.model}
                      {a.effort ? ` · ${a.effort}` : ""}
                    </small>
                    {a.role && <p>{a.role}</p>}
                    {a.workspaces.map((w) => (
                      <span className="badge" key={w.slot}>
                        {w.access === "write" ? "RW" : "RO"} ·{" "}
                        {w.label || w.slot}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <p className="hint">
                {detail.edges.length} connections · {detail.rules.length} rules
                {detail.includesAbsolutePaths
                  ? " · contains absolute paths"
                  : " · no absolute paths"}
              </p>
              {preview && (
                <>
                  <h4>Workspace slots</h4>
                  {preview.workspaceSlots.length ? (
                    <ul>
                      {preview.workspaceSlots.map((s) => (
                        <li key={s.agentKey + s.slot}>
                          {
                            detail.agents.find((a) => a.key === s.agentKey)
                              ?.name
                          }
                          : {s.label || s.slot} ({s.access})
                          {s.embeddedPath ? " — embedded path" : ""}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint">None.</p>
                  )}
                  {preview.issues.length > 0 && (
                    <div className="team-note bad" data-testid="preview-issues">
                      <b>Needs attention before insertion</b>
                      <ul>
                        {preview.issues.map((i, n) => (
                          <li key={n}>{i.message}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preview.warnings.length > 0 && (
                    <div className="team-note warn">
                      <ul>
                        {preview.warnings.map((w, n) => (
                          <li key={n}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <Dependencies
                    items={preview.externalDependencies}
                    template={detail}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
      <TeamPacks
        events={events}
        agentIds={agentIds}
        act={act}
        goCanvas={goCanvas}
      />
      {inserting && source && detail && (
        <InsertTeamDialog
          source={source}
          template={detail}
          agentIds={agentIds}
          team={team}
          close={() => setInserting(false)}
          inserted={(r) => {
            applyLayout(r.layout);
            // Arranged as an org chart once the canvas shows the agents.
            requestArrange(
              r.teamId,
              r.agents.map((a) => a.id),
            );
            applyInsertedGroups(r.groups, agentIds, r.teamId);
            setInserting(false);
            goCanvas();
          }}
        />
      )}
      {insertingExample && (
        <ExampleInsertDialog
          example={insertingExample}
          close={() => setInsertingExample(null)}
          inserted={(r) => {
            requestArrange(
              r.teamId,
              r.agents.map((a) => a.id),
            );
            setInsertingExample(null);
            setNotice(
              `Inserted “${r.teamName}” as a new team. Assign it a project from the Projects pane or the team menu.`,
            );
            goCanvas();
          }}
        />
      )}
    </div>
  );
}
