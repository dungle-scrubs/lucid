import { expect, test } from "bun:test";
import { declaredTheme, readHeadMeta } from "../../src/protocol/artifact-theme.js";

// The shared vectors: the CLI-side parse MUST match the reader's
// classification on every row of the browser theme test.
const vectors = [
  ['<meta name="lucid-theme" content="adaptive">', "adaptive"],
  ['<META NAME="lucid-theme" CONTENT=" \tlight\n">', "light"],
  ['<meta name="lucid-theme" content="dark">', "dark"],
  ['<meta name="color-scheme" content="light dark">', "unmanaged"],
  ['<meta name="lucid-theme" content="Dark">', "unmanaged"],
  ['<meta name="lucid-theme" content=" dark">', "unmanaged"],
  ['<meta name="lucid-theme" content=""><meta name="lucid-theme" content="dark">', "unmanaged"],
  ['<!-- <meta name="lucid-theme" content="dark"> -->', "unmanaged"],
  ['<script>const example = \'<meta name="lucid-theme" content="dark">\';</script>', "unmanaged"],
  ['</head><body><meta name="lucid-theme" content="dark">', "unmanaged"],
] as const;

test("the CLI-side theme parse matches the reader on every shared vector", () => {
  for (const [markup, expected] of vectors) {
    expect(declaredTheme(`<html><head>${markup}</head><body>Content</body></html>`)).toBe(expected);
  }
});

test("hostile bytes never throw; they read unmanaged", () => {
  expect(declaredTheme("not html at all {{{")).toBe("unmanaged");
  expect(declaredTheme("")).toBe("unmanaged");
  expect(readHeadMeta("<html><head>", "lucid-theme")).toBeNull();
});
