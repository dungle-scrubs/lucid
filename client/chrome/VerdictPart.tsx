import type { DataMessagePartComponent } from "@assistant-ui/react";
import { useSession } from "./context.tsx";

export interface VerdictData {
  /** ISO time of the approve/reopen, for the entry's own label. */
  readonly at: string;
  /** True for an approval, false for a reopening. */
  readonly resolved: boolean;
  /** The log seq, so the entry can tell whether it is the CURRENT verdict. */
  readonly seq: number;
}

/**
 * "The review was settled here" - a rule across the record at the moment it
 * happened.
 *
 * Approving and reopening used to be state and nothing else: the header showed
 * the current verdict and the transcript showed neither. An approval therefore
 * left no trace anywhere (a review that ended without the reviewer doing it had
 * nothing to point at), and a reopening surfaced only as a notice pinned under
 * the composer - below the messages that came after it, which reads as though
 * the reopening happened last.
 *
 * Deliberately quiet: it is punctuation between turns, not a turn.
 */
export const VerdictPart: DataMessagePartComponent<VerdictData> = ({ data }) => {
  const listening = useSession((s) => s.agentsListening);
  const newestSeq = useSession((s) => s.verdicts.at(-1)?.seq ?? 0);
  const time = new Date(data.at);
  const label = data.resolved ? "Review approved" : "Review reopened";
  // Approval releases the agent, so a reopening with nobody listening means
  // anything written now sits recorded until one checks back in. It belongs
  // HERE rather than in a notice pinned to the bottom of the thread, where it
  // outlived its moment and rendered under the messages that followed it. Only
  // on the current verdict, and read live - a historical entry must not claim
  // anything about who is listening now.
  const recordOnly = !data.resolved && data.seq === newestSeq && listening === 0;
  return (
    <div
      data-test="verdict"
      data-resolved={data.resolved ? "true" : "false"}
      className="flex flex-col items-center gap-0.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-faint"
    >
      <div className="flex w-full items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-ink-600" />
        <span className={data.resolved ? "text-agent" : "text-fg-muted"}>{label}</span>
        <time dateTime={data.at} className="font-normal tracking-normal">
          {Number.isNaN(time.getTime())
            ? ""
            : time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </time>
        <span aria-hidden className="h-px flex-1 bg-ink-600" />
      </div>
      {recordOnly ? (
        <span data-test="verdict-record-only" className="tracking-normal normal-case">
          no agent is listening right now - feedback is recorded and delivered when one checks in
        </span>
      ) : null}
    </div>
  );
};
