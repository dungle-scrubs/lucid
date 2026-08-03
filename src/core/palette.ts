/**
 * The palette Lucid remaps an artifact by: the six standard tokens, and the
 * value each theme gives them.
 *
 * One table, because these values lived in four hand-mirrored copies - the
 * sheet the overlay injects, the two CSS blocks in the lucid-design skill, and
 * the artifact ground in the chrome's own stylesheet - and nothing checked that
 * they still agreed. The overlay GENERATES its sheet from here; the copies that
 * cannot import TypeScript (a stylesheet, a Markdown skill) are pinned against
 * this table by unit tests.
 *
 * Data and nothing else, with no imports: this is compiled into the overlay
 * bundle, which runs inside the artifact's sandboxed iframe and stays small.
 */

export type ThemeName = "light" | "dark";

/** The tokens Lucid remaps. An artifact routing color through these follows the
 *  viewer's choice with no further work. */
export const THEME_TOKENS = [
  "--paper",
  "--ink",
  "--ink-muted",
  "--rule",
  "--accent",
  "--accent-wash",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** Warm, not clinical - the greys have a little brown in them. The dark form is
 *  paper, not the app: a lifted ground that still reads as a sheet. */
export const THEME_PALETTE: Readonly<Record<ThemeName, Readonly<Record<ThemeToken, string>>>> = {
  light: {
    "--paper": "#faf6ec",
    "--ink": "#211d15",
    "--ink-muted": "#5e6773",
    "--rule": "rgba(33, 29, 21, 0.12)",
    "--accent": "#7b6228",
    "--accent-wash": "rgba(203, 168, 90, 0.16)",
  },
  dark: {
    "--paper": "#211d15",
    "--ink": "#ece3cf",
    "--ink-muted": "#a89d84",
    "--rule": "rgba(236, 227, 207, 0.14)",
    "--accent": "#d9bd7a",
    "--accent-wash": "rgba(203, 168, 90, 0.18)",
  },
};
