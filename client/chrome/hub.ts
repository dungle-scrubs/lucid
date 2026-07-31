import { create } from "zustand";
import { hubFetch, SCAN_TIMEOUT_MS } from "./request.ts";
import type { HarnessInfo } from "../../src/protocol/wire.ts";
import { visibleEl } from "./dom.ts";
import { sessionLabel } from "./naming.ts";
import type { SessionHandle } from "./session.ts";
import { dropSession, ensureSession, getSession, recordViewed, useShell } from "./shell.ts";
import type { ShellConfig } from "./types.ts";

/** The shell page's payload, read through its declared shape - `daemon.ts`
 *  writes it and this reads it, so one type keeps the two spellings from
 *  drifting silently past typecheck. */
const shellConfig = (): ShellConfig | undefined =>
  (window as { __LUCID_SHELL__?: ShellConfig }).__LUCID_SHELL__;

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
  /** The artifact's own `<title>`, when it has one. What a tab, the palette
   *  and the pick screen show: "Units that got away" says what a session
   *  holds, "test2.html" says where it lives. */
  readonly title?: string;
  readonly lastSeen: string;
  readonly id: string;
  readonly hosted: boolean;
  /** Project root path - the grouping the shell displays sessions under
   *  (a worktree resolves to its MAIN repo). */
  readonly project: string;
  /** Present when the session lives in a git worktree: that checkout's root. */
  readonly worktree?: string;
}

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

/** One session's attention signals, as the hub's `event: attention` frame
 *  carries them (keyed by session id; src/core/attention.ts is the source). */
export interface HubAttention {
  readonly openQuestions: number;
  readonly working: boolean;
  readonly resolved: boolean;
  readonly lastEventSeq: number;
}

interface HubState {
  sessions: readonly HubSession[];
  /** id -> attention, from the hub's own fold (plan 03, M3.1). Truth that does
   *  NOT depend on any tab's stream: an evicted background tab's badge reads
   *  from here. Empty until (and unless) the hub emits - a hub that never does
   *  leaves every tab to its own fold, additively. */
  attention: Readonly<Record<string, HubAttention>>;
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
  /** Folders the hub scans for sessions. What an empty shell names when it
   *  reports having found nothing: "looked here" is correctable, "no reviews
   *  yet" is a dead end. Empty until `/hub/identity` answers. */
  roots: readonly string[];
  /** The harness registry's recipe names, so the create dialog can OFFER
   *  them instead of asking for magic strings. Empty until identity answers
   *  (or when no registry exists - the dialog then omits the field). */
  harnesses: readonly string[];
  defaultHarness: string | null;
  /** Each recipe's curated model/effort vocabulary, when the registry declares
   *  one. Runs parallel to `harnesses` (the hub reports both): a harness absent
   *  from here, or present with neither list, simply gets no pickers. */
  harnessInfo: readonly HarnessInfo[];
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
  /** The last heartbeat from each LIVE create turn (M2.1), keyed by artifact:
   *  proof of life, so the dialog reports progress instead of inferring
   *  failure from a clock. `at` is this window's receipt time - what "has the
   *  hub gone quiet" is measured against, since the hub's own elapsed cannot
   *  say whether IT stopped.
   *
   *  Keyed, not a single slot: two creates can run at once (the dialog itself
   *  invites it - "this dialog can be closed"), and one shared slot let the
   *  OTHER turn's heartbeats keep re-arming this dialog's silence detector,
   *  so a hub that stopped reporting THIS turn was never noticed. */
  createProgress: Readonly<
    Record<
      string,
      {
        readonly trace: string;
        readonly elapsedMs: number;
        readonly at: number;
        /** The turn's own phase one-liner (`lucid progress --label`), when the
         *  agent narrated one; the dialog shows it under the clock. */
        readonly label?: string;
      }
    >
  >;
}

export const useHub = create<HubState>(() => ({
  sessions: [],
  loaded: false,
  connected: false,
  paletteOpen: false,
  createOpen: false,
  attend: null,
  roots: [],
  harnesses: [],
  defaultHarness: null,
  harnessInfo: [],
  createFailed: null,
  createProgress: {},
  attention: {},
}));

/**
 * The create-state transition rules (M2.1, adversarial review of #90). The
 * dialog may only state what the hub told it, so stale claims must be
 * unreachable rather than merely unlikely: news about an artifact always
 * invalidates the OTHER kind of news about that same artifact, and every rule
 * is keyed so one turn's outcome never speaks for another's.
 *
 * Pure and exported for the tests: these are the rules, not the plumbing.
 */
export interface CreateState {
  readonly createFailed: HubState["createFailed"];
  readonly createProgress: HubState["createProgress"];
}

/** A live turn's heartbeat. Clears a failure recorded for the SAME artifact -
 *  a retry of a failed name was otherwise reported as still-failed for its
 *  whole duration, with the previous turn's log tail as the evidence. */
export const noteCreateProgress = (
  state: CreateState,
  artifact: string,
  frame: {
    readonly trace: string;
    readonly elapsedMs: number;
    readonly at: number;
    readonly label?: string;
  },
): CreateState => ({
  createFailed: state.createFailed?.artifact === artifact ? null : state.createFailed,
  createProgress: { ...state.createProgress, [artifact]: frame },
});

/** A turn died. Drops its heartbeat, so nothing can arm the silence detector
 *  from a dead turn's last frame. */
export const noteCreateFailed = (
  state: CreateState,
  failed: NonNullable<HubState["createFailed"]>,
): CreateState => {
  const { [failed.artifact]: _gone, ...rest } = state.createProgress;
  return { createFailed: failed, createProgress: rest };
};

/** A turn BEGINS, or has landed: forget everything about that artifact. A
 *  leftover entry is strictly worse than no data - the silence window is armed
 *  from the last heartbeat's AGE, so a stale one arms it at zero and the
 *  dialog claims silence instantly for a turn the hub is reporting. */
export const forgetCreate = (state: CreateState, artifact: string): CreateState => {
  const { [artifact]: _gone, ...rest } = state.createProgress;
  return {
    createFailed: state.createFailed?.artifact === artifact ? null : state.createFailed,
    createProgress: rest,
  };
};

/** Optimistic title update after a rename POST lands: the hub's next sessions
 *  push confirms it, but the tab must not read stale for the seconds between. */
export const renameSession = (artifact: string, title: string): void =>
  useHub.setState((s) => ({
    sessions: s.sessions.map((row) => (row.artifact === artifact ? { ...row, title } : row)),
  }));

export const setPaletteOpen = (open: boolean): void => useHub.setState({ paletteOpen: open });

export const setCreateOpen = (open: boolean): void => useHub.setState({ createOpen: open });

/**
 * Open sessions hold a live SSE stream each; past this many, the least
 * recently ACTIVATED background stream is disconnected (the log is untouched
 * - reactivating refolds). The tab stays: only its stream sleeps.
 */
const MAX_CONNECTED = 10;

/** The effective cap: the shell page may carry a LUCID_STREAM_CAP override -
 *  a test seam, since eviction is otherwise unreachable without 11 real tabs. */
const streamCap = (): number => shellConfig()?.streamCap ?? MAX_CONNECTED;

/** Activation recency per session key, for the eviction order. */
const lastActivated = new Map<string, number>();

/** The hub-attention seq for an artifact, when the hub has one. */
const attentionSeqFor = (key: string): number | undefined => {
  const { sessions, attention } = useHub.getState();
  const id = sessions.find((s) => s.artifact === key)?.id;
  return id !== undefined ? attention[id]?.lastEventSeq : undefined;
};

const activate = (key: string): void => {
  lastActivated.set(key, Date.now());
  // The strip shows every open tab now (plan 03, M2.1): activating a tab no
  // longer scopes the strip to a project.
  useShell.setState({ activeKey: key });
  // Arrival is what clears unseen (M3.2): the human landing on the tab marks
  // its log read up to here. Settling never does this - only activation and
  // the in-front tracking below.
  const seq = attentionSeqFor(key);
  if (seq !== undefined) recordViewed(key, seq);
};

/**
 * Apply one `event: attention` frame (M3.1/M3.2). The map replaces wholesale;
 * the ACTIVE tab's viewed mark tracks its lastEventSeq - the human is looking
 * at it, so what lands in front of them is seen as it lands. Every other
 * tab's mark stays where it is: growth there is exactly what unseen means,
 * and an agent settling must not fake an arrival.
 */
export const applyAttentionFrame = (map: Readonly<Record<string, HubAttention>>): void => {
  useHub.setState({ attention: map });
  const { activeKey } = useShell.getState();
  if (activeKey === null) return;
  const seq = attentionSeqFor(activeKey);
  if (seq !== undefined) recordViewed(activeKey, seq);
};

const enforceStreamCap = (): void => {
  const { sessionKeys, activeKey } = useShell.getState();
  const connected = sessionKeys
    .map((k) => getSession(k))
    .filter((h): h is SessionHandle => h?.connected() === true);
  const cap = streamCap();
  if (connected.length <= cap) return;
  const victims = connected
    .filter((h) => h.key !== activeKey)
    .sort((a, b) => (lastActivated.get(a.key) ?? 0) - (lastActivated.get(b.key) ?? 0));
  for (const v of victims.slice(0, connected.length - cap)) v.disconnect();
};

/**
 * Surface a hub session as a tab and make it active. Fetches the session's
 * identity through its mount (which is also what makes the daemon lazily
 * host a dormant one), then creates + connects its handle.
 */
export const openTab = async (
  row: HubSession,
  opts?: {
    /** Mount the tab WITHOUT bringing it to the front. Restoring a window is
     *  not arriving at its tabs (M3.2): a foreground open records a viewed
     *  mark and moves activeKey; a background one must do neither, or a ⌘R
     *  silently marks every restored tab as read and wipes its unseen badge. */
    readonly background?: boolean;
  },
): Promise<SessionHandle | null> => {
  const existing = getSession(row.artifact);
  if (existing) {
    if (!existing.connected()) existing.connect(); // reactivation refolds via bootstrap
    if (!opts?.background) activate(existing.key);
    enforceStreamCap();
    return existing;
  }
  const base = `/s/${row.id}`;
  const identity = await hubFetch(`${base}/__lucid/identity`)
    .then((r) => (r.ok ? (r.json() as Promise<{ session: string; version: number }>) : null))
    .catch(() => null);
  if (!identity) return null;
  const handle = ensureSession({
    session: identity.session,
    name: sessionLabel(row),
    version: identity.version,
    base,
    // The shell page carries the server's backoff cap (D-015) exactly the way
    // the standalone viewer page does; sessions built here must not silently
    // lose it or a hub-hosted tab reconnects on production patience under a
    // harness that killed its stream on purpose.
    ...((cap) => (typeof cap === "number" ? { sseMaxBackoffMs: cap } : {}))(
      shellConfig()?.sseMaxBackoffMs,
    ),
  });
  handle.connect();
  if (!opts?.background) activate(handle.key);
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
 * Who the hub is: whether authoring is on the table (`attend`), which folders
 * it scans (`roots`), and the spawn recipes it knows. Re-read on every
 * (re)connect, because a hub restarted with `--attend` - or pointed at a new
 * folder - would otherwise leave the shell repeating the old answer for as
 * long as the window stays open.
 */
const refreshIdentity = (): void => {
  void hubFetch("/hub/identity")
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{
            attend?: boolean;
            roots?: string[];
            harnesses?: string[];
            defaultHarness?: string;
            harnessInfo?: HarnessInfo[];
          }>)
        : null,
    )
    .then((who) => {
      if (who)
        useHub.setState({
          attend: who.attend === true,
          roots: who.roots ?? [],
          harnesses: who.harnesses ?? [],
          defaultHarness: who.defaultHarness ?? null,
          harnessInfo: who.harnessInfo ?? [],
        });
    })
    .catch(() => {
      /* the stream's own connected flag already reports an unreachable hub */
    });
};

/** What `POST /hub/roots` answers: the folder added, the whole scanned set,
 *  and how many sessions that folder turned out to hold. */
export interface AddedRoot {
  readonly root: string;
  readonly roots: readonly string[];
  readonly found: number;
}

/**
 * Point the hub at a folder: the OS chooser with no `path`, that path when
 * given. Returns the outcome for the caller to state - `cancelled` when the
 * human backed out, `needsPath` where no native chooser exists (type one
 * instead), an `error` string when the hub refused it.
 *
 * The listing refreshes itself: the hub broadcasts a new snapshot to every
 * connected window, so nothing here touches `sessions`.
 */
export const addRoot = async (
  path?: string,
): Promise<
  | { readonly added: AddedRoot }
  | { readonly cancelled: true }
  | { readonly needsPath: true }
  | { readonly error: string }
> => {
  const opensChooser = path === undefined || path === "";
  const res = await hubFetch("/hub/roots", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Two different unbounded things. With no path this opens a native folder
    // chooser and WAITS ON A HUMAN browsing, which no deadline may cut short -
    // the hub's own chooser guard bounds it instead, arriving here as a
    // cancel. With a path there is no human, but the hub still walks the tree
    // (16s for a home directory, measured), so it gets the scan budget rather
    // than the default.
    ...(opensChooser ? { timeoutMs: null } : { timeoutMs: SCAN_TIMEOUT_MS }),
    body: JSON.stringify(opensChooser ? {} : { path }),
  }).catch(() => null);
  if (!res) return { error: "The hub did not answer - it may have restarted. Reload the page." };
  const body = (await res.json().catch(() => null)) as
    | (Partial<AddedRoot> & {
        cancelled?: boolean;
        error?: string;
      })
    | null;
  if (body?.cancelled === true) return { cancelled: true };
  if (res.status === 501) return { needsPath: true };
  if (!res.ok || typeof body?.root !== "string") {
    return { error: typeof body?.error === "string" ? body.error : `Refused (${res.status}).` };
  }
  // Identity carries `roots`; a fresh add makes the shell's copy stale.
  useHub.setState({ roots: body.roots ?? [] });
  return { added: { root: body.root, roots: body.roots ?? [], found: body.found ?? 0 } };
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
  // The hub's own per-artifact attention fold (plan 03, M3.1): keyed by
  // session id, deduped server-side, independent of any tab's stream.
  es.addEventListener("attention", (e) => {
    try {
      applyAttentionFrame(JSON.parse((e as MessageEvent).data) as Record<string, HubAttention>);
    } catch {
      /* a frame we cannot parse is not worth tearing the stream down for */
    }
  });
  // `lucid open` ran in a terminal: the daemon asks live windows to surface
  // the session as a tab so the CLI never has to pop a browser next to a
  // shell that is already up. The listing snapshot may not carry the row yet
  // (notify is async), so ask the hub directly.
  es.addEventListener("open-tab", (e) => {
    void (async () => {
      try {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
        // The listing unions a scan of every root - same walk, same budget.
        const listed = (await hubFetch("/hub/sessions", { timeoutMs: SCAN_TIMEOUT_MS }).then((r) =>
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
      useHub.setState((prev) =>
        noteCreateFailed(prev, { artifact, tail, ...(usageLimit ? { usageLimit } : {}) }),
      );
    } catch {
      /* malformed frame: the dialog's own timeout still reports */
    }
  });
  // A create turn is STILL RUNNING (M2.1). The dialog reports this rather
  // than inferring health from a clock; `at` is stamped on receipt because
  // the question the dialog asks is "did the HUB go quiet", which the hub's
  // own elapsed number cannot answer.
  es.addEventListener("create-progress", (e) => {
    try {
      const { artifact, trace, elapsedMs, label } = JSON.parse((e as MessageEvent).data) as {
        artifact: string;
        trace: string;
        elapsedMs: number;
        label?: string;
      };
      useHub.setState((prev) =>
        noteCreateProgress(prev, artifact, {
          trace,
          elapsedMs,
          at: Date.now(),
          ...(typeof label === "string" && label !== "" ? { label } : {}),
        }),
      );
    } catch {
      /* malformed frame: the next heartbeat is 2s away */
    }
  });
  es.onopen = () => {
    useHub.setState({ connected: true });
    refreshIdentity();
  };
  es.onerror = () => useHub.setState({ connected: false });
};
