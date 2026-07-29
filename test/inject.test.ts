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

describe("renderInjected: the CSP lift changes as little as possible (#42)", () => {
  const withMeta = (policy: string, body = "<p>x</p>"): string =>
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}" /><title>t</title></head><body>${body}</body></html>`;
  const render = async (html: string) => {
    const { renderInjected } = await import("../src/server/inject.ts");
    return renderInjected(html, "", "http://127.0.0.1:17429");
  };
  const csp = (out: { headers: Readonly<Record<string, string>> }): string =>
    out.headers["content-security-policy"] ?? "";

  test("no meta: body injected, no header, no nonce", async () => {
    const out = await render(doc("<p>plain</p>"));
    expect(out.headers).toEqual({});
    expect(out.body).toContain("__lucid_overlay_root");
    expect(out.body).not.toContain("nonce=");
  });

  test("a restrictive meta is lifted and the bootstrap granted by nonce", async () => {
    const out = await render(withMeta("default-src 'none'"));
    expect(out.body).not.toContain("http-equiv");
    const nonce = /nonce="([a-f0-9]+)"/.exec(out.body)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(10);
    expect(csp(out)).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp(out)).toContain("default-src 'none'");
  });

  test("an artifact's 'unsafe-inline' is NEVER nullified by a nonce", async () => {
    // A nonce in a source list makes the browser IGNORE 'unsafe-inline'
    // (CSP3 6.7.3.2), which would strip an ordinary self-contained artifact's
    // own inline scripts. The origin is granted instead.
    const out = await render(withMeta("default-src 'self' 'unsafe-inline'"));
    expect(csp(out)).toContain("'unsafe-inline'");
    expect(csp(out)).not.toContain("nonce-");
    expect(out.body).not.toContain("nonce=");
    expect(csp(out)).toContain("http://127.0.0.1:17429");
  });

  test("style-src is never touched - the overlay adopts constructed sheets", async () => {
    const out = await render(withMeta("default-src 'none'; style-src 'unsafe-inline'"));
    expect(csp(out)).toContain("style-src 'unsafe-inline'");
    expect(csp(out)).not.toMatch(/style-src[^;,]*nonce/);
  });

  test("the directives a meta must ignore are dropped, not switched on", async () => {
    // report-uri in a meta is inert by spec; lifting it verbatim would hand a
    // 'none' document a live network egress carrying its URI and a sample.
    const out = await render(
      withMeta(
        "default-src 'none'; report-uri https://evil.example/c; frame-ancestors 'none'; sandbox",
      ),
    );
    expect(csp(out)).not.toContain("report-uri");
    expect(csp(out)).not.toContain("frame-ancestors");
    expect(csp(out)).not.toContain("sandbox");
    expect(csp(out)).toContain("default-src 'none'");
  });

  test("script-src-elem governs the bootstrap element when present", async () => {
    const out = await render(withMeta("default-src 'none'; script-src-elem 'self'"));
    expect(csp(out)).toMatch(/script-src-elem 'self' 'nonce-[a-f0-9]+'/);
  });

  test("an uppercase <META> is lifted too", async () => {
    const html = `<!doctype html><html><head><META HTTP-EQUIV="Content-Security-Policy" CONTENT="default-src 'none'" /></head><body><p>x</p></body></html>`;
    const out = await render(html);
    expect(out.body).not.toMatch(/http-equiv/i);
    expect(csp(out)).toContain("default-src 'none'");
  });

  test("a decoy data-content attribute does not stand in for the policy", async () => {
    const html = `<!doctype html><html><head><meta data-content="decoy" http-equiv="Content-Security-Policy" content="default-src 'none'" /></head><body><p>x</p></body></html>`;
    const out = await render(html);
    expect(csp(out)).toContain("default-src 'none'");
    expect(csp(out)).not.toContain("decoy");
  });

  test("a multi-line policy becomes a legal single-line header", async () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src 'self'" /></head><body><p>x</p></body></html>`;
    const out = await render(html);
    expect(csp(out)).not.toMatch(/[\r\n]/);
    expect(
      () => new Response("x", { headers: out.headers as Record<string, string> }),
    ).not.toThrow();
  });

  test("an entity-escaped policy is decoded before lifting", async () => {
    const out = await render(withMeta("default-src &#39;none&#39;"));
    expect(csp(out)).toContain("default-src 'none'");
    expect(csp(out)).not.toContain("&#39;");
  });

  test("several metas all enforce, each granting the bootstrap", async () => {
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'" /><meta http-equiv="Content-Security-Policy" content="script-src 'self'" /></head><body><p>x</p></body></html>`;
    const out = await render(html);
    const nonce = /nonce="([a-f0-9]+)"/.exec(out.body)?.[1] ?? "";
    const policies = csp(out).split(", ");
    expect(policies).toHaveLength(2);
    for (const p of policies) expect(p).toContain(`'nonce-${nonce}'`);
  });

  test("a policy that never constrained scripts is not tightened", async () => {
    const out = await render(withMeta("img-src 'none'"));
    expect(csp(out)).not.toContain("script-src");
    expect(csp(out)).toContain("img-src 'none'");
  });

  test("a CSP meta quoted inside a textarea is text, not policy", async () => {
    const html = doc(
      `<textarea><meta http-equiv="Content-Security-Policy" content="default-src 'none'"></textarea>`,
    );
    const out = await render(html);
    expect(out.headers).toEqual({});
    expect(out.body).toContain("<meta http-equiv");
  });

  test("the nonce is not published on the page's global (no escape channel)", async () => {
    const out = await render(withMeta("default-src 'none'"));
    expect(out.body).toContain('window.__LUCID__={mode:"overlay"};');
    expect(out.body).not.toContain("nonce:");
  });
});
