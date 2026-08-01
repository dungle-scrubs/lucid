import type { CSSProperties } from "react";
import { ArtifactOutline } from "./artifact-outline.tsx";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { SurfaceUpdating } from "./Surface.tsx";
import { Button } from "./ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * Owns the chrome controls that occupy the artifact surface's top-right edge.
 * It deliberately excludes artifact-frame layout and bottom-overlay behavior.
 * The common surface owner supplies the bottom overlay's measured footprint so
 * every top-right notice shares one flow layout without duplicating geometry.
 */

/** Cancel every staged composer pick and unanswered-question pin at once. */
const CancelPicksButton = () => {
  const { cancelAllPicks } = useActions();
  const composer = useSession((state) =>
    state.pendingTargets.length > 0 ? state.pendingTargets.length : state.pendingTarget ? 1 : 0,
  );
  const pins = useSession((state) =>
    state.questions
      .filter((question) => !question.answered)
      .reduce(
        (count, question) =>
          count +
          (state.answerAnchorLists[question.id]?.length ??
            (state.answerAnchors[question.id] ? 1 : 0)),
        0,
      ),
  );
  const count = composer + pins;
  if (count === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-test="cancel-picks"
            onClick={cancelAllPicks}
            className="h-auto cursor-pointer rounded-none border-ink-500 bg-ink-850/95 px-2.5 py-1 text-[11px] font-normal text-fg-muted shadow-[0_2px_10px_rgba(0,0,0,0.35)] hover:border-rust-300/60 hover:bg-ink-850/95 hover:text-fg"
          >
            {/* lucide x */}
            <svg
              data-icon="inline-start"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
            Cancel picks ({count})
          </Button>
        }
      />
      <TooltipContent>
        Cancel every collected spot - the annotation draft and all answer pins
      </TooltipContent>
    </Tooltip>
  );
};

interface SurfaceControlsProps {
  readonly bottomOverlayHeight: number;
}

type SurfaceControlLayerStyle = CSSProperties & {
  readonly "--surface-scrollbar-safe-inset": string;
};

const SURFACE_CONTROL_EDGE_INSET_PX = 12.5;

export const SurfaceControls = (props: SurfaceControlsProps) => {
  const { bottomOverlayHeight } = props;
  const { surface } = useSessionHandle();
  const layerStyle: SurfaceControlLayerStyle = {
    "--surface-scrollbar-safe-inset": "18px",
    bottom: `calc(${bottomOverlayHeight}px + ${SURFACE_CONTROL_EDGE_INSET_PX}px)`,
    top: `${SURFACE_CONTROL_EDGE_INSET_PX}px`,
  };
  const slotStyle = {
    marginRight: "var(--surface-scrollbar-safe-inset)",
    maxWidth: "calc(100% - var(--surface-scrollbar-safe-inset))",
  };

  return (
    <div
      data-test="surface-control-layer"
      style={layerStyle}
      // The header's text metrics place the surface on a half CSS pixel. Move
      // both safe-slot edges inward by the matching half pixel so borders land
      // on whole device pixels at 1x and 2x without weakening proof clearance.
      className="pointer-events-none absolute right-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-end"
    >
      <div
        data-test="surface-control-stack"
        className="flex max-w-full shrink-0 flex-col items-end gap-2 [&>*]:pointer-events-auto"
      >
        <SurfaceUpdating />
        <CancelPicksButton />
      </div>
      <div
        ref={surface.attachOutlineSlot}
        data-test="surface-outline-slot"
        style={slotStyle}
        className="pointer-events-none mt-2 flex min-h-0 w-[240px] flex-1 flex-col items-end overflow-y-auto"
      >
        <ArtifactOutline />
      </div>
    </div>
  );
};
