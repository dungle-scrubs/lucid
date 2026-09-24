/** Spans of one stripped agent message. Pure render over resolved data -
 * no contexts - so tests cover the production component directly. */
import * as React from "react";
import type { ChatLabelPart } from "./chat-references.js";

export const ChatSpans = ({
  parts,
  lookup,
  onGo,
}: {
  parts: readonly ChatLabelPart[];
  lookup: (label: string) => string | null;
  onGo: ((elementId: string) => void) | null;
}): React.ReactElement => (
  <p style={{ whiteSpace: "pre-line" }}>
    {parts.map((part) => {
      if (part.kind === "text")
        return <React.Fragment key={`t${part.at}`}>{part.text}</React.Fragment>;
      const target = lookup(part.label);
      if (target === null || onGo === null)
        return <React.Fragment key={`l${part.at}`}>[{part.label}]</React.Fragment>;
      const go = onGo;
      return (
        <button
          key={`l${part.at}`}
          type="button"
          className="chat-ref"
          title={`Go to ${part.label} in the document`}
          aria-label={`Go to ${part.label} in the document`}
          onClick={() => go(target)}
        >
          {part.label}
        </button>
      );
    })}
  </p>
);
