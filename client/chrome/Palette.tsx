import { Command } from "cmdk";
import { matchScore } from "./list.ts";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { addRoot, closeTab, setPaletteOpen, useHub } from "./hub.ts";
import { projectName } from "./naming.ts";
import { groupCls, itemCls, SessionListGroups } from "./SessionList.tsx";
import type { SessionHandle } from "./session.ts";
import { getSession, useShell } from "./shell.ts";

/**
 * The ⌘K command palette (cmdk): fuzzy over every session the hub knows plus
 * the review actions of the active one. It subsumes the old in-session
 * Sessions panel - the palette is how a keyboard reaches any session from
 * anywhere. Styled to the shell's own tokens (frost accent, mono, sharp
 * corners); cmdk is headless and brings none of its own.
 */

/** The active review's located annotations, each a jump target. Its own
 *  component so the store subscription only exists while a session is
 *  active - a hook cannot be conditional, but a component can. */
const AnnotationItems = ({ handle }: { readonly handle: SessionHandle }) => {
  const annotations = useStore(handle.store, (s) => s.annotations);
  const located = annotations.filter((a) => a.resolved);
  if (located.length === 0) return null;
  return (
    <Command.Group heading="Annotations" className={groupCls}>
      {located.map((a, i) => (
        <Command.Item
          key={a.id}
          value={`annotation ${i + 1} ${a.note}`}
          className={itemCls}
          onSelect={() => {
            setPaletteOpen(false);
            window.dispatchEvent(new CustomEvent("lucid:reveal-annotation", { detail: a.id }));
            document
              .querySelector(`[data-annotation-id="${a.id}"]`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}
        >
          <span className="flex size-4 flex-none items-center justify-center bg-accent text-[10px] font-bold text-on-accent">
            {i + 1}
          </span>
          <span className="truncate">{a.note}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
};

/**
 * What the "Add a project folder…" row reports, or null when there is nothing
 * to say (the human cancelled the chooser).
 *
 * The row states its own outcome because there is nowhere else left to state
 * it: the pick screen's add-folder control - which this copy comes from - was
 * deleted, and the row's old answer to a chooser-less platform was to blank the
 * active tab and land there anyway. A success is worth saying too, since the
 * question a human has after picking is "was that the right folder", which
 * "added" does not answer.
 */
export const addFolderStatus = (outcome: Awaited<ReturnType<typeof addRoot>>): string | null => {
  if ("needsPath" in outcome) return "This build has no folder chooser on this platform.";
  if ("error" in outcome) return outcome.error;
  if ("cancelled" in outcome) return null;
  const { root, found } = outcome.added;
  // 0 found is the confusing case, and silence about WHY was the whole problem:
  // a project folder holds no reviews because agents write artifacts into their
  // own scratchpad, which Lucid already scans. Say that, rather than leaving the
  // human to conclude their work is lost.
  return found === 0
    ? `Watching ${projectName(root)}, but no reviews are stored in it. Agents usually write artifacts to their session scratchpad - those are already listed here, under the project they were about.`
    : `Found ${found} ${found === 1 ? "review" : "reviews"} in ${projectName(root)}.`;
};

export const Palette = () => {
  const open = useHub((s) => s.paletteOpen);
  const activeKey = useShell((s) => s.activeKey);
  const inputRef = useRef<HTMLInputElement>(null);
  /** The last thing the add-folder row has to say. Cleared on each open: a
   *  count from the previous pick would read as this one's. */
  const [added, setAdded] = useState<string | null>(null);

  const active = activeKey !== null ? getSession(activeKey) : undefined;

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      setAdded(null);
    }
  }, [open]);

  if (!open) return null;

  const close = (): void => setPaletteOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    // The overlay owns dismissal - and cannot strand a modal state: the
    // backdrop is a real button (click-away with a keyboard equivalent, the
    // Lightbox's own pattern), and Escape lands on the Command below, which
    // always holds focus while open.
    <div
      data-test="palette-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    >
      <button
        type="button"
        aria-label="Close the command palette"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink-900/60"
      />
      <Command
        data-test="palette"
        label="Lucid commands"
        /* The same scorer the pick screen uses, so the two surfaces cannot
           disagree about what a query matches (list.ts, matchScore). */
        filter={matchScore}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="relative w-[560px] max-w-[calc(100vw-48px)] border border-ink-500 bg-ink-800 shadow-[0_18px_50px_rgba(0,0,0,0.6)]"
      >
        <Command.Input
          ref={inputRef}
          data-test="palette-input"
          placeholder="Jump to a session, or run a command…"
          className="w-full border-b border-ink-600 bg-bg-inset px-3 py-2.5 font-sans text-[13px] text-fg outline-none placeholder:text-fg-faint"
        />
        <Command.List className="max-h-[50vh] overflow-y-auto pb-1">
          <Command.Empty className="px-3 py-4 text-[12px] italic text-fg-faint">
            Nothing matches.
          </Command.Empty>

          {active ? (
            <Command.Group heading="This review" className={groupCls}>
              <Command.Item
                className={itemCls}
                onSelect={run(() => void active.actions.approveReview())}
              >
                Approve review
                <span className="ml-auto text-[10px] text-fg-faint">⌘⇧↵</span>
              </Command.Item>
              <Command.Item
                className={itemCls}
                onSelect={run(() => void active.actions.reopenReview())}
              >
                Reopen review
              </Command.Item>
              <Command.Item
                className={itemCls}
                onSelect={run(() => void active.actions.enterDiff())}
              >
                Show changes since the last version
              </Command.Item>
              <Command.Item
                className={itemCls}
                onSelect={run(() => active.actions.toggleTargets())}
              >
                Toggle annotation marks
                <span className="ml-auto text-[10px] text-fg-faint">⌘.</span>
              </Command.Item>
              <Command.Item className={itemCls} onSelect={run(() => closeTab(active.key))}>
                Close this tab
              </Command.Item>
            </Command.Group>
          ) : null}

          {active ? <AnnotationItems handle={active} /> : null}

          {/* The unified session list (M4.1, D-019): the same component the
              pick screen mounts inline - recency band, open tabs, one group
              per project, all fuzzy over values that fold the project in. */}
          <SessionListGroups includeOpen onDone={close} />

          {/* Pointing Lucid at a new folder is a command, not only a pick-screen
              affordance (D-007) - and now the ONLY place the control exists, so
              the palette stays open across the pick and reports what came back
              (addFolderStatus). Whatever the folder held has already joined the
              session groups above by then: the hub broadcasts the new listing. */}
          <Command.Group heading="Shell" className={groupCls}>
            <Command.Item
              data-test="palette-add-folder"
              value="add a project folder watch scan"
              className={itemCls}
              onSelect={() => {
                setAdded(null);
                void addRoot().then((outcome) => setAdded(addFolderStatus(outcome)));
              }}
            >
              Add a project folder…
            </Command.Item>
            {added !== null ? (
              <div
                data-test="palette-add-folder-status"
                className="px-3 pb-2 text-[10px] leading-relaxed text-fg-faint"
              >
                {added}
              </div>
            ) : null}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
};
