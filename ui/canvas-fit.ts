/**
 * Pure canvas-fit logic for the team canvas (no React/DOM; node tests import this file).
 *
 * - `fitViewport` fits the team's node bounds into the canvas with padding, never zooming in past
 *   `maxZoom` and never out past `minZoom` (below it card text gets unreadable). A team too large
 *   to fit at `minZoom` stays centred horizontally and is aligned to the top, so the leads show.
 * - `fitStep` decides what a trigger does: the canvas re-fits automatically (panel opened/closed,
 *   window resized, agents added) until the user pans or zooms by hand; after that an automatic
 *   trigger only shows the "Fit" hint, and an explicit fit (Fit button, Arrange) resumes it.
 */
export type Rect = { x: number; y: number; width: number; height: number };
export type ViewSize = { width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };
export type FitOptions = {
  /** Screen pixels kept free around the team. */
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
};
/**
 * Lowest automatic zoom. Below FAR_ZOOM (0.6) cards switch to the glance layout, whose text is
 * scaled by 1/zoom, so down to this zoom names and roles keep their on-screen size (15 / 11 px).
 */
export const MIN_FIT_ZOOM = 0.4;
export const FIT_PADDING = 40;

export function fitViewport(
  bounds: Rect,
  view: ViewSize,
  opts: FitOptions = {},
): Viewport {
  const padding = opts.padding ?? FIT_PADDING,
    minZoom = opts.minZoom ?? MIN_FIT_ZOOM,
    maxZoom = opts.maxZoom ?? 1;
  const availW = Math.max(1, view.width - 2 * padding),
    availH = Math.max(1, view.height - 2 * padding);
  const w = Math.max(1, bounds.width),
    h = Math.max(1, bounds.height);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(availW / w, availH / h)),
  );
  const x = view.width / 2 - (bounds.x + w / 2) * zoom;
  const y =
    h * zoom <= availH
      ? view.height / 2 - (bounds.y + h / 2) * zoom
      : padding - bounds.y * zoom;
  return { x, y, zoom };
}

export type FitState = {
  /** The user panned or zoomed by hand since the last fit. */
  manual: boolean;
  /** An automatic re-fit was skipped because of that: offer "Fit". */
  hint: boolean;
};
export type FitTrigger =
  /** Canvas size changed (side panel opened/closed, window resized). */
  | "resize"
  /** The set of visible agents changed. */
  | "nodes"
  /** Fit button or Arrange. */
  | "explicit"
  /** The user panned or zoomed. */
  | "user-move";

export function fitStep(
  state: FitState,
  trigger: FitTrigger,
): { state: FitState; fit: boolean } {
  switch (trigger) {
    case "explicit":
      return { state: { manual: false, hint: false }, fit: true };
    case "user-move":
      return { state: { manual: true, hint: state.hint }, fit: false };
    case "resize":
    case "nodes":
      return state.manual
        ? { state: { manual: true, hint: true }, fit: false }
        : { state, fit: true };
  }
}

/** Two viewports equal within a pixel / 0.1 % zoom (a click on the pane is not a move). */
export const sameViewport = (a: Viewport | null, b: Viewport) =>
  !!a &&
  Math.abs(a.x - b.x) < 1 &&
  Math.abs(a.y - b.y) < 1 &&
  Math.abs(a.zoom - b.zoom) < 0.001;
