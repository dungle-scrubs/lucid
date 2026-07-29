/**
 * The unified session list's data rules (plan 03, M4.1). One vocabulary for
 * both mounts - the ⌘K palette and the pick screen - so the two surfaces
 * cannot drift: the recency band, the open/openable split, and the fuzzy
 * search value are decided here and merely rendered there.
 */

import type { HubSession } from "./hub.ts";
import { projectName, sessionLabel } from "./naming.ts";

/** How many rows the recency band offers. Enough to cover "the things I was
 *  just working on" without becoming a second full list. */
export const BAND_SIZE = 5;

/** The most recently seen sessions, newest first, across ALL projects -
 *  ordered by the hub's own `lastSeen` (D-024), which tracks opens and scans
 *  rather than this window's activations. */
export const recencyBand = (
  sessions: readonly HubSession[],
  size: number = BAND_SIZE,
): HubSession[] =>
  [...sessions].sort((x, y) => y.lastSeen.localeCompare(x.lastSeen)).slice(0, size);

/** Split the listing by what a click DOES: an open row activates its tab; an
 *  openable one becomes a new tab. */
export const openSplit = (
  sessions: readonly HubSession[],
  openKeys: readonly string[],
): { readonly open: HubSession[]; readonly openable: HubSession[] } => {
  const openSet = new Set(openKeys);
  return {
    open: sessions.filter((s) => openSet.has(s.artifact)),
    openable: sessions.filter((s) => !openSet.has(s.artifact)),
  };
};

/** Everything typing should be able to catch (D-020): the display title, the
 *  filename, the project's short name, and the full path. */
export const fuzzyValue = (s: HubSession): string =>
  `${sessionLabel(s)} ${s.name} ${projectName(s.project)} ${s.artifact}`;
