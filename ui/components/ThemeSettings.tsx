import { setThemeSetting, useTheme, type ThemeSetting } from "../theme";

/** Settings → Appearance: follow the system theme, or force light or dark (stored locally). */
export function ThemeSettings() {
  const { setting } = useTheme();
  const osDark =
    typeof matchMedia !== "function" ||
    matchMedia("(prefers-color-scheme: dark)").matches;
  return (
    <section className="settings-card">
      <h3>Appearance</h3>
      <p>
        Follow the system’s light or dark setting, or always use one of them.
      </p>
      <select
        aria-label="Theme"
        value={setting}
        onChange={(e) => setThemeSetting(e.target.value as ThemeSetting)}
      >
        <option value="system">
          System (currently {osDark ? "dark" : "light"})
        </option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </section>
  );
}
