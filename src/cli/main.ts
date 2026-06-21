#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import { toErrorJson, type LucidError } from "../errors.ts";
import { runEnd, runOpen, runServe, runStatus, runWaitCli } from "./run.ts";

const isLucidError = (e: unknown): e is LucidError =>
  typeof e === "object" &&
  e !== null &&
  "code" in e &&
  typeof (e as { code: unknown }).code === "string";

/** Wrap an async command body: print structured error JSON + exit 1 on failure. */
const runEffect = (fn: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({ try: fn, catch: (e) => e }).pipe(
    Effect.catchAll((err) =>
      Effect.sync(() => {
        const envelope = isLucidError(err)
          ? toErrorJson(err)
          : {
              error: {
                code: "SERVER_ERROR",
                message: String((err as Error)?.message ?? err),
                detail: {},
              },
            };
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
        process.exitCode = 1;
      }),
    ),
  );

const fileArg = Args.file({ name: "file" });

const noOpen = Options.boolean("no-open").pipe(Options.withDefault(false));
const openCommand = Command.make("open", { file: fileArg, noOpen }, ({ file, noOpen }) =>
  runEffect(() => runOpen(file, { open: !noOpen })),
);

const sinceOpt = Options.text("since").pipe(Options.optional);
const replyOpt = Options.text("reply").pipe(Options.optional);
const harnessOpt = Options.text("harness").pipe(Options.optional);
const timeoutOpt = Options.integer("timeout").pipe(Options.optional);
const waitCommand = Command.make(
  "wait",
  { file: fileArg, since: sinceOpt, reply: replyOpt, harness: harnessOpt, timeout: timeoutOpt },
  ({ file, since, reply, harness, timeout }) =>
    runEffect(() =>
      runWaitCli(file, {
        since: Option.getOrUndefined(since),
        reply: Option.getOrUndefined(reply),
        harness: Option.getOrUndefined(harness),
        timeoutMs: Option.match(timeout, { onNone: () => undefined, onSome: (s) => s * 1000 }),
      }),
    ),
);

const endCommand = Command.make("end", { file: fileArg }, ({ file }) =>
  runEffect(() => runEnd(file)),
);

const serveCommand = Command.make("__serve", { file: fileArg }, ({ file }) =>
  runEffect(() => runServe(file)),
);

const lucid = Command.make("lucid", {}, () => runEffect(() => runStatus())).pipe(
  Command.withSubcommands([openCommand, waitCommand, endCommand, serveCommand]),
);

const cli = Command.run(lucid, {
  name: "Lucid - addressable HTML artifacts for agent-human review",
  version: "0.1.0",
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
