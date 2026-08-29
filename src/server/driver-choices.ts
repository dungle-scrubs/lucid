/**
 * The lists a person chooses a driver from (RFC-12): the four harnesses hcn
 * knows, and each harness's model and effort vocabulary.
 *
 * One source, read through the harness seam - `hcn inspect <harness> --json`
 * projects the descriptor, and lucid mirrors nothing about it. The server
 * reads the lists once per process per harness and answers every poll from
 * the memo: an inspect dump describes the installed hcn, which does not
 * change under a running server, and re-reading it on every poll would make
 * a 500ms cadence spawn four children a tick.
 *
 * The memo lives at module scope, not per server: in production there is one
 * server per process so the two are the same thing, and in a test run - many
 * servers, one process - the shared read is what keeps the suite from paying
 * the spawn cost per server. A harness whose dump fails has no entry, and a
 * missing hcn means no entries at all: the dimension is absent on the page,
 * not disabled, and the server starts and serves everything else - it never
 * needed a harness to serve a record.
 *
 * What it is NOT: it is not a second descriptor. `HarnessVocabulary` is the
 * seam's projection; this module adds only the memo and the degradation.
 */

import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import type {
  HarnessFacts,
  HarnessName,
  HarnessRunner,
  HarnessVocabulary,
} from "../harness/runner.js";
import { DRIVER_HARNESS_NAMES } from "../store/driver-preference.js";

/** What the projection tells the page (RFC-12, "What the client is told").
 * The same object answers every poll, so it is built once and frozen by
 * construction - readonly fields, arrays nobody mutates. */
export interface DriverChoices {
  /** The four hcn knows: the seam's `HarnessName`, the same list the
   * endpoint validates a preference's harness against. */
  readonly harnesses: readonly HarnessName[];
  /** One entry per harness the installed hcn describes. An absent entry is
   * an absent dimension - never an empty list standing in for "none". */
  readonly vocabulary: Readonly<Partial<Record<HarnessName, HarnessVocabulary>>>;
}

/** The projection of inspect facts into the served lists. Pure, so a test
 * drives it with facts instead of a binary. */
export const driverChoicesFromFacts = (
  facts: Readonly<Partial<Record<HarnessName, HarnessFacts>>>,
): DriverChoices => ({
  harnesses: DRIVER_HARNESS_NAMES,
  vocabulary: Object.fromEntries(
    DRIVER_HARNESS_NAMES.flatMap((harness) => {
      const vocabulary = facts[harness]?.vocabulary;
      return vocabulary === undefined ? [] : [[harness, vocabulary] as const];
    }),
  ),
});

/** The memo. Null until the first read; a promise thereafter, whatever it
 * settles to - a refused inspect today would be re-read on every poll
 * otherwise, four spawns a tick for a harness that stays undescribed. */
let memoized: Promise<DriverChoices> | null = null;

/** The lists, from the installed hcn. A test injects a runner so the memo
 * stays untouched; production passes nothing and every caller shares one
 * read. Never rejects: a harness that cannot be asked simply has no entry. */
export const driverChoices = (runner?: HarnessRunner): Promise<DriverChoices> => {
  if (memoized !== null && runner === undefined) return memoized;
  const read = async (): Promise<DriverChoices> => {
    let hcn: HarnessRunner;
    try {
      hcn = runner ?? createHcnRunner(nodeHarnessDeps());
    } catch {
      return { harnesses: DRIVER_HARNESS_NAMES, vocabulary: {} };
    }
    const facts = await Promise.all(
      DRIVER_HARNESS_NAMES.map(async (harness) => {
        const fact = await hcn.inspect(harness).catch(() => undefined);
        return [harness, fact] as const;
      }),
    );
    return driverChoicesFromFacts(Object.fromEntries(facts));
  };
  const pending = read();
  if (runner === undefined) memoized = pending;
  return pending;
};
