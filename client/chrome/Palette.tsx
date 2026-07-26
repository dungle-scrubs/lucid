import { Command } from "cmdk";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import {
  activateTab,
  byProject,
  closeTab,
  openTab,
  projectName,
  sessionLabel,
  setPaletteOpen,
  useHub,
} from "./hub.ts";
import type { SessionHandle } from "./session.ts";
import { getSession, useShell } from "./shell.ts";

/**
 * The ⌘K command palette (cmdk): fuzzy over every session the hub knows plus
 * the review actions of the active one. It subsumes the old in-session
 * Sessions panel - the palette is how a keyboard reaches any session from
 * anywhere. Styled to the shell's own tokens (frost accent, mono, sharp
 * corners); cmdk is headless and brings none of its own.
 */

const itemCls =
  "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] text-fg data-[selected=true]:bg-ink-700 data-[selected=true]:text-fg-strong";
const groupCls =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.8px] [&_[cmdk-group-heading]]:text-fg-faint";

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
          <span className="flex size-4 flex-none items-center justify-center rounded-full bg-accent text-[10px] font-bold text-on-accent">
            {i + 1}
          </span>
          <span className="truncate">{a.note}</span>
        </Command.Item>
      ))}
    </Command.Group>
  );
};

export const Palette = () => {
  const open = useHub((s) => s.paletteOpen);
  const sessions = useHub((s) => s.sessions);
  const openKeys = useShell((s) => s.sessionKeys);
  const activeKey = useShell((s) => s.activeKey);
  const inputRef = useRef<HTMLInputElement>(null);

  const active = activeKey !== null ? getSession(activeKey) : undefined;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = (): void => setPaletteOpen(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const openRows = sessions.filter((s) => openKeys.includes(s.artifact));
  const otherRows = sessions.filter((s) => !openKeys.includes(s.artifact));

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

          {openRows.length > 0 ? (
            <Command.Group heading="Open tabs" className={groupCls}>
              {openRows.map((s) => (
                <Command.Item
                  key={s.id}
                  value={`tab ${sessionLabel(s)} ${s.name} ${projectName(s.project)} ${s.artifact}`}
                  className={itemCls}
                  onSelect={run(() => activateTab(s.artifact))}
                >
                  <span className="truncate">{sessionLabel(s)}</span>
                  <span className="ml-auto truncate text-[10px] text-fg-faint">
                    {projectName(s.project)}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ) : null}

          {/* Sessions to open, one group per PROJECT: a tab is a session, and
              the project heading is how a human scans a long list. The
              project name also rides each item's value, so typing "lucid"
              narrows to that project's sessions. */}
          {[...byProject(otherRows)].map(([project, rows]) => (
            <Command.Group key={project} heading={projectName(project)} className={groupCls}>
              {rows.map((s) => (
                <Command.Item
                  key={s.id}
                  value={`open ${sessionLabel(s)} ${s.name} ${projectName(s.project)} ${s.artifact}`}
                  className={itemCls}
                  onSelect={run(() => void openTab(s))}
                >
                  <span className="truncate">{sessionLabel(s)}</span>
                  <span className="ml-auto truncate text-[10px] text-fg-faint">
                    {s.artifact.slice(project.length + 1) || s.name}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </div>
  );
};
