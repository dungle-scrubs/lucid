/**
 * The paint step: a TuiView (the pure projection) to the array of terminal
 * lines, and a thin writer that clears and paints them. Deliberately
 * trivial - all the logic lives in buildView, so the only thing NOT
 * covered by fixture tests is the tty escape plumbing, which the M6.1
 * live-pty pass verifies (DF-TUI). NOT responsible for input reading (the
 * driver owns the keypress loop); this only renders.
 */

import type { TuiView } from "./view.js";

/** The view as plain lines, top to bottom: conversation, then a rule,
 * then the status/rung line, then the input box. Pure - the live smoke
 * verifies these lines actually reach a terminal. */
export const renderLines = (view: TuiView): readonly string[] => {
  const body = view.lines.map((line) => {
    if (line.kind === "agent") return line.aborted ? `  ⌁ ${line.text}` : `  ${line.text}`;
    return `  ${line.mark ?? "…"} ${line.text}`;
  });
  return [...body, "─".repeat(40), `${view.status} ${view.rung}`, view.inputBox];
};

/** Clear the screen and paint. The one impure line; the write target is
 * injected so a scripted run can capture it. */
export const paint = (
  view: TuiView,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void => {
  write("\x1b[2J\x1b[H");
  write(`${renderLines(view).join("\n")}\n`);
};
