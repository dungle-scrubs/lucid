import { fileURLToPath } from "node:url";

/** A compiled entry is already inside execPath; passing it again shifts the command. */
export const selfInvocation = (args: readonly string[] = []): readonly [string, ...string[]] => {
  const embedded = import.meta.url.startsWith("file:///$bunfs/");
  return embedded
    ? [process.execPath, ...args]
    : [process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url)), ...args];
};

export const BACKGROUND_COMMAND = "LUCID_BACKGROUND_COMMAND";

/** Background workers must never fall through to server startup. */
export const assertServerProcess = (): void => {
  if (process.env[BACKGROUND_COMMAND] !== undefined) {
    throw new Error("A background worker cannot start a browser server");
  }
};
