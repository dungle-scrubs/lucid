import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { instrumentArtifact } from "../../src/server/client/instrument.js";

describe("artifact canvas backgrounds", () => {
  test("a narrow authored body can paint the document canvas", () => {
    // This is the reported pattern: a dark body with wide auto margins,
    // no root background, and no standard color-scheme declaration.
    const bytes = `<!doctype html><html><head>
      <meta name="lucid-theme" content="adaptive">
      <style>body { background: #141412; color: #e8e6e1;
        max-width: 56rem; margin: 0 auto; }</style>
      </head><body><p>Read the document</p></body></html>`;
    const dom = new JSDOM(instrumentArtifact(bytes, "background", 1));
    const { document, getComputedStyle } = dom.window;
    // CSS Backgrounds 3, section 2.11.2: body propagation requires the
    // root background to be transparent and its background image none.
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(document.documentElement).backgroundImage).toBe("none");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(20, 20, 18)");
    expect(getComputedStyle(document.body).color).toBe("rgb(232, 230, 225)");
    dom.window.close();
  });

  test("authored root and body backgrounds remain independent", () => {
    const dom = new JSDOM(
      instrumentArtifact(
        "<style>html { background: #123456; color: #abcdef } body { background: #654321 }</style><p>Text</p>",
        "background",
        1,
      ),
    );
    const { document, getComputedStyle } = dom.window;
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(18, 52, 86)");
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgb(101, 67, 33)");
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("Missing test paragraph");
    expect(getComputedStyle(paragraph).color).toBe("rgb(171, 205, 239)");
    dom.window.close();
  });

  test.each([
    ["app.css", ".doc-frame"],
    ["content-comparison.css", ".comparison-inspection iframe"],
  ])("%s provides a scheme-aware backing outside the document", (file, selector) => {
    const css = readFileSync(`src/server/client/${file}`, "utf8");
    const rule = css.slice(css.indexOf(`${selector} {`)).split("}")[0];
    const dom = new JSDOM(`<style>${rule}}</style><div class="comparison-inspection">
      <iframe class="doc-frame" style="color-scheme:dark"></iframe></div>`);
    const frame = dom.window.document.querySelector("iframe");
    if (!frame) throw new Error("Missing test frame");
    expect(dom.window.getComputedStyle(frame).backgroundColor).toBe("rgb(0, 0, 0)");
    frame.style.colorScheme = "light";
    expect(dom.window.getComputedStyle(frame).backgroundColor).toBe("rgb(255, 255, 255)");
    dom.window.close();
  });
});
