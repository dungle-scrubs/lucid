import { create } from "zustand";
import { visibleEl } from "./dom.ts";
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
  /** Project root path - the grouping the shell displays sessions under
   *  (a worktree resolves to its MAIN repo). */
  readonly project: string;
  /** Present when the session lives in a git worktree: that checkout's root. */
  readonly worktree?: string;
}

/** Display name of a project root ("lucid" for /Users/x/dev/lucid). */
export const projectName = (project: string): string =>
  project.split("/").filter(Boolean).pop() ?? project;

/**
 * Every root `POST /hub/create` would accept: the grouping project of each
 * listed session, plus any worktree checkout - the hub lists a worktree as a
 * root of its own, so both are legitimate places to put a new artifact. The
 * hub only knows projects that already hold a session, so a listing with no
 * rows has nowhere to create into.
 */
export const createRoots = (sessions: readonly HubSession[]): string[] => {
  const roots = new Set<string>();
  for (const s of sessions) {
    roots.add(s.project);
    if (s.worktree) roots.add(s.worktree);
  }
  return [...roots].sort();
};

/** Sessions grouped by project, insertion-ordered by the (name-sorted)
 *  listing. A tab is a session; the PROJECT is how a human scans for it. */
export const byProject = (sessions: readonly HubSession[]): Map<string, HubSession[]> => {
  const groups = new Map<string, HubSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.project);
    if (list) list.push(s);
    else groups.set(s.project, [s]);
  }
  return groups;
};

interface HubState {
  sessions: readonly HubSession[];
  /** The first listing snapshot has arrived. Until then the shell is
   *  LOOKING, not empty - the ~/dev scan can take a moment, and "no
   *  sessions" before it lands would be a false claim. */
  loaded: boolean;
  /** The listing stream is up. Like a session's `live`: status, not an error. */
  connected: boolean;
  /** The ⌘K palette is showing. */
  paletteOpen: boolean;
  /** The new-artifact dialog (D3/D16) is showing. */
  createOpen: boolean;
  /** The hub runs the attend engine, so it can author a new artifact
   *  (D15). Null until `/hub/identity` answers - unknown is not "no". */
  attend: boolean | null;
  /** The harness registry's recipe names, so the create dialog can OFFER
   *  them instead of asking for magic strings. Empty until identity answers
   *  (or when no registry exists - the dialog then omits the field). */
  harnesses: readonly string[];
  defaultHarness: string | null;
  /** The last create turn that DIED before its artifact surfaced, with the
   *  log tail that says why. Keyed state, not a toast: the create dialog is
   *  what must stop saying "authoring…". */
  createFailed: {
    readonly artifact: string;
    readonly tail: string;
    /** The harness's own usage-limit line, when that is what killed the
     *  turn - the dialog names the wall instead of showing a bare tail. */
    readonly usageLimit?: string;
  } | null;
}

export const useHub = create<HubState>(() => ({
  sessions: [],
  loaded: false,
  connected: false,
  paletteOpen: false,
  createOpen: false,
  attend: null,
  harnesses: [],
  defaultHarness: null,
  createFailed: null,
}));

export const setPaletteOpen = (open: boolean): void => useHub.setState({ paletteOpen: open });

export const setCreateOpen = (open: boolean): void => useHub.setState({ createOpen: open });

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
  // Activating a tab follows it to its project: the strip is project-scoped
  // (D8), so landing on a tab from elsewhere (⌘K, ?s boot) rescopes.
  const project = useHub.getState().sessions.find((s) => s.artifact === key)?.project;
  useShell.setState({ activeKey: key, ...(project ? { activeProject: project } : {}) });
};

/** The most recently activated OPEN tab in a project, if any. */
export const latestTabIn = (project: string): string | undefined => {
  const rows = useHub.getState().sessions;
  const inProject = new Set(rows.filter((s) => s.project === project).map((s) => s.artifact));
  return [...useShell.getState().sessionKeys]
    .filter((k) => inProject.has(k))
    .sort((a, b) => (lastActivated.get(b) ?? 0) - (lastActivated.get(a) ?? 0))[0];
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
  // Focus routing: landing on a tab should land the keyboard with it. The
  // composer is where typing goes next; rAF waits for the view to show
  // (visibleEl, because every open tab's view stays mounted).
  requestAnimationFrame(() => {
    visibleEl<HTMLTextAreaElement>('[data-test="message-input"]')?.focus();
  });
};

/** Close a tab: drop the stream and the roster entry. State on disk is
 *  untouched; reopening from the hub listing refolds everything. */
export const closeTab = (key: string): void => {
  const handle = getSession(key);
  handle?.disconnect();
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
  dropSession(key);
  // Promote through activateTab, not by index alone: the neighbor may be an
  // LRU-disconnected background tab, and landing on a dead stream would show
  // a frozen review until the human clicked it again.
  if (wasActive && promoted !== null) activateTab(promoted);
};

let hubSource: EventSource | null = null;
/** Last seen dev-bundle stamp (see connectHub's reload handling). */
let bundleStamp: string | null = null;

/**
 * Who the hub is. Only `attend` is kept: it decides whether authoring a new
 * artifact is on the table at all. Re-read on every (re)connect, because a
 * hub restarted with `--attend` would otherwise leave the shell repeating the
 * old answer for as long as the window stays open.
 */
const refreshIdentity = (): void => {
  void fetch("/hub/identity")
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{
            attend?: boolean;
            harnesses?: string[];
            defaultHarness?: string;
          }>)
        : null,
    )
    .then((who) => {
      if (who)
        useHub.setState({
          attend: who.attend === true,
          harnesses: who.harnesses ?? [],
          defaultHarness: who.defaultHarness ?? null,
        });
    })
    .catch(() => {
      /* the stream's own connected flag already reports an unreachable hub */
    });
};

/** Open the hub listing stream (idempotent). Each frame is a full snapshot. */
export const connectHub = (): void => {
  if (hubSource !== null) return;
  refreshIdentity();
  const es = new EventSource("/hub/events");
  hubSource = es;
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data) as { sessions: HubSession[]; bundle?: string };
      // Dev mode only: the hub stamps each snapshot with its bundle version.
      // A moved stamp means the watcher rebuilt the UI - reload to run it.
      if (data.bundle !== undefined) {
        if (bundleStamp !== null && bundleStamp !== data.bundle) {
          window.location.reload();
          return;
        }
        bundleStamp = data.bundle;
      }
      useHub.setState({ sessions: data.sessions, loaded: true });
    } catch {
      /* a frame we cannot parse is not worth tearing the stream down for */
    }
  };
  // `lucid open` ran in a terminal: the daemon asks live windows to surface
  // the session as a tab so the CLI never has to pop a browser next to a
  // shell that is already up. The listing snapshot may not carry the row yet
  // (notify is async), so ask the hub directly.
  es.addEventListener("open-tab", (e) => {
    void (async () => {
      try {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
        const listed = (await fetch("/hub/sessions").then((r) =>
          r.ok ? (r.json() as Promise<{ sessions: HubSession[] }>) : null,
        )) as { sessions: HubSession[] } | null;
        const row = listed?.sessions.find((s) => s.id === id);
        if (row) await openTab(row);
      } catch {
        /* the next snapshot still lists it; the human can open it by hand */
      }
    })();
  });
  // A create turn exited without producing its artifact: stop the dialog's
  // "authoring…" wait NOW and say why (the log tail rides along).
  es.addEventListener("create-failed", (e) => {
    try {
      const { artifact, tail, usageLimit } = JSON.parse((e as MessageEvent).data) as {
        artifact: string;
        tail: string;
        usageLimit?: string;
      };
      useHub.setState({
        createFailed: { artifact, tail, ...(usageLimit ? { usageLimit } : {}) },
      });
    } catch {
      /* malformed frame: the dialog's own timeout still reports */
    }
  });
  es.onopen = () => {
    useHub.setState({ connected: true });
    refreshIdentity();
  };
  es.onerror = () => useHub.setState({ connected: false });
};
