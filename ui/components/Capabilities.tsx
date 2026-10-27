import { useCallback, useEffect, useState } from "react";
import { api, type Agent, type Snapshot } from "../api";
import { ContextCost } from "./ContextCost";
import { agentSelectorLabel } from "../agent-identity";
import "./capabilities.css";

/** Encodes every character the desktop IPC path filter rejects (".", "_") as well as reserved ones. */
const enc = (v: string) =>
  encodeURIComponent(v).replace(/\./g, "%2E").replace(/_/g, "%5F");

type Props = {
  data: Snapshot;
  selected: string;
  setSelected: (id: string) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
};
const TABS = [
  ["skills", "Skills"],
  ["tools", "Tools"],
  ["knowledge", "Knowledge"],
  ["effective", "Effective instructions"],
] as const;
type Tab = (typeof TABS)[number][0];
const tokens = (n: number) => `~${n.toLocaleString()} tokens`;

export function Capabilities(p: Props) {
  const [tab, setTab] = useState<Tab>("skills");
  const agent: Agent | undefined = p.data.agents.find(
    (a) => a.id === p.selected,
  );
  return (
    <div className="scroll section cap" data-testid="capabilities">
      <div className="section-title">
        <div>
          <span className="eyebrow">CAPABILITIES</span>
          <h2>Skills, tools and knowledge</h2>
        </div>
        <select
          aria-label="Agent"
          value={p.selected}
          onChange={(e) => p.setSelected(e.target.value)}
        >
          {p.data.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {agentSelectorLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="cap-kinds" data-testid="cap-kinds">
        <div className="cap-kind kind-skill">
          <b>Skills</b>
          <span className="badge">instructions</span>
          <p>
            Text the model reads. Loaded into the prompt; never grants access.
          </p>
        </div>
        <div className="cap-kind kind-tool">
          <b>Tools</b>
          <span className="badge">actions</span>
          <p>Things an agent may do (MCP servers). Granted per agent.</p>
        </div>
        <div className="cap-kind kind-knowledge">
          <b>Knowledge</b>
          <span className="badge">reference</span>
          <p>
            Cited passages from attached folders. Untrusted data, never
            instructions.
          </p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "skills" && <SkillsTab act={p.act} />}
      {tab === "tools" && <ToolsTab act={p.act} agent={agent} />}
      {tab === "knowledge" && <KnowledgeTab act={p.act} agent={agent} />}
      {tab === "effective" && (
        <EffectiveTab
          agent={agent}
          tasks={p.data.workflows
            .flatMap((w) => w.tasks)
            .filter((t) => t.agentId === agent?.id)}
        />
      )}
    </div>
  );
}

function SkillsTab({ act }: { act: Props["act"] }) {
  const [adapters, setAdapters] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);
  const [changes, setChanges] = useState<any>(null);
  const load = useCallback(async () => {
    setAdapters((await api("/capabilities/skills/adapters")).adapters);
    setChanges(await api("/capabilities/skills/changes"));
  }, []);
  useEffect(() => {
    void act(load);
  }, []);
  return (
    <div className="cap-body">
      <h3>Always load vs. on demand, per adapter</h3>
      <p className="hint">
        Always load: full text in every run. On demand: AgentTeam adds the full
        text for a run only when the request matches the skill (trigger phrases,
        name, description); otherwise only name and description are listed.
        Model-initiated loading depends on the adapter.
      </p>
      <table className="cap-table" data-testid="adapter-table">
        <thead>
          <tr>
            <th>Adapter</th>
            <th>Always load</th>
            <th>On demand</th>
            <th>Model reads skill files itself</th>
          </tr>
        </thead>
        <tbody>
          {adapters.map((a) => (
            <tr key={a.id} data-testid={"adapter-" + a.id}>
              <td>{a.label}</td>
              <td>{a.always}</td>
              <td>{a.onDemand}</td>
              <td>
                <span
                  className={
                    "badge " + (a.modelRead === "unsupported" ? "bad" : "")
                  }
                >
                  {a.modelRead === "unsupported"
                    ? "unsupported"
                    : "possible, unverified"}
                </span>{" "}
                {a.modelReadNote}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row between">
        <h3>Catalog validation</h3>
        <button
          onClick={() =>
            void act(async () =>
              setReport(
                await api("/capabilities/skills/validation", "POST", {}),
              ),
            )
          }
        >
          Validate and record audit event
        </button>
      </div>
      {report && (
        <div data-testid="validation-report">
          <p>
            <span className={"badge " + (report.ok ? "ok" : "bad")}>
              {report.ok ? "no errors" : "errors found"}
            </span>{" "}
            {report.counts.skills} bundled skills · {report.counts.errors}{" "}
            errors · {report.counts.warnings} warnings · {report.counts.infos}{" "}
            notes · curated {report.curatedOn ?? "unknown"}
          </p>
          <ul className="cap-list">
            {report.environments.map((e: any) => (
              <li key={e.environment}>
                <b>{e.environment}</b>: {e.skills} skills. {e.toolNote}
              </li>
            ))}
          </ul>
          <details>
            <summary>Upstream revision and license per skill</summary>
            <table className="cap-table" data-testid="validation-skills">
              <tbody>
                {report.skills.map((k: any) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>{k.version ?? "no version"}</td>
                    <td>{k.commit ? k.commit.slice(0, 10) : "no revision"}</td>
                    <td>{k.license ?? "no license"}</td>
                    <td>{k.environments.join(", ")}</td>
                    <td>
                      {k.hashOk === null
                        ? "hash unchecked"
                        : k.hashOk
                          ? "hash ok"
                          : "HASH DRIFT"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
          {report.findings.length > 0 && (
            <ul className="cap-list" data-testid="validation-findings">
              {report.findings.map((f: any, i: number) => (
                <li key={i}>
                  <span
                    className={"badge " + (f.severity === "error" ? "bad" : "")}
                  >
                    {f.severity}
                  </span>{" "}
                  <code>{f.code}</code> {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="row between">
        <h3>Skill changes</h3>
        <button title="Recheck" onClick={() => void act(load)}>
          Recheck
        </button>
      </div>
      <p className="hint">
        A skill you use is pinned the first time it runs. If its text later
        changes it is left out of runs until you accept the update.
      </p>
      {changes && (
        <ul className="cap-list" data-testid="skill-changes">
          {changes.rows.map((r: any) => (
            <li key={r.id} data-testid="skill-change-row">
              <div className="row between">
                <span>
                  <b>{r.name}</b>{" "}
                  <span
                    className={
                      "badge " + (r.status === "unchanged" ? "ok" : "bad")
                    }
                  >
                    {r.status}
                  </span>
                  {r.assignedTo.length > 0 && (
                    <small>
                      {" "}
                      used by{" "}
                      {r.assignedTo
                        .map((a: any) => a.agent + " (" + a.mode + ")")
                        .join(", ")}
                    </small>
                  )}
                </span>
                {(r.status === "changed" || r.status === "unpinned") && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api("/capabilities/skills/accept", "POST", {
                          ids: [r.id],
                        });
                        await load();
                      })
                    }
                  >
                    {r.status === "changed"
                      ? "Accept update"
                      : "Accept and pin"}
                  </button>
                )}
              </div>
              {r.note && <p className="hint">{r.note}</p>}
              {r.change?.available && (
                <details>
                  <summary>
                    +{r.change.added} / -{r.change.removed} lines
                  </summary>
                  <pre>{r.change.preview.join("\n")}</pre>
                </details>
              )}
            </li>
          ))}
          {!changes.rows.length && (
            <li className="hint">No skills assigned or pinned yet.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function ToolsTab({ act, agent }: { act: Props["act"]; agent?: Agent }) {
  const [servers, setServers] = useState<any[]>([]);
  const [grants, setGrants] = useState<any>({ grants: [], exposure: "" });
  const [form, setForm] = useState({
    name: "",
    command: "",
    args: "",
    env: "",
  });
  const [limit, setLimit] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    setServers((await api("/tools/servers")).servers);
    if (agent) setGrants(await api(`/agents/${agent.id}/tool-grants`));
  }, [agent?.id]);
  useEffect(() => {
    void act(load);
  }, [agent?.id]);
  const granted = (id: string) =>
    grants.grants.find((g: any) => g.serverId === id);
  return (
    <div className="cap-body">
      <p className="hint">
        Authentication is configured as environment-variable references only;
        AgentTeam never stores the secret itself. Test connection starts the
        server and asks for its tool list; it never calls a tool.
      </p>
      <form
        className="cap-form"
        data-testid="tool-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api("/tools/servers", "POST", {
              name: form.name,
              command: form.command,
              args: form.args
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              envRefs: form.env
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
                .map((l) => {
                  const [name, fromEnv] = l.split("=").map((x) => x.trim());
                  return { name, fromEnv: fromEnv || name };
                }),
            });
            setForm({ name: "", command: "", args: "", env: "" });
            await load();
          });
        }}
      >
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Command
          <input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
          />
        </label>
        <label>
          Arguments (one per line)
          <textarea
            rows={2}
            value={form.args}
            onChange={(e) => setForm({ ...form, args: e.target.value })}
          />
        </label>
        <label>
          Environment references (NAME=HOST_VARIABLE, one per line)
          <textarea
            rows={2}
            value={form.env}
            onChange={(e) => setForm({ ...form, env: e.target.value })}
          />
        </label>
        <button type="submit" disabled={!form.name || !form.command}>
          Add tool server
        </button>
      </form>
      {agent && (
        <p className="hint" data-testid="grant-exposure">
          {grants.exposure}
        </p>
      )}
      <ul className="cap-list" data-testid="tool-servers">
        {servers.map((s) => {
          const g = granted(s.id);
          return (
            <li key={s.id} data-testid="tool-server">
              <div className="row between">
                <span>
                  <b>{s.name}</b>{" "}
                  <span
                    className={
                      "badge " +
                      (s.connection.state === "connected"
                        ? "ok"
                        : s.connection.state === "failed"
                          ? "bad"
                          : "")
                    }
                    data-testid="connection-state"
                  >
                    {s.connection.state}
                  </span>
                </span>
                <span className="row">
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api(`/tools/servers/${s.id}/test`, "POST", {});
                        await load();
                      })
                    }
                  >
                    Test connection
                  </button>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await api(`/tools/servers/${s.id}`, "DELETE");
                        await load();
                      })
                    }
                  >
                    Remove
                  </button>
                </span>
              </div>
              <small>
                <code>{[s.command, ...s.args].join(" ")}</code>
              </small>
              {s.envRefs.length > 0 && (
                <small>
                  {" "}
                  auth:{" "}
                  {s.envRefs
                    .map(
                      (r: any) =>
                        `${r.name} ← $${r.fromEnv} (${r.set ? "set" : "not set"})`,
                    )
                    .join(", ")}
                </small>
              )}
              {s.connection.error && (
                <p className="hint bad-text">{s.connection.error}</p>
              )}
              {s.connection.state === "connected" && (
                <p className="hint">
                  {s.connection.serverInfo?.name}{" "}
                  {s.connection.serverInfo?.version} advertises{" "}
                  {s.connection.toolCount} tools:{" "}
                  {s.connection.tools.map((t: any) => t.name).join(", ")}
                </p>
              )}
              {agent && (
                <div className="row">
                  {g ? (
                    <>
                      <span className="badge ok">
                        granted to {agent.name}
                        {g.allowedTools
                          ? ` (${g.allowedTools.join(", ")})`
                          : " (all tools)"}
                      </span>
                      <button
                        onClick={() =>
                          void act(async () => {
                            await api(
                              `/agents/${agent.id}/tool-grants/${s.id}`,
                              "DELETE",
                            );
                            await load();
                          })
                        }
                      >
                        Revoke
                      </button>
                    </>
                  ) : (
                    <>
                      <input
                        aria-label={"Allowed tools for " + s.name}
                        placeholder="all tools, or comma-separated names"
                        value={limit[s.id] ?? ""}
                        onChange={(e) =>
                          setLimit({ ...limit, [s.id]: e.target.value })
                        }
                      />
                      <button
                        onClick={() =>
                          void act(async () => {
                            const names = (limit[s.id] ?? "")
                              .split(",")
                              .map((x) => x.trim())
                              .filter(Boolean);
                            await api(
                              `/agents/${agent.id}/tool-grants`,
                              "PUT",
                              {
                                serverId: s.id,
                                allowedTools: names.length ? names : null,
                              },
                            );
                            await load();
                          })
                        }
                      >
                        Grant to {agent.name}
                      </button>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {!servers.length && (
          <li className="hint">No tool servers registered.</li>
        )}
      </ul>
    </div>
  );
}

function KnowledgeTab({ act, agent }: { act: Props["act"]; agent?: Agent }) {
  const [sources, setSources] = useState<any[]>([]);
  const [form, setForm] = useState({
    name: "",
    folder: "",
    scope: "agent",
    include: false,
  });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any>(null);
  const load = useCallback(async () => {
    if (agent) setSources((await api(`/agents/${agent.id}/knowledge`)).sources);
  }, [agent?.id]);
  useEffect(() => {
    setResults(null);
    void act(load);
  }, [agent?.id]);
  if (!agent) return <p className="hint">Create an agent first.</p>;
  return (
    <div className="cap-body">
      <p className="hint">
        Sources must be inside a folder attached to the agent. Indexing is a
        local, bounded text index (no uploads, no embeddings); symlinks, hidden
        files and secret-looking files are skipped. Passages are untrusted
        reference data.
      </p>
      <form
        className="cap-form"
        data-testid="knowledge-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api(`/agents/${agent.id}/knowledge`, "POST", form);
            setForm({ ...form, name: "" });
            await load();
          });
        }}
      >
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label>
          Folder (inside an attached folder)
          <select
            value={form.folder}
            onChange={(e) => setForm({ ...form, folder: e.target.value })}
          >
            <option value="">Choose…</option>
            {agent.workspaces.map((w) => (
              <option key={w.path} value={w.path}>
                {w.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          Shared with
          <select
            value={form.scope}
            onChange={(e) => setForm({ ...form, scope: e.target.value })}
          >
            <option value="agent">This agent only</option>
            <option value="project">Any agent with this folder attached</option>
          </select>
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={form.include}
            onChange={(e) => setForm({ ...form, include: e.target.checked })}
          />
          Add relevant cited passages to this agent&apos;s runs
        </label>
        <button type="submit" disabled={!form.name || !form.folder}>
          Add and index
        </button>
      </form>
      <ul className="cap-list" data-testid="knowledge-sources">
        {sources.map((s) => (
          <li key={s.id} data-testid="knowledge-source">
            <div className="row between">
              <span>
                <b>{s.name}</b>{" "}
                <span
                  className={
                    "badge " +
                    (s.status === "ready"
                      ? "ok"
                      : s.status === "failed"
                        ? "bad"
                        : "")
                  }
                  data-testid="index-status"
                >
                  {s.status}
                </span>{" "}
                <small>
                  {s.scope.kind === "agent" ? "agent" : "project"}
                  {s.include ? " · included in runs" : ""}
                </small>
              </span>
              <span className="row">
                <button
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `/knowledge/sources/${s.id}/refresh`,
                        "POST",
                        {},
                      );
                      await load();
                    })
                  }
                >
                  Refresh
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      await api(`/knowledge/sources/${s.id}`, "DELETE");
                      await load();
                    })
                  }
                >
                  Remove
                </button>
              </span>
            </div>
            <small>
              <code>{s.folder}</code> · {s.files} files · {s.chunks} passages ·{" "}
              {Math.round(s.bytes / 1024)} KB
              {s.truncated ? " · truncated at size limits" : ""}
              {s.indexedAt
                ? " · indexed " + new Date(s.indexedAt).toLocaleString()
                : ""}
            </small>
            {!s.access.ok && (
              <p className="hint bad-text">Access denied: {s.access.reason}</p>
            )}
            {s.error && <p className="hint bad-text">{s.error}</p>}
          </li>
        ))}
        {!sources.length && (
          <li className="hint">No knowledge sources for this agent.</li>
        )}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () =>
            setResults(
              await api(`/agents/${agent.id}/knowledge/search?q=${enc(query)}`),
            ),
          );
        }}
      >
        <input
          aria-label="Search knowledge"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indexed passages…"
        />
        <button type="submit" disabled={!query.trim()}>
          Search
        </button>
      </form>
      {results && (
        <ul className="cap-list" data-testid="knowledge-results">
          {results.results.map((r: any, i: number) => (
            <li key={i} data-testid="citation">
              <b>{r.label}</b>{" "}
              {r.stale && (
                <span className="badge bad">file changed since indexing</span>
              )}
              <pre>{r.snippet}</pre>
            </li>
          ))}
          {!results.results.length && (
            <li className="hint">No matching passages.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function EffectiveTab({
  agent,
  tasks,
}: {
  agent?: Agent;
  tasks: Snapshot["workflows"][number]["tasks"];
}) {
  const [prompt, setPrompt] = useState("");
  const [taskId, setTaskId] = useState("");
  const [view, setView] = useState<any>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!agent) return;
    try {
      setError("");
      setView(
        await api(
          `/agents/${agent.id}/effective-instructions${taskId || prompt.trim() ? "?" + [taskId ? "taskId=" + enc(taskId) : "", prompt.trim() ? "prompt=" + enc(prompt) : ""].filter(Boolean).join("&") : ""}`,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to build the preview");
    }
  }, [agent?.id, prompt, taskId]);
  useEffect(() => {
    setTaskId("");
  }, [agent?.id]);
  useEffect(() => {
    void load();
  }, [agent?.id, taskId]);
  if (!agent) return <p className="hint">Create an agent first.</p>;
  return (
    <div className="cap-body" data-testid="effective">
      <p className="hint">
        What a run of this agent receives: role, persistent instructions, loaded
        skills and tool requirements. Type a sample request to see which
        on-demand skills it would load.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          Task context
          <select
            aria-label="Preview task"
            value={taskId}
            onChange={(e) => setTaskId(e.target.value)}
          >
            <option value="">Agent defaults</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <input
          aria-label="Sample request"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Sample request (optional)"
        />
        <button type="submit">Preview</button>
      </form>
      {error && <p className="hint bad-text">{error}</p>}
      <ContextCost agentId={agent.id} />
      {view && (
        <>
          {view.capabilities && (
            <section
              className="project-setup-card"
              aria-label="Effective run capabilities"
              data-testid="effective-run-capabilities"
            >
              <h4>
                {view.task
                  ? `Capabilities for ${view.task.title}`
                  : "Capabilities from agent defaults"}
              </h4>
              <p>{view.capabilities.line}</p>
              {Object.entries(view.capabilities.gaps ?? {}).map(
                ([capability, gap]) =>
                  gap && (
                    <p className="quiet" key={capability}>
                      {(gap as { message?: string }).message}
                    </p>
                  ),
              )}
              {view.capabilities.readiness?.message && (
                <p>{view.capabilities.readiness.message}</p>
              )}
            </section>
          )}
          <p>
            <b>{view.adapter.label}</b> · {tokens(view.totals.approxTokens)} of
            instructions ({tokens(view.totals.skillTokens)} from skills).{" "}
            {view.totals.note}
          </p>
          {view.problems.map((pr: any, i: number) => (
            <p key={i} className="hint bad-text">
              {pr.message}
            </p>
          ))}
          <h3>Sections</h3>
          <ol className="cap-list" data-testid="effective-sections">
            {view.sections.map((s: any, i: number) => (
              <li key={i}>
                <b>{s.title}</b> <small>{tokens(s.approxTokens)}</small>
                <details>
                  <summary>Show text</summary>
                  <pre>
                    {s.text.length > 4000
                      ? s.text.slice(0, 4000) + "\n… (preview cut)"
                      : s.text}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
          <h3>Skills</h3>
          <ul className="cap-list" data-testid="effective-skills">
            {view.skills.map((s: any) => (
              <li key={s.id}>
                <b>{s.name}</b> {s.version && <small>v{s.version}</small>}{" "}
                <span
                  className={
                    "badge " +
                    (s.state === "skipped"
                      ? "bad"
                      : s.state === "loaded"
                        ? "ok"
                        : "")
                  }
                >
                  {s.state}
                </span>{" "}
                <small>
                  {s.mode === "always" ? "always load" : "on demand"} ·{" "}
                  {tokens(s.approxTokens)} (full {tokens(s.fullTokens)}) ·{" "}
                  {s.origin}
                  {s.revision
                    ? " · upstream " + s.revision.slice(0, 8)
                    : ""} · {s.hash.slice(0, 10)}
                </small>
                <p className="hint">{s.reason}</p>
              </li>
            ))}
            {!view.skills.length && (
              <li className="hint">No skills assigned.</li>
            )}
          </ul>
          <p className="hint">{view.adapter.modelReadNote}</p>
          <h3>Tool requirements</h3>
          <ul className="cap-list" data-testid="effective-tools">
            {view.tools.requirements.map((r: any, i: number) => (
              <li key={i}>
                <code>{r.tool}</code> required by {r.skill}:{" "}
                <span className={"badge " + (r.listedByAgent ? "ok" : "bad")}>
                  {r.listedByAgent
                    ? "listed by agent"
                    : "not listed (run would fail)"}
                </span>
              </li>
            ))}
            {!view.tools.requirements.length && (
              <li className="hint">No skill requires a tool.</li>
            )}
            <li className="hint">
              Agent tools: {view.tools.listed.join(", ") || "none"}.{" "}
              {view.adapter.toolExposure}
            </li>
            {view.tools.grants.map((g: any) => (
              <li key={g.id}>
                MCP grant: {g.server} ({g.state}). {view.adapter.grantExposure}
              </li>
            ))}
          </ul>
          <h3>Knowledge</h3>
          <ul className="cap-list">
            {view.knowledge.sources.map((s: any) => (
              <li key={s.id}>
                {s.name}: {s.status}
                {s.include ? ", included in runs" : ", search only"}
                {!s.access.ok ? ` (access denied: ${s.access.reason})` : ""}
              </li>
            ))}
            {view.knowledge.citations.map((c: any, i: number) => (
              <li key={i}>
                Would cite [{c.label}] {c.stale ? "(stale)" : ""}
              </li>
            ))}
            {!view.knowledge.sources.length && (
              <li className="hint">No knowledge sources.</li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
