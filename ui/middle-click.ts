import type { MouseEvent } from "react";

/**
 * Handlers that close a tab on middle click. Spread them on the tab wrapper so a
 * middle click anywhere on the tab (label or X) closes it. `onMouseDown` also
 * stops Chromium's middle-button autoscroll cursor on Windows and Linux.
 * Left clicks are untouched; `click` never fires for the middle button, so the
 * tab's own activate handler does not run.
 */
export function middleClickProps(close: () => void) {
  return {
    onAuxClick: (event: MouseEvent<HTMLElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      close();
    },
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      if (event.button === 1) event.preventDefault();
    },
  };
}
