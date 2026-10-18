import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { GitIntegrate } from "./GitIntegrate";

type State = {
  repository: string | null;
  canInit?: boolean;
  message?: string;
  branch?: string | null;
  detached?: boolean;
  unborn?: boolean;
  upstream?: string | null;
  pushTarget?: { remote: string; branch: string; matches: boolean } | null;
  scope?: string;
  ahead?: number | null;
  behind?: number | null;
  tracked?: number;
  untracked?: number;
  conflicted?: number;
  operation?: string;
  remotes?: { name: string; display: string; provider: string }[];
  activeRun?: string | null;
  canMutate?: boolean;
};
type Feedback = { ok: boolean; text: string; detail?: string } | null;

/**
 * Branch/remote/history/PR/conflict workflow for the attached repository.
 * Confirmations are explicit checkboxes shown next to the risky action; the backend enforces
 * the same rules, so ticking nothing can never switch under a run or carry dirty files.
 */
export function GitWorkflowPanel({
  agentId,
  workspace,
  tick,
  onChanged,
}: {
  agentId: string;
  workspace: string;
  tick: number;
  onChanged: () => void;
}) {
  const route = (a: string) => `/agents/${agentId}/git/${a}`;
  const [st, setSt] = useState<State | null>(null),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<Feedback>(null),
    [loadError, setLoadError] = useState("");
  const reload = useCallback(async () => {
    try {
      setSt(await api(route("state"), "POST", { workspace }));
      setLoadError("");
    } catch (e) {
      setLoadError(String((e as Error).message ?? e));
    }
  }, [agentId, workspace]);
  useEffect(() => {
    void reload();
  }, [reload, tick]);
  /** Run an action that returns {ok, summary, failure?}; surface the outcome explicitly. */
  const run = async (label: string, body: () => Promise<any>) => {
    setBusy(true);
    setFeedback(null);
    try {
      const r = await body();
      if (r && r.ok === false)
        setFeedback({
          ok: false,
          text: `${label} failed: ${r.summary}`,
          detail: r.failure?.raw,
        });
      else setFeedback({ ok: true, text: r?.summary ?? `${label} done` });
    } catch (e) {
      setFeedback({
        ok: false,
        text: `${label} failed: ${(e as Error).message}`,
      });
    } finally {
      setBusy(false);
      await reload();
      onChanged();
    }
  };
  if (loadError) return <p role="alert">{loadError}</p>;
  if (!st) return <p className="hint">Loading repository…</p>;
  if (!st.repository)
    return (
      <section className="git-workflow" aria-label="Git workflow">
        <p className="notice">
          {st.message ?? "This folder is not a Git repository."}
        </p>
        {st.canInit ? (
          <button
            disabled={busy}
            onClick={() =>
              void run("Initialize", () =>
                api(route("init"), "POST", { workspace }),
              )
            }
          >
            Initialize a Git repository here
          </button>
        ) : (
          <p className="hint">
            Attach this folder with write access to initialize it.
          </p>
        )}
        {feedback && (
          <p role={feedback.ok ? "status" : "alert"}>{feedback.text}</p>
        )}
      </section>
    );
  const mutate = !!st.canMutate;
  return (
    <section className="git-workflow" aria-label="Git workflow">
      <div className="row between">
        <div>
          <b>{st.branch ?? "(detached HEAD)"}</b>
          {st.upstream && (
            <small>
              {" "}
              → {st.upstream} · ahead {st.ahead ?? 0} · behind {st.behind ?? 0}
            </small>
          )}
          {!st.upstream && !st.unborn && <small> · no upstream</small>}
          {st.scope && (
            <small title="This attachment is a subfolder of the repository">
              {" "}
              · limited to {st.scope}/
            </small>
          )}
        </div>
        <small>
          {st.tracked ?? 0} changed · {st.untracked ?? 0} untracked
        </small>
      </div>
      {st.activeRun && (
        <p className="notice" role="status">
          {st.activeRun}. Branch changes need explicit confirmation.
        </p>
      )}
      {st.operation && st.operation !== "none" && (
        <ConflictPanel
          agentId={agentId}
          workspace={workspace}
          operation={st.operation}
          run={run}
          busy={busy}
          canMutate={mutate}
          tick={tick}
        />
      )}
      <div className="row" role="group" aria-label="Remote actions">
        <button
          disabled={busy || !st.remotes?.length}
          onClick={() =>
            void run("Fetch", () => api(route("fetch"), "POST", { workspace }))
          }
        >
          Fetch
        </button>
        <button
          disabled={busy || !mutate || st.operation !== "none"}
          title="Fast-forward only"
          onClick={() =>
            void run("Pull", () =>
              api(route("pull"), "POST", {
                workspace,
                mode: "ff-only",
                confirmActiveRun: false,
              }),
            )
          }
        >
          Pull (fast-forward)
        </button>
        <PushControls
          disabled={busy || !mutate}
          st={st}
          onPush={(setUpstream, remote, confirmTarget) =>
            void run("Push", () =>
              api(route("push"), "POST", {
                workspace,
                ...(setUpstream ? { setUpstream: true, remote } : {}),
                ...(confirmTarget ? { confirmTarget } : {}),
              }),
            )
          }
        />
      </div>
      {feedback && (
        <div role={feedback.ok ? "status" : "alert"} className="git-feedback">
          <b>{feedback.text}</b>
          {feedback.detail && <pre>{feedback.detail}</pre>}
        </div>
      )}
      <BranchSwitcher
        agentId={agentId}
        workspace={workspace}
        st={st}
        run={run}
        busy={busy}
        tick={tick}
      />
      <GitIntegrate
        agentId={agentId}
        workspace={workspace}
        st={st}
        run={run}
        busy={busy}
        tick={tick}
      />
      <PullRequestPanel agentId={agentId} workspace={workspace} tick={tick} />
      <History agentId={agentId} workspace={workspace} tick={tick} />
    </section>
  );
}

function PushControls({
  st,
  disabled,
  onPush,
}: {
  st: State;
  disabled: boolean;
  onPush: (
    setUpstream: boolean,
    remote?: string,
    confirmTarget?: string,
  ) => void;
}) {
  const [remote, setRemote] = useState(st.remotes?.[0]?.name ?? "");
  const [targetOk, setTargetOk] = useState(false);
  const target = st.pushTarget;
  if (st.upstream) {
    // The tracked remote branch has another name (e.g. a feature branch tracking main):
    // pushing there must be a visible, deliberate choice.
    const other = target && !target.matches;
    return (
      <span className="row">
        {other && (
          <label className="notice">
            <input
              type="checkbox"
              checked={targetOk}
              onChange={(e) => setTargetOk(e.target.checked)}
            />{" "}
            Push {st.branch} onto {target.remote}/{target.branch}
          </label>
        )}
        <button
          disabled={disabled || st.detached || (!!other && !targetOk)}
          title={
            target
              ? `Pushes to ${target.remote}/${target.branch}`
              : "No push destination configured"
          }
          onClick={() =>
            onPush(false, undefined, other ? target.branch : undefined)
          }
        >
          Push{target ? ` to ${target.remote}/${target.branch}` : ""}
          {st.ahead ? ` (${st.ahead})` : ""}
        </button>
      </span>
    );
  }
  return (
    <span className="row">
      {(st.remotes?.length ?? 0) > 1 && (
        <select
          aria-label="Remote to publish to"
          value={remote}
          onChange={(e) => setRemote(e.target.value)}
        >
          {st.remotes!.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      <button
        disabled={disabled || st.detached || st.unborn || !st.remotes?.length}
        onClick={() => onPush(true, remote || undefined)}
      >
        Push and set upstream
      </button>
    </span>
  );
}

function BranchSwitcher({
  agentId,
  workspace,
  st,
  run,
  busy,
  tick,
}: {
  agentId: string;
  workspace: string;
  st: State;
  run: (label: string, body: () => Promise<any>) => Promise<void>;
  busy: boolean;
  tick: number;
}) {
  const [data, setData] = useState<any>(null),
    [target, setTarget] = useState(""),
    [created, setCreated] = useState(""),
    [base, setBase] = useState(""),
    [dirtyOk, setDirtyOk] = useState(false),
    [runOk, setRunOk] = useState(false);
  useEffect(() => {
    api(`/agents/${agentId}/git/branches`, "POST", { workspace })
      .then(setData)
      .catch(() => setData(null));
  }, [agentId, workspace, tick, st.branch]);
  const locals: string[] = data?.local.map((b: any) => b.name) ?? [];
  const remotes: string[] = (data?.remote ?? [])
    .map((b: any) => b.name as string)
    .filter((n: string) => !locals.includes(n.replace(/^[^/]+\//, "")));
  const dirty = (st.tracked ?? 0) > 0;
  const canSwitch =
    !busy &&
    st.canMutate &&
    st.operation === "none" &&
    (!dirty || dirtyOk) &&
    (!st.activeRun || runOk);
  const confirmations = (
    <>
      {dirty && (
        <label className="check">
          <input
            type="checkbox"
            checked={dirtyOk}
            onChange={(e) => setDirtyOk(e.target.checked)}
          />
          Carry {st.tracked} uncommitted change(s) to the new branch (Git
          refuses if they would be overwritten)
        </label>
      )}
      {st.activeRun && (
        <label className="check">
          <input
            type="checkbox"
            checked={runOk}
            onChange={(e) => setRunOk(e.target.checked)}
          />
          Change the branch while an agent is running here
        </label>
      )}
    </>
  );
  return (
    <details className="section" open>
      <summary>Branches</summary>
      <div className="row">
        <select
          aria-label="Branch to switch to"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">Choose a branch…</option>
          {locals
            .filter((n) => n !== st.branch)
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          {remotes.map((n) => (
            <option key={n} value={n.replace(/^[^/]+\//, "")}>
              {n} (track remote)
            </option>
          ))}
        </select>
        <button
          disabled={!canSwitch || !target}
          onClick={() =>
            void run("Switch", () =>
              api(`/agents/${agentId}/git/switch`, "POST", {
                workspace,
                branch: target,
                confirmDirty: dirtyOk,
                confirmActiveRun: runOk,
              }),
            ).then(() => setTarget(""))
          }
        >
          Switch
        </button>
      </div>
      <div className="row">
        <input
          aria-label="New branch name"
          placeholder="new-branch-name"
          value={created}
          onChange={(e) => setCreated(e.target.value)}
        />
        <select
          aria-label="Base for new branch"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        >
          <option value="">Current commit</option>
          {[...locals, ...(data?.remote?.map((b: any) => b.name) ?? [])].map(
            (n: string) => (
              <option key={n} value={n}>
                {n}
              </option>
            ),
          )}
        </select>
        <button
          disabled={!canSwitch || !created.trim()}
          onClick={() =>
            void run("Create branch", () =>
              api(`/agents/${agentId}/git/switch`, "POST", {
                workspace,
                branch: created.trim(),
                create: true,
                ...(base ? { base } : {}),
                confirmDirty: dirtyOk,
                confirmActiveRun: runOk,
              }),
            ).then(() => setCreated(""))
          }
        >
          Create and switch
        </button>
      </div>
      {confirmations}
      {st.operation !== "none" && (
        <p className="hint">
          Finish or abort the {st.operation} before switching.
        </p>
      )}
    </details>
  );
}

function History({
  agentId,
  workspace,
  tick,
}: {
  agentId: string;
  workspace: string;
  tick: number;
}) {
  const [commits, setCommits] = useState<any[]>([]),
    [next, setNext] = useState<number | null>(null),
    [open, setOpen] = useState<any>(null),
    [error, setError] = useState("");
  const load = useCallback(
    async (skip: number) => {
      try {
        const r = await api(`/agents/${agentId}/git/log`, "POST", {
          workspace,
          limit: 20,
          skip,
        });
        setCommits((c) => (skip ? [...c, ...r.commits] : r.commits));
        setNext(r.nextSkip);
        setError("");
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [agentId, workspace],
  );
  useEffect(() => {
    void load(0);
  }, [load, tick]);
  return (
    <details className="section">
      <summary>History</summary>
      {error && <p role="alert">{error}</p>}
      <ul className="commit-list" aria-label="Commit history">
        {commits.map((c) => (
          <li key={c.sha}>
            <button
              className="link"
              onClick={async () =>
                setOpen(
                  open?.sha === c.sha
                    ? null
                    : await api(`/agents/${agentId}/git/commit-info`, "POST", {
                        workspace,
                        sha: c.sha,
                      }),
                )
              }
            >
              <code>{c.short}</code> {c.subject}
            </button>
            <small>
              {" "}
              {c.author} · {new Date(c.date).toLocaleString()}
              {c.refs.length ? ` · ${c.refs.join(", ")}` : ""}
            </small>
            {open?.sha === c.sha && (
              <div className="commit-detail">
                <pre>{open.message}</pre>
                <ul>
                  {open.files.map((f: any) => (
                    <li key={f.path}>
                      <code>{f.status}</code> {f.from ? `${f.from} → ` : ""}
                      {f.path}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!commits.length && !error && <p className="hint">No commits yet.</p>}
      {next !== null && (
        <button onClick={() => void load(next)}>Load more</button>
      )}
    </details>
  );
}

function PullRequestPanel({
  agentId,
  workspace,
  tick,
}: {
  agentId: string;
  workspace: string;
  tick: number;
}) {
  const [base, setBase] = useState(""),
    [info, setInfo] = useState<any>(null),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [url, setUrl] = useState(""),
    [status, setStatus] = useState("open");
  const load = useCallback(async () => {
    try {
      setInfo(
        await api(`/agents/${agentId}/git/pr`, "POST", {
          workspace,
          ...(base.trim() ? { base: base.trim() } : {}),
        }),
      );
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [agentId, workspace, base]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  return (
    <details className="section">
      <summary>Pull request</summary>
      {error && <p role="alert">{error}</p>}
      {info && (
        <>
          <label>
            Base branch
            <input
              value={base}
              placeholder={info.base ?? "main"}
              onChange={(e) => setBase(e.target.value)}
            />
          </label>
          <p className="hint">
            {info.branch ?? "No branch"} → {info.base ?? "?"}
            {info.remote ? ` on ${info.remote.display}` : ""}
            {info.commitsAhead !== null
              ? ` · ${info.commitsAhead} commit(s) ahead`
              : ""}
          </p>
          {info.notes.map((n: string) => (
            <p key={n} className="hint">
              {n}
            </p>
          ))}
          <div className="row">
            <button
              disabled={!info.url}
              onClick={async () => {
                setNote("");
                try {
                  await api(`/agents/${agentId}/git/pr/open`, "POST", {
                    workspace,
                    ...(base.trim() ? { base: base.trim() } : {}),
                  });
                  setNote("Opened the pull request page in your browser.");
                } catch (e) {
                  setError(String((e as Error).message ?? e));
                }
              }}
            >
              Open pull request page
            </button>
            {info.url && <code className="pr-url">{info.url}</code>}
          </div>
          {note && <p role="status">{note}</p>}
          <h4>Linked work</h4>
          <ul aria-label="Linked work">
            <li>
              Branch: <code>{info.branch ?? "none"}</code>
            </li>
            {info.links.tasks.map((t: any) => (
              <li key={t.id}>
                Task: {t.title} <small>({t.status})</small>
              </li>
            ))}
            {info.links.reviews.map((r: any) => (
              <li key={r.id}>
                Review: {r.decision.replace("_", " ")}{" "}
                <small>({new Date(r.at).toLocaleString()})</small>
              </li>
            ))}
            {info.links.pullRequests.map((p: any) => (
              <li key={p.id}>
                PR{p.number ? ` #${p.number}` : ""}: <code>{p.url}</code>{" "}
                <small>
                  ({p.status}, recorded by you; status is not fetched)
                </small>
              </li>
            ))}
          </ul>
          <details>
            <summary>Record a pull request you created</summary>
            <div className="row">
              <input
                aria-label="Pull request URL"
                placeholder="https://…/pull/12"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
              <select
                aria-label="Pull request status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {["open", "draft", "merged", "closed"].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <button
                disabled={!url.trim()}
                onClick={async () => {
                  try {
                    await api(`/agents/${agentId}/git/pr/record`, "POST", {
                      workspace,
                      url: url.trim(),
                      status,
                    });
                    setUrl("");
                    await load();
                  } catch (e) {
                    setError(String((e as Error).message ?? e));
                  }
                }}
              >
                Record
              </button>
            </div>
          </details>
        </>
      )}
    </details>
  );
}

function ConflictPanel({
  agentId,
  workspace,
  operation,
  run,
  busy,
  canMutate,
  tick,
}: {
  agentId: string;
  workspace: string;
  operation: string;
  run: (label: string, body: () => Promise<any>) => Promise<void>;
  busy: boolean;
  canMutate: boolean;
  tick: number;
}) {
  const route = (a: string) => `/agents/${agentId}/git/${a}`;
  const [data, setData] = useState<any>(null),
    [file, setFile] = useState<any>(null),
    [ack, setAck] = useState(false),
    [confirm, setConfirm] = useState<"abort" | "continue" | null>(null),
    [runOk, setRunOk] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api(route("conflicts"), "POST", { workspace }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, [agentId, workspace]);
  useEffect(() => {
    void load();
  }, [load, tick]);
  const show = async (path: string) => {
    setAck(false);
    try {
      setFile(await api(route("conflict-file"), "POST", { workspace, path }));
      setError("");
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };
  return (
    <section className="conflicts" aria-label="Conflicts">
      <p className="notice" role="status">
        A {operation} is in progress. {data?.next}
      </p>
      {error && <p role="alert">{error}</p>}
      <ul className="conflict-files" aria-label="Conflicted files">
        {data?.files.map((f: any) => (
          <li key={f.path}>
            <button className="link" onClick={() => void show(f.path)}>
              <code>{f.code}</code> {f.path}
            </button>
            <small> {f.description}</small>
          </li>
        ))}
      </ul>
      {file && (
        <div className="conflict-detail" aria-label="Conflict details">
          <div className="row between">
            <b>{file.path}</b>
            <span className="row">
              <button
                onClick={() =>
                  void api(`/agents/${agentId}/editors/open`, "POST", {
                    workspace,
                    path: file.path,
                    action: "file",
                  }).catch((e) => setError(String(e.message)))
                }
                disabled={file.exists === false}
              >
                Open in editor
              </button>
            </span>
          </div>
          {file.note && <p className="hint">{file.note}</p>}
          {file.sections.map((s: any) => (
            <div className="conflict-section" key={s.startLine}>
              <small>
                Lines {s.startLine}–{s.endLine}
                {s.truncated ? " (truncated)" : ""}
              </small>
              <div className="conflict-side ours">
                <b>Ours {s.oursLabel && `(${s.oursLabel})`}</b>
                <pre>{s.ours.join("\n")}</pre>
              </div>
              {s.base && (
                <div className="conflict-side base">
                  <b>Base</b>
                  <pre>{s.base.join("\n")}</pre>
                </div>
              )}
              <div className="conflict-side theirs">
                <b>Theirs {s.theirsLabel && `(${s.theirsLabel})`}</b>
                <pre>{s.theirs.join("\n")}</pre>
              </div>
            </div>
          ))}
          {file.sectionCount > file.sections.length && (
            <p className="hint">
              {file.sectionCount - file.sections.length} more conflict
              section(s) not shown.
            </p>
          )}
          {file.hasMarkers && (
            <label className="check">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
              />
              This file still contains conflict markers; stage it anyway
            </label>
          )}
          <button
            disabled={busy || !canMutate || (file.hasMarkers && !ack)}
            onClick={() =>
              void run("Mark resolved", () =>
                api(route("resolve"), "POST", {
                  workspace,
                  paths: [file.path],
                  acknowledgeMarkers: ack,
                }),
              ).then(() => setFile(null))
            }
          >
            Mark resolved (stage)
          </button>
        </div>
      )}
      <div className="row">
        {confirm ? (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={runOk}
                onChange={(e) => setRunOk(e.target.checked)}
              />
              Allow while an agent is running here
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void run(confirm === "abort" ? "Abort" : "Continue", () =>
                  api(route(confirm), "POST", {
                    workspace,
                    confirm: true,
                    confirmActiveRun: runOk,
                  }),
                ).then(() => setConfirm(null))
              }
            >
              Confirm {confirm} {operation}
            </button>
            <button onClick={() => setConfirm(null)}>Cancel</button>
          </>
        ) : (
          <>
            <button
              disabled={busy || !canMutate || !!data?.files.length}
              onClick={() => setConfirm("continue")}
            >
              Continue {operation}…
            </button>
            <button
              disabled={busy || !canMutate}
              onClick={() => setConfirm("abort")}
            >
              Abort {operation}…
            </button>
          </>
        )}
      </div>
    </section>
  );
}
