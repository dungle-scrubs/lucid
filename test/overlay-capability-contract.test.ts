import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TRUSTED_OVERLAY_CAPABILITY_KEYS } from "../client/overlay/trusted-overlay.ts";

/**
 * The capability bag the trusted realm hands the overlay is typed on one side
 * only.
 *
 * `bootOverlay(port, tag, capabilities)` declares ~40 members, and the single
 * production implementation is a JavaScript object literal inside a template
 * STRING in `src/server/inject.ts` - source tsc never parses. A member renamed
 * on one side and not the other compiles clean and fails at runtime, inside a
 * hostile iframe, as the outline simply never appearing.
 *
 * The hot-path members would eventually be caught by the
 * artifact-outline-surface-controls e2e spec, at the slowest tier there is. The
 * rare-path ones are why this file exists: `onFontsSettled`,
 * `observeStyleActivity`, `pseudoContent`, and `hasActiveMotion` are read on a
 * web-font settle, a stylesheet edit, a generated-content check, and a running
 * animation - none of which a passing suite has to hit, so losing one is
 * invisible everywhere else.
 *
 * A grep, not a browser: two lists of strings compared in the unit suite, the
 * same shape `locators-drift.test.ts` uses for the generated locators.
 *
 * What it does NOT cover: names only, never signatures. A member whose value
 * drifts in parameter order or arity - `text:boundedText` against a refactored
 * `TrustedOutlineCapabilities.text` - leaves the key set intact, so this file
 * passes, tsc never parses the string, and the build is clean, while the
 * iframe reads a deadline as a node count. Catching that means type-checking
 * the literal rather than comparing two lists of strings.
 */

const INJECT = join(import.meta.dirname, "..", "src", "server", "inject.ts");

/** The body of the bootstrap's `const capabilities={…}`, brace-matched through
 *  the string literals that source is full of. */
const capabilityLiteralBody = (source: string): string => {
  const anchor = source.indexOf("const capabilities={");
  if (anchor === -1) {
    throw new Error("no `const capabilities={` in inject.ts - the bootstrap literal moved");
  }
  const open = source.indexOf("{", anchor);
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("the capabilities literal never closes");
};

/** Property names declared at the top level of an object-literal body, both
 *  `name:value` and shorthand, ignoring everything nested or quoted. */
const topLevelKeys = (body: string): readonly string[] => {
  const keys: string[] = [];
  let entry = "";
  let depth = 0;
  let quote: string | null = null;
  const take = (): void => {
    const name = /^([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(entry.trim())?.[1];
    if (name !== undefined) keys.push(name);
    entry = "";
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (quote !== null) {
      entry += char;
      if (char === "\\") {
        entry += body[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === "," && depth === 0) {
      take();
      continue;
    }
    entry += char;
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
  }
  take();
  return keys;
};

describe("the trusted overlay capability contract", () => {
  test("the bootstrap hands over exactly the members the interface declares", async () => {
    const shipped = topLevelKeys(capabilityLiteralBody(await readFile(INJECT, "utf8")));

    // A duplicate key is a silent shadow, and set equality alone would miss it.
    expect(new Set(shipped).size).toBe(shipped.length);
    expect(
      [...shipped].sort(),
      "src/server/inject.ts and TrustedOverlayCapabilities disagree",
    ).toEqual([...TRUSTED_OVERLAY_CAPABILITY_KEYS].sort());
  });

  test("the extraction reads real property names, not whatever the source contains", () => {
    // The guard's own guard: an extractor that quietly returned nothing, or
    // counted the innards of a value, would make the comparison above vacuous.
    const body = capabilityLiteralBody(
      `const capabilities={hot:(limit)=>{const x=[1,2];return{complete:true,elements:x}},` +
        `quoted:(e)=>attribute(e,["a-b:c"])==="}",shorthand,};`,
    );
    expect(topLevelKeys(body)).toEqual(["hot", "quoted", "shorthand"]);
  });

  test("the artifact-swap's trusted operations are in the bag (DF-3)", () => {
    // importNode and the flat head-access members (remove the old tagged
    // artifact styles, append a tagged clone) are the swap operations that
    // MUST run on captured intrinsics: an artifact that patches
    // Document.prototype.importNode or the head accessors could otherwise
    // observe or redirect them onto overlay-owned nodes. Flat members, not a
    // nested handle, so the bag stays one shape (D-005).
    const keys = new Set(TRUSTED_OVERLAY_CAPABILITY_KEYS);
    expect(keys.has("importNode")).toBe(true);
    expect(keys.has("removeArtifactStyles")).toBe(true);
    expect(keys.has("appendArtifactStyle")).toBe(true);
  });
});
