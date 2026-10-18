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
