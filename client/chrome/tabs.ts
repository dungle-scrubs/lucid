/**
 * The tab roster (M4.4): owns the session-handle Map, the LRU activation order,
 * and the operations that mutate them. The reactive mirror (`sessionKeys`,
 * `activeKey`) lives in `useShell` (shell.ts); this module is the sole writer.
 *
 * Extracted from shell.ts (handle Map, ensureSession, dropSession, getSession,
 * activeSession) and hub.ts (lastActivated Map, activate, enforceStreamCap).
 * hub.ts keeps the identity fetch and the attention coupling (recordViewed),
 * which read `useHub` state; the pure roster mechanics live here.
 *
 * Design rule (checkbox 7): no side effect occurs inside a state updater. The
 * `useShell.setState` callbacks compute the next snapshot only - disconnect,
 * dispose, and activate run OUTSIDE the updater, sequenced by the caller.
 */
import { createSession, type SessionHandle } from "./session.ts";
import type { SessionConfig } from "./store.ts";
import { useShell } from "./shell.ts";

/** The cap on simultaneously connected SSE streams (plan 03, D-036). The
 *  shell page may carry a LUCID_STREAM_CAP override via `shellConfig()` - a
 *  test seam, since eviction is otherwise unreachable without 11 real tabs. */
export const MAX_CONNECTED = 10;

/** The handle roster. A plain module Map rather than store state: handles hold
 *  live resources (an EventSource, closures), and zustand state wants
 *  immutable snapshots. The reactive mirror is `sessionKeys`/`activeKey` in
 *  `useShell`. */
const handles = new Map<string, SessionHandle>();

/** Activation recency per session key, for the eviction order. */
const lastActivated = new Map<string, number>();

/** Create (or return) the handle for a session, registering its tab. */
export const register = (config: SessionConfig): SessionHandle => {
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
export const dropHandle = (key: string): void => {
  handles.delete(key);
};

/** The handle driving the render right now, for window-level handlers that
 *  fire outside React (keyboard, postMessage). Null only before boot. */
export const activeSession = (): SessionHandle | null => {
  const key = useShell.getState().activeKey;
  return key === null ? null : (handles.get(key) ?? null);
};

/** Mark a key as most-recently-activated and set it as the active tab. Pure
 *  roster mechanics: the LRU stamp and the `activeKey` mirror. The attention
 *  coupling (recordViewed with the hub's attention seq) is the caller's job -
 *  it reads `useHub` state, which this module does not depend on. */
export const activate = (key: string): void => {
  lastActivated.set(key, Date.now());
  useShell.setState({ activeKey: key });
};

/** Remove a key from the roster and clean BOTH maps (no orphan in
 *  `lastActivated`). When `ops` is passed this is the ONE door for the whole
 *  close protocol (M4.3): dispose the stream/surface, drop the roster, then
 *  activate the promoted neighbor through the caller's reconnect path - in
 *  that order, so a disconnect never races the activate that reconnects the
 *  promoted (LRU-disconnected) tab. Returns whether the closed tab was active
 *  and which neighbor was promoted. */
export const close = (
  key: string,
  ops?: { readonly dispose?: (key: string) => void; readonly activate?: (key: string) => void },
): { readonly wasActive: boolean; readonly promoted: string | null } => {
  ops?.dispose?.(key);
  lastActivated.delete(key);
  const wasActive = useShell.getState().activeKey === key;
  let promoted: string | null = null;
  useShell.setState((s) => {
    const keys = s.sessionKeys.filter((k) => k !== key);
    const nextActive =
      s.activeKey === key
        ? // The neighbor that took the closed tab's place, else the last tab.
          (keys[Math.min(s.sessionKeys.indexOf(key), keys.length - 1)] ?? null)
        : s.activeKey;
    promoted = s.activeKey === key ? nextActive : null;
    return { sessionKeys: keys, activeKey: nextActive };
  });
  dropHandle(key);
  if (wasActive && promoted !== null) ops?.activate?.(promoted);
  return { wasActive, promoted };
};

/** The effective cap: the shell page may carry a LUCID_STREAM_CAP override. */
export const streamCap = (override?: number): number => override ?? MAX_CONNECTED;

/** Evict the least-recently-ACTIVATED background streams past the cap. The
 *  active tab is never a victim. Disconnected tabs keep their roster entry -
 *  their handle and log are intact, and reactivation refolds via bootstrap. */
export const enforceCap = (cap: number): void => {
  const { sessionKeys, activeKey } = useShell.getState();
  const connected = sessionKeys
    .map((k) => getSession(k))
    .filter((h): h is SessionHandle => h?.connected() === true);
  if (connected.length <= cap) return;
  const victims = connected
    .filter((h) => h.key !== activeKey)
    .sort((a, b) => (lastActivated.get(a.key) ?? 0) - (lastActivated.get(b.key) ?? 0));
  for (const v of victims.slice(0, connected.length - cap)) v.disconnect();
};
