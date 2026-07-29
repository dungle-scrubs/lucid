import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { AddFolder } from "./AddFolder.tsx";
import { attentionStateOf, isUnseen } from "./attention.ts";
import { openSplit } from "./list.ts";
import { SessionView } from "./Chrome.tsx";
import { Command } from "cmdk";
import { CreateDialog } from "./CreateDialog.tsx";
import { SessionListGroups } from "./SessionList.tsx";
import {
  activateTab,
  closeTab,
  connectHub,
  openTab,
  setCreateOpen,
  setPaletteOpen,
  useHub,
} from "./hub.ts";
import { resolveShortcut } from "./keymap.ts";
import { groupTabs, projectName, tabLabel } from "./naming.ts";
import { Palette } from "./Palette.tsx";
import type { SessionHandle } from "./session.ts";
import { getSession, persistTabs, readStoredTabs, useShell } from "./shell.ts";
import { closeButtonSmall } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The shell: one window over every session (Model B). A tab bar across the
 * top - one tab per open session, each holding its own live handle - and the
 * active session's full view below it. The daemon serves this at `/`;
 * everything session-scoped rides `/s/<id>` on the same origin.
 */

/**
 * A tab's attention badge. The state is the pure resolver's decision
 * (attention.ts, D-018); the INPUTS come from the hub's attention map first -
 * truth that does not depend on this tab's own stream, so a background tab
 * evicted from the connection cap still wears its question dot (M3.1) - and
 * fall back to the session's own fold when the hub has no entry (a per-session
 * server, or a hub that does not emit). Primitive selectors, one per fact - a
 * combined object selector would defeat useSyncExternalStore's equality check.
 */
const TabAttention = ({ handle }: { readonly handle: SessionHandle }) => {
  const hubEntry = useHub((s) => {
    const id = s.sessions.find((row) => row.artifact === handle.key)?.id;
    return id !== undefined ? s.attention[id] : undefined;
  });
  const viewed = useShell((s) => s.viewedSeq[handle.key]);
  const active = useShell((s) => s.activeKey === handle.key);
  const storeQuestions = useStore(handle.store, (s) => s.questions.some((q) => !q.answered));
  const storeWorking = useStore(handle.store, (s) => s.agentWorking !== null);
  // Which source is FRESH follows the stream: a connected tab's own SSE is
  // push (instant), so it joins the hub map in a union - set-fast from the
  // push side, cleared within a poll tick. A disconnected (evicted) tab's
  // store is FROZEN at eviction time; unioning it in would hold a stale dot
  // forever, so only the hub speaks for it (M3.1) - with the frozen store as
  // the last resort when the hub has no entry at all.
  const live = handle.connected();
  const state = attentionStateOf({
    openQuestions: live
      ? Math.max(hubEntry?.openQuestions ?? 0, storeQuestions ? 1 : 0)
      : (hubEntry?.openQuestions ?? (storeQuestions ? 1 : 0)),
    working: live
      ? (hubEntry?.working ?? false) || storeWorking
      : (hubEntry?.working ?? storeWorking),
    // The tab in FRONT is being looked at - unseen is a background-tab state
    // by definition (M3.2), and the marker map only knows hub-fed logs.
    unseen: !active && hubEntry !== undefined && isUnseen(hubEntry.lastEventSeq, viewed),
  });
  if (state === "question") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test="tab-attention"
              data-kind="question"
              role="img"
              aria-label="A question is waiting on you"
              className="size-1.5 bg-user"
            />
          }
        />
        <TooltipContent>A question is waiting on you</TooltipContent>
      </Tooltip>
    );
  }
  if (state === "working") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test="tab-attention"
              data-kind="working"
              role="img"
              aria-label="The agent is working"
              className="size-1.5 animate-pulse bg-agent"
            />
          }
        />
        <TooltipContent>The agent is working</TooltipContent>
      </Tooltip>
    );
  }
  if (state === "finished-unseen") {
    // The forever-tick is retired (M3.2): what used to be a permanent ✓ on
    // every approved tab is now a marker that means "something landed here
    // since you last looked", and the human arriving clears it.
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test="tab-attention"
              data-kind="unseen"
              role="img"
              aria-label="Finished while you were away"
              className="size-1.5 bg-accent-bright"
            />
          }
        />
        <TooltipContent>Finished while you were away</TooltipContent>
      </Tooltip>
    );
  }
  return null;
};

const Tab = ({ sessionKey, active }: { readonly sessionKey: string; readonly active: boolean }) => {
  const handle = getSession(sessionKey);
  const ref = useRef<HTMLDivElement>(null);
  // Reachability, centralised (plan 03, M2.3 / R1): EVERY activation path -
  // click, palette, picker, ⌘digit/bracket, ?s= boot, CLI open, close
  // promotion - funnels through `activate` flipping exactly one tab to
  // active, so this one effect is the single line that guarantees the active
  // tab is never parked outside the scrollable strip's viewport. It runs on
  // the render that MAKES the tab active, so a tab that did not exist a tick
  // ago (a fresh open) is scrolled once it is real - no DOM query races.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active]);
  if (!handle) return null;
  // Title only (D-012): the project a colliding name used to carry as a
  // qualifier is the GROUP heading's job now; the tooltip carries the path.
  const label = tabLabel({ key: sessionKey, name: handle.config.name });
  return (
    <div
      ref={ref}
      data-test="shell-tab"
      data-active={active ? "true" : "false"}
      className={`group -ml-px flex min-w-0 max-w-[220px] flex-none items-center gap-1.5 border-x border-ink-600 px-3 text-[12px] ${
        active
          ? "bg-ink-850 text-fg-strong shadow-[inset_0_2px_0_var(--color-accent)]"
          : "bg-ink-900 text-fg-muted hover:bg-ink-800 hover:text-fg"
      }`}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => activateTab(sessionKey)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[7px]"
            >
              <TabAttention handle={handle} />
              <span className="truncate">{label}</span>
            </button>
          }
        />
        <TooltipContent>{handle.key}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-test="tab-close"
              aria-label={`Close ${handle.config.name}`}
              onClick={() => closeTab(sessionKey)}
              className={`${closeButtonSmall} group-hover:opacity-100 focus-visible:opacity-100 ${
                active ? "opacity-100" : "opacity-0"
              }`}
            >
              ×
            </button>
          }
        />
        <TooltipContent>Close tab (the session keeps running)</TooltipContent>
      </Tooltip>
    </div>
  );
};

/**
 * Create from nothing (D3): opens the new-artifact dialog. Deliberately
 * UNGATED - the dialog answers both ways this can be unavailable, and answers
 * them better than a missing button does: it carries its own folder chooser
 * when no project holds a session yet, and it names `--attend` when the hub
 * cannot spawn. Hiding it until the listing was non-empty left the one state
 * that needs an invitation as the only state without one.
 */
const NewArtifactButton = ({
  testId,
  className,
  before,
}: {
  readonly testId: string;
  readonly className: string;
  /** Ran before the dialog opens - the drawer closes itself on its way out. */
  readonly before?: () => void;
}) => {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-test={testId}
            onClick={(e) => {
              e.currentTarget.blur();
              before?.();
              setCreateOpen(true);
            }}
            className={className}
          >
            New artifact
          </button>
        }
      />
      <TooltipContent>Ask an agent to author a new artifact here</TooltipContent>
    </Tooltip>
  );
};

/** The "+" opener: a NEW-TAB gesture, not a dropdown. It deselects the
 *  current tab, which lands the shell on the full-screen pick-a-session
 *  page (the same screen a fresh shell shows) - the way a browser's + gives
 *  a whole new-tab page. Existing tabs stay in the bar to click back to. */
const NewTabButton = () => (
  <Tooltip>
    <TooltipTrigger
      render={
        <button
          type="button"
          data-test="tab-add"
          aria-label="New tab - pick a session (⌘K also works)"
          // Blur on activation: the pick screen takes over, and a focus ring left
          // burning on the + reads as a stuck state. The keyboard path to this
          // screen is ⌘K, so nothing is lost by not holding focus here.
          onClick={(e) => {
            e.currentTarget.blur();
            useShell.setState({ activeKey: null });
          }}
          className="cursor-pointer px-3 py-[7px] text-[14px] leading-none text-fg-muted outline-none hover:bg-ink-800 hover:text-fg"
        >
          +
        </button>
      }
    />
    <TooltipContent>New tab - pick a session (⌘K also works)</TooltipContent>
  </Tooltip>
);

/** The pick screen's own actions: quiet accent links, sized to the copy they
 *  sit beside - never buttons competing with the session list. */
const emptyAction =
  "cursor-pointer text-[11px] text-accent-bright underline-offset-2 outline-none hover:underline disabled:cursor-default disabled:opacity-50";

const EmptyShell = () => {
  const allSessions = useHub((s) => s.sessions);
  const loaded = useHub((s) => s.loaded);
  const roots = useHub((s) => s.roots);
  const openKeys = useShell((s) => s.sessionKeys);
  // What this screen offers is what you can OPEN. An artifact that is already
  // a tab is not an option - picking it would just switch to the tab sitting
  // a few pixels above. Same rule a browser's new-tab page follows: it shows
  // where you can go, not where you are.
  const { openable: sessions } = openSplit(allSessions, openKeys);
  /** Everything known is already a tab: a different state from "nothing here",
   *  and it must not borrow that screen's copy. */
  const allOpen = sessions.length === 0 && allSessions.length > 0;
  // Until the first listing lands the truthful state is LOOKING, not empty -
  // claiming "no sessions" mid-scan told the human to go run a command.
  // pt-[12vh], not vertical centering: this screen and the ⌘K palette are
  // the same gesture (pick a session), so they hold the same eye line - and
  // a list anchored near the top does not jump around as it grows.
  if (!loaded) {
    return (
      <div className="flex min-h-0 flex-1 justify-center bg-ink-850 pt-[12vh]">
        <div className="text-[12px] italic text-fg-faint">Looking for sessions…</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-4 bg-ink-850 pt-[12vh]">
      {sessions.length > 0 ? (
        <>
          <div className="flex items-baseline gap-3">
            <div className="text-[13px] text-fg-muted">Open a session to review.</div>
            <AddFolder className={emptyAction} />
            <NewArtifactButton testId="new-artifact" className={emptyAction} />
          </div>
          {/* The unified session list (M4.1, D-019): the same component the ⌘K
              palette mounts over its backdrop, here inline with an undebounced
              fuzzy filter (D-020) whose value folds the project name in. */}
          <Command
            data-test="picker"
            label="Pick a session"
            className="flex max-h-[60vh] w-[560px] max-w-[calc(100vw-48px)] flex-col border border-ink-600 bg-ink-800"
          >
            <Command.Input
              data-test="picker-filter"
              placeholder="Filter sessions…"
              className="w-full border-b border-ink-600 bg-bg-inset px-3 py-2 font-sans text-[13px] text-fg outline-none placeholder:text-fg-faint"
            />
            <Command.List className="snap-y snap-proximity scroll-pt-9 overflow-y-auto pb-1">
              <Command.Empty className="px-3 py-4 text-[12px] italic text-fg-faint">
                No session matches.
              </Command.Empty>
              <SessionListGroups includeOpen={false} />
            </Command.List>
          </Command>
        </>
      ) : allOpen ? (
        // Everything in scope is already a tab. Saying "no reviews here yet"
        // would be a lie about a project full of them, and the way forward is
        // the strip above, not this screen.
        <>
          <div data-test="all-open" className="text-[13px] text-fg-muted">
            Every session is already open.
          </div>
          <div className="max-w-[440px] text-center text-[12px] leading-relaxed text-fg-faint">
            Pick one from the tab strip above.
          </div>
          <div className="flex items-baseline gap-3">
            <AddFolder className={emptyAction} />
            <NewArtifactButton testId="new-artifact" className={emptyAction} />
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] text-fg-muted">No reviews here yet.</div>
          {/* The human's agent is who starts sessions - when it renders an
              artifact and runs `lucid open`, a tab appears here on its own.
              The command is a footnote, not the instruction. */}
          <div className="max-w-[440px] text-center text-[12px] leading-relaxed text-fg-faint">
            Ask your coding agent to render something reviewable - a plan, a comparison, a schema.
            When it opens the artifact, the session appears here as a tab.
            <br />
            (By hand: <code className="bg-ink-700 px-1">lucid open &lt;artifact&gt;.html</code>)
          </div>
          {/* Where it LOOKED, and how to correct that. An empty listing is
              usually a wrong root rather than an absent history - artifacts
              live wherever the agent wrote them, which is often not ~/dev -
              so the folder chooser belongs on THIS screen, not only in a
              dialog that opens once a session already exists. */}
          <div className="flex flex-col items-center gap-2 border-t border-ink-700 pt-4">
            <div className="max-w-[460px] text-center text-[11px] leading-relaxed text-fg-faint">
              {roots.length > 0 ? (
                <>
                  Looking in{" "}
                  {roots.map((r, i) => (
                    <span key={r}>
                      {i > 0 ? ", " : ""}
                      <code className="bg-ink-700 px-1">{r}</code>
                    </span>
                  ))}
                  {" - project checkouts and agent scratchpads. Work kept somewhere else? "}
                  Add it and the reviews already inside it appear here.
                </>
              ) : (
                <>Add a project and any reviews already inside it appear here.</>
              )}
            </div>
            <div className="flex flex-col items-center gap-2">
              <AddFolder className={emptyAction} />
              <NewArtifactButton testId="new-artifact" className={emptyAction} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

/** The fade marker wears the hidden dot's own color (D-023): a question is the
 *  human's color, working the agent's, unseen the accent - same mapping the
 *  dots themselves use. */
const FADE_KIND_COLOR: Record<string, string> = {
  question: "bg-user",
  working: "bg-agent",
  unseen: "bg-accent-bright",
};

/**
 * The grouped tab strip (plan 03, M2.2): one row, every open tab, grouped by
 * project. Each run is headed by an INERT group label (D-022 - a heading, not
 * a control; the scope machinery it might resurrect is deleted), a hairline
 * rule separates groups, and an edge fade appears only while content actually
 * extends past that edge (D-013) - a fade over nothing would claim hidden tabs
 * that do not exist.
 */
const TabStrip = () => {
  const sessionKeys = useShell((s) => s.sessionKeys);
  const activeKey = useShell((s) => s.activeKey);
  const sessions = useHub((s) => s.sessions);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [fades, setFades] = useState({ left: false, right: false });
  /** Attention dots hidden past an edge (D-023): the fade on that side wears a
   *  marker IN THE HIDDEN DOT'S OWN KIND, so an off-screen working tab is not
   *  dressed as a question. Null = nothing hidden on that side. */
  const [hiddenAttn, setHiddenAttn] = useState<{
    left: string | null;
    right: string | null;
  }>({ left: null, right: null });

  const groups = groupTabs(sessionKeys, sessions);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      const left = el.scrollLeft > 0;
      // -1: fractional scroll widths round; a strip that fits must read as fitting.
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setFades((f) => (f.left === left && f.right === right ? f : { left, right }));
      // Which side hides attention, and of what KIND: a tab wearing a dot
      // whose box sits fully outside the visible window. offsetLeft is layout
      // position - unaffected by the scroll - so [scrollLeft, scrollLeft +
      // clientWidth] is the window. When several kinds hide on one side the
      // marker wears the most urgent (the resolver's own order).
      const rank: Record<string, number> = { question: 3, working: 2, unseen: 1 };
      let attnLeft: string | null = null;
      let attnRight: string | null = null;
      for (const dot of el.querySelectorAll('[data-test="tab-attention"]')) {
        const tab = dot.closest('[data-test="shell-tab"]') as HTMLElement | null;
        if (!tab) continue;
        const kind = dot.getAttribute("data-kind") ?? "unseen";
        if (tab.offsetLeft + tab.offsetWidth < el.scrollLeft) {
          if ((rank[kind] ?? 0) > (rank[attnLeft ?? ""] ?? 0)) attnLeft = kind;
        } else if (tab.offsetLeft > el.scrollLeft + el.clientWidth) {
          if ((rank[kind] ?? 0) > (rank[attnRight ?? ""] ?? 0)) attnRight = kind;
        }
      }
      setHiddenAttn((a) =>
        a.left === attnLeft && a.right === attnRight ? a : { left: attnLeft, right: attnRight },
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Content width moves without a scroll or resize event when a tab opens
    // or closes; watching the scroller's children catches exactly that.
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  return (
    <div
      data-test="shell-tabbar"
      className="relative flex h-9 flex-none items-stretch border-b border-ink-600 bg-ink-900"
    >
      <div ref={scrollRef} className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {groups.map((group, i) => {
          // A tab the listing has not placed yet groups under its own key
          // (groupTabs's fallback): it gets no heading rather than a nonsense
          // one, and earns its project's the moment the listing lands.
          const placed = !group.keys.includes(group.project);
          return (
            <div key={group.project} data-test="tab-group" className="flex flex-none items-stretch">
              {i > 0 ? (
                <div aria-hidden className="w-px flex-none self-stretch bg-ink-500" />
              ) : null}
              {placed ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        data-test="group-label"
                        className="max-w-[110px] flex-none cursor-default self-center truncate pl-3 pr-1.5 text-[9px] font-semibold uppercase tracking-[1.1px] text-fg-faint"
                      >
                        {projectName(group.project)}
                      </span>
                    }
                  />
                  <TooltipContent>{group.project}</TooltipContent>
                </Tooltip>
              ) : null}
              {group.keys.map((k) => (
                <Tab key={k} sessionKey={k} active={k === activeKey} />
              ))}
            </div>
          );
        })}
        <NewTabButton />
      </div>
      {fades.left ? (
        <div
          data-test="tabbar-fade-left"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center bg-gradient-to-r from-ink-900 to-transparent"
        >
          {hiddenAttn.left !== null ? (
            <span
              data-test="fade-attention"
              data-side="left"
              data-kind={hiddenAttn.left}
              className={`ml-1 size-1.5 ${FADE_KIND_COLOR[hiddenAttn.left] ?? "bg-accent-bright"}`}
            />
          ) : null}
        </div>
      ) : null}
      {fades.right ? (
        <div
          data-test="tabbar-fade-right"
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 flex w-8 items-center justify-end bg-gradient-to-l from-ink-900 to-transparent"
        >
          {hiddenAttn.right !== null ? (
            <span
              data-test="fade-attention"
              data-side="right"
              data-kind={hiddenAttn.right}
              className={`mr-1 size-1.5 ${FADE_KIND_COLOR[hiddenAttn.right] ?? "bg-accent-bright"}`}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const Shell = () => {
  const sessionKeys = useShell((s) => s.sessionKeys);
  const activeKey = useShell((s) => s.activeKey);
  const viewedSeq = useShell((s) => s.viewedSeq);
  const sessions = useHub((s) => s.sessions);
  const bootHandled = useRef(false);
  const restoreHandled = useRef(false);

  useEffect(() => {
    connectHub();
  }, []);

  // A reload restores the window you had: the tabs that were open, the one in
  // front, and the scope. Held in memory alone, ⌘R - the most ordinary gesture
  // there is - threw all of it away and dropped you on the pick screen.
  // Sessions that no longer exist are simply not reopened.
  useEffect(() => {
    if (restoreHandled.current || sessions.length === 0) return;
    restoreHandled.current = true;
    const stored = readStoredTabs();
    if (stored.keys.length === 0) return;
    const byArtifact = new Map(sessions.map((s) => [s.artifact, s]));
    void (async () => {
      // BACKGROUND opens (M3.2): restoring a window is not arriving at its
      // tabs. A foreground open records a viewed mark per tab, which would
      // wipe every unseen badge on the most ordinary gesture there is (⌘R).
      // Only the tab that ends up in FRONT is arrived at.
      const restored: string[] = [];
      for (const key of stored.keys) {
        const row = byArtifact.get(key);
        if (row && (await openTab(row, { background: true })) !== null) restored.push(key);
      }
      const active =
        stored.active !== null && byArtifact.has(stored.active)
          ? stored.active
          : (restored.at(-1) ?? null);
      if (active !== null) activateTab(active);
    })();
  }, [sessions]);

  // Any change to the tab set - or the per-machine viewed marks (M3.2) - is
  // worth remembering, including the restore above. Marks are pruned to the
  // artifacts still known (listed or open), so the map cannot grow forever.
  useEffect(() => {
    if (!restoreHandled.current) return;
    const known = new Set([...sessions.map((s) => s.artifact), ...sessionKeys]);
    persistTabs({ keys: sessionKeys, active: activeKey, viewed: viewedSeq }, known);
  }, [sessionKeys, activeKey, viewedSeq, sessions]);

  // `?s=<id>`: the tab `lucid open` asked for, honored once the listing
  // names it. Consumed only on SUCCESS - a transient identity miss leaves it
  // pending, so the next listing snapshot retries instead of stranding an
  // empty shell. After it lands, the human owns the tab set.
  useEffect(() => {
    if (bootHandled.current) return;
    const wanted = new URLSearchParams(window.location.search).get("s");
    if (!wanted) {
      bootHandled.current = true;
      return;
    }
    const row = sessions.find((s) => s.id === wanted);
    if (row) {
      void openTab(row).then((handle) => {
        if (handle) bootHandled.current = true;
      });
    }
  }, [sessions]);

  // The shell's own keyboard: ⌘K palette, ⌘W close the current tab, ⌘1-9 jump
  // to tab N, ⌘⇧[ / ⌘⇧] step tabs.
  //
  // The MAP is `resolveShortcut` (keymap.ts) - a pure function from chord and
  // tab state to a decision - so the table can be exercised without a browser.
  // This effect owns only the wiring: reading live state, carrying the
  // decision out, and preventing the default exactly when the gesture is ours.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The same bail `resolveShortcut` opens with, repeated here on purpose.
      // This handler sees EVERY keystroke, including every character typed in
      // the composer, and everything below it reads two stores and rebuilds
      // the visible strip. Without this line that work happens per character.
      // `resolveShortcut` still owns the rule - this is a cheap pre-filter that
      // can only ever skip chords the map would have answered `none` to.
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const { sessionKeys: all, activeKey: current } = useShell.getState();
      const action = resolveShortcut(e, {
        keys: [...all], // the whole strip - ⌘1-9 and brackets index every tab
        activeKey: current,
      });
      if (action.kind === "none") return;
      e.preventDefault();
      if (action.kind === "palette") {
        setPaletteOpen(!useHub.getState().paletteOpen);
        return;
      }
      if (action.kind === "close") {
        closeTab(action.key);
        return;
      }
      activateTab(action.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const active = activeKey !== null ? getSession(activeKey) : undefined;

  return (
    // --lucid-shell-top: the tab bar's exact footprint (h-9 + 1px border).
    // The vendored sidebar's fixed container anchors below it; without this
    // the panel would cover the bar and swallow its clicks.
    <div
      className="flex h-screen flex-col"
      style={{ "--lucid-shell-top": "37px" } as React.CSSProperties}
    >
      <TabStrip />
      <Palette />
      <CreateDialog />
      {/* EVERY open tab's view stays mounted; the inactive ones hide with
          display:none (drafts survive switching). Only the active view takes
          window listeners. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {sessionKeys.map((k) => {
          const handle = getSession(k);
          if (!handle) return null;
          const isActive = k === activeKey;
          return (
            <div key={k} className={isActive ? "min-h-0 flex-1" : "hidden"}>
              <SessionView session={handle} shell active={isActive} />
            </div>
          );
        })}
        {active ? null : <EmptyShell />}
      </div>
    </div>
  );
};
