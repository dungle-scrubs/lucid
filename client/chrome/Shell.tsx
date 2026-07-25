import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { SessionView } from "./Chrome.tsx";
import { CreateDialog } from "./CreateDialog.tsx";
import {
  activateTab,
  byProject,
  closeTab,
  connectHub,
  createRoots,
  latestTabIn,
  openTab,
  projectName,
  setCreateOpen,
  setPaletteOpen,
  useHub,
  type HubSession,
} from "./hub.ts";
import { Palette } from "./Palette.tsx";
import type { SessionHandle } from "./session.ts";
import { getSession, setDrawerOpen, useShell } from "./shell.ts";
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
  const openKeys = useShell((s) => s.sessionKeys);
  const sessions = useHub((s) => s.sessions);
  if (!handle) return null;
  // Two open tabs named plan.html are indistinguishable; when names collide,
  // the tab carries its project (browser-style disambiguation). A tab stays
  // a SESSION - the project is just the qualifier.
  const collides = openKeys.some(
    (k) => k !== sessionKey && getSession(k)?.config.name === handle.config.name,
  );
  const project = collides ? sessions.find((s) => s.artifact === handle.key)?.project : undefined;
  const label = project ? `${handle.config.name} · ${projectName(project)}` : handle.config.name;
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
        <span className="truncate">{label}</span>
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

/**
 * Create from nothing (D3): opens the new-artifact dialog. Rendered only when
 * the hub has somewhere to put one - it accepts a project it already lists a
 * session in, so an empty listing has no target and a button would be a dead
 * end rather than an invitation.
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
  const sessions = useHub((s) => s.sessions);
  if (createRoots(sessions).length === 0) return null;
  return (
    <button
      type="button"
      data-test={testId}
      title="Ask an agent to author a new artifact here"
      onClick={(e) => {
        e.currentTarget.blur();
        before?.();
        setCreateOpen(true);
      }}
      className={className}
    >
      New artifact
    </button>
  );
};

/**
 * The projects drawer (D7): GTM-style - slides in from the left, OVERLAYS
 * the content, and parallaxes it right while open. Projects list with
 * session counts; worktrees group under their main repo with a qualifier.
 * Selecting a project scopes the tab strip (D8) and lands on its most
 * recent open tab, or the pick screen scoped to it.
 */
const ProjectsDrawer = () => {
  const open = useShell((s) => s.drawerOpen);
  const activeProject = useShell((s) => s.activeProject);
  const sessions = useHub((s) => s.sessions);

  const pick = (project: string): void => {
    const recent = latestTabIn(project);
    if (recent) {
      activateTab(recent);
    } else {
      useShell.setState({ activeProject: project, activeKey: null });
    }
    setDrawerOpen(false);
  };

  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close the projects drawer"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-x-0 bottom-0 top-(--lucid-shell-top,37px) z-30 cursor-default bg-ink-900/40"
        />
      ) : null}
      <aside
        data-test="projects-drawer"
        aria-hidden={!open}
        className={`fixed bottom-0 left-0 top-(--lucid-shell-top,37px) z-40 flex w-[340px] flex-col overflow-y-auto border-r border-ink-500 bg-ink-800 py-2 shadow-[8px_0_30px_rgba(0,0,0,0.45)] transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
            Projects
          </span>
          {/* Click-away and ☰ both close it too, but a drawer with no visible
              exit reads as a trap. */}
          <button
            type="button"
            data-test="drawer-close"
            aria-label="Close the projects drawer"
            title="Close"
            onClick={() => setDrawerOpen(false)}
            className="cursor-pointer rounded-full px-1.5 text-[13px] leading-none text-fg-faint hover:text-fg"
          >
            ×
          </button>
        </div>
        {[...byProject(sessions)].map(([project, rows]) => {
          const isActive = project === activeProject;
          const worktrees = new Set(rows.map((r) => r.worktree).filter(Boolean));
          return (
            <button
              key={project}
              type="button"
              data-test="drawer-project"
              data-active={isActive ? "true" : "false"}
              title={project}
              onClick={() => pick(project)}
              className={`flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left ${
                isActive
                  ? "bg-ink-700 shadow-[inset_2px_0_0_var(--color-accent)]"
                  : "hover:bg-ink-700"
              }`}
            >
              <span className="flex items-baseline gap-2">
                <span className="text-[12px] font-semibold text-fg">{projectName(project)}</span>
                <span className="text-[10px] tabular-nums text-fg-faint">
                  {rows.length} artifact{rows.length === 1 ? "" : "s"}
                </span>
              </span>
              <span className="truncate text-[10px] text-fg-faint">{project}</span>
              {worktrees.size > 0 ? (
                <span className="text-[10px] text-accent-bright">
                  +{worktrees.size} worktree{worktrees.size === 1 ? "" : "s"}
                </span>
              ) : null}
            </button>
          );
        })}
        {/* mt-auto: the way to start something new sits at the bottom of the
            list of what already exists, not competing with it. */}
        <NewArtifactButton
          testId="drawer-new-artifact"
          before={() => setDrawerOpen(false)}
          className="mt-auto cursor-pointer border-t border-ink-600 px-3 pt-2.5 pb-1 text-left text-[12px] text-fg-muted outline-none hover:text-accent-bright"
        />
      </aside>
    </>
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

const PickerRow = ({ row, subtitle }: { readonly row: HubSession; readonly subtitle?: string }) => {
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
        {failed ? "couldn't open - is the session's log readable?" : (subtitle ?? row.artifact)}
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
  const allSessions = useHub((s) => s.sessions);
  const loaded = useHub((s) => s.loaded);
  const activeProject = useShell((s) => s.activeProject);
  // Scoped like the strip (D8): inside a project, its artifacts; the way out
  // is explicit, not implied.
  const sessions =
    activeProject === null ? allSessions : allSessions.filter((s) => s.project === activeProject);
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
            <div className="text-[13px] text-fg-muted">
              {activeProject === null
                ? "Pick a session to review."
                : `Pick an artifact in ${projectName(activeProject)}.`}
            </div>
            {activeProject !== null ? (
              <button
                type="button"
                data-test="scope-clear"
                onClick={() => useShell.setState({ activeProject: null })}
                className="cursor-pointer text-[11px] text-fg-faint underline-offset-2 hover:text-fg hover:underline"
              >
                all projects
              </button>
            ) : null}
            <NewArtifactButton
              testId="new-artifact"
              className="cursor-pointer text-[11px] text-accent-bright underline-offset-2 outline-none hover:underline"
            />
          </div>
          <div className="flex max-h-[60vh] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-y-auto border border-ink-600 bg-ink-800 py-1">
            {[...byProject(sessions)].map(([project, rows]) => (
              <div key={project} data-test="picker-project">
                <div className="flex items-baseline gap-2 px-3 pt-2 pb-1">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-muted">
                    {projectName(project)}
                  </span>
                  <span className="truncate text-[10px] text-fg-faint">{project}</span>
                </div>
                {rows.map((s) => (
                  <PickerRow
                    key={s.id}
                    row={s}
                    subtitle={s.artifact.slice(project.length + 1) || s.name}
                  />
                ))}
              </div>
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
  const activeProject = useShell((s) => s.activeProject);
  const drawerOpen = useShell((s) => s.drawerOpen);
  const sessions = useHub((s) => s.sessions);
  const bootHandled = useRef(false);

  // The strip is project-scoped (D8): only the active project's tabs show.
  // A tab whose project the listing does not know yet stays visible rather
  // than vanishing mid-load.
  const projectOf = new Map(sessions.map((s) => [s.artifact, s.project]));
  const visibleKeys =
    activeProject === null
      ? sessionKeys
      : sessionKeys.filter((k) => (projectOf.get(k) ?? activeProject) === activeProject);

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
      // ⌘digits index the VISIBLE (project-scoped) strip, like the pointer.
      const { sessionKeys: all, activeKey: current, activeProject: proj } = useShell.getState();
      const rows = useHub.getState().sessions;
      const pOf = new Map(rows.map((r) => [r.artifact, r.project]));
      const keys = proj === null ? all : all.filter((k) => (pOf.get(k) ?? proj) === proj);
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
        <button
          type="button"
          data-test="drawer-toggle"
          title="Projects"
          aria-expanded={drawerOpen}
          onClick={(e) => {
            e.currentTarget.blur();
            setDrawerOpen(!drawerOpen);
          }}
          className={`cursor-pointer border-r border-ink-600 px-3 text-[13px] leading-none outline-none hover:bg-ink-800 ${
            drawerOpen ? "text-accent-bright" : "text-fg-muted hover:text-fg"
          }`}
        >
          ☰
        </button>
        {activeProject !== null ? (
          // A scope BADGE, not a tab cell: pill-shaped, frost-tinted, floating
          // in the bar rather than filling it - nothing about it may read as a
          // disabled sibling of the tabs. It names the project, so it opens
          // the drawer that switches projects.
          <button
            type="button"
            data-test="scope-label"
            title={`${activeProject} - switch project`}
            onClick={(e) => {
              e.currentTarget.blur();
              // A toggle, like the ☰ beside it: the control that opened the
              // drawer must also be able to close it.
              setDrawerOpen(!useShell.getState().drawerOpen);
            }}
            className="mx-2 flex flex-none cursor-pointer items-center gap-1 self-center rounded-full border border-accent/40 bg-accent/10 px-2.5 py-px text-[10px] font-semibold uppercase tracking-[0.8px] text-accent-bright outline-none hover:border-accent hover:bg-accent/20"
          >
            {projectName(activeProject)}
            <svg
              viewBox="0 0 24 24"
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        ) : null}
        {visibleKeys.map((k) => (
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
      <CreateDialog />
      {/* GTM-drawer parallax (D7): the drawer OVERLAYS this region, and the
          region also eases right while it is open - motion says "shifted
          aside", not "replaced". EVERY open tab's view stays mounted; the
          inactive ones hide with display:none (drafts survive switching).
          Only the active view takes window listeners. */}
      <div
        className={`flex min-h-0 flex-1 flex-col transition-transform duration-200 ease-out ${
          drawerOpen ? "translate-x-12" : "translate-x-0"
        }`}
      >
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
      <ProjectsDrawer />
    </div>
  );
};
