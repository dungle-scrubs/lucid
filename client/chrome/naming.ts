import type { HubSession } from "./hub.ts";

/**
 * What the shell CALLS a session, and which project it files it under.
 *
 * Every function here is a fold of listing data into a string or a group. None
 * of them touch a store, a fetch, or the DOM - the listing comes in as an
 * argument and a value comes back, which is what makes the awkward cases
 * affordable to cover: an artifact that lives outside its own project, a name
 * that collides across two projects, a worktree that must not become a project
 * of its own.
 *
 * What this module does NOT own: WIRING. Whether the tab bar actually renders
 * `tabLabel`'s answer, whether the grouped strip paints a heading per
 * `byProject` group, and whether two tabs a human is looking at are visually
 * tellable apart - those are claims about the shell, and they stay in the
 * browser. It also does not own the
 * LISTING: which sessions exist, which project the hub decided each belongs to
 * (a worktree is resolved to its main repo server-side), and whether a dead
 * registry pointer was pruned are all answered before the data gets here.
 */

/** What to call a session on screen: its document's title, else its file.
 *  "Units that got away" says what a session holds; "test2.html" says where
 *  it lives. */
export const sessionLabel = (row: Pick<HubSession, "title" | "name">): string =>
  row.title ?? row.name;

/** Display name of a project root ("lucid" for /Users/x/dev/lucid). */
export const projectName = (project: string): string =>
  project.split("/").filter(Boolean).pop() ?? project;

/**
 * Where an artifact sits, said as briefly as it can be truthfully said: the
 * path under its project, or - when it lives OUTSIDE the project, as every
 * artifact in an agent's scratchpad does - just its filename. Slicing the
 * project prefix off unconditionally produced sliced-up nonsense for those.
 */
export const artifactLabel = (artifact: string, project: string): string =>
  artifact.startsWith(`${project}/`)
    ? artifact.slice(project.length + 1)
    : (artifact.split("/").pop() ?? artifact);

/** Sessions grouped by project, insertion-ordered by the (name-sorted)
 *  listing. A tab is a session; the PROJECT is how a human scans for it.
 *  Grouping is by `project` alone, so a session in a worktree lands under the
 *  main repo the hub resolved for it rather than opening a project of its own. */
export const byProject = (sessions: readonly HubSession[]): Map<string, HubSession[]> => {
  const groups = new Map<string, HubSession[]>();
  for (const s of sessions) {
    const list = groups.get(s.project);
    if (list) list.push(s);
    else groups.set(s.project, [s]);
  }
  return groups;
};

/** One run of the grouped tab strip: a project and its open tabs, in tab
 *  order. */
export interface TabGroup {
  readonly project: string;
  readonly keys: readonly string[];
}

/**
 * The OPEN tabs, grouped by project for the strip (plan 03, M2.2). Unlike
 * `byProject` (which orders by the name-sorted listing), groups here appear in
 * FIRST-OPEN order and never reorder afterwards (D-010): a group sits where its
 * first tab opened, so activating a tab or opening another in an existing group
 * does not shuffle the bar. Keys within a group stay in open order. A worktree
 * shares its main repo's group because `project` already resolves to the main
 * repo server-side (D-002); a project with a single tab is an ordinary group of
 * one (D-011). A tab the listing has not placed yet groups under its own key,
 * so two unplaced tabs never wrongly merge.
 */
export const groupTabs = (
  sessionKeys: readonly string[],
  sessions: readonly Pick<HubSession, "artifact" | "project">[],
): TabGroup[] => {
  const projectOf = new Map(sessions.map((s) => [s.artifact, s.project]));
  const order: string[] = [];
  const keysByProject = new Map<string, string[]>();
  for (const key of sessionKeys) {
    const project = projectOf.get(key) ?? key;
    let keys = keysByProject.get(project);
    if (!keys) {
      keys = [];
      keysByProject.set(project, keys);
      order.push(project);
    }
    keys.push(key);
  }
  return order.map((project) => ({ project, keys: keysByProject.get(project) as string[] }));
};

/** The distinct worktree checkouts a project's rows live in - what the drawer
 *  counts as "+N worktrees". A SET, because several sessions in one checkout
 *  are one worktree, and a project with none is not qualified at all. */
export const worktreeRoots = (rows: readonly Pick<HubSession, "worktree">[]): Set<string> => {
  const roots = new Set<string>();
  for (const r of rows) if (r.worktree) roots.add(r.worktree);
  return roots;
};

/** An open tab, as naming sees it: its session key and what its session is
 *  called. The handle itself is the caller's business. */
export interface OpenTab {
  readonly key: string;
  readonly name: string;
}

/**
 * What a tab reads: its title, and ONLY its title (plan 03, D-012). The
 * cross-project qualifier the label used to grow on a name collision is the
 * GROUP's job now - the strip renders every tab under its project's heading
 * (`groupTabs`), so "which project's Migration plan is this?" is answered by
 * where the tab sits, not by a suffix eating the strip's width. Two same-titled
 * tabs in ONE project are distinguished by each tab's tooltip (its artifact
 * path), which is the tooltip's job in a browser too. This deliberately flips
 * e2e finding #56's pinned behavior - by design (D-027).
 */
export const tabLabel = (tab: OpenTab): string => tab.name;
