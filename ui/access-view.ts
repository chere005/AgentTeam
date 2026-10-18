/** Small client-side helpers for access rules (the backend in src/access.ts is authoritative). */
export type AccessRule = { path: string; access: "none" | "read" | "write" };
export type RuledWorkspace = {
  path: string;
  access: string;
  active?: boolean;
  rules?: AccessRule[];
  explicitOnly?: boolean;
};
export function ruleCounts(ws: RuledWorkspace) {
  const rules = ws.rules ?? [];
  const excluded = rules.filter((r) => r.access === "none").length;
  return { excluded, included: rules.length - excluded };
}
/** "RW +1 rule −2 excluded" style label for compact cards. */
export function accessLabel(ws: RuledWorkspace) {
  const { excluded, included } = ruleCounts(ws);
  const base = ws.explicitOnly ? "LISTED" : ws.access === "write" ? "RW" : "RO";
  return (
    base +
    (included ? ` +${included} rule${included === 1 ? "" : "s"}` : "") +
    (excluded ? ` −${excluded} excluded` : "")
  );
}
export function accessTitle(ws: RuledWorkspace) {
  const lines = [
    ws.path +
      " — " +
      (ws.explicitOnly
        ? "only the listed paths"
        : ws.access === "write"
          ? "read & write"
          : "read only"),
  ];
  for (const r of ws.rules ?? [])
    lines.push(
      `  ${r.access === "none" ? "excluded" : r.access === "write" ? "read & write" : "read only"}: ${r.path}`,
    );
  return lines.join("\n");
}
