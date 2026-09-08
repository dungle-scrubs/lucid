# Review: RFC-17 Conversation panel visibility, revision 1

## Evidence scale used below

Each finding names how far its evidence got, on the scale in `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`:

- **E1 asserted.** Stated, not backed.
- **E2 pointed at the code.** A real `file:line`.
- **E3 traced.** Execution or branch order followed through the code.
- **E4 ran it.** A script or test that calls the real code.
- **E5 saw it in the running system.**

## What was reviewed

- **RFC:** `docs/rfc/17_conversation-panel-visibility.rfc.md`
- **Revision:** 1 (frontmatter `revision: 1`, `date: 2026-09-08`)
- **Status:** Draft, type `feature`
- **Read alongside:** `.scratch/conversation-panel-visibility/spec.md`, `.scratch/conversation-panel-visibility/issues/01-conversation-panel-visibility.md`, `src/cli/mapping.ts`, `src/cli/dispatch.ts`, `src/cli/serve.ts`, `src/cli/record-addressing.ts`, `src/store/errors.ts`, `src/server/server.ts`, `src/server/client/app.tsx`, `app.css`, `route.ts`, `layout.ts`, `content-comparison.css`, `docs/design.md`, `docs/adr/`, `test/server/`, `test/cli/`.
- **Scope honored:** read-only. No files written, no agents spawned. No secrets, environment files, or conversation records read. The user's selection of implementation and the approved CLI spelling and test seams were not reopened. F-02 names a concrete blocker inside the approved seam; it does not propose a different seam.

**Graph coverage qualification:** the `codebase-memory-mcp` server failed to connect this session (`CONNECTION_CLOSED`), so `check_index_coverage`, `search_graph`, and `trace_path` were unavailable. Every code claim below rests on direct file reads and ripgrep, with no index-coverage confirmation. Symbols reachable only through dynamic dispatch or generated code could have been missed.

**Working-tree qualification:** `app.tsx`, `app.css`, `layout.ts`, `route.ts`, `server.ts` and others are modified and uncommitted (comparison and artifact-width work in flight). All line numbers are against the working tree, which is what an implementer will edit. The baseline can shift when that work lands.

## Structural results

Supplied by the parent, which ran the draft-rfc structure validator before dispatch. Output from `artifacts/evidence/conversation-panel-visibility/rfc-validation.json`, verbatim:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

I did not re-run it and did not re-derive any check it covers.

## Findings

### F-01. Collapsing does not release space in the stacked layout (Medium, E3)

**Lands in:** Design, "Layout, focus, and motion" (line 57); State Machine.

Line 57 requires collapse to "remove its layout allocation and divider, and let the document use the released space", and says "the same rightward motion applies to the stacked layout". In the stacked layout the document pane is not elastic. `app.css:269-272` sets `.pane.document { flex: 0 0 var(--document-height, 33.333%) }` at `max-width: 900px`, fed by an inline custom property at `app.tsx:3757` from `documentShare` (`app.tsx:2280`, default `1/3`). Removing the conversation pane's allocation leaves about two thirds of the window empty instead of giving it to the document. The RFC never says the document's height share is overridden while collapsed. Line 53 ("Reopening SHOULD restore the current view's prior pane sizes") implies the share must be preserved while overridden, which is a second unstated requirement.

Related gap: the State Machine has no row for crossing the 900px breakpoint while collapsed. That transition is real and already tracked (`app.tsx:2376-2383` resets `stacked` on resize), and it swaps between two geometries the RFC specifies differently.

**Why it matters:** 390px is one of the three widths the plan requires verifying (line 106). Implemented literally, that check fails.

### F-02. Test seam 3 has no rendering entry point today (Medium, E3)

**Lands in:** Implementation Plan, item 3 (line 102).

Seam 3 is "the rendered reading view: native keyboard and pointer controls, accessibility state, pane geometry, reduced motion, and retention of composer/annotation/edit state". Three obstacles, none named in the plan:

- `App` is not exported. `app.tsx:1984` declares `const App = ...` with no `export`.
- Importing the module mounts the app as a side effect. `app.tsx:4566-4567` runs `createRoot(root).render(<App />)` at module scope.
- The rendering tests in this repo use JSDOM (`test/server/comparison-view.test.tsx:2`), which supplies no layout engine and no `matchMedia`. `app.tsx:2278` calls `window.matchMedia` during initial state, so rendering `App` needs a stub, and pane geometry cannot be asserted there at all. A grep of `test/` for `matchMedia`, `getBoundingClientRect`, or an import of `app.js` returns nothing but one unrelated string assertion (`test/server/instrument.test.ts:419`), so no precedent exists.

There is also an internal ambiguity. Line 102 lists pane geometry and reduced motion as deterministic seam-3 coverage, while lines 104-106 assign layout and motion to browser checks. The RFC should say which seam-3 items are deterministic, and what extraction makes them so: an exported panel or header component, or an exported `App`. This is the missing prerequisite inside the approved seam, not a challenge to it.

### F-03. Toggle placement spans five divergent headers, and one required state has no header that can carry it (Medium, E3)

**Lands in:** Design, "Browser controls and state" (line 49); Error Handling (line 80).

Line 49 requires the toggle in "loaded, empty, missing-artifact, unsaved, historical, comparison, and connection-error" states. The code has no shared header component. Five separate `doc-head` renderings exist: missing artifact (`app.tsx:3770`), empty (`app.tsx:3837`), dead or damaged (`app.tsx:3883`), unsaved (`app.tsx:3904`), and loaded, which also serves historical and comparison (`app.tsx:3935`). The first two carry no control slot at all.

The branch order at `app.tsx:3765`, `3832`, `3874` checks `doc === null` before `dead`. `dead` is independent of `doc` (`app.tsx:2044`, set from a 401 at `app.tsx:2508` and `3427`). So a record with no artifact plus an expired token renders the "No document" header, which has neither the Reload button nor any control. Line 80 requires that "invalid server tokens MUST retain the visible toggle". In that combination there is no header to attach it to.

**Why it matters:** the requirement reads as one rule and is five edits, one of which needs a branch that does not exist. A header-per-branch structure drops exactly this state.

### F-04. The required clipped container collides with the drag code's DOM sibling assumptions (Medium, E3)

**Lands in:** Design, "Layout, focus, and motion" (line 58).

Line 58 requires "A clipped layout container MUST prevent the moving panel from creating horizontal page overflow" and does not say where that container sits. The resize code navigates the DOM by position: `app.tsx:2291` reads `grip.previousElementSibling` for the document height, `app.tsx:2301` reads `grip.nextElementSibling` for the conversation width, `app.tsx:2292` and `2354` read `grip.parentElement` as `.panes`, and `app.tsx:2368` repeats the sibling read for the keyboard nudge. A wrapper around the conversation pane changes what `nextElementSibling` returns. A wrapper around `.panes` changes `parentElement`. There is no deterministic test over pointer drag geometry, so this breaks silently.

Second-order risk on the same requirement (E2, not traced to a rendered case): `overflow: hidden` on `.panes` would clip absolutely positioned children that currently escape their pane, in particular `.driver-menu` (`app.css:2437-2440`, `position: absolute; bottom: calc(100% + 6px)`), which opens upward from the composer inside the conversation pane. The dialogs are safe; they render outside `.panes` (`app.tsx:4473`, `4480`).

### F-05. Comparison reflow during the collapse is unspecified (Medium, E3)

**Lands in:** Design, "Browser controls and state" (line 49) and "Layout, focus, and motion" (line 57).

The RFC requires the toggle in the comparison state and requires the document to take the released space. It says nothing about what that does to the comparison view. The comparison lays out by container query: `content-comparison.css:5` declares `container: content-comparison / inline-size`, and `:153` and `:243` switch to two columns at `min-width: 820px`. `docs/design.md:106-107` states the contract: "The same rows use two columns at 820px of available comparison width and one column below it. Conversation width is excluded." Collapsing the panel widens the document pane, so a collapse can flip the comparison from one column to two, and an animated width re-evaluates the container query repeatedly across the 180ms.

The RFC should state whether the comparison reflow is acceptable during the transition, whether the note editor's position and its draft survive it (line 51 lists note drafts as preserved, but not their position), and whether the width should animate at all while a comparison is open. `.pane.document` is itself a container (`app.css:192`), so the header also reflows.

### F-06. New views generated from inside the app are an unnamed initialization case (Low, E3)

**Lands in:** Design, "CLI and view URL" (line 45); State Machine, last row.

Line 45 covers reload and "another independently loaded view", and requires later path replacements to preserve the query string. Two call sites format routes today: `app.tsx:2341` (`window.history.replaceState(null, "", formatRoute(next))`) and `app.tsx:443-449`, an `Inspect saved v{n}` anchor with `target="_blank"`. `formatRoute` emits a path only (`route.ts:62-67`), so the anchor opens a new view with no parameter, which under line 43 initializes closed even when the current view is open. That is defensible and probably intended. The RFC names only reload and independent loads, so the reader cannot tell whether the anchor was considered.

`sameRoute` (`route.ts:71-74`) compares path fields only, so preserving the query cannot be done by widening `formatRoute`'s output without also changing that comparison. The RFC should say the preservation is caller-side, with `replaceState` composing the path plus `window.location.search` and `formatRoute` staying path-only, or say the opposite.

### F-07. Ordering of the layout release against the 180ms motion is not stated (Low, E2)

**Lands in:** Design, "Layout, focus, and motion" (lines 57, 59, 61).

Line 57 requires removing the layout allocation. Line 59 gives the animation about 180ms. Line 61 forbids requiring a timer or `transitionend` "to restore usability". Two implementations satisfy every sentence and look different. Release the allocation at the start, and the document snaps to full width while the panel is still sliding. Release it at the end, and the visual result needs a `transitionend` even though usability does not depend on one. The plan requires inspecting a captured intermediate state (line 106), which is where the two diverge, so a verifier has no stated expectation to check against.

### F-08. An invalid conversation argument is an omitted CLI state (Low, E2)

**Lands in:** Design, "CLI and view URL" (line 41); Error Handling (line 78).

Line 41 enumerates what the parser rejects: missing, invalid, repeated, or unknown options, and extra positionals. Nothing covers the conversation argument itself. The repository has a rule for it: `validConversationId` (`src/store/errors.ts:67-68`, re-exported at `src/cli/record-addressing.ts:214`) allows letters, digits, dot, underscore, space and dash up to 128 characters, and excludes `.` and `..`. As written, `lucid2 serve ..` percent-encodes and prints a link to a record that cannot exist. The security requirement at line 84 ("MUST remain a URL path operation and MUST NOT resolve a filesystem path") holds either way, so this is a completeness gap, not a safety one. State whether the argument is validated against `validConversationId` before printing, or deliberately passed through.

### F-09. "Existing `serve` usage remains valid" is true only for the zero-argument form (Low, E2)

**Lands in:** Design, "CLI and view URL" (line 41).

`src/cli/mapping.ts:102-103` is `case "serve": return { kind: "serve" };`, which discards every following token. `lucid2 serve foo --bar` starts a server today and must error after this RFC. The sentence should say the documented no-argument invocation keeps working, and that arguments previously ignored now fail.

### F-10. Documentation examples required by the ticket are not carried into the RFC (Low, E2)

**Lands in:** Design line 41; Implementation Plan line 108.

The ticket's acceptance criterion (`issues/01-conversation-panel-visibility.md:15`) says "Help and user documentation describe the option, its default, and examples for both states." The RFC requires only that "Help MUST describe the default and both values" (line 41). Line 108 says to extract the contract into the README and reading-view docs, without naming the examples. `README.md:20-21` is the current example link and is where those examples land.

### F-11. Unused terminology (Low, E2)

**Lands in:** Terminology (line 27).

"Document mode" is defined by reference to `CONTEXT.md` and never used again in the document. "Record", "artifact", and "driver" all recur. This one does not.

### F-12. Transcript scroll position after reopening is unspecified (Low, E1)

**Lands in:** Design, "Browser controls and state" (line 51).

Line 51 requires that new transcript messages not reset visibility, and that opening "MUST restore access to the same transcript and composer". It does not say where the transcript is scrolled after messages arrive while the panel is hidden. Whether assistant-ui's autoscroll runs while the panel is translated off-screen with its box intact depends on the library's viewport observation, which I did not trace. E1: this is an unanswered question, not a demonstrated defect.

## Cleared

Checked and found sound. A later reviewer need not repeat these.

- **No record is created by `serve`.** `dispatch.ts:147-153` builds a `Conversations` binding, and `record-addressing.ts:187-207` shows the factory is pure: only `.ensure()` creates, and the serve branch (`dispatch.ts:159-167`) never calls it. Line 37's MUST NOT is already true and stays true when a conversation argument is added (E3).
- **The query parameter reaches the client intact.** The page routes match pathname only (`server.ts:180-182`), and the trailing-slash redirect re-appends the query: `server.ts:223-227` sets `location` to `path.replace(/\/+$/, "") + url.search` (E3).
- **No collision with an existing query parameter.** A grep of `src/` for `URLSearchParams`, `location.search`, and `searchParams` returns nothing. The session token is fetched from `/api/session` (`server.ts:207`) and never appears in a URL, so line 84's claim that the parameter cannot touch tokens holds (E3).
- **Persisted width is independent.** `convWidth` is written only from the drag paths (`app.tsx:2371` and the pointer `done` handler) through `writeConversationWidth` (`layout.ts:41-50`). `documentShare` is unpersisted React state (`app.tsx:2280`). A CSS-only hide of a mounted subtree writes neither, so line 53's "hiding MUST NOT overwrite it" needs no extra machinery (E3).
- **Re-clamping on reopen is already handled.** `layout.ts:20-25` clamps against window width, and `app.tsx:2376-2383` re-clamps on resize. Line 53's "clamped to available space by the existing layout rules" is satisfied by existing code even if the window changes while collapsed (E3).
- **Percent-encoding is warranted.** `validConversationId` permits spaces and dots (`src/store/errors.ts:68`), and `formatRoute` already encodes (`route.ts:63`). Line 43's requirement is correct (E3).
- **Reduced motion has precedent.** `app.css:1961` and `instrument.ts:410,445` already carry `prefers-reduced-motion: reduce` blocks, so line 61 fits the existing pattern (E2).
- **Seams 1 and 2 are feasible as stated.** `mapSubcommand` is pure (`mapping.ts:34`), and `dispatch` takes injectable seams including `serveFn` (`dispatch.ts:66`). `layout.ts` plus `test/server/layout.test.ts` is the precedent for a browser-only pure module (E3).
- **References resolve.** All five normative links and both informative links point at existing files: `docs/adr/0007-document-edits-preserve-evidence.md`, `docs/adr/0008-browser-and-agent-content-have-separate-authority.md`, `CONTEXT.md`, `docs/design.md`, `src/cli/serve.ts`, and the two `.scratch` documents (E2).
- **Fidelity to the approved ticket.** Every acceptance criterion in `issues/01-conversation-panel-visibility.md` has a normative counterpart except the documentation examples (F-10). The ticket's "both controls work with a keyboard" is met by the RFC's single named toggle whose accessible name changes (line 49); nothing in the ticket requires two distinct controls (E2).
- **No ADR conflict.** ADR 0007 governs edits and version evidence. ADR 0008 governs browser and agent content authority. A view-only presentation flag touches neither bytes nor versions, and line 84 states the non-interference explicitly (E2).
- **Normative statements agree on initialization.** Line 43's URL rules and the State Machine's first two rows agree on missing, closed, invalid, and duplicate values. Lines 39 and 45 agree that toggles never rewrite the initializer. Reload restoring the CLI choice is surprising but explicitly stated, not contradictory (E2).
- **The 900px breakpoint is documented.** `docs/design.md:91-95` matches `app.css:264` and `app.tsx:2278`, so the RFC's stacked-layout language rests on a real contract (E3).

## Not reviewed

- **No browser was run.** Every layout, motion, focus, and overflow claim is a static read of `app.css` and `app.tsx`. Nothing above reaches E4 or E5.
- **assistant-ui internals.** The `Thread` component (`app.tsx:4443`) and its viewport, autoscroll, and composer behavior while its container is translated off-screen were not traced. F-12 rests on that gap.
- **Artifact iframe identity.** Line 51 requires visibility changes not to change iframe identity. I did not verify how the iframe is keyed or remounted in `app.tsx` and `instrument.ts`, so that requirement is unverified against the code.
- **`hotkeys.ts`, `driver-menus.ts`, `anchor.ts`, `instrument.ts`, and the reference view.** Not read, except for the two greps cited above. If a global key handler should own the toggle, this review did not check for it.
- **The `lucid-design` skill's artifact guidance.** Not consulted; nothing in this RFC authors artifact content.
- **The uncommitted comparison and artifact-width work.** Read as it currently stands, not reviewed for correctness, and not diffed against `HEAD`. F-05 identifies where the two efforts touch; the interaction was not exercised.
- **Graph-based structural discovery.** Unavailable this session, per the qualification above. Callers reachable only through indirection may have been missed, in particular other `formatRoute` consumers outside `src/server/client/`.
