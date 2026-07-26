#!/usr/bin/env bun
import { Args, Command, Options } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import { toErrorJson, type LucidError } from "../errors.ts";
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
const planRenderCommand = Command.make(
  "render",
  { doc: docArg, out: outOpt, title: titleOpt, stage: stageOpt },
  ({ doc, out, title, stage }) =>
    runEffect(() =>
      runPlanRender(doc, {
        out: Option.getOrUndefined(out),
        title: Option.getOrUndefined(title),
        stage: Option.getOrUndefined(stage),
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
    process.stdout.write(
      "lucid plan render <doc.md> [--out <file>] [--title <t>] [--stage <s>]\nlucid plan ingest --plan <name> [--payload <file>]  (or pipe `lucid wait` JSON to stdin)\n",
    );
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
  version: "0.2.0", // x-release-please-version
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
