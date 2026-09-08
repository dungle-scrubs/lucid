import * as Popover from "@radix-ui/react-popover";
import * as React from "react";
import {
  ARTIFACT_FRAME_MIN,
  artifactWidthKey,
  artifactWidthLabel,
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
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="v width-trigger">
          Document width
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="width-panel" sideOffset={8} align="end" collisionPadding={12}>
          <label htmlFor={id}>Document width</label>
          <output htmlFor={id}>
            {Math.round(measure.used)}px · {percentage}% of available space
          </output>
          <input
            id={id}
            type="range"
            min={minimum}
            max={100}
            step={1}
            value={value}
            aria-valuetext={`${Math.round(measure.used)} pixels, ${percentage} percent of available space`}
            onChange={(event) => change(Number(event.currentTarget.value))}
          />
          <p>
            {override === null
              ? `Artifact: ${artifactWidthLabel(preferred)}`
              : `Reader preference: ${override}%`}
          </p>
          <button
            type="button"
            className="v"
            disabled={override === null}
            onClick={() => change(null)}
          >
            Use artifact width
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
  return { control, stage, style: { inlineSize: measure.available > 0 ? `${pixels}px` : "100%" } };
}
