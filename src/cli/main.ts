#!/usr/bin/env bun

/**
 * `lucid` CLI entry point — thin adapter over the deep `CliHost`.
 *
 * The `argv -> MappedCommand` parse, `LUCID_ROOT` resolution (once), and
 * `send/watch/run` effect routing live in `src/cli/dispatch.ts`. This
 * file is the process entry: it wires `process.argv`, the SIGINT/SIGTERM
 * abort for `watch`, and the `console` sinks, then delegates to
 * `runCli`. Hook commands (`announce`/`inject`) are also routed through
 * the host so `LUCID_ROOT` never fans out again.
 *
 * What it is NOT: it does not parse, validate, or own the flock.
 */

import { version } from "../../package.json";
import { runCli } from "./dispatch.js";
import { requestNaming } from "./naming.js";

const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    console.log(version);
    return;
  }
  // `watch` is the only long-lived command — give it a signal that
  // SIGINT/SIGTERM abort. The host forwards it; other commands ignore it.
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onAbort);
  await runCli(argv, { signal: ac.signal, wakeNamingFn: requestNaming });
};

run().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
