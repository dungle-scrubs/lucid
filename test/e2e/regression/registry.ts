/**
 * What each shipped fix owes, and how to prove the test that covers it works.
 *
 * The plan assumed one mutation for all twelve rows - `git revert --no-commit
 * <sha>` - and M1.1 measured that assumption against the tree. Six of the
 * twelve reverts do not apply at all, later work having touched the same lines;
 * three that do apply no longer reproduce their defect, because something else
 * now holds the invariant; and one fixed a surface that has since been deleted.
 * A verifier looping over `git revert` would have reported four green tests
 * that cannot fail, which is worse than no tests: it reports coverage that does
 * not exist (D-046, D-047).
 *
 * So the mutation is per row, it is written down, and the rows that have none
 * say so with a reason rather than being left out. `scripts/verify-regressions.ts`
 * reads this file; it is the difference between a script that checks the tests
 * and a script that checks the ones that were convenient.
 */

/** Revert the whole commit. Only for fixes whose revert still applies AND still
 *  reproduces - both were measured, neither was assumed. */
export interface RevertMutation {
  readonly kind: "revert";
  readonly sha: string;
}

/** A named source edit that removes the behaviour, for fixes whose revert
 *  conflicts on the current tree. `find` must match exactly once. */
export interface EditMutation {
  readonly kind: "edit";
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** No mutation can reproduce the defect any more. Carries the measurement, so
 *  the claim can be re-checked rather than taken on trust. */
export interface NoMutation {
  readonly kind: "none";
  readonly why: string;
}

export type Mutation = RevertMutation | EditMutation | NoMutation;

export interface RegressionRow {
  /** The shipped fix this row is about. */
  readonly sha: string;
  /** What broke, in the words of the bug report. */
  readonly broke: string;
  /** Repo-relative, or null when the row is closed without a test. */
  readonly testFile: string | null;
  /** The Playwright title, verbatim, or null. */
  readonly testName: string | null;
  readonly mutation: Mutation;
}

export const REGRESSIONS: readonly RegressionRow[] = [
  {
    sha: "c9d7f86",
    broke: "The pick list came to rest with a row cut in half against the container's top edge.",
    testFile: "test/e2e/regression/c9d7f86-pick-list-whole-rows.e2e.ts",
    testName: "the pick list comes to rest on a whole row, never half of one",
    mutation: { kind: "revert", sha: "c9d7f86" },
  },
  {
    sha: "0267c64",
    broke: "A running turn was announced in three places at once.",
    testFile: "test/e2e/regression/0267c64-one-running-turn.e2e.ts",
    testName: "a running turn is announced in one place, not three",
    mutation: { kind: "revert", sha: "0267c64" },
  },
  {
    sha: "3bca9c0",
    broke: "A reload threw away every open tab and dropped you on the pick screen.",
    testFile: "test/e2e/regression/3bca9c0-reload-keeps-your-tabs.e2e.ts",
    testName: "a reload keeps the tab that was open, instead of the pick screen",
    mutation: { kind: "revert", sha: "3bca9c0" },
  },
  {
    sha: "3bca9c0",
    broke:
      "A session wrote its record into a folder of the user's that happened to share its name.",
    testFile: "test/e2e/regression/3bca9c0-no-colonising-your-folder.e2e.ts",
    testName: "open refuses a record folder that already holds someone else's work",
    mutation: { kind: "revert", sha: "3bca9c0" },
  },
  {
    sha: "9df5eae",
    broke: "Annotations on identical table cells all resolved to the first one.",
    testFile: "test/e2e/regression/9df5eae-ambiguous-fingerprint.e2e.ts",
    testName: "an annotation on the third identical cell marks the third, not the first",
    mutation: { kind: "revert", sha: "9df5eae" },
  },
  {
    sha: "569d43c",
    broke: "An artifact with no dark form was relabelled dark: dark text on a dark ground.",
    testFile: "test/e2e/regression/569d43c-no-dark-form-stays-light.e2e.ts",
    testName: "an artifact with no dark form is not relabelled dark",
    mutation: {
      kind: "edit",
      file: "client/overlay/overlay.ts",
      find: "  private canRenderDark(): boolean {",
      replace: "  private canRenderDark(): boolean {\n    return true;",
    },
  },
  {
    sha: "a52aa58",
    broke: "Fork with an empty note silently did nothing.",
    testFile: "test/e2e/regression/a52aa58-fork-with-an-empty-note.e2e.ts",
    testName: "Fork with no directive still reaches the agent, and says it did",
    mutation: {
      kind: "edit",
      file: "client/chrome/actions.ts",
      find: "expandPastes(rawNote).trim() || DEFAULT_FORK_DIRECTIVE",
      replace: "expandPastes(rawNote).trim()",
    },
  },
  {
    sha: "f107e28",
    broke: "A message typed while the server was gone vanished with no trace.",
    testFile: "test/e2e/regression/f107e28-message-survives-a-dead-server.e2e.ts",
    testName: "a message typed at a dead server is kept, and delivers itself later",
    mutation: {
      kind: "edit",
      file: "client/chrome/session.ts",
      find: "void actions.flushOutbox();",
      replace: "/* mutation: the outbox is never flushed */",
    },
  },
  {
    sha: "41af772",
    broke: "Reopen review after approval was a dead end, answered with a false 'try again'.",
    testFile: "test/e2e/regression/41af772-reopen-after-approval.e2e.ts",
    testName: "reopening a review after the session ended explains the way back",
    mutation: {
      kind: "edit",
      file: "client/chrome/actions.ts",
      find: 'if (get().status === "ended") {',
      replace: "if (false) {",
    },
  },
  {
    sha: "42842f3",
    broke: "The badge straddling a card's top edge landed on the previous card's footer.",
    testFile: null,
    testName: null,
    mutation: {
      kind: "none",
      why:
        "Reverting the reserve no longer collides: later thread spacing puts 18px between cards " +
        "while the straddling badge overhangs ~7px. Measured with the revert applied - a test " +
        "written against it passed and was deleted rather than shipped.",
    },
  },
  {
    sha: "a7c3e12",
    broke: "The thread viewport grew a horizontal scrollbar on wide content.",
    testFile: null,
    testName: null,
    mutation: {
      kind: "none",
      why:
        "Reverting overflow-x-hidden no longer produces overflow: wrapping and min-width work " +
        "elsewhere prevents it independently. Tried with prose and with the wide markdown shapes " +
        "(fenced command, table, long inline path, unbroken token); both passed reverted. The " +
        "invariant is still covered by the two-width overflow.e2e.ts the fix shipped with.",
    },
  },
  {
    sha: "80faab5",
    broke: "A human message was refused outright because an agent held the append lock.",
    testFile: null,
    testName: null,
    mutation: {
      kind: "none",
      why:
        "The refusal is unreachable at any timeout. Held the artifact's append lock for 9s and " +
        "sent from the composer with DEFAULT_TIMEOUT_MS at 30_000, 5000 (the pre-fix value) and " +
        "100: all three delivered with no warning, because f107e28's outbox retries until the " +
        "lock frees. The invariant now belongs to f107e28's row.",
    },
  },
  {
    sha: "7c46d38",
    broke: "Answered questions stayed pinned in the 'Questions for you' panel.",
    testFile: null,
    testName: null,
    mutation: {
      kind: "none",
      why:
        "The surface is gone: client/chrome/Questions.tsx, whose answered cards the fix removed, " +
        "was replaced wholesale by QuestionDrawer.tsx. There is no panel to leave, so neither a " +
        "revert nor an edit can reproduce it. The drawer's behaviour is covered by " +
        "question-drawer.e2e.ts.",
    },
  },
];
