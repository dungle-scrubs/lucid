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
- **Occurrences since:** none observed, across an unknown but small number of
  full runs - including the M6.1 gate run (178 passed, 1 skipped, 7.9m, zero
  flaky). That is not the same as "does not recur": one clean run is exactly
  what a one-in-fifteen flake looks like most of the time.
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
- **Occurrences since:** the M6.1 gate run carried it green in 1.0s. It then
  **flaked again on the `workers: 4` experiment** (finding #62) - the second
  observed occurrence, and the first with a captured failure mode:

  ```
  Error: expect(locator).toBeFocused() failed
  Locator:  locator('[data-test="palette-input"]')
  Expected: focused / Received: inactive / Timeout: 10000ms
  ```

  The palette opened; the focus never arrived. That is a real narrowing - it
  rules out the palette failing to open, and points at the focus handoff.
- **Rate:** unmeasured, and now known to be **load-sensitive**: 2 occurrences
  in roughly a dozen serial runs, one of which came on the first run under four
  workers. If contention is the trigger, the serial rate and the parallel rate
  are different numbers and both need measuring separately - which makes the
  20-runs-per-arm requirement two arms wider, not narrower.
- **What is known:** the same run carried the entire hostile corpus without
  incident, so whatever this is, it is not general instability under load. The
  test landed in M4.1 (#68) and flaked on the next full run after it.
- **Plan-db:** finding #49.

## Not a flake: the orphan the teardown reports

Every full run ends with the global teardown reporting survivors, and the M6.1
gate run reported one:

```
[e2e teardown] 1 process outlived the suite - killing:
  33560  bun .../src/cli/main.ts __serve /tmp/lucid-e2e-.../plan.html
```

This is **not** intermittent and does not belong above. It is finding #55, a
product defect: two simultaneous `lucid open` of one artifact leave a server
with no descriptor, so `lucid end` cannot find it, the listing cannot see it,
and it holds its port until someone kills it by hand. The teardown kills it, so
the suite stays green and the machine stays clean - which is precisely why it
needs to be written down somewhere. A defect whose only symptom is a line in a
teardown log is one nobody will notice has stopped being fixed.

## Adding an entry

A flake turns a run red, so it cannot be added later from memory. When one
happens: record the test, the run it happened on with its totals, and what else
was true about that run. Do not record a theory - the theory is what the
measurement is for.
