import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { api, persist, saved } from "../api";
import { createGroup, sanitizeGroups } from "../groups";
import { Modal, applyLayout, nextOffset, type Point } from "./Teams";
import "./team-packs.css";

type PackSummary =
  | { packId: string; invalid: string }
  | {
      packId: string;
      name: string;
      version: string;
      description: string;
      status: string;
      license: string;
      source: string;
      agents: number;
      bundledSkills: number;
      missingSkills: number;
      limitations: string[];
      installs: { id: string; version: string }[];
    };
type Installed = {
  id: string;
  packId: string;
  name: string;
  version: string;
  status: string;
};
type PackRequest = { packId: string } | { manifest: unknown };
type Issue = { code: string; message: string };
type PackPreview = {
  ok: boolean;
  pack: {
    name: string;
    version: string;
    status: string;
    description: string;
    source: { name: string; license: string; url?: string };
    notices: string[];
    limitations: string[];
  };
  issues: Issue[];
  warnings: string[];
  harnesses: {
    environment: string;
    support: string;
    note: string;
    usedBy: string[];
    installed: boolean | null;
  }[];
  skills: {
    name: string;
    bundled: boolean;
    status: string;
    id?: string;
    license?: string;
    revision?: string;
    purpose?: string;
    note?: string;
    installedHere?: boolean;
  }[];
  modelMappings: {
    environment: string;
    templateModel: string;
    preferredModel?: string;
    note: string;
  }[];
  grants: { kind: string; description: string }[];
  workspaceSlots: {
    agentKey: string;
    slot: string;
    label: string;
    access: string;
  }[];
  changes: {
    agents: {
      key: string;
      name: string;
      environment: string;
      model: string;
      skills: string[];
    }[];
    edges: number;
    rules: number;
    groups: string[];
    records: string[];
  };
  requiresGrantAcknowledgement: boolean;
};
type Change = {
  id: string;
  entity: string;
  label: string;
  field?: string;
  action: string;
  status: "apply" | "conflict" | "keep-local";
  reason?: string;
  old?: string;
  new?: string;
  local?: string;
};
type UpdatePreview = {
  ok: boolean;
  from: string;
  to: string;
  changes: Change[];
  conflicts: number;
  issues: Issue[];
  warnings: string[];
  licenseChanges: {
    subject: string;
    change: string;
    from?: string;
    to?: string;
  }[];
  requiresLicenseAcceptance: boolean;
  diffHash: string;
};

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error: /, "");
const NOT_BUNDLED = "not bundled — install separately";

/** Add inserted groups to the canvas' persisted groups (membership is exclusive). */
export function applyInsertedGroups(
  groups: { name: string; agentIds: string[] }[] | undefined,
  allAgentIds: string[],
) {
  if (!groups?.length) return;
  const ids = [
    ...new Set([...allAgentIds, ...groups.flatMap((g) => g.agentIds)]),
  ];
  let current = sanitizeGroups(saved("groups", []), ids);
  for (const g of groups)
    current = createGroup(
      current,
      g.name,
      g.agentIds,
      "group-" + Math.random().toString(36).slice(2, 10),
    );
  persist("groups", current);
}

export function TeamPacks({
  events,
  agentIds,
  act,
  goCanvas,
}: {
  events: unknown[];
  agentIds: string[];
  act: (fn: () => Promise<unknown>) => Promise<void>;
  goCanvas: () => void;
}) {
  const [library, setLibrary] = useState<PackSummary[]>([]),
    [installed, setInstalled] = useState<Installed[]>([]),
    [dialog, setDialog] = useState<PackRequest | null>(null),
    [updating, setUpdating] = useState<{
      install: Installed;
      request: PackRequest;
    } | null>(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    file = useRef<HTMLInputElement>(null),
    updateFor = useRef<Installed | null>(null);
  useEffect(() => {
    Promise.all([api("/team-packs"), api("/team-packs/installed")])
      .then(([l, i]) => {
        setLibrary(l);
        setInstalled(i);
      })
      .catch((e) => setError(message(e)));
  }, [events.length]);
  async function readManifest(f: File) {
    try {
      return JSON.parse(await f.text());
    } catch {
      throw new Error("The selected file is not valid JSON");
    }
  }
  return (
    <section className="team-packs" aria-label="Team packs">
      <div className="section-title">
        <div>
          <span className="eyebrow">VERSIONED PACKS</span>
          <h2>Team packs</h2>
        </div>
        <div className="row">
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            aria-label="Team pack file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              const target = updateFor.current;
              updateFor.current = null;
              void act(async () => {
                const manifest = await readManifest(f);
                if (target)
                  setUpdating({ install: target, request: { manifest } });
                else setDialog({ manifest });
              });
            }}
          />
          <button
            onClick={() => {
              updateFor.current = null;
              file.current?.click();
            }}
          >
            <Upload size={15} />
            Open pack file…
          </button>
        </div>
      </div>
      <p className="hint">
        A pack bundles a team with its source, licenses, pinned skills and model
        mappings. Previewing writes nothing; installation is all-or-nothing and
        never imports credentials or grants access without your approval.
      </p>
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
      <ul className="team-list pack-list" aria-label="Bundled packs">
        {library.map((p) =>
          "invalid" in p ? (
            <li key={p.packId} className="team-note bad">
              {p.packId}: {p.invalid}
            </li>
          ) : (
            <li key={p.packId} className="pack-item">
              <div>
                <b>{p.name}</b> <span className="badge">v{p.version}</span>{" "}
                {p.status === "skeleton" && (
                  <span className="badge">skeleton</span>
                )}
                <small>
                  {p.agents} agents · {p.bundledSkills} bundled skill
                  {p.bundledSkills === 1 ? "" : "s"} · {p.missingSkills} not
                  bundled · pack license {p.license}
                </small>
                <p>{p.description}</p>
              </div>
              <div className="row team-actions">
                <button onClick={() => setDialog({ packId: p.packId })}>
                  Preview…
                </button>
                {installed
                  .filter(
                    (i) => i.packId === p.packId && i.version !== p.version,
                  )
                  .map((i) => (
                    <button
                      key={i.id}
                      onClick={() =>
                        setUpdating({
                          install: i,
                          request: { packId: p.packId },
                        })
                      }
                    >
                      Review update {i.version} → {p.version}
                    </button>
                  ))}
              </div>
            </li>
          ),
        )}
      </ul>
      <h3>Installed packs</h3>
      {installed.length ? (
        <ul className="team-list pack-list" aria-label="Installed packs">
          {installed.map((i) => (
            <li key={i.id} className="pack-item">
              <div>
                <b>{i.name}</b> <span className="badge">v{i.version}</span>
              </div>
              <button
                onClick={() => {
                  updateFor.current = i;
                  file.current?.click();
                }}
              >
                Update from file…
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No packs installed.</p>
      )}
      {dialog && (
        <PackDialog
          request={dialog}
          agentIds={agentIds}
          close={() => setDialog(null)}
          done={(r) => {
            applyLayout(r.layout);
            applyInsertedGroups(r.groups, agentIds);
            setDialog(null);
            setNotice("Pack installed.");
            goCanvas();
          }}
        />
      )}
      {updating && (
        <UpdateDialog
          agentIds={agentIds}
          install={updating.install}
          request={updating.request}
          close={() => setUpdating(null)}
          done={(r) => {
            applyLayout(r.layout ?? {});
            setUpdating(null);
            setNotice(
              `Updated to ${r.to}. ${r.applied.length} change(s) applied, ${r.keptLocal.length} local customization(s) kept.`,
            );
          }}
        />
      )}
    </section>
  );
}

function PackDialog({
  request,
  agentIds,
  close,
  done,
}: {
  request: PackRequest;
  agentIds: string[];
  close: () => void;
  done: (r: {
    layout: Record<string, Point>;
    groups?: { name: string; agentIds: string[] }[];
  }) => void;
}) {
  const [mapping, setMapping] = useState<Record<string, string>>({}),
    [models, setModels] = useState<Record<string, string>>({}),
    [unknownModels, setUnknownModels] = useState(false),
    [uninstalled, setUninstalled] = useState(false),
    [ack, setAck] = useState(false),
    [dup, setDup] = useState(false),
    [preview, setPreview] = useState<PackPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const body = () => ({
    ...request,
    workspaces: Object.fromEntries(
      Object.entries(mapping).filter(([, v]) => v.trim()),
    ),
    modelMap: Object.fromEntries(
      Object.entries(models).filter(([, v]) => v.trim()),
    ),
    allowUnknownModels: unknownModels,
    allowUninstalledEnvironments: uninstalled,
    allowDuplicate: dup,
    acknowledgeGrants: ack,
  });
  const latest = useRef(0);
  useEffect(() => {
    const run = ++latest.current;
    const timer = setTimeout(() => {
      api("/team-packs/preview", "POST", body())
        .then((p) => {
          if (run === latest.current) {
            setPreview(p);
            setError("");
          }
        })
        .catch((e) => run === latest.current && setError(message(e)));
    }, 200);
    return () => clearTimeout(timer);
  }, [mapping, models, unknownModels, uninstalled, dup]);
  async function install() {
    setBusy(true);
    try {
      done(
        await api("/team-packs/install", "POST", {
          ...body(),
          offset: nextOffset(agentIds),
        }),
      );
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  const nameOf = (key: string) =>
    preview?.changes.agents.find((a) => a.key === key)?.name ?? key;
  const pairs = preview
    ? [
        ...new Set(
          preview.changes.agents.map((a) => `${a.environment}:${a.model}`),
        ),
      ]
    : [];
  return (
    <Modal
      title={preview ? `Pack “${preview.pack.name}”` : "Team pack"}
      eyebrow="TEAM PACK"
      close={close}
      footer={
        <>
          <span className="hint">
            {preview
              ? `${preview.changes.agents.length} agents · ${preview.changes.edges} connections · ${preview.changes.rules} rules`
              : "Checking…"}
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={
                !preview?.ok ||
                busy ||
                (preview.requiresGrantAcknowledgement && !ack)
              }
              onClick={() => void install()}
            >
              Install pack
            </button>
          </div>
        </>
      }
    >
      {error && (
        <div className="team-note bad" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <>
          <p className="hint">
            v{preview.pack.version} · {preview.pack.status} · from{" "}
            {preview.pack.source.name} · pack license{" "}
            {preview.pack.source.license}
          </p>
          {preview.pack.description && <p>{preview.pack.description}</p>}
          {preview.pack.limitations.length > 0 && (
            <div className="team-note warn" data-testid="pack-limitations">
              <b>What is missing or not validated</b>
              <ul>
                {preview.pack.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          <h3>Compatibility</h3>
          <ul data-testid="pack-harnesses">
            {preview.harnesses.map((h) => (
              <li key={h.environment}>
                <b>{h.environment}</b>: {h.support}
                {h.installed === null
                  ? ""
                  : h.installed
                    ? " · detected"
                    : " · not detected here"}
                {h.usedBy.length ? ` · used by ${h.usedBy.join(", ")}` : ""}
              </li>
            ))}
          </ul>
          <h3>Skills and licenses</h3>
          <ul data-testid="pack-skills">
            {preview.skills.map((s) => (
              <li key={s.name}>
                {s.bundled ? (
                  <>
                    <b>{s.name}</b> · {s.license} · pinned{" "}
                    {s.revision?.slice(0, 12)} ·{" "}
                    {s.status === "ok"
                      ? "license text retained"
                      : "license check failed"}
                    {s.installedHere ? "" : " · not installed here"}
                  </>
                ) : (
                  <>
                    <b>{s.name}</b> · {NOT_BUNDLED}
                    <small>{s.purpose}</small>
                  </>
                )}
              </li>
            ))}
          </ul>
          <h3>Folders</h3>
          <div className="team-slots">
            {preview.workspaceSlots.map((s) => {
              const id = `${s.agentKey}/${s.slot}`;
              return (
                <div className="team-slot" key={id}>
                  <div>
                    <b>{nameOf(s.agentKey)}</b>
                    <small>
                      {s.label || s.slot} ·{" "}
                      {s.access === "write" ? "read & write" : "read only"}
                    </small>
                  </div>
                  <input
                    aria-label={`Folder for ${nameOf(s.agentKey)} ${s.label || s.slot}`}
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
              );
            })}
          </div>
          <h3>Models</h3>
          <p className="hint">
            The pack pins no model. Leave a replacement empty to keep the
            harness default.
          </p>
          <div className="team-slots">
            {pairs.map((pair) => (
              <div className="team-slot models" key={pair}>
                <div>
                  <b>{pair.split(":")[0]}</b>
                  <small>
                    template model: {pair.slice(pair.indexOf(":") + 1)}
                    {preview.modelMappings.find(
                      (m) => `${m.environment}:${m.templateModel}` === pair,
                    )?.preferredModel
                      ? ` · suggested ${preview.modelMappings.find((m) => `${m.environment}:${m.templateModel}` === pair)!.preferredModel}`
                      : ""}
                  </small>
                </div>
                <input
                  aria-label={`Replacement model for ${pair}`}
                  placeholder="Keep as is"
                  value={models[pair] ?? ""}
                  onChange={(e) =>
                    setModels({ ...models, [pair]: e.target.value })
                  }
                />
              </div>
            ))}
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
          <h3>Installation changes</h3>
          <ul data-testid="pack-changes">
            {preview.changes.agents.map((a) => (
              <li key={a.key}>
                Adds agent <b>{a.name}</b> ({a.environment}
                {a.skills.length ? `, skills: ${a.skills.join(", ")}` : ""})
              </li>
            ))}
            <li>
              {preview.changes.edges} connection(s), {preview.changes.rules}{" "}
              rule(s)
              {preview.changes.groups.length
                ? `, group ${preview.changes.groups.join(", ")}`
                : ""}
            </li>
            {preview.changes.records.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <h3>Access this pack grants</h3>
          {preview.grants.length ? (
            <div className="team-note warn" data-testid="pack-grants">
              <ul>
                {preview.grants.map((g, i) => (
                  <li key={i}>{g.description}</li>
                ))}
              </ul>
              <label className="inline team-check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <span>I have reviewed and accept these grants</span>
              </label>
            </div>
          ) : (
            <p className="hint">None.</p>
          )}
          {preview.issues.some((i) => i.code === "pack_already_installed") && (
            <label className="inline team-check">
              <input
                type="checkbox"
                checked={dup}
                onChange={(e) => setDup(e.target.checked)}
              />
              <span>Install a second copy anyway</span>
            </label>
          )}
          {preview.issues.length ? (
            <div className="team-note bad" data-testid="pack-issues">
              <b>Fix before installing ({preview.issues.length})</b>
              <ul>
                {preview.issues.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="team-note ok">No blocking issues.</div>
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
          {preview.pack.notices.length > 0 && (
            <details>
              <summary>Retained upstream notices</summary>
              <ul>
                {preview.pack.notices.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Modal>
  );
}

function UpdateDialog({
  agentIds,
  install,
  request,
  close,
  done,
}: {
  agentIds: string[];
  install: Installed;
  request: PackRequest;
  close: () => void;
  done: (r: {
    to: string;
    applied: string[];
    keptLocal: string[];
    layout?: Record<string, Point>;
  }) => void;
}) {
  const [preview, setPreview] = useState<UpdatePreview | null>(null),
    [resolutions, setResolutions] = useState<
      Record<string, "keep-local" | "take-pack">
    >({}),
    [license, setLicense] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/team-packs/installed/${install.id}/update-preview`, "POST", request)
      .then(setPreview)
      .catch((e) => setError(message(e)));
  }, []);
  const conflicts =
    preview?.changes.filter((c) => c.status === "conflict") ?? [];
  const ready =
    preview?.ok &&
    conflicts.every((c) => resolutions[c.id]) &&
    (!preview.requiresLicenseAcceptance || license);
  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      done(
        await api(`/team-packs/installed/${install.id}/update`, "POST", {
          ...request,
          diffHash: preview.diffHash,
          resolutions,
          acceptLicenseChanges: license,
          offset: nextOffset(agentIds),
        }),
      );
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }
  const row = (c: Change) => (
    <li key={c.id}>
      <b>{c.label}</b> {c.field ? `· ${c.field}` : `· ${c.action}`}
      {c.reason ? ` · ${c.reason}` : ""}
      {(c.old !== undefined || c.new !== undefined) && (
        <div className="pack-diff">
          <div>
            <small>Installed pack</small>
            <pre>{c.old}</pre>
          </div>
          <div>
            <small>New pack</small>
            <pre>{c.new}</pre>
          </div>
          <div>
            <small>Your configuration</small>
            <pre>{c.local}</pre>
          </div>
        </div>
      )}
    </li>
  );
  return (
    <Modal
      title={`Update “${install.name}”`}
      eyebrow="PACK UPDATE"
      close={close}
      footer={
        <>
          <span className="hint">
            {preview ? `${install.version} → ${preview.to}` : "Comparing…"}
          </span>
          <div className="row">
            <button onClick={close}>Cancel</button>
            <button
              className="primary"
              disabled={!ready || busy}
              onClick={() => void apply()}
            >
              Apply update
            </button>
          </div>
        </>
      }
    >
      {error && (
        <div className="team-note bad" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <>
          <p className="hint">
            Nothing is written until you apply. Fields you changed yourself are
            never overwritten unless you choose the pack value for a conflict.
          </p>
          {preview.licenseChanges.length > 0 && (
            <div className="team-note warn" data-testid="update-licenses">
              <b>License and pin changes</b>
              <ul>
                {preview.licenseChanges.map((c, i) => (
                  <li key={i}>
                    {c.subject}: {c.change}
                    {c.from || c.to
                      ? ` (${c.from ?? "—"} → ${c.to ?? "—"})`
                      : ""}
                  </li>
                ))}
              </ul>
              {preview.requiresLicenseAcceptance && (
                <label className="inline team-check">
                  <input
                    type="checkbox"
                    checked={license}
                    onChange={(e) => setLicense(e.target.checked)}
                  />
                  <span>
                    I have reviewed these license and revision changes
                  </span>
                </label>
              )}
            </div>
          )}
          <h3>Conflicts ({conflicts.length})</h3>
          {conflicts.length ? (
            <ul data-testid="update-conflicts">
              {conflicts.map((c) => (
                <li key={c.id}>
                  {row(c)}
                  <div className="row">
                    {(["keep-local", "take-pack"] as const).map((r) => (
                      <label key={r} className="inline">
                        <input
                          type="radio"
                          name={`res-${c.id}`}
                          checked={resolutions[c.id] === r}
                          onChange={() =>
                            setResolutions({ ...resolutions, [c.id]: r })
                          }
                        />
                        <span>
                          {r === "keep-local"
                            ? "Keep my version"
                            : "Take the pack's version"}{" "}
                          ({c.label}
                          {c.field ? ` ${c.field}` : ""})
                        </span>
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">None.</p>
          )}
          <h3>Applied automatically (you never changed these)</h3>
          <ul data-testid="update-applied">
            {preview.changes.filter((c) => c.status === "apply").map(row)}
          </ul>
          <h3>Your customizations kept</h3>
          <ul data-testid="update-kept">
            {preview.changes.filter((c) => c.status === "keep-local").map(row)}
          </ul>
          {preview.issues.length > 0 && (
            <div className="team-note bad">
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
        </>
      )}
    </Modal>
  );
}
