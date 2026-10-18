import { useEffect, useRef } from "react";
import { X } from "lucide-react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
const visible = (el: HTMLElement) =>
  el.getClientRects().length > 0 &&
  getComputedStyle(el).visibility !== "hidden";
export const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);

/**
 * Mounted once. For every modal dialog (`role="dialog" aria-modal="true"`) that appears it moves
 * focus inside, traps Tab/Shift+Tab, lets Escape press the dialog's "Close…" button, and returns
 * focus to the element that opened it when the dialog is removed. Works for dialogs in any file.
 */
export function DialogFocusManager() {
  useEffect(() => {
    const stack: { el: HTMLElement; opener: HTMLElement | null }[] = [];
    let last: HTMLElement | null = null;
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('[role="dialog"][aria-modal="true"]')) last = t;
    };
    const sync = () => {
      const dialogs = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ];
      for (const d of dialogs)
        if (!stack.some((s) => s.el === d)) {
          // `last` is the last focus outside any dialog: a dialog field with autoFocus has
          // already taken focus by the time this observer runs.
          const active = document.activeElement as HTMLElement | null;
          stack.push({
            el: d,
            opener:
              last?.isConnected && !d.contains(last)
                ? last
                : active && active !== document.body && !d.contains(active)
                  ? active
                  : null,
          });
          requestAnimationFrame(() => {
            if (d.contains(document.activeElement)) return;
            const target =
              d.querySelector<HTMLElement>("[data-autofocus]") ??
              focusables(
                d.querySelector<HTMLElement>(".modal-content") ?? d,
              )[0] ??
              focusables(d)[0] ??
              d;
            if (target === d) d.tabIndex = -1;
            target.focus();
          });
        }
      for (let i = stack.length - 1; i >= 0; i--)
        if (!stack[i].el.isConnected) {
          const [gone] = stack.splice(i, 1);
          if (gone.opener?.isConnected) gone.opener.focus();
        }
    };
    const onKey = (e: KeyboardEvent) => {
      const top = stack[stack.length - 1]?.el;
      if (!top?.isConnected) return;
      if (e.key === "Escape" && !e.defaultPrevented) {
        const close = top.querySelector<HTMLElement>(
          'button[aria-label^="Close"]',
        );
        if (close) {
          e.preventDefault();
          close.click();
        }
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(top);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0],
        end = items[items.length - 1],
        active = document.activeElement;
      if (!top.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && active === end) {
        e.preventDefault();
        first.focus();
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKey, true);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return null;
}

export const shortcuts: { keys: string; action: string }[] = [
  { keys: "Mod+K", action: "More: open any view, agent or action" },
  { keys: "Mod+\\", action: "Show or hide the side panel (chat, agent setup)" },
  { keys: "Mod+Shift+N", action: "New agent" },
  { keys: "Mod+Shift+T", action: "Switch team" },
  { keys: "Mod+Shift+I", action: "Open the inbox" },
  {
    keys: "F6 / Shift+F6",
    action: "Move between top bar, main view and side panels",
  },
  { keys: "Alt+Arrow keys", action: "Canvas: parent, child and sibling agent" },
  {
    keys: "Enter / Shift+Enter",
    action: "Send message / new line in a conversation",
  },
  { keys: "?", action: "Show this list" },
  { keys: "Esc", action: "Close the open dialog, menu or agent panel" },
];
export const modLabel = () =>
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "Cmd"
    : "Ctrl";

export function ShortcutHelp({ close }: { close: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const mod = modLabel();
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <header>
          <div>
            <span className="eyebrow">KEYBOARD</span>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button className="icon" aria-label="Close shortcuts" onClick={close}>
            <X size={19} />
          </button>
        </header>
        <div className="modal-content">
          <dl className="shortcut-list">
            {shortcuts.map((s) => (
              <div key={s.keys}>
                <dt>
                  <kbd>{s.keys.replaceAll("Mod", mod)}</kbd>
                </dt>
                <dd>{s.action}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
