import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { pastedFilesFromData } from "../../src/server/client/paste-files.js";

const dom = new JSDOM("", { url: "http://localhost/" });
const FileCtor = dom.window.File as typeof File;

const transfer = (clipboardData: unknown): DataTransfer => clipboardData as DataTransfer;

test("paste with no files yields nothing to attach", () => {
  const text = { kind: "string", getAsFile: () => null };
  expect(pastedFilesFromData(transfer({ files: [], items: [text] }))).toEqual([]);
});

test("paste prefers clipboard files list when present", () => {
  const shot = new FileCtor(["bytes"], "screenshot.png", { type: "image/png" });
  const itemFile = new FileCtor(["other"], "other.png", { type: "image/png" });
  const asList = (files: File[]): FileList =>
    ({
      length: files.length,
      item: (at: number) => files[at] ?? null,
      [Symbol.iterator]: function* () {
        yield* files;
      },
    }) as FileList;
  const data = {
    files: asList([shot]),
    items: [{ kind: "file", getAsFile: () => itemFile }],
  };
  expect(pastedFilesFromData(transfer(data))).toEqual([shot]);
});

test("paste falls back to file items and skips text entries", () => {
  const shot = new FileCtor(["bytes"], "screenshot.png", { type: "image/png" });
  const text = { kind: "string", getAsFile: () => null };
  const data = {
    files: [] as unknown as FileList,
    items: [text, { kind: "file", getAsFile: () => shot }, { kind: "file", getAsFile: () => null }],
  };
  expect(pastedFilesFromData(transfer(data))).toEqual([shot]);
});

test("pasted documents ride the same store path as chosen files", () => {
  const doc = new FileCtor(["%PDF"], "notes.pdf", { type: "application/pdf" });
  const data = {
    files: [] as unknown as FileList,
    items: [{ kind: "file", getAsFile: () => doc }],
  };
  const found = pastedFilesFromData(transfer(data));
  expect(found.map((f) => [f.name, f.type])).toEqual([["notes.pdf", "application/pdf"]]);
});
