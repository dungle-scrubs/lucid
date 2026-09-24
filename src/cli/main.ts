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
import { HubError } from "../protocol/hub-errors.js";
import { runCli } from "./dispatch.js";
import { requestNaming } from "./naming.js";

const run = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    console.log(version);
    return;
  }
  // Watch and native listening record shutdown when SIGINT/SIGTERM aborts the wait.
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  process.on("SIGINT", onAbort);
  process.on("SIGTERM", onAbort);
  const result = await runCli(argv, { signal: ac.signal, wakeNamingFn: requestNaming });
  if (result.kind === "reconnect") process.exitCode = result.exitCode;
  if (result.kind === "connection-control" && result.verdict === "refused") process.exitCode = 1;
  if (result.kind === "connection-listen" && result.verdict === "held") process.exitCode = 1;
  if (result.kind === "connection-setup" && result.verdict === "refused") process.exitCode = 1;
};

run().catch((e) => {
  // Machine callers match on code without parsing prose: with --json,
  // a HubError serializes as code plus message on stderr with exit 1.
  if (e instanceof HubError && process.argv.includes("--json")) {
    console.error(JSON.stringify({ code: e.code, message: e.message }));
  } else {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exit(1);
});
