import { applyUnitEnv } from "./unit-env.ts";

/**
 * Run before every unit test file, via `bunfig.toml`.
 *
 * One job: make sure no unit test reads, or writes, anything belonging to the
 * human running it. `bun test` inherits the developer's whole environment, and
 * every variable Lucid leaves unset resolves into their real home - their
 * settings, their session history, their session registry, the folders their
 * own shell scans. A test that reads those is not measuring the product; it is
 * measuring the machine.
 *
 * Done here rather than in each `beforeEach` because per-file containment is
 * exactly what failed: three files reach hub discovery, each had pinned the
 * paths it thought of, and only one had considered the hub. `LUCID_SETTINGS`
 * was pinned by none of them, so `readSettingsCached()` - reached through the
 * session host `attend.test.ts` drives - read the developer's real
 * `~/.lucid/settings.json` on every run. A preload cannot be forgotten by the
 * next file.
 *
 * Only the path-valued names are pinned: a behaviour switch like
 * `LUCID_NO_OPEN` reads nothing off disk, and forcing one onto the unit suite
 * would change what these tests are testing. What each name is, and why, lives
 * in `test/e2e/harness-env.ts`; how it is applied lives in `test/unit-env.ts`,
 * which tests also use to put containment back after borrowing a variable.
 *
 * The hub pin is a hole this suite has, not a diagnosis of any failure it has
 * shown: the intermittent `attend.test.ts` failures once blamed on a running
 * hub were something else entirely - the suite degrading `syspolicyd` by
 * executing copied binaries, which stalled every process spawn (D-035 retracts
 * D-033). No unit test depends on the unpinned default: `daemon.test.ts` always
 * passes an explicit `port: 0`, and the `17428` in `ports.test.ts` is a pure
 * function's expected output, not an environment read.
 */
applyUnitEnv();
