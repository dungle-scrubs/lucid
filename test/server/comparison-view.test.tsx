import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { detectAnnotationBatch, encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import {
  comparisonMetadata,
  validateComparisonSource,
} from "../../src/protocol/comparison-note.js";
import { compareContent, readContentSource } from "../../src/protocol/content-comparison.js";
import {
  type ComparisonDraft,
  comparisonDraftText,
  draftForPassage,
  restoreComparisonDraft,
} from "../../src/server/client/comparison-draft.js";
import {
  type ComparisonPair,
  ContentComparisonView,
} from "../../src/server/client/content-comparison.js";
import { hashArtifactBytes } from "../../src/store/log.js";

const saved = (version: number, bytes: string, author = "agent") => ({
  artifactId: "doc",
  version,
  bytes,
  author,
  contentType: "text/html",
  hash: hashArtifactBytes(bytes),
});
const v1 = saved(1, "<h1>Guide</h1><p>Send the old agenda today.</p>");
const v2 = saved(2, "<h1>Guide</h1><p>Send the new agenda today.</p>", "human");
const v3 = saved(3, "<h1>Guide</h1><p>Keep the latest human additions.</p>", "human");

test("equal repeated passages remain unchanged; human provenance and subset quotes survive admission", () => {
  expect(
    compareContent("<p>Same</p><p>Same</p>", "<p>Same</p><p>Same</p>").rows.map((r) => r.kind),
  ).toEqual(["same", "same"]);
  const p = compareContent(v1.bytes, v2.bytes, undefined, [v1.author, v2.author]).sources[1]
    .passages[1];
  if (!p) throw new Error("passage missing");
  const draft = { ...draftForPassage(p, v2.version, v2.hash, 5, 19), text: "Keep this" };
  const text = comparisonDraftText(
    "doc",
    { earlier: v1, earlierVersion: 1, reviewed: v2, reviewedVersion: 2 },
    draft,
  );
  const parsed = comparisonMetadata(text ?? "");
  expect(parsed.kind).toBe("comparison");
  if (parsed.kind !== "comparison") throw new Error("metadata missing");
  expect(parsed.batch.notes[0].spots[0]?.author).toBe("human");
  expect(validateComparisonSource(parsed.batch, v2)).toBe(true);
});

test("returning a saved request to the editor preserves all source selections and files", () => {
  const spots = readContentSource(v1.bytes).passages.map(
    (p) => draftForPassage(p, 1, v1.hash).spot,
  );
  const batch = {
    artifactId: "doc",
    version: 1,
    comparison: { earlierVersion: 1, reviewedVersion: 2, reviewedHash: v2.hash },
    notes: [
      {
        note: "Both passages",
        spots,
        files: [
          {
            name: "evidence.txt",
            hash: "a".repeat(64),
            bytes: 8,
            contentType: "text/plain",
            path: "/synthetic/evidence.txt",
          },
        ],
      },
    ],
  };
  const draft = restoreComparisonDraft(
    `${encodeAnnotationBatch(batch)}\n\nAttached evidence: keep these bytes.`,
  );
  expect(draft).not.toBeNull();
  if (!draft) throw new Error("draft missing");
  expect(
    comparisonDraftText(
      "doc",
      { earlier: v1, earlierVersion: 1, reviewed: v3, reviewedVersion: 3 },
      draft,
    ),
  ).toEndWith("Attached evidence: keep these bytes.");
  expect(
    detectAnnotationBatch(
      comparisonDraftText(
        "doc",
        { earlier: v1, earlierVersion: 1, reviewed: v3, reviewedVersion: 3 },
        draft,
      ) ?? "",
    ),
  ).toMatchObject({
    ...batch,
    comparison: { earlierVersion: 1, reviewedVersion: 3, reviewedHash: v3.hash },
  });
});

test("one inline editor preserves source, focus and selection through stale arrival, review, unreadable sources and inspection", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  // React may load before a DOM exists and select its legacy input listener.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.slice(2), listener);
      },
    },
    detachEvent: {
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.slice(2), listener);
      },
    },
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const container = dom.window.document.getElementById("root") as HTMLElement;
  const root = createRoot(container);
  let pair: ComparisonPair = { earlier: v1, earlierVersion: 1, reviewed: v2, reviewedVersion: 2 };
  let latest = 2;
  let draft: ComparisonDraft | null = null;
  let sends = 0;
  const render = () =>
    root.render(
      <ContentComparisonView
        artifactId="doc"
        pair={pair}
        latest={latest}
        loading={false}
        draft={draft}
        onDraft={(next) => {
          draft = next;
          render();
        }}
        onSend={() => {
          sends++;
        }}
        locked={false}
        refusal={null}
        sent={[]}
        onReview={() => {
          pair = { ...pair, reviewed: v3, reviewedVersion: 3 };
          render();
        }}
      />,
    );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    ) as HTMLButtonElement;
  try {
    await React.act(render);
    const source = container.querySelectorAll(
      ".comparison-cell.after button",
    )[1] as HTMLButtonElement;
    await React.act(() => source.click());
    expect(container.querySelectorAll("#comparison-note")).toHaveLength(1);
    expect(dom.window.document.activeElement?.id).toBe("comparison-note");
    draft = { ...(draft as unknown as ComparisonDraft), text: "Preserve the latest additions" };
    await React.act(render);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 9);
    source.focus();
    latest = 3;
    await React.act(render);
    expect(dom.window.document.activeElement).toBe(source);
    expect(button("Send note").disabled).toBe(true);
    expect(container.textContent).toContain("still reviewing v2");
    await React.act(() => button("+ Note").click());
    expect(container.textContent).toContain("Send or cancel your current note");
    await React.act(() => button("Review latest").click());
    const retained = container.querySelector(".comparison-retained");
    expect(retained?.textContent).toContain("Your note on v2");
    const restored = retained?.querySelector("textarea") as HTMLTextAreaElement;
    expect(restored.value).toBe("Preserve the latest additions");
    expect(dom.window.document.activeElement).toBe(restored);
    expect([restored.selectionStart, restored.selectionEnd]).toEqual([3, 9]);
    expect(button("Send note").disabled).toBe(false);
    await React.act(() => button("Inspect v1").click());
    expect(container.querySelector("dialog")?.open).toBe(true);
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    await React.act(() => button("Back to comparison").click());
    expect(container.querySelector(".comparison-retained textarea")).not.toBeNull();
    pair = { ...pair, earlier: null };
    await React.act(render);
    expect(container.textContent).toContain("Earlier v1 could not be read");
    expect(container.querySelector(".comparison-retained textarea")).not.toBeNull();
    await React.act(() => button("Cancel").click());
    expect(container.querySelector("textarea")).toBeNull();
    expect(sends).toBe(0);
  } finally {
    await React.act(() => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
