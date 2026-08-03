import type { DataMessagePartComponent } from "@assistant-ui/react";

export interface ClearedData {
  /** ISO time of the clear. */
  readonly at: string;
  /** Entries the clear hid. All of them are still in the log. */
  readonly hiddenCount: number;
}

/**
 * "The record starts again here."
 *
 * A clear empties the panel, and an emptied panel that says nothing is a
 * viewer you cannot reason about - the same silence that made an approval
 * nobody made so hard to account for. So the boundary is an entry like any
 * other, and it carries the count of what it is holding back: enough to know
 * the earlier work exists and was not destroyed, without rebuilding it on
 * screen.
 */
export const ClearedPart: DataMessagePartComponent<ClearedData> = ({ data }) => {
  const time = new Date(data.at);
  const kept =
    data.hiddenCount > 0
      ? `${data.hiddenCount} earlier ${data.hiddenCount === 1 ? "entry" : "entries"} kept in the log`
      : "nothing to keep";
  return (
    <div
      data-test="cleared"
      data-hidden-count={data.hiddenCount}
      className="flex flex-col items-center gap-0.5 py-0.5 text-[10px] text-fg-faint"
    >
      <div className="flex w-full items-center gap-2">
        <span aria-hidden className="h-px flex-1 bg-ink-600" />
        <span className="font-semibold uppercase tracking-[0.12em]">Chat cleared</span>
        <time dateTime={data.at} className="tracking-normal">
          {Number.isNaN(time.getTime())
            ? ""
            : time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </time>
        <span aria-hidden className="h-px flex-1 bg-ink-600" />
      </div>
      <span>{kept}</span>
    </div>
  );
};
