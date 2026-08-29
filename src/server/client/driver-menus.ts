/**
 * The driver line's menus (RFC-12, design 7a-7d), as derivations - no DOM,
 * no fetch, so the rules are testable without a browser.
 *
 * Three menus: harness, model, effort. Mode is not among them - it is not
 * settable from the browser, and the design's mode gloss stays a tooltip.
 * The rules this module owns:
 *
 * - **Absent, not disabled.** A dimension that cannot act - effort on a
 *   session-mode driver (the pinned hcn's `session` carries no `--effort`),
 *   a model list the harness does not carry - is removed, never greyed.
 * - **The preference is the choice; the driver in force is the fact.** The
 *   line renders what runs where the record names it and what the person
 *   chose where only a choice exists (effort has no other source), and the
 *   menus' selected rows are always the preference's values.
 * - **The whole bundle goes on every POST.** The endpoint replaces the file,
 *   so a harness change sends the new spine and clears the dimensions that
 *   were values in the old harness's vocabulary.
 */

/** The wire shape of one harness's entry in `driverChoices`. `provider` is
 * present only where the harness expresses the dimension. */
export interface DriverVocabulary {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly extensible: boolean;
  readonly provider?: true;
}

/** The wire shape of `driverChoices`, as the poll delivers it. */
export interface DriverChoices {
  readonly harnesses: readonly string[];
  readonly vocabulary: Readonly<Record<string, DriverVocabulary | undefined>>;
}

/** The wire shape of `driverPreference`: what the person chose. */
export interface DriverPreference {
  readonly v: 1;
  readonly harness: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** What a POST body may carry - the five fields the endpoint accepts. */
export interface DriverChoiceBody {
  readonly v: 1;
  readonly harness: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** The three switchable dimensions. Mode is deliberately not a MenuKey. */
export type MenuKey = "harness" | "model" | "effort";

/** The effort glosses, verbatim from the design (7a). Three glosses for the
 * whole ladder: what answers faster than the default, the default itself,
 * and what trades turn count for turn length. */
export const EFFORT_GLOSS = {
  below: "answers fast, thinks little",
  default: "the default",
  above: "longer turns, fewer of them",
} as const;

/** The hcn profile's own effort (the skill's Defaults section): what runs
 * when no preference names an effort. The gloss on this level says so. */
export const EFFORT_DEFAULT = "medium";

/** One gloss for one level, placed by the ladder's own order rather than by
 * any one harness's names - "off", "none" and "low" are all below medium on
 * their ladders. Empty when the level is not on the ladder, because a gloss
 * about a trade needs to know which side of the default the level sits. */
export const effortGloss = (level: string, ladder: readonly string[]): string => {
  const at = ladder.indexOf(level);
  const medium = ladder.indexOf(EFFORT_DEFAULT);
  if (at === -1 || medium === -1) return "";
  if (at === medium) return EFFORT_GLOSS.default;
  return at < medium ? EFFORT_GLOSS.below : EFFORT_GLOSS.above;
};

/** What the line renders and which menus exist, from the driver in force,
 * the preference, and the served lists. */
export interface DriverLineState {
  /** The harness the menus compose against: the preference's where one
   * exists (it is honored at the next turn boundary), else the one in
   * force. Null names nothing and no model or effort menu can exist. */
  readonly harness: string | null;
  /** The model the line names. The preference's where set; else the one in
   * force's, but only while the harness has not changed under it - a model
   * is a value in its harness's vocabulary and must not leak across the
   * change. */
  readonly model: string | null;
  /** The effort the line names. Only a preference can move it off the
   * profile default, so the default is what renders until one does. */
  readonly effort: string | null;
  /** Which menus exist. Interactive offers none: the human's session chose
   * the driver and lucid cannot change it mid-run. */
  readonly menus: ReadonlySet<MenuKey>;
  /** The harness whose vocabulary the model and effort lists come from -
   * always the effective harness, or null when there is none. */
  readonly vocabulary: DriverVocabulary | null;
}

/** One line's state. Pure: same inputs, same segments, same menus. */
export const driverLineState = (args: {
  /** The driver in force, as the poll reports it. */
  readonly profile: string | undefined;
  readonly driverHarness: string | undefined;
  readonly driverModel: string | undefined;
  readonly preference: DriverPreference | null;
  readonly choices: DriverChoices | null;
}): DriverLineState => {
  const { profile, driverHarness, driverModel, preference, choices } = args;
  const interactive = profile === "interactive";
  // In interactive the labels are a report of the human's session (7c): the
  // preference may exist - written earlier, honored by a future headless
  // driver - but this line names what is running, and no menu is offered.
  const reported = interactive
    ? { harness: driverHarness ?? null, model: driverModel ?? null }
    : null;
  const harness = reported?.harness ?? preference?.harness ?? driverHarness ?? null;
  // A model chosen by the record belongs to the harness it was running
  // under; once the preference names a different harness, carrying it over
  // would offer claude's model as muse's selected row.
  const model =
    reported?.model ??
    preference?.model ??
    (driverHarness === undefined || preference === null || preference.harness === driverHarness
      ? driverModel
      : undefined) ??
    null;
  const effort = preference?.effort ?? EFFORT_DEFAULT;
  const vocabulary = harness === null ? null : (choices?.vocabulary[harness] ?? null);
  const menus = new Set<MenuKey>();
  if (!interactive && choices !== null) {
    // The harness list exists wherever the lists were served at all.
    menus.add("harness");
    // A model menu needs a vocabulary to render from - the listed models,
    // or none but an open one (extensible), which still offers a choice.
    if (
      harness !== null &&
      vocabulary !== null &&
      (vocabulary.models.length > 0 || vocabulary.extensible)
    ) {
      menus.add("model");
    }
    // Effort cannot act on a session-mode driver: the pinned hcn's
    // `session` carries no --effort, so the level would be written and
    // never honored. Absent, not disabled (RFC-12, the honor rule's gap).
    if (
      harness !== null &&
      profile !== "headless-session" &&
      vocabulary !== null &&
      vocabulary.efforts.length > 0
    ) {
      menus.add("effort");
    }
  }
  return { harness, model, effort: menus.has("effort") ? effort : null, menus, vocabulary };
};

/** The bundle for choosing a harness: the new spine alone. Model, effort
 * and provider were values in the old harness's vocabulary - cleared, back
 * to the hcn defaults, per the RFC's not-a-patch rule. Null when the pick
 * is the harness already composed against: re-choosing it must not clear
 * the dimensions that travel with it. */
export const chooseHarness = (
  next: string,
  current: { readonly harness: string | null },
): DriverChoiceBody | null => (next === current.harness ? null : { v: 1, harness: next });

/** The bundle for choosing a model: the dimension changes, the rest of the
 * preference stands. Null when the model is already the effective one. */
export const chooseModel = (
  next: string,
  current: { readonly harness: string | null; readonly model: string | null },
  keep: DriverPreference | null,
): DriverChoiceBody | null => {
  if (current.harness === null || next === current.model) return null;
  return {
    v: 1,
    harness: current.harness,
    model: next,
    ...(keep?.effort === undefined ? {} : { effort: keep.effort }),
    ...(keep?.provider === undefined ? {} : { provider: keep.provider }),
  };
};

/** The bundle for choosing an effort: the model stands, and picking the
 * default level writes an absent field rather than the name - absent IS the
 * default, and the file should not carry a choice that says nothing. Null
 * when nothing would change. */
export const chooseEffort = (
  next: string,
  current: { readonly harness: string | null; readonly model: string | null },
  keep: DriverPreference | null,
): DriverChoiceBody | null => {
  if (current.harness === null) return null;
  const already = keep?.effort ?? EFFORT_DEFAULT;
  if (next === already) return null;
  return {
    v: 1,
    harness: current.harness,
    ...(current.model === null ? {} : { model: current.model }),
    ...(next === EFFORT_DEFAULT ? {} : { effort: next }),
    ...(keep?.provider === undefined ? {} : { provider: keep.provider }),
  };
};
