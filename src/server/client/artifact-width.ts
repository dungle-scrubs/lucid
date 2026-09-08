import { parse } from "parse5";

export type ArtifactWidth =
  | { readonly unit: "full" }
  | { readonly unit: "px" | "rem" | "%"; readonly value: number };

export const ARTIFACT_FRAME_MIN = 320;

export const parseArtifactWidth = (raw: string | null): ArtifactWidth => {
  const match = raw?.trim().match(/^(\d+(?:\.\d+)?|\.\d+)(px|rem|%)$/);
  if (!match) return { unit: "full" };
  const value = Number(match[1]);
  const unit = match[2];
  if (unit !== "px" && unit !== "rem" && unit !== "%") return { unit: "full" };
  const limit = unit === "px" ? 10000 : unit === "rem" ? 625 : 100;
  return Number.isFinite(value) && value > 0 && value <= limit ? { unit, value } : { unit: "full" };
};

/** Parse bytes without creating browser elements or fetching their resources. */
export const preferredArtifactWidth = (bytes: string): ArtifactWidth => {
  const tree = parse(bytes);
  const html = tree.childNodes.find((node) => node.nodeName === "html");
  if (!html || !("childNodes" in html)) return { unit: "full" };
  const head = html.childNodes.find((node) => node.nodeName === "head");
  if (!head || !("childNodes" in head)) return { unit: "full" };
  const meta = head.childNodes.find(
    (node) =>
      node.nodeName === "meta" &&
      "attrs" in node &&
      node.attrs.some((attr) => attr.name === "name" && attr.value === "lucid-width"),
  );
  return parseArtifactWidth(
    meta && "attrs" in meta
      ? (meta.attrs.find((attr) => attr.name === "content")?.value ?? null)
      : null,
  );
};

export const artifactWidthLabel = (width: ArtifactWidth): string =>
  width.unit === "full" ? "Full available width" : `${width.value}${width.unit}`;

export const artifactWidthPixels = (
  preferred: ArtifactWidth,
  override: number | null,
  available: number,
  rootFontSize: number,
): number => {
  if (!Number.isFinite(available) || available <= 0) return 0;
  const wanted =
    override !== null
      ? (override / 100) * available
      : preferred.unit === "full"
        ? available
        : preferred.unit === "%"
          ? (preferred.value / 100) * available
          : preferred.unit === "rem"
            ? preferred.value * rootFontSize
            : preferred.value;
  return Math.min(available, Math.max(Math.min(ARTIFACT_FRAME_MIN, available), wanted));
};

export const artifactWidthKey = (conversationId: string, artifactId: string): string =>
  `lucid.artifactWidth:${JSON.stringify([conversationId, artifactId])}`;

export const readArtifactWidth = (
  store: Pick<Storage, "getItem"> | null,
  key: string,
): number | null => {
  try {
    const raw = store?.getItem(key);
    if (!raw || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
  } catch {
    return null;
  }
};

export const writeArtifactWidth = (
  store: Pick<Storage, "setItem" | "removeItem"> | null,
  key: string,
  value: number | null,
): void => {
  try {
    if (value === null) store?.removeItem(key);
    else if (Number.isInteger(value) && value >= 1 && value <= 100)
      store?.setItem(key, String(value));
  } catch {
    // The in-memory view remains usable when storage is unavailable or full.
  }
};
