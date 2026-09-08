/**
 * The driver line's menus (7a-7d, RFC-12), as derivations.
 *
 * The rules under test are the ones a browser cannot be trusted to show:
 * which dimensions are offered in which mode, what the selected row is,
 * and what a pick POSTs. All inputs here are values - no DOM, no fetch.
 */
import { describe, expect, test } from "bun:test";
import {
  chooseEffort,
  chooseHarness,
  chooseModel,
  type DriverChoices,
  type DriverPreference,
  type DriverVocabulary,
  driverLineState,
  EFFORT_DEFAULT,
  effortGloss,
} from "../../src/server/client/driver-menus.js";

/** A ladder as the pinned hcn reports one for pi. A vocabulary value, not a
 * recording: `test/fixtures/hcn` holds event streams, and this is a fact. */
const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const vocab = (over: Partial<DriverVocabulary> = {}): DriverVocabulary => ({
  models: ["model-a", "model-b"],
  efforts: [...LADDER],
  extensible: false,
  ...over,
});

const CHOICES: DriverChoices = {
  harnesses: ["claude", "codex", "pi", "muse"],
  vocabulary: { claude: vocab(), codex: vocab(), pi: vocab({ extensible: true }), muse: vocab() },
};

const pref = (over: Partial<DriverPreference> = {}): DriverPreference => ({
  v: 1,
  harness: "claude",
  ...over,
});

describe("the effort glosses", () => {
  test("three glosses, placed by the ladder's order", () => {
    expect(effortGloss("minimal", LADDER)).toBe("answers fast, thinks little");
    expect(effortGloss("low", LADDER)).toBe("answers fast, thinks little");
    expect(effortGloss("medium", LADDER)).toBe("the default");
    expect(effortGloss("high", LADDER)).toBe("longer turns, fewer of them");
    expect(effortGloss("max", LADDER)).toBe("longer turns, fewer of them");
  });

  test("a level off the ladder, or a ladder with no default, gets none", () => {
    expect(effortGloss("sideways", LADDER)).toBe("");
    expect(effortGloss("low", ["low", "high"])).toBe("");
  });

  test("muse's own name for the bottom of the ladder still glosses as fast", () => {
    expect(effortGloss("none", ["none", "minimal", "low", "medium", "high", "xhigh"])).toBe(
      "answers fast, thinks little",
    );
  });
});

describe("which menus exist", () => {
  test("headless-turn offers all three", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "codex",
      driverModel: "gpt-5.6-sol",
      preference: null,
      choices: CHOICES,
    });
    expect([...s.menus]).toEqual(["harness", "model", "effort"]);
    expect(s.effort).toBe(EFFORT_DEFAULT);
  });

  test("headless-session offers all three: hcn session carries --effort since 0.6.0", () => {
    const s = driverLineState({
      profile: "headless-session",
      driverHarness: "claude",
      driverModel: "claude-opus-5",
      preference: null,
      choices: CHOICES,
    });
    expect([...s.menus]).toEqual(["harness", "model", "effort"]);
    expect(s.effort).toBe(EFFORT_DEFAULT);
  });

  test("interactive offers none: the human's session chose the driver", () => {
    const s = driverLineState({
      profile: "interactive",
      driverHarness: undefined,
      driverModel: "whatever-the-human-ran",
      preference: null,
      choices: CHOICES,
    });
    expect(s.menus.size).toBe(0);
  });

  test("interactive names what runs, not what a preference says", () => {
    // A preference written while a session runs interactively is stored and
    // honored by a later headless driver; the interactive line itself keeps
    // reporting the human's session (7c), so the labels never claim a
    // driver the session never chose.
    const s = driverLineState({
      profile: "interactive",
      driverHarness: "claude",
      driverModel: "claude-opus-5",
      preference: pref({ harness: "muse", model: "muse-spark-1.2" }),
      choices: CHOICES,
    });
    expect(s.harness).toBe("claude");
    expect(s.model).toBe("claude-opus-5");
    expect(s.menus.size).toBe(0);
  });

  test("nothing driving still offers the menus: choosing now is the natural moment", () => {
    const s = driverLineState({
      profile: undefined,
      driverHarness: undefined,
      driverModel: undefined,
      preference: null,
      choices: CHOICES,
    });
    // No harness to compose against, so model and effort wait for one.
    expect([...s.menus]).toEqual(["harness"]);
  });

  test("no served lists means no menus, whatever the mode", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "codex",
      driverModel: "gpt-5.6-sol",
      preference: null,
      choices: null,
    });
    expect(s.menus.size).toBe(0);
    // The labels stay: the line is a report first, a control second.
    expect(s.harness).toBe("codex");
    expect(s.model).toBe("gpt-5.6-sol");
  });

  test("a harness with no models and no open entry offers no model menu", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "muse",
      driverModel: undefined,
      preference: null,
      choices: {
        harnesses: CHOICES.harnesses,
        vocabulary: { muse: vocab({ models: [], extensible: false }) },
      },
    });
    expect(s.menus.has("model")).toBe(false);
    expect(s.menus.has("effort")).toBe(true);
  });

  test("an extensible harness offers the model menu even with an empty list", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "pi",
      driverModel: undefined,
      preference: null,
      choices: {
        harnesses: CHOICES.harnesses,
        vocabulary: { pi: vocab({ models: [], extensible: true }) },
      },
    });
    expect(s.menus.has("model")).toBe(true);
  });
});

describe("what the segments say", () => {
  test("the preference names the harness and the model; effort falls to the default", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "codex",
      driverModel: "gpt-5.6-sol",
      preference: pref({ harness: "pi", model: "qwen3.6-35b-a3b-mlx" }),
      choices: CHOICES,
    });
    expect(s.harness).toBe("pi");
    expect(s.model).toBe("qwen3.6-35b-a3b-mlx");
    expect(s.effort).toBe("medium");
  });

  test("the driver in force's model does not leak across a harness change", () => {
    // claude's model is a value in claude's vocabulary; once the preference
    // names muse, offering it as muse's selected row would be a lie.
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "claude",
      driverModel: "claude-opus-5",
      preference: pref({ harness: "muse" }),
      choices: CHOICES,
    });
    expect(s.harness).toBe("muse");
    expect(s.model).toBeNull();
  });

  test("while the harness stands, the model in force names the segment", () => {
    const s = driverLineState({
      profile: "headless-turn",
      driverHarness: "claude",
      driverModel: "claude-opus-5",
      preference: null,
      choices: CHOICES,
    });
    expect(s.model).toBe("claude-opus-5");
  });
});

describe("what a pick POSTs", () => {
  const line = (over: Partial<DriverPreference> = {}) =>
    driverLineState({
      profile: "headless-turn",
      driverHarness: "pi",
      driverModel: "zai/glm-5.2",
      preference: pref({ harness: "pi", ...over }),
      choices: CHOICES,
    });

  test("a harness change sends the spine alone - the old dimensions clear", () => {
    const s = line({ model: "zai/glm-5.2", effort: "high", provider: "lmstudio" });
    expect(chooseHarness("codex", s)).toEqual({ v: 1, harness: "codex" });
  });

  test("re-choosing the effective harness is no POST at all", () => {
    const s = line();
    expect(chooseHarness("pi", s)).toBeNull();
  });

  test("a model change keeps the effort and the provider", () => {
    const s = line({ effort: "high", provider: "lmstudio" });
    expect(
      chooseModel(
        "qwen3.6-35b-a3b-mlx",
        s,
        pref({ harness: "pi", effort: "high", provider: "lmstudio" }),
      ),
    ).toEqual({
      v: 1,
      profile: "headless-turn",
      expectedRevision: 0,
      harness: "pi",
      model: "qwen3.6-35b-a3b-mlx",
      effort: "high",
      provider: "lmstudio",
    });
  });

  test("an effort change keeps the model and clears back to the default by name", () => {
    const s = line({ model: "zai/glm-5.2" });
    expect(chooseEffort("high", s, pref({ harness: "pi", model: "zai/glm-5.2" }))).toEqual({
      v: 1,
      profile: "headless-turn",
      expectedRevision: 0,
      harness: "pi",
      model: "zai/glm-5.2",
      effort: "high",
    });
  });

  test("picking medium saves the explicit effort and retains the model", () => {
    // A later user default must not change this saved selection.
    const s = line({ effort: "high" });
    expect(chooseEffort("medium", s, pref({ harness: "pi", effort: "high" }))).toEqual({
      v: 1,
      profile: "headless-turn",
      expectedRevision: 0,
      harness: "pi",
      model: "zai/glm-5.2",
      effort: "medium",
    });
  });

  test("picking what already runs is no POST at all", () => {
    const s = line({ effort: "high" });
    expect(chooseEffort("high", s, pref({ harness: "pi", effort: "high" }))).toBeNull();
    const settled = driverLineState({
      profile: "headless-turn",
      driverHarness: "pi",
      driverModel: "zai/glm-5.2",
      preference: null,
      choices: CHOICES,
    });
    expect(chooseModel("zai/glm-5.2", settled, null)).toBeNull();
  });
});
