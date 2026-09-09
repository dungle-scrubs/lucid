import type * as React from "react";
import { Tooltip } from "./tooltip.js";

const levels = [
  {
    description: "Original version, or the same words found again.",
    filled: 3,
    label: "Still exact",
  },
  {
    description: "Wording changed; a similar passage was found.",
    filled: 2,
    label: "Reworded",
  },
  {
    description: "Matched by position or structure. Check the target.",
    filled: 1,
    label: "A guess",
  },
  {
    description: "Passage not found. Your note stays in chat.",
    filled: 0,
    label: "Lost",
  },
] as const;

export function NoteAnchorHelp(props: { readonly children: React.ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger className="note-anchor-trigger" aria-label="Explain note match levels">
        {props.children}
      </Tooltip.Trigger>
      <Tooltip.Content className="note-anchor-help" align="start">
        <h3>How well does your note match?</h3>
        <dl className="note-anchor-levels">
          {levels.map(({ description, filled, label }) => (
            <div key={filled}>
              <dt>
                {filled === 0 ? (
                  <span className="bands lost" aria-hidden="true" />
                ) : (
                  <span className="bands" aria-hidden="true">
                    {[1, 2, 3].map((n) => (
                      <span key={n} className={n <= filled ? "b on" : "b"} />
                    ))}
                  </span>
                )}
                <span>
                  {filled} - {label}
                </span>
              </dt>
              <dd>{description}</dd>
            </div>
          ))}
          <div>
            <dt>
              <span className="bands later" aria-hidden="true" />
              <span>Not on this version</span>
            </dt>
            <dd>On another version; outside the 0-3 scale.</dd>
          </div>
        </dl>
        <p className="note-anchor-help-footer">
          Match strength only. Does not mean the note is addressed.
        </p>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}
