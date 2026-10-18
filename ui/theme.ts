import { useEffect, useState } from "react";

/**
 * Colour theme: "system" follows the OS (prefers-color-scheme); Settings can force light or dark.
 * The choice is stored in localStorage (`agentteam.theme`) and applied as `data-theme` on <html>
 * (styles: `ui/theme-light.ts` derives the light twin of every rule at build time).
 */
export type ThemeSetting = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export const THEME_KEY = "agentteam.theme";
const EVENT = "agentteam:theme";

export function sanitizeTheme(value: unknown): ThemeSetting {
  return value === "light" || value === "dark" ? value : "system";
}
export function resolveTheme(setting: ThemeSetting, osDark: boolean): Theme {
  return setting === "system" ? (osDark ? "dark" : "light") : setting;
}

function storedSetting(): ThemeSetting {
  try {
    return sanitizeTheme(JSON.parse(localStorage.getItem(THEME_KEY) ?? "null"));
  } catch {
    return "system";
  }
}
const osQuery = () =>
  typeof matchMedia === "function"
    ? matchMedia("(prefers-color-scheme: dark)")
    : null;

/** Applies the stored (or given) setting to <html>; returns the resolved theme. */
export function applyTheme(setting = storedSetting()): Theme {
  const theme = resolveTheme(setting, osQuery()?.matches ?? true);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  return theme;
}

/**
 * Tell the desktop main process (window background colour, native theme, and the theme the preload
 * marks <html> with before the next launch's first paint). Absent outside the desktop app.
 */
export function syncThemeToShell(setting = storedSetting()) {
  try {
    const shell = (
      window as unknown as {
        agentteam?: { setTheme?: (s: ThemeSetting) => Promise<unknown> };
      }
    ).agentteam;
    void shell?.setTheme?.(setting)?.catch(() => {});
  } catch {
    /* not in the desktop shell */
  }
}

export function setThemeSetting(setting: ThemeSetting) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(setting));
  } catch {
    /* storage unavailable: the choice lasts for this session */
  }
  applyTheme(setting);
  syncThemeToShell(setting);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: setting }));
}

/** Current setting and resolved theme; follows Settings changes and OS changes. */
export function useTheme(): { setting: ThemeSetting; theme: Theme } {
  const read = () => {
    const setting = storedSetting();
    return {
      setting,
      theme: resolveTheme(setting, osQuery()?.matches ?? true),
    };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => {
      applyTheme();
      setState(read());
    };
    const query = osQuery();
    query?.addEventListener("change", update);
    window.addEventListener(EVENT, update);
    return () => {
      query?.removeEventListener("change", update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return state;
}
