import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// Run the actual injected callbacks with explicit trusted input. The live
// browser check covers native event trust, default navigation, and text drag.
const listeners = new Map();
const dom = new JSDOM(readFileSync(0, "utf8"), {
  beforeParse(window) {
    const add = window.document.addEventListener.bind(window.document);
    window.document.addEventListener = (type, listener, options) => {
      if (listener) {
        const registered = listeners.get(type) ?? [];
        registered.push(listener);
        listeners.set(type, registered);
      }
      add(type, listener, options);
    };
  },
  runScripts: "dangerously",
});
const element = (id) => {
  const found = dom.window.document.getElementById(id);
  assert.ok(found);
  return found;
};
const fire = (type, id, modifiers = {}) => {
  const target = element(id);
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...modifiers });
  const trusted = new Proxy(event, {
    get(event, key) {
      if (key === "isTrusted") return true;
      if (key === "target") return target;
      const value = Reflect.get(event, key, event);
      return typeof value === "function" ? value.bind(event) : value;
    },
  });
  assert.ok(listeners.has(type));
  for (const listener of listeners.get(type)) {
    if (typeof listener === "function") listener.call(dom.window.document, trusted);
    else listener.handleEvent(trusted);
  }
  return event;
};
try {
  // These cases exercise latched annotation, regardless of the initial mode.
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: { source: "lucid-artifact", kind: "mode", mode: "annotate" },
      source: dom.window,
    }),
  );
  switch (process.argv[2]) {
    case "link":
    case "label":
      for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }]) {
        assert.equal(fire("mousedown", process.argv[2], modifiers).defaultPrevented, false);
        assert.equal(fire("click", process.argv[2], modifiers).defaultPrevented, false);
        assert.equal(dom.window.document.querySelector(".lucid-selected"), null);
      }
      break;
    case "hover":
      fire("mouseover", "prose");
      assert.ok(element("prose").classList.contains("lucid-hover"));
      fire("mouseover", "label");
      assert.equal(dom.window.document.querySelector(".lucid-hover"), null);
      assert.equal(dom.window.document.querySelector(".lucid-text-cursor"), null);
      break;
    case "selection":
      fire("click", "prose");
      fire("click", "label");
      assert.ok(element("prose").classList.contains("lucid-selected"));
      assert.equal(element("label").classList.contains("lucid-selected"), false);
      break;
    case "controls":
      assert.equal(fire("mousedown", "control").defaultPrevented, true);
      for (const id of ["control", "placeholder"]) {
        assert.equal(fire("click", id).defaultPrevented, true);
        assert.ok(element(id).classList.contains("lucid-selected"));
      }
      break;
    default:
      assert.fail("Unknown scenario");
  }
} finally {
  dom.window.close();
}
