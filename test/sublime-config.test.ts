import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSublimeEditorConfig,
  parseSublimeJson,
  sublimePreferencesPath,
} from "../src/sublime-config.ts";

test("Sublime JSON settings allow comments and trailing commas without changing strings", () => {
  assert.deepEqual(
    parseSublimeJson(`{
      // user's project URL
      "url": "https://example.test/a/*b*/",
      "nested": [1, 2,],
    }`),
    { url: "https://example.test/a/*b*/", nested: [1, 2] },
  );
});

test("Sublime global preferences load first; project settings override supported values", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agentteam-sublime-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) =>
      rm(home, { recursive: true, force: true }),
    ),
  );
  const userSettings = sublimePreferencesPath("darwin", home, {});
  await mkdir(
    join(
      home,
      "Library",
      "Application Support",
      "Sublime Text",
      "Packages",
      "User",
    ),
    { recursive: true },
  );
  await writeFile(
    userSettings,
    `{
    "font_size": 16,
    "tab_size": 3,
    "translate_tabs_to_spaces": false,
    "word_wrap": true,
    "rulers": [80, 100, 100, 999],
  }`,
  );
  const root = join(home, "site");
  await mkdir(root);
  await writeFile(
    join(root, "site.sublime-project"),
    `{
    "folders": [{ "path": "." }],
    "settings": { "tab_size": 4, "word_wrap": false, "rulers": [100] },
  }`,
  );

  const config = await loadSublimeEditorConfig(root, {
    platform: "darwin",
    home,
    env: {},
  });
  assert.deepEqual(config, {
    preferences: {
      fontSize: 16,
      tabSize: 4,
      translateTabsToSpaces: false,
      wordWrap: false,
      rulers: [100],
    },
    globalSettings: "loaded",
    projectFile: "site.sublime-project",
  });
});

test("Sublime project selection is deterministic and malformed or unsafe values fall back safely", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "agentteam-sublime-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) =>
      rm(home, { recursive: true, force: true }),
    ),
  );
  const root = join(home, "multiple");
  await mkdir(root);
  await writeFile(
    join(root, "one.sublime-project"),
    `{"settings":{"tab_size":8}}`,
  );
  await writeFile(
    join(root, "two.sublime-project"),
    `{"settings":{"tab_size":6}}`,
  );
  const ambiguous = await loadSublimeEditorConfig(root, {
    platform: "darwin",
    home,
    env: {},
  });
  assert.equal(ambiguous.projectFile, null);
  assert.equal(ambiguous.preferences.tabSize, 4);
  assert.equal(ambiguous.globalSettings, "missing");

  await writeFile(
    join(root, "multiple.sublime-project"),
    `{"settings":{"tab_size":99,"font_size":500,"word_wrap":"no"}}`,
  );
  const exact = await loadSublimeEditorConfig(root, {
    platform: "darwin",
    home,
    env: {},
  });
  assert.equal(exact.projectFile, "multiple.sublime-project");
  assert.equal(exact.preferences.tabSize, 4);
  assert.equal(exact.preferences.fontSize, 13);
  assert.equal(exact.preferences.wordWrap, true);
  assert.equal(exact.preferences.translateTabsToSpaces, false);
});

test("Sublime preferences paths follow macOS, Windows, and XDG conventions", () => {
  assert.equal(
    sublimePreferencesPath("darwin", "/Users/test", {}),
    "/Users/test/Library/Application Support/Sublime Text/Packages/User/Preferences.sublime-settings",
  );
  assert.equal(
    sublimePreferencesPath("win32", "C:\\Users\\test", {
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    }),
    "C:\\Users\\test\\AppData\\Roaming\\Sublime Text\\Packages\\User\\Preferences.sublime-settings",
  );
  assert.equal(
    sublimePreferencesPath("linux", "/home/test", {
      XDG_CONFIG_HOME: "/home/test/config",
    }),
    "/home/test/config/sublime-text/Packages/User/Preferences.sublime-settings",
  );
});
