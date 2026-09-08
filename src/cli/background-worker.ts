import { spawn } from "node:child_process";
import { BACKGROUND_COMMAND, selfInvocation } from "./invocation.js";
import { LUCID_RECORD_DIR, LUCID_TURN_ID } from "./record-addressing.js";

export function workerEnvironment(base: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LUCID_ROOT: root };
  delete env[LUCID_RECORD_DIR];
  delete env[LUCID_TURN_ID];
  delete env.LUCID_HARNESS;
  return env;
}

/** Durable records own the work; a failed launch is retried by reconciliation. */
export function requestBackgroundWorker(args: readonly string[], root: string): void {
  const command = args[0];
  if (command !== "_managed-worker" && command !== "_name-titles") {
    throw new Error("A background launch requires an internal worker command");
  }
  // A wrongly routed child must not recursively launch more workers. Naming
  // coordinators may hand off a final wake only after releasing their lock.
  const parent = process.env[BACKGROUND_COMMAND];
  if (parent !== undefined && (parent !== "_name-titles" || command !== "_name-titles")) {
    throw new Error("A background worker cannot launch another background worker");
  }
  const [binary, ...argv] = selfInvocation(args);
  if (!binary) return;
  try {
    const child = spawn(binary, argv, {
      detached: true,
      stdio: "ignore",
      env: { ...workerEnvironment(process.env, root), [BACKGROUND_COMMAND]: command },
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
