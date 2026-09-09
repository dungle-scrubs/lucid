import { expect, test } from "bun:test";
import { createTheme } from "../../src/server/client/theme.js";

test("System follows the current preference until the reader chooses an override", () => {
  let dark = true;
  let changed = (): void => {};
  const theme = createTheme({
    isDark: () => dark,
    observe: (refresh) => {
      changed = refresh;
      return () => {};
    },
    storage: () => null,
  });
  expect(theme.read()).toMatchObject({ appearance: "dark", preference: "system" });
  theme.choose("light");
  dark = false;
  changed();
  dark = true;
  changed();
  expect(theme.read()).toMatchObject({ appearance: "light", preference: "light" });
  theme.choose("system");
  expect(theme.read()).toMatchObject({ appearance: "dark", preference: "system" });
  dark = false;
  changed();
  expect(theme.read()).toMatchObject({ appearance: "light", preference: "system" });
  theme.dispose();
});

test("unavailable browser facilities preserve an override and expose failed persistence", () => {
  let refresh: (source?: "storage") => void = () => {};
  let available = false;
  let stopped = false;
  let value: string | null = "Dark";
  const theme = createTheme({
    isDark: () => {
      throw new Error("unavailable");
    },
    observe: (listener) => {
      refresh = listener;
      return () => {
        stopped = true;
      };
    },
    storage: () => {
      if (!available) throw new Error("denied");
      return {
        getItem: () => value,
        setItem: (_key, next) => {
          value = next;
        },
      };
    },
  });
  expect(theme.read()).toEqual({ appearance: "light", preference: "system", persisted: false });
  theme.choose("dark");
  refresh("storage");
  expect(theme.read()).toEqual({ appearance: "dark", preference: "dark", persisted: false });
  available = true;
  refresh("storage");
  expect(theme.read().preference).toBe("system");
  theme.choose("light");
  expect(theme.read().persisted).toBe(true);
  let notices = 0;
  theme.subscribe(() => notices++);
  theme.dispose();
  expect(stopped).toBe(true);
  refresh("storage");
  expect(notices).toBe(0);
});

test("a saved choice survives reopening and tabs converge without echo writes", () => {
  const values = new Map<string, string>([["lucid.theme.v1", "dark"]]);
  let writes = 0;
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes++;
      values.set(key, value);
    },
  };
  let refresh: (source?: "storage") => void = () => {};
  const platform = {
    isDark: () => false,
    observe: (listener: typeof refresh) => {
      refresh = listener;
      return () => {};
    },
    storage: () => store,
  };
  const theme = createTheme(platform);
  expect(theme.read().appearance).toBe("dark");
  theme.choose("light");
  expect(createTheme(platform).read().preference).toBe("light");
  theme.dispose();
  const tab = createTheme(platform);
  let notices = 0;
  const unsubscribe = tab.subscribe(() => notices++);
  values.set("lucid.theme.v1", "dark");
  refresh("storage");
  expect(tab.read().appearance).toBe("dark");
  const snapshot = tab.read();
  refresh("storage");
  expect(tab.read()).toBe(snapshot);
  expect(notices).toBe(1);
  values.clear();
  refresh("storage");
  expect(tab.read()).toMatchObject({ appearance: "light", preference: "system" });
  expect(writes).toBe(1);
  unsubscribe();
  tab.dispose();
});
