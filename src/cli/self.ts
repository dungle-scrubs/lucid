/**
 * Self-invocation helper (thin re-export of env-stamp's exec-form builder).
 *
 * Kept as a separate module so `src/cli/hooks` and `src/cli/run` can
 * import `selfInvocation` without pulling the whole env-stamp surface,
 * and so the module comment can name what this file is NOT: it is not a
 * shell-string interpolator. Hook commands and self-invocation both use
 * exec-form argument arrays, never `${var}` inside a shell command.
 */

export { selfInvocation } from "./env-stamp.js";
