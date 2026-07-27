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
    testName: "a reload keeps the tabs that were open, and the one in front",
    // Was a revert until the M2 ownership fix touched the same commit's
    // session.ts and the revert stopped applying. The verifier caught that on
    // the run after, which is the whole reason it prints conflicts rather than
    // skipping them.
    mutation: {
      kind: "edit",
      file: "client/chrome/shell.ts",
      // The READ, not the key name. Renaming the key moved the writer and
      // the reader together, so a reload still restored and the verifier
      // reported a mutation that changed nothing - which is what it was.
      find: "export const readStoredTabs = (): PersistedTabs => {",
      replace:
        "export const readStoredTabs = (): PersistedTabs => {\n  return { keys: [], active: null, project: null }; // mutation",
    },
  },
  {
    sha: "3bca9c0",
    broke:
      "A session wrote its record into a folder of the user's that happened to share its name.",
    testFile: "test/e2e/regression/3bca9c0-no-colonising-your-folder.e2e.ts",
    testName: "open refuses a record folder that already holds someone else's work",
    mutation: {
      kind: "edit",
      file: "src/core/session.ts",
      find: "  if (existsSync(paths.logPath)) return false; // unmistakably ours",
      replace: "  return false; // mutation: every directory reads as ours",
    },
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
    sha: "m2.1",
    broke: "Effect's own refusals logged a formatted block to stdout, so JSON.parse(stdout) threw.",
    testFile: "test/e2e/regression/m2.1-stdout-is-one-json-document.e2e.ts",
    testName: "a refused command puts one JSON envelope on stdout",
    mutation: {
      kind: "edit",
      file: "src/cli/main.ts",
      // The catchAll, not the logger. Removing the stderr logger alone leaves
      // the test green: the top-level catch handles the error before anything
      // logs it, so the logger replacement is belt-and-braces rather than the
      // fix. Measured, not assumed - the first mutation named here was the
      // logger, and it passed.
      // Anchored on the catch-all's own line. `process.stdout.write`
      // alone matches twice - runEffect writes the same envelope for
      // failures INSIDE a command - and an ambiguous mutation would not
      // mean what the row says it means.
      find: "    const envelope = asEnvelope(error);",
      replace: "    const envelope = undefined as ReturnType<typeof asEnvelope>;",
    },
  },
  {
    sha: "m2.2",
    broke:
      "progress and context printed {ok:false} and exited 0, so a shell `if` read a refusal as success.",
    testFile: "test/e2e/regression/m2.2-refusals-exit-non-zero.e2e.ts",
    testName: "progress and context refuse with a non-zero exit, not a quiet ok:false",
    mutation: {
      kind: "edit",
      file: "src/cli/run.ts",
      // Removes the fix, not a type. An earlier version appended an excess
      // property to the ValidationError constructor, which is a COMPILE-time
      // error and nothing else - the verifier does not run tsc, so at runtime
      // the throw was unchanged, the test passed, and the row reported itself
      // proven while proving nothing.
      find: `    throw new ValidationError({\n      message: "progress needs a --label, --total, or --done",\n      detail: { file },\n    });`,
      replace: `    print({ ok: false, error: "progress needs a --label, --total, or --done" });\n    return;`,
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
    broke: "A slow send showed nothing, so it looked exactly like a swallowed one.",
    testFile: "test/e2e/regression/80faab5-a-slow-send-is-visible.e2e.ts",
    testName: "a send that is taking a while says so, before it has failed",
    // This row was first closed as "no reachable mutation" on the reading that
    // the commit was about the LOCK REFUSAL - and that part is genuinely
    // unreachable: the lock was held for 9s and the composer sent with
    // DEFAULT_TIMEOUT_MS at 30_000, 5000 and 100, and all three delivered with
    // no warning, because f107e28's outbox retries until the lock frees. The
    // review pointed out the commit shipped three more invariants, each one
    // line and none tested, so the `why` was true of the refusal and false of
    // the commit. Two remain untested: the 4xx short-circuit in transport.ts,
    // and outboxSendingId vs outboxSending in Panel.tsx.
    mutation: {
      kind: "edit",
      file: "client/chrome/Panel.tsx",
      find: "const SLOW_SEND_MS = 1200;",
      replace: "const SLOW_SEND_MS = 60_000;",
    },
  },
  {
    sha: "m4.1-wait-zero",
    broke:
      "wait --timeout 0 mapped to POSITIVE_INFINITY and parked the agent's turn forever - the opposite of what 0 reads as.",
    testFile: "test/e2e/regression/m4.1-wait-zero-drains.e2e.ts",
    testName: "wait --timeout 0 drains and returns instead of blocking forever",
    mutation: {
      kind: "edit",
      file: "src/core/wait.ts",
      find: "  const deadline = Date.now() + Math.max(0, timeoutMs);",
      replace:
        "  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;",
    },
  },
  {
    sha: "m4.1-wait-since",
    broke:
      "A --since that parsed to nothing silently became the bootstrap read: the whole session replayed as a delta, with no ack, and the viewer never flipped to delivered.",
    testFile: "test/e2e/regression/m4.1-wait-since-garbage-refused.e2e.ts",
    testName: "a garbage --since is a VALIDATION_ERROR, not a silent full replay",
    mutation: {
      kind: "edit",
      file: "src/core/wait.ts",
      // Neutralises the guard, not the parse: the refusal is the fix, and with
      // it gone the garbage cursor falls through to the bootstrap branch the
      // way it always did.
      find: "  if (options.since !== undefined && cursor === undefined) {",
      replace: "  if (false) {",
    },
  },
  {
    sha: "m4.1-blank-note",
    broke:
      "Add to queue with a whitespace-only note refused silently: the button stayed enabled, the click did nothing, and nothing said why.",
    testFile: "test/e2e/regression/m4.1-blank-note-refusal-visible.e2e.ts",
    testName: "add to queue refuses a blank note visibly, and typing re-arms it",
    mutation: {
      kind: "edit",
      file: "client/chrome/Panel.tsx",
      find: "              disabled={composerNote.trim().length === 0}",
      replace: "              disabled={false}",
    },
  },
  {
    sha: "m4.1-quick-reply",
    broke:
      "A quick-reply chip clicked over a half-typed note replaced it wholesale - the queued card held only the canned ask, with no confirmation and no way back.",
    testFile: "test/e2e/regression/m4.1-quick-reply-merges.e2e.ts",
    testName: "a quick-reply over a typed note queues both, the typing first",
    mutation: {
      kind: "edit",
      file: "client/chrome/actions.ts",
      // The `\\n` is deliberate: the SOURCE spells `\n` as two characters
      // inside its template literal, so the match must too. A single-escaped
      // version held real newlines, matched nothing, and was caught by the
      // exactly-once guard - the same silent-no-op class as mistake #6.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the SOURCE being matched, not an interpolation that forgot its backticks
      find: "    set({ composerNote: typed ? `${typed}\\n\\n${note}` : note });",
      replace: "    set({ composerNote: note });",
    },
  },
  {
    sha: "m4.1-queue-reload",
    broke:
      "A reload destroyed every queued annotation while an undelivered message survived it - the queue lived only in component state.",
    testFile: "test/e2e/regression/m4.1-queue-survives-reload.e2e.ts",
    testName: "queued annotations survive a reload, and the survivors still send",
    mutation: {
      kind: "edit",
      file: "client/chrome/store.ts",
      // Severs the restore, not the writes: storage still fills, the page just
      // never reads it back - which is exactly the pre-fix shape.
      find: "    queue: storage.readQueue(assetUrl),",
      replace: "    queue: [],",
    },
  },
  {
    sha: "80faab5",
    broke:
      "A 4xx verdict was retried like a hiccup: a 409 re-POSTed five times over 14s, and the failure card arrived 14s late.",
    testFile: "test/e2e/regression/80faab5-a-verdict-is-not-retried.e2e.ts",
    testName: "a 4xx verdict fails once, immediately, with the server's reason",
    mutation: {
      kind: "edit",
      file: "client/chrome/transport.ts",
      find: "        if (res.status >= 400 && res.status < 500) throw lastErr;",
      replace: "        // mutation: a verdict is retried like a hiccup",
    },
  },
  {
    sha: "80faab5",
    broke:
      "One stuck flush read as a global sending flag would disable every card's Retry and Discard - the one control a failed send leaves you.",
    testFile: "test/e2e/regression/80faab5-one-stuck-flush.e2e.ts",
    testName: "a stuck flush disables its own card's Retry, and no other's",
    mutation: {
      kind: "edit",
      file: "client/chrome/Panel.tsx",
      find: "  const sending = useSession((s) => s.outboxSendingId) === message.id;",
      replace: "  const sending = useSession((s) => s.outboxSending);",
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
