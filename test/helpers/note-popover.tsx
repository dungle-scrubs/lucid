import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
let observers = 0;
const activeObservers = new Set<Observer>();
class Observer {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers++;
    activeObservers.add(this);
  }
  disconnect() {
    activeObservers.delete(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve() {}
}
for (const key of [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "NodeFilter",
  "HTMLInputElement",
  "MutationObserver",
  "CustomEvent",
  "DOMRect",
] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? dom.window : dom.window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: Observer,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
});
let boxWidth = 360;
dom.window.HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(100, 100, boxWidth, 180);
dom.window.HTMLElement.prototype.setPointerCapture = () => {};
dom.window.HTMLElement.prototype.releasePointerCapture = () => {};
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { NotePopover } = await import("../../src/server/client/note-popover.js");
const root = createRoot(document.getElementById("root") as HTMLElement);
let commits = 0;
const render = (open: boolean) =>
  root.render(
    <React.Profiler id="note" onRender={() => commits++}>
      <NotePopover
        held={false}
        label="1 selected"
        onCancel={() => {}}
        onFocus={() => {}}
        rect={open ? { x: 100, y: 50, width: 200, height: 30 } : null}
      >
        <textarea defaultValue="Keep this draft" />
        <input type="file" />
      </NotePopover>
    </React.Profiler>,
  );
try {
  await React.act(async () => {
    render(true);
  });
  const note = document.querySelector(".note-pop") as HTMLElement;
  const handle = document.querySelector(".note-pop-drag") as HTMLElement;
  const textarea = note.querySelector("textarea") as HTMLTextAreaElement;
  const file = note.querySelector("input") as HTMLInputElement;
  textarea.focus();
  textarea.setSelectionRange(2, 6);
  const pointer = (type: string, x: number, y: number) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    handle.dispatchEvent(event);
  };
  await React.act(async () => {
    pointer("pointerdown", 120, 120);
  });
  const before = { commits, observers };
  await React.act(async () => {
    for (let x = 140; x <= 240; x += 20) pointer("pointermove", x, 160);
  });
  assert.equal(commits, before.commits, "Pointer movement must not trigger React commits");
  assert.equal(observers, before.observers, "Pointer movement must not replace resize observers");
  assert.equal(note.dataset.detached, "true");
  assert.equal(note.style.getPropertyValue("--note-x"), "220px");
  assert.equal(note.style.getPropertyValue("--note-y"), "140px");
  assert.equal(note.querySelector("textarea"), textarea);
  assert.equal(note.querySelector("input"), file);
  assert.equal(textarea.value, "Keep this draft");
  assert.equal(document.activeElement, textarea);
  assert.equal(textarea.selectionStart, 2);
  boxWidth = 900;
  await React.act(async () => {
    for (const observer of activeObservers) {
      if (observer.targets.has(note)) observer.callback([], observer as unknown as ResizeObserver);
    }
  });
  assert.equal(
    note.style.getPropertyValue("--note-x"),
    "112px",
    "Content resize keeps the note on screen",
  );
  boxWidth = 360;
  await React.act(async () => {
    pointer("pointerup", 240, 160);
  });
  assert.equal(note.dataset.dragging, "false");
  await React.act(async () => {
    handle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
  });
  assert.equal(note.dataset.detached, "false");
  await React.act(async () => {
    render(false);
  });
  await React.act(async () => {
    render(true);
  });
  assert.notEqual(document.querySelector(".note-pop")?.getAttribute("data-detached"), "true");
} finally {
  await React.act(async () => {
    root.unmount();
  });
  dom.window.close();
}
