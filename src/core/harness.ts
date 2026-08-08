/**
 * Which harness is this, whatever the caller spelled?
 *
 * Two questions with one owner: how a harness name is NORMALIZED, and which
 * FAMILY the normalized name belongs to. Both were re-spelled wherever they
 * were first needed - the launch selection adapter re-wrote the normalizer
 * minus its `.trim()`, `presence.ts` open-coded it at six call sites and the
 * claude-family test at five - and a rule copied that many times is one edit
 * away from disagreeing with itself. It already did: a registry key with a
 * stray space canonicalized for identity and failed flag lookup, which
 * surfaced as Lucid claiming it knew no flags for a harness it ships.
 *
 * Pure, and importing nothing: core, launch and server all ask this, so it
 * cannot sit downstream of any of them.
 */

/**
 * One harness, one identity, however it is spelled. A registry key of
 * `claude_code` and an artifact stamped `claude-code` are the same harness -
 * and treating them as different meant a recorded session could never be
 * resumed on a machine whose registry used the other separator.
 */
export const normalizeHarness = (name: string): string =>
  name.trim().toLowerCase().replace(/_/g, "-");

/** The harness families Lucid carries built-in knowledge of. */
export type HarnessKind = "claude" | "codex" | "pi" | "muse";

/**
 * The family a harness name names, or undefined when Lucid knows none.
 *
 * Closed on purpose: every caller asking is about to apply knowledge Lucid
 * only has for these three - the CLI's flag spellings, where it files its
 * transcripts, how its resume command is written - so an unknown harness has
 * to fall through to "Lucid does not know" rather than to a guess.
 *
 * `claude-code` and `claude` are ONE family, not two: the first is what the
 * registry calls the harness, the second what its CLI calls itself, and both
 * arrive here from artifact stamps and recorded resume commands.
 */
export const harnessKind = (name: string): HarnessKind | undefined => {
  const n = normalizeHarness(name);
  if (n === "claude-code" || n === "claude") return "claude";
  if (n === "muse-code" || n === "muse") return "muse";
  return n === "codex" || n === "pi" ? n : undefined;
};
