/** Escape a string for safe interpolation into HTML text content. */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Characters a POSIX shell leaves alone; anything else has to be quoted. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a value for a command line Lucid PRINTS - a copy-paste hint, or the
 * `lucid open <file>` line inside a prompt an agent will run. Lucid never
 * shells out itself (every spawn is argv), so this is about the OTHER parser:
 * a project path with a space or a metacharacter must reach that shell as one
 * argument. Single quotes, with the standard `'\''` break for embedded ones.
 */
export const shellArg = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
