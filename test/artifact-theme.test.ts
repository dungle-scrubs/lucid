import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { createArtifactTheme } from "../client/overlay/artifact-theme.ts";
import { THEME_PALETTE, THEME_TOKENS } from "../src/core/palette.ts";

/**
 * The theme layer rewrites another party's stylesheets through the CSSOM, and
 * every bug it has had came from asking the wrong source: Lucid's own injected
 * sheet instead of the artifact's, or a media condition Lucid had already
 * rewritten instead of the one the author wrote. Both are cheap to pin once the
 * document is a parameter.
 *
 * linkedom parses the document; the CSSOM is a stand-in, because linkedom has
 * none. `createArtifactTheme` reads its constructors off the document's own
 * realm precisely so a stand-in can answer for them.
 */

class FakeMediaRule {
  conditionText: string;
  readonly cssRules: unknown[];
  readonly media: { mediaText: string };

  constructor(condition: string, rules: unknown[] = []) {
    this.conditionText = condition;
    this.cssRules = rules;
    this.media = {} as { mediaText: string };
    // A real `media.mediaText` write is what changes `conditionText`, which is
    // exactly why the original condition has to be kept aside.
    Object.defineProperty(this.media, "mediaText", {
      get: () => this.conditionText,
      set: (value: string) => {
        this.conditionText = value;
      },
    });
  }
}

class FakeStyleRule {
  constructor(readonly selectorText: string) {}
}

class FakeImportRule {}

class FakeStyleSheet {
  cssText = "";
  replaceSync(text: string): void {
    this.cssText = text;
  }
}

interface FakeSheet {
  readonly cssRules: unknown[];
  readonly ownerNode: null;
}

const sheetOf = (...rules: unknown[]): FakeSheet => ({ cssRules: rules, ownerNode: null });

/**
 * A document whose cascade declares `declares` and nothing else, plus whatever
 * rules the test hands in. The stand-in `getComputedStyle` applies Lucid's own
 * tokens only while `data-lucid-theme` is set, the way its attribute-scoped
 * sheet does - so a probe that forgets to take the attribute off sees them.
 */
const harness = (declares: readonly string[] = [], sheets: readonly FakeSheet[] = []) => {
  const { document, window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  const declared = new Set<string>(declares);
  /** The attribute in force each time the cascade was asked. */
  const probedWith: (string | null)[] = [];
  let adopted: FakeStyleSheet[] = [];
  Object.assign(window, {
    CSSImportRule: FakeImportRule,
    CSSMediaRule: FakeMediaRule,
    CSSStyleRule: FakeStyleRule,
    CSSStyleSheet: FakeStyleSheet,
    getComputedStyle: (element: Element) => {
      const themed = element.getAttribute("data-lucid-theme");
      probedWith.push(themed);
      return {
        getPropertyValue: (name: string): string => {
          if (declared.has(name)) return "#123456";
          if (themed !== null && (THEME_TOKENS as readonly string[]).includes(name))
            return "#abcdef";
          return "";
        },
      };
    },
  });
  Object.defineProperty(document, "styleSheets", { value: sheets, configurable: true });
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => adopted,
    set: (value: FakeStyleSheet[]) => {
      adopted = value;
    },
  });
  return {
    adopted: (): readonly FakeStyleSheet[] => adopted,
    document: document as unknown as Document,
    probedWith,
    theme: () => document.documentElement.getAttribute("data-lucid-theme"),
  };
};

describe("the injected sheet is generated from the palette", () => {
  test("both blocks carry every token at its palette value", () => {
    const h = harness(["--paper"]);
    createArtifactTheme(h.document).apply("dark");
    const css = h.adopted()[0]?.cssText ?? "";
    for (const theme of ["light", "dark"] as const) {
      expect(css).toContain(`:root[data-lucid-theme="${theme}"]`);
      expect(css).toContain(`color-scheme: ${theme};`);
      for (const token of THEME_TOKENS) {
        expect(css).toContain(`${token}: ${THEME_PALETTE[theme][token]};`);
      }
    }
  });

  test("it is adopted once, however many times the reader toggles", () => {
    const h = harness(["--paper"]);
    const theme = createArtifactTheme(h.document);
    theme.apply("dark");
    theme.apply("light");
    theme.reapply();
    expect(h.adopted()).toHaveLength(1);
  });
});

describe("can this artifact be rendered dark at all", () => {
  test("any one of the six tokens qualifies it, not just --paper and --ink", () => {
    // The defect this pins: an artifact routing colour through --accent (or
    // --rule, or --ink-muted) and taking the rest from Lucid's remap is exactly
    // as dark-capable as one that declares --paper, and was forced light.
    for (const token of THEME_TOKENS) {
      const h = harness([token]);
      createArtifactTheme(h.document).apply("dark");
      expect(h.theme(), `an artifact declaring only ${token}`).toBe("dark");
    }
  });

  test("an artifact with no tokens and no dark form keeps the one form it has", () => {
    const h = harness();
    createArtifactTheme(h.document).apply("dark");
    expect(h.theme()).toBe("light");
  });

  test("the cascade is asked with Lucid's own attribute off, then it is restored", () => {
    // With the attribute left on, Lucid's injected sheet declares all six and
    // every artifact answers yes - which is how this check once stopped meaning
    // anything from the second theme message onward.
    const h = harness();
    const theme = createArtifactTheme(h.document);
    theme.apply("light");
    theme.apply("dark");
    expect(h.probedWith.length).toBeGreaterThan(0);
    expect(h.probedWith.every((seen) => seen === null)).toBe(true);
    expect(h.theme()).toBe("light");
  });

  test("a dark form of the artifact's own qualifies it, toggle after toggle", () => {
    // Applying a theme REWRITES the condition, so from the second message on no
    // rule mentions prefers-color-scheme. Only the conditions kept aside before
    // the first rewrite still answer truthfully.
    const media = new FakeMediaRule("(prefers-color-scheme: dark)");
    const h = harness([], [sheetOf(media)]);
    const theme = createArtifactTheme(h.document);
    theme.apply("dark");
    expect(h.theme()).toBe("dark");
    theme.apply("light");
    theme.apply("dark");
    expect(h.theme()).toBe("dark");
  });

  test("a rule keyed on the attribute Lucid sets is a dark form too", () => {
    const h = harness([], [sheetOf(new FakeStyleRule(':root[data-lucid-theme="dark"]'))]);
    createArtifactTheme(h.document).apply("dark");
    expect(h.theme()).toBe("dark");
  });
});

describe("the artifact's own color-scheme queries are retuned, reversibly", () => {
  test("a dark block is switched on under dark and off under light, both ways round", () => {
    const dark = new FakeMediaRule("(prefers-color-scheme: dark)");
    const light = new FakeMediaRule("(prefers-color-scheme: light)");
    const h = harness([], [sheetOf(dark, light)]);
    const theme = createArtifactTheme(h.document);

    theme.apply("dark");
    expect(dark.conditionText).toBe("(min-width: 0px)");
    expect(light.conditionText).toBe("(max-width: 0px)");

    theme.apply("light");
    expect(dark.conditionText).toBe("(max-width: 0px)");
    expect(light.conditionText).toBe("(min-width: 0px)");

    theme.apply("dark");
    expect(dark.conditionText).toBe("(min-width: 0px)");
  });

  test("only the color-scheme feature is touched", () => {
    const media = new FakeMediaRule("(prefers-color-scheme: dark) and (min-width: 60em)");
    const h = harness([], [sheetOf(media)]);
    createArtifactTheme(h.document).apply("dark");
    expect(media.conditionText).toBe("(min-width: 0px) and (min-width: 60em)");
  });

  test("a block nested inside another grouping rule is reached", () => {
    // @supports, @layer, @container, @scope and nesting all just expose
    // cssRules, so nothing here may depend on an allowlist of at-rules.
    const inner = new FakeMediaRule("(prefers-color-scheme: dark)");
    const outer = { cssRules: [inner] };
    const h = harness([], [sheetOf(outer)]);
    createArtifactTheme(h.document).apply("dark");
    expect(inner.conditionText).toBe("(min-width: 0px)");
  });
});
