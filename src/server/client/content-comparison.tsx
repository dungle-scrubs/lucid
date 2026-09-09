import * as React from "react";
import type { Passage, WordPart } from "../../protocol/content-comparison.js";
import { compareContent } from "../../protocol/content-comparison.js";
import type { ComparisonDraft } from "./comparison-draft.js";
import { draftForPassage, draftIsOnPassage } from "./comparison-draft.js";
import { FRAME_MESSAGE_SOURCE, instrumentArtifact } from "./instrument.js";
import type { SentBatch } from "./timeline.js";
import { Button } from "./ui/button.js";
import { Textarea } from "./ui/textarea.js";
import { useArtifactAppearance } from "./use-artifact-appearance.js";

export interface ComparedVersion {
  readonly author?: string;
  readonly contentType: string;
  readonly artifactId: string;
  readonly bytes: string;
  readonly hash: string;
  readonly version: number;
}
export interface ComparisonPair {
  readonly earlier: ComparedVersion | null;
  readonly earlierVersion: number;
  readonly reviewed: ComparedVersion | null;
  readonly reviewedVersion: number;
}
const PassageText = ({ passage, words }: { passage: Passage; words: readonly WordPart[] }) => {
  const tag = /^h[1-6]$/.test(passage.tag)
    ? (passage.tag as "h1")
    : passage.tag === "pre"
      ? "pre"
      : "p";
  let offset = 0;
  return React.createElement(
    tag,
    {
      className: `comparison-text passage-${passage.tag}`,
      style: { paddingInlineStart: `${Math.min(passage.depth, 6) * 12}px` },
    },
    words.map((part) => {
      const key = offset;
      offset += part.text.length;
      return part.changed ? <mark key={key}>{part.text}</mark> : part.text;
    }),
  );
};

/** Only strings from the inert model enter React. Saved HTML is confined to
 * the explicit inspection iframe, using the existing reader sandbox. */
export const ContentComparisonView = ({
  artifactId,
  pair,
  latest,
  onReview,
  loading,
  draft,
  onDraft,
  onSend,
  locked,
  refusal,
  sent,
}: {
  artifactId: string;
  pair: ComparisonPair;
  latest: number;
  onReview: () => void;
  loading: boolean;
  draft: ComparisonDraft | null;
  onDraft: (draft: ComparisonDraft | null) => void;
  onSend: () => void;
  locked: boolean;
  refusal: string | null;
  sent: readonly SentBatch[];
}) => {
  const editor = React.useRef<HTMLTextAreaElement>(null);
  const selection = React.useRef<{ start: number; end: number } | null>(null);
  const [selectionMessage, setSelectionMessage] = React.useState<string | null>(null);
  const selectedKey = draft
    ? `${draft.spot.sourceVersion}:${draft.spot.id}:${draft.spot.selectors?.position.start}`
    : "";
  const focusKey = selectedKey ? `${selectedKey}:${pair.reviewedVersion}` : "";
  React.useLayoutEffect(() => {
    if (!focusKey || locked) return;
    editor.current?.focus();
    if (selection.current)
      editor.current?.setSelectionRange(selection.current.start, selection.current.end);
    editor.current?.scrollIntoView({ block: "nearest" });
  }, [focusKey, locked]);
  const choose = (
    passage: Passage,
    version: ComparedVersion,
    start = 0,
    end = passage.text.length,
  ): void => {
    if (locked) return;
    if (draft?.text.trim()) {
      setSelectionMessage("Send or cancel your current note before choosing another passage.");
      return;
    }
    selection.current = null;
    setSelectionMessage(null);
    onDraft(draftForPassage(passage, version.version, version.hash, start, end));
  };
  const selectWords = (cell: HTMLElement, passage: Passage, version: ComparedVersion): void => {
    const selected = window.getSelection();
    const text = cell.querySelector(".comparison-text");
    if (!selected || selected.isCollapsed || !selected.rangeCount || !text) return;
    const range = selected.getRangeAt(0);
    if (!text.contains(range.startContainer) || !text.contains(range.endContainer)) return;
    const prefix = document.createRange();
    prefix.selectNodeContents(text);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length,
      end = start + range.toString().length;
    if (start < end && end <= passage.text.length) choose(passage, version, start, end);
  };
  const noteEditor = draft ? (
    <div className="comparison-note-editor">
      <label htmlFor="comparison-note">Your note on v{draft.spot.sourceVersion}</label>
      <blockquote>{draft.spot.snippet}</blockquote>
      {draft.spot.selectors &&
      draft.spot.selectors.quote.exact.length > draft.spot.snippet.length ? (
        <p className="comparison-coverage">
          Excerpt shortened. The saved source selection is retained.
        </p>
      ) : null}
      <Textarea
        id="comparison-note"
        ref={editor}
        value={draft.text}
        disabled={locked}
        aria-label="Note about selected content"
        placeholder="What should change?"
        onChange={(event) => {
          onDraft({ ...draft, text: event.target.value });
        }}
      />
      <div className="comparison-actions">
        <Button
          onClick={() => {
            onDraft(null);
            setSelectionMessage(null);
          }}
          disabled={locked}
        >
          Cancel
        </Button>
        <Button
          onClick={onSend}
          disabled={
            locked ||
            loading ||
            !draft.text.trim() ||
            latest > pair.reviewedVersion ||
            !pair.reviewed
          }
        >
          Send note
        </Button>
      </div>
      {refusal ? <p role="alert">{refusal}</p> : null}
    </div>
  ) : null;
  const [inspection, setInspection] = React.useState<ComparedVersion | null>(null);
  const dialog = React.useRef<HTMLDialogElement>(null);
  const inspectionTrigger = React.useRef<HTMLElement | null>(null);
  const model = React.useMemo(
    () =>
      pair.earlier && pair.reviewed
        ? compareContent(pair.earlier.bytes, pair.reviewed.bytes, undefined, [
            pair.earlier.author ?? "agent",
            pair.reviewed.author ?? "agent",
          ])
        : null,
    [pair],
  );
  const inspect = (version: ComparedVersion): void => {
    inspectionTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInspection(version);
    dialog.current?.showModal();
  };
  const closeInspection = (): void => {
    dialog.current?.close();
    setInspection(null);
    inspectionTrigger.current?.focus();
  };
  return (
    <section
      className="content-comparison"
      aria-label="Saved content comparison"
      aria-busy={loading}
    >
      <div className="comparison-toolbar">
        <div className="comparison-versions">
          <span>
            Earlier <strong>v{pair.earlierVersion}</strong>
          </span>
          <span>
            Reviewed <strong>v{pair.reviewedVersion}</strong>
          </span>
        </div>
        <div className="comparison-actions">
          <Button disabled={!pair.earlier} onClick={() => pair.earlier && inspect(pair.earlier)}>
            Inspect v{pair.earlierVersion}
          </Button>
          <Button disabled={!pair.reviewed} onClick={() => pair.reviewed && inspect(pair.reviewed)}>
            Inspect v{pair.reviewedVersion}
          </Button>
        </div>
      </div>
      {latest > pair.reviewedVersion ? (
        <div className="comparison-stale" role="status">
          <span>
            v{latest} is now current. You are still reviewing v{pair.reviewedVersion}.
          </span>
          <Button
            disabled={loading}
            onClick={() => {
              if (editor.current)
                selection.current = {
                  start: editor.current.selectionStart,
                  end: editor.current.selectionEnd,
                };
              onReview();
            }}
          >
            Review latest
          </Button>
        </div>
      ) : null}
      {loading ? <p role="status">Reading saved versions…</p> : null}
      {!loading && !pair.earlier ? (
        <p role="alert">E-COMP-01: Earlier v{pair.earlierVersion} could not be read.</p>
      ) : null}
      {!loading && !pair.reviewed ? (
        <p role="alert">E-COMP-01: Reviewed v{pair.reviewedVersion} could not be read.</p>
      ) : null}
      {selectionMessage ? <p role="status">{selectionMessage}</p> : null}
      {draft &&
      !model?.rows.some(
        (row) =>
          (row.before && draftIsOnPassage(draft, row.before, pair.earlierVersion)) ||
          (row.after && draftIsOnPassage(draft, row.after, pair.reviewedVersion)),
      ) ? (
        <div className="comparison-retained">{noteEditor}</div>
      ) : null}
      {model ? (
        <>
          <p className="comparison-coverage">{model.notice}</p>
          {model.coarse ? (
            <p className="comparison-coverage">
              E-COMP-05: Coarse comparison. Some passages or words could not be aligned within the
              comparison limit.
            </p>
          ) : null}
          {model.sources.some((source) => source.notices.length) ? (
            <details className="comparison-coverage">
              <summary>Content not compared</summary>
              <ul>
                {[...new Set(model.sources.flatMap((source) => source.notices))].map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="comparison-rows">
            {model.rows.map((row) => (
              <div
                className={`comparison-row ${row.kind}`}
                key={`${row.before?.key ?? "_"}/${row.after?.key ?? "_"}`}
              >
                {(["before", "after"] as const).map((side) => {
                  const passage = row[side];
                  const version = side === "before" ? pair.earlierVersion : pair.reviewedVersion;
                  return (
                    <div
                      className={`comparison-cell ${side}`}
                      key={side}
                      data-source-version={version}
                      data-source-element={passage?.id}
                    >
                      <div className="comparison-side-label">
                        {side === "before" ? "Earlier" : "Reviewed"} v{version}
                        {row.kind === "same"
                          ? " · unchanged"
                          : passage
                            ? side === "before"
                              ? " · − removed"
                              : " · + added"
                            : ""}
                      </div>
                      {passage ? (
                        <section
                          aria-label={`Select content from v${version}`}
                          onPointerUp={(event) => {
                            const source = side === "before" ? pair.earlier : pair.reviewed;
                            if (source) selectWords(event.currentTarget, passage, source);
                          }}
                          onKeyUp={(event) => {
                            const source = side === "before" ? pair.earlier : pair.reviewed;
                            if (event.key === "Shift" && source)
                              selectWords(event.currentTarget, passage, source);
                          }}
                        >
                          <PassageText
                            passage={passage}
                            words={side === "before" ? row.oldWords : row.newWords}
                          />
                        </section>
                      ) : (
                        <p className="comparison-absent">
                          {side === "before"
                            ? "Not present in the earlier version"
                            : "Not present in the reviewed version"}
                        </p>
                      )}
                      {passage ? (
                        <div className="comparison-passage-actions">
                          <Button
                            disabled={locked}
                            onClick={() => {
                              const source = side === "before" ? pair.earlier : pair.reviewed;
                              if (source) choose(passage, source);
                            }}
                          >
                            + Note
                          </Button>
                          {sent
                            .filter(
                              (batch) =>
                                batch.version === version &&
                                batch.notes[0]?.spots.some(
                                  (spot) =>
                                    typeof spot.sourceHash === "string" &&
                                    spot.sourceHash ===
                                      (side === "before"
                                        ? pair.earlier?.hash
                                        : pair.reviewed?.hash) &&
                                    draftIsOnPassage(
                                      {
                                        spot: {
                                          ...spot,
                                          sourceHash: spot.sourceHash,
                                          sourceVersion: version,
                                        },
                                        text: "",
                                      },
                                      passage,
                                      version,
                                    ),
                                ),
                            )
                            .map((batch) => (
                              <a
                                className="comparison-marker"
                                key={batch.inputId}
                                href={`#comparison-note-${batch.inputId}`}
                              >
                                Note · {batch.inputId?.slice(-6)}
                              </a>
                            ))}
                        </div>
                      ) : null}
                      {passage && draft && draftIsOnPassage(draft, passage, version)
                        ? noteEditor
                        : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : null}
      <dialog
        ref={dialog}
        className="comparison-inspection"
        onCancel={(event) => {
          event.preventDefault();
          closeInspection();
        }}
        aria-label={`Inspect saved v${inspection?.version ?? ""}`}
      >
        <header>
          <span>Saved v{inspection?.version}</span>
          <Button onClick={closeInspection}>Back to comparison</Button>
        </header>
        {inspection ? <InspectionFrame artifactId={artifactId} inspection={inspection} /> : null}
      </dialog>
    </section>
  );
};

function InspectionFrame(props: {
  readonly artifactId: string;
  readonly inspection: ComparedVersion;
}) {
  const { artifactId, inspection } = props;
  const colorScheme = useArtifactAppearance(inspection.bytes);
  const srcDoc = React.useMemo(
    () => instrumentArtifact(inspection.bytes, artifactId, inspection.version),
    [inspection, artifactId],
  );
  return (
    <iframe
      title={`${artifactId} saved v${inspection.version}`}
      style={{ colorScheme }}
      sandbox="allow-scripts"
      onLoad={(event) =>
        event.currentTarget.contentWindow?.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "mode", mode: "annotate", readOnly: true },
          "*",
        )
      }
      srcDoc={srcDoc}
    />
  );
}
