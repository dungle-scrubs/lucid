import { describe, expect, test } from "bun:test";
import type { HubSession } from "../client/chrome/hub.ts";
import {
  artifactLabel,
  byProject,
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

describe("a name that collides across projects", () => {
  // Both artifacts are called plan.html and both declare the SAME title, so
  // the shell hands each tab the identical name - which is the only way the
  // qualifier branch is reached at all. They differ ONLY in project.
  const a = row({ artifact: "/dev/lucid/plan.html", project: "/dev/lucid", title: "Migration" });
  const b = row({ artifact: "/dev/tether/plan.html", project: "/dev/tether", title: "Migration" });
  const listing = [a, b];
  const tabA = { key: a.artifact, name: sessionLabel(a) };
  const tabB = { key: b.artifact, name: sessionLabel(b) };
  const open = [tabA, tabB];

  test("the fixture really does collide on name and differ on project", () => {
    // Guard on the fixture itself: two rows that quietly disagreed on name
    // would never enter the qualifier branch, and every claim below would
    // pass without exercising anything.
    expect(sessionLabel(a)).toBe(sessionLabel(b));
    expect(a.project).not.toBe(b.project);
  });

  test("both colliding tabs carry their project", () => {
    expect(tabLabel(tabA, open, listing)).toBe("Migration · lucid");
    expect(tabLabel(tabB, open, listing)).toBe("Migration · tether");
  });

  test("an uncontested name is left alone", () => {
    // The qualifier is disambiguation, not decoration. A lone tab that grew a
    // project suffix would spend the strip's scarce width saying nothing.
    expect(tabLabel(tabA, [tabA], listing)).toBe("Migration");
  });

  test("a collision the listing cannot place stays unqualified", () => {
    // The tab is open but no listing row names its project (a burst of
    // `lucid open` outruns the listing). A qualifier invented here would put
    // some other project's name on this artifact.
    const unplaced = { key: "/dev/nowhere/plan.html", name: "Migration" };
    expect(tabLabel(unplaced, [unplaced, tabB], listing)).toBe("Migration");
  });

  test("two same-titled tabs in ONE project get a qualifier that does not tell them apart", () => {
    // Measured, not desired: the qualifier is the PROJECT, so a collision
    // inside one project produces two identical labels. What distinguishes
    // them is each tab's tooltip (its artifact path) and the document it
    // shows - neither of which this module owns, which is why the "tellable
    // apart" scenario keeps a browser.
    const c = row({
      artifact: "/dev/lucid/rollout.html",
      project: "/dev/lucid",
      title: "Migration",
    });
    const sameProject = [tabA, { key: c.artifact, name: "Migration" }];
    const labels = sameProject.map((t) => tabLabel(t, sameProject, [a, c]));
    expect(labels).toEqual(["Migration · lucid", "Migration · lucid"]);
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
