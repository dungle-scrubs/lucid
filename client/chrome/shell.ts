import { create } from "zustand";
import { createSession, type SessionHandle } from "./session.ts";
import type { SessionConfig } from "./store.ts";

/**
 * The shell: what belongs to the WINDOW, not to any one session. Layout is a
 * single shared setting across every tab (a resize in one review is a resize
 * in all of them); which sessions are open, and which is active, is the
 * shell's roster. Session state itself lives on each SessionHandle.
 */

const CHROME_WIDTH_KEY = "lucid:chromeWidth";
const SIDEBAR_OPEN_KEY = "lucid:sidebarOpen";

export const DEFAULT_CHROME_WIDTH = 384;
export const CHROME_MIN_WIDTH = 320;

const readStoredWidth = (): number => {
  try {
    const raw = localStorage.getItem(CHROME_WIDTH_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n >= 300 ? n : DEFAULT_CHROME_WIDTH;
  } catch {
    return DEFAULT_CHROME_WIDTH;
  }
};

/** The review panel is the reason the viewer exists, so it starts open unless
 *  the human closed it last time. */
const readStoredSidebarOpen = (): boolean => {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

export const persistWidth = (w: number): void => {
  try {
    localStorage.setItem(CHROME_WIDTH_KEY, String(w));
  } catch {
    /* storage unavailable; width simply resets next load */
  }
};

const persistSidebarOpenValue = (open: boolean): void => {
  try {
    localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* storage unavailable; the panel simply reopens next load */
  }
};

interface ShellState {
  chromeWidth: number;
  /** Panel open/closed. Closing collapses it out of flow, so the artifact
   *  reflows to full width rather than being covered. */
  sidebarOpen: boolean;
  /** Which face of the panel is showing: the review, or the project's other
   *  sessions. */
  sidebarTab: "chat" | "sessions";
  /** The open sessions' ids, in tab order. */
  sessionKeys: readonly string[];
  /** The session driving the render, or null before boot. */
  activeKey: string | null;
}

export const useShell = create<ShellState>(() => ({
  chromeWidth: readStoredWidth(),
  sidebarOpen: readStoredSidebarOpen(),
  sidebarTab: "chat",
  sessionKeys: [],
  activeKey: null,
}));

export const setChromeWidth = (w: number): void => useShell.setState({ chromeWidth: w });

export const setSidebarOpen = (open: boolean): void => {
  useShell.setState({ sidebarOpen: open });
  persistSidebarOpenValue(open);
};

export const setSidebarTab = (tab: "chat" | "sessions"): void =>
  useShell.setState({ sidebarTab: tab });

/**
 * The handle roster. A plain module Map rather than store state: handles hold
 * live resources (an EventSource, closures), and zustand state wants
 * immutable snapshots. The reactive mirror is `sessionKeys`/`activeKey`.
 */
const handles = new Map<string, SessionHandle>();

/** Create (or return) the handle for a session, registering its tab. */
export const ensureSession = (config: SessionConfig): SessionHandle => {
  const existing = handles.get(config.session);
  if (existing) return existing;
  const handle = createSession(config);
  handles.set(handle.key, handle);
  useShell.setState((s) => ({
    sessionKeys: s.sessionKeys.includes(handle.key)
      ? s.sessionKeys
      : [...s.sessionKeys, handle.key],
    activeKey: s.activeKey ?? handle.key,
  }));
  return handle;
};

export const getSession = (key: string): SessionHandle | undefined => handles.get(key);

/** Forget a handle entirely (a closed tab). The caller has disconnected it;
 *  its on-disk state is untouched and reopening builds a fresh handle. */
export const dropSession = (key: string): void => {
  handles.delete(key);
};

/** The handle driving the render right now, for window-level handlers that
 *  fire outside React (keyboard, postMessage). Null only before boot. */
export const activeSession = (): SessionHandle | null => {
  const key = useShell.getState().activeKey;
  return key === null ? null : (handles.get(key) ?? null);
};
