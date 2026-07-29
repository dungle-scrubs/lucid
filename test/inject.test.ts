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

describe("the D-019 review's adversarial corpus (F2-F5, F7)", () => {
  test("</scripting> inside a script does not end it (appropriate-end-tag boundary, F2)", () => {
    const html = `<html><body><script>var s = "</scripting>"; var t = "</body>";</script><p>a</p></body></html>`;
    const idx = bodyCloseIndex(html);
    expect(html.slice(idx)).toBe("</body></html>");
    expect(idx).toBeGreaterThan(html.indexOf("</script>"));
  });

  test("a double-escaped script comment stays script data (F2)", () => {
    const html = `<html><body><script><!--<script></script>var s="</body>";--></script><p>a</p></body></html>`;
    // The tokenizer's double-escape rule: the inner </script> is consumed as
    // script text, the element closes at the real trailing one, and the JS
    // string never takes the splice.
    const idx = bodyCloseIndex(html);
    expect(html.slice(idx)).toBe("</body></html>");
  });

  test("markup inside a quoted attribute is neither rawtext nor a close (F3/F4)", () => {
    const attrRawtext = `<html><body><div data-tpl="<script>">x</div><p>b</p></body></html>`;
    expect(bodyCloseIndex(attrRawtext)).toBe(attrRawtext.lastIndexOf("</body>"));
    const attrClose = `<html><body><div title="type </body> here">x</div></body></html>`;
    expect(bodyCloseIndex(attrClose)).toBe(attrClose.lastIndexOf("</body>"));
  });

  test("HTML5 abrupt comment closes terminate the comment (F3)", () => {
    for (const c of ["<!-->", "<!--->", "<!-- n --!>"]) {
      const html = `<html><body>${c}<p>b</p></body></html>`;
      expect(bodyCloseIndex(html)).toBe(html.lastIndexOf("</body>"));
    }
  });

  test("the other rawtext elements hide their content too (F5)", () => {
    for (const t of ["xmp", "noscript", "noembed", "noframes", "style", "title"]) {
      const html = `<html><body><${t}>text </body${""}> text</${t}><p>b</p></body></html>`;
      expect(bodyCloseIndex(html)).toBe(html.lastIndexOf("</body>"));
    }
  });

  test("plaintext swallows the rest of the document (F5)", () => {
    expect(bodyCloseIndex(`<html><body><plaintext></body></html>`)).toBe(-1);
  });

  test("no </body> but a real </html> splices before it (F7: the fallback)", () => {
    const html = `<html><p>headless fragment</p></html>`;
    const out = injectOverlay(html);
    const boot = out.indexOf("__lucid_overlay_root");
    expect(boot).toBeGreaterThan(-1);
    expect(boot).toBeLessThan(out.lastIndexOf("</html>"));
  });

  test("maskHiddenText preserves length across the nasty corpus (F7)", async () => {
    const { maskHiddenText } = await import("../src/core/html-scan.ts");
    const corpus = [
      `<html><body><script>var s = "</scripting>";</script></body></html>`,
      `<html><body><!--></body>--!></body></html>`,
      `<div title="a>b" data-x='</body>'>x</div>`,
      `<textarea>unterminated`,
      `<plaintext>rest`,
      `<!-- unterminated`,
      `<xmp>literal </body></xmp><p>b</p>`,
    ];
    for (const html of corpus) {
      expect(maskHiddenText(html).length).toBe(html.length);
    }
  });

  test("the hot path stays hot: a ~4MB document splices in single-digit ms territory (F1)", () => {
    const rows = Array.from({ length: 40_000 }, (_, i) => `<li>row ${i} with some text</li>`).join(
      "\n",
    );
    const html = `<!doctype html><html><head><title>big</title></head><body><ol>${rows}</ol></body></html>`;
    const t0 = performance.now();
    const out = injectOverlay(html);
    const ms = performance.now() - t0;
    expect(out).toContain("__lucid_overlay_root");
    // Generous bound for a loaded runner: the masked-copy implementation
    // measured ~343ms on this size (D-019 review F1); the skip-scan is ~2ms.
    expect(ms).toBeLessThan(120);
  });
});

describe("renderInjected: a document CSP is lifted, nonced, and honored (#42)", () => {
  const withMeta = (policy: string): string =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}" /><title>t</title></head><body><p>x</p></body></html>`;

  test("no meta: body injected, no header, no nonce", async () => {
    const { renderInjected } = await import("../src/server/inject.ts");
    const out = renderInjected(doc("<p>plain</p>"));
    expect(out.headers).toEqual({});
    expect(out.body).toContain("__lucid_overlay_root");
    expect(out.body).not.toContain("nonce=");
  });

  test("a meta CSP is removed from the body and lifted into the header with nonces", async () => {
    const { renderInjected } = await import("../src/server/inject.ts");
    const out = renderInjected(withMeta("default-src 'none'; style-src 'unsafe-inline'"));
    expect(out.body).not.toContain("http-equiv");
    const csp = out.headers["content-security-policy"] ?? "";
    // The document's own governance survives...
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    // ...and the bootstrap is permitted by nonce, derived from default-src
    // with 'none' dropped (it only has meaning alone).
    const nonce = /nonce="([a-f0-9]+)"/.exec(out.body)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(10);
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain(`style-src 'unsafe-inline' 'nonce-${nonce}'`);
    // Both bootstrap scripts carry it, and the overlay can read it back.
    expect(out.body).toContain(`nonce:"${nonce}"`);
  });

  test("an existing script-src keeps its sources and gains only the nonce", async () => {
    const { renderInjected } = await import("../src/server/inject.ts");
    const out = renderInjected(withMeta("script-src 'self' https://cdn.example"));
    const csp = out.headers["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' https:\/\/cdn\.example 'nonce-[a-f0-9]+'/);
  });

  test("a policy that never constrained scripts is not tightened", async () => {
    const { renderInjected } = await import("../src/server/inject.ts");
    const out = renderInjected(withMeta("img-src 'none'"));
    const csp = out.headers["content-security-policy"] ?? "";
    expect(csp).not.toContain("script-src"); // unrestricted stays unrestricted
    expect(csp).toContain("img-src 'none'");
  });

  test("a CSP meta quoted inside a textarea is text, not policy", async () => {
    const { renderInjected } = await import("../src/server/inject.ts");
    const html = doc(
      `<textarea><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></textarea>`,
    );
    const out = renderInjected(html);
    expect(out.headers).toEqual({});
    expect(out.body).toContain("<meta http-equiv"); // untouched, it is content
  });
});
