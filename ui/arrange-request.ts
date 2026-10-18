/**
 * Hand-off from the places that create agents in bulk (team/template/pack insert, example teams)
 * to the team canvas: "arrange these agents as an org chart when they appear". Stored in
 * localStorage so it survives the pane switch; consumed once by the canvas of that team.
 */
const KEY = "agentteam.arrangeRequest";
export type ArrangeRequest = { teamId: string; agentIds: string[] };

export function requestArrange(teamId: string, agentIds: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ teamId, agentIds }));
    window.dispatchEvent(new CustomEvent("agentteam:arrange-request"));
  } catch {
    /* storage unavailable: the canvas still auto-arranges teams without positions */
  }
}
export function peekArrange(teamId: string): ArrangeRequest | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return r && r.teamId === teamId && Array.isArray(r.agentIds) ? r : null;
  } catch {
    return null;
  }
}
export function clearArrange() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
