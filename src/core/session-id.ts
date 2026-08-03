/**
 * The shape a harness session id must have before Lucid will believe it.
 *
 * In core, and importing nothing, for the same reason `harness.ts` is: both
 * layers ask. The launch decoder applies it to ids read off a harness's
 * stdout; `core/presence.ts` applies it to ids that arrive from a log event or
 * a sidecar before using one as a path segment. Owning it in `launch/` meant
 * core reached DOWN into launch for a rule that is not launch's - the one
 * `core -> launch` import in the tree, and the start of a cycle the moment
 * anything under launch imports `presence.ts` (`fork-launcher.ts` already
 * does).
 */

/** A native session id longer than this is not an id Lucid will ever place
 *  into a resume argv. Matches the sidecar/stamp bound (`sanitizeAttendant`
 *  cleans `sessionId` to 128) so the decoder cannot admit an id the record
 *  layer would truncate into a DIFFERENT id. */
export const SESSION_ID_MAX = 128;

/**
 * A discovered id comes from the harness's own stdout, which is the least
 * trusted input in the whole flow: it is read from a subprocess, believed,
 * stored, and later substituted into `resume` argv. Bounding length and
 * stripping control characters is not enough - an id of `--dangerously-skip-
 * permissions` is printable, short, and would be handed to the CLI as a FLAG.
 * So an id is an opaque token: letters, digits, and the few separators real
 * harnesses use, never leading with a dash.
 */
const SESSION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

/** True when this id may be believed and, later, placed into resume argv. */
export const isUsableSessionId = (value: string): boolean =>
  value.length > 0 && value.length <= SESSION_ID_MAX && SESSION_ID_SHAPE.test(value);
