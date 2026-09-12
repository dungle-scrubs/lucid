import { runCli } from "../../src/cli/dispatch.js";
import { runManagedWorker } from "../../src/cli/managed-worker.js";

// Exercise the real dispatcher and worker in separate processes. The production
// idle batching window is not part of these ownership and cleanup assertions.
await runCli(process.argv.slice(2), {
  managedWorkerFn: (root, conversationId, inputId, deps) =>
    runManagedWorker(root, conversationId, inputId, { ...deps, idleMs: 0 }),
});
