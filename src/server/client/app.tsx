/**
 * The browser surface, client side.
 *
 * The record is the source of truth, so this component never owns
 * conversation state. It polls the projection the server derives from the
 * log and replaces its message list wholesale. Sending appends an input and
 * then waits for the next poll to show it, exactly as the terminal does —
 * nothing is rendered because the browser believes it happened.
 *
 * assistant-ui supplies the thread through `useExternalStoreRuntime`, which
 * is the adapter for precisely this shape: state lives elsewhere, the
 * runtime renders it. The styled `Thread` component is not part of the
 * library (0.10 ships primitives and generates the styled layer into the
 * consuming project), so the small composition below is that layer.
 *
 * The token is fetched from the server rather than baked in, because the
 * page is a static bundle. A restart mints a new one, so a page holding the
 * old token gets 401 and stops; it does not retry against a server that
 * will never accept it.
 */
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  getExternalStoreMessage,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useMessage,
  useThreadComposer,
} from "@assistant-ui/react";
import * as Popover from "@radix-ui/react-popover";
import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  type Annotation,
  type AnnotationSpot,
  type AttachedFile,
  clampSnippet,
  encodeAnnotationBatch,
  NOTE_QUEUE_MAX,
  queueAdmits,
} from "../../protocol/annotations.js";
import { ARTIFACT_TITLE_MAX } from "../../protocol/artifact-title.js";
import { ATTACHMENT_BYTES_MAX } from "../../protocol/attachment.js";
import { type Activity as ActivitySnapshot, describeActivity, type Report } from "./activity.js";
import {
  type Confidence,
  resolveSpot,
  type SpotSelectors,
  selectorsFor,
  selectorsForQuote,
  sha256Hex,
} from "./anchor.js";
import {
  chooseEffort,
  chooseHarness,
  chooseModel,
  type DriverChoiceBody,
  type DriverChoices,
  type DriverPreference,
  driverLineState,
  effortGloss,
  type MenuKey,
} from "./driver-menus.js";
import { isModeToggle, isQueueSend } from "./hotkeys.js";
import {
  ArchiveDuotone,
  ArrowDownDuotone,
  ArrowRightDuotone,
  ArrowUpDuotone,
  CaretDownDuotone,
  CheckDuotone,
  FileDuotone,
  FileTextDuotone,
  ImageDuotone,
  LockDuotone,
  PaperclipDuotone,
  PaperPlaneTiltDuotone,
  PencilDuotone,
  ProhibitDuotone,
  TableDuotone,
  XDuotone,
} from "./icons.js";
import { ELEMENT_ID, FRAME_MESSAGE_SOURCE, instrumentArtifact } from "./instrument.js";
import {
  CONVERSATION_MAX,
  CONVERSATION_MIN,
  clampConversationWidth,
  readConversationWidth,
  writeConversationWidth,
} from "./layout.js";
import { formatRoute, parseRoute, type Route, sameRoute } from "./route.js";
import { seamsForLost } from "./seams.js";
import { type Msg, type PendingNote, type SentBatch, weaveNotes } from "./timeline.js";
import { diffVersions, type VersionDiff } from "./version-diff.js";
import { isReadOnly, versionState } from "./version-state.js";

/** Kept in step with the server's own poll interval. */
/** How wide a column must be for two of them to beat one.
 *
 * Policy, not measured: RFC-07 R9 names the number and says so. A line of
 * markup in a column narrower than this wraps so often that the comparison
 * is harder to read than the two versions separately. */
const COMPARE_COLUMN_MIN = 360;

const POLL_MS = 500;
const TOKEN_HEADER = "x-lucid-token";

interface Line {
  readonly kind: "agent" | "human";
  readonly seq?: number;
  readonly text: string;
  readonly mark?: string;
  readonly aborted?: boolean;
  readonly event?: string;
  readonly batch?: SentBatch;
}

/** The artifact's name, and renaming it in place.
 *
 * Renaming writes a title and never touches `artifactId`, so nothing that
 * points at the artifact moves: existing notes still resolve, and the
 * agent's next `replaces` still names the thing it means. It also writes no
 * version, so naming a document does not appear in its history as a change
 * to the document.
 *
 * The name is a button until you press it, and a field while you type. There
 * is no separate edit affordance to find, and nothing to dismiss when you
 * change your mind: Escape puts it back.
 */
const DocName = ({
  artifactId,
  title,
  onRename,
}: {
  artifactId: string;
  title?: string;
  onRename: (title: string) => Promise<string | null>;
}): React.ReactElement => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const shown = displayName({ artifactId, ...(title === undefined ? {} : { title }) });

  const commit = async (): Promise<void> => {
    const next = draft.trim();
    // Renaming to what it already says, or to nothing, is not a rename.
    if (next === "" || next === shown) {
      setEditing(false);
      setProblem(null);
      return;
    }
    const why = await onRename(next);
    if (why !== null) {
      setProblem(why);
      return;
    }
    setEditing(false);
    setProblem(null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="doc-id doc-rename"
        title={
          title === undefined
            ? `${artifactId} — click to name it`
            : `${artifactId} — click to rename`
        }
        onClick={() => {
          setDraft(shown);
          setProblem(null);
          setEditing(true);
        }}
      >
        {shown}
        {/* The affordance, on approach only: the name is the most
            prominent word in the bar and needs no standing label beside it. */}
        <span className="pencil">
          <PencilDuotone size={14} />
        </span>
      </button>
    );
  }
  return (
    <span className="doc-id doc-renaming">
      <input
        className="doc-rename-input"
        value={draft}
        // The stored bound. The field refuses the 201st character rather
        // than letting you type a name the endpoint will then reject.
        maxLength={ARTIFACT_TITLE_MAX}
        aria-label="Name this artifact"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
            setProblem(null);
          }
        }}
        onBlur={() => void commit()}
      />
      {problem === null ? null : <span className="doc-rename-problem">{problem}</span>}
    </span>
  );
};

/** What to call an artifact on screen.
 *
 * The id is the fallback, not a placeholder to be styled differently: an
 * artifact nobody has renamed is displayed by its id, and that is a complete
 * answer rather than a missing one. `artifactId` never moves, so this is the
 * only thing a rename changes. */
const displayName = (a: { readonly artifactId: string; readonly title?: string }): string =>
  a.title !== undefined && a.title !== "" ? a.title : a.artifactId;

/** What the frame reports for one pick, before it is stored.
 *
 * `quote` is the text a person dragged over, and it is deliberately not part
 * of `AnnotationSpot`: the record expresses it as `selectors.quote.exact`,
 * measured against the document's own bytes rather than against the frame's
 * instrumented copy. This carries it the short distance between the two. */
type CapturedSpot = AnnotationSpot & { readonly quote?: string };

/** `activity.ts` owns the shape and the rule that reads it. */
type Activity = ActivitySnapshot;

interface Driver {
  readonly harness?: string;
  readonly profile?: string;
  readonly model?: string;
  readonly harnessVersion?: string;
}

/** The driver as the conversation header names it: harness, then model.
 * Derived from the same Driver the line under the composer renders (7a-7d),
 * so the header above and the line below can never disagree about who is
 * driving. Null when the record carries no identity at all; an interactive
 * attachment names no harness (RFC-03), so a model alone still names what
 * is known. */
const driverHeadline = (driver: Driver): string | null => {
  const known = [driver.harness, driver.model].filter((p): p is string => p !== undefined);
  return known.length === 0 ? null : known.join(" · ");
};

/** The conversation, and now the artifact and the version, are named by the
 * URL and never by the bundle. `route.ts` owns the shape. */
const routeFromPath = (): Route | null => parseRoute(window.location.pathname);

const linesToMessages = (lines: readonly Line[]): Msg[] =>
  lines
    .filter((l) => l.text.trim() !== "")
    .map((l, i) => ({
      id: l.seq === undefined ? `l-${i}` : `s-${l.seq}-${i}`,
      ...(l.seq === undefined ? {} : { seq: l.seq }),
      role: l.kind === "agent" ? ("assistant" as const) : ("user" as const),
      text: l.text,
      ...(l.event === "tool" ? { tool: true } : {}),
      ...(l.event === "error" || l.event === "limit"
        ? { refusal: true }
        : l.event === "failure"
          ? { refusal: true, harnessFailed: true }
          : {}),
      ...(l.batch === undefined ? {} : { sentBatch: l.batch }),
    }));

/** Who said it has to survive into the DOM: a transcript where the person
 * and the agent look identical is not a transcript. The role is not on the
 * message element, so it is read through `If` and written as a class. */
/** How a sent note re-attached in the version on screen, keyed by what the
 * note said and what it pointed at. Context rather than a prop because the
 * component is handed to assistant-ui, which does the rendering. */
const Resolutions = React.createContext<
  ReadonlyMap<
    string,
    {
      lost: boolean;
      later: boolean;
      how: string | null;
      elementId: string | null;
      /** The version the note was made against: where a lost note still
       * reads, and what "Open vNN beside this" opens. */
      fromVersion: number;
    }
  >
>(new Map());

/** Hold one version against the one on screen (6b). Context for the same
 * reason `Resolutions` is: the message component cannot take a prop. */
const CompareWith = React.createContext<((version: number) => void) | null>(null);

/** A thumbnail for a stored attachment, by hash. Returns the object URL if
 * the bytes are an image, null when they are not or could not be read.
 * Context, ditto: the chips inside note cards are rendered by assistant-ui. */
const ThumbFor = React.createContext<((hash: string) => Promise<string | null>) | null>(null);

/** Go to what a note points at.
 *
 * Context for the same reason `Resolutions` is: the message component is
 * handed to assistant-ui, which does the rendering, so nothing can be passed
 * down as a prop. `null` while no document is on screen. */
const FocusSpot = React.createContext<((ids: readonly string[]) => void) | null>(null);

/** The anchoring bands: how confidently a sent note still points where it
 * did (handoff, "Anchoring bands").
 *
 * Three 5x9px bars - accent filled, accent-300 outline empty - read at a
 * glance what the head wording used to spell out. Lost and not-on-this-
 * version are shapes instead: a grey bar and a dashed outline. A fact about
 * history, never an error, so nothing here is magenta. */
const Bands = ({
  how,
  lost,
  later,
}: {
  how: string | null;
  lost: boolean;
  later: boolean;
}): React.ReactElement | null => {
  if (lost) return <span className="bands lost" aria-hidden="true" />;
  if (later) return <span className="bands later" aria-hidden="true" />;
  // Made against the version on screen, or found verbatim: still exact.
  // Reworded but matched: two. Matched without the words agreeing - by
  // position or by path - one bar and a label that says to check it.
  const filled = how === null || how === "exact" ? 3 : how === "approximate" ? 2 : 1;
  return (
    <span className="bands" aria-hidden="true">
      {[1, 2, 3].map((n) => (
        <span key={n} className={n <= filled ? "b on" : "b"} />
      ))}
    </span>
  );
};

/** A file a SENT note carried (4a state 6, mapped to the note card). Inside
 * the turn the chips lose their x and keep their size; the image reads its
 * bytes back through the same token-checked fetch the composer uses, once,
 * and stands on the design's placeholder until then. */
const SentFileChip = ({ file }: { file: AttachedFile }): React.ReactElement => {
  const thumbFor = React.useContext(ThumbFor);
  const [url, setUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    if (file.contentType.startsWith("image/")) {
      void thumbFor?.(file.hash).then((u) => {
        if (alive) setUrl(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [file.hash, file.contentType, thumbFor]);
  if (file.contentType.startsWith("image/")) return <ImageChip name={file.name} url={url} />;
  return <PillChip name={file.name} contentType={file.contentType} bytes={file.bytes} />;
};

/** The lost-note light (6a, "Target lost"): clicking a note with nowhere to
 * go lights the note itself, in the conversation, and nothing in the
 * document pane moves. Not drawn as an error - the light is the same accent
 * wash a found target takes, and it fades on the same 2.6s the pulse uses. */
const useLostLight = (): {
  lit: string | null;
  light: (key: string) => void;
} => {
  const [lit, setLit] = React.useState<string | null>(null);
  const timer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const light = React.useCallback((key: string): void => {
    setLit(key);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setLit(null), 2600);
  }, []);
  return { lit, light };
};

const Message = (): React.ReactElement => {
  const resolutions = React.useContext(Resolutions);
  const focusSpot = React.useContext(FocusSpot);
  const compareWith = React.useContext(CompareWith);
  const { lit, light } = useLostLight();
  const resolutionFor = (note: string, snippet: string) =>
    resolutions.get(`${note}\u0000${snippet}`);
  // A tool call is the agent working, not the agent talking. Rendered as a
  // message it looks like something to read, and six of them in a row bury
  // the one thing that was.
  const original = useMessage((m) => getExternalStoreMessage<Msg>(m));
  const one = Array.isArray(original) ? original[0] : original;

  if (one?.tool === true) {
    return (
      <MessagePrimitive.Root>
        <div className="msg tool">
          <span className="tool-mark">⚙</span>
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.sentBatch !== undefined) {
    const b = one.sentBatch;
    return (
      <MessagePrimitive.Root>
        <div className="batch">
          {b.notes.map((n) => {
            const spot = n.spots[0];
            const status = resolutionFor(n.note, spot?.snippet ?? "");
            // Somewhere to go, and something to go there with. A lost note
            // and a note written against another version both stay inert:
            // there is no target, and scrolling somewhere arbitrary is worse
            // than not moving.
            // Every spot the note covers, in the order they were written.
            // A note can point at several elements and all of them are part
            // of what it is about.
            const targets = n.spots
              .map((sp) => resolutionFor(n.note, sp.snippet)?.elementId ?? null)
              .filter((id): id is string => id !== null);
            const canGo = focusSpot !== null && targets.length > 0;
            // The band reads off the same resolution the travel rule does.
            // A note made against the version on screen resolves to nothing
            // special - which is the exact case, three bars. No entry at
            // all means the resolutions have not landed yet: no band, no
            // claim, rather than a guess dressed as a fact.
            const how = status === undefined ? undefined : status.how;
            const lost = status?.lost === true;
            const state =
              status === undefined
                ? `sent · v${b.version}`
                : lost
                  ? "lost · nothing left to point at"
                  : status.later === true
                    ? "not on this version"
                    : how === "approximate"
                      ? "reworded, found anyway"
                      : how === "position" || how === "css"
                        ? "a guess · worth checking"
                        : "still exact";
            // 6a: a lost note is still clickable. There is nowhere to
            // travel to, so the click lights the note here instead - the
            // document never moves.
            const lostKey = `${n.note}:${spot?.id ?? ""}`;
            const goLost = (): void => light(lostKey);
            const fromVersion = status?.fromVersion;
            return (
              <React.Fragment key={lostKey}>
                <div
                  className={[
                    "note-card",
                    lost ? "orphan" : status?.later === true ? "later" : "sent",
                    canGo ? "goes" : "",
                    lit === lostKey ? "lit" : "",
                  ]
                    .filter((c) => c !== "")
                    .join(" ")}
                  {...(canGo
                    ? {
                        role: "button" as const,
                        tabIndex: 0,
                        title: "Go to what this note is about",
                        onClick: () => focusSpot?.(targets),
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            focusSpot?.(targets);
                          }
                        },
                      }
                    : lost
                      ? {
                          role: "button" as const,
                          tabIndex: 0,
                          title: "Nothing to go to - the passage is gone from this version",
                          onClick: goLost,
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              goLost();
                            }
                          },
                        }
                      : {})}
                >
                  <span className="note-card-head">
                    <span className="note-card-kind">Your note</span>
                    {status === undefined ? null : (
                      <Bands how={how ?? null} lost={status.lost} later={status.later} />
                    )}
                    <span className="note-card-state">{state}</span>
                  </span>
                  <span className="note-card-quote">
                    {n.spots.map((sp) => `“${sp.snippet.slice(0, 44)}”`).join(", ")}
                  </span>
                  <span className="note-card-note">{n.note}</span>
                  {/* Sent attachments ride the note: read, never imported.
                      The "read in full - N words, N rows" confirmation line
                      is NOT drawn, because the client would have to compute
                      it and the record never states it; the agent's own turn
                      text carries whatever it measured. */}
                  {n.files === undefined || n.files.length === 0 ? null : (
                    <span className="note-card-files">
                      {n.files.map((f) => (
                        <SentFileChip file={f} key={f.hash} />
                      ))}
                    </span>
                  )}
                </div>
                {/* 3e / 6a: a lost note still reads on the version it was
                    written against, and the way to see that is the compare
                    view - the passage beside its absence. */}
                {lost && fromVersion !== undefined && compareWith !== null ? (
                  <div className="card">
                    <div className="card-title">A lost note is a fact, not an error.</div>
                    <div className="card-body">
                      The words it was attached to are not in this version. It stays in the
                      conversation, and it still reads on v{fromVersion}, where the passage lives.
                    </div>
                    <div className="card-actions">
                      <button type="button" onClick={() => compareWith(fromVersion)}>
                        Open v{fromVersion} beside this
                      </button>
                    </div>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.pendingNote !== undefined) {
    const pn = one.pendingNote;
    return (
      <MessagePrimitive.Root>
        {/* Yours until it is sent: the accent rule and the word queued say
            whose it is and that nothing has left the page yet. */}
        <div className="note-card pending">
          <span className="note-card-head">
            <span className="note-card-kind">Your note</span>
            <span className="note-card-state">queued · still yours to change</span>
          </span>
          <span className="note-card-quote">
            {pn.spots.map((sp) => `“${sp.snippet.slice(0, 44)}”`).join(", ")}
          </span>
          <span className="note-card-note">{pn.note}</span>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.refusal === true) {
    // The substrate saying no, which is why the document did not change.
    // Magenta and unmistakable, never alongside cyan in the same row: this
    // is the one transcript kind that is not anybody talking. The terminal
    // view prefixes the reason with a cross or a bang; the row already
    // names who refused, so the prefix goes. Who said no differs: lucid
    // refusing an input, or the harness failing a turn - a rate limit is
    // the upstream refusing service, and the reader needs to know it was
    // not lucid and not the agent.
    const said = one.text.replace(/^([✗!])\s+/, "");
    const who = one.harnessFailed === true ? "the turn failed" : "lucid refused";
    return (
      <MessagePrimitive.Root>
        <div className="msg refusal">
          <div className="refusal-head">
            <ProhibitDuotone size={12} />
            <span className="refusal-kind">{who}</span>
          </div>
          <div className="body">{said}</div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (one?.note === true) {
    return (
      <MessagePrimitive.Root>
        <div className="msg happened">
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.Root>
    );
  }

  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.If user>
        <div className="msg user">
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.If>
      {/* No label: the side says whose it is. Yours is the bubble on the
          right; the agent's is the open text on the left. */}
      <MessagePrimitive.If assistant>
        <div className="msg agent">
          <div className="body">
            <MessagePrimitive.Parts />
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
};

/** The scroll behaviour is assistant-ui's, not lucid's.
 *
 * `Viewport autoScroll` watches the content with a ResizeObserver and
 * tracks whether you are at the bottom: new content follows you down when
 * you are there, and leaves you alone when you have scrolled up. The
 * ResizeObserver is the part a hand-rolled version gets wrong — text
 * reflows after the effect runs, which leaves the viewport short of the
 * end.
 *
 * `ScrollToBottom` is its affordance for getting back, and it hides itself
 * when you are already there. */
/** A file attached to the message being written. Stored already - the hash
 * is the record's, not the page's - so the page holds a reference and a URL
 * to show it by, never a second copy of the bytes. */
interface Attached {
  readonly hash: string;
  readonly name: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly text: boolean;
  /** An object URL for the thumbnail, or null for a file with no picture.
   *
   * An object URL rather than the endpoint's own: an `img` tag cannot send
   * the token header every `/api/` path requires, and putting a token in a
   * URL puts it in logs and referrers. The page fetches the bytes with the
   * header and shows what it already holds. */
  readonly url: string | null;
}

/** A file on its way to the store. The bytes are known the moment they are
 * chosen - `file.size` - and that is all the chip claims: a count, never a
 * percentage, because a fetch cannot report how much of the body has left. */
interface Uploading {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
}

/** The substrate refusing an attach or a send (4a state 5, G2). The reason
 * rides on the chip and stays until it is dismissed: a toast that leaves on
 * its own would take the only statement of what happened with it. */
interface Refusal {
  readonly id: string;
  /** What was refused, when the refusal is about a file. */
  readonly name: string | null;
  readonly reason: string;
}

/** "18 KB", "3.4 MB" - one decimal under ten, whole above, as the design
 * writes sizes on its chips. */
const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const shown = v >= 10 || Number.isInteger(v) ? Math.round(v) : Number(v.toFixed(1));
  return `${shown} ${units[u] as string}`;
};

/** The glyph a chip carries when it has no picture. What the file IS, read
 * off its name and claimed type, in the design's own small vocabulary. */
const FileGlyph = ({
  contentType,
  name,
}: {
  contentType: string;
  name: string;
}): React.ReactElement => {
  const lower = name.toLowerCase();
  if (/\.(zip|gz|tar|7z|bz2|xz)$/.test(lower)) return <ArchiveDuotone size={14} />;
  if (/\.(csv|tsv)$/.test(lower)) return <TableDuotone size={14} />;
  if (contentType.startsWith("text/") || /\.(md|txt|json|ya?ml|html?)$/.test(lower))
    return <FileTextDuotone size={14} />;
  if (contentType.startsWith("image/")) return <ImageDuotone size={14} />;
  return <FileDuotone size={14} />;
};

/** One attached image, as the design draws it: a 64px thumb, the filename on
 * a translucent ink strip along the bottom, an x in the corner while it can
 * still be taken off. `url` null means the bytes are an image the page has
 * not read back - the dot-screen placeholder stands in until they arrive. */
const ImageChip = ({
  name,
  url,
  onRemove,
}: {
  name: string;
  url: string | null;
  onRemove?: () => void;
}): React.ReactElement => (
  <span className="chip imgchip" title={name}>
    {url === null ? (
      <span className="thumb-img none" aria-hidden="true">
        <ImageDuotone size={18} />
      </span>
    ) : (
      <img src={url} alt="" className="thumb-img" />
    )}
    <span className="thumb-name">{name}</span>
    {onRemove === undefined ? null : (
      <button type="button" className="chip-x corner" title="Remove" onClick={onRemove}>
        <XDuotone size={9} />
      </button>
    )}
  </span>
);

/** One attached file that is not a picture: a 32px pill - glyph, name (128px
 * at most), size, and an x while it is still removable. */
const PillChip = ({
  name,
  contentType,
  bytes,
  onRemove,
}: {
  name: string;
  contentType: string;
  bytes: number;
  onRemove?: () => void;
}): React.ReactElement => (
  <span className="chip pill">
    <span className="chip-glyph" aria-hidden="true">
      <FileGlyph contentType={contentType} name={name} />
    </span>
    <span className="chip-name">{name}</span>
    <span className="chip-size">{fmtBytes(bytes)}</span>
    {onRemove === undefined ? null : (
      <button type="button" className="chip-x" title="Remove" onClick={onRemove}>
        <XDuotone size={10} />
      </button>
    )}
  </span>
);

/** A file on its way in (4a state 3): the same pill with a 2px accent line
 * along its bottom edge and the byte count where the size goes. No x - a
 * fetch in flight cannot be taken back. */
const UploadingChip = ({ name, bytes }: { name: string; bytes: number }): React.ReactElement => (
  <span className="chip pill uploading" title={name}>
    <span className="chip-glyph" aria-hidden="true">
      <FileGlyph contentType="" name={name} />
    </span>
    <span className="chip-name">{name}</span>
    <span className="chip-size">{fmtBytes(bytes)}</span>
  </span>
);

/** A refusal (4a state 5): magenta, the reason on the chip, and it stays
 * until it is dismissed. */
const RefusalChip = ({
  name,
  reason,
  onDismiss,
}: {
  name: string | null;
  reason: string;
  onDismiss: () => void;
}): React.ReactElement => (
  <span className="chip pill refused">
    {name === null ? null : <span className="chip-name">{name}</span>}
    <span className="chip-reason">{reason}</span>
    <button type="button" className="chip-x" title="Dismiss" onClick={onDismiss}>
      <XDuotone size={10} />
    </button>
  </span>
);

/** What the mode segment's hover gloss says, one string per mode. Verbatim
 * from the product's mode table (CONTEXT.md) as the handoff requires, so
 * the surface and the docs cannot drift. */
const MODE_GLOSS: Readonly<Record<string, string>> = {
  interactive:
    "A terminal session you own. lucid attaches, records everything, and can interject — it does not drive.",
  "headless-session":
    "lucid spawns the harness and drives it. The harness recalls its own session across restarts.",
  "headless-turn":
    "No session recall. Each send starts the harness fresh; lucid's record is what carries continuity.",
};

/** One row of a driver menu (7a): a 12px gutter carries the check when the
 * row is the selected one, so every label aligns whether or not it is
 * chosen. Effort rows carry a gloss under the label - the words alone do
 * not say what is being traded, and only effort rows get one: harness and
 * model name things that name themselves. */
const DriverMenuRow = ({
  label,
  gloss,
  selected,
  onPick,
}: {
  label: string;
  gloss?: string;
  selected: boolean;
  onPick: () => void;
}): React.ReactElement => {
  const hasGloss = gloss !== undefined && gloss !== "";
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={
        selected
          ? hasGloss
            ? "driver-row selected glossed"
            : "driver-row selected"
          : hasGloss
            ? "driver-row glossed"
            : "driver-row"
      }
      onClick={onPick}
    >
      {selected ? (
        <span aria-hidden="true" className="driver-check">
          <CheckDuotone size={12} />
        </span>
      ) : (
        <span aria-hidden="true" className="driver-gutter" />
      )}
      <span className="driver-row-text">
        <span className="driver-row-label">{label}</span>
        {hasGloss ? <span className="driver-gloss">{gloss}</span> : null}
      </span>
    </button>
  );
};

/** The menus' width, from the handoff's drawn values: the model menu draws
 * at 214px and the effort menu at 226px; the harness menu is the same shape
 * as the model's. One constant serves the left clamp. */
const DRIVER_MENU_W = 226;

/** The driver line (7a-7d): harness · mode · model · effort docked under
 * the prompt, in the transcript datelines' voice. The order is the
 * design's - harness, mode and model are one thought (the program, how
 * lucid runs it, the weights); effort alters a turn rather than the
 * connection, so it is last. A segment whose value the record does not
 * carry is absent, not disabled - and so is a blank or a ghost.
 *
 * Harness, model and effort are controls now (RFC-12): hover takes the
 * accent pill, opening takes the segment solid, and a pick POSTs the whole
 * preference - the line and the header settle from the next poll, because
 * nothing renders because the browser believes it happened. Mode stays a
 * report with its hover gloss: it is not settable from the browser, and a
 * control that cannot act is not drawn as one. Interactive offers no
 * menus at all - the human's session chose the driver and lucid cannot
 * change it mid-run - and its harness and model sit at 55% report ink.
 * The conversation header names the same driver through `driverHeadline`,
 * from the same Driver. */
const DriverLine = ({
  driver,
  preference,
  choices,
  onChoose,
  onMenuToggle,
}: {
  driver: Driver;
  /** What the person chose (RFC-12), beside what is driving. The menus'
   * selected rows are these values; the labels are these where only a
   * choice can name the dimension. */
  preference: DriverPreference | null;
  /** The served lists: the four harnesses, each harness's models and
   * efforts. Null when the server did not send them, and then no menu is
   * offered - absent, not disabled. */
  choices: DriverChoices | null;
  /** POST a whole preference. Answers null on success, or why it refused,
   * drawn beside the line that made the choice. */
  onChoose: (body: DriverChoiceBody) => Promise<string | null>;
  /** The line tells the dock when a menu is open, so the composer can dim
   * to 40% and stay in place, per the design. */
  onMenuToggle: (open: boolean) => void;
}): React.ReactElement | null => {
  const mode = driver.profile;
  const wrapper = React.useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = React.useState<{ key: MenuKey; left: number } | null>(null);
  const [choiceError, setChoiceError] = React.useState<string | null>(null);
  const [freeModel, setFreeModel] = React.useState("");
  React.useEffect(() => {
    onMenuToggle(open !== null);
    if (open === null) return;
    // One menu at a time closes on Escape and on a click anywhere outside
    // itself - including on another segment, which opens that one instead.
    const close = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(null);
    };
    const away = (e: PointerEvent): void => {
      if (wrapper.current?.contains(e.target as Node | null) !== true) setOpen(null);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", away);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", away);
    };
  }, [open, onMenuToggle]);
  // A line that unmounts with a menu open must not leave the composer
  // dimmed behind it.
  React.useEffect(() => {
    return () => onMenuToggle(false);
  }, [onMenuToggle]);
  const pick = React.useCallback(
    async (body: DriverChoiceBody | null): Promise<void> => {
      setOpen(null);
      if (body === null) return;
      setChoiceError(null);
      const why = await onChoose(body);
      if (why !== null) setChoiceError(why);
    },
    [onChoose],
  );
  const state = driverLineState({
    profile: mode,
    driverHarness: driver.harness,
    driverModel: driver.model,
    preference,
    choices,
  });
  const interactive = mode === "interactive";
  const gloss = mode === undefined ? undefined : MODE_GLOSS[mode];
  // headless-turn is the one mode whose consequence the line itself
  // states: no session recall has no visual, so it gets words, permanent,
  // and a 4px neutral dot marks the segment that owns them.
  const noRecall = mode === "headless-turn";
  /** Open a segment's menu, its left edge on the segment - clamped so a
   * long label near the column's right edge cannot push the menu into the
   * document pane. Effort never comes here: it opens right-aligned. */
  const openAt = (key: MenuKey, el: HTMLElement): void => {
    const line = wrapper.current;
    let left = el.offsetLeft;
    if (line !== null) left = Math.min(left, Math.max(0, line.clientWidth - DRIVER_MENU_W - 8));
    setFreeModel("");
    setOpen((was) => (was !== null && was.key === key ? null : { key, left }));
  };
  const seg = (key: MenuKey | "mode", label: string): React.ReactElement => {
    if (key === "mode") {
      return (
        <span className="driver-seg mode" key={key}>
          {label}
          {noRecall ? <span aria-hidden="true" className="driver-mode-dot" /> : null}
          {gloss === undefined ? null : (
            <span className="driver-tip" role="tooltip">
              <span className="driver-tip-title">{label}</span>
              <span className="driver-tip-body">{gloss}</span>
            </span>
          )}
        </span>
      );
    }
    const live = state.menus.has(key);
    if (!live) {
      return (
        <span className={interactive ? "driver-seg report" : "driver-seg"} key={key}>
          {label}
        </span>
      );
    }
    const isOpen = open?.key === key;
    return (
      <button
        type="button"
        className="driver-seg pick"
        key={key}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={(e) => openAt(key, e.currentTarget)}
      >
        {label}
        <span aria-hidden="true" className={isOpen ? "driver-caret flipped" : "driver-caret"}>
          <CaretDownDuotone size={9} />
        </span>
      </button>
    );
  };
  const segments: { key: string; el: React.ReactElement }[] = [
    // Nothing driving and nothing chosen still names the state in the
    // product's own words (3d: "No driver"), so the harness menu hangs
    // somewhere and the first choice can be made from the browser - the
    // natural moment, per RFC-12's open question 1. No menu offered, no
    // segment: a line with nothing to say is not drawn.
    ...(state.harness === null && !state.menus.has("harness")
      ? []
      : [{ key: "harness", el: seg("harness", state.harness ?? "no driver") }]),
    // The model segment renders wherever a choice exists, even before one
    // is made: until then the harness's own default runs, and "default
    // model" names that honestly instead of hiding the dimension. Kevin's
    // order (2026-08-29, over the handoff's): provider · model · effort ·
    // mode - the things you can change first, the state that governs them
    // last.
    ...(state.menus.has("model")
      ? [{ key: "model", el: seg("model", state.model ?? "default model") }]
      : state.model === null
        ? []
        : [{ key: "model", el: seg("model", state.model) }]),
    ...(state.effort === null
      ? []
      : [{ key: "effort", el: seg("effort", `${state.effort} effort`) }]),
    ...(mode === undefined ? [] : [{ key: "mode", el: seg("mode", mode) }]),
  ];
  const rowsFor = (key: MenuKey): React.ReactElement[] => {
    if (key === "harness") {
      return (choices?.harnesses ?? []).map((h) => (
        <DriverMenuRow
          key={h}
          label={h}
          selected={h === state.harness}
          onPick={() => void pick(chooseHarness(h, state))}
        />
      ));
    }
    const vocabulary = state.vocabulary;
    if (vocabulary === null) return [];
    if (key === "model") {
      const listed = vocabulary.models.map((m) => (
        <DriverMenuRow
          key={m}
          label={m}
          selected={m === state.model}
          onPick={() => void pick(chooseModel(m, state, preference))}
        />
      ));
      // The open entry (extensible harnesses, RFC-12): pi registers models
      // at runtime, so the listed ids are examples of a kind rather than
      // the kind's whole population.
      // The check sits on the committed choice only: while a new id is
      // being typed, the row is a field, not the selected answer.
      const freeSelected =
        freeModel === "" && state.model !== null && !vocabulary.models.includes(state.model);
      return vocabulary.extensible
        ? [
            ...listed,
            <div className={freeSelected ? "driver-free selected" : "driver-free"} key="free">
              {freeSelected ? (
                <span aria-hidden="true" className="driver-check">
                  <CheckDuotone size={12} />
                </span>
              ) : (
                <span aria-hidden="true" className="driver-gutter" />
              )}
              <input
                aria-label="Another model id"
                onChange={(e) => setFreeModel(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const id = freeModel.trim();
                  if (id !== "") void pick(chooseModel(id, state, preference));
                }}
                placeholder="other model id…"
                spellCheck={false}
                value={freeSelected ? (state.model ?? "") : freeModel}
              />
            </div>,
          ]
        : listed;
    }
    return vocabulary.efforts.map((level) => (
      <DriverMenuRow
        gloss={effortGloss(level, vocabulary.efforts)}
        key={level}
        label={level}
        selected={level === state.effort}
        onPick={() => void pick(chooseEffort(level, state, preference))}
      />
    ));
  };
  // A line with no segments says nothing and is not drawn - the interactive
  // record whose server sent no lists, the dead connection the dock already
  // hides.
  if (segments.length === 0) return null;
  return (
    <div className={interactive ? "driver-line interactive" : "driver-line"} ref={wrapper}>
      {segments.map((s, i) =>
        // Each middot is bound into one flex item with the label that
        // follows it, so a wrap can only break BEFORE a separator - a
        // middot stranded at the end of a row reads as a dropped segment.
        // Labels are never shortened to force one row.
        i === 0 ? (
          <React.Fragment key={s.key}>{s.el}</React.Fragment>
        ) : (
          <span className="driver-pair" key={s.key}>
            <span aria-hidden="true" className="driver-sep">
              ·
            </span>
            {s.el}
          </span>
        ),
      )}
      {noRecall ? (
        <span className="driver-note">
          Each send starts the harness fresh. This record is what carries continuity.
        </span>
      ) : null}
      {choiceError === null ? null : (
        <span className="driver-choice-error">Choice not saved: {choiceError}</span>
      )}
      {open === null ? null : (
        <div
          className={open.key === "effort" ? "driver-menu align-right" : "driver-menu"}
          role="menu"
          style={open.key === "effort" ? undefined : { left: `${open.left}px` }}
        >
          {rowsFor(open.key)}
          {open.key === "effort" ? null : (
            <>
              <div className="driver-menu-rule" />
              <div className="driver-menu-note">
                Changing the model does not restart the conversation.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

const Thread = ({
  pending,
  onSendNotes,
  onDiscardNotes,
  sending,
  report,
  version,
  dead,
  invite,
  collision,
  onSave,
  onShowWaiting,
  attachments,
  uploading,
  refusals,
  onAttach,
  onRemoveAttachment,
  onDismissRefusal,
  driver,
  driverPreference,
  driverChoices,
  onDriverChoice,
}: {
  pending: readonly PendingNote[];
  onSendNotes: () => void;
  onDiscardNotes: () => void;
  sending: boolean;
  /** What the dock said about the agent, moved into the conversation's own
   * status pill (3c, 6e Wait). Neutral ink while it is only a wait; the one
   * warning is the stall. */
  report: Report;
  /** The document's version, for the stall card's facts. Null when no
   * document is on screen. */
  version: number | null;
  /** The connection is dead (3d): the transcript fades, queued notes become
   * one held card, and the composer says so. */
  dead: boolean;
  /** No document yet (3a): the conversation is the way in, so its field is
   * dressed as the thing to do - accent border, ring, solid send. */
  invite: boolean;
  /** A version arrived underneath unsaved edits (3f): the collision card in
   * the conversation offers both answers, and neither destroys anything. */
  collision: { readonly arrived: number; readonly next: number } | null;
  onSave: () => void;
  onShowWaiting: (arrived: number) => void;
  /** Files attached to the message being written, not yet sent. */
  attachments: readonly Attached[];
  uploading: readonly Uploading[];
  refusals: readonly Refusal[];
  onAttach: (files: FileList) => void;
  onRemoveAttachment: (hash: string) => void;
  onDismissRefusal: (id: string) => void;
  /** What is driving, for the driver line docked under the composer
   * (7a-7d) and for the composer's own variant: the mode decides whether
   * the field sends or interjects, and whether the clip button is there. */
  driver: Driver;
  /** What the person chose (RFC-12) and the lists to choose from, both from
   * the poll the client already makes. */
  driverPreference: DriverPreference | null;
  driverChoices: DriverChoices | null;
  /** POST a whole driver preference; answers null or why it refused. */
  onDriverChoice: (body: DriverChoiceBody) => Promise<string | null>;
}): React.ReactElement => {
  const composerBox = React.useRef<HTMLTextAreaElement | null>(null);
  // 4a: send is ghost at rest and solid the moment there is something to
  // send. assistant-ui does not disable its own Send on an empty composer,
  // so the emptiness is read here and the button is disabled by lucid -
  // with attachments counted, because a file alone is something to say.
  const composerText = useThreadComposer((c) => c.text);
  const hasToSay = composerText.trim() !== "" || attachments.length > 0;
  // 4a state 2: a file held over the composer is a drop target. The whole
  // composer takes the dashed accent edge and the field says what will
  // happen. Nothing lands on the document: a file is attached to the
  // conversation or it goes back where it came from - never a version.
  const [dragOver, setDragOver] = React.useState(false);
  /** Whether one of the driver line's menus is open: the composer dims to
   * 40% and stays in place while it is, per 7a. Lifted here because the
   * composer and the line are siblings. */
  const [driverMenuOpen, setDriverMenuOpen] = React.useState(false);
  const onDriverMenu = React.useCallback((open: boolean): void => setDriverMenuOpen(open), []);
  const stalled = report.stalled;
  // 7c: the mode governs the composer too. interactive means a human owns
  // the session - lucid attaches, records, and can interject, it does not
  // drive - so the field says Interject and the clip button is gone. A
  // file dropped on the composer still attaches: storing one is a lucid
  // act, not a driving act.
  const interactive = driver.profile === "interactive";
  return (
    <ThreadPrimitive.Root className={dead ? "thread-root dead" : "thread-root"}>
      {/* The half that scrolls. Only messages and note cards are in here, so
          nothing that has to stay put competes with the scrolling. */}
      <div className="thread-wrap">
        <ThreadPrimitive.Viewport autoScroll className={dead ? "thread dead" : "thread"}>
          <ThreadPrimitive.Empty>
            <div className="empty">Nothing in this conversation yet.</div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ Message }} />

          {/* 6e Wait: progress in accent ink, as the transcript's own last
              row - the scroll absorbs it, so the composer never moves when
              work starts and stops (the dock version reflowed the input).
              The header pill says it too; this row sits where the eyes
              already are. The count joins at the dock's 8-second
              threshold; before that the state alone is the message. */}
          {report.busy && !stalled ? (
            <div className="working-row">
              <span>
                {report.label}
                <span aria-hidden="true" className="working-dots" />
              </span>
              {report.elapsed === null ? null : (
                <span className="working-elapsed"> · {report.elapsed}</span>
              )}
            </div>
          ) : null}

          {/* 3c: the agent stopped mid-turn. A card under the truncated turn
              says what that cost - nothing was written, the version is as it
              was, the queue is intact. The document column does not react.
              "Pick it up" is not offered: no record behaviour resumes a
              stalled turn, and the nearest real act - saying something
              again - is what "Ask again" does. */}
          {stalled ? (
            <div className="card">
              <div className="card-title">The agent stopped here.</div>
              <div className="card-body">
                Nothing was written{version === null ? "" : ` — v${version} is exactly as it was`}
                {pending.length === 0
                  ? ""
                  : `, and your ${pending.length} note${pending.length === 1 ? " is" : "s are"} still queued`}
                .
              </div>
              <div className="card-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => composerBox.current?.focus()}
                >
                  Ask again
                </button>
              </div>
            </div>
          ) : null}

          {/* 3d: queued notes while the connection is dead. Nothing was sent,
              nothing failed, nothing is guessed at - they are held here until
              a driver returns, and the composer below says the same. */}
          {dead && pending.length > 0 ? (
            <div className="held">
              <div className="held-head">
                <span className="held-kind">Held</span>
                <span className="held-state">
                  {pending.length} note{pending.length === 1 ? "" : "s"}, nothing sent
                </span>
              </div>
              <div className="held-body">
                They stay yours until a driver is back. Nothing was lost and nothing was guessed at.
              </div>
            </div>
          ) : null}

          {/* 3f: the agent wrote a version underneath unsaved edits. Both
              answers keep everything, so both are offered and neither is
              styled as a danger. */}
          {collision === null ? null : (
            <div className="card">
              <div className="card-title">
                The agent wrote v{collision.arrived} while you were editing.
              </div>
              <div className="card-body">
                Your copy is held where it is. Both ways forward keep everything — no version is
                ever destroyed.
              </div>
              <div className="card-actions">
                <button type="button" className="primary" onClick={onSave} disabled={sending}>
                  {sending ? "Saving…" : `Save mine as v${collision.next}`}
                </button>
                <button type="button" onClick={() => onShowWaiting(collision.arrived)}>
                  Show v{collision.arrived}
                </button>
              </div>
            </div>
          )}
        </ThreadPrimitive.Viewport>
        <ThreadPrimitive.ScrollToBottom asChild>
          <button type="button" className="to-bottom">
            ↓ latest
          </button>
        </ThreadPrimitive.ScrollToBottom>
      </div>

      {/* The half that does not. One solid block at the bottom: what is
          queued, what is attached, and the box you type in. What is
          happening lives in the conversation's status pill now, not here. */}
      <div className={dead ? "dock dead" : "dock"}>
        {pending.length === 0 ? null : (
          <div className="queue-bar">
            <span>
              {pending.length} note{pending.length === 1 ? "" : "s"} queued
              {/* Only near the bound. A count out of a maximum on an empty
                  queue is a limit nobody was going to reach. */}
              {pending.length >= NOTE_QUEUE_MAX - 4 ? ` of ${NOTE_QUEUE_MAX}` : ""}
            </span>
            <button
              type="button"
              className="primary"
              onClick={onSendNotes}
              disabled={sending}
              title="Send the queued notes (⌘⏎)"
            >
              {sending ? "Sending…" : "Send ⌘⏎"}
            </button>
            <button type="button" className="discard" onClick={onDiscardNotes} title="Discard them">
              ×
            </button>
          </div>
        )}

        {uploading.length + attachments.length + refusals.length === 0 ? null : (
          <div className="attached">
            {uploading.map((u) => (
              <UploadingChip key={u.id} name={u.name} bytes={u.bytes} />
            ))}
            {attachments.map((a) =>
              a.url !== null || a.contentType.startsWith("image/") ? (
                <ImageChip
                  key={a.hash}
                  name={a.name}
                  url={a.url}
                  onRemove={() => onRemoveAttachment(a.hash)}
                />
              ) : (
                <PillChip
                  key={a.hash}
                  name={a.name}
                  contentType={a.contentType}
                  bytes={a.bytes}
                  onRemove={() => onRemoveAttachment(a.hash)}
                />
              ),
            )}
            {refusals.map((r) => (
              <RefusalChip
                key={r.id}
                name={r.name}
                reason={r.reason}
                onDismiss={() => onDismissRefusal(r.id)}
              />
            ))}
          </div>
        )}

        <ComposerPrimitive.Root
          className={
            dragOver
              ? "composer dragover"
              : invite
                ? "composer inviting"
                : driverMenuOpen
                  ? "composer driver-open"
                  : "composer"
          }
          onDragOver={(e) => {
            // Without the preventDefault the drop never fires and the
            // browser navigates to the file instead.
            if (e.dataTransfer?.types.includes("Files") !== true) return;
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const files = e.dataTransfer?.files;
            if (files !== undefined && files.length > 0) onAttach(files);
          }}
        >
          {/* Attaching and sending are separate: the file is stored the
            moment it is chosen, so closing the page does not lose it and
            sending is the ordinary act it already was. 38px, matching send,
            as the design's one new piece of composer chrome. Interactive
            has none of it (7c): interjecting carries words into a session
            a human owns. */}
          {interactive ? null : (
            <label className="attach" title="Attach a file">
              <PaperclipDuotone size={16} />
              <input
                type="file"
                multiple
                onChange={(e) => {
                  if (e.currentTarget.files !== null) onAttach(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          )}
          <ComposerPrimitive.Input
            autoFocus
            ref={composerBox}
            className={dragOver ? "drop" : undefined}
            disabled={dead}
            placeholder={
              dead
                ? "Reload to write…"
                : dragOver
                  ? "Drop to attach — the original is kept"
                  : interactive
                    ? "Interject…"
                    : "Send to the conversation…"
            }
            rows={1}
          />
          <ComposerPrimitive.Send asChild>
            <button
              type="submit"
              className="send"
              title="Send"
              aria-label="Send"
              disabled={dead || !hasToSay}
            >
              <PaperPlaneTiltDuotone size={16} />
            </button>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>

        {/* 7a-7d: the driver line, docked under the prompt and named from
            the same projection the header names. Dead hides it: 3d's
            composer says Reload and names no driver, and a stale one
            would. */}
        {dead ? null : (
          <DriverLine
            driver={driver}
            preference={driverPreference}
            choices={driverChoices}
            onChoose={onDriverChoice}
            onMenuToggle={onDriverMenu}
          />
        )}
      </div>
    </ThreadPrimitive.Root>
  );
};
interface CatalogEntry {
  readonly artifactId: string;
  /** What to display. Absent from an older server and from an artifact
   * nobody has renamed, in which case the id is displayed (RFC-07 R11). */
  readonly title?: string;
  readonly versions: readonly number[];
  readonly latest: number;
  readonly authors?: Readonly<Record<number, string>>;
  /** Per version, the seq of the last line before it: where in the
   * conversation it belongs. Absent from an older server, in which case a
   * saved version has no place and is left out rather than guessed at. */
  readonly afterSeq?: Readonly<Record<number, number>>;
}

interface Doc {
  readonly artifactId: string;
  readonly version: number;
  readonly contentType: string;
  readonly bytes: string;
}

/** How often the document channel is asked for news.
 *
 * Slower than the conversation on purpose. A transcript changes constantly
 * and costs a few lines; a document changes rarely and costs its whole
 * size. Only the catalog is polled — it is versions and ids, no bytes — and
 * a version is fetched once, when it turns out to be new. */
const CATALOG_POLL_MS = 2000;

/** The document, in a frame the page cannot reach into.
 *
 * `srcdoc` hands the frame its bytes; the frame fetches nothing, so a
 * document that names an external image or script gets neither.
 *
 * The sandbox has no `allow-same-origin`, which is the whole point. With
 * it the parent could read into the frame — and the frame could read back
 * out, into a page holding a token with read and write on every record.
 * The document is written by an agent, so that reach is not one to grant.
 * Without it the frame is an opaque origin: nothing crosses in either
 * direction. `allow-scripts` alone is safe precisely because the origin is
 * opaque; the two together would not be.
 *
 * `key` is the version, so a new version replaces the frame rather than
 * mutating it. There is no in-place update path to get wrong. */
/** Where a selection sits inside the frame, in the frame's own viewport. */
interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame is not trusted, so the rect is checked like anything else it
 * sends. A bad one means no anchor, not a thrown render. */
const readRect = (raw: unknown): SelectionRect | null => {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const nums = [r.x, r.y, r.width, r.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
  };
};

const DocumentFrame = ({
  doc,
  onSelection,
  capture,
  snapshot,
  deselect,
  focusSpot,
  place,
  restorePlace,
  pendingRestore,
  pendingPulse,
  pulseBlocks,
  goBlock,
  onOffscreen,
  onTravel,
  onMarksBelow,
  onSeamClick,
  seams,
  onHotkey,
  onDirty,
  noteCounts,
  mode,
  readOnly,
}: {
  doc: Doc;
  onSelection: (ids: readonly string[], rect: SelectionRect | null) => void;
  /** Handed the frame's answer to a capture request. */
  capture: React.MutableRefObject<((ids: readonly string[]) => Promise<CapturedSpot[]>) | null>;
  /** Handed the frame's answer to a snapshot request: the document as it now
   * reads, with lucid's instrumentation taken back out, and the values of
   * the controls the agent authored. */
  snapshot: React.MutableRefObject<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >;
  /** Handed a way to drop the frame's selection, for backing out of a note. */
  deselect: React.MutableRefObject<(() => void) | null>;
  focusSpot: React.MutableRefObject<((ids: readonly string[]) => void) | null>;
  place: React.MutableRefObject<{ version: number; index: number; top: number } | null>;
  restorePlace: React.MutableRefObject<((index: number, top: number) => void) | null>;
  pendingRestore: React.MutableRefObject<{ index: number; top: number } | null>;
  pendingPulse: React.MutableRefObject<readonly number[] | null>;
  pulseBlocks: React.MutableRefObject<((indexes: readonly number[]) => void) | null>;
  goBlock: React.MutableRefObject<((index: number) => void) | null>;
  /** Which changed blocks the reader could not see, and which edge they sit
   * at (6a): the ones below pulse and are not offered; the ones above and
   * below are offered at the nearer edge instead. */
  onOffscreen: (below: readonly number[], above: readonly number[]) => void;
  /** A note's target sat off screen (6a): the frame did not scroll, and the
   * page docks a travel offer at the edge nearest the target instead. */
  onTravel: (index: number, below: boolean) => void;
  /** Which noted blocks sit wholly below the fold (3g), pushed by the frame
   * as the reader scrolls and as notes land. */
  onMarksBelow: (indexes: readonly number[]) => void;
  /** A seam was clicked: open the version where the passage still lives. */
  onSeamClick: (version: number) => void;
  /** Where a lost note pointed (3e). Sent again whenever it changes and once
   * the frame says it is ready. */
  seams: readonly { before: number; label: string; version: number }[];
  /** A key the frame caught that means something to the whole page. */
  onHotkey: (which: "toggle-mode" | "send-queue") => void;
  /** The frame says the person changed something in it, and how many blocks
   * carry an edit - the quantity the discard dialog names (6c). */
  onDirty: (edits: number) => void;
  /** How many notes each block has carried, sent or queued. Drives the
   * count chip - the one persistent mark - so the frame is told counts,
   * not just presence: the chip is a tally, not a flag. */
  noteCounts: ReadonlyMap<string, number>;
  mode: "edit" | "annotate";
  /** A version that is not the current one. Neither editable nor markable
   * (RFC-07 R6, R7). Not a third mode: the mode still stands, and applies
   * again the moment the current version is back. Also true while the
   * connection is dead (3d): every word stays, and none of it moves. */
  readOnly: boolean;
}): React.ReactElement => {
  const ref = React.useRef<HTMLIFrameElement | null>(null);
  const pending = React.useRef(new Map<string, (spots: AnnotationSpot[]) => void>());
  const snaps = React.useRef(
    new Map<string, (v: { html: string; values: Record<string, string> } | null) => void>(),
  );
  const nextToken = React.useRef(0);

  // Where a lost note pointed (3e), sent whenever it changes. `seamsRef` is
  // the copy the ready handler sends, because a fresh frame will not hear
  // this effect again until the anchors move - and they usually just moved,
  // which is exactly when the frame was replaced.
  const seamsRef = React.useRef(seams);
  React.useEffect(() => {
    seamsRef.current = seams;
    ref.current?.contentWindow?.postMessage(
      { source: FRAME_MESSAGE_SOURCE, kind: "seam", seams: [...seams] },
      "*",
    );
  }, [seams]);

  // A `message` listener hears from every frame on the page and from any
  // origin. The boundary exists only because this checks.
  React.useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      // The frame is sandboxed without `allow-same-origin`, so its origin
      // is opaque and there is nothing to compare. Identity of the sending
      // window is the check.
      const frame = ref.current;
      if (frame === null || e.source !== frame.contentWindow) return;

      // Arriving on that channel is not the same as being true. The shape
      // is checked before any of it is believed.
      const m = e.data as Record<string, unknown> | null;
      if (m === null || typeof m !== "object") return;
      if (m.source !== FRAME_MESSAGE_SOURCE) return;

      // A key press is about the page, not about a version of a document, so
      // it carries no artifact and is answered before anything is checked
      // against one.
      if (m.kind === "hotkey") {
        if (m.hotkey === "toggle-mode" || m.hotkey === "send-queue") onHotkey(m.hotkey);
        return;
      }

      if (
        m.kind !== "selection" &&
        m.kind !== "captured" &&
        m.kind !== "snapshot-taken" &&
        m.kind !== "dirty" &&
        m.kind !== "place" &&
        m.kind !== "ready" &&
        m.kind !== "pulsed" &&
        m.kind !== "focus-offscreen" &&
        m.kind !== "marks-below" &&
        m.kind !== "seam-clicked"
      )
        return;
      // A seam click carries no artifact or version: the frame that sent it
      // is the frame that holds the seam, and the seam itself names the
      // version to open. Everything else names the document it is about.
      if (m.kind !== "seam-clicked") {
        if (m.artifactId !== doc.artifactId || m.version !== doc.version) return;
      }

      // Where the reader is, pushed by the frame as they scroll (#180).
      //
      // Pushed rather than asked for, because by the time it is needed the
      // frame that knew it has been unmounted. The version is recorded with
      // it: a place in v20 means nothing in v24 until it has been followed
      // through the versions between.
      // A fresh frame, holding the version that has just been taken up. If a
      // place was followed into it, this is the moment it can be given.
      if (m.kind === "ready") {
        const want = pendingRestore.current;
        if (want !== null) {
          pendingRestore.current = null;
          restorePlace.current?.(want.index, want.top);
        }
        // After the restore, never before it. What counts as already in view
        // is what the reader will be looking at, and until the place is put
        // back the frame is still at the top showing the wrong thing.
        const changed = pendingPulse.current;
        if (changed !== null) {
          pendingPulse.current = null;
          if (changed.length > 0) pulseBlocks.current?.(changed);
        }
        // Where a lost note pointed. The frame has to exist before a seam
        // can sit in it.
        ref.current?.contentWindow?.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "seam", seams: seamsRef.current },
          "*",
        );
        return;
      }

      // Which of them the reader could not see, and which edge they sat
      // at. The other half of the rule: they did not pulse, so they are
      // offered at the nearer edge instead.
      if (m.kind === "pulsed") {
        const below = Array.isArray(m.below) ? (m.below as number[]) : [];
        const above = Array.isArray(m.above) ? (m.above as number[]) : [];
        onOffscreen(below, above);
        return;
      }

      // A note's target sat off screen (6a). The frame did not scroll and
      // did not light anything; the offer is the page's to dock.
      if (m.kind === "focus-offscreen") {
        if (typeof m.index === "number" && typeof m.below === "boolean") onTravel(m.index, m.below);
        return;
      }

      // The fold moved, or the marks did (3g).
      if (m.kind === "marks-below") {
        onMarksBelow(Array.isArray(m.indexes) ? (m.indexes as number[]) : []);
        return;
      }

      // The way back to a lost passage (3e): the seam names the version
      // where the note still reads, and opening that beside the current
      // one is the compare view.
      if (m.kind === "seam-clicked") {
        if (typeof m.version === "number" && Number.isSafeInteger(m.version))
          onSeamClick(m.version);
        return;
      }

      if (m.kind === "place") {
        if (typeof m.index !== "number" || typeof m.top !== "number") return;
        place.current = { version: doc.version, index: m.index, top: m.top };
        return;
      }
      if (m.kind === "dirty") {
        onDirty(typeof m.edits === "number" && m.edits >= 1 ? m.edits : 1);
        return;
      }

      if (m.kind === "snapshot-taken") {
        const token = typeof m.token === "string" ? m.token : "";
        const settle = snaps.current.get(token);
        if (settle === undefined) return;
        snaps.current.delete(token);
        if (typeof m.html !== "string") {
          settle(null);
          return;
        }
        const values: Record<string, string> = {};
        if (m.values !== null && typeof m.values === "object" && !Array.isArray(m.values)) {
          for (const [k, v] of Object.entries(m.values as Record<string, unknown>)) {
            if (typeof v === "string") values[k] = v;
          }
        }
        settle({ html: m.html, values });
        return;
      }

      if (m.kind === "captured") {
        // The answer to a capture this page asked for, matched by the token
        // it was asked with — an answer nobody is waiting for is dropped.
        const token = typeof m.token === "string" ? m.token : "";
        const settle = pending.current.get(token);
        if (settle === undefined) return;
        pending.current.delete(token);
        if (!Array.isArray(m.spots)) {
          settle([]);
          return;
        }
        const spots: CapturedSpot[] = [];
        for (const raw of m.spots) {
          if (raw === null || typeof raw !== "object") continue;
          const sp = raw as Record<string, unknown>;
          if (typeof sp.id !== "string" || !ELEMENT_ID.test(sp.id)) continue;
          if (typeof sp.snippet !== "string" || typeof sp.author !== "string") continue;
          spots.push({
            id: sp.id,
            snippet: clampSnippet(sp.snippet),
            author: sp.author,
            ...(typeof sp.quote === "string" && sp.quote !== "" ? { quote: sp.quote } : {}),
          });
        }
        settle(spots);
        return;
      }

      if (!Array.isArray(m.ids)) return;
      if (!m.ids.every((id) => typeof id === "string" && ELEMENT_ID.test(id))) return;

      onSelection(m.ids as string[], readRect(m.rect));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    doc.artifactId,
    doc.version,
    onSelection,
    onHotkey,
    onDirty,
    place,
    pendingRestore,
    restorePlace,
    pendingPulse,
    pulseBlocks,
    onOffscreen,
    onTravel,
    onMarksBelow,
    onSeamClick,
  ]);

  // Asking the frame what is at a set of spots. The parent cannot read the
  // document, so it asks and the frame answers — the boundary stays one
  // narrow message in each direction.
  React.useEffect(() => {
    capture.current = (ids) =>
      new Promise<AnnotationSpot[]>((resolve) => {
        const frame = ref.current;
        if (frame === null || frame.contentWindow === null) return resolve([]);
        const token = `c${nextToken.current++}`;
        pending.current.set(token, resolve);
        frame.contentWindow.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "capture", token, ids: [...ids] },
          "*",
        );
        // A frame that never answers must not leave a note half-written.
        window.setTimeout(() => {
          if (pending.current.delete(token)) resolve([]);
        }, 2000);
      });
    snapshot.current = () =>
      new Promise((resolve) => {
        const frame = ref.current;
        if (frame === null || frame.contentWindow === null) return resolve(null);
        const token = `s${nextToken.current++}`;
        snaps.current.set(token, resolve);
        frame.contentWindow.postMessage(
          { source: FRAME_MESSAGE_SOURCE, kind: "snapshot", token },
          "*",
        );
        window.setTimeout(() => {
          if (snaps.current.delete(token)) resolve(null);
        }, 4000);
      });
    deselect.current = () =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "deselect" },
        "*",
      );
    focusSpot.current = (ids) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "focus", ids: [...ids] },
        "*",
      );
    restorePlace.current = (index, top) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "restore-place", index, top },
        "*",
      );
    pulseBlocks.current = (indexes) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "pulse", indexes: [...indexes] },
        "*",
      );
    goBlock.current = (index) =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "go-block", index },
        "*",
      );
    return () => {
      capture.current = null;
      snapshot.current = null;
      deselect.current = null;
      focusSpot.current = null;
      restorePlace.current = null;
      pulseBlocks.current = null;
      goBlock.current = null;
    };
  }, [capture, snapshot, deselect, focusSpot, restorePlace, pulseBlocks, goBlock]);

  React.useEffect(() => {
    ref.current?.contentWindow?.postMessage(
      { source: FRAME_MESSAGE_SOURCE, kind: "mark", counts: Object.fromEntries(noteCounts) },
      "*",
    );
  }, [noteCounts]);

  React.useEffect(() => {
    // Sent on a timer as well as on change: the frame is replaced whenever
    // the version changes, and a fresh frame starts in edit mode.
    const send = (): void =>
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "mode", mode, readOnly },
        "*",
      );
    send();
    const id = window.setInterval(send, 1000);
    return () => window.clearInterval(id);
  }, [mode, readOnly]);

  return (
    <iframe
      ref={ref}
      key={`${doc.artifactId}@${doc.version}`}
      className="doc-frame"
      title={`${doc.artifactId} v${doc.version}`}
      sandbox="allow-scripts"
      srcDoc={instrumentArtifact(doc.bytes, doc.artifactId, doc.version)}
    />
  );
};

/** One side of a comparison: a whole document in its own sandboxed frame,
 * with the diff marks for its side. The same frame machinery as the reading
 * view - the document is agent-written and never rendered outside a
 * sandbox, comparing included - sent its marks on a timer like the mode
 * message, because a fresh frame has to hear them whenever it is ready. */
const CompareSheet = ({
  artifactId,
  bytes,
  version,
  side,
  marks,
  seams,
}: {
  artifactId: string;
  bytes: string;
  version: number;
  side: "old" | "new";
  marks: readonly number[];
  seams: readonly { before: number; label: string }[];
}): React.ReactElement => {
  const ref = React.useRef<HTMLIFrameElement | null>(null);
  // Read-only from the first message: a comparison is for reading, and no
  // write exists behind either side. The marks ride their own timer.
  React.useEffect(() => {
    const send = (): void => {
      ref.current?.contentWindow?.postMessage(
        { source: FRAME_MESSAGE_SOURCE, kind: "mode", mode: "annotate", readOnly: true },
        "*",
      );
      ref.current?.contentWindow?.postMessage(
        {
          source: FRAME_MESSAGE_SOURCE,
          kind: "compare",
          side,
          marks: [...marks],
          seams: seams.map((s) => ({ before: s.before, label: s.label, mid: true })),
        },
        "*",
      );
    };
    send();
    const id = window.setInterval(send, 1000);
    return () => window.clearInterval(id);
  }, [side, marks, seams]);
  return (
    <iframe
      ref={ref}
      key={`${artifactId}@${version}`}
      className="doc-frame"
      title={`${artifactId} v${version} (comparison)`}
      sandbox="allow-scripts"
      srcDoc={instrumentArtifact(bytes, artifactId, version)}
    />
  );
};

/** Where a removed block sits in the newer document: before the first
 * surviving block that followed it, or at the end when nothing did. The
 * same walk the place-keeping rule uses, read for where things went. */
const seamBefore = (d: VersionDiff, wasAt: number): number => {
  let best: number | undefined;
  for (const oldIndex of d.carried.keys()) {
    if (oldIndex > wasAt && (best === undefined || oldIndex < best)) best = oldIndex;
  }
  return best === undefined ? Number.MAX_SAFE_INTEGER : (d.carried.get(best) as number);
};

/** Where each removed run shows on the newer side: one seam per gap, however
 * many blocks the run took with it. */
const removedSeams = (d: VersionDiff): { before: number; label: string }[] => {
  const byBefore = new Map<number, number>();
  for (const c of d.changes) {
    if (c.kind !== "removed" || c.wasAt === undefined) continue;
    const before = seamBefore(d, c.wasAt);
    byBefore.set(before, (byBefore.get(before) ?? 0) + 1);
  }
  return [...byBefore.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([before, count]) => ({
      before,
      label: count === 1 ? "one block removed" : `${count} blocks removed`,
    }));
};

/**
 * Two versions, side by side (RFC-07 R9, designed 6b).
 *
 * A comparison is a view and nothing else. It never reaches the agent, never
 * appends to the record, and offers no editing of either side - restoring
 * means leaving it first, which is deliberate: this is for reading, and
 * there is no write behind it.
 *
 * Two whole sheets rather than one split sheet, because each side is a whole
 * document; below 360px a side it becomes one column. The newer side wears
 * the accent border and the accent marks; the older side wears edge ink. A
 * diff is not a refusal, so neither side ever takes magenta.
 */
const Comparison = ({
  artifactId,
  left,
  right,
  leftVersion,
  rightVersion,
}: {
  artifactId: string;
  left: string | null;
  right: string | null;
  leftVersion: number;
  rightVersion: number;
}): React.ReactElement => {
  const box = React.useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = React.useState(true);

  // Measured, not assumed. `COMPARE_COLUMN_MIN` is policy: below it a column
  // is too narrow to read a line of markup in, and two unreadable columns are
  // worse than one readable one.
  React.useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = (): void => setWide(el.clientWidth >= COMPARE_COLUMN_MIN * 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A version that could not be read is reported for its own side. Rendering
  // it as an empty column would say it was empty, which is a different and
  // untrue thing.
  const missing = left === null || right === null;
  const diff = React.useMemo(() => {
    if (missing) return null;
    const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");
    return diffVersions(parse(left as string), parse(right as string));
  }, [left, right, missing]);

  const oldMarks = React.useMemo(
    () =>
      diff === null
        ? []
        : diff.changes.map((c) => c.wasAt).filter((v): v is number => v !== undefined),
    [diff],
  );
  const newMarks = React.useMemo(
    () =>
      diff === null
        ? []
        : diff.changes.map((c) => c.at).filter((v): v is number => v !== undefined),
    [diff],
  );
  const seams = React.useMemo(() => (diff === null ? [] : removedSeams(diff)), [diff]);
  const changedCount = diff === null ? 0 : diff.changes.length;

  return (
    <div className={wide ? "doc-ground compare wide" : "doc-ground compare"} ref={box}>
      <div className="compare-cols">
        <div className="compare-col">
          <div className="compare-col-head">
            <span className="v">v{leftVersion}</span>
            <span className="who">the earlier one</span>
          </div>
          {left === null ? (
            <div className="compare-unreadable">v{leftVersion} could not be read.</div>
          ) : (
            <div className="compare-frame-wrap">
              <CompareSheet
                artifactId={artifactId}
                bytes={left}
                version={leftVersion}
                side="old"
                marks={oldMarks}
                seams={[]}
              />
            </div>
          )}
        </div>
        <div className="compare-col">
          <div className="compare-col-head">
            <span className="v">v{rightVersion}</span>
            <span className="who">the newer one</span>
            {diff === null || changedCount === 0 ? null : (
              <span className="count">
                {changedCount} change{changedCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {right === null ? (
            <div className="compare-unreadable">v{rightVersion} could not be read.</div>
          ) : (
            <div className="compare-frame-wrap new">
              <CompareSheet
                artifactId={artifactId}
                bytes={right}
                version={rightVersion}
                side="new"
                marks={newMarks}
                seams={seams}
              />
            </div>
          )}
        </div>
      </div>
      <div className="compare-foot">
        <div className="compare-note">
          Comparing never reaches the agent and appends nothing.
          {diff === null || diff.controls.length === 0
            ? ""
            : ` Also changed: ${diff.controls
                .map(
                  (c) =>
                    `“${c.label}” ${c.before === "on" || c.before === "off" ? c.before : `“${c.before}”`} → ${
                      c.after === "on" || c.after === "off" ? c.after : `“${c.after}”`
                    }`,
                )
                .join(" · ")}.`}
        </div>
        <div className="compare-legend">
          <span className="key new">
            <span className="swatch" aria-hidden="true" />
            changed in v{rightVersion}
          </span>
          <span className="key old">
            <span className="swatch" aria-hidden="true" />
            was in v{leftVersion}
          </span>
        </div>
      </div>
    </div>
  );
};

/** The 6c shell: the one dialog, because discard is the one control that
 * destroys work. 392px of paper on a blurred paper wash over the window;
 * no shadow - the edge and the wash carry it. The destructive action is
 * filled with ink, never magenta: a choice the person made is not the
 * substrate refusing. */
const Dialog = ({
  title,
  body,
  keep,
  go,
  busy,
  onKeep,
  onGo,
}: {
  title: string;
  body: React.ReactNode;
  keep: string;
  go: string;
  busy: boolean;
  onKeep: () => void;
  onGo: () => void;
}): React.ReactElement => {
  // Escape is the keep answer, like everywhere else in lucid that asks a
  // question of the person holding the keyboard.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onKeep();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{body}</div>
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onKeep}>
            {keep}
          </button>
          <button type="button" className="go" onClick={onGo} disabled={busy}>
            {go}
          </button>
        </div>
      </div>
    </div>
  );
};

const App = (): React.ReactElement => {
  // Read once. Where in the record the page starts is an opening question;
  // after that the page moves the address bar, not the other way round.
  const opened = React.useMemo(routeFromPath, []);
  const conversationId = opened?.conversationId ?? "";
  /** The artifact the URL asked for, until a person picks another. */
  const [wantArtifact, setWantArtifact] = React.useState<string | null>(opened?.artifactId ?? null);
  /** Show another artifact. The pin goes with it: a version number belongs
   * to the artifact it came from, and carrying v7 across would ask for a
   * version of a different document. */
  const openArtifact = React.useCallback((artifactId: string): void => {
    setWantArtifact(artifactId);
    setPinned(null);
    setUnknownArtifact(null);
  }, []);

  /** An artifact the URL named that the record does not hold. */
  const [unknownArtifact, setUnknownArtifact] = React.useState<string | null>(null);
  const [token, setToken] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [status, setStatus] = React.useState<string>("");
  /** What is driving: harness, model when known, and profile. */
  const [driver, setDriver] = React.useState<Driver>({});
  /** What the person chose (RFC-12), beside what is driving, and the lists
   * to choose from. Both ride on the poll the page already makes. */
  const [driverPreference, setDriverPreference] = React.useState<DriverPreference | null>(null);
  const [driverChoices, setDriverChoices] = React.useState<DriverChoices | null>(null);
  const [activity, setActivity] = React.useState<Activity>({
    turn: false,
    inFlight: 0,
    waiting: 0,
  });
  /** When the transcript last changed. A conversation that is waiting and a
   * conversation that has stopped look identical without it — which is how
   * a wedged harness sat silent for ninety minutes with eight inputs
   * delivered and nothing said. */
  const [lastChange, setLastChange] = React.useState(() => Date.now());
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const [problem, setProblem] = React.useState<string | null>(null);
  /** The record is damaged past a point (G1, the 3d family): the header
   * goes magenta with the cause and Reload is the one action, but the words
   * already read stay on screen - they were on disk the whole time. */
  const [damaged, setDamaged] = React.useState(false);
  /** Set once on 401. Every fetch stops: the token can only come back by
   * reloading, and retrying a dead token forever is the failure this flag
   * exists to prevent. */
  const [dead, setDead] = React.useState(false);
  const [doc, setDoc] = React.useState<Doc | null>(null);
  /** Which version is on screen. Compared against the catalog so a fetch
   * happens on a new version and not on every tick. */
  const shown = React.useRef<string>("");
  /** True while a version is being fetched. A new version appears when
   * nothing is in progress, so a slow fetch never has a second one racing
   * it, and the frame is never swapped halfway. */
  const fetching = React.useRef(false);
  /** One selection, however many spots are in it. A new version clears it:
   * an id addresses an element in the render it came from, and the next
   * version is a different render. */
  const [selection, setSelection] = React.useState<readonly string[]>([]);
  /** Every version the record holds, and which spots already carry a sent
   * note on each. */
  const [catalog, setCatalog] = React.useState<CatalogEntry | null>(null);
  /** Every artifact the record holds. The catalog endpoint has always
   * returned all of them; the page kept only the one it was showing, which
   * is what made the rest unreachable. */
  const [allArtifacts, setAllArtifacts] = React.useState<readonly CatalogEntry[]>([]);
  /** Sent notes, by `artifactId@version` — the version each was made
   * against. */
  const [sentNotes, setSentNotes] = React.useState<Record<string, Annotation[]>>({});
  /** Where each sent note points in the version on screen, and how
   * confidently it got there. A note made against this version needs no
   * resolving; one from an earlier version does. */
  const [anchored, setAnchored] = React.useState<
    readonly {
      readonly note: string;
      readonly fromVersion: number;
      readonly elementId: string | null;
      readonly how: Confidence | null;
      readonly why: string | null;
      readonly snippet: string;
    }[]
  >([]);
  /** Where each lost note's passage WAS, as a seam the frame draws in the
   * gap it left (3e). Derived in the same walk as the resolutions, because
   * the question - where did the removed block sit relative to the ones
   * that survived - is the same diff read another way. */
  const [seams, setSeams] = React.useState<
    readonly { before: number; label: string; version: number }[]
  >([]);
  /** The version asked for. Null means "follow the newest" — the ordinary
   * state, where a new version simply appears.
   *
   * Choosing a version always pins it, the newest included. The rule that
   * lucid never changes version under pending work is about lucid moving
   * someone, not about someone moving themselves, and a pin is how the two
   * are told apart. */
  // A version named in the URL opens pinned to it: a link to a version has
  // to land on that version, not on the newest one.
  const [pinned, setPinned] = React.useState<number | null>(opened?.version ?? null);
  /** Go to the newest version even though there is work in progress.
   *
   * The banner offering the newer version used to call `setPinned(null)`,
   * and in the case it appears for, `pinned` is already `null` - nothing was
   * ever pinned. So the click changed no state, the guard below re-ran on the
   * same values, and the button did nothing at all.
   *
   * State rather than a ref, because the effect has to re-run when it is set
   * and has to read it. It is cleared as soon as it is honoured, so it asks
   * once rather than turning following back on for good. */
  const [forceFollow, setForceFollow] = React.useState(false);
  const goToNewest = React.useCallback(() => {
    // Both, because "show me the newest" has two things standing in its way
    // and either may be present. A pin holds the target at a chosen version;
    // work in progress holds the document where it is. Clearing only the pin
    // was the old behaviour and did nothing when nothing was pinned; setting
    // only the override does nothing when something is.
    setPinned(null);
    setForceFollow(true);
  }, []);
  /** A version that arrived while there was work pending. It waits here and
   * is announced rather than swapped in underneath. */
  const [waiting, setWaiting] = React.useState<number | null>(null);
  /** Notes written but not yet sent. They accumulate: a batch is composed
   * over several selections and leaves as one act. */
  /** Unsent notes, kept per version. A note addresses an element in the
   * render it was made against, so it belongs to that version — and looking
   * at another version and coming back must not have lost it. */
  const [notesByVersion, setNotesByVersion] = React.useState<
    Record<string, readonly PendingNote[]>
  >({});
  const [draft, setDraft] = React.useState("");
  /** A refused send keeps what was typed and says why, here in the window. */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const capture = React.useRef<((ids: readonly string[]) => Promise<CapturedSpot[]>) | null>(null);
  const snapshot = React.useRef<
    (() => Promise<{ html: string; values: Record<string, string> } | null>) | null
  >(null);
  /** The document has been changed by the person and not yet saved. Saving
   * is an explicit act — nothing becomes permanent until they say so, which
   * is what stops every keystroke being a version. */
  const [edited, setEdited] = React.useState(false);
  /** How many blocks the change touches, as the frame reports it. Names the
   * quantity in the discard dialog (6c: "Discard your three edits?"). */
  const [editedCount, setEditedCount] = React.useState(0);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<string | null>(null);
  /** What a click means right now. Two things wanted the same click — ticking
   * a box and picking an element to write about — so which one it is, is a
   * choice rather than a guess.
   *
   * Annotate is the default. What a person does with a document an agent
   * produced is read it and say what is wrong with it; filling it in is the
   * rarer act, and it is the one that has a mode switch to reach it. */
  const [mode, setMode] = React.useState<"edit" | "annotate">("annotate");
  const noteBox = React.useRef<HTMLTextAreaElement | null>(null);
  /** Where in the frame the selection sits, so the note box opens beside it
   * rather than in a panel at the bottom, away from what it is about. */
  const [selRect, setSelRect] = React.useState<SelectionRect | null>(null);
  const deselect = React.useRef<(() => void) | null>(null);
  const focusSpot = React.useRef<((ids: readonly string[]) => void) | null>(null);
  /** The reader's place, as the frame last reported it. */
  const place = React.useRef<{ version: number; index: number; top: number } | null>(null);
  const restorePlace = React.useRef<((index: number, top: number) => void) | null>(null);
  /** A place followed into the version being taken up, waiting for its
   * frame to exist. */
  const pendingRestore = React.useRef<{ index: number; top: number } | null>(null);
  /** The travel offer (6a): what a click on a note or an arriving version
   * docks at the sheet edge nearest the target. Null while there is nothing
   * to offer - the reader is looking at what changed, or declined to go. */
  const [offer, setOffer] = React.useState<{
    readonly side: "below" | "above";
    readonly count: number;
    readonly index: number;
    readonly note: boolean;
  } | null>(null);
  /** Noted blocks wholly below the fold (3g), pushed by the frame. */
  const [marksBelow, setMarksBelow] = React.useState<readonly number[]>([]);
  /** Files attached to the message being written. Stored the moment they are
   * chosen, so closing the page does not lose them. */
  const [attached, setAttached] = React.useState<readonly Attached[]>([]);
  /** Files on the note being written. Separate from the composer's: a note is
   * about a spot, and its files are about that note. */
  const [noteFiles, setNoteFiles] = React.useState<readonly Attached[]>([]);
  /** Files on their way to the store (4a state 3), composer and note box
   * separately - a chip belongs to the surface it was dropped on. */
  const [uploading, setUploading] = React.useState<readonly Uploading[]>([]);
  const [noteUploading, setNoteUploading] = React.useState<readonly Uploading[]>([]);
  /** The substrate refused an attach or a send (4a state 5, G2). The chip
   * stays until it is dismissed - never a toast. */
  const [refusals, setRefusals] = React.useState<readonly Refusal[]>([]);
  const [noteRefusals, setNoteRefusals] = React.useState<readonly Refusal[]>([]);
  const refusalSeq = React.useRef(0);

  /** A refusal as a fact the surface holds, not a message that times out. */
  const addRefusal = React.useCallback((name: string | null, reason: string): void => {
    const id = `r${refusalSeq.current++}`;
    setRefusals((prev) => [...prev, { id, name, reason }]);
  }, []);
  const addNoteRefusal = React.useCallback((name: string | null, reason: string): void => {
    const id = `n${refusalSeq.current++}`;
    setNoteRefusals((prev) => [...prev, { id, name, reason }]);
  }, []);
  /** A comparison being read: which version the one on screen is held against,
   * and that version's bytes once they arrive. `null` bytes mean it could not
   * be read, which is reported rather than shown as an empty side. */
  const [comparing, setComparing] = React.useState<{
    version: number;
    bytes: string | null;
    loading: boolean;
  } | null>(null);
  const docRef = React.useRef<Doc | null>(null);
  /** Blocks this version added or changed, waiting for its frame. Sent once:
   * the pulse marks a version arriving, not a block existing. */
  const pendingPulse = React.useRef<readonly number[] | null>(null);
  const pulseBlocks = React.useRef<((indexes: readonly number[]) => void) | null>(null);
  const goBlock = React.useRef<((index: number) => void) | null>(null);
  /** What is typed, readable from a callback the frame holds. That callback
   * must keep its identity across keystrokes, so it cannot close over the
   * draft itself. */
  const draftRef = React.useRef("");
  /** Read from the hotkey callback, which must keep its identity. */
  /** Read only, for the hotkey path. Fed from `pinnedOld`: being
   * overtaken does not take the modes away. */
  const viewingOldRef = React.useRef(false);
  const editedRef = React.useRef(false);
  /** A batch of notes is on its way to the record. */
  const [sending, setSending] = React.useState(false);
  const sendingNotes = React.useRef(false);
  const queueSendRef = React.useRef<(() => Promise<void>) | null>(null);
  draftRef.current = draft;

  // Backing out. A selection with no way out of it was a dead end: the note
  // box stayed open over the document with nothing but Add note in it.
  const cancelNote = React.useCallback((): void => {
    setDraft("");
    setSelection([]);
    setSelRect(null);
    setRefusal(null);
    deselect.current?.();
  }, []);

  /** How wide the conversation is. Null means it has never been dragged, and
   * the stylesheet's own share of the window stands. */
  const [convWidth, setConvWidth] = React.useState<number | null>(() =>
    readConversationWidth(typeof localStorage === "undefined" ? null : localStorage),
  );
  const [dragging, setDragging] = React.useState(false);

  // A pointer capture, not a window listener: the pointer crosses the frame
  // on the way, and the frame is another document that would swallow every
  // move after the first.
  const startDrag = React.useCallback((e: React.PointerEvent<HTMLHRElement>): void => {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = grip.nextElementSibling?.getBoundingClientRect().width ?? 0;
    setDragging(true);

    const move = (ev: PointerEvent): void => {
      // Dragging left widens the conversation: it is the right-hand pane.
      setConvWidth(clampConversationWidth(startWidth - (ev.clientX - startX), window.innerWidth));
    };
    const done = (): void => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", done);
      grip.removeEventListener("pointercancel", done);
      grip.releasePointerCapture(e.pointerId);
      setDragging(false);
      setConvWidth((w) => {
        if (w !== null) writeConversationWidth(localStorage, w);
        return w;
      });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done);
    grip.addEventListener("pointercancel", done);
  }, []);

  // The address bar says what is on screen. Replaced rather than pushed:
  // moving between versions of a document is not a sequence of pages a person
  // wants to walk back through one at a time, and a pin that follows the
  // newest version would otherwise fill the history by itself.
  React.useEffect(() => {
    if (conversationId === "" || doc === null) return;
    const next: Route = {
      conversationId,
      artifactId: doc.artifactId,
      ...(pinned === null ? {} : { version: pinned }),
    };
    const now = parseRoute(window.location.pathname);
    if (sameRoute(now, next)) return;
    window.history.replaceState(null, "", formatRoute(next));
  }, [conversationId, doc, pinned]);

  // The same move without a pointer. A separator you can reach with Tab and
  // cannot operate is a control in name only.
  const nudgeDrag = React.useCallback((e: React.KeyboardEvent<HTMLHRElement>): void => {
    const step = e.shiftKey ? 64 : 16;
    const by = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
    if (by === 0) return;
    e.preventDefault();
    const now = e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? 0;
    const next = clampConversationWidth(now + by, window.innerWidth);
    setConvWidth(next);
    writeConversationWidth(localStorage, next);
  }, []);

  // A window that shrinks can leave the conversation wider than there is
  // room for. What was dragged is kept; what is shown is what fits.
  React.useEffect(() => {
    const onResize = (): void => {
      setConvWidth((w) => (w === null ? null : clampConversationWidth(w, window.innerWidth)));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* Closing the tab, reloading, or following a link takes the frame with it,
   * and the frame is where an unsaved edit lives - nothing has written it
   * down yet. Every other way of losing it now asks first: a version
   * arriving offers save-or-discard, and a mode switch keeps it. This was
   * the one exit with no question on it.
   *
   * The browser shows its own wording and ignores ours, so there is no
   * message here. `preventDefault` is what asks. */
  React.useEffect(() => {
    if (!edited) return;
    const ask = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [edited]);

  const toggleMode = React.useCallback((): void => {
    // Nothing to switch between on a version that permits neither, and
    // nothing to switch to while the bar is asking to save or discard.
    if (viewingOldRef.current || editedRef.current) return;
    setMode((m) => (m === "edit" ? "annotate" : "edit"));
    // Leaving annotate mode ends whatever note was being written: there is no
    // selection in edit mode for it to point at.
    cancelNote();
  }, [cancelNote]);

  // Pressed anywhere in the page. The frame catches its own and posts them
  // out, so both work with the caret in the document too.
  const onHotkey = React.useCallback(
    (which: "toggle-mode" | "send-queue"): void => {
      if (which === "toggle-mode") {
        toggleMode();
        return;
      }
      // The note box has its own meaning for this key: add the note being
      // written to the queue. Once no note is being written, the same press
      // sends what the queue holds.
      if (queueSendRef.current === null) return;
      void queueSendRef.current();
    },
    [toggleMode],
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isModeToggle(e)) {
        e.preventDefault();
        onHotkey("toggle-mode");
        return;
      }
      if (!isQueueSend(e)) return;
      if (queueSendRef.current === null) return;
      e.preventDefault();
      onHotkey("send-queue");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onHotkey]);

  const onSelected = React.useCallback(
    (ids: readonly string[], rect: SelectionRect | null): void => {
      // Clicking a part of the document that is not addressable empties the
      // selection. With something already typed that threw the words away
      // and closed the box, with no undo. Backing out is Cancel or Escape;
      // a stray click is not either of them.
      if (ids.length === 0 && draftRef.current.trim() !== "") return;
      setSelection(ids);
      setSelRect(ids.length === 0 ? null : rect);
    },
    [],
  );

  // Selecting something in the document is the start of writing about it,
  // so the caret goes where the writing happens. Keyed on emptiness rather
  // than on the ids: adding a spot with ⌘-click should not pull focus back
  // out of a note being typed.
  const hasSelection = selection.length > 0;
  React.useEffect(() => {
    if (hasSelection) noteBox.current?.focus();
  }, [hasSelection]);

  const docKey = doc === null ? "" : `${doc.artifactId}@${doc.version}`;
  const notes = React.useMemo(() => notesByVersion[docKey] ?? [], [notesByVersion, docKey]);
  /** Work pending: something selected, something typed, or notes not sent.
   * lucid never changes version under a person who has work pending — that
   * is what makes replacing the whole frame safe, and why no attempt is made
   * to patch the document in place. */
  const pending = selection.length > 0 || draft.trim() !== "" || notes.length > 0 || edited;
  const pendingRef = React.useRef(false);
  React.useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  const setNotes = React.useCallback(
    (next: readonly PendingNote[]) => setNotesByVersion((prev) => ({ ...prev, [docKey]: next })),
    [docKey],
  );

  React.useEffect(() => {
    let alive = true;
    fetch("/api/session")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`session ${r.status}`))))
      .then((d: { token: string }) => {
        if (alive) setToken(d.token);
      })
      .catch((e: unknown) => {
        if (alive) setProblem(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  React.useEffect(() => {
    if (token === null || dead || conversationId === "") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
          headers: { [TOKEN_HEADER]: token },
        });
        if (!alive) return;
        if (res.status === 401) {
          setDead(true);
          return;
        }
        if (!res.ok) {
          setProblem(`Could not read the conversation (${res.status}).`);
          return;
        }
        const data = (await res.json()) as {
          lines: Line[];
          status: string;
          damaged?: boolean;
          driver?: Driver;
          driverPreference?: DriverPreference | null;
          driverChoices?: DriverChoices | null;
          activity?: Activity;
        };
        if (!alive) return;
        const next = linesToMessages(data.lines);
        setMessages((prev) => {
          const changed =
            prev.length !== next.length ||
            (prev.length > 0 && prev[prev.length - 1]?.text !== next[next.length - 1]?.text);
          if (changed) setLastChange(Date.now());
          return next;
        });
        setStatus(data.status);
        setDriver(data.driver ?? {});
        setDriverPreference(data.driverPreference ?? null);
        setDriverChoices(data.driverChoices ?? null);
        setActivity(data.activity ?? { turn: false, inFlight: 0, waiting: 0 });
        setDamaged(data.damaged === true);
        if (data.damaged !== true) setProblem(null);
      } catch (e: unknown) {
        if (alive) setProblem(String(e));
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [token, dead, conversationId]);

  // The document channel. Separate effect, separate cadence, separate
  // endpoint — a document never rides along with a transcript poll.
  React.useEffect(() => {
    if (token === null || dead || conversationId === "") return;
    let alive = true;
    const tick = async (): Promise<void> => {
      if (fetching.current) return;
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/artifacts`,
          {
            headers: { [TOKEN_HEADER]: token },
          },
        );
        if (!alive || !res.ok) return;
        const body = (await res.json()) as {
          artifacts: CatalogEntry[];
          notes?: Record<string, Annotation[]>;
        };
        const artifacts = body.artifacts;
        // Held before the pick, not after it. An artifact the record does not
        // hold returns early below, and that is exactly the page that has to
        // offer the list of what it does hold.
        setAllArtifacts(artifacts);
        // The artifact the URL named, else the one with the most recent
        // version entry - which is what the page did when nothing could name
        // one. An id that names nothing is not silently replaced: the page
        // says so, because a link that quietly shows a different document is
        // worse than a link that fails.
        const asked = wantArtifact;
        const entry =
          asked === null
            ? artifacts[artifacts.length - 1]
            : artifacts.find((a) => a.artifactId === asked);
        if (entry === undefined) {
          if (asked !== null) setUnknownArtifact(asked);
          return;
        }
        setUnknownArtifact(null);
        setCatalog(entry);
        setSentNotes(body.notes ?? {});

        // The version asked for, else the newest. A pin is what makes an
        // older version reachable, and marks live on the version they were
        // made against, so that version has to be reachable.
        const target = pinned ?? entry.latest;
        const want = `${entry.artifactId}@${target}`;
        if (want === shown.current) {
          // Already on the asked-for version. A newer one having arrived is
          // news, not a reason to move.
          if (entry.latest > target) setWaiting(entry.latest);
          return;
        }
        if (pinned === null && pendingRef.current && shown.current !== "" && !forceFollow) {
          // Nothing pinned, but there is work in progress: say a newer
          // version exists and wait to be asked. `forceFollow` is that asking.
          setWaiting(entry.latest);
          return;
        }
        // Asked for, so spent. Anything after this holds the document again
        // the moment there is work in progress.
        if (forceFollow) setForceFollow(false);
        fetching.current = true;
        try {
          const one = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(entry.artifactId)}/${target}`,
            { headers: { [TOKEN_HEADER]: token } },
          );
          if (!alive || !one.ok) return;
          const fetched = (await one.json()) as Doc;
          if (!alive) return;
          shown.current = want;

          // Follow the reader's place into the version being taken up (#180).
          //
          // By block, not by scroll offset. An offset is wrong the moment
          // anything above the reader changes length, which is exactly what
          // a new version does. `carried` is the same walk that reports what
          // changed, read for where things went rather than what they are.
          //
          // Only when the place belongs to the version being left. A place
          // in v20 says nothing about v24, and following it through every
          // version between is work nobody asked for - the reader who was
          // not here does not need their seat kept.
          pendingRestore.current = null;
          pendingPulse.current = null;
          setOffer(null);
          setMarksBelow([]);
          const here = place.current;
          const leaving = docRef.current;
          // One walk answers both questions - where the reader's block went,
          // and what this version changed. They are the same comparison read
          // two ways.
          if (leaving !== null) {
            try {
              const parse = (html: string): Document =>
                new DOMParser().parseFromString(html, "text/html");
              const d = diffVersions(parse(leaving.bytes), parse(fetched.bytes));

              if (here !== null && here.version === leaving.version) {
                const moved = d.carried.get(here.index);
                // Absent means the block the reader was on is gone. Putting
                // them somewhere else that happens to share its number is
                // worse than the top, which is at least honest.
                if (moved !== undefined) pendingRestore.current = { index: moved, top: here.top };
              }

              // What arrived, by its place in the version that arrived. A
              // removed block has nowhere to pulse, so it is not here.
              const touched: number[] = [];
              for (const c of d.changes) {
                if (c.at !== undefined) touched.push(c.at);
              }
              pendingPulse.current = touched;
            } catch {
              // Both of these are conveniences. Failing at them must never
              // stop the version arriving.
            }
          }
          place.current = null;

          // A note addresses an element in the render it was made against,
          // so the selection and the draft do not carry across. Notes do:
          // they are held per version, and coming back finds them.
          setSelection([]);
          setSelRect(null);
          setDraft("");
          setRefusal(null);
          setWaiting(null);
          setEdited(false);
          setEditedCount(0);
          setSaved(null);
          setDoc(fetched);
        } finally {
          fetching.current = false;
        }
      } catch {
        // A failed poll is not worth a notice: the next one is 2s away, and
        // the conversation channel already reports a server that has gone.
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), CATALOG_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [token, dead, conversationId, pinned, wantArtifact, forceFollow]);

  /** A restore waiting to be confirmed. Holding the version rather than a
   * boolean means the confirmation can name what it is about to do. */
  const [confirmRestore, setConfirmRestore] = React.useState<number | null>(null);
  /** A newer version waiting to be shown, once it is confirmed that the
   * unsaved edit can go. Holds the version so the confirmation can name it. */
  const [confirmDiscard, setConfirmDiscard] = React.useState<number | null>(null);
  /** An unsaved edit waiting to be thrown away on purpose. Separate from
   * `confirmDiscard`, which is about going to a newer version: this one is
   * just abandoning what was typed, with nowhere to go afterwards. */
  const [confirmDiscardEdit, setConfirmDiscardEdit] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);

  /** Showing a version that is not the current one. Read-only: no editing,
   * no saving, no selecting, no annotating (RFC-07 R6, R7). */
  /** Not the newest version. Two situations wear this, and they are not the
   * same situation.
   *
   * `pinnedOld` is going back deliberately: a version was chosen from the
   * picker. It is read only, and everything that reads "you cannot change
   * this" belongs to it.
   *
   * `overtaken` is standing still while the newest moved. Nothing was
   * chosen - the agent wrote a version, and the document was held where it
   * was because there was work in progress. Treating that as read only
   * disabled the save on an edit that was still live, and the server's whole
   * superseded-save path (`basedOn`, `supersededSince`) exists for exactly
   * this and could not be reached from the page. */
  const shownVersion = versionState({
    shown: doc?.version ?? null,
    latest: catalog?.latest ?? null,
    pinned,
  });
  const pinnedOld = isReadOnly(shownVersion);
  const overtaken = shownVersion === "overtaken";
  /** Not the newest, either way. Cosmetic only - what the picker looks like,
   * and what the follow button says. Never what is disabled. */
  const viewingOld = shownVersion !== "current";

  const addNote = React.useCallback(async (): Promise<void> => {
    const text = draft.trim();
    if (text === "" || selection.length === 0 || capture.current === null) return;
    // RFC-07 R10. Refused before anything is captured: what is queued stays
    // queued, and what was typed stays in the box to send after this one goes.
    // Belt as well as braces: the frame stops sending selections on a
    // read-only version, so this should be unreachable. It is here because
    // "should be unreachable" is where notes end up on the wrong version.
    if (pinnedOld) return;
    const room = queueAdmits(notes.length);
    if (!room.ok) {
      setRefusal(room.why);
      return;
    }
    // What was on screen where the note points, captured now. A reference
    // would have to be resolved later, against a document that may have
    // changed by then.
    const spots = await capture.current(selection);
    if (spots.length === 0) return;
    // Three ways of finding each spot again, written now, against the
    // version being annotated — the same bytes the snapshot guard will
    // verify before any of them is trusted later.
    const parsed = new DOMParser().parseFromString(doc?.bytes ?? "", "text/html");
    const withSelectors = spots.map(({ quote, ...sp }) => {
      // A drag anchors to the words dragged over; a click anchors to the
      // whole element. `quote` is dropped here either way: what is stored is
      // the anchor it produced, not the raw report from the frame.
      const sel =
        quote === undefined || quote === ""
          ? selectorsFor(parsed, sp.id)
          : selectorsForQuote(parsed, sp.id, quote);
      return sel === null ? sp : { ...sp, selectors: sel };
    });
    // Where in the timeline this happened, so it stays there when the
    // conversation carries on above and below it.
    setNotes([
      ...notes,
      {
        note: text,
        spots: withSelectors,
        at: messages.length,
        // The reference travels with the note, never the bytes. `path` is
        // filled in when the turn is built, because where a file is offered
        // from is a per-turn copy outside the record.
        ...(noteFiles.length === 0
          ? {}
          : {
              files: noteFiles.map((f) => ({
                hash: f.hash,
                bytes: f.bytes,
                contentType: f.contentType,
                name: f.name,
              })),
            }),
      },
    ]);
    setNoteFiles([]);
    setDraft("");
    setSelection([]);
    setSelRect(null);
    setRefusal(null);
    deselect.current?.();
  }, [draft, selection, notes, setNotes, doc, messages.length, pinnedOld, noteFiles]);

  const sendNotes = React.useCallback(async (): Promise<void> => {
    if (notes.length === 0 || doc === null || token === null || dead) return;
    // One send at a time. There was no guard here at all, and the button was
    // greyed out by the document-save flag instead — two unrelated things
    // sharing one piece of state, so saving a document disabled sending
    // notes and sending notes showed nothing. A key that sends makes a
    // double press easy, which is what turned this up.
    if (sendingNotes.current) return;
    sendingNotes.current = true;
    setSending(true);
    try {
      // One request. Every note goes together, as one input with one id, one
      // disposition, and one turn.
      const body = encodeAnnotationBatch({
        artifactId: doc.artifactId,
        version: doc.version,
        notes: notes.map((n) => ({
          note: n.note,
          spots: n.spots,
          ...(n.files === undefined || n.files.length === 0 ? {} : { files: n.files }),
        })),
      });
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/input`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        // Nothing is cleared: what was written is still there to send again.
        setRefusal(said.error === undefined ? `refused (${res.status})` : String(said.error));
        return;
      }
      setNotes([]);
      setRefusal(null);
    } finally {
      sendingNotes.current = false;
      setSending(false);
    }
  }, [notes, doc, token, dead, conversationId, setNotes]);

  // What command-Enter means right now, or null when it means nothing. A
  // ref, so the window listener and the frame's callback both read the
  // current answer without either being rebuilt as the queue changes.
  // Normally the note box owns this key: it adds the note being written. Once
  // the queue is full nothing can be added, so the key sends rather than doing
  // nothing at all - which is what it did, leaving a full queue, an open note
  // box, and no way out of either without reaching for the mouse.
  queueSendRef.current =
    notes.length > 0 && !sending && (selection.length === 0 || notes.length >= NOTE_QUEUE_MAX)
      ? sendNotes
      : null;

  /** Choose the driver (RFC-12): POST the whole preference the line
   * composed. The file is written by the server and read back by the poll,
   * so nothing here changes the line - it settles from the next poll, the
   * same discipline as sending. Answers null on success, or why it was
   * refused, so the line can say so beside itself. */
  const chooseDriver = React.useCallback(
    async (body: DriverChoiceBody): Promise<string | null> => {
      if (token === null) return "not connected";
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/driver`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return null;
      const said = (await res.json().catch(() => ({}))) as { error?: string };
      return said.error === undefined ? `refused (${res.status})` : said.error;
    },
    [token, conversationId],
  );

  /** Write a title. Returns null on success, or why not, so the field can
   * stay open with the reason beside it rather than closing and losing what
   * was typed. */
  const rename = React.useCallback(
    async (title: string): Promise<string | null> => {
      if (doc === null || token === null || dead) return "not connected";
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/meta`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ title }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        return said.error === "invalid-title"
          ? `a name is 1 to ${ARTIFACT_TITLE_MAX} characters, with no control characters`
          : `not renamed: ${said.error ?? res.status}`;
      }
      // The catalog is what the header reads, and the poll refreshes it. Set
      // it now so the name does not flicker back to the id for a tick.
      setAllArtifacts((prev) =>
        prev.map((a) => (a.artifactId === doc.artifactId ? { ...a, title } : a)),
      );
      return null;
    },
    [doc, token, dead, conversationId],
  );

  const restore = React.useCallback(async (): Promise<void> => {
    const from = confirmRestore;
    if (from === null || doc === null || token === null || dead || restoring) return;
    setRestoring(true);
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/restore`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ version: from }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        setRefusal(`not restored: ${said.error ?? res.status}`);
        return;
      }
      const body = (await res.json()) as { version: number };
      setConfirmRestore(null);
      setRefusal(null);
      // Follow what was just written. It is the current version now, and
      // staying on the old one would leave the page read-only for no reason
      // a person could see.
      setPinned(null);
      setSaved(`v${from} restored as v${body.version}`);
    } finally {
      setRestoring(false);
    }
  }, [confirmRestore, doc, token, dead, restoring, conversationId]);

  /** Read another version, to hold this one against it.
   *
   * Read-only in every sense: it fetches bytes and puts them on screen. No
   * frame is made for it, so neither side can be edited, and nothing about a
   * comparison reaches the record or the agent. */
  const compareWith = React.useCallback(
    async (version: number): Promise<void> => {
      if (doc === null || token === null) return;
      setComparing({ version, bytes: null, loading: true });
      try {
        const res = await fetch(
          `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/${version}`,
          { headers: { [TOKEN_HEADER]: token } },
        );
        if (!res.ok) {
          setComparing({ version, bytes: null, loading: false });
          return;
        }
        const other = (await res.json()) as Doc;
        setComparing({ version, bytes: other.bytes, loading: false });
      } catch {
        // Reported on its own side of the comparison, not as a page failure.
        setComparing({ version, bytes: null, loading: false });
      }
    },
    [doc, token, conversationId],
  );

  /** Store a chosen file and describe it back. Shared by the composer and
   * the note box, because storing is the same act either way - only what the
   * reference is then attached to differs. A refusal goes to whichever
   * surface asked, and each file settles on its own - by its place in the
   * chosen set, since names can repeat - so its chip leaves when its own
   * bytes have landed. */
  const storeFiles = React.useCallback(
    async (
      files: FileList,
      onRefusal: (name: string | null, reason: string) => void,
      onSettled: (at: number) => void,
    ): Promise<readonly Attached[]> => {
      if (token === null || conversationId === "") return [];
      const out: Attached[] = [];
      for (let at = 0; at < files.length; at += 1) {
        const file = files.item(at);
        if (file === null) continue;
        try {
          const res = await fetch(
            `/api/conversations/${encodeURIComponent(conversationId)}/attachments`,
            {
              method: "POST",
              headers: {
                [TOKEN_HEADER]: token,
                "x-lucid-filename": file.name,
                "content-type": file.type === "" ? "application/octet-stream" : file.type,
              },
              body: file,
            },
          );
          if (!res.ok) {
            const said = (await res.json().catch(() => ({}))) as { error?: string };
            // The real bound, not the prototype's: 25 MB is what this build
            // refuses, and the chip says that in the bound's own decimal
            // units - the coverage ruling names the exact wording.
            onRefusal(
              file.name,
              said.error === "attachment-too-large"
                ? `over the ${ATTACHMENT_BYTES_MAX / 1_000_000} MB limit`
                : `could not attach: ${said.error ?? res.status}`,
            );
            continue;
          }
          const a = (await res.json()) as Omit<Attached, "url">;
          let url: string | null = null;
          if (a.contentType.startsWith("image/")) {
            const got = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${a.hash}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (got.ok) {
              const blob = await got.blob();
              // Served as an image only when the BYTES say so: a file that
              // claimed to be a picture and is not comes back as bytes and
              // gets the placeholder rather than a broken one.
              if (blob.type.startsWith("image/")) url = URL.createObjectURL(blob);
            }
          }
          out.push({ ...a, url });
        } catch (e: unknown) {
          onRefusal(file.name, `could not attach: ${String(e)}`);
        } finally {
          onSettled(at);
        }
      }
      return out;
    },
    [token, conversationId],
  );

  const attachToNote = React.useCallback(
    async (files: FileList): Promise<void> => {
      const chips = Array.from(files).map((f, i) => ({ id: `n${i}`, name: f.name, bytes: f.size }));
      setNoteUploading((prev) => [...prev, ...chips]);
      const stored = await storeFiles(files, addNoteRefusal, (at) => {
        const id = `n${at}`;
        setNoteUploading((prev) => prev.filter((u) => u.id !== id));
      });
      setNoteFiles((prev) => [
        ...prev,
        ...stored.filter((a) => !prev.some((p) => p.hash === a.hash)),
      ]);
    },
    [storeFiles, addNoteRefusal],
  );

  const removeNoteFile = React.useCallback((hash: string): void => {
    setNoteFiles((prev) => {
      const going = prev.find((a) => a.hash === hash);
      if (going?.url !== null && going?.url !== undefined) URL.revokeObjectURL(going.url);
      return prev.filter((a) => a.hash !== hash);
    });
  }, []);

  const attachFiles = React.useCallback(
    async (files: FileList): Promise<void> => {
      const chips = Array.from(files).map((f, i) => ({ id: `u${i}`, name: f.name, bytes: f.size }));
      setUploading((prev) => [...prev, ...chips]);
      const stored = await storeFiles(files, addRefusal, (at) => {
        const id = `u${at}`;
        setUploading((prev) => prev.filter((u) => u.id !== id));
      });
      setAttached((prev) => [
        ...prev,
        ...stored.filter((a) => !prev.some((p) => p.hash === a.hash)),
      ]);
    },
    [storeFiles, addRefusal],
  );

  /** Take it off the message. The bytes stay in the record - nothing removes
   * anything from a record - and this is the message forgetting it. */
  const removeAttachment = React.useCallback((hash: string): void => {
    setAttached((prev) => {
      // The object URL holds the bytes in the page until it is revoked.
      const going = prev.find((a) => a.hash === hash);
      if (going?.url !== null && going?.url !== undefined) URL.revokeObjectURL(going.url);
      return prev.filter((a) => a.hash !== hash);
    });
  }, []);

  const save = React.useCallback(async (): Promise<void> => {
    if (doc === null || token === null || dead || snapshot.current === null) return;
    setSaving(true);
    try {
      const taken = await snapshot.current();
      if (taken === null) {
        setRefusal("could not read the document back");
        return;
      }
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/save`,
        {
          method: "POST",
          headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
          body: JSON.stringify({ html: taken.html, values: taken.values, basedOn: doc.version }),
        },
      );
      if (!res.ok) {
        const said = (await res.json().catch(() => ({}))) as { error?: string };
        // Nothing is cleared: the edit is still in the frame, and what was
        // typed is still here.
        setRefusal(
          said.error === "artifact-too-large"
            ? "too large to store — nothing was saved"
            : `not saved: ${said.error ?? res.status}`,
        );
        return;
      }
      const body = (await res.json()) as { version: number; supersededSince: boolean };
      setEdited(false);
      setEditedCount(0);
      setRefusal(null);
      setSaved(
        body.supersededSince
          ? `saved as v${body.version}, based on v${doc.version} — the agent has since written a newer one`
          : `saved as v${body.version}`,
      );
      // Follow, do not pin. What was just saved IS the newest version, so
      // following shows it - and keeps showing the newest one after that.
      //
      // Pinning here looked equivalent and was not. The version you saved
      // stops being current the moment the agent answers, and a version that
      // is not current is read only, so saving and then asking the agent for
      // anything locked you out of your own document with no explanation
      // beyond a small line offering the new version.
      setPinned(null);
    } finally {
      setSaving(false);
    }
  }, [doc, token, dead, conversationId]);

  // Re-anchoring. A note made against the version on screen already points
  // at an element there. One made against an earlier version has to be
  // found again — and only after that version's bytes verify against the
  // hash the record stored for them.
  const verified = React.useRef(new Map<string, boolean>());
  React.useEffect(() => {
    if (doc === null || token === null) return;
    let alive = true;
    void (async () => {
      const out: {
        note: string;
        fromVersion: number;
        elementId: string | null;
        how: Confidence | null;
        why: string | null;
        snippet: string;
        selectors: SpotSelectors | undefined;
      }[] = [];
      const target = new DOMParser().parseFromString(doc.bytes, "text/html");
      if (alive) setSeams([]);
      // The parsed bytes of each older version that verified, kept for the
      // seam walk: where a lost note's passage WAS is a question about the
      // old document, not the one on screen.
      const olderDocs = new Map<number, Document>();
      for (const [key, list] of Object.entries(sentNotes)) {
        const sep = key.lastIndexOf("@");
        if (sep === -1 || key.slice(0, sep) !== doc.artifactId) continue;
        const from = Number(key.slice(sep + 1));
        if (!Number.isSafeInteger(from)) continue;

        // Made against what is on screen: the ids still name the elements
        // they were written for, so nothing is resolved and nothing is
        // qualified.
        if (from === doc.version) {
          for (const n of list) {
            for (const sp of n.spots) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: sp.id,
                how: null,
                why: null,
                snippet: sp.snippet,
                selectors: sp.selectors as SpotSelectors | undefined,
              });
            }
          }
          continue;
        }

        // The snapshot guard. The selectors describe the bytes of the
        // version the note was made against, so those bytes are checked
        // before any selector is believed. Asked once per version.
        let ok = verified.current.get(key);
        if (ok === undefined) {
          try {
            const res = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(doc.artifactId)}/${from}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (res.ok) {
              const src = (await res.json()) as { bytes: string; hash: string };
              ok = (await sha256Hex(src.bytes)) === src.hash;
              if (ok === true && !olderDocs.has(from))
                olderDocs.set(from, new DOMParser().parseFromString(src.bytes, "text/html"));
            } else {
              ok = false;
            }
          } catch {
            ok = false;
          }
          verified.current.set(key, ok);
        }
        if (!alive) return;

        for (const n of list) {
          // Each spot resolves on its own, and whichever survive are kept.
          for (const sp of n.spots) {
            const sel = sp.selectors as SpotSelectors | undefined;
            if (sel === undefined) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: null,
                how: null,
                why: "no-selectors",
                snippet: sp.snippet,
                selectors: undefined,
              });
              continue;
            }
            // A note written against a LATER version than the one on
            // screen was never about this one. Resolving it backwards and
            // reporting "lost its target" said the agent had removed
            // something, when all that happened is that you looked at an
            // older version.
            if (from > doc.version) {
              out.push({
                note: n.note,
                fromVersion: from,
                elementId: null,
                how: null,
                why: "later-version",
                snippet: sp.snippet,
                selectors: sel,
              });
              continue;
            }
            const r = resolveSpot(target, sel, ok === true);
            out.push(
              r.resolved
                ? {
                    note: n.note,
                    fromVersion: from,
                    elementId: r.elementId,
                    how: r.how,
                    why: null,
                    snippet: sp.snippet,
                    selectors: sel,
                  }
                : {
                    note: n.note,
                    fromVersion: from,
                    elementId: null,
                    how: null,
                    why: r.why,
                    snippet: sp.snippet,
                    selectors: sel,
                  },
            );
          }
        }
      }
      if (alive) setAnchored(out);

      // Where a lost note pointed (3e): the seam's placement is proven in
      // seams.ts against documents, not trusted from the one place it runs.
      // The older bytes were fetched above for the hash check and kept
      // parsed; the lost spots are everything the resolutions marked lost.
      if (alive)
        setSeams(
          seamsForLost(
            out
              .filter((a) => a.elementId === null && a.why !== "later-version" && a.why !== null)
              .map((a) => ({ fromVersion: a.fromVersion, selectors: a.selectors })),
            olderDocs,
            target,
            doc.version,
          ),
        );
    })();
    return () => {
      alive = false;
    };
  }, [doc, sentNotes, token, conversationId]);

  const onNew = React.useCallback(
    async (m: { content: readonly { type: string; text?: string }[] }): Promise<void> => {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("");
      if (text.trim() === "" || token === null || dead) return;
      const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/input`, {
        method: "POST",
        headers: { [TOKEN_HEADER]: token, "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 401) {
        setDead(true);
        return;
      }
      if (!res.ok) {
        // G2: the substrate refused the send, drawn where the refused act
        // happened - a magenta chip at the composer, not a toast and not a
        // page-level banner.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        addRefusal(null, `not sent — ${body.error ?? res.status}`);
      }
    },
    [conversationId, token, dead, addRefusal],
  );

  // A save is an artifact version entry, not an input, so it is not in the
  // transcript. The conversation still has to show that one happened — and
  // show that, never the document. Appended in version order: an artifact
  // entry carries no seq to interleave by, and a save is the most recent
  // thing its author did.
  const withSaves = React.useMemo(() => {
    // A version this person saved is a moment in the conversation, so it is
    // shown where it happened. It used to be appended after every message,
    // which put a save from yesterday below an answer from a minute ago and
    // made it read as something that had just occurred.
    //
    // An artifact entry carries no seq of its own - the fold does not reduce
    // one into state - so the fold records the seq of the last line before
    // it, and that is the place. A version with no place, from a server that
    // does not send one, is left out rather than guessed at: a marker in the
    // wrong place is worse than no marker.
    const authors = catalog?.authors ?? {};
    const afterSeq = catalog?.afterSeq ?? {};
    const placed = Object.entries(authors)
      .filter(([, who]) => who === "human")
      .map(([v]) => Number(v))
      .filter((v) => typeof afterSeq[v] === "number")
      .sort((x, y) => x - y)
      .map((v) => ({
        after: afterSeq[v] as number,
        line: {
          id: `save-${catalog?.artifactId}-${v}`,
          role: "user" as const,
          text: `you saved ${catalog?.artifactId} v${v}`,
          note: true,
        },
      }));

    if (placed.length === 0) return dead ? weaveNotes(messages, []) : weaveNotes(messages, notes);

    const woven: Msg[] = [];
    let next = 0;
    for (const m of messages) {
      // Every save whose place is at or before this line goes in first.
      while (next < placed.length && (placed[next]?.after ?? 0) < (m.seq ?? 0)) {
        woven.push(placed[next++]?.line as Msg);
      }
      woven.push(m);
    }
    while (next < placed.length) woven.push(placed[next++]?.line as Msg);
    // Dead (3d): queued notes leave the timeline and become one held card
    // under it - "N notes, nothing sent" - because nothing can be sent and
    // a queue that looks live would say otherwise.
    return dead ? weaveNotes(woven, []) : weaveNotes(woven, notes);
  }, [messages, catalog, notes, dead]);

  const runtime = useExternalStoreRuntime<Msg>({
    messages: withSaves,
    setMessages: (next) => setMessages([...next]),
    onNew,
    convertMessage: (m: Msg) => ({
      id: m.id,
      role: m.role,
      content: [{ type: "text" as const, text: m.text }],
    }),
  });

  /** What to do next, in one line.
   *
   * The actions were discoverable only by trying them: three buttons whose
   * names said what they did and nothing about when they applied, and a
   * selection whose only feedback was inside a frame. This says which state
   * the page is in and what the next act is. */
  /** Keyed the way the batch line looks a note up: what it said, and what
   * it pointed at. */
  /** The count chip's data: every note each block has carried, answered or
   * not (handoff, "State needed": noteCountByBlock). The record hands the
   * page notes, not counts - sent ones as anchors against the version on
   * screen, queued ones as the batch being composed - so the tally is
   * derived here, client-side, from what the page already holds. A note
   * pointing at the same block twice counts once for that block; the chip
   * answers "how many notes", not "how many spots". */
  const noteCountByBlock = React.useMemo(() => {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    const add = (id: string, by: string): void => {
      const key = `${by}\u0000${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    };
    for (const a of anchored) if (a.elementId !== null) add(a.elementId, a.note);
    for (const n of notes) for (const sp of n.spots) add(sp.id, n.note);
    return counts;
  }, [anchored, notes]);

  const resolutions = React.useMemo(() => {
    const m = new Map<
      string,
      {
        lost: boolean;
        later: boolean;
        how: string | null;
        elementId: string | null;
        fromVersion: number;
      }
    >();
    for (const a of anchored) {
      m.set(`${a.note}\u0000${a.snippet}`, {
        lost: a.elementId === null && a.why !== "later-version",
        later: a.why === "later-version",
        // What the note points at in the version on screen. Already resolved
        // - it is what decides the "found again, exactly" line below - so
        // going there needs no second search.
        elementId: a.elementId,
        fromVersion: a.fromVersion,
        how:
          a.how === null
            ? null
            : a.how === "exact"
              ? "found again, exactly"
              : a.how === "approximate"
                ? "found again, reworded"
                : a.how === "position"
                  ? "found by position"
                  : "found by path",
      });
    }
    return m;
  }, [anchored]);

  viewingOldRef.current = pinnedOld;
  // The save bar hides the mode control while an edit is pending, so the
  // hotkey goes with it. A key that still worked would be an unlabelled
  // way past a bar whose whole claim is that there are two things to do.
  editedRef.current = edited;
  // The version on screen, for readers that must not re-run when it
  // changes. The document channel is one: making it depend on `doc`
  // would restart a fetching effect every time a fetch finished.
  docRef.current = doc;

  const guidance = ((): { text: string; tone: "idle" | "ready" | "warn" } => {
    if (doc === null) return { text: "No document in this conversation yet.", tone: "idle" };
    if (refusal !== null) return { text: refusal, tone: "warn" };
    // Said before anything else about the document, because it explains why
    // every other affordance is missing.
    if (pinnedOld)
      return {
        text: `Version ${doc?.version} — read only. Only the current version can be edited or written about.`,
        tone: "warn",
      };
    // Being overtaken is not read only, so it does not take this branch. An
    // edit in progress keeps saying what it says, and the banner above the
    // document is what reports the newer version.
    if (edited)
      return {
        text: overtaken
          ? "You changed the document. Save to keep it — it will land on top of the newer version."
          : "You changed the document. Save to keep it.",
        tone: "ready",
      };
    // What the last save did. It was recorded and never shown, so a save the
    // server turned down looked exactly like one that worked.
    if (saved !== null)
      return { text: saved, tone: saved.startsWith("not saved") ? "warn" : "ready" };
    // The box is beside what it is about now, and it says what is selected.
    // Repeating that down here told the reader to look in the wrong place.
    if (selection.length > 0)
      return { text: "⌘-click to put more of the document in this note.", tone: "ready" };
    if (notes.length > 0)
      return {
        text: `${notes.length} note${notes.length === 1 ? "" : "s"} ready. ⌘⏎ sends them, or select more.`,
        tone: "ready",
      };
    // The mode how-to is gone (Kevin, 2026-08-29): the sheet's tab carries
    // the mode, and a hint that repeats it forever stops being read. What
    // renders down here now is only what is news - a warning, an outcome,
    // a count. Nothing to say, nothing drawn.
    return { text: "", tone: "idle" };
  })();

  /** Handed to every note card. Refuses while an older version is pinned:
   * the note's target was resolved against what is on screen, and jumping
   * inside a version the note was not written against points at the wrong
   * place rather than at nothing. */
  const goToSpot = React.useCallback(
    (ids: readonly string[]) => {
      if (pinnedOld) return;
      focusSpot.current?.(ids);
    },
    [pinnedOld],
  );

  /** The frame says the person changed the document, and by how many blocks
   * (6c names the quantity in the discard dialog). */
  const onDirty = React.useCallback((edits: number): void => {
    setEdited(true);
    setEditedCount(edits);
  }, []);

  /** What a version changed out of sight (6a). Shown blocks pulsed; these
   * are offered at the sheet edge nearest them instead, and taking the
   * offer is the only thing that moves the page. */
  const onOffscreen = React.useCallback(
    (below: readonly number[], above: readonly number[]): void => {
      if (below.length === 0 && above.length === 0) {
        setOffer(null);
        return;
      }
      const side = below.length > 0 ? "below" : "above";
      const list = side === "below" ? below : above;
      setOffer({ side, count: list.length, index: list[0] as number, note: false });
    },
    [],
  );

  /** A note's target sat off screen (6a). The frame refused to scroll; the
   * offer docks here and says the note is the reason. */
  const onTravel = React.useCallback((index: number, below: boolean): void => {
    setOffer({ side: below ? "below" : "above", count: 1, index, note: true });
  }, []);

  /** A thumbnail for a stored attachment, read back once per hash through
   * the token-checked endpoint. Null when the bytes are not a picture; a
   * failed read leaves the design's placeholder rather than a broken img. */
  const thumbCache = React.useRef(new Map<string, string | null>());
  const thumbFor = React.useCallback(
    (hash: string): Promise<string | null> => {
      const had = thumbCache.current.get(hash);
      if (had !== undefined) return Promise.resolve(had);
      return (async (): Promise<string | null> => {
        let url: string | null = null;
        try {
          if (token !== null) {
            const got = await fetch(
              `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${hash}`,
              { headers: { [TOKEN_HEADER]: token } },
            );
            if (got.ok) {
              const blob = await got.blob();
              if (blob.type.startsWith("image/")) url = URL.createObjectURL(blob);
            }
          }
        } catch {
          url = null;
        }
        thumbCache.current.set(hash, url);
        return url;
      })();
    },
    [token, conversationId],
  );

  /** The conversation's status pill, counted and clocked (3c, 6e Wait).
   * Working is progress in the accent family; stalled is the one warning,
   * in neutral ink, because a stall is not a refusal; idle says nothing
   * more than that nobody is working. */
  const busy = activity.turn || activity.inFlight > 0 || activity.waiting > 0;
  // When this stretch of work began. Held across renders because nothing in
  // the record says it: a turn writes no line between its input and its
  // terminal event, so the only witness to the start is the page that saw
  // idle become busy. Adjusted during render, which is React's own form for
  // state derived from a change in props.
  const [wasBusy, setWasBusy] = React.useState(busy);
  const [startedAt, setStartedAt] = React.useState<number | null>(busy ? now : null);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    setStartedAt(busy ? now : null);
  }
  // A turn that streams resets the clock as it goes; one that says nothing
  // until it finishes is timed from when it started.
  const since = Math.max(startedAt ?? now, lastChange);
  const report = describeActivity(activity, (now - since) / 1000);
  const pillLabel = report.stalled
    ? `stopped · ${report.elapsed ?? "a while"} ago`
    : busy
      ? `working${report.elapsed === null ? "" : ` · ${report.elapsed}`}`
      : "idle";

  /** The header over the document column, in its three states (README \u00a71):
   * reading on the ground, ink while changes are unsaved, and the one
   * magenta state when there is no driver. Everything it shows is decided by
   * data the page already holds - it never invents a state. */
  const headerTitle = (doc: Doc): React.ReactNode => {
    if (dead || damaged)
      return (
        <>
          <span className="none-name">{dead ? "No driver" : "Damaged record"}</span>
          <span className="head-cause">
            {dead
              ? "this page's token is no longer valid · your work is on disk"
              : "the log is damaged past a point · what follows is not shown"}
          </span>
        </>
      );
    const title = allArtifacts.find((a) => a.artifactId === doc.artifactId)?.title;
    return (
      <DocName
        artifactId={doc.artifactId}
        {...(title === undefined ? {} : { title })}
        onRename={rename}
      />
    );
  };

  const nextVersion = (catalog?.latest ?? doc?.version ?? 0) + 1;
  /** The number of saved versions, for the discard dialog's second fact. */
  const savedCount = catalog?.versions.length ?? null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Resolutions.Provider value={resolutions}>
        <FocusSpot.Provider value={goToSpot}>
          <CompareWith.Provider value={(v: number) => void compareWith(v)}>
            <ThumbFor.Provider value={thumbFor}>
              {problem === null || dead || damaged ? null : (
                <div className="notice" role="alert">
                  {problem}
                </div>
              )}

              <div className="panes">
                {/* The document is the thing being worked on, so it gets the room
                and the left side. The conversation is the margin note. */}
                <div className="pane document">
                  {unknownArtifact !== null ? (
                    <>
                      {/* 6d: the address named an artifact this record does not
                          hold. Not an error and not styled as one - the way
                          on is the artifact it does hold, named plainly. */}
                      <div className="doc-head">
                        <span className="doc-mark" aria-hidden="true">
                          <span className="dot" />
                          <span className="word">lucid</span>
                        </span>
                        <span className="doc-head-sep" aria-hidden="true" />
                        {allArtifacts.length === 0 ? (
                          <span className="none-name">No document</span>
                        ) : (
                          <span className="dim-name">
                            {displayName(allArtifacts[0] as CatalogEntry)}
                          </span>
                        )}
                      </div>
                      <div className="doc-ground">
                        <div className="empty-panel">
                          <div className="miss-heading">
                            This conversation has no artifact called{" "}
                            <code className="miss-name">{unknownArtifact}</code>.
                          </div>
                          <div className="miss-line">
                            It holds {allArtifacts.length} artifact
                            {allArtifacts.length === 1 ? "" : "s"}. Nothing is missing and nothing
                            failed — the address simply named something else.
                          </div>
                          {allArtifacts.length === 0 ? null : (
                            <div className="artifact-row">
                              <span className="artifact-glyph" aria-hidden="true">
                                <FileTextDuotone size={20} />
                              </span>
                              <span className="artifact-meta">
                                <span className="artifact-name">
                                  {displayName(allArtifacts[0] as CatalogEntry)}
                                </span>
                                <span className="artifact-facts">
                                  {(() => {
                                    const one = allArtifacts[0] as CatalogEntry;
                                    return `v${one.latest} · latest of ${one.versions.length} · saved by ${one.authors?.[one.latest] === "human" ? "you" : "the agent"}`;
                                  })()}
                                </span>
                              </span>
                              <button
                                type="button"
                                className="primary"
                                onClick={() =>
                                  openArtifact((allArtifacts[0] as CatalogEntry).artifactId)
                                }
                              >
                                Open
                              </button>
                            </div>
                          )}
                        </div>
                        {/* The guidance line, under the panel on the ground. */}
                        <div className="doc-panel">
                          <div className="guidance idle">
                            Ask the agent for “{unknownArtifact}” and it becomes a second artifact
                            here.
                          </div>
                        </div>
                      </div>
                    </>
                  ) : doc === null ? (
                    <>
                      {/* 3a: no document, so no version pill and no mode toggle
                          - the header says so rather than showing dead
                          controls. The way in is the conversation. */}
                      <div className="doc-head">
                        <span className="doc-mark" aria-hidden="true">
                          <span className="dot" />
                          <span className="word">lucid</span>
                        </span>
                        <span className="doc-head-sep" aria-hidden="true" />
                        <span className="none-name">No document</span>
                      </div>
                      <div className="doc-ground">
                        <div className="empty-panel">
                          <div className="empty-line">
                            Nothing here yet. Ask on the right, or attach a file — either way lucid
                            writes v1 and keeps it.
                          </div>
                          {/* Attaching here is the composer's own act: the file
                              is stored and rides the next thing said, exactly
                              as if the clip on the right had been pressed.
                              Dropping a file ONTO the document is not a
                              gesture - a file is never a version. */}
                          <label className="v choose">
                            Choose a file
                            <input
                              type="file"
                              multiple
                              onChange={(e) => {
                                if (e.currentTarget.files !== null)
                                  attachFiles(e.currentTarget.files);
                                e.currentTarget.value = "";
                              }}
                            />
                          </label>
                        </div>
                        <div className="doc-panel">
                          <div className="guidance idle">No document in this conversation yet.</div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {/* App Bridge, as #171 settled it: with an unsaved edit the
                    header stops describing the document and becomes the
                    question, and nothing else. The name stays; the version
                    pill and the modes are not merely disabled but gone - the
                    only two things there are to do are the two that are here.

                    3f is the same bar: a version arriving underneath changes
                    only the clause it states and the number it offers, and
                    the conversation card below carries the same two answers. */}
                      {dead || damaged ? (
                        <div className="doc-head dead">
                          <span className="doc-mark" aria-hidden="true">
                            <span className="dot" />
                            <span className="word">lucid</span>
                          </span>
                          <span className="doc-head-sep" aria-hidden="true" />
                          {headerTitle(doc)}
                          {/* 3d: Reload is the only action. The token cannot
                              come back any other way, and the work is already
                              on disk. */}
                          <button
                            type="button"
                            className="v reload"
                            onClick={() => window.location.reload()}
                          >
                            Reload
                          </button>
                        </div>
                      ) : edited ? (
                        <div className="doc-head saving-bar">
                          <span className="doc-mark" aria-hidden="true">
                            <span className="dot" />
                            <span className="word">lucid</span>
                          </span>
                          <span className="doc-head-sep" aria-hidden="true" />
                          {headerTitle(doc)}
                          <span className="saving-clause">
                            {waiting !== null && waiting > doc.version
                              ? `unsaved · v${waiting} arrived while you typed`
                              : "unsaved changes"}
                          </span>
                          <button
                            type="button"
                            className="v"
                            onClick={() => setConfirmDiscardEdit(true)}
                            disabled={saving}
                          >
                            Discard
                          </button>
                          <button
                            type="button"
                            className="v primary"
                            onClick={() => void save()}
                            disabled={saving}
                          >
                            {saving ? "Saving…" : `Save as v${nextVersion}`}
                          </button>
                        </div>
                      ) : (
                        <div className="doc-head">
                          {/* lucid, over the document: the mark, a hairline, then
                      the name. Nothing else above the sheet. */}
                          <span className="doc-mark" aria-hidden="true">
                            <span className="dot" />
                            <span className="word">lucid</span>
                          </span>
                          <span className="doc-head-sep" aria-hidden="true" />
                          {headerTitle(doc)}
                          {/* One version is a badge with nothing to open. More than
                    one is the version pill: its closed state is the design's,
                    and the invisible select over it opens the native dropdown.
                    A hundred versions is a hundred buttons otherwise, and a
                    long conversation produces a hundred versions. */}
                          {comparing !== null ? (
                            <span className="doc-version-pill compare-pill">
                              <span className="v">v{comparing.version}</span>
                              <span className="arrow" aria-hidden="true">
                                <ArrowRightDuotone />
                              </span>
                              <span className="v">v{doc.version}</span>
                            </span>
                          ) : catalog === null || catalog.versions.length < 2 ? (
                            <span className="doc-version">v{doc.version}</span>
                          ) : (
                            <span className="doc-version-pill">
                              <span className="v">v{doc.version}</span>
                              {viewingOld ? null : (
                                <span className="of">latest of {catalog.versions.length}</span>
                              )}
                              <span className="caret" aria-hidden="true">
                                <CaretDownDuotone />
                              </span>
                              <select
                                className="pill-select"
                                value={String(doc.version)}
                                aria-label="Version"
                                onChange={(e) => {
                                  const picked = Number.parseInt(e.target.value, 10);
                                  // Choosing the current version is choosing to follow
                                  // it, not to pin it there. Otherwise the newest
                                  // version arriving would leave you on a stale one
                                  // that the picker calls current.
                                  setPinned(picked === catalog.latest ? null : picked);
                                }}
                              >
                                {[...catalog.versions].reverse().map((v) => (
                                  <option key={v} value={String(v)}>
                                    v{v}
                                    {catalog.authors?.[v] === "human"
                                      ? " · saved by you"
                                      : " · by the agent"}
                                    {v === catalog.latest ? " · current" : ""}
                                  </option>
                                ))}
                              </select>
                            </span>
                          )}
                          {/* G4: a pinned old version states its rule in the
                          lock vocabulary - read-only, neutral ink, never
                          magenta, because going back on purpose refused
                          nothing. */}
                          {pinnedOld && comparing === null ? (
                            <span className="lock-chip">
                              <LockDuotone size={11} />
                              viewing v{doc.version} · read-only
                            </span>
                          ) : null}
                          {/* Offered only where there is something to compare
                      against: one version has nothing to be held against, and
                      while a comparison is open the header already states
                      which two it holds. */}
                          {comparing !== null ||
                          catalog === null ||
                          catalog.versions.length < 2 ? null : (
                            <select
                              className="compare-pick"
                              value=""
                              aria-label="Compare with another version"
                              onChange={(e) => {
                                const v = Number.parseInt(e.target.value, 10);
                                if (Number.isSafeInteger(v)) void compareWith(v);
                                e.currentTarget.value = "";
                              }}
                            >
                              <option value="">Compare with…</option>
                              {catalog?.versions
                                .filter((v) => v !== doc.version)
                                .map((v) => (
                                  <option key={v} value={String(v)}>
                                    v{v}
                                  </option>
                                ))}
                            </select>
                          )}
                          {comparing === null && pinned !== null ? (
                            <button
                              type="button"
                              className="v latest"
                              onClick={() => setPinned(null)}
                            >
                              {viewingOld ? "Back to current" : "Follow newest"}
                            </button>
                          ) : null}
                          {comparing === null && pinnedOld ? (
                            <button
                              type="button"
                              className="v restore"
                              onClick={() => setConfirmRestore(doc.version)}
                              title={`Make v${doc.version} the current version`}
                            >
                              Restore this version
                            </button>
                          ) : null}
                          {comparing !== null ? (
                            /* 6b: there is no mode here and neither side takes a
                          caret, so the toggle is replaced by the lock chip
                          and the way out. */
                            <>
                              <span className="lock-chip">
                                <LockDuotone size={11} />
                                read-only · comparing
                              </span>
                              <button
                                type="button"
                                className="v"
                                onClick={() => setComparing(null)}
                              >
                                Close
                              </button>
                            </>
                          ) : (
                            <span className="modes">
                              <button
                                type="button"
                                className={mode === "annotate" ? "m current" : "m"}
                                onClick={() => setMode("annotate")}
                                disabled={pinnedOld}
                                title="Click parts of the document to write notes about them (⌥⌫)"
                              >
                                Annotate
                              </button>
                              <button
                                type="button"
                                className={mode === "edit" ? "m current" : "m"}
                                onClick={() => setMode("edit")}
                                disabled={pinnedOld}
                                title="Tick boxes, fill fields, and edit text (⌥⌫)"
                              >
                                Edit
                              </button>
                            </span>
                          )}
                        </div>
                      )}

                      {/* The other half of the update-location rule (#181). What
                  the reader could see pulsed and is not mentioned; what they
                  could not see did not pulse and is offered here - at the
                  sheet edge nearest the target, per 6a. Saying both would be
                  saying it twice. */}
                      {offer === null ? null : (
                        <button
                          type="button"
                          className={`travel-offer ${offer.side}`}
                          title="Put the target at the centre of the sheet"
                          onClick={() => {
                            goBlock.current?.(offer.index);
                            setOffer(null);
                          }}
                        >
                          <span className="t-arrow" aria-hidden="true">
                            {offer.side === "below" ? <ArrowDownDuotone /> : <ArrowUpDuotone />}
                          </span>
                          <span className="t">
                            {offer.note
                              ? `1 change ${offer.side} · the note points there`
                              : `${offer.count} change${offer.count === 1 ? "" : "s"} ${offer.side}`}
                          </span>
                          <span className="jump">Jump</span>
                        </button>
                      )}

                      {waiting === null ||
                      waiting <= doc.version ||
                      edited ||
                      dead ||
                      damaged ? null : (
                        <div className="doc-waiting">
                          Version {waiting} has arrived.{" "}
                          {/* Follow rather than pin, for the reason the save path
                        gives: pinning to the newest version now means being
                        read-only against the one after it. */}
                          <button type="button" onClick={goToNewest}>
                            show it
                          </button>
                        </div>
                      )}

                      {/* A comparison replaces the sheet on the ground (6b); the
                    header above it states which two versions, and leaving it
                    returns to the version that was being read, exactly where
                    it was. */}
                      {comparing === null ? (
                        <div
                          className={
                            mode === "edit" && !(pinnedOld || dead || damaged)
                              ? "doc-ground edit"
                              : "doc-ground"
                          }
                        >
                          {/* The frame and the note box share one positioned box, so
                  a rect in the frame's own viewport is also a position on
                  this page and the anchor needs no arithmetic. The box is
                  the sheet: --paper, the mode's 1px border, radius 12px. */}
                          <div
                            className={[
                              "doc-stage",
                              pinnedOld ? "ro" : "",
                              dead || damaged ? "dead" : "",
                            ]
                              .filter((c) => c !== "")
                              .join(" ")}
                          >
                            {/* The tab on the sheet's top edge carries the mode. An
                    indicator only - the toggle in the header is the control.
                    A version that refuses everything says that instead: grey,
                    edge ink, no mode named (G4, 3d). */}
                            {dead || damaged ? (
                              <div className="doc-tab grey" aria-hidden="true">
                                {dead ? "Read only — no driver" : "Read only"}
                              </div>
                            ) : pinnedOld ? (
                              <div className="doc-tab grey" aria-hidden="true">
                                Read only
                              </div>
                            ) : (
                              <div className="doc-tab" aria-hidden="true">
                                {mode === "edit" ? "Edit" : "Annotate"}
                              </div>
                            )}
                            <DocumentFrame
                              doc={doc}
                              onSelection={onSelected}
                              capture={capture}
                              snapshot={snapshot}
                              deselect={deselect}
                              focusSpot={focusSpot}
                              place={place}
                              restorePlace={restorePlace}
                              pendingRestore={pendingRestore}
                              pendingPulse={pendingPulse}
                              pulseBlocks={pulseBlocks}
                              goBlock={goBlock}
                              onOffscreen={onOffscreen}
                              onTravel={onTravel}
                              onMarksBelow={setMarksBelow}
                              onSeamClick={(v) => void compareWith(v)}
                              seams={seams}
                              onHotkey={onHotkey}
                              onDirty={onDirty}
                              noteCounts={noteCountByBlock}
                              mode={mode}
                              readOnly={pinnedOld || dead || damaged}
                            />

                            {/* 3g: most of the marks are below the fold on a long
                        document. The bottom 56px of the sheet fades to
                        paper and one ink pill says how many are down there;
                        taking it goes to the next one. The scrollbar stays
                        a scrollbar - no tick marks, no minimap. */}
                            {marksBelow.length === 0 ? null : (
                              <>
                                <div className="sheet-fade" aria-hidden="true" />
                                <button
                                  type="button"
                                  className="marks-pill"
                                  title="Go to the next noted block"
                                  onClick={() => {
                                    const first = marksBelow[0];
                                    if (first !== undefined) goBlock.current?.(first);
                                  }}
                                >
                                  <span className="dot" aria-hidden="true" />
                                  {marksBelow.length} note{marksBelow.length === 1 ? "" : "s"} below
                                </button>
                              </>
                            )}

                            {/* Written where you clicked. The box used to be a panel at
                    the bottom of the pane, so the thing being written about
                    and the writing were at opposite ends of the screen. */}
                            <Popover.Root
                              open={selection.length > 0 && selRect !== null}
                              // Whether it is open is a fact about the selection, so
                              // the selection is the only thing that decides it. The
                              // library asked to close on any click outside and took
                              // a half-written note with it; refusing here means the
                              // ways out are Cancel, Escape, and Add note.
                              onOpenChange={() => {}}
                            >
                              <Popover.Anchor asChild>
                                <div
                                  className="sel-anchor"
                                  style={
                                    selRect === null
                                      ? { display: "none" }
                                      : {
                                          left: `${selRect.x}px`,
                                          top: `${selRect.y}px`,
                                          width: `${selRect.width}px`,
                                          height: `${selRect.height}px`,
                                        }
                                  }
                                />
                              </Popover.Anchor>
                              <Popover.Portal>
                                <Popover.Content
                                  className="note-pop"
                                  // Under the line, not beside it. A block in a
                                  // document is as wide as the column, so there is
                                  // never room to the side — Radix said so, reporting
                                  // 128px available, and the box hung off the screen.
                                  // Below, it flips above near the bottom and slides
                                  // sideways to stay in view.
                                  side="bottom"
                                  align="start"
                                  // Stepped in from the left edge of what it points at.
                                  // Flush, its edge lined up with the paragraph's and
                                  // the two read as one block.
                                  alignOffset={28}
                                  sideOffset={8}
                                  collisionPadding={12}
                                  // Only Escape and the buttons close it. A click into
                                  // the document is how a second spot is added, and it
                                  // must not throw away what is already typed.
                                  onInteractOutside={(e) => e.preventDefault()}
                                  onFocusOutside={(e) => e.preventDefault()}
                                  onEscapeKeyDown={cancelNote}
                                  onOpenAutoFocus={(e) => {
                                    e.preventDefault();
                                    noteBox.current?.focus();
                                  }}
                                >
                                  <div className="note-pop-head">
                                    {notes.length >= NOTE_QUEUE_MAX
                                      ? `${NOTE_QUEUE_MAX} notes queued — send them before writing another`
                                      : `${selection.length} selected${selection.length > 1 ? " — ⌘-click adds more" : ""}`}
                                  </div>
                                  <textarea
                                    ref={noteBox}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        void addNote();
                                      }
                                    }}
                                    placeholder={`What about ${selection.length === 1 ? "this" : `these ${selection.length}`}? (⌘⏎ to add)`}
                                    rows={3}
                                  />
                                  {noteFiles.length + noteUploading.length + noteRefusals.length ===
                                  0 ? null : (
                                    <div className="attached in-note">
                                      {noteUploading.map((u) => (
                                        <UploadingChip key={u.id} name={u.name} bytes={u.bytes} />
                                      ))}
                                      {noteFiles.map((a) =>
                                        a.url !== null || a.contentType.startsWith("image/") ? (
                                          <ImageChip
                                            key={a.hash}
                                            name={a.name}
                                            url={a.url}
                                            onRemove={() => removeNoteFile(a.hash)}
                                          />
                                        ) : (
                                          <PillChip
                                            key={a.hash}
                                            name={a.name}
                                            contentType={a.contentType}
                                            bytes={a.bytes}
                                            onRemove={() => removeNoteFile(a.hash)}
                                          />
                                        ),
                                      )}
                                      {noteRefusals.map((r) => (
                                        <RefusalChip
                                          key={r.id}
                                          name={r.name}
                                          reason={r.reason}
                                          onDismiss={() =>
                                            setNoteRefusals((prev) =>
                                              prev.filter((x) => x.id !== r.id),
                                            )
                                          }
                                        />
                                      ))}
                                    </div>
                                  )}
                                  <div className="note-pop-actions">
                                    {/* The half that carries this feature: a
                              screenshot of what is wrong with a paragraph is
                              marking up, which is what lucid is for. */}
                                    <label className="attach" title="Attach a file to this note">
                                      <PaperclipDuotone size={16} />
                                      <input
                                        type="file"
                                        multiple
                                        onChange={(e) => {
                                          if (e.currentTarget.files !== null)
                                            void attachToNote(e.currentTarget.files);
                                          e.currentTarget.value = "";
                                        }}
                                      />
                                    </label>
                                    <button type="button" className="ghost" onClick={cancelNote}>
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      className="primary"
                                      onClick={() => void addNote()}
                                      disabled={
                                        draft.trim() === "" || notes.length >= NOTE_QUEUE_MAX
                                      }
                                    >
                                      Add note
                                    </button>
                                  </div>
                                  <Popover.Arrow className="note-pop-arrow" width={12} height={6} />
                                </Popover.Content>
                              </Popover.Portal>
                            </Popover.Root>
                          </div>

                          {/* The guidance line, under the sheet on the ground.
                              Empty when there is nothing to say. */}
                          <div className="doc-panel">
                            {guidance.text === "" ? null : (
                              <div className={`guidance ${guidance.tone}`}>{guidance.text}</div>
                            )}

                            {/* Saving moved to the top bar with #171, and this is
                        what is left: the last save's outcome, which is news
                        rather than an action. A second Save down here would be
                        a second place to look for the same thing. */}
                            {saved === null ? null : <div className="note-actions">{saved}</div>}
                          </div>
                        </div>
                      ) : (
                        <Comparison
                          artifactId={doc.artifactId}
                          left={comparing.bytes}
                          right={doc.bytes}
                          leftVersion={comparing.version}
                          rightVersion={doc.version}
                        />
                      )}
                    </>
                  )}
                </div>

                {/* An `hr`, because that is what a separator is. It carries its
              width so a reader that cannot see the drag is still told what
              the arrow keys just did. */}
                <hr
                  className={dragging ? "pane-grip dragging" : "pane-grip"}
                  onPointerDown={startDrag}
                  onKeyDown={nudgeDrag}
                  tabIndex={0}
                  aria-orientation="vertical"
                  aria-label="Resize the conversation"
                  aria-valuemin={CONVERSATION_MIN}
                  aria-valuemax={CONVERSATION_MAX}
                  aria-valuenow={convWidth ?? undefined}
                />

                <div
                  className="pane conversation"
                  style={
                    convWidth === null
                      ? undefined
                      : ({ "--conversation-width": `${convWidth}px` } as React.CSSProperties)
                  }
                >
                  {/* The conversation's own 34px row, aligned with the document
              header so both columns top out together: its name, what is
              driving it, and how it stands - counted and clocked. */}
                  <div className="conv-head">
                    <span className="conv-name">
                      {conversationId === "" ? "no conversation" : conversationId}
                    </span>
                    {/* What is driving, named from the same Driver the
                driver line under the composer renders (7a-7d), so the two
                surfaces cannot disagree. Identity, not status. */}
                    {driverHeadline(driver) === null ? null : (
                      <span
                        className="conv-driver"
                        title={
                          driver.harnessVersion === undefined ? undefined : driver.harnessVersion
                        }
                      >
                        {driverHeadline(driver)}
                      </span>
                    )}
                    <span
                      className={
                        report.stalled
                          ? "conv-pill stopped"
                          : report.busy
                            ? "conv-pill busy"
                            : "conv-pill"
                      }
                      title={status === "" ? undefined : status}
                    >
                      <span className="dot" aria-hidden="true" />
                      <span className="label">{pillLabel}</span>
                    </span>
                  </div>
                  <Thread
                    pending={notes}
                    onSendNotes={() => void sendNotes()}
                    onDiscardNotes={() => setNotes([])}
                    sending={sending}
                    report={report}
                    version={doc?.version ?? null}
                    dead={dead}
                    invite={doc === null && !dead}
                    collision={
                      edited && waiting !== null && waiting > (doc?.version ?? 0)
                        ? { arrived: waiting, next: nextVersion }
                        : null
                    }
                    onSave={() => void save()}
                    onShowWaiting={(arrived) => setConfirmDiscard(arrived)}
                    attachments={attached}
                    uploading={uploading}
                    refusals={refusals}
                    onAttach={(files) => void attachFiles(files)}
                    onRemoveAttachment={removeAttachment}
                    onDismissRefusal={(id) =>
                      setRefusals((prev) => prev.filter((r) => r.id !== id))
                    }
                    driver={driver}
                    driverPreference={driverPreference}
                    driverChoices={driverChoices}
                    onDriverChoice={chooseDriver}
                  />
                </div>
              </div>

              {/* 6c: discard confirms, and the G5 restore confirm in the same
              shell. The only dialogs, because discard is the only control
              that destroys work - and the filled action is ink, never
              magenta, because a choice the person made is not the substrate
              refusing. */}
              {confirmDiscardEdit ? (
                <Dialog
                  title={
                    editedCount > 1
                      ? `Discard your ${editedCount} edits?`
                      : editedCount === 1
                        ? "Discard your edit?"
                        : "Discard your changes?"
                  }
                  body={
                    <>
                      They have not been saved to a version, so discarding is the one thing in lucid
                      that destroys work.
                      {savedCount === null ? (
                        " Every version already saved is untouched."
                      ) : (
                        <> Every version already saved — all {savedCount} — is untouched.</>
                      )}
                    </>
                  }
                  keep="Keep editing"
                  go="Discard them"
                  busy={saving}
                  onKeep={() => setConfirmDiscardEdit(false)}
                  onGo={() => {
                    setConfirmDiscardEdit(false);
                    setEdited(false);
                    setEditedCount(0);
                    // The change lives in the frame, so the frame has to
                    // be rebuilt from the stored bytes to be rid of it.
                    setDoc((d) => (d === null ? d : { ...d }));
                  }}
                />
              ) : null}
              {confirmDiscard === null ? null : (
                <Dialog
                  title={`Discard your edits and show v${confirmDiscard}?`}
                  body={
                    <>
                      Your changes have not been saved to a version, so this is the one thing in
                      lucid that destroys work. Saving instead keeps them: they land on top of v
                      {confirmDiscard} as v{nextVersion}, and the agent is told what they were based
                      on.
                      {savedCount === null
                        ? ""
                        : ` All ${savedCount} saved versions are untouched.`}
                    </>
                  }
                  keep="Keep editing"
                  go="Discard them"
                  busy={saving}
                  onKeep={() => setConfirmDiscard(null)}
                  onGo={() => {
                    setEdited(false);
                    setEditedCount(0);
                    setConfirmDiscard(null);
                    goToNewest();
                  }}
                />
              )}
              {confirmRestore === null ? null : (
                <Dialog
                  title={`Restore v${confirmRestore}?`}
                  body={
                    <>
                      The old bytes land as a new version at the end of the list — v
                      {(catalog?.latest ?? doc?.version ?? 0) + 1}. Nothing is destroyed: every
                      version stays in the record, and going back is restoring v
                      {catalog?.latest ?? doc?.version ?? 0} the same way.
                    </>
                  }
                  keep="Keep viewing"
                  go={restoring ? "Restoring…" : "Restore"}
                  busy={restoring}
                  onKeep={() => setConfirmRestore(null)}
                  onGo={() => void restore()}
                />
              )}
            </ThumbFor.Provider>
          </CompareWith.Provider>
        </FocusSpot.Provider>
      </Resolutions.Provider>
    </AssistantRuntimeProvider>
  );
};

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<App />);
