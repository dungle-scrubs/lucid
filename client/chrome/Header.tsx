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

export const Header = () => {
  const version = useLucid((s) => s.version);
  const showTargets = useLucid((s) => s.showTargets);

  const toggleTargets = (): void => {
    const next = !showTargets;
    set({ showTargets: next });
    persistShowTargets(next);
    pushHighlights();
  };

  return (
    <header className="flex items-center justify-between gap-2 border-b border-ink-600 px-4 py-[10px]">
      <div className="text-[13px] font-semibold text-fg-strong">
        Lucid review
        <small className="ml-2 font-normal text-fg-muted">{config().name}</small>
      </div>
      <div className="flex items-center gap-1.5">
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
          className="rounded-full bg-ink-700 px-[9px] py-px text-[11px] tabular-nums text-steel-300"
          title="current artifact version"
        >
          v{version}
        </div>
      </div>
    </header>
  );
};
