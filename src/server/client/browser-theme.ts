import type { Theme } from "./theme.js";
import { createTheme, THEME_KEY } from "./theme.js";

let owner: Theme | undefined;
let ownerWindow: Window | undefined;

export function getBrowserTheme(): Theme {
  if (owner && ownerWindow === window) return owner;
  owner?.dispose();
  ownerWindow = window;
  const target = window;
  const theme = createTheme({
    isDark: () => target.matchMedia("(prefers-color-scheme: dark)").matches,
    observe: (refresh) => {
      const system = (): void => refresh();
      const restored = (): void => refresh("storage");
      const storage = (event: StorageEvent): void => {
        if (event.key !== THEME_KEY && event.key !== null) return;
        try {
          if (event.storageArea === target.localStorage) restored();
        } catch {
          // Storage can become unavailable after the page was opened.
        }
      };
      let media: MediaQueryList | undefined;
      try {
        media = target.matchMedia("(prefers-color-scheme: dark)");
        media.addEventListener("change", system);
      } catch {
        // Manual choices still work without media-query observation.
      }
      target.addEventListener("storage", storage);
      target.addEventListener("pageshow", restored);
      return () => {
        media?.removeEventListener("change", system);
        target.removeEventListener("storage", storage);
        target.removeEventListener("pageshow", restored);
      };
    },
    storage: () => target.localStorage,
  });
  const apply = (): void => {
    const { appearance } = theme.read();
    target.document.documentElement.classList.toggle("dark", appearance === "dark");
    target.document.documentElement.style.colorScheme = appearance;
  };
  apply();
  theme.subscribe(apply);
  owner = theme;
  return theme;
}
