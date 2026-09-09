import * as Popover from "@radix-ui/react-popover";
import * as React from "react";

interface Position {
  readonly x: number;
  readonly y: number;
}

interface NotePopoverProps {
  readonly children: React.ReactNode;
  readonly held: boolean;
  readonly label: string;
  readonly onCancel: () => void;
  readonly onFocus: () => void;
  readonly rect: (Position & { readonly height: number; readonly width: number }) | null;
}

/** The note stays mounted when moved, so its draft, focus and files survive. */
export function NotePopover(props: NotePopoverProps) {
  const { children, held, label, onCancel, onFocus, rect } = props;
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  // Drag coordinates belong to the DOM, not React's rendering/placement cycle.
  const position = React.useRef<Position | null>(null);
  const drag = React.useRef<{ readonly id: number; readonly offset: Position } | null>(null);
  const open = rect !== null;

  const move = React.useCallback(
    (next: Position): void => {
      const node = content;
      if (!node) return;
      node.dataset.detached = "true";
      const box = node.getBoundingClientRect();
      const fitted = {
        x: Math.max(12, Math.min(next.x, window.innerWidth - box.width - 12)),
        y: Math.max(12, Math.min(next.y, window.innerHeight - box.height - 12)),
      };
      position.current = fitted;
      node.style.setProperty("--note-x", `${fitted.x}px`);
      node.style.setProperty("--note-y", `${fitted.y}px`);
    },
    [content],
  );

  const endDrag = (): void => {
    drag.current = null;
    if (content) content.dataset.dragging = "false";
  };

  const resetPosition = (): void => {
    position.current = null;
    if (content) {
      content.dataset.detached = "false";
      content.style.removeProperty("--note-x");
      content.style.removeProperty("--note-y");
    }
  };

  React.useEffect(() => {
    if (!open) {
      position.current = null;
      drag.current = null;
      return;
    }
    if (!content) return;
    const fit = (): void => {
      if (position.current) move(position.current);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [content, move, open]);

  return (
    <Popover.Root open={open} onOpenChange={() => {}}>
      <Popover.Anchor asChild>
        <div
          className="sel-anchor"
          style={
            rect === null
              ? { display: "none" }
              : {
                  height: rect.height,
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                }
          }
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          ref={setContent}
          className="note-pop"
          aria-label="Annotation note"
          side="bottom"
          align="start"
          alignOffset={28}
          sideOffset={8}
          avoidCollisions
          collisionPadding={12}
          arrowPadding={16}
          onInteractOutside={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={onCancel}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (!held) onFocus();
          }}
        >
          <div className="note-pop-body">
            <div className="note-pop-head">
              <span>{label}</span>
              <button
                type="button"
                className="note-pop-drag"
                aria-label="Move note box"
                title="Drag to move. Arrow keys move; Home returns beside selection."
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const box = content?.getBoundingClientRect();
                  if (!box) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = {
                    id: event.pointerId,
                    offset: {
                      x: event.clientX - box.x,
                      y: event.clientY - box.y,
                    },
                  };
                  if (content) content.dataset.dragging = "true";
                }}
                onPointerMove={(event) => {
                  const active = drag.current;
                  if (!active || active.id !== event.pointerId) return;
                  move({ x: event.clientX - active.offset.x, y: event.clientY - active.offset.y });
                }}
                onPointerUp={(event) => {
                  if (drag.current?.id !== event.pointerId) return;
                  endDrag();
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onLostPointerCapture={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => {
                  if (event.key === "Home") {
                    event.preventDefault();
                    resetPosition();
                    return;
                  }
                  const box = content?.getBoundingClientRect();
                  if (
                    !box ||
                    !["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp"].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  const step = event.shiftKey ? 64 : 16;
                  move({
                    x:
                      box.x +
                      (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0),
                    y:
                      box.y +
                      (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0),
                  });
                }}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 18 18"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="6" cy="4" r="1.25" />
                  <circle cx="12" cy="4" r="1.25" />
                  <circle cx="6" cy="9" r="1.25" />
                  <circle cx="12" cy="9" r="1.25" />
                  <circle cx="6" cy="14" r="1.25" />
                  <circle cx="12" cy="14" r="1.25" />
                </svg>
              </button>
            </div>
            {children}
          </div>
          <Popover.Arrow asChild width={16} height={8}>
            <svg
              className="note-pop-arrow"
              width="16"
              height="8"
              viewBox="0 0 16 8"
              aria-hidden="true"
            >
              <path d="M0 -1H16L8 7Z" fill="var(--paper)" />
              <path d="M0 0L8 7L16 0" fill="none" stroke="var(--edge-2)" />
            </svg>
          </Popover.Arrow>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
