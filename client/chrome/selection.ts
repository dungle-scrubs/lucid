import type { HarnessInfo } from "../../src/protocol/wire.ts";

/**
 * The picker vocabulary rules, shared by the two places a human picks a model
 * and an effort: the create dialog (which reads the hub's whole registry) and
 * the chat area (which reads the artifact's own harness). Pure, so both
 * surfaces offer the SAME rows for the same recipe.
 *
 * "" is the default row everywhere: it sends nothing and the CLI decides.
 */

/** The vocabulary for a harness name. An empty name resolves the registry
 *  default, which is what a "default" harness pick actually runs. */
export const harnessInfoFor = (
  info: readonly HarnessInfo[],
  name: string,
  fallback: string | null,
): HarnessInfo | undefined => {
  const wanted = name || fallback || "";
  return wanted ? info.find((h) => h.name === wanted) : undefined;
};

/** The offered rows, with a value the registry no longer lists kept as a row of
 *  its own: a sticky pick made against an older registry must still SHOW, not
 *  vanish into a blank control. */
export const withCurrent = (offered: readonly string[], current: string): readonly string[] =>
  current !== "" && !offered.includes(current) ? [...offered, current] : offered;
