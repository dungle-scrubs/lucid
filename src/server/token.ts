import { randomBytes } from "node:crypto";

/** Mint a session token — held in memory, never written to disk. */
export const mintToken = (): string => randomBytes(32).toString("hex");
