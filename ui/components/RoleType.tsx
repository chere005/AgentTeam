import { ROLE_PRESETS, rolePreset, roleWarnings } from "../../src/roles";

type RoleForm = {
  kind: string;
  roleType?: string;
  role: string;
  instructions: string;
  tools: string[];
  workspaces: { path: string; access: string; active: boolean }[];
};
export function applyRoleType(form: RoleForm, value: string) {
  if (value === "team-assistant")
    return { kind: "team-assistant", roleType: "custom" };
  const previous = rolePreset(form.roleType);
  const next = rolePreset(value);
  const patch: Record<string, unknown> = { kind: "agent", roleType: value };
  if (next) {
    // Fill only what is empty or still the previous preset's default, so edits are never clobbered.
    if (!form.role || form.role === previous?.role) patch.role = next.role;
    if (!form.instructions || form.instructions === previous?.instructions)
      patch.instructions = next.instructions;
    if (
      !form.tools.length ||
      form.tools.join(",") === previous?.tools.join(",")
    )
      patch.tools = [...next.tools];
  }
  return patch;
}
/** First control of the agent editor: role type with preset defaults and its output contract. */
export function RoleTypeSelect({
  kind,
  roleType,
  form,
  onChange,
}: {
  kind: string;
  roleType: string;
  form: RoleForm;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const value = kind === "team-assistant" ? "team-assistant" : roleType;
  const preset = rolePreset(roleType);
  const warnings = roleWarnings({
    roleType: roleType as never,
    tools: form.tools,
    workspaces: form.workspaces as never,
  });
  return (
    <label>
      Role type
      <select
        value={value}
        onChange={(e) => onChange(applyRoleType(form, e.target.value))}
      >
        <option value="custom">Specialist agent</option>
        {Object.values(ROLE_PRESETS).map((r) => (
          <option key={r.type} value={r.type}>
            {r.label}
          </option>
        ))}
        <option value="team-assistant">Team Assistant</option>
      </select>
      {preset && kind !== "team-assistant" && (
        <small data-testid="role-preset-note">
          {preset.summary} Output: {preset.outputContract.fields.join(", ")}.
          Default access: {preset.workspaceAccess}.
        </small>
      )}
      {warnings.map((w) => (
        <small key={w} role="status" data-testid="role-warning">
          {w}
        </small>
      ))}
    </label>
  );
}
