/** The UI-safe shape returned by the local Sublime settings reader. */
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
