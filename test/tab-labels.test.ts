import { describe, expect, test } from "bun:test";
import type { HubSession } from "../client/chrome/hub.ts";
import {
  artifactLabel,
  byProject,
  groupTabs,
  projectName,
  sessionLabel,
  tabLabel,
  worktreeRoots,
} from "../client/chrome/naming.ts";

/**
 * What the shell calls a session, and which project it files it under.
 *
 * These were e2e scenarios. Each one cost a hub, a git worktree or a second
 * project, a session, a page load and a settle to ask a question that is a
 * fold of listing data into a string. Moved here per D-018 - a scenario that
 * never touches paint does not need a browser.
 *
 * What did NOT move: whether a human can TELL two tabs apart. The label is
 * only half of that (the tooltip's artifact path is the other half), and
 * "tellable apart" is a claim about pixels. That stays in e2e.
 */

/** A listing row, with only the fields a name is derived from spelled out per
 *  test. `lastSeen`/`id`/`hosted` are listing plumbing no naming rule reads. */
const row = (over: Partial<HubSession> & Pick<HubSession, "artifact" | "project">): HubSession => ({
  name: over.artifact.split("/").pop() ?? over.artifact,
  lastSeen: "2026-01-01T00:00:00.000Z",
  id: over.artifact,
  hosted: false,
  ...over,
});

describe("what a tab is called", () => {
  test("an artifact with no title is called by its filename", () => {
    // A document that never declared a <title> must still name itself on the
    // tab. Without the fallback the tab reads empty, or "undefined".
    expect(sessionLabel(row({ artifact: "/dev/lucid/plan.html", project: "/dev/lucid" }))).toBe(
      "plan.html",
    );
  });

  test("a title beats the filename, because it says what the session holds", () => {
    expect(
      sessionLabel(
        row({
          artifact: "/dev/lucid/test2.html",
          project: "/dev/lucid",
          title: "Units that got away",
        }),
      ),
    ).toBe("Units that got away");
  });
});

describe("a tab shows only its title (D-012; flips e2e finding #56 by design)", () => {
  // Both artifacts declare the SAME title and differ only in project - the
  // exact fixture that used to earn a `· project` qualifier. The GROUP is the
  // qualifier now: the strip renders each under its project's heading, so the
  // label stays clean.
  const a = row({ artifact: "/dev/lucid/plan.html", project: "/dev/lucid", title: "Migration" });
  const b = row({ artifact: "/dev/tether/plan.html", project: "/dev/tether", title: "Migration" });
  const tabA = { key: a.artifact, name: sessionLabel(a) };
  const tabB = { key: b.artifact, name: sessionLabel(b) };

  test("a cross-project collision stays title-only; group membership tells them apart", () => {
    expect(tabLabel(tabA)).toBe("Migration");
    expect(tabLabel(tabB)).toBe("Migration");
    // The distinction the labels no longer carry lives in the grouping.
    const groups = groupTabs([tabA.key, tabB.key], [a, b]);
    expect(groups.map((g) => g.project)).toEqual(["/dev/lucid", "/dev/tether"]);
  });

  test("an uncontested name is unchanged", () => {
    expect(tabLabel(tabA)).toBe("Migration");
  });

  test("a same-project collision is a tooltip's job, not the label's", () => {
    // Two same-titled tabs in one project read identically on the strip; each
    // tab's tooltip (its artifact path) is what tells them apart - the same
    // division of labor a browser uses.
    const c = row({
      artifact: "/dev/lucid/rollout.html",
      project: "/dev/lucid",
      title: "Migration",
    });
    expect(tabLabel({ key: c.artifact, name: "Migration" })).toBe("Migration");
  });
});

describe("where an artifact says it sits", () => {
  test("an artifact outside its project shows just its filename", () => {
    // An agent's scratchpad is listed under the project it was ABOUT, so the
    // project is not a prefix of the path at all. Slicing anyway produced
    // sliced-up nonsense - a path chopped mid-segment.
    expect(artifactLabel("/tmp/claude-501/scratch/review.html", "/dev/lucid")).toBe("review.html");
  });

  test("an artifact inside its project shows the path under it", () => {
    expect(artifactLabel("/dev/lucid/docs/plan.html", "/dev/lucid")).toBe("docs/plan.html");
  });

  test("a project that merely prefixes the path is not a parent", () => {
    // "/dev/lucid" is a string prefix of "/dev/lucid-old/plan.html" but not a
    // parent directory of it. Testing the prefix without the separator would
    // slice this into "-old/plan.html".
    expect(artifactLabel("/dev/lucid-old/plan.html", "/dev/lucid")).toBe("plan.html");
  });

  test("a project root is named by its last segment", () => {
    expect(projectName("/Users/x/dev/lucid")).toBe("lucid");
    // A trailing slash is still the same folder; the empties are dropped.
    expect(projectName("/Users/x/dev/lucid/")).toBe("lucid");
  });
});

describe("a session in a git worktree", () => {
  // The hub resolves a worktree checkout to its MAIN repo and reports that as
  // `project`, carrying the checkout separately. So this fixture has three
  // rows over ONE project, two of which live in worktrees - and the two
  // worktree rows share a checkout, so the drawer must say "+1 worktree".
  const main = row({ artifact: "/dev/lucid/plan.html", project: "/dev/lucid" });
  const wt1 = row({
    artifact: "/dev/lucid-wt/notes.html",
    project: "/dev/lucid",
    worktree: "/dev/lucid-wt",
  });
  const wt2 = row({
    artifact: "/dev/lucid-wt/spec.html",
    project: "/dev/lucid",
    worktree: "/dev/lucid-wt",
  });
  const listing = [main, wt1, wt2];

  test("the fixture really does put a session inside a worktree", () => {
    // Without a row whose `worktree` differs from its `project`, the grouping
    // claim below is about nothing.
    expect(wt1.worktree).toBe("/dev/lucid-wt");
    expect(wt1.worktree).not.toBe(wt1.project);
  });

  test("a worktree session groups under its main repo, not beside it", () => {
    const groups = byProject(listing);
    expect([...groups.keys()]).toEqual(["/dev/lucid"]);
    expect(groups.get("/dev/lucid")).toHaveLength(3);
  });

  test("several sessions in one checkout are one worktree", () => {
    // The drawer's "+N worktrees" counts CHECKOUTS. Counting rows would
    // report "+2 worktrees" for a single one holding two artifacts.
    expect([...worktreeRoots(listing)]).toEqual(["/dev/lucid-wt"]);
  });

  test("a project with no worktrees is not qualified at all", () => {
    expect(worktreeRoots([main]).size).toBe(0);
  });

  test("projects keep the listing's order, so the drawer does not reshuffle", () => {
    const other = row({ artifact: "/dev/tether/a.html", project: "/dev/tether" });
    expect([...byProject([main, other, wt1]).keys()]).toEqual(["/dev/lucid", "/dev/tether"]);
  });
});

describe("groupTabs: the strip's runs (plan 03, M2.2)", () => {
  const listing = [
    row({ artifact: "/dev/lucid/a.html", project: "/dev/lucid" }),
    row({ artifact: "/dev/lucid/b.html", project: "/dev/lucid" }),
    row({ artifact: "/dev/tether/c.html", project: "/dev/tether" }),
    // a worktree checkout: `project` already resolves to the main repo.
    row({ artifact: "/dev/wt/d.html", project: "/dev/lucid", worktree: "/dev/wt" }),
  ];

  test("groups appear in FIRST-OPEN order, keys in open order", () => {
    const keys = ["/dev/tether/c.html", "/dev/lucid/a.html", "/dev/lucid/b.html"];
    expect(groupTabs(keys, listing)).toEqual([
      { project: "/dev/tether", keys: ["/dev/tether/c.html"] },
      { project: "/dev/lucid", keys: ["/dev/lucid/a.html", "/dev/lucid/b.html"] },
    ]);
  });

  test("a group stays put when a later tab joins an EARLIER group", () => {
    // tether opened first, then a lucid tab, then a SECOND lucid tab. lucid's
    // group must not jump ahead of tether just because it grew.
    const keys = ["/dev/tether/c.html", "/dev/lucid/a.html", "/dev/lucid/b.html"];
    const order = groupTabs(keys, listing).map((g) => g.project);
    expect(order).toEqual(["/dev/tether", "/dev/lucid"]);
  });

  test("a worktree tab shares its main repo's group", () => {
    const keys = ["/dev/lucid/a.html", "/dev/wt/d.html"];
    expect(groupTabs(keys, listing)).toEqual([
      { project: "/dev/lucid", keys: ["/dev/lucid/a.html", "/dev/wt/d.html"] },
    ]);
  });

  test("a single-tab project is an ordinary group of one", () => {
    expect(groupTabs(["/dev/tether/c.html"], listing)).toEqual([
      { project: "/dev/tether", keys: ["/dev/tether/c.html"] },
    ]);
  });

  test("two tabs the listing has not placed do not merge", () => {
    const groups = groupTabs(["/x/unplaced-1.html", "/x/unplaced-2.html"], listing);
    expect(groups).toHaveLength(2);
  });
});
