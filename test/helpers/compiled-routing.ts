// Inert probe: print the real routing decisions, never launch their commands.
import { selfInvocation } from "../../src/cli/record-addressing.js";
import { hcnSupervisorInvocation } from "../../src/harness/node-deps.js";

console.log(
  JSON.stringify({
    argv: process.argv,
    background: selfInvocation(["_managed-worker", "synthetic-root", "conversation", "input"]),
    executable: process.execPath,
    supervisor: hcnSupervisorInvocation(["synthetic-hcn", "inspect", "claude"]),
  }),
);
