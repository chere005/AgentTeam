import { useEffect, useRef } from "react";
import { api } from "../api";
import { WorkspaceWatchSubscriptions } from "../workspace-watches";

const subscriptions = new WorkspaceWatchSubscriptions(api);

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
    const release = subscriptions.subscribe(agentId, workspace);
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
      off();
      release();
    };
  }, [agentId, workspace, enabled]);
}
