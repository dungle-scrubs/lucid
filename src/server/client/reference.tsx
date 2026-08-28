/**
 * The behaviour reference: every state lucid's surface has, on one page.
 *
 * It exists because a design brief can describe a state and still be wrong
 * about it. This renders the states from the same stylesheets the product
 * uses - `app.css`, and the `STYLE` string `instrument.ts` injects into the
 * artifact frame - so what a designer sees is what the surface does, not a
 * recollection of it.
 *
 * Two rules hold the page honest.
 *
 * **It borrows, never copies.** The in-document states are drawn by the real
 * injected stylesheet, imported. A reference with its own copy of those
 * rules would drift, and a drifted reference shows states the product does
 * not have.
 *
 * **It marks what is broken.** Several combinations here are defects the map
 * found rather than decisions anyone made. They are shown, because a design
 * has to account for them, and they are labelled, because otherwise the
 * design would preserve them.
 *
 * It is not a design. Anything on it that looks good is an accident, and no
 * accident here is a decision.
 */

import type React from "react";
import { createRoot } from "react-dom/client";
import { ELEMENT_ATTR, STYLE } from "./instrument.js";

/** One state: what it is called, what produces it, what it means. */
const Case = ({
  name,
  classes,
  note,
  broken,
  children,
}: {
  name: string;
  classes?: string;
  note: string;
  broken?: boolean;
  children: React.ReactNode;
}): React.ReactElement => (
  <div className={broken === true ? "ref-case broken" : "ref-case"}>
    <div className="ref-case-head">
      <span className="ref-case-name">{name}</span>
      {classes === undefined ? null : <span className="ref-case-classes">{classes}</span>}
    </div>
    <div className="ref-stage">{children}</div>
    <div className="ref-case-note">{note}</div>
  </div>
);

const Section = ({
  title,
  blurb,
  wide,
  children,
}: {
  title: string;
  blurb: string;
  wide?: boolean;
  children: React.ReactNode;
}): React.ReactElement => (
  <section className="ref-section">
    <h2>{title}</h2>
    <p>{blurb}</p>
    <div className={wide === true ? "ref-grid wide" : "ref-grid"}>{children}</div>
  </section>
);

/** A block of document text carrying lucid's marks.
 *
 * `data-lucid-el` is on it because every rule in the injected stylesheet is
 * scoped to that attribute; without it none of them apply and the case would
 * silently render as plain text. */
const Marked = ({ cls, text }: { cls: string; text: string }): React.ReactElement => (
  <div className="ref-doc">
    <p {...{ [ELEMENT_ATTR]: "e1" }} className={cls}>
      {text}
    </p>
  </div>
);

const SAMPLE = "Read the front door before any code.";

const InDocument = (): React.ReactElement => (
  <Section
    title="In the document"
    blurb="Six classes lucid injects into the artifact frame, over HTML it did not write. Every rule below has the same specificity, so when two apply, source order alone decides which one you see. That is not a design decision — it is the order the rules happen to sit in."
  >
    <Case
      name="Nothing"
      note="Annotate mode, nothing under the pointer. The cursor is a crosshair."
    >
      <Marked cls="" text={SAMPLE} />
    </Case>
    <Case name="Hovered" classes=".lucid-hover" note="This is what a click would take.">
      <Marked cls="lucid-hover" text={SAMPLE} />
    </Case>
    <Case
      name="Selected"
      classes=".lucid-selected"
      note="In the note being written. ⌘-click adds more."
    >
      <Marked cls="lucid-selected" text={SAMPLE} />
    </Case>
    <Case
      name="Annotated"
      classes=".lucid-noted"
      note="Something was already said about this, in a note that is still attached."
    >
      <Marked cls="lucid-noted" text={SAMPLE} />
    </Case>
    <Case name="Edited" classes=".lucid-edited" note="Changed by a person and not yet saved.">
      <Marked cls="lucid-edited" text={SAMPLE} />
    </Case>
    <Case
      name="Editable"
      classes="[contenteditable]"
      note="Edit mode. Today every editable block carries this; #170 decided it should appear only on approach, and on touch it stays persistent because approach needs a pointer."
    >
      <div className="ref-doc">
        <p {...{ [ELEMENT_ATTR]: "e1" }} contentEditable suppressContentEditableWarning>
          {SAMPLE}
        </p>
      </div>
    </Case>
    <Case
      name="Text dragged over"
      classes=".lucid-range"
      note="One box per visual line, so a phrase that wraps is several boxes rather than one rectangle. A drag can end mid-word, and the design must show that it did — RFC-08 records a note reading “ALPHA BRA” that cost four list items."
    >
      <div className="ref-doc" style={{ position: "relative" }}>
        <p {...{ [ELEMENT_ATTR]: "e1" }}>
          Read the <span className="lucid-range-inline">front door</span> before any code.
        </p>
      </div>
    </Case>
  </Section>
);

const Combinations = (): React.ReactElement => (
  <Section
    title="Combinations"
    blurb="An element can be in more than one state at once, and this is what happens today. Measured by reading computed styles back, not by reasoning about the cascade."
  >
    <Case
      name="Annotated + hovered"
      classes=".lucid-noted.lucid-hover"
      broken
      note="The hover is invisible. An annotated element gives no feedback when you point at it."
    >
      <Marked cls="lucid-noted lucid-hover" text={SAMPLE} />
    </Case>
    <Case
      name="Annotated + selected"
      classes=".lucid-noted.lucid-selected"
      broken
      note="The selection is invisible. Going back to something you already annotated — the most likely thing to do — gives no sign it worked."
    >
      <Marked cls="lucid-noted lucid-selected" text={SAMPLE} />
    </Case>
    <Case
      name="Edited + selected"
      classes=".lucid-edited.lucid-selected"
      broken
      note="Neither state. A teal outline with an amber wash, because `edited` declares no background so `selected`'s shows through."
    >
      <Marked cls="lucid-edited lucid-selected" text={SAMPLE} />
    </Case>
    <Case
      name="Selected + hovered"
      classes=".lucid-selected.lucid-hover"
      note="Selection wins, which is right: pointing at something already picked should not change it."
    >
      <Marked cls="lucid-selected lucid-hover" text={SAMPLE} />
    </Case>
  </Section>
);

/** The eight heads a note card can carry. */
const NOTE_CARDS: readonly {
  cls: string;
  head: string;
  note: string;
  spot: string;
  meaning: string;
}[] = [
  {
    cls: "pending",
    head: "queued",
    note: "explain this further",
    spot: "on “Read the front door”",
    meaning: "Written, not sent. Still yours to change or discard.",
  },
  {
    cls: "sent",
    head: "sent · v9",
    note: "expand on this",
    spot: "on “bun run lint”",
    meaning: "Sent. Nothing is known about whether it still points anywhere.",
  },
  {
    cls: "sent",
    head: "sent · found again, exactly · v9",
    note: "expand on this",
    spot: "on “bun run lint”",
    meaning: "Certain. The words it pointed at are still there, unchanged.",
  },
  {
    cls: "sent",
    head: "sent · found again, reworded · v9",
    note: "this is still unclear",
    spot: "on “the deterministic suite”",
    meaning: "Changed but matched. The passage was reworded and found anyway.",
  },
  {
    cls: "sent",
    head: "sent · found by position · v9",
    note: "shorten this",
    spot: "on “five files, each answering”",
    meaning: "Matched without the words agreeing. A guess — worth checking.",
  },
  {
    cls: "sent",
    head: "sent · found by path · v9",
    note: "wrong order",
    spot: "on “CONTEXT.md → AGENTS.md”",
    meaning: "Also matched without the words. #172 collapses this and the one above into one band.",
  },
  {
    cls: "orphan",
    head: "lost its target · from v3",
    note: "explain this further",
    spot: "on “Get the one command green”",
    meaning: "The document changed and the spot is gone. Not an error — a fact about history.",
  },
  {
    cls: "orphan",
    head: "written against v9 · not on this one",
    note: "check this against the RFC",
    spot: "on “the append lock”",
    meaning: "It exists, on a version you are not looking at.",
  },
];

const NoteCards = (): React.ReactElement => (
  <Section
    title="Notes, in the conversation"
    blurb="Eight states, not the three usually on screen at once. Six of them are one question — how confident lucid is that the note still points where it did."
  >
    {NOTE_CARDS.map((c) => (
      <Case key={c.head} name={c.head} classes={`.note-card.${c.cls}`} note={c.meaning}>
        <div className={`note-card ${c.cls}`}>
          <span className="note-card-head">{c.head}</span>
          <span className="note-card-note">{c.note}</span>
          <span className="note-card-spot">{c.spot}</span>
        </div>
      </Case>
    ))}
  </Section>
);

const Messages = (): React.ReactElement => (
  <Section
    title="The transcript"
    blurb="Four variants. A refusal is not one of them — it arrives as EventKind.error and renders as an ordinary agent message, which is the defect #176 records."
  >
    <Case name="You" classes=".msg.user" note="What you sent.">
      <div className="msg user">
        <div className="body">
          <p>Expand the AGENTS.md bullet.</p>
        </div>
      </div>
    </Case>
    <Case name="The agent" classes=".msg.agent" note="What the agent said.">
      <div className="msg agent">
        <span className="who">agent</span>
        <div className="body">
          <p>It said what AGENTS.md is for but not what is in it. Expanded that bullet.</p>
        </div>
      </div>
    </Case>
    <Case name="A tool" classes=".msg.tool" note="A tool the agent used.">
      <div className="msg tool">
        <span className="tool-mark" />
        <div className="body">
          <p>Read(AGENTS.md)</p>
        </div>
      </div>
    </Case>
    <Case
      name="Something happened"
      classes=".msg.happened"
      note="lucid recording a fact: a version saved, a note sent."
    >
      <div className="msg happened">
        <div className="body">
          <p>you saved onboarding-checklist v23</p>
        </div>
      </div>
    </Case>
    <Case
      name="A refusal"
      classes=".msg.agent"
      broken
      note="lucid telling the agent no. Identical to the agent speaking, because the client reads Line.event once and compares it only to “tool”."
    >
      <div className="msg agent">
        <span className="who">agent</span>
        <div className="body">
          <p>
            artifact onboarding-checklist refused: E-PATCH-02 patch-anchor-not-found: edit 0 found
            no match for "the front door"
          </p>
        </div>
      </div>
    </Case>
  </Section>
);

const Head = (): React.ReactElement => (
  <Section
    title="The document head"
    blurb="Three controls, and at 390px they total more than the width available — the mode control clips mid-word. #171 decided the save bar replaces all of this while an edit is pending; the ordinary state still has to fit."
    wide
  >
    <Case name="Named, many versions" classes=".doc-head" note="The usual case.">
      <div className="ref-pane">
        <div className="doc-head">
          <button type="button" className="doc-id doc-rename">
            First day checklist
          </button>
          <select className="doc-version-pick" defaultValue="24" aria-label="Version">
            <option value="24">v24 · by the agent · current</option>
            <option value="23">v23 · by you</option>
          </select>
          <span className="modes">
            <button type="button" className="m">
              Use
            </button>
            <button type="button" className="m current">
              Mark up
            </button>
          </span>
        </div>
      </div>
    </Case>
    <Case
      name="Unnamed, one version"
      classes=".doc-version"
      note="No title yet, so the id shows. One version, so the picker is a badge with nothing to open."
    >
      <div className="ref-pane">
        <div className="doc-head">
          <button type="button" className="doc-id doc-rename">
            onboarding-checklist
          </button>
          <span className="doc-version">v1</span>
          <span className="modes">
            <button type="button" className="m current">
              Use
            </button>
            <button type="button" className="m">
              Mark up
            </button>
          </span>
        </div>
      </div>
    </Case>
    <Case
      name="Being renamed"
      classes=".doc-renaming"
      note="Edits in place. The map settled that this should read as directly editable, with an edit icon on hover."
    >
      <div className="ref-pane">
        <div className="doc-head">
          <span className="doc-id doc-renaming">
            <input
              className="doc-rename-input"
              defaultValue="First day checklist"
              aria-label="Name this artifact"
            />
          </span>
        </div>
      </div>
    </Case>
    <Case
      name="Rename refused"
      classes=".doc-rename-problem"
      note="The reason sits beside the field and what was typed is not cleared."
    >
      <div className="ref-pane">
        <div className="doc-head">
          <span className="doc-id doc-renaming">
            <input className="doc-rename-input" defaultValue="" aria-label="Name this artifact" />
            <span className="doc-rename-problem">invalid-title</span>
          </span>
        </div>
      </div>
    </Case>
    <Case
      name="An older version, read only"
      classes=".doc-version-pick.old"
      note="Pinned deliberately. Both modes are unavailable, and this version can be restored."
    >
      <div className="ref-pane">
        <div className="doc-head">
          <button type="button" className="doc-id doc-rename">
            First day checklist
          </button>
          <select className="doc-version-pick old" defaultValue="10" aria-label="Version">
            <option value="10">v10 · by the agent</option>
          </select>
          <button type="button" className="v latest">
            Back to current
          </button>
          <button type="button" className="v restore">
            Restore this version
          </button>
          <span className="modes">
            <button type="button" className="m" disabled>
              Use
            </button>
            <button type="button" className="m current" disabled>
              Mark up
            </button>
          </span>
        </div>
      </div>
    </Case>
    <Case
      name="A newer version arrived"
      classes=".doc-waiting"
      note="With an unsaved edit it offers both ways out. Saving works and lands on top, carrying what it was based on."
    >
      <div className="ref-pane">
        <div className="doc-waiting">
          Version 24 has arrived. <button type="button">save mine first</button>{" "}
          <button type="button">discard mine and show it</button>
        </div>
      </div>
    </Case>
  </Section>
);

const Panel = (): React.ReactElement => (
  <Section
    title="The panel under the document"
    blurb="Guidance, the save control, and the one confirmation the surface has. #171 moves save and discard to the top bar, which leaves this bar holding a sentence and a dialog — whether it survives is a design question."
    wide
  >
    <Case name="Guidance, annotate" classes=".guidance.idle" note="What this mode does.">
      <div className="ref-pane">
        <div className="doc-panel">
          <div className="guidance idle">
            Marking up: click a part of the document to select it, ⌘-click to add more.
          </div>
          <div className="note-actions">
            <button type="button" disabled>
              Saved
            </button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Guidance, unsaved edit"
      classes=".guidance.ready"
      note="Something changed and the save is live."
    >
      <div className="ref-pane">
        <div className="doc-panel">
          <div className="guidance ready">You changed the document. Save to keep it.</div>
          <div className="note-actions">
            <button type="button">Save changes</button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Guidance, overtaken"
      classes=".guidance.ready"
      note="Still saveable. The wording has to say where it will land without reading as an error, because it is not one."
    >
      <div className="ref-pane">
        <div className="doc-panel">
          <div className="guidance ready">
            You changed the document. Save to keep it — it will land on top of the newer version.
          </div>
          <div className="note-actions">
            <button type="button">Save changes</button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Guidance, read only"
      classes=".guidance.warn"
      note="Said before anything else, because it explains why every other affordance is missing."
    >
      <div className="ref-pane">
        <div className="doc-panel">
          <div className="guidance warn">
            Version 10 — read only. Only the current version can be edited or written about.
          </div>
          <div className="note-actions">
            <button type="button" disabled>
              Saved
            </button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Saving"
      classes=".note-actions"
      note="In flight. Four labels across the control's life: Saved, Save changes, Saving…, Saved."
    >
      <div className="ref-pane">
        <div className="doc-panel">
          <div className="guidance ready">You changed the document. Save to keep it.</div>
          <div className="note-actions">
            <button type="button" disabled>
              Saving…
            </button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Restore, confirming"
      classes=".confirm"
      note="The only action that confirms today. It says the undo out loud, because nothing is overwritten."
    >
      <div className="ref-pane">
        <div className="confirm">
          <span>
            Make v10 the current version? It is copied to the end of the list as v25. Nothing is
            deleted, and going back is restoring v24 the same way.
          </span>
          <button type="button" className="primary">
            Restore
          </button>
          <button type="button">Cancel</button>
        </div>
      </div>
    </Case>
    <Case
      name="Discard, confirming"
      classes=".confirm"
      note="Added with the fix for the stranded edit. Abandoning work is the other act that must ask."
    >
      <div className="ref-pane">
        <div className="confirm">
          <span>
            Show v24 and lose the change you have not saved? Saving instead keeps it: it lands on
            top of v24 as the next version, and the agent is told what it was based on.
          </span>
          <button type="button" className="primary">
            Discard and show it
          </button>
          <button type="button">Cancel</button>
        </div>
      </div>
    </Case>
  </Section>
);

const Dock = (): React.ReactElement => (
  <Section
    title="The dock"
    blurb="Fixed at the foot of the conversation, never scrolls away. Five of its six states are progress; only one is a warning, and the thresholds behind it are measured from 47 turns rather than chosen."
    wide
  >
    <Case name="The agent is working" classes=".activity" note="A turn is in flight.">
      <div className="ref-pane">
        <div className="dock">
          <div className="activity">
            <span className="pulse" />
            <span>the agent is working</span>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Working, with a count"
      classes=".activity"
      note="The elapsed count appears past 8 seconds. Below that it is noise, and a dock that counts every wait teaches you to stop reading it."
    >
      <div className="ref-pane">
        <div className="dock">
          <div className="activity">
            <span className="pulse" />
            <span>the agent is working — 38s</span>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Stalled"
      classes=".activity.stalled"
      note="Past 180 seconds for a running turn, or 45 for notes that were never delivered. The only waiting state that is a warning."
    >
      <div className="ref-pane">
        <div className="dock">
          <div className="activity stalled">
            <span className="pulse" />
            <span>the agent is working — nothing back for 4m 12s</span>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Notes queued"
      classes=".queue-bar"
      note="Written and not sent. The count shows out of the maximum only near the bound."
    >
      <div className="ref-pane">
        <div className="dock">
          <div className="queue-bar">
            <span>3 notes queued</span>
            <button type="button" className="primary">
              Send ⌘⏎
            </button>
            <button type="button" className="discard">
              ×
            </button>
          </div>
        </div>
      </div>
    </Case>
    <Case
      name="Queue near its bound"
      classes=".queue-bar"
      note="Twelve is the most one batch can carry. Past it, writing another is refused."
    >
      <div className="ref-pane">
        <div className="dock">
          <div className="queue-bar">
            <span>9 notes queued of 12</span>
            <button type="button" className="primary">
              Send ⌘⏎
            </button>
            <button type="button" className="discard">
              ×
            </button>
          </div>
        </div>
      </div>
    </Case>
    <Case name="The composer" classes=".composer" note="Idle, and disabled once the token is dead.">
      <div className="ref-pane">
        <div className="dock">
          <form className="composer">
            <textarea placeholder="Send to the conversation…" rows={1} />
            <button type="button">Send</button>
          </form>
        </div>
      </div>
    </Case>
  </Section>
);

const Failures = (): React.ReactElement => (
  <Section
    title="Empty, and broken"
    blurb="Nothing here is the person's fault. Two of them are invitations and must not read as errors; the last one stops everything and has exactly one action."
    wide
  >
    <Case
      name="No artifact yet"
      classes=".empty.doc-empty"
      note="An invitation. It names the next action rather than reporting an absence."
    >
      <div className="empty doc-empty">
        <p>It has no artifact yet. Ask the agent for a document.</p>
      </div>
    </Case>
    <Case
      name="No artifact by that name"
      classes=".empty.doc-empty"
      note="The URL named something this conversation does not hold, so it offers the one it does."
    >
      <div className="empty doc-empty">
        <p>This conversation has no artifact called “roadmap”.</p>
        <button type="button" className="primary">
          Open onboarding-checklist
        </button>
      </div>
    </Case>
    <Case
      name="The token is dead"
      classes=".notice"
      note="Everything stops. One action, and it is reload."
    >
      <div className="notice">
        This page's token is no longer valid — the server restarted. Reload.
      </div>
    </Case>
    <Case
      name="The record could not be read"
      classes=".notice"
      note="A damaged record, or a server that answered with something else."
    >
      <div className="notice">Could not read the conversation (500)</div>
    </Case>
  </Section>
);

const Page = (): React.ReactElement => (
  <>
    {/* The real injected stylesheet, not a copy of it. */}
    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: this is lucid's own stylesheet, imported from instrument.ts */}
    <style dangerouslySetInnerHTML={{ __html: STYLE }} />
    <style>
      {
        ".lucid-range-inline{background:rgba(251,191,36,.28);outline:1px solid #b45309;border-radius:2px}"
      }
    </style>
    <header className="ref-head">
      <h1>lucid — behaviour reference</h1>
      <p>
        Every state the browser surface has, on one page, drawn by the same stylesheets the product
        uses. It is not a design. It is what a design has to account for.
      </p>
      <p>
        Cases marked <strong>defect</strong> are things the design map found broken rather than
        decisions anyone made. They are here because a design has to handle them, and labelled so a
        design does not preserve them.
      </p>
    </header>
    <InDocument />
    <Combinations />
    <NoteCards />
    <Messages />
    <Head />
    <Panel />
    <Dock />
    <Failures />
    <footer className="ref-foot">
      <p>
        Two states cannot be shown on a static page and are described instead: the one-time pulse
        when new material arrives inside the reader's viewport, which runs 2.6s ease-in-out and
        peaks at a 20% wash; and the crosshair cursor that annotate mode puts over everything.
      </p>
    </footer>
  </>
);

const root = document.getElementById("ref-root");
if (root !== null) createRoot(root).render(<Page />);
