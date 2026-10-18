import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox as InboxIcon, X } from "lucide-react";
import { api, saved, persist, type Snapshot } from "../api";
import { buildInbox, kindLabel, type InboxItem } from "../inbox";
import "./inbox.css";

/** Attention items derived from the snapshot plus approvals, recovery and limit trips. */
export function useInbox(data: Snapshot) {
  const [approvals, setApprovals] = useState<any[]>([]),
    [recovery, setRecovery] = useState<any[]>([]),
    [trips, setTrips] = useState<Record<string, { reason: string } | null>>({}),
    [dismissed, setDismissed] = useState<string[]>(() =>
      saved<string[]>("inbox.dismissed", []),
    );
  const pausedKey = data.workflows
    .filter((w) => w.paused)
    .map((w) => w.id)
    .join(",");
  const load = useCallback(async () => {
    try {
      setApprovals(await api("/approvals"));
    } catch {
      /* backend restarting */
    }
    try {
      setRecovery((await api("/recovery")).tasks ?? []);
    } catch {
      /* backend restarting */
    }
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void load();
    return window.agentteam?.onEvent(() => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 150);
    });
  }, [load]);
  useEffect(() => {
    let alive = true;
    const ids = pausedKey ? pausedKey.split(",") : [];
    void Promise.all(
      ids.map(async (id) => {
        try {
          const v = await api(`/workflows/${id}/limits`);
          return [
            id,
            v?.trip ? { reason: String(v.trip.reason) } : null,
          ] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => alive && setTrips(Object.fromEntries(entries)));
    return () => {
      alive = false;
    };
  }, [pausedKey, data.workflows]);
  const items = useMemo(
    () => buildInbox({ data, approvals, recovery, trips, dismissed }),
    [data, approvals, recovery, trips, dismissed],
  );
  const dismiss = (id: string) =>
    setDismissed((old) => {
      const next = [...old, id].slice(-200);
      try {
        persist("inbox.dismissed", next);
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return { items, dismiss };
}

type OtherTeamItem = InboxItem & { teamId: string; teamName: string };
export function InboxPane({
  items,
  others = [],
  teamName,
  dismiss,
  open,
}: {
  /** Items of the active team (and global ones such as approvals without a team). */
  items: InboxItem[];
  /** Items of other teams: listed separately; opening one switches the active team first. */
  others?: OtherTeamItem[];
  teamName?: string;
  dismiss: (id: string) => void;
  open: (item: InboxItem | OtherTeamItem) => void;
}) {
  const row = (item: InboxItem | OtherTeamItem, other: boolean) => (
    <li
      key={item.id}
      className={"inbox-item " + item.kind}
      data-testid={other ? "inbox-other-item" : "inbox-item"}
      data-kind={item.kind}
    >
      <div className="grow">
        <span className="eyebrow">{kindLabel[item.kind]}</span>
        {other && (
          <span className="inbox-team-label">
            {" "}
            · {(item as OtherTeamItem).teamName}
          </span>
        )}
        <b>{item.title}</b>
        <small>{item.detail}</small>
      </div>
      <button
        onClick={() => open(item)}
        aria-label={
          other
            ? `Switch to ${(item as OtherTeamItem).teamName} and open: ${item.title}`
            : undefined
        }
      >
        {other
          ? "Switch & open"
          : item.target === "workspace"
            ? "Open review"
            : "Open"}
      </button>
      <button
        className="icon"
        aria-label={`Dismiss: ${item.title}`}
        onClick={() => dismiss(item.id)}
      >
        <X size={15} />
      </button>
    </li>
  );
  return (
    <section className="inbox pane-content scroll" aria-label="Attention inbox">
      <div className="inbox-head">
        <h2>Attention inbox{teamName ? ` · ${teamName}` : ""}</h2>
        <span className="badge" data-testid="inbox-count">
          {items.length}
        </span>
      </div>
      {!items.length ? (
        <div className="empty" role="status">
          <InboxIcon size={30} />
          <h3>Nothing in {teamName ?? "this team"} needs your attention</h3>
          <p>
            Approvals, failed or blocked tasks, limit trips and ready reviews
            appear here.
          </p>
        </div>
      ) : (
        <ul className="inbox-list" aria-label="Items needing attention">
          {items.map((item) => row(item, false))}
        </ul>
      )}
      {others.length > 0 && (
        <div className="inbox-other-team">
          <h3>Other teams ({others.length})</h3>
          <ul className="inbox-list" aria-label="Items in other teams">
            {others.map((item) => row(item, true))}
          </ul>
        </div>
      )}
    </section>
  );
}
