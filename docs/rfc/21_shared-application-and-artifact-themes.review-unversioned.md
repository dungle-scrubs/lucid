# Review: RFC-21, Shared application and artifact themes (final, cross-family)

## What was reviewed

| Field | Value |
|---|---|
| RFC | `docs/rfc/21_shared-application-and-artifact-themes.rfc.md` |
| Version | **unversioned**. Frontmatter has `number`, `title`, `type`, `status`, `author`, `date`, and no draft version field. |
| Status | `Draft` |
| Hash | SHA-256 `8542e6499a1f3171343ec91604eced4ac70a5826a2710be0bb680d4f945ba76e`, verified by the parent. This session has no shell and did not recompute it. |
| Role | Final independent cross-family reviewer. The RFC was authored by an OpenAI-family model; this review is by `opus-5@claude` (Claude Opus 5). Read only. No file was edited. |
| New evidence | `artifacts/evidence/rfc21-review/{probe.mjs,probe-evidence.md,browser-probe.json}`. **Produced by the primary OpenAI session, not by me.** I read the script and the JSON and judged whether the results support the claims. |
| Tools I used | `Read`, `Grep`, `Glob`, `WebFetch`. I made no codebase-memory graph queries. Coverage notes reached me only as automatic hook output on those calls. The parent's `coverage.json` records a partial parse of `content-comparison.css` lines 153 and 243; the parent read both directly. |

Working-tree evidence: sources were read from the current working tree, which contains concurrent uncommitted work. Source line numbers can move; the quoted rules and RFC hash identify what was reviewed.

## Structural results

Verbatim from `artifacts/evidence/rfc21-review/structure.json`:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

Evidence rungs below: 2 pointed at code, 3 traced, 4 executed result supplied.

---

## Findings

### F1 - Script-rendered graphics need a serialization constraint

**Priority: High.** The authoring paragraph permits a scripted palette change that the global snapshot invariant forbids. The serializer behavior is reproduced.

RFC lines 186-189 permit script-rendered graphics: "An adaptive artifact using script-rendered graphics MUST read the same media query and react to changes without resetting user input or interaction state."

RFC lines 243-245 forbid the result: "A theme-only change MUST NOT mark the artifact dirty or change the normalized snapshot. Explicitly authored metadata and both palettes remain in saved/exported documents; the reader's current override does not."

The parent's probe embeds an artifact doing exactly what 186-189 allows: an SVG circle whose script reads `matchMedia('(prefers-color-scheme: dark)')` and sets a `fill` attribute (`probe.mjs:26-30`). Switching the embedding frame from light to dark changes the serialized snapshot bytes. `browser-probe.json` records `graphicsSnapshotChanged: true`, `graphicLightFill` `fill="#111111"`, `graphicDarkFill` `fill="#eeeeee"`.

This is expected from the serializer: `clean()` clones the live `document.documentElement` (`src/server/client/instrument.ts:652`), so a script-set attribute is captured.

**Consequence.** A document following the script-graphics paragraph can carry the reader's current appearance into a saved version, which line 244-245 states must not happen. The reader has no signal that saving produced different bytes because of a theme toggle.

**Resolution.** Add a serialization-safe restriction to the authoring contract: drive SVG and chart palettes through CSS media rules rather than scripted attribute or inline-style writes, or specify how canonical authored graphic values are restored during a snapshot. Then narrow 243-245 to match.

**Evidence: rung 4**, from the parent's Chrome 152.0.7977.77 run using the real `instrumentArtifact`. **Bounded:** this proves one permitted shape violates the invariant. It does not prove every adaptive artifact does, and it did not run inside Lucid. Whether the artifact is also marked *dirty* depends on Lucid's edit tracking and is unproven.

### F2 - Applying the RFC's prescribed value changes the inspection frame, and the RFC calls it preservation

**Priority: Medium.** This is an undisclosed change to existing behavior.

RFC lines 208-211 require "the existing `light dark` behavior for unmanaged documents. This applies to the reading frame and full-document comparison inspection frames."

Only the reading frame has that value, from `.doc-frame` in `src/server/client/app.css:815-818`. The comparison inspection frame carries no class (`src/server/client/content-comparison.tsx:388-398`); `.comparison-inspection iframe` sets no `color-scheme` (`content-comparison.css:147-152`), so it inherits `light` from `:root` (`app.css:54-55`).

The probe reproduces both states under an emulated dark system with the application root at `color-scheme: light`: `currentInspection` reports `dark: false`, background `rgb(255, 255, 255)`; `proposedUnmanagedInspection`, after setting `light dark` on the frame, reports `dark: true`, background `rgb(17, 17, 17)`.

**Consequence.** Following line 210 uniformly gives one consistent post-implementation outcome, which is fine, but it moves unmanaged documents in the inspection frame from application-following to OS-following. The RFC presents this as retaining existing behavior, so a reader and an implementer are not told a change is happening, and no evidence row covers it.

**Resolution.** State the unmanaged rule as a value rather than as existing behavior, and add one clause recording that this changes the comparison inspection frame. Add the case to the browser evidence list at lines 358-360.

**Evidence: rung 4** for both observed states, from the parent's probe; **rung 2** for the current CSS.

### F3 - The normative spec citation points at the wrong section

**Priority: Low.** Documentation defect in a normative reference.

RFC lines 214-217 attribute the propagation claim to `https://drafts.csswg.org/css-color-adjust-1/#color-scheme-prop`, repeated at line 409. I fetched the current CSSWG Editor's Draft during this review. That anchor is § 2.2, the property definition. The embedded-document propagation rule is in § 2.1, anchor `#color-scheme-page`. The `light dark` outcome depends on § 2.3, `#color-scheme-resolution`.

**Consequence.** A reviewer following the normative link cannot verify the central mechanism claim.

**Resolution.** Cite `#color-scheme-page`, and add `#color-scheme-resolution`.

**Evidence: rung 2**, verified against the fetched draft. MDN was unreachable in this session, so the RFC's two MDN URLs remain unverified as resolving.

---

## Non-blocking notes

Useful to the implementer. None blocks acceptance.

1. `src/server/client/settings.css` uses cross-vocabulary fallbacks such as `var(--foreground, var(--color-text))` at lines 8, 29, 40, 56, 58, 90, 96, 100, 133, 135, 136, and is loaded by both shells. Whichever vocabulary gains dark values, check that Settings resolves to one source in both appearances.
2. `docs/artifacts.md:278-288` and `src/server/client/artifact-width.ts:20-37` already implement a non-mounting parse5 meta parser with the same first-match and invalid-value rules, tested at `test/server/artifact-width.test.ts:38-52`. Reuse rather than write a second parser.
3. The reading view renders five `.doc-head` branches, at `app.tsx:3643, 3711, 3738, 3759, 3791`. Two invert colours: `.doc-head.saving-bar` (`app.css:613-619`) and `.doc-head.dead` (`app.css:666-671`). Lines 148-150 and the Save/Discard evidence row already require legibility here; this is the concrete list.
4. `docs/design.md:154-155`, `:160`, `:162-163`, and the `app.css:36-52` header comment are the design-contract statements that step 4 (line 348) will need to revise. That comment also carries the "same names, same values" invariant between `app.css :root` and `instrument.ts` `FRAME_TOKENS`.
5. The repo's storage modules take the platform object as a parameter (`layout.ts:30-46`, `input-recovery.ts:38-39`, `artifact-width.ts:65-91`). Nothing in lines 90-92 forbids that, and it is what makes the required blocked-storage and system-change tests writable on jsdom.
6. `reference.tsx:29` and `:937-938` inject `instrument.ts`'s `STYLE` into the parent document. It is a build output (`scripts/build-reference.ts`), not a served surface, but adding a media query to `STYLE` will make its in-document samples follow the OS while its application samples follow the application.

---

## Cleared (bounded)

- **Native propagation works.** Setting `color-scheme` on the embedding element flips `prefers-color-scheme` inside a `sandbox="allow-scripts"` `srcDoc` frame with no `allow-same-origin`. `adaptiveDark.dark: true`, `adaptiveLight.dark: false`. Rung 4, Chrome 152 only, parent's probe.
- **Switching preserves frame and document identity, and input values.** `sameWindow`, `sameInstance`, `sameInput` all true. The reading frame's key `` `${doc.artifactId}@${doc.version}` `` (`app.tsx:1682`) does not depend on the theme. Rung 4 plus rung 2.
- **Snapshot invariance, for CSS-only documents only.** `sameSnapshot: true` for the CSS-driven fixture. Rung 4. This does **not** extend to script-rendered graphics; see F1.
- **Factual claims about current code are accurate**: the light-only reading view (`app.css:51`, `:54-55`), dark tokens present in `hub.css:22-31` and `content-comparison.css:164-174`, `instrumentArtifact` used by both frames (`app.tsx:1686`, `content-comparison.tsx:397`), cleanup of `[data-lucid]` (`instrument.ts:651-654`), and the Settings entry sitting in the composer with none on the hub (`app.tsx:1211`, `hub.tsx:137-154`). Rung 2. I found no runtime toggle that adds a `dark` class in `src/`; I make no claim about whether those token sets have ever been rendered in tests, the reference, or by hand.
- **Internal consistency**: storage failure against cross-tab convergence (lines 106, 280, 292-293), storage clear (lines 94-95, 108-109), the Settings MUST against Open Question 1 (lines 134-137, 391-393), all nine state-machine rows, terminology use, and ADR 0007, 0008, 0009 alignment. No dangling reference; the RFC adds no message, endpoint, or record field.

## Not reviewed

Whether the feature should be built. The RFC hash (no shell). `bun run check`, `bun run build`, and the test suite (no shell). Full reads of `app.tsx`, `hub.tsx`, and `content-comparison.tsx` beyond the cited regions. Tests other than `artifact-width.test.ts`. The body of `skills/lucid/SKILL.md`. Adversarial security analysis. Contrast ratios, screen-reader behaviour of the toggle's changing name, and forced-colors rendering. Initial paint across the three shells, which no evidence yet covers.


## Review provenance

The independent reviewer accepted the supplied probe evidence and corrected the
findings in a follow-up. The final disposition withdraws the separate unmanaged
controls objection: the RFC already selects the frame media query, which follows
the OS for unmanaged frames. An unmanaged light-background document under a dark
OS remains a useful test case; no visual failure is established.

The authoring-gap wording in F1 incorporates the same reviewer's correction.
The primary session assembled this document from that review and disposition,
verified the RFC hash, and ran the browser probe. No RFC or product code was edited.

- [Executable probe](../../artifacts/evidence/rfc21-review/probe.mjs)
- [Probe results](../../artifacts/evidence/rfc21-review/browser-probe.json)
- [Independent final report](../../artifacts/evidence/rfc21-review/final-report.json)
- [Reviewer disposition](../../artifacts/evidence/rfc21-review/disposition.json)
