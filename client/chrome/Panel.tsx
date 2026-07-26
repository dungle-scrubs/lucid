import { useEffect, useRef, useState } from "react";
import type { SelectionResponse } from "../../src/protocol/wire.ts";
import { QUICK_REPLIES } from "./actions.ts";
import { TargetSnippet } from "./AnnotationPart.tsx";
import { useActions, useSession, useSessionHandle } from "./context.tsx";
import { FoldedText } from "./FoldedText.tsx";
import { effortLadder, withCurrent } from "./selection.ts";
import { imagesFromPaste } from "./store.ts";
import type { OutboxMessage, PastedImage } from "./types.ts";
import { Kbd, KbdGroup } from "./ui/kbd.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { closeButtonSmall } from "./ui/close.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/**
 * The parts of the panel that are not transcript: work staged but not yet in
 * the log. They sit at the end of the record, where the eye already is after a
 * pick.
 */

const btn =
  "cursor-pointer border border-ink-600 bg-ink-700 px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-fg hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-40";
const btnPrimary =
  "cursor-pointer border border-accent bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase tracking-[0.05em] text-on-accent hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-40";
const heading = "mb-2 text-[10px] font-semibold uppercase tracking-[0.8px] text-fg-muted";
/* my-1 on top of the card's 7px gap: the focus ring extends 4px past the
   border on every side (2px outline + 2px offset), which otherwise leaves the
   snippet above and the buttons below visually touching the ring. */
const field =
  "my-1 resize-y border border-ink-600 bg-bg-inset p-2 font-sans text-[13px] text-fg placeholder:text-fg-faint focus-visible:annot-outline";

/** Enter submits, Shift+Enter is a newline - the composer's rule everywhere. */
const onSubmitKey = (e: React.KeyboardEvent, action: () => void): void => {
  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
    e.preventDefault();
    action();
  }
};

/** Staged images, before the annotation carrying them is sent. */
const Chips = ({
  images,
  onRemove,
}: {
  readonly images: readonly PastedImage[];
  readonly onRemove?: (id: string) => void;
}) => {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((img) => (
        <span
          key={img.id}
          data-test="annotation-chip"
          className="inline-flex items-center gap-1.5 border border-ink-600 bg-ink-800 py-[3px] pr-[6px] pl-[3px]"
        >
          <img src={img.url} alt="" className="size-[22px] object-cover" />
          <span className="max-w-[150px] truncate text-[11px] text-cream-300">{img.name}</span>
          {onRemove ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => onRemove(img.id)}
                    className={`${closeButtonSmall} hover:text-rust-300`}
                  >
                    ×
                  </button>
                }
              />
              <TooltipContent>Remove</TooltipContent>
            </Tooltip>
          ) : null}
        </span>
      ))}
    </div>
  );
};

export const Warnings = () => {
  const warnings = useSession((s) => s.warnings);
  if (warnings.length === 0) return null;
  return (
    <section>
      <h3 className={heading}>Warnings</h3>
      {warnings.map((w) => (
        <div key={w.id} className="text-[12px] text-rust-300">
          {w.code}: {w.message}
        </div>
      ))}
    </section>
  );
};

/**
 * A message that did not reach the log. It is the human's own words, held
 * verbatim until the server takes them - the composer cannot hold them, because
 * assistant-ui clears it the instant Enter is pressed.
 *
 * Retry is the point, so it leads. Copy is the escape hatch that makes the text
 * genuinely unlosable (paste it anywhere), and Discard is the only way it ever
 * goes away.
 */
const UnsentMessage = ({ message }: { readonly message: OutboxMessage }) => {
  const { flushOutbox, discardOutboxMessage } = useActions();
  const { transport, notify } = useSessionHandle();
  // This entry's own state, not the outbox's: a flush stuck on one message must
  // never disable the retry that would clear another.
  const sending = useSession((s) => s.outboxSendingId) === message.id;
  const [copied, setCopied] = useState(false);
  return (
    <article
      data-test="unsent-message"
      className="flex flex-col gap-[7px] border border-dashed border-rust-400/60 bg-ink-700 px-[11px] py-[10px]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className={`text-[11px] ${message.failed ? "text-rust-300" : "text-fg-faint"}`}>
          {message.failed ? "not delivered" : "sending…"}
        </span>
        <span className="text-[10px] text-fg-faint tabular-nums">
          {new Date(message.at).toLocaleTimeString()}
        </span>
      </div>
      {message.images.length > 0 ? (
        <Chips images={message.images.map((i) => ({ ...i, url: transport.assetUrl(i.file) }))} />
      ) : null}
      <div className="text-fg">
        <FoldedText text={message.text} />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          data-test="retry-unsent"
          disabled={sending}
          onClick={() => void flushOutbox()}
          className={btnPrimary}
        >
          {sending ? "Sending…" : "Retry"}
        </button>
        <button
          type="button"
          data-test="copy-unsent"
          onClick={() => {
            navigator.clipboard.writeText(message.text).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              },
              () => notify.warn("Couldn't copy - select the text above instead."),
            );
          }}
          className={btn}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          data-test="discard-unsent"
          onClick={() => discardOutboxMessage(message.id)}
          className={`${btn} ml-auto`}
        >
          Discard
        </button>
      </div>
    </article>
  );
};

/** How long a send may take before it must become VISIBLE. Long enough that the
 *  common path (a fast append) never flashes a card, short enough that nobody
 *  wonders where their typing went. */
const SLOW_SEND_MS = 1200;

/**
 * Messages the server has not taken yet.
 *
 * A failed one always shows. An in-flight one shows once it has been trying for
 * longer than a beat: the composer empties on Enter, so this card is the only
 * place the human's typing still exists, and appends can queue behind an agent
 * rewriting the artifact. Hiding every in-flight entry meant a slow send looked
 * exactly like a swallowed one.
 */
export const UnsentMessages = () => {
  const outbox = useSession((s) => s.outbox);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = outbox.some((m) => !m.failed);

  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [inFlight]);

  const shown = outbox.filter((m) => m.failed || now - new Date(m.at).getTime() > SLOW_SEND_MS);
  if (shown.length === 0) return null;
  const anyFailed = shown.some((m) => m.failed);
  return (
    <section data-test="unsent-messages">
      <h3 className={heading}>
        {anyFailed ? "Not sent" : "Sending"}
        {shown.length > 1 ? ` (${shown.length})` : ""}
      </h3>
      <div className="flex flex-col gap-[7px]">
        {shown.map((m) => (
          <UnsentMessage key={m.id} message={m} />
        ))}
      </div>
    </section>
  );
};

/** Neutral, transient confirmations (e.g. a fork was recorded). Distinct from
 *  Warnings both in intent and colour so a success never reads as an error. */
export const Notices = () => {
  const notices = useSession((s) => s.notices);
  if (notices.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      {notices.map((n) => (
        <div
          key={n.id}
          className="border border-ink-600 bg-ink-700 px-2.5 py-1.5 text-[12px] text-cream-300"
        >
          {n.message}
        </div>
      ))}
    </section>
  );
};

/**
 * A composed-but-unsent annotation, inline in the record at the moment it was
 * written - the same place its sent form will hold (the event carries
 * authoredAt). Client-side until Send; reads the live queue by id so edits
 * re-render without the timeline rebuilding.
 */
export const QueuedCard = ({ id, index }: { readonly id: string; readonly index: number }) => {
  const { beginEdit, cancelEdit, commitEdit, removeQueued, setEditDraft, setHovered } =
    useActions();
  const { pastes } = useSessionHandle();
  const q = useSession((s) => s.queue.find((x) => x.id === id));
  const editingId = useSession((s) => s.editingId);
  const editDraft = useSession((s) => s.editDraft);
  const sending = useSession((s) => s.sending);
  const hoveredId = useSession((s) => s.hoveredId);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const editing = editingId === id;

  // Keyed on the edit state, not mount: the textarea does not exist until the
  // card opens, so an empty dep array would focus nothing, every time.
  useEffect(() => {
    if (!editing) return;
    const box = editRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [editing]);

  if (!q) return null; // just sent: the located card takes this spot over
  return (
    <section
      data-test="queued-annotation"
      data-annotation-id={q.id}
      aria-label={`Queued annotation ${index}`}
      className={`relative flex flex-col gap-[7px] border border-dashed bg-ink-700 px-[11px] py-[10px] ${
        hoveredId === q.id
          ? "border-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
          : "border-ink-500"
      }`}
      onMouseEnter={() => {
        setHovered(q.id);
        window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: q.id }));
      }}
      onMouseLeave={() => {
        setHovered(null);
        window.dispatchEvent(new CustomEvent("lucid:focus-annotation", { detail: "" }));
      }}
    >
      <span className="absolute -top-px -left-px z-1 flex size-5 items-center justify-center border border-dashed border-accent-dim bg-brass-400 text-[11px] font-bold tabular-nums text-on-accent shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        {index}
      </span>
      <span className="absolute -top-[9px] -right-[9px] z-1 bg-ink-600 px-[7px] py-px text-[10px] text-steel-300 shadow-[0_1px_3px_rgba(0,0,0,0.4)]">
        queued
      </span>
      {/* Every collected spot, first to last - the one note below covers them all. */}
      {q.targets.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: anchors have no id and the list only ever shrinks from a fixed pick order.
        <TargetSnippet key={i} target={t} />
      ))}
      <Chips images={q.images} />
      {editing ? (
        <>
          <textarea
            ref={editRef}
            rows={3}
            data-test="edit-note"
            placeholder="Edit this annotation… (Enter to save, Shift+Enter for a new line, Esc to cancel)"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
                return;
              }
              onSubmitKey(e, () => commitEdit());
            }}
            onPaste={pastes.collapseTextPaste}
            className={field}
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-test="save-edit"
              disabled={editDraft.trim().length === 0}
              onClick={() => commitEdit()}
              className={`${btnPrimary} flex items-center gap-1.5`}
            >
              Save
              <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
            </button>
            <button
              type="button"
              data-test="cancel-edit"
              onClick={cancelEdit}
              className={`${btn} flex items-center gap-1.5`}
            >
              Cancel
              <Kbd>esc</Kbd>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-fg">{q.note}</div>
          <div className="flex gap-2">
            <button
              type="button"
              data-test="edit-queued"
              disabled={sending}
              onClick={() => beginEdit(q.id)}
              className={btn}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={sending}
              onClick={() => removeQueued(q.id)}
              className={btn}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </section>
  );
};

/** The one queue-wide action. The cards live in the record; the send is a bar
 *  that stays visible above the composer however far the transcript scrolls. */
export const SendQueueBar = () => {
  const { sendQueue } = useActions();
  const queueLen = useSession((s) => s.queue.length);
  const sending = useSession((s) => s.sending);
  if (queueLen === 0) return null;
  return (
    <div className="border-t border-ink-600 bg-bg px-[14px] py-2">
      <button
        type="button"
        data-test="send-queue"
        disabled={sending}
        onClick={() => void sendQueue()}
        className={`${btnPrimary} flex w-full items-center justify-center gap-2`}
      >
        <span>
          Send {queueLen} annotation{queueLen > 1 ? "s" : ""}
        </span>
        {/* Keycaps on a filled button borrow the label's own colour: an ink
            keycap would punch a dark hole in the accent fill. */}
        <KbdGroup className="opacity-90">
          <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">⌘</Kbd>
          <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
        </KbdGroup>
      </button>
    </div>
  );
};

/** Why the pickers go read-only while someone is attending: Lucid cannot move
 *  a live conversation onto another model, and offering the choice would lie. */
const INHERITED_WHY = "an interactive session runs its own model";

/** One quiet picker in the composer's furniture: the same pill at the same
 *  weight whether it is writable or a readout, minus the chevron when there is
 *  nothing to open. A disabled Select would still advertise a menu. */
const SelectionPicker = ({
  label,
  test,
  value,
  busy,
  readOnly,
  display,
  options,
  onPick,
}: {
  readonly label: string;
  readonly test: string;
  readonly value: string;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly display: (value: string) => string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly hint?: string;
  }[];
  readonly onPick: (value: string) => void;
}) => (
  <span className="flex items-center">
    {readOnly ? (
      // No menu to head, so the label rides the value - still needed, or a
      // lone "opus" beside a lone "high" says nothing about which is which.
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              data-test={test}
              data-readonly="true"
              className="flex cursor-default items-baseline gap-1 border border-ink-500 bg-ink-800 px-2 py-[2px] text-[11px] text-fg-muted"
            >
              <span className="text-[9px] uppercase tracking-[0.08em] text-fg-faint">{label}</span>
              {display(value)}
            </span>
          }
        />
        <TooltipContent>{INHERITED_WHY}</TooltipContent>
      </Tooltip>
    ) : (
      <Select value={value} disabled={busy} onValueChange={(v) => onPick(v ?? "")}>
        <Tooltip>
          <TooltipTrigger
            render={
              <SelectTrigger
                data-test={test}
                aria-label={label}
                // The vendored trigger is the header's round, faint version PILL.
                // Here it is a control the human reads and changes, so it takes the
                // field shape and full-contrast text the rest of the composer uses.
                className={`border-ink-500 bg-ink-800 px-2 py-[2px] text-[11px] disabled:opacity-60 ${
                  value === "" ? "text-fg-muted" : "text-accent-bright"
                }`}
              >
                <SelectValue>{(v: string) => display(v)}</SelectValue>
              </SelectTrigger>
            }
          />
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
        <SelectContent>
          {/* The label heads the OPEN menu rather than sitting beside the
              trigger: on a narrow panel two standing labels cost a third of
              the row, and the name is only needed while choosing. */}
          <span
            data-test={`${test}-heading`}
            className="block border-b border-ink-600 px-2 pt-0.5 pb-1 text-[9px] uppercase tracking-[0.08em] text-fg-faint"
          >
            {label}
          </span>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
              {o.hint ? <span className="ml-2 text-[10px] text-fg-faint">{o.hint}</span> : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )}
  </span>
);

/**
 * Which model and effort this artifact's UNATTENDED turns run on. The pick is
 * sticky - it is written beside the artifact and every later headless resume
 * reuses it - so this is a property of the ARTIFACT, not of this window, and
 * every viewer of it sees the same pair.
 *
 * With an agent listening the pickers become a readout of what THAT session
 * runs (its stamp, or "inherited" when its environment declared nothing).
 * Presence is the only signal available here: a working window disconnects the
 * agent, and the pick applies to the next turn either way, so the pickers stay
 * writable through it rather than flickering.
 */
export const SelectionPickers = () => {
  const { transport, store, notify } = useSessionHandle();
  const info = useSession((s) => s.selectionInfo);
  const selection = useSession((s) => s.selection);
  const listening = useSession((s) => s.agentsListening);
  const attendant = useSession((s) => s.lastAttendant);
  const presence = useSession((s) => s.attendantPresence);
  const status = useSession((s) => s.status);
  const [busy, setBusy] = useState(false);

  // No recipe for this artifact's harness (or a server that predates the
  // route): there is no vocabulary to pick from, so there is no picker.
  if (info === null || status !== "active") return null;
  // A pick here sets what the next UNATTENDED turn runs as. With the
  // conversation open in a terminal there is no unattended turn to configure -
  // that session already runs on what it runs on - so the pickers report it
  // instead of pretending to set it. Same rule as a listening agent; presence
  // just sees the case the listener count cannot.
  const readOnly = listening > 0 || presence?.interactive === true;
  const models = info.models ?? [];
  const ladder = effortLadder(info, selection.model ?? "") ?? [];
  const modelValue = readOnly ? (attendant?.model ?? "") : (selection.model ?? "");
  const effortValue = readOnly ? (attendant?.effort ?? "") : (selection.effort ?? "");
  // A live effort keeps its row even when the ladder resolves empty (a sticky
  // model the registry no longer lists has no per-model vocabulary), or the
  // pick would be invisible and unclearable until the model changed.
  const showEffort = ladder.length > 0 || effortValue !== "";
  if (models.length === 0 && !showEffort) return null;

  const harness = selection.harness ?? attendant?.harness ?? info.name;
  const inherited = `inherited from ${harness}`;

  /** A POST replaces the whole selection, so both fields ride every write. */
  const commit = async (model: string, effort: string): Promise<void> => {
    setBusy(true);
    const res = await fetch(`${transport.base}/__lucid/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, effort }),
    }).catch(() => null);
    setBusy(false);
    if (!res) {
      notify.warn("Couldn't reach the server - the selection is unchanged.");
      return;
    }
    const body = (await res.json().catch(() => null)) as
      | (Partial<SelectionResponse> & { error?: string })
      | null;
    // The adapter's own words: a pick the recipe refuses is named here rather
    // than dying later as an agent turn on a flag the CLI never took.
    if (!res.ok || !body?.selection) {
      notify.warn(
        typeof body?.error === "string"
          ? body.error
          : `The server refused the selection (${res.status}).`,
      );
      return;
    }
    store.setState({ selection: body.selection, selectionInfo: body.info ?? null });
  };

  // A model change re-picks the ladder, so an effort the new model does not
  // accept falls back to default instead of being refused.
  const pickModel = (v: string): void => {
    const next = effortLadder(info, v);
    const effort = selection.effort ?? "";
    void commit(v, effort !== "" && next?.includes(effort) ? effort : "");
  };

  return (
    <div
      data-test="selection-pickers"
      data-readonly={readOnly ? "true" : "false"}
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
    >
      {models.length > 0 ? (
        <SelectionPicker
          label="model"
          test="selection-model"
          value={modelValue}
          busy={busy}
          readOnly={readOnly}
          display={(v) =>
            v === ""
              ? readOnly
                ? inherited
                : `default${info.defaultModel ? ` (${info.defaultModel})` : ""}`
              : (models.find((m) => m.id === v)?.label ?? v)
          }
          options={[
            {
              value: "",
              label: "default",
              ...(info.defaultModel ? { hint: info.defaultModel } : {}),
            },
            ...withCurrent(
              models.map((m) => m.id),
              modelValue,
            ).map((id) => {
              const m = models.find((x) => x.id === id);
              return { value: id, label: m?.label ?? id, ...(m?.label ? { hint: id } : {}) };
            }),
          ]}
          onPick={pickModel}
        />
      ) : null}
      {showEffort ? (
        <SelectionPicker
          label="effort"
          test="selection-effort"
          value={effortValue}
          busy={busy}
          readOnly={readOnly}
          display={(v) =>
            v === ""
              ? readOnly
                ? inherited
                : `default${info.defaultEffort ? ` (${info.defaultEffort})` : ""}`
              : v
          }
          options={[
            {
              value: "",
              label: "default",
              ...(info.defaultEffort ? { hint: info.defaultEffort } : {}),
            },
            ...withCurrent(ladder, effortValue).map((e) => ({ value: e, label: e })),
          ]}
          onPick={(v) => void commit(selection.model ?? "", v)}
        />
      ) : null}
    </div>
  );
};

/** The in-flight pick: an element chosen on the surface, awaiting its note.
 *  Renders nothing at all when idle - the pick gesture is taught once, by the
 *  empty-thread state, and a permanent placeholder was furniture after that. */
export const PendingComposer = () => {
  const {
    addPastedImage,
    addToQueue,
    discardPending,
    forkPending,
    queueQuickReply,
    removePastedImage,
    removePendingTarget,
    setComposerNote,
  } = useActions();
  const { pastes } = useSessionHandle();
  const pendingTarget = useSession((s) => s.pendingTarget);
  const pendingTargets = useSession((s) => s.pendingTargets);
  const composerNote = useSession((s) => s.composerNote);
  const pastedImages = useSession((s) => s.pastedImages);
  const forking = useSession((s) => s.forking);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (pendingTarget) ref.current?.focus();
  }, [pendingTarget]);

  if (!pendingTarget) return null;
  return (
    <section>
      <h3 className={heading}>
        New annotation
        {/* The gesture taught where its result appears; normal-case so the
            hint reads as an aside, not part of the heading. */}
        <span className="ml-2 font-normal normal-case tracking-normal text-fg-faint">
          ⌘-click adds more spots
        </span>
      </h3>
      {
        <div className="flex flex-col gap-[7px] border border-ink-600 bg-ink-700 px-[11px] py-[10px]">
          {pendingTargets.length > 1 ? (
            /* One chip per collected spot - the note below covers them all,
               and any spot can leave without discarding the draft. */
            <div className="flex flex-col gap-1" data-test="pending-targets">
              {pendingTargets.map((t, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: anchors have no id and the list only ever shrinks from a fixed pick order.
                <div key={i} data-test="target-chip" className="flex items-start gap-1.5">
                  <div className="min-w-0 flex-1">
                    <TargetSnippet target={t} />
                  </div>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          aria-label={`Remove spot ${i + 1}`}
                          onClick={() => removePendingTarget(i)}
                          className={`${closeButtonSmall} hover:text-rust-300`}
                        >
                          ×
                        </button>
                      }
                    />
                    <TooltipContent>Remove this spot</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          ) : (
            <TargetSnippet target={pendingTarget} />
          )}
          <Chips images={pastedImages} onRemove={removePastedImage} />
          <textarea
            ref={ref}
            rows={3}
            data-test="annotation-note"
            disabled={forking}
            placeholder="What should change here? Paste an image to show it. (Enter to queue, Shift+Enter for a new line, Esc to discard)"
            value={composerNote}
            onChange={(e) => setComposerNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                discardPending();
                return;
              }
              onSubmitKey(e, addToQueue);
            }}
            onPaste={(e) => {
              const files = imagesFromPaste(e);
              if (files.length === 0) return pastes.collapseTextPaste(e); // text: folds only if large
              e.preventDefault();
              for (const f of files) void addPastedImage(f);
            }}
            className={field}
          />
          {/* One-tap canned notes. Clicking queues that note for this pick, the
              same as typing it and pressing Enter - no textarea detour for the
              asks that recur. */}
          <div className="flex flex-wrap gap-1.5">
            {QUICK_REPLIES.map((r) => (
              <button
                key={r}
                type="button"
                data-test="quick-reply"
                onClick={() => queueQuickReply(r)}
                className="cursor-pointer border border-ink-500 bg-ink-800 px-2.5 py-1 text-[11px] text-cream-300 hover:border-accent hover:text-fg"
              >
                {r}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-test="add-to-queue"
              onClick={addToQueue}
              className={`${btnPrimary} flex items-center gap-1.5`}
            >
              Add to queue
              <Kbd className="border-on-accent/30 bg-on-accent/10 text-on-accent">↵</Kbd>
            </button>
            <button type="button" data-test="discard" onClick={discardPending} className={btn}>
              Discard
            </button>
            {/* The one composer action that starts something new instead of
                changing this artifact: spin the selection off into its own
                artifact + session. The note above is the directive. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    data-test="fork"
                    onClick={forkPending}
                    // A fork's seed is ONE selection; the fork wire carries one
                    // target, and silently forking only the first collected spot
                    // would drop the rest of the draft. Disabled beats lossy.
                    disabled={forking || pendingTargets.length > 1}
                    className={`${btn} ml-auto disabled:cursor-default disabled:opacity-50`}
                  >
                    {forking ? "Forking…" : "Fork"}
                  </button>
                }
              />
              <TooltipContent>
                {pendingTargets.length > 1
                  ? "Fork takes a single spot - remove the extra chips first"
                  : "Spin this selection off into a new artifact and agent session"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      }
    </section>
  );
};
