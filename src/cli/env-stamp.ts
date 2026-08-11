/**
 * Env-stamp + self-invocation (port from v1 `src/launch/env-stamp.ts`,
 * `src/cli/self.ts`). The stamp is a HINT, not a trust boundary
 * (D-010): `announce`/`inject` MUST verify the resolved record against
 * `meta.json` before writing.
 *
 * For lucid-v2 the stamp is minimal: the record directory and the turn
 * id that the hook's claude session believes it is in. The hook commands
 * use exec-form argument arrays, never interpolated shell strings, so the
 * stamp cannot be used to inject shell metacharacters.
 */

export const LUCID_RECORD_DIR = "LUCID_RECORD_DIR";
export const LUCID_TURN_ID = "LUCID_TURN_ID";

/** Build the env object for a child spawn that should carry the stamp. */
export const envStamp = (recordDir: string, turnId?: string): NodeJS.ProcessEnv => ({
  [LUCID_RECORD_DIR]: recordDir,
  ...(turnId ? { [LUCID_TURN_ID]: turnId } : {}),
});

/** Read the stamp from the current env. Returns undefined when not set
 * (a fresh `lucid run` without a parent stamp, or a normal shell). */
export const readStamp = (): { recordDir: string; turnId?: string } | undefined => {
  const dir = process.env[LUCID_RECORD_DIR];
  if (!dir || dir.length === 0) return undefined;
  const turnId = process.env[LUCID_TURN_ID];
  return { recordDir: dir, ...(turnId ? { turnId } : {}) };
};

/** Resolve a record directory from the stamp or an explicit argument.
 * The stamp is the primary source for hooks; `explicitDir` wins when the
 * CLI is invoked directly (`lucid send <conversation> ...`). */
export const resolveRecordDir = (explicitDir?: string): string | undefined => {
  if (explicitDir) return explicitDir;
  const stamp = readStamp();
  return stamp?.recordDir;
};

/**
 * Reconstruct how to re-invoke this CLI as a child process, in exec-form.
 * Uses `process.execPath` + `process.argv[1]` when running via `bun run
 * src/cli/main.ts` (where argv[1] is the entry script), otherwise just
 * the exec path. Returns an argv array suitable for `spawn`/`execFile`,
 * never a shell string.
 */
export const selfInvocation = (extraArgs: readonly string[] = []): readonly string[] => {
  const execPath = process.execPath;
  const arg1 = process.argv[1];
  if (arg1 && (arg1.endsWith(".ts") || arg1.endsWith(".js"))) {
    return [execPath, arg1, ...extraArgs];
  }
  return [execPath, ...extraArgs];
};
