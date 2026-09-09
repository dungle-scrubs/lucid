import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { instrumentArtifact } from "../../src/server/client/instrument.js";
import { useDocumentMode } from "../../src/server/client/use-document-mode.js";

const InitialMode = () => {
  const state = useDocumentMode();
  return createElement(
    "output",
    { "data-held": state.held, "data-touch": state.touchAnnotate },
    state.mode,
  );
};

test("the parent and fresh document both begin in edit mode without a latched modifier", () => {
  expect(renderToStaticMarkup(createElement(InitialMode))).toBe(
    '<output data-held="false" data-touch="false">edit</output>',
  );
  expect(instrumentArtifact("<body><p>Text</p></body>", "d", 1)).toContain('var mode = "edit"');
});
