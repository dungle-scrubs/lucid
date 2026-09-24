---
number: 33
title: "Publish-time theme declaration guard"
type: feature
status: Draft
author: "pi"
date: 2026-09-24
---

# RFC-33: Publish-time theme declaration guard

## Abstract

An HTML artifact published without a `lucid-theme` declaration renders as
unmanaged: the embedding frame follows the system preference while the
document's fixed colors stay fixed, so a light-authored document docks dark
chrome around stuck-light content. `publishArtifact` validates identity,
bytes, and URLs but never inspects theme declaration, so the failure reaches
the reader before any human sees it. This RFC requires the publish path to
refuse unmanaged documents unless the request carries an explicit unmanaged
marker, and names the fix in the refusal.

## Introduction

The observed failure: an HTML artifact authored with hardcoded light colors
and no `lucid-theme` meta published fine through `lucid artifact publish`,
then docked mixed with Lucid in dark mode. Per the appearance contract in
`docs/artifacts.md`, an undeclared document is unmanaged, so the frame
follows the app/system preference while fixed authored colors stay fixed.
Lucid rendered exactly what was published; the author shipped an unmanaged
document by mistake.

Authoring discipline alone will not hold. The `lucid-design` skill already
mandates adaptive-by-default on the authoring side, but a headless pipeline
that skips the skill, or a human error inside one that loads it, passes the
publish boundary today with no signal. The failure surfaces at read time, in
front of the reader, after the document is durable. This RFC puts the
backstop at the boundary: the publish path refuses what it cannot prove
managed, unless the caller opts out loudly.

Scope: `publishArtifact` in `src/cli/artifact-publish.ts` and the handoff
path that writes artifacts through `runHandoff`. Both create version 1 of a
document from supplied bytes; both MUST apply the same guard. Out of scope:
agent emissions through the fenced `lucid-artifact` block (the live turn
path already teaches emission; refusal there would drop agent output
mid-turn), human saves (a person looking at their own document needs no
guard), revisions to an already-held artifact (the policy belongs to the
version being viewed, and a revision inherits its author's intent), and
any check beyond declaration presence (this RFC never infers styling
correctness from colors or styles).

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

- **Managed document**: artifact bytes whose head carries a first matching
  `lucid-theme` meta with content `adaptive`, `light`, or `dark`, parsed by
  the same rules the reader uses (first match wins, ASCII whitespace
  trimmed, lowercase only, head only, inert parse).
- **Unmanaged document**: artifact bytes that are not a managed document.
- **Unmanaged marker**: an explicit request-level opt-out declaring that
  the caller intends an unmanaged document.
- **Publish path**: `publishArtifact` and `runHandoff`, the two CLI-driven
  creators of artifact version 1 from supplied bytes.

## Motivation

The appearance contract already documents the unmanaged row; the reader
behaves correctly per that contract. The missing piece is a refusal at the
only point where the mistake is still cheap: before the bytes are stored.
A refusal names the fix while the authoring session is still open and can
act. A warning alone would scroll past in a headless pipeline; a refusal
with an explicit escape preserves the legitimate unmanaged case (a document
that genuinely wants system-following chrome) without letting accidents
through silently.

## Design

The publish path MUST determine managed or unmanaged from the artifact
bytes before storing version 1, using the same inert head-meta parse the
reader uses. The canonical parser lives beside the reader's copy and shares
its test vectors; the two MUST NOT drift. Where the code can share one
module it SHOULD; where the browser bundle boundary forbids it, a second
implementation with the shared vectors is REQUIRED.

An unmanaged document MUST be refused unless the publication request
carries the unmanaged marker. The marker is the top-level request field
`"theme": "unmanaged"` alongside `artifact` in the request JSON.
`--allow-unmanaged` on both commands sets the same marker for terminal
use. The marker MUST apply to exactly one publication request; it MUST NOT
be stored on the record, inherited by revisions, or remembered as a default.

Marker validation precedes the guard: an absent field means no marker; a
field present with any value other than the exact string `"unmanaged"`
(`null`, booleans, arrays, objects, other strings) is refused as a malformed
request before the guard runs. The flag supplies the marker only when the
field is absent; it MUST NOT conceal an invalid field value. Marker
validation applies even to exempt revisions (a malformed field is still
malformed), though a valid marker on an exempt revision is accepted and
ignored.

The refusal MUST name the fix: add `<meta name="lucid-theme" content="adaptive">`
with matching `color-scheme` metadata (`light` and `dark` are the fixed-theme
alternatives), or resubmit with the explicit unmanaged marker.
It MUST carry code `E-HUB-09` so headless callers can match on it without
parsing prose.

The CLI MUST serialize the refusal for machine callers. Today `main.ts`
prints only the error message on stderr with exit 1, and the `--json`
branches serialize success results only. With `--json`, a refused publish
or handoff MUST print `{"code":"E-HUB-09","message":...}` on stderr
and exit 1; without `--json` the message alone on stderr with exit 1 is
sufficient. CLI-level tests MUST cover both commands in both modes.

`runHandoff` writes the same version-1 artifact from the same kind of
supplied bytes and MUST enforce the same rule with the same marker shape
in the handoff request. The handoff retry-equality rule (same creation ID
MUST be byte-identical) is unchanged; a refused handoff stores nothing, so
a corrected retry with identical bytes plus the marker, or with fixed bytes,
proceeds as a fresh creation.

Revisions to an already-held artifact are exempt: when the artifact ID
is already held on the record, the publish proceeds without the guard.
The guard applies at creation, where the policy for the new document is
chosen, not at every later version. Admission is defined by whether the
artifact already exists, independent of the addressing field
(`creationId` versus `conversationId`) and the numeric version: a first
publication into an existing empty conversation, or with a supplied
version greater than 1, is still a creation and the guard applies.
A theme refusal forbids exactly the artifact write; it MUST NOT forbid
the native-publication bookkeeping that precedes it, and the guard MUST
run before that bookkeeping so the no-side-effect guarantee holds.

Retry precedence: an identical retry of a pre-guard unmanaged publication
is refused the same way (the bytes are still unmanaged and no marker is
present); a partial handoff retry where the artifact exists but the
continuation is incomplete follows the artifact-exists rule (exempt) and
continues the continuation. When a retry carries both conflicting bytes
and an unmanaged declaration, the existing byte-conflict refusal wins
(the caller MUST reconcile bytes first); the theme refusal applies once
bytes agree.

The guard MUST run before the record is created and before any bytes are
stored, so a refusal leaves no record shell, no receipt, and no version.
Existing validation order (identity, then bytes, then this declaration
check) places the theme check with the other bytes checks. The existing
`ARTIFACT_BYTES_MAX` bound MUST be enforced before theme parsing in both
paths (handoff already checks it in its request parser; publication MUST
check it before `createWithReceipt`), so an oversized input is refused
without parsing or durable writes. An oversized-input test MUST verify
that neither parsing nor writes occur.

## State Machine

No new states. The guard is a pre-store admission check with two outcomes:

```
managed bytes → store (unchanged path)
unmanaged bytes + marker → store (unchanged path, marker consumed)
unmanaged bytes, no marker → refuse, nothing stored
```

## Error Handling

- New refusal code `E-HUB-09` (verified free at draft time: no occurrence
  under `src`, `docs`, or `test`; recheck at implementation). Severity:
  caller error. Through the CLI adapter: message on stderr, exit 1; with
  `--json`, `{"code":"E-HUB-09","message":...}` on stderr, exit 1.
  Recovery: fix the bytes or add the marker and resubmit; nothing
  was stored, so no cleanup is needed. Escalation: none; the message names
  the fix.
- Malformed bytes that no parser can read are unmanaged by definition:
  the guard refuses them the same way, and the message still names the
  fix. The guard MUST NOT throw an unclassified error on hostile input.
- The marker with managed bytes is accepted and ignored; it MUST NOT
  change the stored document.

## Security Considerations

Trust boundary: artifact bytes are untrusted author input. The guard parses
them inertly (no DOM, no resource fetch, no script execution), exactly as
the reader's metadata parse does. A hostile document aiming to confuse the
parser gets refused as unmanaged, which is the safe direction: refusal is
always available, and the marker is the caller's explicit choice, not
something bytes can assert for themselves.

Input validation: the marker value MUST be validated as an exact string;
unknown marker values are refused, not treated as absent. The declaration
parse MUST apply the reader's strictness (lowercase only, first match
wins, head only) so a document the reader would treat as unmanaged can
never pass the guard as managed. The reverse (reader managed, guard
unmanaged) is a nuisance refusal, fixed by matching the shared vectors.

Blast radius: a false refusal blocks one publication; the bytes are
unchanged on the caller's side and resubmission succeeds. A false accept
reproduces the original theme-mixing report. The shared test vectors bound
both directions.

Permissions: no new access. The guard runs inside the existing publish
call with the caller's authority.

## Alternatives Considered

**Warn instead of refuse.** A warning in the publication result would let
the headless pipeline continue while informing the caller. Rejected
because warnings scroll past in unattended runs; the failure still reaches
the reader first. The explicit marker gives pipelines a loud opt-out that a
warning cannot.

**Guard the emission path too.** Refusing unmanaged fenced
`lucid-artifact` blocks mid-turn would cover the live agent path.
Rejected because refusal there drops agent output mid-turn with no
resubmission channel; the turn path already teaches emission, and the
creation-time CLI paths are where supplied bytes enter without a reader
present.

**Infer managed-ness from styles.** Scanning the bytes for dark-mode media
queries or semantic properties would catch documents that are effectively
adaptive but undeclared. Rejected because the appearance contract states
parsing never infers support from colors, styles, or prose; inference
would let a wrong guess pass silently, which is worse than a refusal.

**Default-deny with no escape.** Refusing all unmanaged documents with no
marker would be simpler. Rejected because genuinely system-following
documents are legitimate, and a headless pipeline producing them needs a
way to say so once rather than fighting the guard per document.

## Implementation Plan

1. Extract or mirror the inert head-meta parse so the CLI publish path
   can use it; share the test vectors from
   `test/server/artifact-theme.test.ts`. Verify: existing theme tests
   pass unchanged; new unit tests cover the CLI-side parse against the
   same vectors.
2. Add the unmanaged marker to the publication request shape and the CLI
   flag; enforce refuse-without-marker in `publishArtifact` before record
   creation. Verify: unmanaged bytes refused with the named fix; managed
   bytes pass; marker passes; malformed bytes refused, never throwing.
3. Apply the same rule in `runHandoff` with the handoff request shape.
   Verify: handoff round-trip tests plus unmanaged refusal and
   marker-acceptance cases; retry-equality behavior unchanged.
4. Update the appearance contract section and the publish/handoff usage
   text to document the marker. Verify: validator on the RFC is not
   applicable; `bun run check` green.

Rollback at each phase is the phase's own revert; refused publications
store nothing, so no data migration exists.

## Open Questions

1. Marker shape: request field (`"theme": "unmanaged"`) versus CLI-only
   flag. Resolved: both, with the flag setting the field; see Design.
2. Exact error code number in the `E-HUB` family. Resolved: `E-HUB-09`;
   see Design and Error Handling.
3. Whether the guard SHOULD also check `color-scheme` presence for
   fixed-theme declarations (`light`/`dark` SHOULD pair with matching
   standard metadata per the contract). Recommendation: no; declaration
   presence only, per scope. A styling-correctness check is a separate
   proposal if wanted.

## References

Normative:

- [Application and artifact appearance](../artifacts.md#application-and-artifact-appearance) - defines managed versus unmanaged and the frame behavior this RFC guards.
- [Artifact theme tests](../../test/server/artifact-theme.test.ts) - the shared parse vectors the guard MUST match.
- [Publish path](../../src/cli/artifact-publish.ts) - the validation site.
- [Handoff path](../../src/cli/handoff.ts) - the second creation site.

Informative:

- [Adaptive authoring example](../../skills/lucid-design/examples/adaptive-reading.html) - what a compliant managed document looks like.
- [Appearance contracts](../artifacts.md) - the full verification suite the guard's tests join.
