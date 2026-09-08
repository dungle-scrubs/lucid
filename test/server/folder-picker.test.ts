import { expect, test } from "bun:test";
import { createFolderPicker } from "../../src/server/folder-picker.js";

test("folder selection distinguishes cancellation, blocks duplicate dialogs, and releases after completion", async () => {
  let finish: (folder: string | null) => void = () => {};
  const picker = createFolderPicker(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    true,
  );
  const selected = picker.select(new AbortController().signal);
  await expect(picker.select(new AbortController().signal)).rejects.toMatchObject({ status: 409 });
  finish("/Users/a folder");
  expect(await selected).toEqual({ status: "selected", workingDirectory: "/Users/a folder" });
  const cancelled = picker.select(new AbortController().signal);
  finish(null);
  expect(await cancelled).toEqual({ status: "cancelled" });
});

test("shutdown aborts the chooser and failures allow a later attempt", async () => {
  let calls = 0;
  const picker = createFolderPicker((signal) => {
    calls++;
    if (calls > 1) return Promise.resolve(null);
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  }, true);
  const request = picker.select(new AbortController().signal);
  picker.close();
  await expect(request).rejects.toMatchObject({ code: "E-HUB-04" });
  expect(await picker.select(new AbortController().signal)).toEqual({ status: "cancelled" });
});

test("unsupported platforms refuse selection without launching a process", async () => {
  let called = false;
  const picker = createFolderPicker(async () => {
    called = true;
    return null;
  }, false);
  await expect(picker.select(new AbortController().signal)).rejects.toMatchObject({ status: 503 });
  expect(called).toBe(false);
});
