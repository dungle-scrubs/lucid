import React from "react";
import { TopBar } from "./TopBar.jsx";
import { Button } from "./Button.jsx";
import { Pill } from "./Pill.jsx";
import { Bubble } from "./Bubble.jsx";
import { AnnotationCard } from "./AnnotationCard.jsx";

/* Editor - the full Lucid editor chrome.
   Two columns: a left CHROME panel (~384px, --bg-raised, hairline right border)
   wrapped around a right SURFACE (the cream paper artifact + an annotation OVERLAY).

   Interactivity (all React useState):
     - Click a list item or the paragraph phrase → it gets the brass mark and the
       left composer opens for that target.
     - Hover an item in the Annotations list → its on-surface mark brightens (focus).
     - "Add to queue" moves the draft into Queued; "Send message" clears the queue.
     - "Approve review" toggles an approved bar.

   The element annotation outline IS the focus ring (2px brass, 2px offset). The
   text-range annotation is a translucent brass highlight. Every value is a token. */

export const styles = {
  shell: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    background: "var(--bg)",
    color: "var(--fg)",
    fontFamily: "var(--font-sans)",
    overflow: "hidden",
  },
  body: {
    display: "grid",
    gridTemplateColumns: "384px 1fr",
    flex: "1 1 auto",
    minHeight: 0,
  },

  /* ---- left chrome -------------------------------------------------------- */
  chrome: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    background: "var(--bg-raised)",
    borderRight: "1px solid var(--border)",
  },
  chromeScroll: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  section: {
    padding: "var(--space-4)",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-2)",
  },
  eyebrow: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-semibold)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-caps)",
    color: "var(--fg-muted)",
    margin: 0,
  },
  count: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-faint)",
  },
  hint: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg-muted)",
    margin: 0,
  },

  /* composer */
  composer: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  capturedLabel: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-faint)",
    letterSpacing: "var(--tracking-wide)",
  },
  captured: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-snug)",
    color: "var(--fg)",
    background: "var(--bg-inset)",
    border: "1px solid var(--border-inset)",
    borderLeft: "2px solid var(--annot-color)",
    borderRadius: "var(--radius-sm)",
    padding: "var(--space-2) var(--space-3)",
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    resize: "none",
    minHeight: "72px",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg)",
    background: "var(--bg-inset)",
    border: "1px solid var(--border-inset)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    outline: "none",
    transition: "border-color var(--dur-base) var(--ease)",
  },
  composerActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },

  /* annotations list */
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  item: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    textAlign: "left",
    width: "100%",
    boxSizing: "border-box",
    background: "var(--bg-overlay)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    cursor: "pointer",
    boxShadow: "var(--shadow-none)",
    transition:
      "background var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease)",
  },
  itemActive: {
    borderColor: "var(--accent-dim)",
    background: "var(--bg-overlay)",
  },
  itemHover: {
    borderColor: "var(--border-strong)",
  },
  itemHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-2)",
  },
  itemSnippet: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  itemNote: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg)",
    margin: 0,
  },
  orphanGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    marginTop: "var(--space-2)",
  },

  queuedItem: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
    background: "var(--annot-fill)",
    border: "1px solid var(--brass-700)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
  },
  queuedSnippet: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: "var(--accent-bright)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  queuedNote: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg)",
    margin: 0,
  },

  conversation: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },

  /* footer */
  footer: {
    flex: "0 0 auto",
    padding: "var(--space-4)",
    borderTop: "1px solid var(--border)",
    background: "var(--bg-raised)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
  },
  footerActions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-2)",
  },

  approvedBar: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    background: "var(--agent-fill)",
    border: "1px solid var(--sage-600)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-2) var(--space-3)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    color: "var(--agent)",
  },

  /* ---- right surface ------------------------------------------------------ */
  surfaceWrap: {
    position: "relative",
    minWidth: 0,
    overflowY: "auto",
    background: "var(--bg)",
    padding: "var(--space-12) var(--space-8)",
    display: "flex",
    justifyContent: "center",
  },
  paper: {
    position: "relative",
    width: "100%",
    maxWidth: "640px",
    background: "var(--surface)",
    color: "var(--surface-ink)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-12) var(--space-12)",
  },
  artifactMeta: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--brass-700)",
    margin: "0 0 var(--space-3) 0",
  },
  h1: {
    fontFamily: "var(--font-serif)",
    fontWeight: "var(--weight-semibold)",
    fontSize: "var(--text-2xl)",
    lineHeight: "var(--leading-tight)",
    letterSpacing: "var(--tracking-tight)",
    color: "var(--surface-ink)",
    margin: "0 0 var(--space-6) 0",
  },
  lead: {
    fontFamily: "var(--font-serif)",
    fontSize: "var(--text-md)",
    lineHeight: "var(--leading-relaxed)",
    color: "var(--surface-ink)",
    margin: "0 0 var(--space-6) 0",
  },
  ol: {
    fontFamily: "var(--font-serif)",
    fontSize: "var(--text-md)",
    lineHeight: "var(--leading-relaxed)",
    color: "var(--surface-ink)",
    margin: "0 0 var(--space-6) 0",
    paddingLeft: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  li: {
    paddingLeft: "var(--space-1)",
    borderRadius: "var(--radius-sm)",
    cursor: "pointer",
    transition: "outline-color var(--dur-base) var(--ease)",
  },
  para: {
    fontFamily: "var(--font-serif)",
    fontSize: "var(--text-md)",
    lineHeight: "var(--leading-relaxed)",
    color: "var(--surface-ink)",
    margin: 0,
  },
  /* the text-range mark: translucent brass highlight, no box */
  range: {
    background: "var(--annot-fill)",
    borderRadius: "var(--radius-sm)",
    padding: "0 2px",
    cursor: "pointer",
    transition: "background var(--dur-base) var(--ease)",
  },
  rangeMarker: {
    color: "var(--annot-color)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    verticalAlign: "super",
    marginRight: "1px",
    userSelect: "none",
  },
  cardLayer: {
    position: "absolute",
    top: "var(--space-12)",
    right: "calc(-1 * var(--space-10))",
    zIndex: 5,
  },
};

/* element annotation outline == focus ring: 2px brass, 2px offset */
function elementOutline(on) {
  return {
    outline: on
      ? "var(--annot-outline-width) solid var(--annot-color)"
      : "var(--annot-outline-width) solid transparent",
    outlineOffset: "var(--annot-outline-offset)",
  };
}

const LIST_ITEMS = [
  { id: "step-1", text: "Take the service into a read-only window." },
  {
    id: "step-2",
    text: "Backfill the new columns from the existing rows.",
    snippet: "Backfill the new columns…",
  },
  { id: "step-3", text: "Cut writes over to the new schema and verify counts." },
  { id: "step-4", text: "Drop the deprecated columns once parity holds." },
];

const RANGE_TEXT = "before any write traffic resumes";

export function Editor() {
  // which on-surface target is selected ("element:step-2" | "range:para" | null)
  const [selected, setSelected] = React.useState("element:step-2");
  // which annotations-list item is hovered → brightens its on-surface mark
  const [focusedMark, setFocusedMark] = React.useState(null);
  const [draft, setDraft] = React.useState("Backfill must run first - verify counts before any write traffic resumes.");
  const [queued, setQueued] = React.useState([]);
  const [message, setMessage] = React.useState("");
  const [approved, setApproved] = React.useState(false);
  const [hoverItem, setHoverItem] = React.useState(null);

  const located = [
    {
      id: "element:step-2",
      snippet: "Backfill the new columns…",
      note: "Backfill must run first. Reorder this above the cut-over step.",
      version: "v2",
    },
    {
      id: "range:para",
      snippet: "before any write traffic resumes",
      note: "Verify row counts here, not after writes resume.",
      version: "v2",
    },
  ];

  const orphaned = [
    {
      id: "orphan:1",
      snippet: "rollback in under a minute",
      note: "This sentence was removed in v2; the anchor no longer attaches.",
    },
  ];

  const composerOpen = selected != null;
  const capturedSnippet =
    selected === "range:para"
      ? RANGE_TEXT
      : selected === "element:step-2"
        ? "Backfill the new columns from the existing rows."
        : selected
          ? LIST_ITEMS.find((i) => `element:${i.id}` === selected)?.text || ""
          : "";

  function selectElement(id) {
    setSelected(`element:${id}`);
  }

  function addToQueue() {
    if (!draft.trim() || !selected) return;
    setQueued((q) => [
      ...q,
      { id: `q-${Date.now()}`, snippet: capturedSnippet, note: draft.trim() },
    ]);
    setDraft("");
    setSelected(null);
  }

  function discardDraft() {
    setDraft("");
    setSelected(null);
  }

  function sendMessage() {
    setQueued([]);
    setMessage("");
  }

  const markActive = (markId) => selected === markId || focusedMark === markId;

  return (
    <div style={styles.shell}>
      <TopBar title="Database migration plan" version="v2" />

      <div style={styles.body}>
        {/* ---- LEFT CHROME ---- */}
        <aside style={styles.chrome}>
          <div style={styles.chromeScroll}>
            {/* composer (opens when a target is selected) */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <p style={styles.eyebrow}>New annotation</p>
              </div>
              {composerOpen ? (
                <div style={styles.composer}>
                  <span style={styles.capturedLabel}>
                    {selected.startsWith("range") ? "Captured range" : "Captured element"}
                  </span>
                  <div style={styles.captured}>{capturedSnippet}</div>
                  <textarea
                    style={styles.textarea}
                    value={draft}
                    placeholder="Say what you mean. The agent gets it."
                    onChange={(e) => setDraft(e.target.value)}
                    onFocus={(e) => (e.target.style.borderColor = "var(--accent-dim)")}
                    onBlur={(e) => (e.target.style.borderColor = "var(--border-inset)")}
                  />
                  <div style={styles.composerActions}>
                    <Button variant="primary" onClick={addToQueue} disabled={!draft.trim()}>
                      Add to queue
                    </Button>
                    <Button variant="ghost" onClick={discardDraft}>
                      Discard
                    </Button>
                  </div>
                </div>
              ) : (
                <p style={styles.hint}>
                  Select an element or a phrase on the surface to begin an annotation.
                </p>
              )}
            </section>

            {/* queued */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <p style={styles.eyebrow}>Queued</p>
                <span style={styles.count}>{queued.length}</span>
              </div>
              {queued.length === 0 ? (
                <p style={styles.hint}>Nothing queued. Added annotations wait here until you send.</p>
              ) : (
                <div style={styles.list}>
                  {queued.map((q) => (
                    <div key={q.id} style={styles.queuedItem}>
                      <span style={styles.queuedSnippet}>{q.snippet}</span>
                      <p style={styles.queuedNote}>{q.note}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* annotations list */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <p style={styles.eyebrow}>Annotations</p>
                <span style={styles.count}>{located.length + orphaned.length}</span>
              </div>
              <div style={styles.list}>
                {located.map((a) => {
                  const isActive = selected === a.id;
                  const isHover = hoverItem === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      style={{
                        ...styles.item,
                        ...(isHover ? styles.itemHover : null),
                        ...(isActive ? styles.itemActive : null),
                      }}
                      onClick={() => setSelected(a.id)}
                      onMouseEnter={() => {
                        setHoverItem(a.id);
                        setFocusedMark(a.id);
                      }}
                      onMouseLeave={() => {
                        setHoverItem(null);
                        setFocusedMark(null);
                      }}
                    >
                      <div style={styles.itemHead}>
                        <Pill variant="located" withDot>
                          located · {a.version}
                        </Pill>
                        <span style={styles.itemSnippet}>{a.snippet}</span>
                      </div>
                      <p style={styles.itemNote}>{a.note}</p>
                    </button>
                  );
                })}
              </div>

              <div style={styles.orphanGroup}>
                <div style={styles.sectionHead}>
                  <p style={styles.eyebrow}>Orphaned</p>
                  <span style={styles.count}>{orphaned.length}</span>
                </div>
                <div style={styles.list}>
                  {orphaned.map((a) => (
                    <div key={a.id} style={styles.item}>
                      <div style={styles.itemHead}>
                        <Pill variant="orphaned">orphaned</Pill>
                        <span style={styles.itemSnippet}>{a.snippet}</span>
                      </div>
                      <p style={styles.itemNote}>{a.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* conversation */}
            <section style={styles.section}>
              <div style={styles.sectionHead}>
                <p style={styles.eyebrow}>Conversation</p>
              </div>
              <div style={styles.conversation}>
                <Bubble variant="agent" author="The agent" time="evt_00018">
                  I drafted a four-step migration plan with a read-only window and a backfill.
                </Bubble>
                <Bubble variant="user" author="You" time="evt_00031">
                  The backfill has to run before the cut-over. I marked the two steps.
                </Bubble>
                <Bubble variant="agent" author="The agent" time="evt_00040">
                  Reordered the steps and moved verification before writes resume. Re-rendered as v2.
                </Bubble>
              </div>
            </section>
          </div>

          {/* footer */}
          <div style={styles.footer}>
            {approved ? (
              <div style={styles.approvedBar}>
                <CheckIcon />
                Review approved. v2 returned to the agent.
              </div>
            ) : null}
            <textarea
              style={{ ...styles.textarea, minHeight: "60px" }}
              value={message}
              placeholder="Message the agent, or send the queued annotations."
              onChange={(e) => setMessage(e.target.value)}
              onFocus={(e) => (e.target.style.borderColor = "var(--accent-dim)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border-inset)")}
            />
            <div style={styles.footerActions}>
              <Button variant="secondary" onClick={sendMessage}>
                Send message
                {queued.length > 0 ? (
                  <Pill variant="located">{queued.length}</Pill>
                ) : null}
              </Button>
              <Button variant="good" onClick={() => setApproved((v) => !v)}>
                {approved ? "Reopen review" : "Approve review"}
              </Button>
            </div>
          </div>
        </aside>

        {/* ---- RIGHT SURFACE ---- */}
        <main style={styles.surfaceWrap}>
          <article style={styles.paper}>
            <p style={styles.artifactMeta}>Artifact · v2</p>
            <h1 style={styles.h1}>Database migration plan</h1>
            <p style={styles.lead}>
              We move the orders table to the new schema without downtime, in a read-only
              window narrow enough that no caller notices.
            </p>

            <ol style={styles.ol}>
              {LIST_ITEMS.map((item) => {
                const markId = `element:${item.id}`;
                const isMarked = item.id === "step-2"; // carries the element annotation
                const on = isMarked && markActive(markId);
                return (
                  <li
                    key={item.id}
                    style={{
                      ...styles.li,
                      ...(isMarked ? elementOutline(on) : null),
                    }}
                    onClick={() => selectElement(item.id)}
                  >
                    {item.text}
                  </li>
                );
              })}
            </ol>

            <p style={styles.para}>
              The cut-over is reversible up to the final step: counts are reconciled{" "}
              <span
                style={{
                  ...styles.range,
                  background: markActive("range:para")
                    ? "var(--annot-fill-strong)"
                    : "var(--annot-fill)",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected("range:para");
                }}
              >
                <span style={styles.rangeMarker}>✎</span>
                {RANGE_TEXT}
              </span>
              , so a mismatch halts the migration before it can do harm.
            </p>

            {/* floating annotation card - the one shadowed surface */}
            <div style={styles.cardLayer}>
              <AnnotationCard
                cursor="evt_00031"
                snippet="Backfill the new columns from the existing rows."
                note="Backfill must run first. Reorder this above the cut-over step."
                who="user"
                version="v2"
                onResolve={() => setSelected(null)}
                onDiscard={() => setSelected(null)}
              />
            </div>
          </article>
        </main>
      </div>
    </div>
  );
}

/* Lucide-style check: stroke 1.5, currentColor, no fill */
function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export default Editor;
