import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const input = JSON.parse(readFileSync(0, "utf8"));
let dark = false;
const listeners = [];
const answers = [];
const dom = new JSDOM(input.html, {
  runScripts: "dangerously",
  beforeParse(window) {
    window.matchMedia = () => ({
      get matches() {
        return dark;
      },
      addEventListener(_kind, listener) {
        listeners.push(listener);
      },
    });
    window.postMessage = (message) => answers.push(message);
  },
});
try {
  const snapshot = () => {
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        source: dom.window,
        data: { source: "lucid-artifact", kind: "snapshot", token: "test" },
      }),
    );
    const response = answers.findLast((message) => message.kind === "snapshot-taken");
    assert.ok(response?.html);
    return response.html;
  };
  const before = snapshot();
  dark = true;
  for (const listener of listeners) listener();
  const after = snapshot();
  assert.equal(before === after, input.equal);
  assert.ok(after.includes('value="retained"'));
  assert.ok(!after.includes("data-lucid="));
  assert.ok(after.includes('name="lucid-theme"'));
  console.log("Snapshots match the authoring contract.");
} finally {
  dom.window.close();
}
