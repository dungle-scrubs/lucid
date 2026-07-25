import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { SessionView } from "./Chrome.tsx";
import {
  activateTab,
  closeTab,
  connectHub,
  openTab,
  setPaletteOpen,
  useHub,
  type HubSession,
} from "./hub.ts";
import { Palette } from "./Palette.tsx";
import type { SessionHandle } from "./session.ts";
import { getSession, useShell } from "./shell.ts";
import { Kbd } from "./ui/kbd.tsx";

/**
 * The shell: one window over every session (Model B). A tab bar across the
 * top - one tab per open session, each holding its own live handle - and the
 * active session's full view below it. The daemon serves this at `/`;
 * everything session-scoped rides `/s/<id>` on the same origin.
 */

/**
 * A tab's attention state, derived from its session's own store: the human
 * owes an answer (open questions), the agent is mid-revision, or the review
 * is settled. Primitive selectors, one per fact - a combined object selector
 * would defeat useSyncExternalStore's equality check.
 */
const TabAttention = ({ handle }: { readonly handle: SessionHandle }) => {
  const hasQuestions = useStore(handle.store, (s) => s.questions.some((q) => !q.answered));
  const working = useStore(handle.store, (s) => s.agentWorking !== null);
  const resolved = useStore(handle.store, (s) => s.reviewResolved);
  if (hasQuestions) {
    return (
      <span
        data-test="tab-attention"
        data-kind="question"
        title="A question is waiting on you"
        className="size-1.5 rounded-full bg-user"
      />
    );
  }
  if (working) {
    return (
      <span
        data-test="tab-attention"
        data-kind="working"
        title="The agent is working"
        className="size-1.5 animate-pulse rounded-full bg-agent"
      />
    );
  }
  if (resolved) {
    return (
      <span
        data-test="tab-attention"
        data-kind="approved"
        title="Approved"
        className="text-[10px] leading-none text-agent"
      >
        ✓
      </span>
    );
  }
  return null;
};

const Tab = ({ sessionKey, active }: { readonly sessionKey: string; readonly active: boolean }) => {
  const handle = getSession(sessionKey);
  if (!handle) return null;
  return (
    <div
      data-test="shell-tab"
      data-active={active ? "true" : "false"}
      className={`group flex min-w-0 max-w-[220px] flex-none items-center gap-1.5 border-r border-ink-600 px-3 text-[12px] ${
        active
          ? "bg-ink-850 text-fg-strong shadow-[inset_0_2px_0_var(--color-accent)]"
          : "bg-ink-900 text-fg-muted hover:bg-ink-800 hover:text-fg"
      }`}
    >
      <button
        type="button"
        title={handle.key}
        onClick={() => activateTab(sessionKey)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-[7px]"
      >
        <TabAttention handle={handle} />
        <span className="truncate">{handle.config.name}</span>
      </button>
      <button
        type="button"
        data-test="tab-close"
        aria-label={`Close ${handle.config.name}`}
        title="Close tab (the session keeps running)"
        onClick={() => closeTab(sessionKey)}
        className="cursor-pointer rounded-full px-[3px] text-fg-faint opacity-0 hover:text-fg group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
};

/** The "+" opener: a NEW-TAB gesture, not a dropdown. It deselects the
 *  current tab, which lands the shell on the full-screen pick-a-session
 *  page (the same screen a fresh shell shows) - the way a browser's + gives
 *  a whole new-tab page. Existing tabs stay in the bar to click back to. */
const NewTabButton = () => (
  <button
    type="button"
    data-test="tab-add"
    title="New tab - pick a session (⌘K also works)"
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
);

const PickerRow = ({ row }: { readonly row: HubSession }) => {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      data-test="picker-row"
      title={row.artifact}
      onClick={() => {
        // openTab activates on success, which swaps the pick screen away on
        // its own; a failure keeps the screen and says so on the row.
        void openTab(row).then((h) => {
          if (!h) setFailed(true);
        });
      }}
      className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-ink-700"
    >
      <span className="truncate text-[12px] text-fg">{row.name}</span>
      <span className="truncate text-[10px] text-fg-faint">
        {failed ? "couldn't open - is the session's log readable?" : row.artifact}
      </span>
    </button>
  );
};

/** The hub listing stream's health. Self-clearing like a session's own
 *  reconnect pill: EventSource retries by itself, so this states what is
 *  happening rather than asking for anything. */
const HubHealth = () => {
  const connected = useHub((s) => s.connected);
  if (connected) return null;
  return (
    <span
      data-test="hub-reconnecting"
      title="The hub connection dropped; retrying"
      className="flex flex-none items-center self-center rounded-full bg-ink-700 px-2 py-px text-[10px] text-steel-400"
    >
      hub reconnecting…
    </span>
  );
};

const EmptyShell = () => {
  const sessions = useHub((s) => s.sessions);
  const loaded = useHub((s) => s.loaded);
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
          <div className="text-[13px] text-fg-muted">Pick a session to review.</div>
          <div className="flex max-h-[50vh] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-y-auto border border-ink-600 bg-ink-800 py-1">
            {sessions.map((s) => (
              <PickerRow key={s.id} row={s} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] text-fg-muted">No reviews yet.</div>
          {/* The human's agent is who starts sessions - when it renders an
              artifact and runs `lucid open`, a tab appears here on its own.
              The command is a footnote, not the instruction. */}
          <div className="max-w-[440px] text-center text-[12px] leading-relaxed text-fg-faint">
            Ask your coding agent to render something reviewable - a plan, a comparison, a schema.
            When it opens the artifact, the session appears here as a tab.
            <br />
            (By hand: <code className="bg-ink-700 px-1">lucid open &lt;artifact&gt;.html</code>)
          </div>
        </>
      )}
    </div>
  );
};

export const Shell = () => {
  const sessionKeys = useShell((s) => s.sessionKeys);
  const activeKey = useShell((s) => s.activeKey);
  const sessions = useHub((s) => s.sessions);
  const bootHandled = useRef(false);

  useEffect(() => {
    connectHub();
  }, []);

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

  // The shell's own keyboard: ⌘K palette, ⌘1-9 jump to tab N, ⌘⇧[ / ⌘⇧]
  // step tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (!e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen(!useHub.getState().paletteOpen);
        return;
      }
      const { sessionKeys: keys, activeKey: current } = useShell.getState();
      const digit = Number.parseInt(e.key, 10);
      if (!e.shiftKey && Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const key = keys[digit - 1];
        if (key) {
          e.preventDefault();
          activateTab(key);
        }
        return;
      }
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        if (keys.length < 2 || current === null) return;
        e.preventDefault();
        const at = keys.indexOf(current);
        const step = e.code === "BracketRight" ? 1 : -1;
        const next = keys[(at + step + keys.length) % keys.length];
        if (next) activateTab(next);
      }
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
      <div
        data-test="shell-tabbar"
        className="flex h-9 flex-none items-stretch overflow-x-auto border-b border-ink-600 bg-ink-900"
      >
        {sessionKeys.map((k) => (
          <Tab key={k} sessionKey={k} active={k === activeKey} />
        ))}
        <NewTabButton />
        <HubHealth />
        <button
          type="button"
          data-test="palette-hint"
          title="Command palette (⌘K)"
          onClick={() => setPaletteOpen(true)}
          className="ml-auto flex flex-none cursor-pointer items-center gap-1 pr-3 text-[10px] text-fg-faint hover:text-fg"
        >
          <Kbd>⌘K</Kbd> everywhere
        </button>
      </div>
      <Palette />
      {/* EVERY open tab's view stays mounted; the inactive ones hide with
          display:none. This is what makes switching instant and what keeps
          assistant-ui's composer draft and pending attachments alive - that
          state is component-local and would die with an unmount. Only the
          active view takes window listeners (SessionView's `active`). */}
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
  );
};
