/**
 * Print the environment an e2e run is judged by, and refuse the run when a
 * silent fallback would make its results describe code production never runs.
 *
 * The e2e job is the run every later claim about coverage rests on, so what it
 * ran ON has to be part of the record. A green run is only evidence if you can
 * say which platform, which Bun, and - the one that actually bites - which
 * append-lock implementation it exercised.
 *
 * `lock.ts` prefers real `flock(2)` through FFI and falls back to an `O_EXCL`
 * lockfile mutex if `dlopen` fails for any reason. The two are not equivalent:
 * `flock` auto-releases when the holding process dies, while the fallback has to
 * infer death from a 10s staleness window. Every concurrency scenario in the
 * catalogue is a statement about the first one. If the runner image quietly took
 * the second, those scenarios would still go green - and would be measuring code
 * no user ever runs. That is worth failing the job over, loudly, rather than
 * discovering it the first time a concurrent append tears a log line in the wild.
 */
import { lockBackend } from "../src/core/lock.ts";

const backend = lockBackend();

console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    node: process.version,
    lockBackend: backend,
    ci: process.env.CI === "true",
  }),
);

if (backend !== "flock") {
  console.error(
    "::error::append lock fell back to the lockfile mutex - bun:ffi could not open libc on this runner. " +
      "Concurrency results from this run would describe an implementation production does not use.",
  );
  process.exit(1);
}
