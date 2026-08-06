import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonFile, writeTextAtomic, writeTextAtomicSync } from "../src/core/atomic-json.ts";

/**
 * M1.2 - the ONE atomic publish.
 *
 * The contract: a uniquely named sibling is written then renamed over the
 * target, so (a) a reader sees the old complete document or the new complete
 * document, never a torn one, and (b) two writers racing the same target cannot
 * write through each other's tmp file. This replaces four hand-rolled copies -
 * one of which used a non-unique `${target}.tmp` that two concurrent saves
 * would clobber.
 */
describe("M1.2: atomic-json - one atomic publish", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lucid-atomic-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writeTextAtomic writes complete content and leaves no tmp behind", async () => {
    const target = join(dir, "out.txt");
    await writeTextAtomic(target, "hello world");
    expect(await readFile(target, "utf8")).toBe("hello world");
    const siblings = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    expect(siblings).toEqual([]);
  });

  test("writeTextAtomic creates a missing parent dir", async () => {
    const target = join(dir, "nested", "deep", "out.txt");
    await writeTextAtomic(target, "x");
    expect(await readFile(target, "utf8")).toBe("x");
  });

  test("writeTextAtomicSync is a synchronous atomic publish", () => {
    const target = join(dir, "sync.txt");
    writeTextAtomicSync(target, "sync-body");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("sync-body");
    // A rename-based publish: no tmp remains once it returns.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("two concurrent writers on one target never corrupt each other (unique tmps)", async () => {
    // The old hand-rolled saveHandled used `${target}.tmp` - one shared name -
    // so two concurrent saves wrote through the same tmp and could interleave
    // bytes. Unique tmp names mean each writer renames its own complete file.
    const target = join(dir, "race.json");
    const values = Array.from({ length: 40 }, (_, i) => ({ i, body: "x".repeat(2000) }));
    await Promise.all(values.map((v) => writeJsonFile(target, v)));
    // The winner is whichever renamed last - but it must be ONE complete value,
    // never a splice of two.
    const final = JSON.parse(await readFile(target, "utf8")) as { i: number; body: string };
    expect(final.body.length).toBe(2000);
    expect(values.some((v) => v.i === final.i)).toBe(true);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("a reader during a concurrent write sees a complete document, never a torn one", async () => {
    // Atomicity is the rename: the target is replaced in one step, so a reader
    // racing a writer observes either the previous complete value or the next
    // complete value. Hammer it and require every observed read to parse and
    // carry the full body.
    const target = join(dir, "torn.json");
    await writeJsonFile(target, { i: 0, body: "init".repeat(500) });
    const writers = Array.from({ length: 30 }, (_, i) =>
      writeJsonFile(target, { i: i + 1, body: `v${i}`.repeat(500) }),
    );
    const reads: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      reads.push(
        readFile(target, "utf8")
          .then((s) => JSON.parse(s) as { body: string })
          .then((v) => expect(v.body.length).toBeGreaterThanOrEqual(500)),
      );
    }
    await Promise.all([...writers, ...reads]);
  });
});
