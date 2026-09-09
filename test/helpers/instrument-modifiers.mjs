import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// Run the shipped frame callbacks. Browser verification separately covers
// trusted input dispatch, native text ranges and focus crossing the iframe.
const listeners = new Map();
const dom = new JSDOM(readFileSync(0, "utf8"), {
  beforeParse(window) {
    const add = window.document.addEventListener.bind(window.document);
    window.document.addEventListener = (type, listener, options) => {
      const group = listeners.get(type) ?? [];
      group.push(listener);
      listeners.set(type, group);
      add(type, listener, options);
    };
  },
  runScripts: "dangerously",
});
const { document } = dom.window;
const first = document.getElementById("first");
const second = document.getElementById("second");
const fire = (type, target, flags = {}, trusted = true) => {
  const event = {
    altKey: false,
    ctrlKey: false,
    getModifierState: () => false,
    isTrusted: trusted,
    key: "Alt",
    metaKey: false,
    preventDefault() {},
    target,
    ...flags,
  };
  for (const listener of listeners.get(type) ?? []) listener.call(document, event);
};
const click = (target, flags) => {
  fire("mousedown", target, flags);
  fire("mouseup", target, flags);
  fire("click", target, flags);
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 1));
const mode = (value, readOnly = false) =>
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { source: "lucid-artifact", kind: "mode", mode: value, readOnly },
      source: dom.window,
    }),
  );
try {
  assert.equal(first.contentEditable, undefined); // jsdom exposes the attribute only.
  assert.equal(first.getAttribute("contenteditable"), "true");
  click(first, {});
  assert.equal(document.querySelectorAll(".lucid-selected").length, 0);
  fire("keydown", first, { altKey: true }, false);
  assert.equal(first.getAttribute("contenteditable"), "true");
  fire("keydown", first, { altKey: true });
  assert.equal(first.hasAttribute("contenteditable"), false);
  click(first, { altKey: true });
  await flush();
  fire("keyup", first);
  assert.equal(first.getAttribute("contenteditable"), "true");
  assert.ok(first.classList.contains("lucid-selected"));
  fire("keydown", first, { altKey: true });
  dom.window.dispatchEvent(new dom.window.Event("blur"));
  assert.equal(first.getAttribute("contenteditable"), "true");
  assert.ok(first.classList.contains("lucid-selected"));
  fire("keydown", first, { altKey: true, getModifierState: (key) => key === "AltGraph" });
  assert.equal(first.getAttribute("contenteditable"), "true");
  click(second, { altKey: true, metaKey: true });
  await flush();
  assert.equal(document.querySelectorAll(".lucid-selected").length, 2);
  click(first, { altKey: true, metaKey: true });
  await flush();
  assert.equal(document.querySelectorAll(".lucid-selected").length, 1);
  assert.ok(second.classList.contains("lucid-selected"));
  fire("keyup", second);
  assert.ok(second.classList.contains("lucid-selected"));
  // A key released during a pointer gesture cannot turn its click into an edit.
  fire("mousedown", first, { altKey: true });
  fire("keyup", first);
  assert.equal(first.hasAttribute("contenteditable"), false);
  fire("mouseup", first);
  fire("click", first);
  await flush();
  assert.equal(first.getAttribute("contenteditable"), "true");
  assert.ok(first.classList.contains("lucid-selected"));
  mode("edit", true);
  assert.equal(document.querySelectorAll(".lucid-selected").length, 0);
  click(first, { altKey: true });
  assert.equal(document.querySelectorAll(".lucid-selected").length, 0);
  assert.equal(first.hasAttribute("contenteditable"), false);
  mode("annotate");
  click(first, {});
  await flush();
  assert.ok(first.classList.contains("lucid-selected"));
  assert.equal(first.hasAttribute("contenteditable"), false);
  mode("edit");
  assert.equal(first.getAttribute("contenteditable"), "true");
  assert.ok(first.classList.contains("lucid-selected"));
} finally {
  dom.window.close();
}
