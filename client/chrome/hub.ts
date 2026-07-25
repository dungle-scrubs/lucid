import { create } from "zustand";
import type { SessionHandle } from "./session.ts";
import { dropSession, ensureSession, getSession, useShell } from "./shell.ts";

/**
 * The shell's connection to the hub daemon: the session listing (every
 * session across the scan roots), the live listing stream, and tab
 * orchestration - opening a session as a tab, activating it, closing it, and
 * the connected-stream cap.
 */

/** A hub listing row, as GET /hub/sessions reports it. */
export interface HubSession {
  readonly artifact: string;
  readonly name: string;
  readonly lastSeen: string;
  readonly id: string;
  readonly hosted: boolean;
}

interface HubState {
  sessions: readonly HubSession[];
  /** The listing stream is up. Like a session's `live`: status, not an error. */
  connected: boolean;
  /** The "+" opener popover is showing. */
  pickerOpen: boolean;
  /** The ⌘K palette is showing. */
  paletteOpen: boolean;
}

export const useHub = create<HubState>(() => ({
  sessions: [],
  connected: false,
  pickerOpen: false,
  paletteOpen: false,
}));

export const setPickerOpen = (open: boolean): void => useHub.setState({ pickerOpen: open });

export const setPaletteOpen = (open: boolean): void => useHub.setState({ paletteOpen: open });

/**
 * Open sessions hold a live SSE stream each; past this many, the least
 * recently ACTIVATED background stream is disconnected (the log is untouched
 * - reactivating refolds). The tab stays: only its stream sleeps.
 */
const MAX_CONNECTED = 10;

/** Activation recency per session key, for the eviction order. */
const lastActivated = new Map<string, number>();

const activate = (key: string): void => {
  lastActivated.set(key, Date.now());
  useShell.setState({ activeKey: key });
};

const enforceStreamCap = (): void => {
  const { sessionKeys, activeKey } = useShell.getState();
  const connected = sessionKeys
    .map((k) => getSession(k))
    .filter((h): h is SessionHandle => h?.connected() === true);
  if (connected.length <= MAX_CONNECTED) return;
  const victims = connected
    .filter((h) => h.key !== activeKey)
    .sort((a, b) => (lastActivated.get(a.key) ?? 0) - (lastActivated.get(b.key) ?? 0));
  for (const v of victims.slice(0, connected.length - MAX_CONNECTED)) v.disconnect();
};

/**
 * Surface a hub session as a tab and make it active. Fetches the session's
 * identity through its mount (which is also what makes the daemon lazily
 * host a dormant one), then creates + connects its handle.
 */
export const openTab = async (row: HubSession): Promise<SessionHandle | null> => {
  const existing = getSession(row.artifact);
  if (existing) {
    if (!existing.connected()) existing.connect(); // reactivation refolds via bootstrap
    activate(existing.key);
    enforceStreamCap();
    return existing;
  }
  const base = `/s/${row.id}`;
  const identity = await fetch(`${base}/__lucid/identity`)
    .then((r) => (r.ok ? (r.json() as Promise<{ session: string; version: number }>) : null))
    .catch(() => null);
  if (!identity) return null;
  const handle = ensureSession({
    session: identity.session,
    name: row.name,
    version: identity.version,
    base,
  });
  handle.connect();
  activate(handle.key);
  enforceStreamCap();
  return handle;
};

export const activateTab = (key: string): void => {
  const handle = getSession(key);
  if (!handle) return;
  if (!handle.connected()) handle.connect();
  activate(key);
  enforceStreamCap();
};

/** Close a tab: drop the stream and the roster entry. State on disk is
 *  untouched; reopening from the hub listing refolds everything. */
export const closeTab = (key: string): void => {
  const handle = getSession(key);
  handle?.disconnect();
  lastActivated.delete(key);
  useShell.setState((s) => {
    const keys = s.sessionKeys.filter((k) => k !== key);
    const nextActive =
      s.activeKey === key
        ? // The neighbor that took the closed tab's place, else the last tab.
          (keys[Math.min(s.sessionKeys.indexOf(key), keys.length - 1)] ?? null)
        : s.activeKey;
    return { sessionKeys: keys, activeKey: nextActive };
  });
  dropSession(key);
};

let hubSource: EventSource | null = null;

/** Open the hub listing stream (idempotent). Each frame is a full snapshot. */
export const connectHub = (): void => {
  if (hubSource !== null) return;
  const es = new EventSource("/hub/events");
  hubSource = es;
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as { sessions: HubSession[] };
      useHub.setState({ sessions: data.sessions });
    } catch {
      /* a frame we cannot parse is not worth tearing the stream down for */
    }
  };
  es.onopen = () => useHub.setState({ connected: true });
  es.onerror = () => useHub.setState({ connected: false });
};
