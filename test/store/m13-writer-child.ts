/**
 * M1.3 two-writer helper: one process that appends N inputs to a shared
 * conversation via the lock-wrapped append transaction. Each input has a
 * unique id so dedup does not collapse concurrent appends.
 *
 * Usage: bun test/store/m13-writer-child.ts <recordDir> <writerId> <count>
 */
import { openConversation } from "../../src/store/store.js";

const dir = process.argv[2];
const writerId = process.argv[3];
const count = Number(process.argv[4] ?? "20");

if (!dir || !writerId) {
  process.stderr.write("usage: m13-writer-child <recordDir> <writerId> <count>\n");
  process.exit(2);
}

const host = openConversation(dir, {
  now: () => Date.now(),
  presence: () => undefined,
  executorLease: () => false,
  onEffect: () => {},
  onRecord: () => {},
});

for (let i = 0; i < count; i++) {
  const id = `${writerId}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    host.enqueueInput({ id, text: `writer ${writerId} msg ${i}`, mode: "queue" });
  } catch (e) {
    process.stderr.write(`writer ${writerId} failed at ${i}: ${e}\n`);
    process.exit(1);
  }
}

process.stdout.write(`DONE ${writerId} ${count}\n`);
process.exit(0);
