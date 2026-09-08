/**
 * Which version you are looking at, and whether that makes it read-only.
 *
 * Not the same question, which is the whole reason this is a module. The
 * page had one boolean for it:
 *
 *     const viewingOld = doc.version !== catalog.latest;
 *
 * That is true in two situations, and they need opposite treatment.
 *
 * **Pinned old.** A version was chosen from the picker. You went back
 * deliberately, and read-only is right: RFC-07 R6 and R7 say only the
 * current version can be edited or written about.
 *
 * **Overtaken.** Nothing was chosen. You were following the newest, you had
 * work in progress, the agent wrote a version, and the page held the
 * document where it was rather than replacing the frame under you. You did
 * not go back in time; the present moved.
 *
 * Treating the second as read-only disabled the save on an edit that was
 * still live. That mattered more than it looks, because the server has a
 * whole path for this - a save carries `basedOn`, the server appends it at
 * the end regardless of what arrived meanwhile, and answers with
 * `supersededSince` so the page can say what happened. The path was built,
 * tested, and unreachable, because the button that reached it was disabled
 * by a flag that had confused two states.
 */

/** Where the shown version sits relative to the newest one. */
export type VersionState =
  /** Showing the newest version. Everything is available. */
  | "current"
  /** An older version was chosen on purpose. Read-only. */
  | "pinned-old"
  /** The newest moved on while this one was held. Not read-only. */
  | "overtaken";

export interface VersionFacts {
  /** The version on screen, or null when no document is shown. */
  readonly shown: number | null;
  /** The newest version the record holds, or null when it is not known. */
  readonly latest: number | null;
  /** The version pinned by the picker, or null when following the newest. */
  readonly pinned: number | null;
}

/**
 * Read the three facts into one state.
 *
 * `pinned` is what separates the two not-newest cases, and it is enough on
 * its own: nothing sets it except choosing a version, and the page clears it
 * to follow again. Work-in-progress is not consulted here - it is why the
 * document was held, not what the person is now looking at, and mixing the
 * two is how one flag came to mean two things in the first place.
 */
export const versionState = (facts: VersionFacts): VersionState => {
  const { shown, latest, pinned } = facts;
  // Nothing to compare against reads as current: a document with no catalog
  // yet is not an old version, and must not be locked as one.
  if (shown === null || latest === null) return "current";
  if (shown === latest) return "current";
  return pinned === null ? "overtaken" : "pinned-old";
};

/** Whether this state forbids editing and annotating.
 *
 * The one question every disabled control should ask. Named separately from
 * the state so a caller cannot accidentally spell it `state !== "current"`,
 * which is the original bug written a second way. */
export const isReadOnly = (state: VersionState): boolean => state === "pinned-old";
