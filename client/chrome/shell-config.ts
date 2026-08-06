import type { ShellConfig } from "./types.ts";

/**
 * The shell page's payload, read through its declared shape (M4.4): `daemon.ts`
 * writes `window.__LUCID_SHELL__` and this reads it, so one type keeps the two
 * spellings from drifting past typecheck. Owned here - a leaf with no imports
 * of its own beyond the type - so `tabs.ts`, `stream.ts`, and `hub.ts` all read
 * the SAME source instead of each threading the knobs they need through
 * per-call signatures.
 */
export const shellConfig = (): ShellConfig | undefined =>
  (globalThis as { __LUCID_SHELL__?: ShellConfig }).__LUCID_SHELL__;
