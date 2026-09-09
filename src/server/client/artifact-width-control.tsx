import * as React from "react";
import {
  ARTIFACT_FRAME_MIN,
  artifactWidthKey,
  artifactWidthPixels,
  preferredArtifactWidth,
  readArtifactWidth,
  writeArtifactWidth,
} from "./artifact-width.js";

const browserStorage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** Viewer-local state and frame measurements; never touches artifact bytes. */
export function useArtifactWidth(
  conversationId: string,
  artifactId: string,
  bytes: string,
): {
  readonly control: React.ReactElement;
  readonly stage: (node: HTMLDivElement | null) => void;
  readonly style: React.CSSProperties;
} {
  const key = artifactWidthKey(conversationId, artifactId);
  const [stageNode, setStageNode] = React.useState<HTMLDivElement | null>(null);
  const stage = React.useCallback((node: HTMLDivElement | null) => setStageNode(node), []);
  const id = React.useId();
  const preferred = React.useMemo(() => preferredArtifactWidth(bytes), [bytes]);
  const stored = React.useMemo(() => readArtifactWidth(browserStorage(), key), [key]);
  const [choices, setChoices] = React.useState<ReadonlyMap<string, number | null>>(() => new Map());
  const override = choices.has(key) ? (choices.get(key) ?? null) : stored;
  const [measure, setMeasure] = React.useState({ available: 0, rootFontSize: 16, used: 0 });

  React.useLayoutEffect(() => {
    const frame = stageNode;
    const ground = frame?.parentElement;
    if (!frame || !ground) return;
    const update = (): void => {
      const style = getComputedStyle(ground);
      const next = {
        available: Math.max(
          0,
          ground.clientWidth -
            Number.parseFloat(style.paddingLeft) -
            Number.parseFloat(style.paddingRight),
        ),
        rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        used: frame.getBoundingClientRect().width,
      };
      setMeasure((old) =>
        old.available === next.available &&
        old.rootFontSize === next.rootFontSize &&
        old.used === next.used
          ? old
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ground);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [stageNode]);

  const change = (value: number | null): void => {
    setChoices((old) => new Map(old).set(key, value));
    writeArtifactWidth(browserStorage(), key, value);
  };
  const minimum =
    measure.available > 0
      ? Math.min(100, Math.ceil((ARTIFACT_FRAME_MIN / measure.available) * 100))
      : 100;
  const percentage =
    measure.available > 0 ? Math.round((measure.used / measure.available) * 100) : 100;
  const value = Math.max(minimum, Math.min(100, percentage));
  const pixels = artifactWidthPixels(preferred, override, measure.available, measure.rootFontSize);
  const control = (
    <ArtifactWidthControl
      key={key}
      id={id}
      minimum={minimum}
      onChange={change}
      override={override}
      percentage={percentage}
      value={value}
    />
  );
  return { control, stage, style: { inlineSize: measure.available > 0 ? `${pixels}px` : "100%" } };
}

/** The border grows from the tab; the controls keep their size as they fade in. */
function ArtifactWidthControl(props: {
  readonly id: string;
  readonly minimum: number;
  readonly onChange: (value: number | null) => void;
  readonly override: number | null;
  readonly percentage: number;
  readonly value: number;
}) {
  const { id, minimum, onChange, override, percentage, value } = props;
  const [open, setOpen] = React.useState(false);
  const [height, setHeight] = React.useState(100);
  const root = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragging = React.useRef(false);
  const returningFocus = React.useRef(false);
  const clearClose = (): void => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = (): void => {
    clearClose();
    setOpen(true);
  };
  const scheduleClose = (): void => {
    clearClose();
    if (!dragging.current) closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  React.useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = (): void => setHeight(node.offsetHeight + 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  React.useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  React.useLayoutEffect(() => {
    content.current?.toggleAttribute("inert", !open);
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const blur = (): void => setOpen(false);
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", blur);
    };
  }, [open]);
  return (
    <div
      ref={root}
      className="width-control"
      role="toolbar"
      aria-label="Document width"
      data-state={open ? "open" : "closed"}
      style={{ "--width-panel-height": `${height}px` } as React.CSSProperties}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") show();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") scheduleClose();
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          clearClose();
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          clearClose();
          setOpen(false);
          returningFocus.current = true;
          trigger.current?.focus();
          returningFocus.current = false;
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="width-trigger"
        aria-label="Adjust document width"
        aria-controls={`${id}-panel`}
        aria-expanded={open}
        onClick={show}
        onFocus={() => {
          if (!returningFocus.current) show();
        }}
      >
        Width
      </button>
      <div className="width-panel" id={`${id}-panel`}>
        <div ref={content} className="width-panel-content">
          <div className="width-panel-heading">
            <label htmlFor={id}>Document width</label>
            <output htmlFor={id}>{percentage}%</output>
          </div>
          <fieldset className="width-presets" aria-label="Document width presets">
            {[
              { label: "Narrow", width: 55 },
              { label: "Reading", width: 75 },
              { label: "Full", width: 100 },
              { label: "Default", width: null },
            ].map((preset) => (
              <button
                key={preset.label}
                type="button"
                aria-pressed={override === preset.width}
                title={preset.width === null ? "Restore the document's preferred width" : undefined}
                onClick={() => onChange(preset.width)}
              >
                {preset.label}
              </button>
            ))}
          </fieldset>
          <input
            id={id}
            type="range"
            min={minimum}
            max={100}
            step={1}
            value={value}
            aria-valuetext={`${percentage} percent of available space`}
            onChange={(event) => onChange(Number(event.currentTarget.value))}
            onPointerDown={() => {
              dragging.current = true;
              clearClose();
            }}
            onPointerUp={(event) => {
              dragging.current = false;
              const bounds = root.current?.getBoundingClientRect();
              if (
                bounds &&
                (event.clientX < bounds.left ||
                  event.clientX > bounds.right ||
                  event.clientY < bounds.top - height / 2 ||
                  event.clientY > bounds.top + height / 2)
              ) {
                scheduleClose();
              }
            }}
            onPointerCancel={() => {
              dragging.current = false;
              scheduleClose();
            }}
          />
        </div>
      </div>
    </div>
  );
}
