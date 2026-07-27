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
 * catalogue is a statement about the first one, so on the fallback those
 * scenarios would still go green while measuring code no user runs.
 *
 * A warning here, not a refusal. The suite has no concurrency assertions yet -
 * they arrive with `concurrent-cli` in M5.4 - and failing this step would block
 * every unrelated test in the gate to protect assertions that do not exist,
 * hostage to a runner-image change. The hard refusal belongs with the scenarios
 * it protects; M5.4 owns it. What matters today is that the choice is in the
 * record instead of being invisible.
 *
 * Note it measures THIS process. Every append happens in a `bun run …/main.ts`
 * child, on the same Bun and platform - a sound proxy, not the run itself.
 */
import { lockBackend } from "../src/core/lock.ts";
import { hubPort, portBase, sessionPortPool } from "../src/server/ports.ts";

const backend = lockBackend();
const base = portBase(process.env);

console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    node: process.version,
    lockBackend: backend,
    ci: process.env.CI === "true",
    // The ports THIS process would bind, which is worker 0's set: the stamp is
    // its own CI step and runs outside every worker, so TEST_PARALLEL_INDEX is
    // not set here and the base is always 0. Recorded anyway because it pins
    // the unshifted layout, and named honestly so nobody reads it as evidence
    // about what a parallel run did. Each server logs the base it actually
    // bound with, which is where that answer lives.
    portBaseHere: base,
    unshiftedSessionPorts: sessionPortPool(base),
    unshiftedHubPort: hubPort(base),
  }),
);

if (backend !== "flock") {
  // GitHub's annotation syntax only where GitHub is reading; a bare sentence is
  // what a human at a terminal wants.
  const message =
    "append lock fell back to the lockfile mutex - bun:ffi could not open libc here. " +
    "Concurrency behaviour on this run is NOT the implementation production uses.";
  console.error(process.env.GITHUB_ACTIONS === "true" ? `::warning::${message}` : message);
}
