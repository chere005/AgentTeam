import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";

const MAX_PREFERENCES_BYTES = 256 * 1024;
const MAX_PROJECT_BYTES = 1024 * 1024;

export type SublimeEditorPreferences = {
  fontSize: number;
  tabSize: number;
  translateTabsToSpaces: boolean;
  wordWrap: boolean;
  rulers: number[];
};

export type SublimeEditorConfig = {
  preferences: SublimeEditorPreferences;
  globalSettings: "loaded" | "missing" | "invalid";
  projectFile: string | null;
};

export const defaultSublimePreferences: SublimeEditorPreferences = {
  fontSize: 13,
  tabSize: 4,
  translateTabsToSpaces: false,
  wordWrap: true,
  rulers: [],
};

export function sublimePreferencesPath(
  platform: NodeJS.Platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platform === "win32") {
    const appData =
      env.APPDATA && win32.isAbsolute(env.APPDATA)
        ? env.APPDATA
        : win32.join(home, "AppData", "Roaming");
    return win32.join(
      appData,
      "Sublime Text",
      "Packages",
      "User",
      "Preferences.sublime-settings",
    );
  }
  if (platform === "darwin")
    return join(
      home,
      "Library",
      "Application Support",
      "Sublime Text",
      "Packages",
      "User",
      "Preferences.sublime-settings",
    );
  const config =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith("/")
      ? env.XDG_CONFIG_HOME
      : join(home, ".config");
  return join(
    config,
    "sublime-text",
    "Packages",
    "User",
    "Preferences.sublime-settings",
  );
}

/** Parse Sublime's JSON-with-comments settings without changing string contents. */
export function parseSublimeJson(source: string): unknown {
  let clean = "";
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      clean += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      clean += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      clean += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") clean += "\n";
        i++;
      }
      i++;
      continue;
    }
    if (ch === ",") {
      let next = i + 1;
      while (/\s/.test(source[next] ?? "")) next++;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    clean += ch;
  }
  return JSON.parse(clean);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function applySettings(
  base: SublimeEditorPreferences,
  value: Record<string, unknown> | null,
): SublimeEditorPreferences {
  if (!value) return base;
  const next = { ...base };
  const fontSize = value.font_size;
  if (
    typeof fontSize === "number" &&
    Number.isFinite(fontSize) &&
    fontSize >= 8 &&
    fontSize <= 40
  )
    next.fontSize = fontSize;
  const tabSize = value.tab_size;
  if (
    typeof tabSize === "number" &&
    Number.isInteger(tabSize) &&
    tabSize >= 1 &&
    tabSize <= 8
  )
    next.tabSize = tabSize;
  if (typeof value.translate_tabs_to_spaces === "boolean")
    next.translateTabsToSpaces = value.translate_tabs_to_spaces;
  if (typeof value.word_wrap === "boolean") next.wordWrap = value.word_wrap;
  else if (value.word_wrap === "auto") next.wordWrap = true;
  if (Array.isArray(value.rulers))
    next.rulers = [
      ...new Set(
        value.rulers.filter(
          (n): n is number =>
            typeof n === "number" && Number.isInteger(n) && n >= 20 && n <= 240,
        ),
      ),
    ].slice(0, 5);
  return next;
}

async function readSettings(path: string, maxBytes: number) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maxBytes)
      return { state: "invalid" as const, data: null };
    const parsed = record(parseSublimeJson(await readFile(path, "utf8")));
    return parsed
      ? { state: "loaded" as const, data: parsed }
      : { state: "invalid" as const, data: null };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" as const, data: null }
      : { state: "invalid" as const, data: null };
  }
}

async function findProjectFile(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith(".sublime-project"),
      )
      .map((entry) => entry.name)
      .sort();
    const exact = `${basename(root)}.sublime-project`;
    const selected = names.includes(exact)
      ? exact
      : names.length === 1
        ? names[0]
        : null;
    return selected ? join(root, selected) : null;
  } catch {
    return null;
  }
}

/** Read only the supported editor options; never imports project folder paths as agent grants. */
export async function loadSublimeEditorConfig(
  root: string | null = null,
  options: {
    platform?: NodeJS.Platform;
    home?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SublimeEditorConfig> {
  const global = await readSettings(
    sublimePreferencesPath(
      options.platform ?? process.platform,
      options.home,
      options.env,
    ),
    MAX_PREFERENCES_BYTES,
  );
  let preferences = applySettings(defaultSublimePreferences, global.data);
  const projectPath = root ? await findProjectFile(root) : null;
  if (projectPath) {
    const project = await readSettings(projectPath, MAX_PROJECT_BYTES);
    preferences = applySettings(preferences, record(project.data?.settings));
  }
  return {
    preferences,
    globalSettings: global.state,
    projectFile: projectPath ? basename(projectPath) : null,
  };
}
