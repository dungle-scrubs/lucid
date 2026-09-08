import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "node:process";
import { runCli } from "../../src/cli/dispatch.js";
import { requestManagedWorker } from "../../src/cli/managed-worker.js";

// A shared, non-renewable budget protects the machine even if routing regresses.
// Every compiled descendant must claim a slot before it can launch anything.
const budget = env.LUCID_TEST_PROCESS_BUDGET;
if (!budget) throw new Error("The compiled worker fixture requires a process budget");
let claimed = false;
for (let slot = 0; slot < 16; slot++) {
  try {
    const fd = openSync(join(budget, String(slot)), "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    claimed = true;
    break;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
}
if (!claimed) throw new Error("Compiled worker process budget exhausted");

const [command, root, conversationId, inputId] = process.argv.slice(2);
if (command === "launch-worker" && root && conversationId && inputId) {
  requestManagedWorker(root, conversationId, inputId);
} else if (command === "_managed-worker" || command === "_hcn-supervise") {
  await runCli(process.argv.slice(2));
} else {
  throw new Error("Unexpected compiled worker command");
}
