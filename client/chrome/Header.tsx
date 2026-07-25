import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { setSidebarOpen, useShell } from "./shell.ts";
import { Kbd } from "./ui/kbd.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

/**
 * Open/close the review panel. It lives in the header, on the artifact side,
 * because that is where it stays reachable once the panel is closed and the
 * artifact fills the window. Cmd/Ctrl+B toggles the same state (the sidebar
 * owns that shortcut); this is its visible handle. Lucide `panel-left`.
 */
const PanelToggle = () => {
  const open = useShell((s) => s.sidebarOpen);
  return (
    <button
      type="button"
      data-test="panel-toggle"
      aria-pressed={open}
      aria-label={open ? "Hide the review panel" : "Show the review panel"}
      title={open ? "Hide the review panel (⌘B)" : "Show the review panel (⌘B)"}
      onClick={() => setSidebarOpen(!open)}
      className="inline-flex flex-none cursor-pointer items-center rounded-md border border-ink-400 p-[3px] text-fg-muted hover:border-accent-bright hover:text-fg"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect width="18" height="18" x="3" y="3" rx="2" />
        <path d="M15 3v18" />
      </svg>
    </button>
  );
};

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

const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * The attending agent's context-window usage, as a small ring. Calm steel while
 * there's headroom, amber past 60%, rust near the limit - so it only draws the
 * eye as the window fills. Presence, self-reported by the harness's statusline:
 * absent (no ring) whenever nothing has been reported, e.g. under a harness that
 * does not post it. Sage never appears here - that hue is the agent's voice.
 */
const ContextRing = () => {
  const usage = useSession((s) => s.contextUsage);
  if (!usage) return null;
  const pct = Math.max(0, Math.min(100, usage.pct));
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const color =
    pct >= 85
      ? "var(--color-danger)"
      : pct >= 60
        ? "var(--color-amber-400)"
        : "var(--color-steel-400)";
  const tokens =
    usage.used !== undefined && usage.total !== undefined
      ? ` · ${fmtTokens(usage.used)}/${fmtTokens(usage.total)} tokens`
      : "";
  return (
    <span
      data-test="context-ring"
      data-pct={Math.round(pct)}
      role="img"
      aria-label={`Agent context: ${Math.round(pct)}% used${tokens}`}
      title={`Agent context: ${Math.round(pct)}% used${tokens}`}
      className="inline-flex flex-none items-center"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke="var(--color-steel-600)"
          strokeOpacity="0.5"
          strokeWidth="2.5"
        />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform="rotate(-90 9 9)"
        />
      </svg>
    </span>
  );
};

/**
 * Approve lives here, not under the composer: it ends the review - a session
 * decision alongside the version, the change view and the target toggle - and
 * it refuses while anything is unsent. Approving appends `review_resolved`,
 * which ends the agent's involvement (D-064); work sent after it lands behind a
 * stop the agent has already acted on and is never read.
 */
const ApproveControls = () => {
  const { approveReview, reopenReview } = useActions();
  const resolved = useSession((s) => s.reviewResolved);
  const queueLen = useSession((s) => s.queue.length);
  const pendingTarget = useSession((s) => s.pendingTarget);
  const composerNote = useSession((s) => s.composerNote);
  // A message the server never took is unsent work too - approving over it
  // would strand it behind a stop the agent has already acted on.
  const undelivered = useSession((s) => s.outbox.length);
  const hasDraft = pendingTarget !== null && composerNote.trim().length > 0;
  const blocked = queueLen > 0 || hasDraft || undelivered > 0;
  const reason =
    undelivered > 0
      ? `Retry or discard your ${undelivered} undelivered message${undelivered > 1 ? "s" : ""} first`
      : queueLen > 0
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
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-sage-600 bg-sage-600 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-cream-50 hover:bg-sage-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Approve review
        {/* Keycaps borrow the label's cream so they don't punch a dark hole in
            the sage fill. Kept compact - the header is a tight row. */}
        <Kbd className="border-cream-50/30 bg-cream-50/10 text-cream-50">⌘⇧↵</Kbd>
      </button>
    </span>
  );
};

/**
 * The version badge, made browsable. One version, nothing to browse: it stays a
 * plain badge. Otherwise it opens a picker that loads any prior version into the
 * surface read-only (viewVersion); choosing the current one drops back to live.
 * Disabled inside the change view, which owns its own version selector.
 */
const VersionPicker = () => {
  const { viewVersion } = useActions();
  const version = useSession((s) => s.version);
  const viewing = useSession((s) => s.viewingVersion);
  const diffMode = useSession((s) => s.diffMode);

  if (version <= 1) {
    return (
      <div
        data-test="version"
        className="rounded-full bg-ink-700 px-[9px] py-px text-[11px] tabular-nums text-steel-300"
        title="current artifact version"
      >
        v{version}
      </div>
    );
  }

  const versions = Array.from({ length: version }, (_, i) => version - i); // newest first
  return (
    <Select
      value={String(viewing ?? version)}
      onValueChange={(v) => void viewVersion(Number(v))}
      disabled={diffMode}
    >
      <SelectTrigger
        data-test="version"
        title={viewing === null ? "Browse versions" : `Viewing v${viewing} - back to current`}
        className={viewing === null ? undefined : "border-amber-500 text-amber-300"}
      >
        <SelectValue>{(v: string) => `v${v}`}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {versions.map((v) => (
          <SelectItem key={v} value={String(v)}>
            v{v}
            {v === version ? " · current" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

export const Header = () => {
  const { enterDiff, toggleTargets } = useActions();
  const name = useSessionHandle().config.name;
  const version = useSession((s) => s.version);
  const showTargets = useSession((s) => s.showTargets);
  const diffMode = useSession((s) => s.diffMode);
  const live = useSession((s) => s.live);

  return (
    <header className="relative flex items-center justify-between gap-2 border-b border-ink-600 px-4 py-[10px]">
      {/* min-w-0 lets a long artifact name truncate instead of shoving the
          controls out of the header; the controls themselves never shrink. */}
      <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg-strong">
        Lucid review
        <small className="ml-2 font-normal text-fg-muted">{name}</small>
      </div>
      {live ? null : (
        // Connection status sits in the true centre of the bar, independent of
        // how wide the controls on either side grow. Self-clearing: EventSource
        // is already retrying, so this states what is happening rather than
        // asking the human to do anything.
        <span
          data-test="reconnecting"
          title="The live connection dropped; retrying"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-700 px-[9px] py-px text-[11px] text-steel-400"
        >
          reconnecting…
        </span>
      )}
      <div className="flex flex-none items-center gap-1.5">
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
              ? "Hide annotation targets - read the artifact without marks (⌘.)"
              : "Show annotation targets (⌘.)"
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
        <ContextRing />
        <VersionPicker />
        <ApproveControls />
        {/* Beside the panel it controls: the panel lives on the RIGHT (D9),
            so its toggle holds the header's right edge, not the left. */}
        <PanelToggle />
      </div>
    </header>
  );
};
