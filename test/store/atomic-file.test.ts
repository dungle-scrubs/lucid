import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicSidecar } from "../../src/store/atomic-file.js";

test("exclusive sidecar creation failure preserves a temporary file owned by another writer", () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-sidecar-collision-"));
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const path = join(root, "sidecar.json");
  const temporary = `${path}.${id}.part`;
  writeFileSync(path, "existing sidecar");
  writeFileSync(temporary, "other writer");
  const random = spyOn(crypto, "randomUUID").mockReturnValue(id);
  try {
    expect(() => atomicSidecar(path, { replacement: true })).toThrow();
    expect(readFileSync(path, "utf8")).toBe("existing sidecar");
    expect(readFileSync(temporary, "utf8")).toBe("other writer");
  } finally {
    random.mockRestore();
    rmSync(root, { force: true, recursive: true });
  }
});
