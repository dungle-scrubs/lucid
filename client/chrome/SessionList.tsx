import { Command } from "cmdk";
import { useState } from "react";
import { BAND_SIZE, fuzzyValue, openSplit, recencyBand } from "./list.ts";
import { activateTab, openTab, useHub, type HubSession } from "./hub.ts";
import { artifactLabel, byProject, projectName, sessionLabel } from "./naming.ts";
import { useShell } from "./shell.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The unified session list (plan 03, M4.1, D-019): ONE component owns fuzzy
 * matching, project grouping, the recency band, and the open-vs-openable
 * split; the ⌘K palette and the pick screen are two mounts of it. Filtering
 * is cmdk's own - fuzzy and undebounced (D-020) - over `fuzzyValue`, which
 * folds the project name in so typing "lucid" narrows to that project.
 */

export const groupCls =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[9px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[1.1px] [&_[cmdk-group-heading]]:text-fg-faint";
export const itemCls =
  "mx-1 flex cursor-pointer items-baseline gap-2 px-2 py-1.5 text-[12px] text-fg data-[selected=true]:bg-ink-700";

/** A row that OPENS a session as a tab, reporting a failure on itself - the
 *  pick screen's contract, kept in both mounts. */
const OpenableRow = ({
  row,
  subtitle,
  onDone,
}: {
  readonly row: HubSession;
  readonly subtitle: string;
  readonly onDone?: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Command.Item
            data-test="picker-row"
            value={`pick ${fuzzyValue(row)}`}
            className={`${itemCls} snap-start flex-col !items-stretch gap-0.5`}
            onSelect={() => {
              // openTab activates on success, which swaps the pick screen away
              // on its own; a failure keeps the screen and says so on the row.
              void openTab(row).then((h) => {
                if (!h) setFailed(true);
                else onDone?.();
              });
            }}
          >
            <span className="truncate text-[12px] text-fg">{sessionLabel(row)}</span>
            <span className="truncate text-[10px] text-fg-faint">
              {failed ? "couldn't open - is the session's log readable?" : subtitle}
            </span>
          </Command.Item>
        }
      />
      <TooltipContent>{row.artifact}</TooltipContent>
    </Tooltip>
  );
};

/**
 * The list's cmdk groups: the recency band (hub `lastSeen` order, D-024),
 * open tabs (when the mount wants them - the pick screen offers only places
 * to GO), then one group per project. Mount inside a `<Command>`.
 */
export const SessionListGroups = ({
  includeOpen,
  onDone,
}: {
  /** Offer open tabs as activate-rows (the palette). The pick screen leaves
   *  them out: a tab you already have is not a place to go. */
  readonly includeOpen: boolean;
  readonly onDone?: () => void;
}) => {
  const sessions = useHub((s) => s.sessions);
  const openKeys = useShell((s) => s.sessionKeys);
  const { open, openable } = openSplit(sessions, openKeys);
  const openSet = new Set(open.map((s) => s.artifact));
  const population = includeOpen ? sessions : openable;
  // The band is a SHORTCUT over a long list: with everything visible in one
  // screenful the full list is its own recency band, and duplicating rows
  // would only add ambiguity (and double-match every selector).
  const band = population.length > BAND_SIZE ? recencyBand(population) : [];

  return (
    <>
      {band.length > 0 ? (
        <Command.Group heading="Recent" className={groupCls}>
          {band.map((s) => (
            <Command.Item
              key={`recent-${s.id}`}
              data-test="recent-row"
              value={`recent ${fuzzyValue(s)}`}
              className={itemCls}
              onSelect={() => {
                if (openSet.has(s.artifact)) {
                  activateTab(s.artifact);
                  onDone?.();
                } else {
                  void openTab(s).then((h) => {
                    if (h) onDone?.();
                  });
                }
              }}
            >
              <span className="truncate">{sessionLabel(s)}</span>
              <span className="ml-auto truncate text-[10px] text-fg-faint">
                {projectName(s.project)}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      ) : null}

      {includeOpen && open.length > 0 ? (
        <Command.Group heading="Open tabs" className={groupCls}>
          {open.map((s) => (
            <Command.Item
              key={`tab-${s.id}`}
              value={`tab ${fuzzyValue(s)}`}
              className={itemCls}
              onSelect={() => {
                activateTab(s.artifact);
                onDone?.();
              }}
            >
              <span className="truncate">{sessionLabel(s)}</span>
              <span className="ml-auto truncate text-[10px] text-fg-faint">
                {projectName(s.project)}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      ) : null}

      {[...byProject(openable)].map(([project, rows]) => (
        <Command.Group
          key={project}
          data-test="picker-project"
          heading={projectName(project)}
          className={groupCls}
        >
          {rows.map((s) => (
            <OpenableRow
              key={s.id}
              row={s}
              subtitle={artifactLabel(s.artifact, project)}
              {...(onDone ? { onDone } : {})}
            />
          ))}
        </Command.Group>
      ))}
    </>
  );
};
