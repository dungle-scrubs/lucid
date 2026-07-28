# Known flakes

A test that fails once and passes on retry. `playwright.config.ts` sets
`retries: 1` with `failOnFlakyTests`, so a flake does not hide - it turns the
whole run red and lands here.

## The rule this file exists to enforce

**A fix that passes once against a flake is evidence of nothing.** An
intermittent failure that reproduces at, say, one run in fifteen will "pass"
after any change at all, including a change that made it worse. The only honest
way to claim a flake is fixed is to measure its RATE on both arms - at least 20
runs unchanged, at least 20 runs with the fix - and show the rate moved.

So the entries below record what was OBSERVED, and state plainly where the rate
is unknown. Nobody should "fix" one of these and check the box on a single
green run.

## Why every rate below is unmeasured

Measuring a rate needs the suite run in a loop, and **this suite must not be run
in a loop on this machine.** Repeated runs of an older version of it wedged
macOS `syspolicyd` and cost two hard restarts. The cause is fixed and a guard
test covers it, so a single full run is routine - a 20-run arm is not, and 40
runs across two arms is the exact shape that caused the damage.

That is a real constraint, not a deferral dressed up as one. It means these two
flakes are carried, visibly, at an unknown rate, and it means the measurement
pass needs somewhere other than this machine to happen - a second Mac, or a
throwaway VM - before either entry can move.

Recording that is the point. A ledger that said "flaky, will investigate" would
read as work queued; this says the measurement is *blocked on hardware*, which
is a different problem with a different fix.

## Entries

### F-1 - a message sent at a dead server is kept, not eaten

- **Test:** `test/e2e/loop.e2e.ts` :: `a message sent at a dead server is kept,
  not eaten, and delivers itself on reconnect`
- **First observed:** the M3.2 full-suite run. 95 passed, 1 flaky, 1 skipped,
  3.1m. Failed once, passed on retry.
- **Occurrences since:** none observed. Not the same as "does not recur" - the
  suite has not been run enough times to distinguish the two.
- **Rate:** unmeasured (see above).
- **What is known:** the `regression` project carries its own copy of this
  behaviour, `f107e28-message-survives-a-dead-server`, and that copy has never
  flaked. The two differ in what surrounds them, not in what they assert, which
  makes the surroundings the first place to look - suite position, and what the
  preceding test left running - rather than the dead-server logic itself.
- **Plan-db:** finding #32.

### F-2 - the palette activates an already-open tab

- **Test:** `test/e2e/tabs-focus.e2e.ts` :: `the palette activates an
  already-open tab instead of opening a second one`
- **First observed:** an M4.2 full-suite run. 142 passed, 1 flaky, 1 skipped,
  5.0m. Failed once, passed on retry.
- **Occurrences since:** none observed. Same caveat as F-1.
- **Rate:** unmeasured (see above).
- **What is known:** the same run carried the entire hostile corpus without
  incident, so whatever this is, it is not general instability under load. The
  test landed in M4.1 (#68) and flaked on the next full run after it.
- **Plan-db:** finding #49.

## Adding an entry

A flake turns a run red, so it cannot be added later from memory. When one
happens: record the test, the run it happened on with its totals, and what else
was true about that run. Do not record a theory - the theory is what the
measurement is for.
