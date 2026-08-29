/**
 * The lists the menus choose from (RFC-12), as the server serves them.
 *
 * Two layers: the pure projection from inspect facts, driven with values;
 * and the served answer itself, read from the pinned hcn through the seam -
 * deterministic because the dependency is pinned exactly, and re-pinned
 * deliberately, so an assertion that breaks names the bump, not a flake.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import type { HarnessFacts, HarnessName } from "../../src/harness/runner.js";
import { driverChoices, driverChoicesFromFacts } from "../../src/server/driver-choices.js";

const facts = (over: Partial<HarnessFacts> = {}): HarnessFacts => ({
  name: "x",
  session: false,
  verifiedAgainst: "1.0.0",
  ...over,
});

describe("the projection from inspect facts", () => {
  test("harnesses are the four hcn knows, in the seam's own order", () => {
    const served = driverChoicesFromFacts({});
    expect(served.harnesses).toEqual(["claude", "codex", "pi", "muse"]);
    expect(served.vocabulary).toEqual({});
  });

  test("a harness whose facts carry no vocabulary has no entry - absent, not empty", () => {
    const served = driverChoicesFromFacts({
      claude: facts(),
      pi: facts({ vocabulary: { models: ["zai/glm-5.2"], efforts: ["medium"], extensible: true } }),
    });
    expect(Object.keys(served.vocabulary)).toEqual(["pi"]);
    expect(served.vocabulary.claude).toBeUndefined();
  });

  test("an inspect that fails is a harness with no entry, not a refusal", async () => {
    // The runner answers what the real one would for a harness the dump
    // cannot describe: a thrown refusal.
    const refuseAll = {
      openSession: () => {
        throw new Error("unused");
      },
      streamTurn: () => {
        throw new Error("unused");
      },
      inspect: (h: HarnessName) =>
        h === "pi"
          ? Promise.resolve(
              facts({
                vocabulary: { models: ["zai/glm-5.2"], efforts: ["medium"], extensible: true },
              }),
            )
          : Promise.reject(new Error("no descriptor")),
      capabilities: () => {
        throw new Error("unused");
      },
    } as unknown as Parameters<typeof driverChoices>[0];
    const served = await driverChoices(refuseAll);
    expect(Object.keys(served.vocabulary)).toEqual(["pi"]);
  });
});

describe("what the pinned hcn serves", () => {
  test("the poll carries the lists, read through the seam", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-driver-choices-"));
    const server = await startServe({ rootDir: root, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/conversations/anything`, {
        headers: { "x-lucid-token": server.token },
      });
      const body = (await res.json()) as {
        driverChoices: {
          harnesses: string[];
          vocabulary: Record<string, { models: string[]; efforts: string[]; extensible: boolean }>;
        };
      };
      expect(body.driverChoices.harnesses).toEqual(["claude", "codex", "pi", "muse"]);
      // The pinned 0.6.0 describes all four. On a deliberate hcn bump this
      // is the assertion that names the change.
      expect(Object.keys(body.driverChoices.vocabulary)).toEqual(["claude", "codex", "pi", "muse"]);
      for (const h of Object.keys(body.driverChoices.vocabulary)) {
        const v = body.driverChoices.vocabulary[h];
        if (v === undefined) continue;
        expect(Array.isArray(v.models)).toBe(true);
        expect(v.efforts.length).toBeGreaterThan(0);
        // A ladder places its glosses by order, so the default must be on it.
        expect(v.efforts).toContain("medium");
      }
      // Only pi carries the provider dimension - as an absent key elsewhere,
      // never a false, which would read as "checked and refused".
      expect(body.driverChoices.vocabulary.pi?.extensible).toBe(true);
      const piJson = JSON.stringify(body.driverChoices.vocabulary.pi);
      expect(piJson).toContain('"provider":true');
      expect(JSON.stringify(body.driverChoices.vocabulary.codex)).not.toContain("provider");
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
