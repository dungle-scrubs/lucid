import { DEAD_HUB_PORT } from "./e2e/harness-env.ts";

/**
 * Run before every unit test file, via `bunfig.toml`.
 *
 * One job: make sure no test can discover the hub the developer happens to be
 * running. `LUCID_HUB_PORT` is where `open`, `deliver` and the CLI look for an
 * always-on hub, and left unset they find the real one - which then hosts the
 * session, answers requests the test meant for its own server, and makes the
 * result depend on whether somebody had Lucid open at the time.
 *
 * That was not hypothetical. Three tests in `attend.test.ts` failed only when a
 * hub was running and passed on a freshly booted machine; reproduced by
 * starting `lucid hub --attend` and watching them fail again (D-033). Two more
 * files reach discovery with the same hole and have simply been lucky.
 *
 * Done here rather than in each `beforeEach` because per-file containment is
 * exactly what failed: every one of those files believed it was hermetic, and
 * each had pinned the paths it thought of. A preload cannot be forgotten by the
 * next file, and no unit test depends on the default - `daemon.test.ts` always
 * passes an explicit `port: 0`, and the `17428` in `ports.test.ts` is a pure
 * function's expected output, not an environment read.
 *
 * Deliberately does not overwrite an existing value: a test that sets its own
 * port is making a decision, and this is a floor, not a policy.
 */
process.env.LUCID_HUB_PORT ??= DEAD_HUB_PORT;
