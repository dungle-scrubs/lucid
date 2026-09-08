/**
 * The frame's stylesheet and script are template literals, and a backtick
 * inside one ends it.
 *
 * This is not hypothetical and it is not a typo anyone catches by reading. It
 * happened three times while building the annotation and version work, every
 * time in a *comment* — writing a symbol name in backticks, which is the
 * house style everywhere else in this repository and is exactly wrong here.
 * The failure is a parse error tens of lines away from the cause, and the
 * error text says nothing about backticks.
 *
 * So it is checked rather than remembered.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(import.meta.dir, "..", "..", "src", "server", "client", "instrument.ts"),
  "utf8",
);

/** The lines between a template literal's opening and its closing `\`;`. */
const insideLiteral = (startsWith: string): { line: number; text: string }[] => {
  const lines = SOURCE.split("\n");
  const start = lines.findIndex((l) => l.startsWith(startsWith));
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && l === "`;");
  expect(end).toBeGreaterThan(start);
  return lines
    .slice(start + 1, end)
    .map((text, i) => ({ line: start + 2 + i, text }))
    .filter((r) => r.text.includes("`"));
};

describe("the strings injected into the artifact frame", () => {
  test("the stylesheet carries no backtick", () => {
    expect(insideLiteral("export const STYLE = `")).toEqual([]);
  });

  test("the script carries no backtick", () => {
    expect(insideLiteral("const script = ")).toEqual([]);
  });
});
