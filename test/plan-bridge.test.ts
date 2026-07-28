import { describe, expect, test } from "bun:test";
import type { WaitPayload } from "../src/core/payload.ts";
import { ArtifactError } from "../src/errors.ts";
import { ingestPayload, parseWaitPayloadInput } from "../src/plan/ingest.ts";
import { planArtifactPath } from "../src/plan/render.ts";

/**
 * The planner bridge's text-in/value-out edges: where `plan render` decides to
 * write, and what `plan ingest` makes of the bytes it is handed.
 *
 * These were e2e scenarios. Each one spent a CLI spawn, a temp tree and a file
 * write to ask a question that is answered before any of that happens - a path
 * derivation, a JSON refusal, a quoting rule. Moved here per D-018: a scenario
 * that never touches paint does not need a browser.
 *
 * What did NOT move: that `plan render` actually creates the file at the path
 * it derived, that the printed `{artifact, next}` envelope reaches stdout, and
 * that a refusal exits 1 with an `ARTIFACT_ERROR` envelope. Those are claims
 * about the CLI process, and they stay in e2e.
 */

describe("where plan render writes", () => {
  test("a doc renders beside itself as <doc>.lucid.html, and --out overrides that", () => {
    expect(planArtifactPath("/w/notes.md")).toBe("/w/notes.lucid.html");
    // Not "beside the doc, renamed": a planner writing a review into a durable
    // directory has to be able to send it somewhere the doc is not.
    expect(planArtifactPath("/w/notes.md", "/durable/custom.html")).toBe("/durable/custom.html");
  });

  test("both routes end at an absolute path", () => {
    // The derived path is printed straight back as `lucid open <path>`. A
    // relative one resolves against whatever directory the NEXT process starts
    // in, which for an agent handing the string to a fresh shell is a different
    // one often enough to matter.
    const derived = planArtifactPath("notes.md");
    const explicit = planArtifactPath("notes.md", "out/custom.html");
    expect(derived.startsWith("/")).toBe(true);
    expect(explicit.startsWith("/")).toBe(true);
    expect(derived.endsWith("/notes.lucid.html")).toBe(true);
    expect(explicit.endsWith("/out/custom.html")).toBe(true);
  });

  test("only a trailing .md is traded away", () => {
    // An unanchored match would eat the FIRST `.md` in the whole path, so a doc
    // whose name or folder contains one gets written to a directory that does
    // not exist and the render dies on an ENOENT nobody can read.
    expect(planArtifactPath("/w/README.md-draft.md")).toBe("/w/README.md-draft.lucid.html");
    expect(planArtifactPath("/w/plans.md/phase-one.md")).toBe("/w/plans.md/phase-one.lucid.html");
  });

  test("a doc with no .md extension keeps its whole name", () => {
    expect(planArtifactPath("/w/PLAN")).toBe("/w/PLAN.lucid.html");
  });
});

describe("plan ingest reads its input", () => {
  test("input that is not JSON is a typed refusal, not a raw SyntaxError", () => {
    // Input arrives from a pipe, so the ordinary failure is a shell that sent a
    // log line where the payload should have been. `ArtifactError` is what the
    // CLI turns into the exit-1 `ARTIFACT_ERROR` envelope, and that envelope is
    // the only thing a script chaining `lucid wait | lucid plan ingest` can
    // branch on - a bare SyntaxError would escape as an unhandled crash.
    let thrown: unknown;
    try {
      parseWaitPayloadInput("not json");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ArtifactError);
    expect((thrown as ArtifactError).code).toBe("ARTIFACT_ERROR");
    expect((thrown as ArtifactError).message).toBe("could not parse wait payload JSON from input");
  });

  test("truncated JSON is refused rather than half-read", () => {
    // A pipe that closed mid-write is the realistic corruption: the text starts
    // out looking exactly like a payload.
    expect(() => parseWaitPayloadInput('{"plan":"p","annotations":[')).toThrow(ArtifactError);
  });

  test("a real payload survives the read intact", () => {
    const payload = emptyPayload();
    expect(parseWaitPayloadInput(JSON.stringify(payload))).toEqual(payload);
  });
});

const emptyPayload = (over: Partial<WaitPayload> = {}): WaitPayload => ({
  session: "/w/plan.lucid.html",
  version: 1,
  status: "waiting",
  nextCursor: "evt_00003",
  reviewResolved: false,
  annotations: [],
  messages: [],
  ...over,
});

/**
 * Split an emitted command the way a shell would: a double quote opens and
 * closes a word, and inside one a backslash escapes the next character.
 *
 * Deliberately a second implementation rather than a reuse of the module's own
 * `esc`. A test that quoted with the same code it is checking would agree with
 * that code about everything, including being wrong.
 */
const shellWords = (command: string): string[] => {
  const words: string[] = [];
  let word = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quoted && c === "\\") {
      word += command[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) words.push(word);
  return words;
};

const annotationOn = (lucidId: string, note: string): WaitPayload["annotations"][number] => ({
  id: "a1",
  version: 1,
  resolved: true,
  target: {
    kind: "element",
    lucidId,
    fingerprint: "f",
    domPath: "li",
    snippet: "<li>which shell?</li>",
  },
  note,
  at: "2026-01-01T00:00:00Z",
});

describe("what a human note can do to an emitted command", () => {
  test("quotes and backslashes stay inside one argument", () => {
    const note = String.raw`he said "do it\now"`;
    const result = ingestPayload(
      emptyPayload({ annotations: [annotationOn("Q-1", note)] }),
      "lucid",
    );
    const command = result.commands[0] as string;

    expect(command).toContain(String.raw`--decision "he said \"do it\\now\""`);
    // The note comes back out of the quoting byte-for-byte, as ONE word: an
    // escape that dropped the backslash would still round-trip the quotes and
    // still look fine here, so the raw backslash is the part being pinned.
    expect(shellWords(command)).toContain(note);
  });

  test("a note that looks like a second command stays an argument", () => {
    // The injection shape: close the quote, chain a command, reopen. If the
    // escaping leaks, `rm` becomes a word of its own in the parse.
    const note = `x"; rm -rf /tmp/lucid; echo "y`;
    const result = ingestPayload(
      emptyPayload({ annotations: [annotationOn("D-014", note)] }),
      "lucid",
    );
    const words = shellWords(result.commands[0] as string);

    expect(words).not.toContain("rm");
    expect(words).not.toContain(";");
    expect(words.some((w) => w.includes(note))).toBe(true);
  });

  test("a plan name is quoted like everything else", () => {
    // The plan name is an argument too, and it comes from the caller's shell.
    const result = ingestPayload(emptyPayload({ annotations: [annotationOn("D-1", "n")] }), 'a"b');
    expect(shellWords(result.commands[0] as string)).toContain('a"b');
  });
});

describe("an empty review", () => {
  test("a payload with nothing in it invents no commands", () => {
    // The planner RUNS what comes back. A summary line, a placeholder finding,
    // anything at all emitted for a review nobody wrote is a plan-db mutation
    // no human asked for.
    expect(ingestPayload(emptyPayload(), "p")).toEqual({ plan: "p", items: [], commands: [] });
  });

  test("an unresolved review is silent even with the approval key present", () => {
    // `reviewResolved: false` is on every payload, so the approval branch is
    // reached on every empty ingest and only its falsiness keeps it quiet.
    const result = ingestPayload(emptyPayload({ reviewResolved: false }), "p");
    expect(result.items).toEqual([]);
    expect(result.commands).toEqual([]);
  });

  test("only human messages become findings", () => {
    // An agent's own replies are in the same list. Ingesting them would file
    // the agent's words back into the plan as human review.
    const result = ingestPayload(
      emptyPayload({
        messages: [{ role: "agent", text: "here is the plan", at: "2026-01-01T00:00:00Z", seq: 1 }],
      }),
      "p",
    );
    expect(result.commands).toEqual([]);
  });
});
