// A-001 spike: does `claude -p --input-format stream-json` hold ONE process
// across MANY turns, stream token deltas, and queue (not drop) a mid-turn send?
// Throwaway evidence generator - writes raw events + a summary verdict.

type Json = Record<string, any>;

const RAW = "evidence/a001-raw.ndjson";
const user = (text: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";

const proc = Bun.spawn(
  ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
   "--verbose", "--include-partial-messages", "--model", "sonnet"],
  { stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: import.meta.dir },
);

const raw = Bun.file(RAW).writer();
const summary = {
  pid: proc.pid,
  sessionIds: [] as string[],
  results: [] as { num_turns: number; result: string }[],
  deltasPerTurn: [] as number[],
  midTurnSend: { sentAtDelta: -1, turn2DeltasAfterSend: 0, error: null as string | null },
  exitCode: null as number | null,
};

let turn = 0;            // completed turns (result events seen)
let deltas = 0;          // deltas in the current turn
let midSent = false;
const stdin = proc.stdin;

const TURNS = [
  "Reply with exactly: alpha done",
  "Count from 1 to 25, one number per line, no other text.",
  // turn 3 is the mid-turn injected message below
];

stdin.write(user(TURNS[0]));

const deadline = Date.now() + 150_000;
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buf = "";

outer: while (Date.now() < deadline) {
  const { done, value } = await Promise.race([
    reader.read(),
    new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
  ]);
  if (done || !value) break;
  buf += decoder.decode(value);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    raw.write(line + "\n");
    let ev: Json; try { ev = JSON.parse(line); } catch { continue; }

    if (ev.type === "system" && ev.subtype === "init") summary.sessionIds.push(ev.session_id);
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      deltas++;
      // Mid-turn injection: once turn 2 is visibly generating, send turn 3.
      if (turn === 1 && !midSent && deltas >= 3) {
        midSent = true;
        summary.midTurnSend.sentAtDelta = deltas;
        try { stdin.write(user("MID-TURN message: after you finish counting, reply with exactly: beta done")); }
        catch (e) { summary.midTurnSend.error = String(e); }
      }
      if (turn === 1 && midSent) summary.midTurnSend.turn2DeltasAfterSend++;
    }
    if (ev.type === "result") {
      summary.results.push({ num_turns: ev.num_turns, result: (ev.result ?? "").slice(0, 120) });
      summary.deltasPerTurn.push(deltas);
      deltas = 0; turn++;
      if (turn === 1) stdin.write(user(TURNS[1]));
      if (turn >= 3) { break outer; }              // alpha, counting, beta all answered
      if (turn === 2 && !midSent) { break outer; } // counting done but we never got to inject
    }
  }
}

try { stdin.end(); } catch {}
summary.exitCode = await proc.exited;
raw.end();
console.log(JSON.stringify(summary, null, 2));
