import { useEffect, useState } from "react";

/** Sand Ink is the app theme; the code editor keeps its independent Sublime-style canvas. */
export type ThemeSetting = "light";
export type Theme = "light";
export const THEME_KEY = "agentteam.theme";
const EVENT = "agentteam:theme";

export function sanitizeTheme(_value: unknown): ThemeSetting {
  return "light";
}
export function resolveTheme(_setting: ThemeSetting, _osDark: boolean): Theme {
  return "light";
}

function storedSetting(): ThemeSetting {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored !== JSON.stringify("light"))
      localStorage.setItem(THEME_KEY, JSON.stringify("light"));
    return "light";
  } catch {
    return "light";
  }
}
/** Applies Sand Ink to <html>; returns the selected theme. */
export function applyTheme(setting = storedSetting()): Theme {
  const theme = resolveTheme(setting, false);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  return theme;
}

/**
 * Tell the desktop main process to keep its native window and dialogs on Sand Ink.
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

/** Current setting and resolved theme. */
export function useTheme(): { setting: ThemeSetting; theme: Theme } {
  const read = () => {
    const setting = storedSetting();
    return {
      setting,
      theme: resolveTheme(setting, false),
    };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => {
      applyTheme();
      setState(read());
    };
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return state;
}
