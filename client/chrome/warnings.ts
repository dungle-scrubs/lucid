/**
 * The viewer's own words for a warning the server names by CODE.
 *
 * The server used to build the whole English sentence and ship it as prose,
 * which put two things in the wrong place at once: the harness's own matched
 * line rode along into a retained log (07#13), and Lucid's voice was decided
 * in a launch module nobody would look in for it.
 *
 * The wording lives HERE rather than being imported from the server, so the
 * browser bundle does not pull in a launch module to read one table - and so
 * that "the viewer owns the wording" is true of the code layout, not just of
 * the data flow. The server's half is the closed `UsageLimitKind` union; the
 * two meet at the string on the wire.
 *
 * A code carries no content by construction, which is what makes the D-005 fix
 * hold rather than merely bound: there is no harness string to leak, only a
 * member of a closed set.
 */
const USAGE_LIMIT_WORDING: Readonly<Record<string, string>> = {
  "usage-limit": "over its usage limit",
  "session-limit": "over its session limit",
  "weekly-limit": "over its weekly usage limit",
  credits: "out of credits",
  quota: "over its provider quota",
};

export const warningText = (code: string, payload: string): string => {
  if (code === "HARNESS_USAGE_LIMIT") {
    const wording = USAGE_LIMIT_WORDING[payload];
    return wording
      ? `Delivery is paused: the attending harness is ${wording}.`
      : // An unknown kind from a newer hub. Say the true, useful thing rather
        // than echoing a code at the human or guessing which wall it hit.
        "Delivery is paused: the attending harness has hit a limit.";
  }
  // Every other warning still arrives as prose the server composed.
  return payload;
};
