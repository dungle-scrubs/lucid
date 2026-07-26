import { create } from "zustand";

/**
 * Which palette the ARTIFACTS render in.
 *
 * A theme belongs to the eyes reading, not to the document: an artifact must
 * render identically from disk and offline, so it may not carry a toggle or its
 * persisted state (the lucid-design skill says so outright). Lucid holds the
 * preference and every open artifact follows it at once.
 *
 * The chrome itself stays dark - this is the paper, not the tool.
 *
 * Its own module, with no imports of its own, because both the shell (which
 * broadcasts a change to every session) and a session's surface (which applies
 * the current value the moment an artifact loads) need it, and routing it
 * through either would make them import each other.
 */

export type ArtifactTheme = "light" | "dark";

const THEME_KEY = "lucid.artifactTheme";

/** Light unless the human chose otherwise: paper is what a document reads best
 *  on, and it is the ground every artifact is designed against first. */
const readStoredTheme = (): ArtifactTheme => {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
};

interface ThemeState {
  theme: ArtifactTheme;
}

export const useTheme = create<ThemeState>(() => ({ theme: readStoredTheme() }));

/** The current choice, for anything outside React (a surface applying it to a
 *  freshly loaded artifact). */
export const currentTheme = (): ArtifactTheme => useTheme.getState().theme;

/** Record the choice. Broadcasting it to open artifacts is the shell's job -
 *  it is the only thing that knows which sessions are open. */
export const storeTheme = (theme: ArtifactTheme): void => {
  useTheme.setState({ theme });
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage unavailable; the choice simply resets next load */
  }
};
