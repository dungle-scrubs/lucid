import { tryCatch } from "./try-catch.js";
export type Appearance = "light" | "dark";
export type ThemePreference = Appearance | "system";
export const THEME_KEY = "lucid.theme.v1";

export const parseThemePreference = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" ? value : "system";

export interface ThemePlatform {
  readonly isDark: () => boolean;
  readonly observe: (refresh: (source?: "storage") => void) => () => void;
  readonly storage: () => Pick<Storage, "getItem" | "setItem"> | null;
}

export interface ThemeState {
  readonly appearance: Appearance;
  readonly persisted: boolean;
  readonly preference: ThemePreference;
}

export interface Theme {
  readonly choose: (value: ThemePreference) => void;
  readonly dispose: () => void;
  readonly read: () => ThemeState;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createTheme(platform: ThemePlatform): Theme {
  let preference: ThemePreference = "system";
  let persisted = true;
  let disposed = false;
  const readPreference = (): void => {
    const [error, store] = tryCatch(() => platform.storage());
    const [readError, value] = tryCatch(() => store?.getItem(THEME_KEY));
    persisted = !error && !readError && store != null;
    if (persisted) preference = parseThemePreference(value);
  };
  readPreference();
  const listeners = new Set<() => void>();
  const resolve = (): ThemeState => ({
    appearance:
      preference === "system" ? (tryCatch(platform.isDark)[1] ? "dark" : "light") : preference,
    persisted,
    preference,
  });
  let state = resolve();
  const refresh = (source?: "storage"): void => {
    if (disposed) return;
    if (source === "storage") readPreference();
    const next = resolve();
    if (
      next.appearance === state.appearance &&
      next.preference === state.preference &&
      next.persisted === state.persisted
    )
      return;
    state = next;
    for (const listener of listeners) listener();
  };
  const stop = platform.observe(refresh);
  return {
    choose: (value: ThemePreference): void => {
      if (disposed) return;
      preference = parseThemePreference(value);
      const [error, written] = tryCatch(() => {
        const store = platform.storage();
        if (!store) return false;
        store.setItem(THEME_KEY, preference);
        return true;
      });
      persisted = !error && written === true;
      refresh();
    },
    dispose: (): void => {
      disposed = true;
      stop();
      listeners.clear();
    },
    read: (): ThemeState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
