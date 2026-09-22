/**
 * What the closed-chat corner shows, in the lower-right spot the send
 * button vacates.
 *
 * With chat closed and notes queued, the corner holds the send button.
 * Once the queue empties the button leaves - but the work it started is
 * still running, and the working line stays inside the hidden panel. So
 * the same corner then holds the same report chat shows above the
 * composer, until nothing is in flight anymore.
 *
 * A native-owned record adds a second resident: the connection card that
 * otherwise lives at the top of hidden chat ("Current connection" with
 * its session identity and retry control) is unreachable with the panel
 * closed, so its one-line summary and its action dock in the same corner.
 *
 * Pure decision table, tested beside it. The send button's own disabled
 * guards stay at the call site; this answers only which corner element
 * renders.
 */

export type ClosedChatCorner = "send" | "status" | "connection" | "none";

export const closedChatCorner = (state: {
  /** The panel is open, so chat shows everything itself. */
  readonly panelOpen: boolean;
  /** Notes queued for the version on screen. */
  readonly queuedNotes: number;
  /** Nothing can move: the token is dead, the record is damaged, or the
   * page has no token yet. */
  readonly dead: boolean;
  readonly damaged: boolean;
  readonly connected: boolean;
  /** A send is on its way to the record. */
  readonly sending: boolean;
  readonly submissionBusy: boolean;
  /** `report.busy` from `describeActivity`: a turn, an in-flight input, a
   * waiting one, a pending approval, or a saved input with no agent. */
  readonly workBusy: boolean;
  /** The record is native-owned: the connection card owns activity
   * announcements on this record, and `report` stays quiet for it. */
  readonly nativeConnectionRequired: boolean;
}): ClosedChatCorner => {
  if (state.panelOpen) return "none";
  if (state.dead || state.damaged || !state.connected) return "none";
  // The connection owns the corner while it owns the record: its card is
  // the only status, and it outranks an empty queue's send button. A
  // queued batch still sends first - the notes are already written and
  // the button is their way out.
  if (state.nativeConnectionRequired && state.queuedNotes === 0) return "connection";
  if (state.queuedNotes > 0) return "send";
  if (state.sending || state.submissionBusy || state.workBusy) return "status";
  return "none";
};
