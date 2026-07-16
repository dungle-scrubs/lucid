import { approveReview, enterDiff, reopenReview } from "./actions.ts";
import { persistShowTargets, set, useLucid } from "./store.ts";
import type { Config } from "./types.ts";
import { pushHighlights } from "./Chrome.tsx";

const config = (): Config => (window as unknown as { __LUCID__: Config }).__LUCID__;

/**
 * Lucide `crosshair` - the surface's targeting affordance. Brass while the
 * marks are on, steel while the surface should recede; the struck-through glyph
 * carries the same state without relying on hue.
 */
const Crosshair = ({ on }: { readonly on: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="22" x2="18" y1="12" y2="12" />
    <line x1="6" x2="2" y1="12" y2="12" />
    <line x1="12" x2="12" y1="6" y2="2" />
    <line x1="12" x2="12" y1="22" y2="18" />
    {on ? null : <line x1="4.2" x2="19.8" y1="4.2" y2="19.8" />}
  </svg>
);

/**
 * Approve lives here, not under the composer: it ends the review - a session
 * decision alongside the version, the change view and the target toggle - and
 * it refuses while anything is unsent. Approving appends `review_resolved`,
 * which ends the agent's involvement (D-064); work sent after it lands behind a
 * stop the agent has already acted on and is never read.
 */
const ApproveControls = () => {
  const resolved = useLucid((s) => s.reviewResolved);
  const queueLen = useLucid((s) => s.queue.length);
  const pendingTarget = useLucid((s) => s.pendingTarget);
  const composerNote = useLucid((s) => s.composerNote);
  const hasDraft = pendingTarget !== null && composerNote.trim().length > 0;
  const blocked = queueLen > 0 || hasDraft;
  const reason =
    queueLen > 0
      ? `Send or remove your ${queueLen} queued annotation${queueLen > 1 ? "s" : ""} first`
      : "Queue or discard your draft annotation first";

  if (resolved) {
    return (
      <span data-test="resolved-bar" className="flex items-center gap-1.5">
        <span className="text-[11px] text-agent">✓ approved</span>
        <button
          type="button"
          data-test="reopen"
          onClick={() => void reopenReview()}
          className="cursor-pointer rounded-full border border-ink-400 px-2.5 py-px text-[11px] font-semibold text-fg hover:bg-ink-700"
        >
          Reopen review
        </button>
      </span>
    );
  }
  return (
    <span data-test="review-bar" className="flex min-w-0 items-center gap-1.5">
      {blocked ? (
        // Amber: the human's own unsent work, not an error. Truncates on a
        // narrow surface; the button's title always carries the full reason.
        <span className="min-w-0 max-w-[280px] truncate text-[11px] text-user">{reason}</span>
      ) : null}
      <button
        type="button"
        data-test="approve"
        disabled={blocked}
        title={
          blocked
            ? `${reason} - the agent stops reading once you approve`
            : "End the review; the agent stops until re-invoked"
        }
        onClick={() => void approveReview()}
        className="cursor-pointer rounded-md border border-sage-600 bg-sage-600 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-cream-50 hover:bg-sage-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Approve review
      </button>
    </span>
  );
};

export const Header = () => {
  const version = useLucid((s) => s.version);
  const showTargets = useLucid((s) => s.showTargets);
  const diffMode = useLucid((s) => s.diffMode);
  const live = useLucid((s) => s.live);

  const toggleTargets = (): void => {
    const next = !showTargets;
    set({ showTargets: next });
    persistShowTargets(next);
    pushHighlights();
  };

  return (
    <header className="flex items-center justify-between gap-2 border-b border-ink-600 px-4 py-[10px]">
      {/* min-w-0 lets a long artifact name truncate instead of shoving the
          controls out of the header; the controls themselves never shrink. */}
      <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg-strong">
        Lucid review
        <small className="ml-2 font-normal text-fg-muted">{config().name}</small>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {live ? null : (
          // Self-clearing: EventSource is already retrying, so this states what
          // is happening rather than asking the human to do anything.
          <span
            data-test="reconnecting"
            title="The live connection dropped; retrying"
            className="rounded-full bg-ink-700 px-[9px] py-px text-[11px] text-steel-400"
          >
            reconnecting…
          </span>
        )}
        {version > 1 && !diffMode ? (
          <button
            type="button"
            data-test="enter-diff"
            title="Show what changed"
            onClick={() => void enterDiff()}
            className="cursor-pointer rounded-full border border-ink-400 px-2.5 py-px text-[11px] font-semibold text-accent-bright hover:border-accent-bright hover:bg-ink-700"
          >
            changes
          </button>
        ) : null}
        <button
          type="button"
          data-test="toggle-targets"
          aria-pressed={showTargets}
          aria-label={showTargets ? "Hide annotation targets" : "Show annotation targets"}
          title={
            showTargets
              ? "Hide annotation targets - read the artifact without marks"
              : "Show annotation targets"
          }
          onClick={toggleTargets}
          className={`inline-flex cursor-pointer items-center rounded-full border p-[3px] ${
            showTargets
              ? "border-ink-400 text-accent-bright hover:border-accent-bright"
              : "border-steel-600/60 text-steel-400 hover:border-steel-600 hover:text-steel-300"
          }`}
        >
          <Crosshair on={showTargets} />
        </button>
        <div
          data-test="version"
          className="rounded-full bg-ink-700 px-[9px] py-px text-[11px] tabular-nums text-steel-300"
          title="current artifact version"
        >
          v{version}
        </div>
        <ApproveControls />
      </div>
    </header>
  );
};
