import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { STYLE } from "../../src/server/client/instrument.js";
import { createTheme, THEME_KEY } from "../../src/server/client/theme.js";

test("both prepaint scripts resolve every stored value like the runtime, even with blocked storage", () => {
  for (const page of ["index", "hub"]) {
    const html = readFileSync(`src/server/client/${page}.html`, "utf8");
    const script = html.match(/<script id="lucid-theme-bootstrap-[^"]+">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    for (const value of [null, "system", "light", "dark", "Dark", " dark ", "invalid"]) {
      for (const dark of [false, true]) {
        for (const blocked of [false, true]) {
          const storage = () => {
            if (blocked) throw new Error("denied");
            return {
              getItem: (key: string) => (key === THEME_KEY ? value : null),
              setItem: () => {},
            };
          };
          const root = {
            classList: {
              toggle: (_name: string, on: boolean) => {
                root.dark = on;
              },
            },
            dark: false,
            style: { colorScheme: "" },
          };
          const context = {
            document: { documentElement: root },
            matchMedia: () => ({ matches: dark }),
            get localStorage() {
              return storage();
            },
          };
          runInNewContext(script ?? "", context);
          const runtime = createTheme({ isDark: () => dark, observe: () => () => {}, storage });
          expect(root.style.colorScheme).toBe(runtime.read().appearance);
          expect(root.dark).toBe(runtime.read().appearance === "dark");
          runtime.dispose();
        }
      }
    }
  }
});

test("annotation and application palette values stay aligned in both appearances", () => {
  const css = readFileSync("src/server/client/app.css", "utf8");
  const frameRoots = [...STYLE.matchAll(/:root\s*\{([^}]*)\}/g)];
  for (const [index, selector] of [":root", ":root.dark"].entries()) {
    const block = css.slice(css.indexOf(`${selector} {`)).split("}")[0] ?? "";
    const frame = frameRoots[index]?.[1] ?? "";
    expect(frame).not.toBe("");
    for (const [, token, value] of frame.matchAll(/--lucid-(color-[\w-]+):\s*([^;]+);/g)) {
      expect(block).toContain(`--${token}: ${value};`);
    }
  }
});
