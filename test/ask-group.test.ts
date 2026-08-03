import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_GROUP_CHARS, decodeGroupText } from "../src/cli/ask-input.ts";
import { runAsk } from "../src/cli/run.ts";
import { readEvents, sessionState } from "../src/core/log.ts";
import { sessionPaths } from "../src/core/paths.ts";
import { ensureSessionDirs, openSession } from "../src/core/session.ts";

/**
 * Everything `lucid ask` refuses, and what it refuses it with.
 *
 * These were e2e scenarios: each one booted a hub, opened a session and loaded
 * a page to read a JSON error off stdout that no pixel was ever involved in.
 * Moved here per D-018 - a scenario that never touches paint does not need a
 * browser. What stays in e2e is the other half of the same story: that a
 * question the CLI DOES accept opens the drawer.
 *
 * The refusals split in two. The payload rules (empty, oversized, unparseable)
 * are a function of the text alone, so they are tested against
 * `decodeGroupText` directly - which is also the only way to reach the stdin
 * branch without a process to pipe into. The argument and contract rules run
 * through `runAsk` against a real session on disk, because half of each claim
 * is that nothing was appended to the log.
 */

describe("what `lucid ask` needs before it will ask anything", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-ask-group-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const openArtifact = async () => {
    const paths = sessionPaths(join(dir, "plan.html"));
    await writeFile(paths.artifactPath, "<!doctype html><html><body><h1>Hi</h1></body></html>");
    ensureSessionDirs(paths);
    await openSession(paths);
    return paths;
  };

  const eventCount = async (logPath: string): Promise<number> =>
    (await readEvents(logPath)).events.length;

  /** A group that is valid on every axis, so a refusal can only be the one under test. */
  const validGroup = async (): Promise<string> => {
    const file = join(dir, "group.json");
    await writeFile(file, JSON.stringify({ questions: [{ id: "ship", question: "Ship it?" }] }));
    return file;
  };

  test("neither --text nor --group leaves nothing to ask", async () => {
    const paths = await openArtifact();
    const before = await eventCount(paths.logPath);
    // Blank text is the same as no text. Without the trim an agent that
    // interpolated an empty variable would post a question with no words in
    // it, and the human would be asked to answer a blank drawer.
    for (const text of [undefined, "   "]) {
      await expect(runAsk(paths.artifactPath, text)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "lucid ask needs --text <question> or --group <file|->",
      });
    }
    expect(await eventCount(paths.logPath)).toBe(before);
  });

  test("--group beside --text, --option or --multi is refused, never quietly preferred", async () => {
    const paths = await openArtifact();
    const group = await validGroup();
    const before = await eventCount(paths.logPath);
    // Each of these asks would SUCCEED on its own - the group is well-formed
    // and so is every legacy flag beside it. Preferring one silently is how an
    // agent comes to believe it asked something it did not ask.
    const both: readonly [string | undefined, Parameters<typeof runAsk>[2]][] = [
      ["Ship it?", { group }],
      [undefined, { group, options: ["Postgres", "SQLite"] }],
      [undefined, { group, multi: true }],
    ];
    for (const [text, opts] of both) {
      await expect(runAsk(paths.artifactPath, text, opts)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "lucid ask takes --group or --text/--option/--multi, not both",
      });
    }
    expect(await eventCount(paths.logPath)).toBe(before);
  });

  test("--multi with nothing to pick from does not claim a multi-select", async () => {
    const paths = await openArtifact();
    await runAsk(paths.artifactPath, "What should we do?", { multi: true });
    const asked = (await sessionState(paths)).questions[0];
    // The question must EXIST before its missing fields mean anything -
    // `asked?.multi` is undefined just as readily when nothing was appended at
    // all, which would make the two assertions below hold for the wrong reason.
    expect(asked).toBeDefined();
    // A `multi` with no choices renders as the plain text box a free-text
    // question already is, so carrying the flag would only tell the agent's
    // own transcript that it offered a selection nobody was shown.
    expect(asked?.multi).toBeUndefined();
    expect(asked?.options).toBeUndefined();

    // The counterpart, so the assertion above is not passing for free: with
    // something to pick from, the same flag does survive.
    await runAsk(paths.artifactPath, "Which stores?", {
      multi: true,
      options: ["Postgres", "SQLite"],
    });
    const withChoices = (await sessionState(paths)).questions[1];
    expect(withChoices?.multi).toBe(true);
  });
});

describe("a --group payload has to be a payload first", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-ask-payload-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an empty stdin group is refused as an empty pipe, not as broken JSON", () => {
    // `--group - < /dev/null` is a pipeline mistake, not a malformed document,
    // and "unexpected end of JSON input" would send the agent to fix a file
    // that was never the problem.
    expect(() => decodeGroupText("", "-")).toThrowError("no question group on stdin");
    expect(() => decodeGroupText("   \n", "-")).toThrowError("no question group on stdin");
    // The same emptiness from a path is a different fact about the world: the
    // file is missing or unreadable (the reader hands unreadable in as "").
    expect(() => decodeGroupText("", "q.json")).toThrowError("cannot read question group: q.json");
  });

  test("malformed group JSON reports the parse problem and names its source", async () => {
    const paths = sessionPaths(join(dir, "plan.html"));
    await writeFile(paths.artifactPath, "<!doctype html><html><body><h1>Hi</h1></body></html>");
    ensureSessionDirs(paths);
    await openSession(paths);
    const groupFile = join(dir, "q.json");
    await writeFile(groupFile, "{not json");
    const before = (await readEvents(paths.logPath)).events.length;
    // Through the CLI rather than the decoder alone: a raw `SyntaxError`
    // escaping here is an unhandled rejection with a stack trace, which is
    // what the typed envelope exists to prevent.
    const failure = await runAsk(paths.artifactPath, undefined, { group: groupFile }).then(
      () => undefined,
      (e: unknown) => e as { code?: string; message?: string; detail?: { source?: string } },
    );
    expect(failure?.code).toBe("VALIDATION_ERROR");
    expect(failure?.message).toStartWith("question group is not valid JSON:");
    expect(failure?.detail?.source).toBe(groupFile);
    expect((await readEvents(paths.logPath)).events.length).toBe(before);
  });

  test("an oversized group is refused before anything tries to parse it", () => {
    // The payload is BOTH too large and unparseable. If the ceiling were
    // checked after `JSON.parse`, this would come back as a syntax error -
    // which is the whole failure the ceiling exists to avoid, since reaching
    // that verdict means the parser already materialized the megabytes.
    const oversized = `{"questions":[${"x".repeat(MAX_GROUP_CHARS)}`;
    expect(oversized.length).toBeGreaterThan(MAX_GROUP_CHARS);
    expect(() => decodeGroupText(oversized, "big.json")).toThrowError(
      `question group is too large (max ${MAX_GROUP_CHARS} characters)`,
    );

    // And the ceiling is a ceiling, not a smaller de facto limit: a payload of
    // exactly the maximum is still read.
    const padding = " ".repeat(MAX_GROUP_CHARS - `{"questions":[]}`.length);
    const atLimit = `{"questions":[]${padding}}`;
    expect(atLimit.length).toBe(MAX_GROUP_CHARS);
    expect(decodeGroupText(atLimit, "big.json")).toEqual({ questions: [] });
  });
});

describe("a group the question contract will not accept", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-ask-contract-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const askGroup = async (payload: unknown) => {
    const paths = sessionPaths(join(dir, "plan.html"));
    await writeFile(paths.artifactPath, "<!doctype html><html><body><h1>Hi</h1></body></html>");
    ensureSessionDirs(paths);
    await openSession(paths);
    const groupFile = join(dir, "group.json");
    await writeFile(groupFile, JSON.stringify(payload));
    const before = (await readEvents(paths.logPath)).events.length;
    const failure = await runAsk(paths.artifactPath, undefined, { group: groupFile }).then(
      () => undefined,
      (e: unknown) =>
        e as {
          code?: string;
          message?: string;
          detail?: { issues?: readonly { code: string; message: string }[] };
        },
    );
    return { failure, appended: (await readEvents(paths.logPath)).events.length - before };
  };

  test("six questions are refused, with the at-most-five rule in the issues", async () => {
    const { failure, appended } = await askGroup({
      questions: Array.from({ length: 6 }, (_, i) => ({
        id: `q${i + 1}`,
        question: `Question ${i + 1}?`,
      })),
    });
    expect(failure?.code).toBe("VALIDATION_ERROR");
    // The issues list, not just a refusal: the agent authored this group and
    // has to know which rule to author against next time.
    expect(failure?.detail?.issues?.map((i) => i.code)).toEqual(["too_many_questions"]);
    expect(failure?.message).toContain("at most 5 questions, got 6");
    // A partly-recorded ask would leave the drawer holding a group nobody can
    // finish answering.
    expect(appended).toBe(0);
  });

  test("a question that must be picked from, with nothing to pick from, is refused", async () => {
    const { failure, appended } = await askGroup({
      questions: [{ id: "stores", question: "Which stores?", multiSelect: true, choices: [] }],
    });
    expect(failure?.code).toBe("VALIDATION_ERROR");
    expect(failure?.detail?.issues?.[0]).toMatchObject({
      code: "missing_choices",
      questionId: "stores",
    });
    expect(appended).toBe(0);

    // Why the fixture must set `multiSelect`: the answer shape is DERIVED, so
    // the same question without it is a legitimate free-text question rather
    // than a broken choice one. A fixture that merely omitted the choices
    // would assert a refusal the code is right never to make.
    const free = await askGroup({
      questions: [{ id: "stores", question: "Which stores?", choices: [] }],
    });
    expect(free.failure).toBeUndefined();
    expect(free.appended).toBeGreaterThan(0);
  });
});
