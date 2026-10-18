import { useEffect, useRef } from "react";
import { api } from "../api";

/**
 * Subscribe to debounced external-change events for one workspace while a view is mounted.
 * The backend lease expires unless renewed, so a crashed window cannot leave watchers behind;
 * we renew every 30 s and stop explicitly on unmount.
 */
export function useWorkspaceWatch(
  agentId: string | undefined,
  workspace: string,
  enabled: boolean,
  onChange: (info: { git: boolean; paths: string[] }) => void,
) {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (!agentId || !workspace || !enabled || !window.agentteam) return;
    let alive = true;
    const start = () =>
      void api(`/agents/${agentId}/watch/start`, "POST", { workspace }).catch(
        () => {},
      );
    start();
    const renew = setInterval(start, 30_000);
    const off = window.agentteam.onEvent((e) => {
      if (
        e.type === "workspace.changed" &&
        e.entityId === agentId &&
        e.data?.workspace === workspace &&
        alive
      )
        latest.current({ git: !!e.data.git, paths: e.data.paths ?? [] });
    });
    return () => {
      alive = false;
      clearInterval(renew);
      off();
      void api(`/agents/${agentId}/watch/stop`, "POST", { workspace }).catch(
        () => {},
      );
    };
  }, [agentId, workspace, enabled]);
}
