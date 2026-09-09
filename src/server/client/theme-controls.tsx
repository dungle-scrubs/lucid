import { getBrowserTheme } from "./browser-theme.js";
import { MoonDuotone, SunDuotone } from "./icons.js";
import { parseThemePreference } from "./theme.js";
import { useTheme } from "./use-theme.js";

export function AppearanceSettings() {
  const state = useTheme();
  return (
    <div className="settings-form appearance-settings">
      <label>
        Appearance
        <select
          value={state.preference}
          onChange={(event) => getBrowserTheme().choose(parseThemePreference(event.target.value))}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">Follow system</option>
        </select>
      </label>
      {!state.persisted ? (
        <p role="status">Appearance applies here but could not be saved.</p>
      ) : null}
    </div>
  );
}

export function ThemeControls() {
  const state = useTheme();
  const dark = state.appearance === "dark";
  const action = dark ? "Switch to light mode" : "Switch to dark mode";
  return (
    <div className="theme-controls">
      <button
        type="button"
        className="theme-toggle"
        aria-label={action}
        title={`${action}${state.preference === "system" ? " · Following system" : ""}`}
        onClick={() => getBrowserTheme().choose(dark ? "light" : "dark")}
      >
        {dark ? <SunDuotone size={16} /> : <MoonDuotone size={16} />}
      </button>
    </div>
  );
}
