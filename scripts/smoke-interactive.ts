/**
 * The interactive adapter, end to end.
 *
 * The other live lanes all drive a harness lucid owns, through hcn. This one
 * drives the mode where lucid owns nothing: a claude process started outside
 * lucid, with lucid's hooks installed in project scope. lucid attaches when
 * the session starts, and interjects a queued input at the turn boundary.
 *
 * This lane verifies hook attachment and delivery against the same
 * durable protocol as the headless lanes.
 *
 * What it proves, and why each part matters:
 *
 *   1. SessionStart announces      - lucid attaches to a process it did not
 *                                    start, at profile `interactive`
 *   2. The Stop hook interjects    - a queued input reaches the session as
 *                                    HUMAN FEEDBACK, at a boundary
 *   3. The session acts on it      - the answer proves delivery, not just
 *                                    that a hook fired
 *   4. The record holds both       - one durable conversation across a
 *                                    process lucid never owned
 *
 * Run: bun scripts/smoke-interactive.ts
 * Evidence: artifacts/evidence/interactive.md
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LUCID_RECORD_DIR } from "../src/cli/record-addressing.js";
import { sendInput } from "../src/cli/send.js";
import { openWriter } from "../src/store/conversation-host.js";
import { createConversationRecord } from "../src/store/store.js";

const CODEWORD = "pomegranate";
const lines: string[] = [];
const log = (s: string): void => {
  console.log(s);
  lines.push(s);
};

/** Project-scope hook settings, exec-form. Never a shell string with `${}`
 * in it: the record dir travels as an env var the hook verifies against
 * meta.json, so interpolating it into a command line would make a trust
 * boundary out of string concatenation. */
const settings = (repo: string): string =>
  JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: `bun ${join(repo, "src/cli/main.ts")} announce` }],
          },
        ],
        Stop: [
          { hooks: [{ type: "command", command: `bun ${join(repo, "src/cli/main.ts")} inject` }] },
        ],
      },
    },
    null,
    2,
  );

const main = async (): Promise<void> => {
  const repo = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "lucid-interactive-"));
  const conversationId = "int-1";
  const dir = join(root, conversationId);
  createConversationRecord(root, conversationId);
  let ok = true;

  log(`# interactive adapter - claude, hooks in project scope`);
  log(`record: ${dir}`);

  // A workspace the session runs in, holding only the hook settings. The
  // session is started by us but not driven by us: lucid never sends it a
  // frame, and hcn is not involved at any point in this lane.
  const work = join(root, "workspace");
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude", "settings.json"), settings(repo));

  // The input a human left before the session existed. This is the case the
  // adapter is for: something to say, and no process to say it to yet.
  const { inputId } = sendInput(conversationId, {
    rootDir: root,
    text: `Reply with only the codeword: ${CODEWORD}`,
  });
  log(`\n## queued before the session started`);
  log(`input ${inputId}`);

  log(`\n## start a claude session lucid does not own`);
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "Say READY and nothing else.",
      "--setting-sources",
      "project",
      "--permission-mode",
      "bypassPermissions",
    ],
    {
      cwd: work,
      env: {
        ...process.env,
        [LUCID_RECORD_DIR]: dir,
        LUCID_ROOT: root,
        // A-002: the child must not think it is inside Herdr, or the hook
        // environment it sees is not the one an ordinary session sees.
        HERDR_ENV: undefined as unknown as string,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  log(`claude exited ${code}; said: ${out.trim().slice(0, 120).replace(/\n/g, " ")}`);
  if (err.trim() !== "") log(`stderr: ${err.trim().slice(0, 200)}`);

  // --- what the record shows -----------------------------------------------
  const host = openWriter(dir);
  const t = host.transcript();
  const raw = readFileSync(join(dir, "log.ndjson"), "utf8");

  log(`\n## what the record shows`);
  const attached = raw.includes('"profile":"interactive"');
  log(`lucid attached at profile interactive: ${attached}`);
  if (!attached) ok = false;

  // The oracle is the session's OWN output, never the log. The input text
  // contains the codeword and the input is in the log, so looking there
  // would pass whether or not anything was ever delivered.
  //
  // The session was told to say READY and nothing else. If it says the
  // codeword instead, the only place it can have come from is the Stop
  // hook handing it an input lucid was holding - which is the whole rung-1
  // mechanism, and the only evidence lucid reached a process it does not
  // own.
  const said = out.toLowerCase();
  const injected = said.includes(CODEWORD);
  log(`the queued input reached the session: ${injected}`);
  log(`  (told to say READY; said "${out.trim().slice(0, 60).replace(/\n/g, " ")}")`);
  if (!injected) ok = false;

  log(`transcript: ${t.events.length} events, ${t.inputs.length} inputs`);

  // --- the record survives the session -------------------------------------
  const reopened = openWriter(dir);
  const foldOk = reopened.state().seq === host.state().seq;
  log(`\n## one record, folded the same twice: ${foldOk} (seq ${host.state().seq})`);
  if (!foldOk) ok = false;

  mkdirSync("artifacts/evidence", { recursive: true });
  writeFileSync(
    "artifacts/evidence/interactive.md",
    [
      "# Interactive adapter - claude, hooks in project scope",
      "",
      "Generated by `bun scripts/smoke-interactive.ts`. Rewritten whole on",
      "every run - do not hand-edit.",
      "",
      "## What this proves",
      "",
      "The mode where lucid owns nothing. A claude process starts outside",
      "lucid with lucid's hooks in project scope; lucid attaches to it at",
      "profile `interactive`, and a queued input reaches it at a turn",
      "boundary through the Stop hook.",
      "",
      "The other live lanes drive a harness lucid owns, through hcn. This one",
      "verifies the human-owned integration mode through project hooks.",
      "",
      "## Run",
      "",
      "```",
      lines.join("\n"),
      "```",
      "",
      `Verdict: ${ok ? "PASS" : "FAIL"}`,
      "",
    ].join("\n"),
  );
  rmSync(root, { recursive: true, force: true });
  log(`\n=== INTERACTIVE ${ok ? "PASS" : "FAIL"} ===`);
  process.exit(ok ? 0 : 1);
};

main().catch((cause) => {
  log(`FATAL: ${String(cause)}`);
  process.exit(1);
});
