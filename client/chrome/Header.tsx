import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { approveBlockedReason, unsentWork } from "./store.ts";
import { setArtifactTheme, setSidebarOpen, useShell } from "./shell.ts";
import { useTheme } from "./theme.ts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Open/close the review panel. It lives in the header, on the artifact side,
 * because that is where it stays reachable once the panel is closed and the
 * artifact fills the window. Cmd/Ctrl+B toggles the same state (the sidebar
 * owns that shortcut); this is its visible handle. Lucide `panel-left`.
 */
/**
 * Light or dark PAPER, for every open artifact at once.
 *
 * Not per-artifact and not per-tab: the artifact is a document that must render
 * the same from disk, so the preference is the tool's to hold (see the
 * lucid-design skill). The chrome does not change - only the paper does.
 */
const ThemeToggle = () => {
  const theme = useTheme((s) => s.theme);
  const dark = theme === "dark";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-test="theme-toggle"
            data-theme={theme}
            aria-pressed={dark}
            aria-label={dark ? "Light paper" : "Dark paper"}
            onClick={() => setArtifactTheme(dark ? "light" : "dark")}
            className="inline-flex flex-none cursor-pointer items-center border border-ink-400 p-[3px] text-fg-muted hover:border-accent-bright hover:text-fg"
          >
            {/* Lucide sun / moon */}
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
              {dark ? (
                <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
                </>
              )}
            </svg>
          </button>
        }
      />
      <TooltipContent>
        {dark ? "Light paper" : "Dark paper"} - applies to every open artifact
      </TooltipContent>
    </Tooltip>
  );
};

export const PanelToggle = () => {
  const open = useShell((s) => s.sidebarOpen);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-test="panel-toggle"
            aria-pressed={open}
            aria-label={open ? "Hide the review panel" : "Show the review panel"}
            onClick={() => setSidebarOpen(!open)}
            // ml-3/mr-0: grouped with the panel edge on its right, separated
            // from Approve on its left - the gap says which thing it belongs to.
            className="ml-3 mr-0 inline-flex flex-none cursor-pointer items-center border border-ink-400 p-[3px] text-fg-muted hover:border-accent-bright hover:text-fg"
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
        }
      />
      <TooltipContent>
        {open ? "Hide the review panel (⌘B)" : "Show the review panel (⌘B)"}
      </TooltipContent>
    </Tooltip>
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

/**
 * Lucide `highlighter` - focus every SENT annotation at once. Off by default:
 * delivered feedback's markup is noise on the artifact, and a card can focus
 * its own mark one at a time. The struck-through glyph carries the off state
 * without relying on hue, like the crosshair beside it.
 */
const Highlighter = ({ on }: { readonly on: boolean }) => (
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
    <path d="m9 11-6 6v3h9l3-3" />
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
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
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-test="context-ring"
            data-pct={Math.round(pct)}
            role="img"
            aria-label={`Agent context: ${Math.round(pct)}% used${tokens}`}
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
        }
      />
      <TooltipContent>{`Agent context: ${Math.round(pct)}% used${tokens}`}</TooltipContent>
    </Tooltip>
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
  const queue = useSession((s) => s.queue);
  const pendingTarget = useSession((s) => s.pendingTarget);
  const composerNote = useSession((s) => s.composerNote);
  // Selected as slices and handed to the owner, never counted here: what is
  // unsent - including a message the server never took - is the store's
  // definition, and the tooltip must refuse on exactly what the click does.
  const outbox = useSession((s) => s.outbox);
  const reason = approveBlockedReason(unsentWork({ queue, pendingTarget, composerNote, outbox }));
  const blocked = reason !== null;

  if (resolved) {
    return (
      <span data-test="resolved-bar" className="flex items-center gap-1.5">
        <span className="text-[11px] text-agent">✓ approved</span>
        <button
          type="button"
          data-test="reopen"
          onClick={() => void reopenReview()}
          className="cursor-pointer border border-ink-400 px-2.5 py-px text-[11px] font-semibold text-fg hover:bg-ink-700"
        >
          Reopen review
        </button>
      </span>
    );
  }
  return (
    <span data-test="review-bar" className="flex min-w-0 items-center gap-1.5">
      {/* No status text in the header. Why Approve is unavailable belongs to
          the thing that is unfinished - the queue bar and the outbox card in
          the panel, which already say it and can act on it - and to this
          button's own tooltip. A sentence wedged between two controls in the
          tightest row of the UI could only ever be truncated prose. */}
      <Tooltip>
        {/* The trigger is the WRAPPER, not the button. A disabled button emits
            no pointer events, so a tooltip attached to it can never open -
            which is precisely when its explanation is needed. */}
        <TooltipTrigger
          render={
            <span data-test="approve-wrap" className="inline-flex">
              {/* aria-disabled, not `disabled`. A truly disabled button emits no
                  pointer events, so clicking the primary action produced
                  NOTHING - no movement, no reason, and the explanation only on
                  hover. The queue bar and the outbox card each say what is
                  unfinished; a DRAFT annotation has neither, so the click was
                  the only surface that could say it, and it was silent.
                  aria-disabled keeps the button focusable and clickable (a
                  clickable span is not keyboard-reachable) while still
                  announcing itself as unavailable; `approveReview` already
                  refuses and says why, for this path and for ⌘⇧↵ alike. */}
              <button
                type="button"
                data-test="approve"
                aria-disabled={blocked}
                onClick={() => void approveReview()}
                className="flex cursor-pointer items-center gap-1.5 border border-sage-600 bg-sage-600 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-cream-50 hover:bg-sage-500 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-sage-600"
              >
                {/* No keycaps. They punched a busy little box into the one
                    solid control in the header, for a shortcut this button is
                    not how you learn - the tooltip and the palette carry it. */}
                Approve review
              </button>
            </span>
          }
        />
        <TooltipContent>
          {blocked
            ? `${reason} - the agent stops reading once you approve`
            : "End the review; the agent stops until re-invoked"}
        </TooltipContent>
      </Tooltip>
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
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              data-test="version"
              className="bg-ink-700 px-[9px] py-px text-[11px] tabular-nums text-steel-300"
            >
              v{version}
            </div>
          }
        />
        <TooltipContent>current artifact version</TooltipContent>
      </Tooltip>
    );
  }

  const versions = Array.from({ length: version }, (_, i) => version - i); // newest first
  return (
    <Select
      value={String(viewing ?? version)}
      onValueChange={(v) => void viewVersion(Number(v))}
      disabled={diffMode}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              data-test="version"
              className={viewing === null ? undefined : "border-amber-500 text-amber-300"}
            >
              <SelectValue>{(v: string) => `v${v}`}</SelectValue>
            </SelectTrigger>
          }
        />
        <TooltipContent>
          {viewing === null ? "Browse versions" : `Viewing v${viewing} - back to current`}
        </TooltipContent>
      </Tooltip>
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

export const Header = ({ shell = false }: { readonly shell?: boolean }) => {
  const { enterDiff, toggleTargets, toggleFocusAll } = useActions();
  const name = useSessionHandle().config.name;
  const version = useSession((s) => s.version);
  const showTargets = useSession((s) => s.showTargets);
  const focusAll = useSession((s) => s.focusAll);
  const diffMode = useSession((s) => s.diffMode);

  return (
    <header className="relative flex items-center justify-between gap-2 border-b border-ink-600 bg-chrome-surface pl-4 pr-2 py-[10px]">
      {/* min-w-0 lets a long artifact name truncate instead of shoving the
          controls out of the header; the controls themselves never shrink. */}
      <div className="min-w-0 flex-1 text-[13px] font-semibold text-fg-strong">
        Lucid review
        <small className="ml-2 font-normal text-fg-muted">{name}</small>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {version > 1 && !diffMode ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-test="enter-diff"
                  onClick={() => void enterDiff()}
                  className="cursor-pointer border border-ink-400 px-2.5 py-px text-[11px] font-semibold text-accent-bright hover:border-accent-bright hover:bg-ink-700"
                >
                  changes
                </button>
              }
            />
            <TooltipContent>Show what changed</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-test="toggle-focus-all"
                aria-pressed={focusAll}
                aria-label={focusAll ? "Unfocus all annotations" : "Focus every sent annotation"}
                onClick={toggleFocusAll}
                className={`inline-flex cursor-pointer items-center border p-[3px] ${
                  focusAll
                    ? "border-ink-400 text-accent-bright hover:border-accent-bright"
                    : "border-steel-600/60 text-steel-400 hover:border-steel-600 hover:text-steel-300"
                }`}
              >
                <Highlighter on={focusAll} />
              </button>
            }
          />
          <TooltipContent>
            {focusAll
              ? "Unfocus every annotation - each card can focus its own"
              : "Focus every sent annotation's mark at once"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-test="toggle-targets"
                aria-pressed={showTargets}
                aria-label={showTargets ? "Hide annotation targets" : "Show annotation targets"}
                onClick={toggleTargets}
                className={`inline-flex cursor-pointer items-center border p-[3px] ${
                  showTargets
                    ? "border-ink-400 text-accent-bright hover:border-accent-bright"
                    : "border-steel-600/60 text-steel-400 hover:border-steel-600 hover:text-steel-300"
                }`}
              >
                <Crosshair on={showTargets} />
              </button>
            }
          />
          <TooltipContent>
            {showTargets
              ? "Hide annotation targets - read the artifact without marks (⌘.)"
              : "Show annotation targets (⌘.)"}
          </TooltipContent>
        </Tooltip>
        <ContextRing />
        <VersionPicker />
        <ApproveControls />
        {/* Beside the panel it controls: the panel lives on the RIGHT (D9),
            so its toggle holds the header's right edge, not the left. Under the
            shell it moves to the tab row instead, where it lines up with the
            tabs and with the top of the drawer it opens. */}
        <ThemeToggle />
        {shell ? null : <PanelToggle />}
      </div>
    </header>
  );
};
