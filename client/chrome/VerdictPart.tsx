import type { DataMessagePartComponent } from "@assistant-ui/react";

export interface VerdictData {
  /** ISO time of the approve/reopen, for the entry's own label. */
  readonly at: string;
  /** True for an approval, false for a reopening. */
  readonly resolved: boolean;
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
  const time = new Date(data.at);
  const label = data.resolved ? "Review approved" : "Review reopened";
  return (
    <div
      data-test="verdict"
      data-resolved={data.resolved ? "true" : "false"}
      className="flex items-center gap-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-fg-faint"
    >
      <span aria-hidden className="h-px flex-1 bg-ink-600" />
      <span className={data.resolved ? "text-agent" : "text-fg-muted"}>{label}</span>
      <time dateTime={data.at} className="font-normal tracking-normal">
        {Number.isNaN(time.getTime())
          ? ""
          : time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </time>
      <span aria-hidden className="h-px flex-1 bg-ink-600" />
    </div>
  );
};
