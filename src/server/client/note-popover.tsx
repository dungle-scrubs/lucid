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
  const content = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<Position | null>(null);
  const drag = React.useRef<{ readonly id: number; readonly offset: Position } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const open = rect !== null;

  const move = React.useCallback((next: Position): void => {
    const box = content.current?.getBoundingClientRect();
    if (!box) return;
    const fitted = {
      x: Math.max(12, Math.min(next.x, window.innerWidth - box.width - 12)),
      y: Math.max(12, Math.min(next.y, window.innerHeight - box.height - 12)),
    };
    setPosition((previous) =>
      previous?.x === fitted.x && previous.y === fitted.y ? previous : fitted,
    );
  }, []);

  React.useEffect(() => {
    if (!open) {
      setPosition(null);
      drag.current = null;
      setDragging(false);
    }
  }, [open]);

  React.useEffect(() => {
    if (position === null) return;
    const fit = (): void => move(position);
    const observer = new ResizeObserver(fit);
    if (content.current) observer.observe(content.current);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [move, position]);

  const virtualAnchor = React.useMemo(
    () =>
      position === null
        ? undefined
        : {
            current: {
              getBoundingClientRect: (): DOMRect => new DOMRect(position.x, position.y, 0, 0),
            },
          },
    [position],
  );

  return (
    <Popover.Root open={open} onOpenChange={() => {}}>
      <Popover.Anchor asChild virtualRef={virtualAnchor}>
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
          ref={content}
          className="note-pop"
          aria-label="Annotation note"
          data-detached={position !== null}
          data-dragging={dragging}
          side="bottom"
          align="start"
          alignOffset={position === null ? 28 : 0}
          sideOffset={position === null ? 8 : 0}
          avoidCollisions={position === null}
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
                  const box = content.current?.getBoundingClientRect();
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
                  setDragging(true);
                }}
                onPointerMove={(event) => {
                  const active = drag.current;
                  if (!active || active.id !== event.pointerId) return;
                  move({ x: event.clientX - active.offset.x, y: event.clientY - active.offset.y });
                }}
                onPointerUp={(event) => {
                  if (drag.current?.id !== event.pointerId) return;
                  drag.current = null;
                  setDragging(false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onLostPointerCapture={() => {
                  drag.current = null;
                  setDragging(false);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                  setDragging(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Home") {
                    event.preventDefault();
                    setPosition(null);
                    return;
                  }
                  const box = content.current?.getBoundingClientRect();
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
          {position === null ? (
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
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
