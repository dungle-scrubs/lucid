import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { AddFolder } from "./AddFolder.tsx";
import { SessionView } from "./Chrome.tsx";
import { CreateDialog } from "./CreateDialog.tsx";
import {
  activateTab,
  artifactLabel,
  byProject,
  closeTab,
  connectHub,
  openProject,
  openTab,
  projectName,
  sessionLabel,
  setCreateOpen,
  setPaletteOpen,
  useHub,
  visibleTabKeys,
  type HubSession,
} from "./hub.ts";
import { Palette } from "./Palette.tsx";
import type { SessionHandle } from "./session.ts";
import { getSession, setDrawerOpen, useShell } from "./shell.ts";
import { Kbd } from "./ui/kbd.tsx";
import { closeButton, closeButtonSmall } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

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
  if (working) {
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
  if (resolved) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test="tab-attention"
              data-kind="approved"
              role="img"
              aria-label="Approved"
              className="text-[10px] leading-none text-agent"
            >
              ✓
            </span>
          }
        />
        <TooltipContent>Approved</TooltipContent>
      </Tooltip>
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

/**
 * The projects drawer (D7): GTM-style - slides in from the left, OVERLAYS
 * the content, and parallaxes it right while open. Projects list with
 * session counts; worktrees group under their main repo with a qualifier.
 * Selecting a project scopes the tab strip (D8) and OPENS the project: every
 * artifact in it becomes a tab, newest active.
 */
const ProjectsDrawer = () => {
  const open = useShell((s) => s.drawerOpen);
  const activeProject = useShell((s) => s.activeProject);
  const sessions = useHub((s) => s.sessions);

  // Picking a project OPENS it - every artifact in it as a tab - rather than
  // offering a second list to pick from.
  const pick = (project: string): void => {
    void openProject(project);
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
          <span className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-faint">
              Projects
            </span>
            {/* At the TOP of the list it adds to, as an icon: the way to point
                Lucid at a folder it has not scanned. */}
            <AddFolder icon />
          </span>
          {/* Click-away and the scope badge both close it too, but a drawer with no visible
              exit reads as a trap. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-test="drawer-close"
                  aria-label="Close the projects drawer"
                  onClick={() => setDrawerOpen(false)}
                  className={closeButton}
                >
                  ×
                </button>
              }
            />
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
        {[...byProject(sessions)].map(([project, rows]) => {
          const isActive = project === activeProject;
          const worktrees = new Set(rows.map((r) => r.worktree).filter(Boolean));
          return (
            <Tooltip key={project}>
              <TooltipTrigger
                render={
                  <button
                    key={project}
                    type="button"
                    data-test="drawer-project"
                    data-active={isActive ? "true" : "false"}
                    onClick={() => pick(project)}
                    className={`flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left ${
                      isActive
                        ? "bg-ink-700 shadow-[inset_2px_0_0_var(--color-accent)]"
                        : "hover:bg-ink-700"
                    }`}
                  >
                    {/* The name truncates and the count never moves: a long project
                        name that wrapped would otherwise shove its own count onto a
                        second line. */}
                    <span className="flex w-full items-baseline gap-2">
                      <span className="min-w-0 truncate text-[12px] font-semibold text-fg">
                        {projectName(project)}
                      </span>
                      <span className="flex-none text-[10px] tabular-nums text-fg-faint">
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
                }
              />
              <TooltipContent>{project}</TooltipContent>
            </Tooltip>
          );
        })}
      </aside>
    </>
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

const PickerRow = ({ row, subtitle }: { readonly row: HubSession; readonly subtitle?: string }) => {
  const [failed, setFailed] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-test="picker-row"
            onClick={() => {
              // openTab activates on success, which swaps the pick screen away on
              // its own; a failure keeps the screen and says so on the row.
              void openTab(row).then((h) => {
                if (!h) setFailed(true);
              });
            }}
            className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-ink-700"
          >
            <span className="truncate text-[12px] text-fg">{sessionLabel(row)}</span>
            <span className="truncate text-[10px] text-fg-faint">
              {failed
                ? "couldn't open - is the session's log readable?"
                : (subtitle ?? row.artifact)}
            </span>
          </button>
        }
      />
      <TooltipContent>{row.artifact}</TooltipContent>
    </Tooltip>
  );
};

/** The pick screen's own actions: quiet accent links, sized to the copy they
 *  sit beside - never buttons competing with the session list. */
const emptyAction =
  "cursor-pointer text-[11px] text-accent-bright underline-offset-2 outline-none hover:underline disabled:cursor-default disabled:opacity-50";

const EmptyShell = () => {
  const allSessions = useHub((s) => s.sessions);
  const loaded = useHub((s) => s.loaded);
  const roots = useHub((s) => s.roots);
  const activeProject = useShell((s) => s.activeProject);
  const openKeys = useShell((s) => s.sessionKeys);
  // Scoped like the strip (D8): inside a project, its artifacts; the way out
  // is explicit, not implied.
  const inScope =
    activeProject === null ? allSessions : allSessions.filter((s) => s.project === activeProject);
  // What this screen offers is what you can OPEN. An artifact that is already
  // a tab is not an option - picking it would just switch to the tab sitting
  // a few pixels above, and on a project with everything open the list read
  // as a menu of things you already had. Same rule a browser's new-tab page
  // follows: it shows where you can go, not where you are.
  const open = new Set(openKeys);
  const sessions = inScope.filter((s) => !open.has(s.artifact));
  /** Everything in scope is already a tab: a different state from "nothing
   *  here", and it must not borrow that screen's copy. */
  const allOpen = sessions.length === 0 && inScope.length > 0;
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
                ? "Open a session to review."
                : `Open an artifact in ${projectName(activeProject)}.`}
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
            <NewArtifactButton testId="new-artifact" className={emptyAction} />
          </div>
          <div className="flex max-h-[60vh] w-[560px] max-w-[calc(100vw-48px)] flex-col overflow-y-auto border border-ink-600 bg-ink-800 py-1">
            {[...byProject(sessions)].map(([project, rows], group) => (
              <div
                key={project}
                data-test="picker-project"
                // A RULE between groups, not just space: one unbroken run of
                // rows with a faint heading every few lines gave the eye
                // nothing to catch, and the headings read as row subtitles.
                className={group > 0 ? "mt-1.5 border-t border-ink-600 pt-1" : ""}
              >
                {/* Sticky, so the project owning the rows you are looking at
                    stays named while the list scrolls. Stacked, not
                    side-by-side: a long name wrapped to a second line while
                    the path sat beside its first, which read as a fault.

                    A BAND, not an item: darker than the list it heads, ruled
                    off below, small caps, and no hover. At row weight it read
                    as the first clickable thing in each group - the one thing
                    a section label must never look like. */}
                <div className="sticky top-0 z-10 flex cursor-default flex-col gap-px border-b border-ink-700 bg-ink-900 px-3 pt-1.5 pb-1">
                  <span className="text-[9px] font-semibold uppercase tracking-[1.1px] text-fg-muted">
                    {projectName(project)}
                  </span>
                  <span className="truncate text-[9px] text-fg-faint">{project}</span>
                </div>
                {rows.map((s) => (
                  <PickerRow key={s.id} row={s} subtitle={artifactLabel(s.artifact, project)} />
                ))}
              </div>
            ))}
          </div>
        </>
      ) : allOpen ? (
        // Everything in scope is already a tab. Saying "no reviews here yet"
        // would be a lie about a project full of them, and the way forward is
        // the strip above, not this screen.
        <>
          <div data-test="all-open" className="text-[13px] text-fg-muted">
            {activeProject === null
              ? "Every session is already open."
              : `Every artifact in ${projectName(activeProject)} is already open.`}
          </div>
          <div className="max-w-[440px] text-center text-[12px] leading-relaxed text-fg-faint">
            Pick one from the tab strip above{activeProject === null ? "" : ", or widen the scope"}.
          </div>
          <div className="flex items-baseline gap-3">
            {activeProject !== null ? (
              <button
                type="button"
                data-test="scope-clear"
                onClick={() => useShell.setState({ activeProject: null })}
                className={emptyAction}
              >
                all projects
              </button>
            ) : null}
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

export const Shell = () => {
  const sessionKeys = useShell((s) => s.sessionKeys);
  const activeKey = useShell((s) => s.activeKey);
  const activeProject = useShell((s) => s.activeProject);
  const drawerOpen = useShell((s) => s.drawerOpen);
  const sessions = useHub((s) => s.sessions);
  const bootHandled = useRef(false);

  // The strip is project-scoped (D8), and always includes the ACTIVE tab -
  // see visibleTabKeys for why that second half matters.
  const visibleKeys = visibleTabKeys(sessionKeys, sessions, activeProject, activeKey);

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

  // The shell's own keyboard: ⌘K palette, ⌘W close the current tab, ⌘1-9 jump
  // to tab N, ⌘⇧[ / ⌘⇧] step tabs.
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
      const keys = visibleTabKeys(all, rows, proj, current);
      // ⌘W closes the ARTIFACT in front of you, which is what the gesture means
      // in a tabbed window - the session keeps running, exactly as the × does.
      if (!e.shiftKey && (e.key === "w" || e.key === "W")) {
        if (current !== null) {
          e.preventDefault();
          closeTab(current);
        }
        return;
      }
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
        {/* The one drawer control: a scope BADGE, not a tab cell - a
            frost-tinted rectangle floating in the bar rather than filling
            it, so nothing about it reads as a disabled sibling of the tabs.
            It names the scoped project (or "Projects" unscoped) and toggles
            the drawer that switches projects. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-test="drawer-toggle"
                aria-expanded={drawerOpen}
                onClick={(e) => {
                  e.currentTarget.blur();
                  // A toggle: the control that opened the drawer must also be able
                  // to close it.
                  setDrawerOpen(!useShell.getState().drawerOpen);
                }}
                className="mx-2 flex flex-none cursor-pointer items-center gap-1 self-center border border-accent/40 bg-accent/10 px-2.5 py-px text-[10px] font-semibold uppercase tracking-[0.8px] text-accent-bright outline-none hover:border-accent hover:bg-accent/20"
              >
                {activeProject !== null ? (
                  <span data-test="scope-label">{projectName(activeProject)}</span>
                ) : (
                  "Projects"
                )}
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
            }
          />
          <TooltipContent>
            {activeProject !== null ? `${activeProject} - switch project` : "Projects"}
          </TooltipContent>
        </Tooltip>
        {visibleKeys.map((k) => (
          <Tab key={k} sessionKey={k} active={k === activeKey} />
        ))}
        <NewTabButton />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-test="palette-hint"
                onClick={() => setPaletteOpen(true)}
                className="ml-auto flex flex-none cursor-pointer items-center gap-1 pr-3 text-[10px] text-fg-faint hover:text-fg"
              >
                <Kbd>⌘K</Kbd> everywhere
              </button>
            }
          />
          <TooltipContent>Command palette (⌘K)</TooltipContent>
        </Tooltip>
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
