/**
 * `lucid2 serve` — start the loopback browser surface.
 *
 * One command, every record, a record chosen by URL. The server itself is
 * `src/server/server.ts`, which owns the binding, the token, and the rule
 * that it never drives. This module is the command: it starts one, says
 * where it is, and holds the process open until the terminal is done with
 * it.
 *
 * The token is not printed. The page fetches it from the server over the
 * same origin, so a person never has to handle it, and it stays out of
 * scrollback and shell history.
 */

import { startServer } from "../server/server.js";

export interface ServeOpts {
  readonly rootDir?: string;
  /** `0` asks the kernel for a free port. Tests use it; a person does not. */
  readonly port?: number;
  readonly token?: string;
  readonly log?: (line: string) => void;
}

/** Start the server and return it running. The caller decides how long it
 * lives — which is what makes this usable both from the command below and
 * from a test that starts one, drives it, and closes it. */
export const startServe = async (opts: ServeOpts = {}) =>
  startServer({ rootDir: opts.rootDir, port: opts.port, token: opts.token });

/** The command. Starts a server and blocks until the process is asked to
 * stop, then closes it so the port is free for the next start. */
export const serveConversation = async (opts: ServeOpts = {}): Promise<void> => {
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const running = await startServe(opts);
  log(`lucid browser on ${running.url}`);
  log(`open a conversation: ${running.url}/c/demo`);

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await running.close();
};
