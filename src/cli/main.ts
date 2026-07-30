#!/usr/bin/env bun
import { Args, Command, HelpDoc, Options, ValidationError } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Logger, Option } from "effect";
// Aliased, because `@effect/cli` exports a `ValidationError` too and this file
// imports both. They are unrelated types with the same name; `isValidationError`
// is TypeId-based so the runtime can never confuse them, but a reader can.
import {
  isLucidError,
  toErrorJson,
  ValidationError as LucidValidationError,
  type LucidError,
} from "../errors.ts";
import { warnUnknownSubsystems } from "../core/verbose.ts";
import {
  runApp,
  runAsk,
  runIntent,
  runProgress,
  runContext,
  runEnd,
  runHub,
  runLaunchCli,
  runOpen,
  runPlanIngest,
  runPlanRender,
  runServe,
  runStatus,
  runWaitCli,
} from "./run.ts";

/** Wrap an async command body: print structured error JSON + exit 1 on failure. */
const runEffect = (fn: () => Promise<void>): Effect.Effect<void> => {
  // Said once, before the command runs: `LUCID_VERBOSE=1` is the likeliest
  // thing a human types, and dropping it in silence is the failure the closed
  // subsystem list exists to prevent. On stderr, since stdout is one JSON
  // document.
  warnUnknownSubsystems();
  return runEffectBody(fn);
};

const runEffectBody = (fn: () => Promise<void>): Effect.Effect<void> =>
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
const restart = Options.boolean("restart").pipe(Options.withDefault(false));
const openCommand = Command.make(
  "open",
  { file: fileArg, noOpen, restart },
  ({ file, noOpen, restart }) => runEffect(() => runOpen(file, { open: !noOpen, restart })),
);

const sinceOpt = Options.text("since").pipe(Options.optional);
const replyOpt = Options.text("reply").pipe(Options.optional);
const harnessOpt = Options.text("harness").pipe(Options.optional);
const resumeOpt = Options.text("resume").pipe(Options.optional);
const timeoutOpt = Options.integer("timeout").pipe(Options.optional);
const waitCommand = Command.make(
  "wait",
  {
    file: fileArg,
    since: sinceOpt,
    reply: replyOpt,
    harness: harnessOpt,
    resume: resumeOpt,
    timeout: timeoutOpt,
  },
  ({ file, since, reply, harness, resume, timeout }) =>
    runEffect(() =>
      runWaitCli(file, {
        since: Option.getOrUndefined(since),
        reply: Option.getOrUndefined(reply),
        harness: Option.getOrUndefined(harness),
        resume: Option.getOrUndefined(resume),
        timeoutMs: Option.match(timeout, { onNone: () => undefined, onSome: (s) => s * 1000 }),
      }),
    ),
);

const endCommand = Command.make("end", { file: fileArg }, ({ file }) =>
  runEffect(() => runEnd(file)),
);

const pollOpt = Options.integer("poll").pipe(Options.optional);
const launchCommand = Command.make("launch", { file: fileArg, poll: pollOpt }, ({ file, poll }) =>
  runEffect(() => runLaunchCli(file, { ...(Option.isSome(poll) ? { pollMs: poll.value } : {}) })),
);

// `--text` is optional only because `--group` is the other way to ask; runAsk
// requires one of them and says so.
const askText = Options.text("text").pipe(Options.optional);
const askRef = Options.text("ref").pipe(Options.optional);
const askOption = Options.text("option").pipe(Options.repeated);
const askMulti = Options.boolean("multi").pipe(Options.withDefault(false));
/** Path to the grouped-question JSON (D12), or "-" to read it from stdin. */
const askGroup = Options.text("group").pipe(Options.optional);
const askCommand = Command.make(
  "ask",
  {
    file: fileArg,
    text: askText,
    ref: askRef,
    option: askOption,
    multi: askMulti,
    group: askGroup,
  },
  ({ file, text, ref, option, multi, group }) =>
    runEffect(() =>
      runAsk(file, Option.getOrUndefined(text), {
        ref: Option.getOrUndefined(ref),
        options: option,
        multi,
        group: Option.getOrUndefined(group),
      }),
    ),
);

const intentArg = Args.choice(
  [
    ["revise", "revise"],
    ["reply", "reply"],
  ],
  { name: "intent" },
);
const intentCommand = Command.make(
  "intent",
  { file: fileArg, intent: intentArg },
  ({ file, intent }) => runEffect(() => runIntent(file, intent as "revise" | "reply")),
);

const progressLabel = Options.text("label").pipe(Options.optional);
const progressTotal = Options.integer("total").pipe(Options.optional);
const progressDone = Options.integer("done").pipe(Options.optional);
const progressCommand = Command.make(
  "progress",
  { file: fileArg, label: progressLabel, total: progressTotal, done: progressDone },
  ({ file, label, total, done }) =>
    runEffect(() =>
      runProgress(file, {
        label: Option.getOrUndefined(label),
        total: Option.getOrUndefined(total),
        done: Option.getOrUndefined(done),
      }),
    ),
);

const ctxPct = Options.integer("pct").pipe(Options.optional);
const ctxUsed = Options.integer("used").pipe(Options.optional);
const ctxTotal = Options.integer("total").pipe(Options.optional);
const contextCommand = Command.make(
  "context",
  { file: fileArg, pct: ctxPct, used: ctxUsed, total: ctxTotal },
  ({ file, pct, used, total }) =>
    runEffect(() =>
      runContext(file, {
        pct: Option.getOrUndefined(pct),
        used: Option.getOrUndefined(used),
        total: Option.getOrUndefined(total),
      }),
    ),
);

const serveCommand = Command.make("__serve", { file: fileArg }, ({ file }) =>
  runEffect(() => runServe(file)),
);

const hubPortOpt = Options.integer("port").pipe(Options.optional);
const hubAttendOpt = Options.boolean("attend").pipe(Options.withDefault(false));
const hubCommand = Command.make(
  "hub",
  { port: hubPortOpt, attend: hubAttendOpt },
  ({ port, attend }) => runEffect(() => runHub({ port: Option.getOrUndefined(port), attend })),
);

const appCommand = Command.make("app", {}, () => runEffect(() => runApp()));

// `lucid plan render|ingest` - the planner bridge.
const docArg = Args.file({ name: "doc" });
const outOpt = Options.file("out").pipe(Options.optional);
const titleOpt = Options.text("title").pipe(Options.optional);
const stageOpt = Options.text("stage").pipe(Options.optional);
const forceOpt = Options.boolean("force").pipe(Options.withDefault(false));
const planRenderCommand = Command.make(
  "render",
  { doc: docArg, out: outOpt, title: titleOpt, stage: stageOpt, force: forceOpt },
  ({ doc, out, title, stage, force }) =>
    runEffect(() =>
      runPlanRender(doc, {
        out: Option.getOrUndefined(out),
        title: Option.getOrUndefined(title),
        stage: Option.getOrUndefined(stage),
        force,
      }),
    ),
);
const planOpt = Options.text("plan");
const payloadOpt = Options.file("payload").pipe(Options.optional);
const planIngestCommand = Command.make(
  "ingest",
  { plan: planOpt, payload: payloadOpt },
  ({ plan, payload }) => runEffect(() => runPlanIngest(plan, Option.getOrUndefined(payload))),
);
const planCommand = Command.make("plan", {}, () =>
  runEffect(async () => {
    // `lucid plan` on its own names no subcommand, which is a refusal, not an
    // answer - it used to print two lines of usage to STDOUT and exit 0, which
    // is both of the defects this milestone fixed, in the one command that did
    // not go through either path. The usage goes to stderr where the words
    // belong, and the refusal answers on stdout in the envelope.
    process.stderr.write(
      "lucid plan render <doc.md> [--out <file>] [--title <t>] [--stage <s>] [--force]\nlucid plan ingest --plan <name> [--payload <file>]  (or pipe `lucid wait` JSON to stdin)\n",
    );
    throw new LucidValidationError({
      message: "plan needs a subcommand - use one of 'render', 'ingest'",
      detail: {},
    });
  }),
).pipe(Command.withSubcommands([planRenderCommand, planIngestCommand]));

const lucid = Command.make("lucid", {}, () => runEffect(() => runStatus())).pipe(
  Command.withSubcommands([
    openCommand,
    waitCommand,
    endCommand,
    launchCommand,
    askCommand,
    intentCommand,
    progressCommand,
    contextCommand,
    serveCommand,
    hubCommand,
    appCommand,
    planCommand,
  ]),
);

const cli = Command.run(lucid, {
  name: "Lucid - addressable HTML artifacts for agent-human review",
  version: "0.3.0", // x-release-please-version
});

/**
 * Nothing Effect logs goes to stdout.
 *
 * The CLI's OWN refusals - an unknown subcommand, an argument outside its set,
 * a missing option - fail before any handler runs, so they were logged as a
 * formatted block:
 *
 *     [16:59:59] ERROR (#17):
 *       Error: {"_tag":"CommandMismatch","error":{...}}
 *
 * That breaks the one promise the CLI makes to an agent: stdout is one JSON
 * document. `JSON.parse(stdout)` then throws a parser error pointing at the
 * caller's own code, for a refusal the CLI could have named.
 *
 * `disablePrettyLogger` is the part that matters, and it took a review to find
 * out why. `runMain` installs `prettyLoggerDefault` into the ROOT fiber refs
 * before the effect runs, and that logger writes to stdout via `console.log`.
 * A `Logger.replace(Logger.defaultLogger, …)` inside the effect therefore
 * removes nothing - the default is no longer there to replace - and merely
 * ADDS a second logger, so every log line went to both channels and the one
 * that mattered still reached stdout. The stderr logger below is now the only
 * logger, rather than a second opinion.
 */
const logToStderr = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ message }) => {
    const parts = Array.isArray(message) ? message : [message];
    process.stderr.write(`${parts.map((m) => String(m)).join(" ")}\n`);
  }),
);

/**
 * The CLI's own refusals, in the envelope every other refusal already uses.
 *
 * `runEffect` covers failures INSIDE a command body; these happen before one is
 * chosen, so they never reached it. A help or version request is not a refusal
 * and is left alone - it has already printed what it was asked for.
 */
const asEnvelope = (error: unknown): { readonly error: LucidError } | undefined => {
  if (!ValidationError.isValidationError(error)) return undefined;
  // No help/version guard here, deliberately. Both are answers rather than
  // refusals, and both are handled inside `cliApp.run` before this catch ever
  // sees them - an earlier version excluded `NoBuiltInMatch`, which is
  // swallowed by the built-in `orElse` and never arrives either. A guard that
  // protects nothing reachable reads as though it does.
  return {
    error: {
      code: "USAGE",
      // The same words stderr already carries, so the two never disagree.
      message: HelpDoc.toAnsiText(error.error).trim(),
      detail: {},
    } as unknown as LucidError,
  };
};

cli(process.argv).pipe(
  Effect.provide(BunContext.layer),
  Effect.provide(logToStderr),
  Effect.catchAll((error) => {
    const envelope = asEnvelope(error);
    if (!envelope) return Effect.fail(error);
    return Effect.sync(() => {
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      process.exitCode = 1;
    });
  }),
  (effect) =>
    // The pretty logger is what wrote to stdout; error reporting would re-log
    // the failure this catch has already answered.
    BunRuntime.runMain(effect, { disablePrettyLogger: true, disableErrorReporting: true }),
);
