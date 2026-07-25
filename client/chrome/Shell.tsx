import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { SessionView } from "./Chrome.tsx";
import {
  activateTab,
  closeTab,
  connectHub,
  openTab,
  setPaletteOpen,
  setPickerOpen,
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

/** The "+" opener: every session the hub knows about, minus the open tabs.
 *  The command palette (Phase 3) subsumes this list; it stays as the
 *  pointer-first path. */
const Picker = () => {
  const sessions = useHub((s) => s.sessions);
  const open = useHub((s) => s.pickerOpen);
  const openKeys = useShell((s) => s.sessionKeys);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const candidates = sessions.filter((s) => !openKeys.includes(s.artifact));

  return (
    <div ref={ref} className="relative flex flex-none items-center">
      <button
        type="button"
        data-test="tab-add"
        title="Open a session"
        aria-expanded={open}
        onClick={() => setPickerOpen(!open)}
        className="cursor-pointer px-3 py-[7px] text-[14px] leading-none text-fg-muted hover:bg-ink-800 hover:text-fg"
      >
        +
      </button>
      {open ? (
        <div
          data-test="session-picker"
          className="absolute left-0 top-full z-20 max-h-[60vh] w-[340px] overflow-y-auto border border-ink-500 bg-ink-800 py-1 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        >
          {candidates.length === 0 ? (
            <div className="px-3 py-2 text-[12px] italic text-fg-faint">
              Every known session is already open.
            </div>
          ) : (
            candidates.map((s) => <PickerRow key={s.id} row={s} />)
          )}
        </div>
      ) : null}
    </div>
  );
};

const PickerRow = ({ row }: { readonly row: HubSession }) => {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      data-test="picker-row"
      title={row.artifact}
      onClick={() => {
        void openTab(row).then((h) => {
          if (h) setPickerOpen(false);
          else setFailed(true);
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

const EmptyShell = () => {
  const sessions = useHub((s) => s.sessions);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 bg-ink-850">
      <div className="text-[13px] text-fg-muted">No session open.</div>
      {sessions.length > 0 ? (
        <div className="flex max-h-[50vh] w-[380px] flex-col overflow-y-auto border border-ink-600 bg-ink-800 py-1">
          {sessions.map((s) => (
            <PickerRow key={s.id} row={s} />
          ))}
        </div>
      ) : (
        <div className="text-[12px] text-fg-faint">
          Run <code className="bg-ink-700 px-1">lucid open &lt;file&gt;</code> in a project to start
          one.
        </div>
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
  // names it. One-shot - after that the human owns the tab set.
  useEffect(() => {
    if (bootHandled.current) return;
    const wanted = new URLSearchParams(window.location.search).get("s");
    if (!wanted) {
      bootHandled.current = true;
      return;
    }
    const row = sessions.find((s) => s.id === wanted);
    if (row) {
      bootHandled.current = true;
      void openTab(row);
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
        <Picker />
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
      {active ? (
        <div className="min-h-0 flex-1">
          <SessionView key={active.key} session={active} shell />
        </div>
      ) : (
        <EmptyShell />
      )}
    </div>
  );
};
