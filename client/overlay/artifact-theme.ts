/**
 * The human's palette choice, applied to the artifact document.
 *
 * Two parts: an attribute on `<html>`, and a stylesheet that remaps the six
 * standard design-system tokens for each theme. The attribute selector
 * (`:root[data-lucid-theme=…]`) outranks both the artifact's own `:root`
 * block and its `@media (prefers-color-scheme: dark)` remap - a media query
 * carries no specificity of its own - so the choice holds even on an artifact
 * written before Lucid had a toggle, and even when it disagrees with the OS.
 *
 * Only the standard tokens are declared. An artifact's own extra variables,
 * and anything it derives from these, follow automatically.
 *
 * Kept apart from the overlay because none of it touches markers, anchors or
 * the outline: it rewrites another party's stylesheets through the CSSOM, which
 * is where its three documented past bugs came from, and that work is worth
 * being able to test on its own.
 */

import { THEME_PALETTE, THEME_TOKENS, type ThemeName } from "../../src/core/palette.ts";

export interface ArtifactTheme {
  /** Apply the reader's choice, as far as this artifact can carry it. */
  readonly apply: (theme: ThemeName) => void;
  /** Re-evaluate the reader's choice after a live swap installs new styles. */
  readonly reapply: () => void;
}

/**
 * The CSSOM constructors and the cascade reader, taken from the artifact
 * document's OWN realm rather than the global one. `instanceof` does not cross
 * realms, so the rules of a document must be tested against that document's
 * classes - which is also what lets a stand-in document be handed in.
 */
type ThemeRealm = Pick<
  Window & typeof globalThis,
  "CSSImportRule" | "CSSMediaRule" | "CSSStyleRule" | "CSSStyleSheet" | "getComputedStyle"
>;

/** The injected sheet, generated from the one palette table (src/core/palette.ts)
 *  so the values Lucid remaps to exist in exactly one place. */
const TOKEN_SHEET: string = (["light", "dark"] as const)
  .map((theme) => {
    const declarations = THEME_TOKENS.map((token) => `  ${token}: ${THEME_PALETTE[theme][token]};`);
    return [
      `:root[data-lucid-theme="${theme}"] {`,
      ...declarations,
      `  color-scheme: ${theme};`,
      "}",
    ].join("\n");
  })
  .join("\n");

export const createArtifactTheme = (document: Document): ArtifactTheme => {
  const realm: ThemeRealm = document.defaultView ?? globalThis;
  let requestedTheme: ThemeName = "light";
  let tokenSheet: CSSStyleSheet | undefined;

  /** Each `prefers-color-scheme` media rule with its ORIGINAL condition, so
   *  toggling back and forth stays lossless. */
  const schemeQueries = new WeakMap<CSSMediaRule, string>();

  /**
   * The token sheet, adopted rather than appended: `style-src` governs style
   * ELEMENTS, and a constructed sheet is not subject to it at all, so Lucid
   * keeps its hands off the artifact's own CSP. Adopted once - the table it
   * carries never changes, and the attribute on `<html>` is what selects
   * between its two blocks.
   */
  const adoptTokens = (): void => {
    if (tokenSheet) return;
    tokenSheet = new realm.CSSStyleSheet();
    tokenSheet.replaceSync(TOKEN_SHEET);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, tokenSheet];
  };

  /**
   * Does the artifact route colour through the standard tokens?
   *
   * Asked of the RESOLVED cascade, because a rule walk cannot answer it. The
   * artifact frame is sandboxed without `allow-same-origin` (Chrome.tsx), so it
   * runs on an opaque origin - which is cross-origin with its own server. Every
   * `<link>`ed sheet therefore throws `SecurityError` on `cssRules`, and a walk
   * would conclude "no tokens" for the entire class of artifact that keeps its
   * CSS in a file. Their tokens resolve perfectly well; they are simply not
   * readable rule by rule.
   *
   * All six, not two: an artifact that routes its colour through `--accent`,
   * `--rule` or `--ink-muted` and takes the rest of the palette from Lucid's
   * remap is exactly as dark-capable as one that declares `--paper`, and
   * probing only the first two forced it light.
   *
   * Lucid's own tokens are excluded by un-matching them rather than by skipping
   * a sheet: `:root[data-lucid-theme=…]` is the only selector its injected sheet
   * uses, so with the attribute absent its declarations cannot apply. Removed
   * and restored inside one task, so nothing can paint in between.
   */
  const cascadeDeclaresTokens = (): boolean => {
    const root = document.documentElement;
    const previous = root.dataset.lucidTheme;
    delete root.dataset.lucidTheme;
    try {
      const own = realm.getComputedStyle(root);
      return THEME_TOKENS.some((token) => own.getPropertyValue(token).trim() !== "");
    } finally {
      if (previous !== undefined) root.dataset.lucidTheme = previous;
    }
  };

  /**
   * Does the artifact ship a dark form of its own - a `prefers-color-scheme`
   * block Lucid can retune, or a rule keyed on the attribute Lucid sets?
   *
   * This one needs the rules: no computed value reveals that a document has a
   * dark variant it is not currently showing. Sheets the sandbox makes
   * unreadable are skipped, which is the right direction here - an unreadable
   * dark block cannot be retuned either, so it would keep following the OS
   * rather than the reader, and claiming it as a dark form would be a lie.
   */
  const carriesOwnDarkForm = (): boolean => {
    const qualifies = (rules: CSSRuleList): boolean => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof realm.CSSMediaRule) {
          const original = schemeQueries.get(rule) ?? rule.conditionText;
          if (/prefers-color-scheme/i.test(original)) return true;
        }
        // An artifact may key its own dark form off the attribute Lucid sets.
        // `themeReadiness` in src/core/theme.ts already counts that as a dark
        // form when it warns the author, so the viewer has to agree with it -
        // otherwise `lucid open` stays silent and the artifact is then refused.
        if (
          rule instanceof realm.CSSStyleRule &&
          /data-lucid-theme\s*=\s*["']?dark/i.test(rule.selectorText)
        ) {
          return true;
        }
        // `@import` hides a whole sheet behind a single rule. Every other
        // grouping at-rule - @media, @supports, @layer, @container, @scope, and
        // CSS nesting - just exposes `cssRules`, so duck-typing covers the ones
        // not invented yet rather than an allowlist that silently misses them.
        if (rule instanceof realm.CSSImportRule) {
          try {
            if (rule.styleSheet && qualifies(rule.styleSheet.cssRules)) return true;
          } catch {
            /* imported sheet unreadable from this origin */
          }
          continue;
        }
        const nested = (rule as Partial<CSSGroupingRule>).cssRules;
        if (nested && qualifies(nested)) return true;
      }
      return false;
    };

    for (const sheet of Array.from(document.styleSheets)) {
      // Every sheet Lucid injects, not just the token one: the diff and section
      // sheets carry hardcoded colours today, and the first person to tokenise
      // them would otherwise reinstate exactly the bug this method exists to fix.
      if ((sheet.ownerNode as Element | null)?.id?.startsWith("__lucid_")) continue;
      try {
        if (qualifies(sheet.cssRules)) return true;
      } catch {
        /* opaque-origin or cross-origin sheet: unreadable from here */
      }
    }
    return false;
  };

  /**
   * Can this document be rendered dark at all?
   *
   * Two ways to qualify: it routes colour through the standard tokens (so
   * Lucid's injected dark values reach it), or it ships its own
   * `prefers-color-scheme` block (so retuning the query reaches it). An
   * artifact with neither has exactly one appearance, and honouring that is
   * more useful than a dark rectangle full of invisible text.
   *
   * The question is about the artifact AS ITS AUTHOR WROTE IT, and both halves
   * used to answer with Lucid's own work instead:
   *
   * - `getComputedStyle(:root).--paper` sees the token sheet `apply` injects,
   *   whose `:root[data-lucid-theme="light"]` block declares every token this
   *   asks about. From the second theme message onward every artifact declared
   *   the tokens, so every artifact was dark-capable and this check stopped
   *   meaning anything.
   * - `rule.conditionText` is REWRITTEN by `retuneColorSchemeQueries`, to
   *   `(min-width: 0px)` or `(max-width: 0px)`. After the first theme message no
   *   rule mentions `prefers-color-scheme` at all, so an artifact that qualified
   *   only on its own dark block stopped qualifying. `schemeQueries` keeps the
   *   original condition and is the only trustworthy source from then on.
   *
   * Measured fresh on every call, never memoized: `markOverlayReady` fires both
   * on the overlay's `ready` message and on the iframe's `load`, so a `<link>`
   * sheet can land BETWEEN two theme messages. Freezing the first answer would
   * lock such an artifact out of dark with no way back.
   */
  const canRenderDark = (): boolean => cascadeDeclaresTokens() || carriesOwnDarkForm();

  /**
   * Hand the artifact's OWN dark block to the human instead of to the OS.
   *
   * Injecting the six standard tokens is not enough: a good artifact remaps a
   * dozen (`--surface`, `--sunken`, `--muted`, `--faint`…) inside
   * `@media (prefers-color-scheme: dark)`, and that query keeps matching on a
   * dark machine no matter what the reader picked. The result was the worst of
   * both - light paper with dark code chips, dark panels and pale grey body
   * text, all technically token-driven.
   *
   * So the color-scheme FEATURE is rewritten to a condition that is simply true
   * or false: `(min-width: 0px)` / `(max-width: 0px)`. Only that feature is
   * touched, so `(prefers-color-scheme: dark) and (min-width: 60em)` keeps its
   * width test. Nothing about the artifact's own CSS has to change, and an
   * artifact opened straight from disk still follows the OS as its author
   * intended - this only applies while Lucid is the one rendering it.
   */
  const retuneColorSchemeQueries = (theme: ThemeName): void => {
    const rewrite = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof realm.CSSMediaRule) {
          const original = schemeQueries.get(rule) ?? rule.conditionText;
          if (/prefers-color-scheme/i.test(original)) {
            schemeQueries.set(rule, original);
            // A block written for the theme in force is switched ON, the other
            // OFF - whichever way round the author wrote it.
            const wantsDark = /dark/i.test(original);
            const on = wantsDark === (theme === "dark");
            try {
              rule.media.mediaText = original.replace(
                /\(\s*prefers-color-scheme\s*:\s*(?:dark|light)\s*\)/gi,
                on ? "(min-width: 0px)" : "(max-width: 0px)",
              );
            } catch {
              /* some engines refuse the write; the token floor still applies */
            }
          }
          rewrite(rule.cssRules);
          continue;
        }
        // An imported sheet is a whole stylesheet behind one rule, and its dark
        // block needs retuning like any other - left alone it keeps following
        // the OS after the reader has chosen. Everything else that can wrap a
        // color-scheme block (@supports, @layer, @container, @scope, nesting)
        // exposes `cssRules`, so duck-typing covers them without an allowlist
        // that quietly misses whatever CSS adds next. Kept in step with
        // `carriesOwnDarkForm`, which has to find exactly what this can retune.
        if (rule instanceof realm.CSSImportRule) {
          try {
            if (rule.styleSheet) rewrite(rule.styleSheet.cssRules);
          } catch {
            /* imported sheet unreadable from this origin */
          }
          continue;
        }
        const nested = (rule as Partial<CSSGroupingRule>).cssRules;
        if (nested) rewrite(nested);
      }
    };

    for (const sheet of Array.from(document.styleSheets)) {
      try {
        rewrite(sheet.cssRules);
      } catch {
        /* a sheet we may not read (cross-origin): nothing to retune */
      }
    }
  };

  const apply = (theme: ThemeName): void => {
    requestedTheme = theme;
    // An artifact with NO dark form must not be forced into one. Declaring
    // `color-scheme: dark` flips the browser's own canvas to near-black while
    // the document's hardcoded ink stays dark - dark text on a dark ground,
    // which is worse than the light page the author actually designed.
    const wanted = theme === "dark" && !canRenderDark() ? "light" : theme;
    document.documentElement.dataset.lucidTheme = wanted;
    retuneColorSchemeQueries(wanted);
    adoptTokens();
  };

  return { apply, reapply: () => apply(requestedTheme) };
};
