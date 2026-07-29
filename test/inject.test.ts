import { describe, expect, test } from "bun:test";
import { bodyCloseIndex, injectOverlay } from "../src/server/inject.ts";

/**
 * Overlay injection splices at the TRUE body close (plan 04, M1.1, #44).
 *
 * The old regex anchored on the first raw `</body>` in the source text, which
 * an artifact can legitimately hold as TEXT - inside a textarea (RCDATA), a
 * script/style, or an HTML comment. Splicing there renders the bootstrap as
 * visible content and never boots the overlay. The splice point must be the
 * close the PARSER would honor.
 */

const doc = (body: string): string =>
  `<!doctype html>\n<html><head><title>t</title></head>\n<body>\n${body}\n</body>\n</html>`;

describe("bodyCloseIndex: the close the parser would honor", () => {
  test("a literal </body> inside a textarea is text, not the close", () => {
    const html = doc(`<textarea>draft with </body> inside</textarea><p>after</p>`);
    const idx = bodyCloseIndex(html);
    expect(idx).toBeGreaterThan(html.indexOf("</textarea>"));
    expect(html.slice(idx)).toMatch(/^<\/body\s*>/i);
  });

  test("a literal </body> inside a script is swallowed rawtext", () => {
    const html = doc(`<script>const s = "</bo" + "dy>";</script><p>after</p>`);
    // The whole script content is rawtext; the literal fragment never closes
    // anything - only the real close after it does.
    expect(bodyCloseIndex(html)).toBe(html.lastIndexOf("</body>"));
  });

  test("a literal </body> inside an HTML comment is not the close", () => {
    const html = doc(`<!-- </body> is what old exports wrote --><p>after</p>`);
    expect(bodyCloseIndex(html)).toBe(html.lastIndexOf("</body>"));
  });

  test("a document with no </body> reports none", () => {
    expect(bodyCloseIndex("<html><body><p>open ended")).toBe(-1);
  });
});

describe("injectOverlay: splices outside the hostile containers", () => {
  test("the textarea keeps its text; the bootstrap lands after it", () => {
    const html = doc(`<textarea>draft with </body> inside</textarea>`);
    const out = injectOverlay(html);
    // The textarea's content is untouched...
    expect(out).toContain(`<textarea>draft with </body> inside</textarea>`);
    // ...and the bootstrap sits between the textarea and the REAL close.
    const boot = out.indexOf("__lucid_overlay_root");
    expect(boot).toBeGreaterThan(out.indexOf("</textarea>"));
    expect(boot).toBeLessThan(out.lastIndexOf("</body>"));
  });

  test("a normal document is unchanged byte-for-byte outside the splice", () => {
    const html = doc(`<p>plain</p>`);
    const out = injectOverlay(html);
    const at = out.indexOf('\n<div id="__lucid_overlay_root"');
    expect(at).toBeGreaterThan(-1);
    const injectedLen = out.length - html.length;
    expect(out.slice(0, at)).toBe(html.slice(0, at));
    expect(out.slice(at + injectedLen)).toBe(html.slice(at));
  });

  test("no </body> at all still appends the bootstrap", () => {
    const out = injectOverlay("<p>fragment");
    expect(out).toContain("__lucid_overlay_root");
  });
});
