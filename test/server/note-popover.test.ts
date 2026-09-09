import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

test("dragging a note moves it immediately without rendering or replacing its inputs", () => {
  const result = spawnSync(process.execPath, ["test/helpers/note-popover.tsx"], {
    encoding: "utf8",
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
});
