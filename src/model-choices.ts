/**
 * Model/effort choices for the agent editor, validated against the selected installation.
 * Pure and dependency-free so the renderer and backend tests share it. A saved model is never
 * replaced here: unavailable or unverifiable values are kept and reported as warnings.
 */
export type ModelOption = { id: string; name: string; efforts: string[] };
export type RuntimeModels = {
  id: string;
  installed: boolean;
  modelSource: string;
  models: ModelOption[];
};
export type ModelStatus =
  | "pending" // installation list not loaded yet
  | "ok" // advertised by the installation
  | "unlisted" // installation only lists aliases, so the ID cannot be verified
  | "unavailable" // installation lists models authoritatively and this is not one
  | "unverifiable"; // installation not detected
export type ModelState = {
  status: ModelStatus;
  /** Options for the dropdown, never including the saved model. */
  options: ModelOption[];
  /** Effort values valid for the selected model (including the installation default). */
  efforts: string[];
  /** Non-null when the saved model needs the user's attention. */
  warning: string | null;
  /** A saved effort the selected model does not support (kept, not cleared). */
  unsupportedEffort: string | null;
};
const aliasOnly = (source: string) =>
  source === "provider-aliases" || source === "evaluator-aliases";
export function resolveModelState(
  runtime: RuntimeModels | undefined,
  model: string,
  effort: string | null,
): ModelState {
  const options = runtime?.models ?? [
    { id: "default", name: "Provider default", efforts: [] },
  ];
  const found = options.find((m) => m.id === model);
  let status: ModelStatus,
    warning: string | null = null;
  if (!runtime) status = "pending";
  else if (found) status = "ok";
  else if (!runtime.installed) status = "unverifiable";
  else if (aliasOnly(runtime.modelSource)) status = "unlisted";
  else status = "unavailable";
  const name = runtime?.id ?? "the selected";
  if (status === "unavailable")
    warning = `Saved model "${model}" is not offered by the installed ${name} runtime. It is kept as-is and was not switched to another model; requests may fail until you pick an available model.`;
  else if (status === "unverifiable")
    warning = `Saved model "${model}" cannot be checked because ${name} is not installed. It is kept as-is.`;
  else if (status === "unlisted")
    warning = `Model "${model}" is not in the ${name} alias list, so it cannot be verified. It is sent to the provider unchanged.`;
  const efforts = found ? found.efforts : [];
  const unsupportedEffort =
    effort && !efforts.includes(effort) && status !== "pending" ? effort : null;
  return { status, options, efforts, warning, unsupportedEffort };
}

/** How a dropdown entry relates to the selected installation. */
export type ModelAvailability =
  | "available" // advertised (or the provider default)
  | "unavailable" // the installation lists models authoritatively and this is not one
  | "unverified" // only aliases are listed, so this explicit ID cannot be checked
  | "unknown-installation"; // the runtime is not installed or detected
export type ModelDropdownOption = ModelOption & {
  availability: ModelAvailability;
  /** Short label suffix for anything not plainly available. */
  note?: string;
};
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/**
 * Well-known model IDs offered per environment besides what the installation advertises, so the
 * IDs the bundled teams and pipelines use are always pickable. Codex advertises its models
 * authoritatively and Wolfram lists its evaluators, so neither gets extra entries.
 */
export const WELL_KNOWN_MODELS: Record<string, ModelOption[]> = {
  claude: [
    { id: "default", name: "Claude recommended", efforts: [] },
    { id: "sonnet", name: "Sonnet", efforts: CLAUDE_EFFORTS },
    { id: "opus", name: "Opus", efforts: CLAUDE_EFFORTS },
    { id: "haiku", name: "Haiku", efforts: CLAUDE_EFFORTS },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: [] },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: [] },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", efforts: [] },
  ],
};
const NOTES: Record<ModelAvailability, string | undefined> = {
  available: undefined,
  unavailable: "unavailable in this installation",
  unverified: "not verified",
  "unknown-installation": "installation not detected",
};
/** Whether a dropdown entry may be picked (unavailable ones are shown grayed out). */
export const isSelectableModel = (o: { availability: ModelAvailability }) =>
  o.availability === "available" || o.availability === "unverified";
/** Dropdown label: the name plus the availability note, if any. */
export const modelOptionLabel = (o: ModelDropdownOption) =>
  o.note ? `${o.name} (${o.note})` : o.name;
/**
 * The full model dropdown for an environment: the installation's advertised models, then the
 * well-known IDs it does not advertise, then the saved model if neither lists it. Nothing is
 * dropped or substituted; entries that cannot be used are marked so the UI can gray them out.
 * While the installation list is loading (`runtime` undefined) nothing is marked.
 */
export function modelOptions(
  runtime: RuntimeModels | undefined,
  savedModel?: string | null,
  environment = runtime?.id,
): ModelDropdownOption[] {
  const advertised = runtime?.models ?? [];
  const seen = new Set(advertised.map((m) => m.id));
  const extra = (WELL_KNOWN_MODELS[environment ?? ""] ?? []).filter(
    (m) => !seen.has(m.id),
  );
  if (!runtime && !extra.length)
    extra.push({ id: "default", name: "Provider default", efforts: [] });
  for (const m of extra) seen.add(m.id);
  // Kept verbatim (not trimmed) so it matches the controlled select value.
  const saved = savedModel?.trim() ? savedModel : "";
  if (saved && !seen.has(saved))
    extra.push({ id: saved, name: saved, efforts: [] });
  const availability = (id: string, listed: boolean): ModelAvailability => {
    if (!runtime)
      return listed || id === "default" ? "available" : "unverified";
    if (!runtime.installed)
      return id === "default" ? "available" : "unknown-installation";
    if (listed) return "available";
    return aliasOnly(runtime.modelSource) ? "unverified" : "unavailable";
  };
  const entry = (m: ModelOption, listed: boolean): ModelDropdownOption => {
    const a = availability(m.id, listed);
    const note = runtime ? NOTES[a] : undefined;
    return { ...m, availability: a, ...(note ? { note } : {}) };
  };
  return [
    ...advertised.map((m) => entry(m, true)),
    ...extra.map((m) => entry(m, false)),
  ];
}
