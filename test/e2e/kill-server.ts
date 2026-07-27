import { sessionPaths } from "../../src/core/paths.ts";
import { handshake, readServerDescriptor } from "../../src/server/discovery.ts";

/**
 * Kill the dedicated server behind a session, the way a crash would.
 *
 * The pid comes from the session's own `server.json`, but the pid alone is NOT
 * enough to fire on. `discovery.ts` says why, and it applies with more force
 * here than anywhere in the product: liveness is a handshake, never pid
 * existence, "because a reused pid is a false-positive". Where the product's
 * false-positive costs a `wait` that blocks, ours would be a SIGKILL delivered
 * to whatever unrelated process inherited that number on the developer's
 * machine - a test suite that kills someone's editor because a server died
 * earlier and the OS recycled its pid.
 *
 * So this asks the recorded port whether THIS session is answering, using the
 * product's own handshake, and only signals a pid that a live session just
 * claimed. The window between the two is a millisecond and unavoidable; the
 * window without the check is however long the descriptor has been stale.
 */
export interface KillOptions {
  /** Default SIGKILL: the point is to leave no chance to clean up, because the
   *  scenarios behind this capability are about a server vanishing without
   *  saying goodbye. */
  readonly signal?: NodeJS.Signals;
  /** Injected for tests, which need to observe the refusal without a process
   *  actually dying. */
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
}

export const killSessionServer = async (
  artifactPath: string,
  options: KillOptions = {},
): Promise<number> => {
  const paths = sessionPaths(artifactPath);
  const descriptor = await readServerDescriptor(paths);
  if (!descriptor) {
    throw new Error(`no server.json for ${artifactPath} - there is nothing to kill`);
  }
  const live = await handshake(descriptor.port, paths.artifactPath, descriptor.base ?? "");
  if (!live) {
    throw new Error(
      `refusing to kill pid ${descriptor.pid}: the session at ${artifactPath} did not answer on ` +
        `port ${descriptor.port}, so server.json is stale and that pid may now belong to ` +
        `anything. Whatever this test wanted to kill is already gone.`,
    );
  }
  const signal = options.signal ?? "SIGKILL";
  (options.kill ?? process.kill.bind(process))(descriptor.pid, signal);
  return descriptor.pid;
};
