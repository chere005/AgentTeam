import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api";
import { requestArrange } from "../arrange-request";
import { agentDisplayName } from "../agent-identity";
import type { PaneProps } from "./Panes";
import "./team-settings.css";

/**
 * Team settings (feature tab, also from the team switcher menu): the active TEAM's project
 * profile after insert. Worker counts add or remove worker agents following the role preset and
 * org tree (src/team-settings.ts); existing projects keep their agents, projects assigned later
 * use the new counts. Name and description use the team container route.
 */
type Brief = {
  id: string;
  name: string;
  model?: string;
  environment?: string;
  effort?: string | null;
  missing?: boolean;
};
type Check = {
  verified: boolean;
  checkedAt: string | null;
  issues: string[];
  warnings: string[];
};
type View = {
  team: { id: string; name: string; description: string };
  hasProfile: boolean;
  projectType: string;
  projectLabel: string;
  source: { template: string; example?: string } | null;
  lead: Brief | null;
  roles: {
    role: string;
    label: string;
    agents: Brief[];
    count: number;
    countable?: { label: string; min: number; max: number };
  }[];
  retired: { agentId: string; role: string; name: string }[];
  workspaceAccess: {
    label: string;
    derived: boolean;
    agents: (Brief & { access: "read" | "write" })[];
  };
  expectations: (Brief & {
    expectation: {
      label: string;
      family: string;
      version: string;
      effort?: string;
    };
  })[];
  modelCheck: Check | null;
  projects: { id: string; name: string; paused: boolean; state: string }[];
  pausedPipelines: {
    id: string;
    name: string;
    verification: { state: string; reasons: string[] };
  }[];
};

const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^.*?Error: /, "");
const TYPE_NAME: Record<string, string> = {
  pipeline: "Pipeline team",
  "wolfram-validated": "Wolfram-validated team",
  "free-form": "Free-form team",
};

export function TeamSettings(p: PaneProps) {
  const teamId = p.data.activeTeamId ?? "main";
  const [view, setView] = useState<View | null>(null),
    [counts, setCounts] = useState<Record<string, number>>({}),
    [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [check, setCheck] = useState<Check | null>(null),
    [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const v: View = await api(`/team-spaces/${teamId}/settings`);
      setView(v);
      setCounts(
        Object.fromEntries(
          v.roles.filter((r) => r.countable).map((r) => [r.role, r.count]),
        ),
      );
      setName(v.team.name);
      setDescription(v.team.description);
    } catch (e) {
      setError(message(e));
    }
  };
  useEffect(() => {
    setView(null);
    setCheck(null);
    setNotice("");
    setError("");
    void load();
  }, [teamId]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  if (!view)
    return (
      <div className="scroll section team-settings">
        <h2>Team settings</h2>
        {error ? (
          <p className="err" role="alert">
            {error}
          </p>
        ) : (
          <p className="quiet">Loading…</p>
        )}
      </div>
    );
  const countable = view.roles.filter((r) => r.countable);
  const changed = countable.some((r) => counts[r.role] !== r.count);
  const modelCheck = check ?? view.modelCheck;
  return (
    <div className="scroll section team-settings" data-testid="team-settings">
      <div className="section-title">
        <div>
          <span className="eyebrow">TEAM SETUP</span>
          <h2>Team settings</h2>
        </div>
      </div>
      <p className="hint">
        Set this team’s defaults. Existing projects keep their agents; new
        projects use updated worker counts.
      </p>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="settings-card">
        <h3>Name and description</h3>
        <label>
          Team name
          <input
            aria-label="Team name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Description
          <textarea
            aria-label="Team description"
            rows={2}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            disabled={
              busy ||
              !name.trim() ||
              (name === view.team.name && description === view.team.description)
            }
            onClick={() =>
              run(async () => {
                await p.act(() =>
                  api(`/team-spaces/${teamId}`, "PUT", {
                    name: name.trim(),
                    description,
                  }),
                );
                await load();
                setNotice("Saved the team name and description.");
              })
            }
          >
            Save name and description
          </button>
        </div>
      </section>

      <section className="settings-card" aria-label="Project profile">
        <h3>Project profile</h3>
        {view.hasProfile ? (
          <dl className="ts-facts">
            <dt>Type</dt>
            <dd data-testid="team-settings-type">
              {TYPE_NAME[view.projectType] ?? view.projectType}
            </dd>
            <dt>Takes projects</dt>
            <dd>{view.projectLabel}</dd>
            <dt>Lead</dt>
            <dd>{view.lead?.name ?? "—"}</dd>
            {view.source && (
              <>
                <dt>From</dt>
                <dd>{view.source.template}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="quiet">
            This team has no project profile (a hand-built team or Main). It
            takes free-form projects: a goal, a workspace and an optional task
            list. Insert an example team for staged pipeline or
            Wolfram-validated projects.
          </p>
        )}
      </section>

      {view.roles.length > 0 && (
        <section className="settings-card" aria-label="Roles and workers">
          <h3>Roles and workers</h3>
          <table className="ts-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Agents</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {view.roles.map((r) => (
                <tr key={r.role}>
                  <td>{r.label}</td>
                  <td>
                    {r.agents.map((a) => (
                      <div key={a.id} className={a.missing ? "bad" : ""}>
                        {agentDisplayName(a)}
                        {a.model && (
                          <small className="quiet"> · {a.model}</small>
                        )}
                      </div>
                    ))}
                  </td>
                  <td>
                    {r.countable ? (
                      <select
                        aria-label={`${r.countable.label} count`}
                        value={counts[r.role] ?? r.count}
                        onChange={(e) =>
                          setCounts({
                            ...counts,
                            [r.role]: Number(e.target.value),
                          })
                        }
                      >
                        {Array.from(
                          { length: r.countable.max - r.countable.min + 1 },
                          (_, i) => r.countable!.min + i,
                        ).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    ) : (
                      r.count
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {countable.length > 0 ? (
            <>
              <p className="quiet">
                New workers copy this role’s model and setup. Workers with
                unfinished work cannot be removed; workers used by projects are
                retired to preserve history.
              </p>
              <div className="row">
                <button
                  className="primary"
                  disabled={busy || !changed}
                  onClick={() =>
                    run(async () => {
                      const r = await api(
                        `/team-spaces/${teamId}/settings/workers`,
                        "PUT",
                        { counts },
                      );
                      const grown = [...r.added, ...r.reinstated];
                      // Re-arrange the whole team as an org chart once the new agents
                      // appear (their parents' rows are re-centred too).
                      if (grown.length)
                        requestArrange(teamId, [
                          ...p.data.agents
                            .filter(
                              (a) =>
                                a.kind !== "team-assistant" &&
                                !r.deleted.includes(a.id),
                            )
                            .map((a) => a.id),
                          ...grown,
                        ]);
                      await p.act(async () => undefined);
                      setView(r.settings);
                      const parts = [
                        r.added.length && `added ${r.added.length}`,
                        r.reinstated.length &&
                          `reinstated ${r.reinstated.length}`,
                        r.deleted.length && `removed ${r.deleted.length}`,
                        r.retired.length && `retired ${r.retired.length}`,
                      ].filter(Boolean);
                      setNotice(
                        `Worker counts updated (${parts.join(", ")} agent${grown.length + r.deleted.length + r.retired.length === 1 ? "" : "s"}). Existing projects are unchanged.`,
                      );
                    })
                  }
                >
                  Apply worker counts
                </button>
                {changed && (
                  <button
                    onClick={() =>
                      setCounts(
                        Object.fromEntries(
                          countable.map((r) => [r.role, r.count]),
                        ),
                      )
                    }
                  >
                    Reset
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="quiet">
              This team type has no worker roles to resize; add agents on the
              canvas instead.
            </p>
          )}
          {view.retired.length > 0 && (
            <p className="quiet">
              Retired (kept for project history):{" "}
              {view.retired.map((r) => r.name).join(", ")}
            </p>
          )}
        </section>
      )}

      <section className="settings-card" aria-label="Workspace access defaults">
        <h3>Workspace access defaults</h3>
        <p className="quiet">
          {view.workspaceAccess.derived
            ? "Default folder access is based on agent role."
            : `${view.workspaceAccess.label}: default access to project folders.`}
        </p>
        <ul className="ts-list">
          {view.workspaceAccess.agents.map((a) => (
            <li key={a.id}>
              {agentDisplayName(a)}:{" "}
              <b>{a.access === "write" ? "Can read and edit" : "Can read"}</b>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-card" aria-label="Model expectations">
        <h3>Model expectations</h3>
        {view.expectations.length ? (
          <ul className="ts-list">
            {view.expectations.map((x) => (
              <li key={x.id}>
                {x.name}: expects <b>{x.expectation.label}</b>
                {x.expectation.effort
                  ? ` at effort ${x.expectation.effort}`
                  : ""}{" "}
                <small className="quiet">
                  (configured {x.environment} · {x.model}
                  {x.effort ? ` · ${x.effort}` : ""})
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="quiet">
            No extra model requirements. Agents are checked against models their
            runtime advertises.
          </p>
        )}
        <div className="row">
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api(
                  `/team-spaces/${teamId}/settings/model-check`,
                  "POST",
                );
                setCheck(r.modelCheck);
                setView(r.settings);
              })
            }
          >
            <RefreshCw size={14} />
            Re-run model check
          </button>
        </div>
        {modelCheck ? (
          <div data-testid="team-model-check">
            <p className={modelCheck.verified ? "good" : "bad"}>
              {modelCheck.verified
                ? "Models verified"
                : "Model check did not pass"}
              {modelCheck.checkedAt &&
                ` (${new Date(modelCheck.checkedAt).toLocaleString()})`}
            </p>
            {modelCheck.issues.length > 0 && (
              <ul className="ts-list bad">
                {modelCheck.issues.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
            {modelCheck.warnings.length > 0 && (
              <ul className="ts-list quiet">
                {modelCheck.warnings.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="quiet">No model check recorded for this team yet.</p>
        )}
      </section>

      {view.pausedPipelines.length > 0 && (
        <section
          className="settings-card"
          aria-label="Paused pipeline projects"
        >
          <h3>Paused pipeline projects</h3>
          <ul className="ts-list">
            {view.pausedPipelines.map((x) => (
              <li key={x.id}>
                {x.name}:{" "}
                <b>
                  {x.verification.state === "verified"
                    ? "verified"
                    : x.verification.state === "stale"
                      ? "needs re-verify"
                      : x.verification.state === "failed"
                        ? "verification failed"
                        : "not verified yet"}
                </b>
                {x.verification.state === "stale" && (
                  <small className="quiet">
                    {" "}
                    — {x.verification.reasons.join("; ")}
                  </small>
                )}
              </li>
            ))}
          </ul>
          {p.openFeature && (
            <button
              className="text-button"
              onClick={() => p.openFeature!("projects")}
            >
              Open Projects
            </button>
          )}
        </section>
      )}
    </div>
  );
}
