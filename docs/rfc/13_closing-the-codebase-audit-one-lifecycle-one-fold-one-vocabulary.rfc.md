---
number: 13
title: "Closing the codebase audit: one lifecycle, one fold, one vocabulary"
type: refactor
status: Implemented
version: "01"
author: Kevin Frilot
date: 2026-09-05
---

# RFC-13: Closing the codebase audit: one lifecycle, one fold, one vocabulary

> Renders `docs/reports/codebase-audit.md` (2026-09-05, at `d9c8de0`). The
> audit ranked its candidates and stopped; this RFC turns every one of them
> into a requirement, a declined line, or a chore, so nothing in that report
> is left without an answer. Where the audit found a defect, the requirement
> that closes it names the finding (`A1`, `H2`, and so on) so the two
> documents can be read against each other.

### Revision 01

First numbered draft; answers
[`review-unversioned`](13_closing-the-codebase-audit-one-lifecycle-one-fold-one-vocabulary.review-unversioned.md),
which reviewed the draft with SHA-256
`e2aed5e11f38c2327c034a7e6937b14e4db3194337c92c64ea79c385be08ec90`.

- F1: C4 preserves `afterSeq` in version headers and retains the placement oracles.
- F2: C2 and Error Handling distinguish lock-free reads from writer operations and cover host construction.
- F3: Error Handling defines diagnostics and local cleanup when durable reporting fails.
- F4: C7 reads the exact legacy demotion format without waiting for a later turn.
- F5: Scope and Phase 0 explicitly retain and document A8's idle-input exception.

### Implementation record

Implemented on 2026-09-06. The final deterministic gate passes 1,030 tests,
lint and both TypeScript projects; the binary build passes. All five live
lanes have been rerun and their script-generated evidence is under
`spikes/evidence/`.

The interrupted run did not preserve the per-phase commit sequence below.
The implementation lands as one reviewed commit, so reverting that commit
reverts the whole RFC. The prerequisite tree was also checked separately:
all 931 original tests passed.

## Abstract

The audit found one shipped defect and a family of design faults that share
a cause: the same discipline written in more than one place. The
driven-conversation lifecycle exists twice and the copies have drifted, so
`lucid2 chat` cannot apply a patch and never sends the artifact state block.
The log's fold and its append transaction each exist several times inside
one file. The harness event vocabulary is owned in four places and two of
its kinds are unclassified. This RFC specifies one owner for each of those
disciplines - one lifecycle, one fold and one appender, one event-class
table, one `HarnessName`, one "current versions" derivation, one writer-host
constructor - and the fixes that ride on them. It removes the pass-through
modules, the retire residue RFC-09 withdrew, and the dead exports. It leaves
the record format unchanged except for additive fields on an error event,
and it records product-shaped findings as scope decisions rather than deciding them
silently.

## Introduction

### Problem statement

`docs/reports/codebase-audit.md` lists seventeen correctness and robustness
findings (A1-A17) and eighteen design candidates (H1-H3, M1-M6, L1-L9). The
ones that matter share one shape:

- **A1 / H2.** `src/cli/chat.ts:216-228` builds the source's host seam
  without `readArtifact`; `src/cli/runtime.ts:237-250` builds it with. Under
  `chat` a patch-form emission is refused ("v1 could not be read") and
  `composeArtifactState` prepends nothing. Reproduced against the real
  headless host. `CONTEXT.md` names `chat` as "the way in".
- **H1.** `src/store/log.ts` carries two folds (`foldLog` at `:620-746`,
  `foldCollect` at `:762-875`) that a test keeps equal by comparison, five
  hand-written "append one line and roll back" blocks, and five copies of
  the cache-refresh block, two of them partial. Artifact, meta and attachment
  appends stamp `Date.now()` past the injected clock (A6).
- **H3 / A3.** `EventKind` names eleven kinds; the two class lists name nine.
  `question` and `failure` are unclassified, `isKnownEventKind` has no
  runtime caller, and `test/protocol/events.test.ts:16` pins the gap.
- **M2, M1, M4, M5.** "Current version per artifact" is decoded from a
  private key format at six sites; the non-holder writer host is constructed
  by hand at nine; `HarnessName` is defined three times; question demotion is
  a substring match on an error message (A4).

Each of these is a discipline with more than one owner. Fixing any one copy
fixes one copy.

### Scope

In scope:

- One driven-conversation lifecycle shared by `run` and `chat`, and a
  required, typed host seam for the headless source (H2, A1, A7, M6).
- One fold and one append transaction in `src/store/log.ts`, the cursor as a
  known entry source, the injected clock on every append, and
  `readArtifact` that reports its errors (H1, A5, A6, A11, A12, L3).
- One event-class table derived from `EventKind` (H3, A3).
- One derivation of the artifact heads, carried by the fold (M2, A16).
- One constructor for the non-holder writer host (M1).
- One `HarnessName` (M4, A14).
- A typed demotion signal (M5, A4).
- Deletion of the pass-through modules, alias exports, dead exports, the
  retire residue, and the interactive ladder's unused half (M3, L1, M6, L2).
- The artifact byte bound beside `TEXT_MAX` (L4); a typed error branch in
  `Conversations.ensure` (L6); the hcn child ended on an open refusal (A10);
  the attachment `content-type` header validated before the blob is written
  (A11).

Out of scope, each with its reason:

- **Granting credit in the driving process (A2).** A functionality decision:
  it widens what the record holds and what the window shows. Declined here,
  reversibly, under Open Question 1; the fit check is recorded there.
- **A read cache in the server (A16).** RFC-06 decided "seek per request,
  never cache". This RFC removes the per-request re-parse of every document
  by carrying the version headers in the fold instead, which honours the rule.
- **Switching drivers for an idle steer or answer (A8).** Retained behavior:
  only a queue input checks the idle-session driver preference; steer and
  answer go to the driver in force, even while idle. Changing that could
  send an answer to a driver that did not ask its question. Declined here,
  reversibly; Phase 0 documents this exception in `CONTEXT.md` and the
  boundary comment in `src/modes/host.ts`. This is a machine-made decision
  to retain current behavior, not a new driver-switch requirement.
- **One token source for the page and the frame (L5), and any restructuring
  of `src/server/client/app.tsx`.** `CONTEXT.md` holds the browser surface
  for a design pass from scratch. Deepening it first would be designing it
  twice. The design pass inherits L5.
- **Chores that need no design decision**: the twelve lint warnings, the
  pre-commit typecheck scope (L7), a CI build step (L8), and the
  documentation drift table (L9). Listed in the Implementation Plan as Phase
  0 so they are not lost, and specified nowhere else.

### Motivation

Fit check for the review corrections: the user is one person reading and
marking up agent output on one machine. Preserving version placement and
legacy demotions, reporting failed operations, and releasing a failed
driver serve that purpose. These corrections hold scope: they preserve
existing records and complete existing failure paths. A8 also holds scope
by retaining its current behavior; this RFC adds no driver-switch case.

The audit's High findings are not three problems. They are the cost of the
"thin adapter that preserves the import path" habit applied to lifecycles,
folds and vocabularies rather than to modules: each copy is documented as
an adapter over a deep module, and each copy carries its own version of the
rule. A1 is the first time a copy drifted far enough to ship a defect on the
documented entry point. The next candidates for the same failure are the
credit frame path (A9), the append rollback (A11) and the demotion contract
(A4). Closing them together, with one owner each, is cheaper than closing
them one shipped defect at a time.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD
NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted
as described in RFC 2119.

Terms from `CONTEXT.md` carry their meaning from there: record, log, fold,
transcript, source, host, executor lease, presence lock, delivery cursor,
artifact, version, driver preference. Vocabulary from `codebase-design`:
module, interface, seam, adapter, depth.

New or narrowed terms:

| Term | What it is |
|---|---|
| **driven conversation** | A record with a headless source attached, the presence lock held, and a follower over the log. What `run` and `chat` both are |
| **host seam** | The interface a headless source uses to reach the record for artifacts and the cursor. Today `HeadlessDeps.host` |
| **writer host** | A `ConversationHost` that appends and never dispatches: executor lease `false`, silent sinks. What the server, `send` and the hooks open |
| **artifact heads** | The current version of each artifact the record holds: `artifactId -> highest version` |
| **the walk** | The one private fold in `log.ts` from which every public fold is projected |
| **the transaction** | The one private append path in `log.ts`: lock, catch-up fold, cache install, write, fsync, rollback |
| **event-class table** | The one table mapping every `EventKind` to `droppable` or `lossless` |

## Current State

```
src/cli/runtime.ts  ─ ensure → gate → presence → host → honor → base deps → tailer → release
src/cli/chat.ts     ─ ensure → gate → presence → host → honor → base deps → tailer → release  (copy; no readArtifact; 50 ms locked poll)
src/modes/host.ts   ─ HeadlessDeps.host: every method optional; artifactRetired never provided

src/store/log.ts    ─ foldLog ─┐ same walk, twice       append ─┐
                      foldCollect ┘                   writeArtifact ─┤ five lock/fold/write/rollback blocks
                      scanCursor (a third pass)       writeArtifactMeta ─┤ two of them refresh the cache partially
                                                      writeAttachment ─┤ three of them stamp Date.now()
                                                      advanceCursor ─┘

src/protocol/events.ts   ─ EventKind (11) ; DROPPABLE_KINDS + LOSSLESS_KINDS (9) ; isKnownEventKind (no caller)
src/harness/events.ts    ─ "failure", "question" as literals
src/protocol/ledgers/input.ts ─ TERMINAL_EVENT_KINDS
src/tui/view.ts          ─ UNRENDERED

artifactKey decode ("\0" split)  ─ conversation-host.ts, host.ts ×2, server.ts ×3
writer host by hand              ─ server.ts ×5, send.ts, announce.ts, interactive-host.ts, scripts
HarnessName                      ─ protocol/frames.ts, harness/runner.ts, store/driver-preference.ts
demotion                         ─ host.ts composes prose; reducer.ts matches a substring
```

Facts the audit established, with the level of evidence it reached:

- The chat defect (A1) reproduces against the real headless host with a
  fake hcn: with the `chat` seam shape, v2 is not written and the second
  prompt carries no state block; with the `runtime` shape, both happen.
- `isKnownEventKind("question")` is `false` (run against the source).
- No process in `src/` calls `grantCredit` except the fold's own replay of
  existing credit entries; the sequencer starts at zero credit and coalesces
  droppable events until a credit frame arrives (traced).

## Proposed Changes

### C1 - One driven-conversation lifecycle (H2, A1, A7, M6)

```
src/cli/runtime.ts
  openDrivenConversation(opts) ──► DrivenConversation | AwaitToken
       │
       ├── startHeadless(opts)   = openDrivenConversation + block on done      (run)
       └── chatConversation(opts)= openDrivenConversation + render + keys      (chat)

src/modes/host.ts
  HeadlessDeps.host: ArtifactHost   (required, every method required)
  hostSeamFor(host: ConversationHost): ArtifactHost   (the one production adapter)
test/harness/fakes.ts
  fakeArtifactHost(): ArtifactHost                    (the one test adapter)
```

- The lifecycle - ensure the record, derive the channel status and consult
  the controller (D-021), acquire presence, open the host, open the honoring
  driver, wire the R2 gate to the presence handle, follow the log, release
  once - MUST exist in exactly one function, `openDrivenConversation`, in
  `src/cli/runtime.ts`.
- `openDrivenConversation` MUST return the pieces `chat` needs and `run` does
  not: the `ConversationHost` (for `enqueueInput` and `snapshot`), the
  honoring source (for `state().profile`), and a way to observe each
  follower trigger. `startHeadless` MUST keep its current return shape
  (`RunningConversation | AwaitToken`) so `runConversation` and its tests do
  not move.
- `chatConversation` MUST NOT open a second host, acquire presence twice,
  open a second honoring driver, or run a second `followRecord`. It MUST
  render from `host.snapshot()`: on the lifecycle's own follower trigger
  (which has already folded under the lock in `collectEffects`) and on
  keystrokes. It MUST NOT take the append lock to paint. The follower
  cadence is the runtime's 500 ms (RFC-04: do not tighten it); the keystroke
  path reads the cached snapshot and costs no fold.
- `HeadlessDeps.host` MUST become a named interface, `ArtifactHost`, with
  every method REQUIRED: `cursor`, `collectEffects`, `advanceCursor`,
  `artifactHeads` (C4), `readArtifact`, `writeArtifact`. A source MUST NOT be
  constructible without one. `artifactRetired` is removed (RFC-09; M6), and
  with it `ArtifactState.retired` and the RETIRED wording in
  `composeArtifactState`.
- `hostSeamFor(host)` in `src/modes/host.ts` MUST be the only place the
  production seam is built. Tests MUST use `fakeArtifactHost()` from
  `test/harness/fakes.ts` rather than object literals, so the seam has two
  adapters and the rigs cannot drift from production the way `chat.ts` did.
- The honor driver's `receive` MUST NOT drop a `credit` frame during a
  switch (A9). It SHOULD hold it and deliver it to the replacement source
  after the swap; it MAY drop an `input` frame, which the record replays.

### C2 - One fold and one transaction in `src/store/log.ts` (H1, A5, A6, A11, A12, L3)

```
walk(raw, {collectFrom?})           ─ private; returns state, goodBytes, transcript,
                                       refusedInputs, cursor, artifactIndex,
                                       artifactHeads, artifactVersions (header per version),
                                       artifactTitles, artifactRefusals, collected
  foldLog  = walk(raw)               ─ projection, kept for viewers
  foldCollect = walk(raw, {from})    ─ projection, kept for the collector

transaction(at, fn: (folded) => {line: Buffer | null; onWritten?(offset)})
                                    ─ private; lock → readFoldRepair → install(folded)
                                      → fn → write-all → fsync → rollback on throw
                                      → close in try → append.* events → curGoodBytes
  append(produce)                    = transaction(...)  frame / input / credit
  writeArtifact(params)              = transaction(...)
  writeArtifactMeta(params)          = transaction(...)
  writeAttachment(params)            = putBlob outside the lock, then transaction(...)
  advanceCursor(offset)              = transaction(...)
```

- `foldLog` and `foldCollect` MUST be projections of one private walk. A
  test that compares them for equality is retired (replace, do not layer).
- `"cursor"` MUST be added to `ENTRY_SOURCES` with a coercion
  (`coerceCursorEntry`) on the same terms as `coerceAttachEntry`, and the
  walk MUST apply it: the cursor is the greatest offset seen, and an offset
  past `goodBytes` MUST refuse the record as `corrupt-log` (RFC-04
  unchanged). `scanCursor` is removed; the fold is one pass, not two.
- Every append MUST go through the transaction. The transaction MUST: take
  the append lock; `readFoldRepair`; install the fold into the cached state,
  transcript, cursor, index, heads, version headers (including `afterSeq`),
  titles and refusals in one function;
  call `fn` with the fold; write with `writeAllSync` and `fsyncSync`; on a
  throw, `ftruncateSync(fd, preWriteOffset)` then `truncateSync` as the
  fallback; close the fd inside a `try`; emit `append.start`, `append.ok`
  or `append.failed`; and update `curGoodBytes`. A writer MUST NOT
  re-implement any of those steps.
- `LogDeps` MUST gain a REQUIRED `now: () => number`, and every entry's
  `at` MUST come from it. `createConversationHost` passes `deps.now`.
  `advanceCursor(offset, at)` loses its `at` parameter.
- `advanceCursor` MUST NOT write when `offset <= curCursor`, including
  `offset === 0` (A12). It MUST still refuse `offset > goodBytes`.
- `readArtifact` MUST NOT catch. A `LockError` or a `StoreError` MUST
  propagate to the caller. Its indexed read remains lock-free; only its
  stale-offset fallback acquires the lock, with `onLockEvent`. An unknown
  index key still returns `null`. Holding the append lock alone MUST NOT
  make a valid indexed read fail. Callers map errors at the actual operation
  boundary (see Error Handling), including writer-host construction.
- The unreachable `applyEntry` cases for `artifact`, `artifact-meta` and
  `attach` are removed. `_REDACTED`, `_isCursorEnvelope` and the write-only
  `curArtifactRefusals` are removed.
- `writeAttachment` MUST validate `contentType` and `name` before `putBlob`,
  so an invalid entry never leaves an orphan blob. The server MUST validate
  the `content-type` header with the same predicate before reading the body
  (A11).

The public `ConversationLog` interface does not change shape except:
`artifactHeads()` and `artifactVersions()` are added (C4), and
`advanceCursor` drops `at`.

### C3 - One event-class table (H3, A3)

```ts
// src/protocol/events.ts
export const EVENT_CLASS = {
  token: "droppable", progress: "droppable", context: "droppable",
  identity: "lossless", message: "lossless", tool: "lossless",
  limit: "lossless", error: "lossless", question: "lossless",
  failure: "lossless", done: "lossless",
} as const satisfies Record<HarnessEventKind, EventClass>;

export const DROPPABLE_KINDS = kindsOf("droppable");
export const LOSSLESS_KINDS = kindsOf("lossless");
```

- `EVENT_CLASS` MUST be the only place a kind is classified. The two lists
  MUST be derived from it. The `satisfies` clause makes an unclassified
  `EventKind` a type error, which is the drift probe the comments promised,
  at compile time.
- `classOfEventKind` keeps its contract: an unknown or malformed kind is
  `lossless`.
- `src/harness/events.ts` MUST use `EventKind.failure` and
  `EventKind.question` rather than literals. `TERMINAL_EVENT_KINDS`
  (`ledgers/input.ts`) and `UNRENDERED` (`tui/view.ts`) stay as subsets but
  MUST be typed `readonly HarnessEventKind[]`.
- `test/protocol/events.test.ts` MUST assert that every value of `EventKind`
  has a class and that `DROPPABLE_KINDS ∪ LOSSLESS_KINDS` equals
  `Object.values(EventKind)`, rather than pinning a literal list. The
  oracle-sweep completeness test then covers the whole vocabulary without
  change.
- `isKnownEventKind` and the three comments that describe a runtime drift
  probe are removed (Open Question 2 records the alternative).

### C4 - The fold carries the artifact heads and headers (M2, A16)

- The walk MUST record, per artifact version, `{offset, author, at,
  afterSeq, basedOn?}` (header and derived placement, never the bytes) and, per artifact, the
  highest version. `ConversationLog` and `ConversationHost` MUST expose
  `artifactHeads(): ReadonlyMap<string, number>` and
  `artifactVersions(): ReadonlyMap<string, ReadonlyMap<number, VersionHeader>>`.
- `afterSeq` MUST be the protocol sequence immediately before that version's
  entry, or zero before any sequenced entry. It is derived during the walk,
  never stored in a new log field and never inferred from `at` or `offset`.
  The first accepted entry for an artifact/version pair owns its header;
  duplicates MUST NOT replace it, and oversized refused entries MUST NOT
  contribute headers or heads. A successful artifact append MUST publish
  its header with the pre-append sequence in the cached projection.
- `artifactKey` and its NUL-joined format MUST become private to `log.ts`.
  No module outside it may split an index key. The six sites
  (`conversation-host.ts:474-484`, `host.ts:95-101`, `host.ts:272-279`,
  `server.ts:448-453`, `:527-533`, `:578-583`) read `artifactHeads()`.
- `viewArtifactCatalog` MUST build the catalog from `artifactVersions()` and
  MUST NOT seek to any version line after the fold. It MUST preserve the
  existing `afterSeq` response map using each header's `afterSeq`. The
  separate NUL-keyed `artifactAfterSeq` map is replaced by these headers;
  callers need neither its key format nor a second derivation. The initial
  fold still reads the log; this removes the catalog's second parse of
  each document, not the initial read.
- `handleArtifactMessage` MUST compute "what the record holds" as
  `artifactHeads()` merged with the message's own `localVersions`, and the
  RFC-09 E-ART-09 predicate reads that map.

### C5 - One writer-host constructor (M1)

```ts
// src/store/conversation-host.ts
export const openWriter = (
  dir: string,
  deps: { now?: () => number; presence?: () => boolean | undefined } = {},
): ConversationHost
```

- `openWriter` MUST set `executorLease: () => false` and MUST NOT accept an
  `onEffect` or `onRecord`; a writer host acts on nothing and records
  nothing. `presence` defaults to `undefined`; `announce` passes `true` as
  it does today.
- The server's five handlers, `send`, `announce`, `deliverFirstQueued`, and
  the smoke scripts MUST open their hosts through it. The R2 comment that
  repeats at each site is deleted; the rule lives on `openWriter`.

### C6 - One `HarnessName` (M4, A14)

- `HARNESS_NAMES` and `HarnessName` in `src/protocol/frames.ts` are the one
  definition. `src/harness/runner.ts` MUST re-export the type from there
  (the harness package already imports `src/protocol/events.ts`, so the
  direction exists). `src/store/driver-preference.ts` MUST import
  `HARNESS_NAMES`; `DRIVER_HARNESS_NAMES` is removed.
  `scripts/smoke-live.ts` MUST resolve its flag through `harnessForName`.

### C7 - A typed demotion signal (M5, A4)

- The error event the host emits when an answer is demoted MUST carry
  `code: "answer-demoted"` and `inputId` beside its message:

  ```json
  { "kind": "error", "code": "answer-demoted", "inputId": "in-7",
    "message": "answer demoted: no-open-question for in-7", "terminal": false }
  ```

- For an error event with a `code` field, `nextQuestionOpenAfterEvent` MUST
  clear `questionOpen` on `code === "answer-demoted"` and MUST NOT inspect
  `message`. An unrecognized code MUST NOT invoke legacy parsing. Other
  clear causes, such as the first event of an unrelated turn, still apply.
- An error event without `code` MUST also clear the question when its whole
  message is exactly the legacy format `answer demoted: no-open-question for `
  followed by a nonempty input id. A named private compatibility parser
  owns that format; substring matching elsewhere is removed. New writers
  MUST emit the code and `inputId`; they MUST NOT emit legacy-only demotions.
- These additive fields do not require a record migration. The legacy
  parser clears the question at the demotion entry itself, including when
  the fallback send is rejected or the record ends before another event.
  There is no dependency on a later turn to heal old state.
- An uncoded error with merely incidental `no-open-question` prose no
  longer clears a same-turn question. That is an intentional fold-visible
  correction. Without a format-version marker an uncoded event exactly
  matching the legacy format cannot be distinguished from an old demotion;
  it retains legacy behavior. The compatibility parser stays while these
  records remain supported.

### C8 - Deletions (M3, L1, L2, M6)

Deleted outright, with their tests moved to the module that owns the code:

| Path | Kind |
|---|---|
| `src/cli/conversations.ts`, `src/cli/env-stamp.ts`, `src/cli/self.ts`, `src/cli/hooks/resolver.ts` | re-exports of `record-addressing.ts` |
| `src/modes/headless.ts`, `src/modes/interactive.ts` | re-exports of `host.ts` / `interactive-host.ts` |
| `src/store/lock.ts` | re-export of `flock.ts`; `store/index.ts` exports the safe surface from `flock.ts` directly, `acquireWith` stays deep-import only |
| `src/cli/hooks/delivery.ts` re-export block (`:19-35`) | `readStdin` and `exitHook` stay; the hooks import the rest from `interactive-host.ts` |
| `chunkInput`, `CHUNK_CAP_BYTES`, `chunkInjection`, `INJECTION_CAP`, `DeliverResultDurable` | aliases in `interactive-host.ts` |
| `openHeadlessSessionViaHost`, `openHeadlessTurnsViaHost` | zero callers |
| `artifactPlaceholder`, `bindToProcess`, `presencePaths`, `HARNESS_AWAITING_INPUT`, `readInput`, `heldLocks`, `lockBackend`, `backendFor`, the ledger free-function aliases and their `protocol/index.ts` lines | dead or test-only |
| The strategy table, `createInteractiveHost`, `attachCapabilities`, `cooperativeStrategy`, `observeStrategy`, `hooksStrategy` in `interactive-host.ts` | one-adapter seam with no production caller (L2; Open Question 3) |

- `selectRung`, `RUNGS`, `RungProfile` and `A003_GATE_OPEN` MUST stay: they
  are the `rung` vocabulary `CONTEXT.md` defines and D-030 gates.
- `deliverFirstQueued` MUST NOT mutate `process.env`; the caller (`inject`)
  clears `HERDR_ENV` before calling it.
- The three barrels (`protocol/index.ts`, `store/index.ts`,
  `modes/index.ts`) stay; they are imported widely and are the public
  import path.

### C9 - Small fixes that ride along (A10, A13, L4, L6)

- `createHcnRunner.openSession` MUST end the child on an open refusal or a
  version refusal: `proc.endInput()` and `proc.kill("SIGTERM")` before the
  throw, and it MUST await the pump so the fake process's `signals` can
  assert it.
- `ARTIFACT_BYTES_MAX` MUST move to `src/protocol/frames.ts` beside
  `TEXT_MAX`; `src/store/log.ts` imports it. No module under `src/protocol/`
  may import from `src/store/` afterwards (the CI grep gate that guards the
  hcn seam gains a second pattern for this).
- `Conversations.ensure` MUST branch on `StoreError.code === "record-exists"`.
  `createConversationRecord` MUST use a distinct code, `record-publish-failed`,
  for a failed rename (`StoreError` gains it).

## Migration Strategy

Each step is one commit, green on `bun run check` before the next. No
dual-write period: a copy is deleted in the commit that replaces it. The
order puts the highest-value, lowest-risk changes first and the log
rewrite last, so a rollback of the log rewrite loses nothing above it.

1. **C3** (event-class table). Pure; tests move first.
2. **C6** (one `HarnessName`), **C9** fixes, **C8** deletions except the
   `headless.ts`/`interactive.ts` facades (the scripts still import them
   until step 4).
3. **C4** (artifact heads in the fold) and **C5** (`openWriter`). The
   `artifactKey` format goes private in the same commit its last external
   reader is replaced.
4. **C1** (one lifecycle, required `ArtifactHost`). The chat + artifact
   test (Testing Strategy, 1) lands red before the change and green after.
   The remaining facades go.
5. **C7** (typed demotion).
6. **C2** (one walk, one transaction, cursor as a known source, clock
   injected, `readArtifact` propagates). The store suite is the oracle;
   every assertion on log bytes MUST pass unchanged.

Backward compatibility:

- **Record format.** Existing envelopes are unchanged. The cursor entry is
  the same bytes, now coerced rather than carried. Demotion adds `code` and
  `inputId` to an
  event payload. No `PROTOCOL_VERSION` bump (RFC-03: a bump makes every
  record unopenable).
- **Older readers** open a record written after this RFC: `code` and
  `inputId` are ignored fields; the legacy message remains present.
- **Newer readers** preserve clearing at a genuine pre-RFC demotion, even
  without a later event. Incidental substring matches no longer clear a
  question; C7 specifies this correction and the exact legacy exception.
- **CLI.** `run`, `chat`, `send`, `watch`, `serve`, `announce`, `inject`
  keep their argv and exit codes. Successful output stays the same except
  that `chat` gains the artifact behavior RFC-07 and RFC-08 specify for a
  headless driver. Failed-log shutdown adds the stderr diagnostic specified
  in Error Handling.
- **HTTP.** No route changes. The attachment endpoint refuses an invalid
  `content-type` header with 400 `attachment-invalid` before reading the
  body. Save, restore and meta map lock timeouts during host construction
  or mutation to 503 `record-busy`. Restore also maps a timeout in its read
  fallback. Version GET remains lock-free, with its existing 404 for a
  missing version and 409 for damage. Error Handling defines the boundaries.

Rollback: each step reverts independently to the previous green state.
Step 6 is the only one that touches the append path; its rollback is the
commit revert, with no record migration in either direction.

## Risk Assessment

- **The append transaction (C2).** The one change with data risk: every
  durable byte goes through it. Mitigation: the existing store oracles
  (`test/store/store.test.ts`, `m13-two-writer`, `cursor`, `collect-effects`,
  `artifacts`, `blobs`) assert on log bytes and lock behaviour and MUST pass
  unchanged; the transaction is a refactor of five copies into one, not a
  new discipline. Blast radius on failure: a record that fails to open or a
  torn line, both of which the repair path already handles and the tests
  already cover.
- **`readArtifact` propagating (C2).** Callers that relied on `null` for
  "busy" now see an error. Error Handling separates the host's prompt and
  patch reads from the server's writer operations. Reporting an error can
  itself fail; local cleanup cannot depend on writing another log entry.
- **`chat` rendering from the cached snapshot (C1).** The snapshot is
  refreshed by the lifecycle's own `collectEffects` under the lock, at the
  500 ms cadence; a keystroke paints what the last trigger saw. A person
  sees the same thing `watch` shows, half a second later at most.
- **Deletions (C8).** Import-path churn in scripts and tests. Blast radius:
  a script that fails to import, caught by `tsc` since scripts are in the
  root `tsconfig.json`'s `include` only if listed; `bun run check` typechecks
  `src` and `test`, so **`scripts/` MUST be added to the root `include`** in
  Phase 0 before step 2, or the smoke scripts break silently.
- **Demotion (C7).** The exact legacy format remains supported. Incidental
  substring matches stop clearing questions; legacy-only and coded replay
  tests distinguish those cases without relying on a later turn.
- **Downtime.** None; single-user local tool, no deployed instance.

## Error Handling

Store failures at the operation boundaries below (C2):

```
E-LOG-01  record-busy                 (severity: warning)
          An operation hit the append-lock timeout (LockError lock-timeout).
          Server: 503 with retry-after: 1, body {"error":"record-busy"}.
          Host read: refuse the patch with E-PATCH-09, or omit the artifact
          from this prompt's state block with one line saying it was busy.
          Attempt one non-terminal error event naming the lock and artifact.
          Recovery: continue only if that event is accepted. If recording
          fails, report outside the log and stop locally as specified below.
          A later request or turn can retry; no automatic patch retry.

E-LOG-02  record-unreadable           (severity: error)
          An operation hit corrupt-log or fold-refused.
          Server: 409 {"error":"damaged"}, matching the conversation
          endpoint's existing damage report.
          Host: report outside the log and stop locally. No event or detach
          append is attempted against a log already known to refuse folding.
          Recovery: the driver's problem; a reader MUST NOT repair (RFC-10).

E-PATCH-09  record-busy               (severity: warning)
          A patch could not read its base because of E-LOG-01. Refused whole,
          no artifact version appended, retryable. Distinct from E-PATCH-02:
          the anchor was never tested, so this refusal creates no new
          obligation to resend bytes. An earlier obligation still stands.
```

**Server boundaries.** The following handlers MUST map `LockError` with
`code === "lock-timeout"` to E-LOG-01 and `StoreError` with `corrupt-log` or
`fold-refused` to E-LOG-02 at the specified boundaries. Other errors retain
their existing handling; they MUST NOT be mislabeled as a missing version.

| Operation | Boundary | Read behavior |
|---|---|---|
| Save | `openWriter` and `writeArtifact` | Does not call `readArtifact` |
| Meta | `openWriter` and `writeArtifactMeta` | Does not call `readArtifact` |
| Restore | `openWriter`, `readArtifact`, and `writeArtifact` | Indexed read is lock-free; stale-offset fallback can time out |
| Version GET | `viewArtifactVersion` | Remains lock-free; missing version is 404 and damage is 409 |

The handler's error boundary MUST include host construction, not start
after it. A constructed host MUST close in `finally`; a failed construction
has no returned host to close. Version GET MUST NOT open a writer host or
acquire an append lock merely to produce a busy response. A valid version
remains readable while another process holds that lock.

**Host boundaries and reporting failure.** Both session and turn modes MUST
handle read failures while preparing artifact state and while resolving a
patch base. An E-LOG-01 warning is one bounded append attempt using the
existing lock timeout. A refused result or a thrown error during this
attempt MUST NOT cause another warning append or a durable detach attempt.
The source MUST stop accepting inputs and initiate local shutdown instead.
E-LOG-02 goes directly to this shutdown path without an append attempt.

Local shutdown MUST notify the lifecycle through a path independent of
`sendFrame`, stop the follower, initiate harness close, close the host, and
release presence exactly once. Host close, follower cancellation, and
presence release MUST run even if harness close throws or remains pending.
Shutdown MUST NOT advance the delivery cursor for undelivered work. These
rules also apply when an ordinary detach append fails during shutdown.

The runtime MUST write one diagnostic to stderr containing the error code,
conversation id, operation, and artifact id when available. It MUST NOT
include the record secret, input text, or artifact bytes. Failure of the
diagnostic sink MUST NOT prevent local cleanup. No new durable error store
or retry queue is introduced. A terminal event is not promised when the log
cannot accept one.

When a state-block read is skipped because of E-LOG-01 and its warning is
recorded successfully, any previously owed artifact bytes MUST remain owed
until included in a later prompt. Skipping the read MUST NOT consume the
one-prompt resend obligation from an earlier anchor refusal.

Other error behaviour this RFC changes:

- `attachment-invalid` (400) is answered before the body is read when the
  `content-type` header fails `isArtifactField`; no blob is written.
- `record-publish-failed` is a new `StoreError` code for a failed record
  rename; `record-exists` means only that.
- A refused `hcn session` open (`HarnessRefusal`, `HarnessVersionError`,
  `HarnessSpawnError`) leaves no child running.

Retry policy is unchanged: lucid never retries a resume, a patch, or an open
on its own.

## Security Considerations

- **Trust boundaries.** Unchanged in shape. The record secret still
  authenticates attach; the server still holds a per-start token behind a
  custom header and an origin allowlist; the artifact frame is still
  sandboxed without `allow-same-origin`. Nothing here adds a process, a
  port, a socket or a descriptor.
- **The executor lease rule (R2).** `openWriter` (C5) encodes "this process
  never dispatches" once, in the constructor, rather than at nine sites. A
  writer host cannot be constructed with a lease gate, so a future endpoint
  cannot acquire dispatch by copying the wrong literal.
- **Input validation.** The attachment `content-type` header is validated
  with the record's own field predicate before any bytes are written, so a
  browser-supplied header can no longer produce an orphan blob. The demotion
  `code` is compared by equality. Only uncoded errors use the exact legacy
  demotion format; incidental substrings no longer clear a question. The
  legacy ambiguity is explicit in C7 rather than treated as authentication.
- **Denial of service visibility.** `readArtifact` no longer converts a lock
  timeout into "no such version". A stuck append lock now surfaces as
  `record-busy` at writer endpoints. A host records a warning only when an
  append succeeds; otherwise stderr reports the failure and local cleanup
  releases presence without requiring another write. Version GET stays
  lock-free. No reporting path recursively appends its own failure.
- **Process hygiene.** An hcn child refused at open is ended (C9), so a
  refused invocation cannot leave a harness process holding a session
  nobody drives.
- **Blast radius.** The largest is C2: a wrong transaction could tear a
  line. The repair path, the byte-accurate store oracles, and the rule that
  every step reverts independently bound it to one commit.
- **Data sensitivity.** No change to the secret, the token, or PII handling.
  Successful state blocks carry the same artifact content without RETIRED
  marking; a busy read omits that artifact with a short explanation. The
  diagnostic outside the log contains identifiers, not document content.

## Testing Strategy

The existing suite is the oracle: 931 tests, every store assertion on log
bytes, every reducer oracle. The rule from RFC-02 holds: the rig changes;
the expected log does not.

New or changed tests, each landing with its step:

1. **`chat` with an artifact** (`test/cli/chat.test.ts`): drive
   `chatConversation` with synthetic keys and a fake hcn that emits a
   whole-form v1 then a patch; assert v2 is written and the second prompt
   carries `[lucid artifact state]`. This is the audit's probe made
   permanent, and it is red on `d9c8de0`.
2. **The seam has two adapters** (`test/modes/headless.test.ts`): a rig
   built with `fakeArtifactHost()` and a rig built with `hostSeamFor(host)`
   pass the same emission tests.
3. **Event-class coverage** (`test/protocol/events.test.ts`): the union of
   the two lists equals `Object.values(EventKind)`.
4. **Artifact heads** (`test/store/artifacts.test.ts`): `artifactHeads()`
   equals the heads the catalog used to derive; `viewArtifactCatalog` reads
   no version line after folding (assert zero calls to the version reader).
   Headers preserve first-writer ownership and exclude oversized refused
   versions. All five `test/store/artifact-place.test.ts` placement oracles
   MUST pass unchanged, including the catalog's `afterSeq` across reopening.
5. **`openWriter`** (`test/store/store.test.ts`): a writer host produces
   effects and acts on none; it holds no presence lock (`presenceHeld`
   stays `false`).
6. **Demotion by code** (`test/modes/demotion.test.ts`): the question clears
   on `code: "answer-demoted"` regardless of message wording. Replay an
   uncoded exact legacy demotion with a rejected fallback send, and a record
   ending at the demotion: both clear without another event. Incidental
   substring prose and an unknown code with legacy-looking prose do not
   clear a same-turn question. Non-error events do not invoke this rule.
7. **`readArtifact` propagates** (`test/store/m13-two-writer.test.ts`
   style): retain an indexed version in an open host, then replace the test
   log with an empty buffer while a second process holds the append lock.
   Its known offset now lies outside the bytes read, forcing the fallback;
   `readArtifact` throws `LockError`. As a negative control, a valid indexed
   read succeeds with the lock held. This synthetic stale-offset setup is
   a failure oracle, not a supported record-editing workflow.
8. **One walk**: `test/store/collect-effects.test.ts`'s fold-equality
   comparison is deleted; the effects assertions stay.
9. **Cursor as a known source** (`test/store/cursor.test.ts`): a cursor
   past `goodBytes` still refuses; a torn trailing cursor still reads as an
   earlier cursor.
10. **hcn child ended on refusal** (`test/harness/hcn-runner.test.ts`): the
    fake process records `SIGTERM` after a `failure`-before-`session` line
    and after a below-floor `session` line.
11. **Clock injection**: an artifact written through a host with an injected
    clock carries that clock's `at`.
12. **HTTP error boundaries** (`test/server/server.test.ts`): save, meta,
    and restore return 503 and `retry-after: 1` when writer construction
    times out. Also cover timeouts during each mutation and restore's read
    fallback after construction, using a controlled seam where necessary.
    Version GET returns the valid version while the append lock is held,
    404 for an absent version, and 409 for damage. Each writer boundary maps
    corrupt-log and fold-refused to 409; cleanup runs for constructed hosts.
13. **Unwritable-log cleanup** (mode and runtime tests): persistent lock
    timeout causes at most one warning append attempt; persistent corruption
    causes no reporting append. Both session and turn modes stop, notify the
    lifecycle, cancel the follower, and release presence once without a
    successful detach frame or cursor advance. A throwing or pending harness
    close and a throwing diagnostic sink do not block that cleanup. A busy
    state-block read whose warning succeeds preserves previously owed bytes
    for the next prompt.

Live lanes (`scripts/smoke-*.ts`) are re-run after step 6 and their evidence
files rewritten, per `AGENTS.md`. They confirm; they do not gate.

## Implementation Plan

| Phase | Delivers | Verify | Depends on |
|---|---|---|---|
| 0 - chores | the 12 lint warnings fixed; `lefthook.yml` runs `bun run typecheck`; CI gains `bun run build`; the documentation drift table in the audit applied (RFC statuses, `CONTEXT.md` record row and attachments, `smoke-seven.md` rows 2 and 4, RFC-02 fixture list, the two false comments); A8's idle steer/answer exception documented in `CONTEXT.md` and the host boundary comment; `scripts/` added to the root tsconfig `include` | `bun run check`, `bun run build` | nothing; MUST precede phase 2's import deletions for script typechecking |
| 1 | C3 | events tests (3) | - |
| 2 | C6, C9, most of C8 | `bun run check`; hcn-runner test (10) | 0, 1 |
| 3 | C4, C5 | tests (4), (5) | 2 |
| 4 | C1 and the last facades | tests (1), (2); `bun scripts/smoke-live.ts` | 3 |
| 5 | C7 | test (6) | 4 |
| 6 | C2 and its HTTP/error-cleanup boundaries | tests (7), (8), (9), (11), (12), (13); the full store suite unchanged; all live lanes | 5 |

Go/no-go between phases: `bun run check` green and the phase's tests
passing. A phase that needs an hcn change stops and files it against the
normalizer rather than working around it.

Phase 0 collects the audit's chores. Its documentation work also records
the retained A8 behavior and the A2 default specified in this draft.

## Open Questions

1. **Should the driving process grant credit (A2)?** Today no shipped
   process grants credit, so `token`, `progress` and `context` events are
   never recorded, and the browser's activity model treats that absence as a
   fact about hcn.
   Fit check: the user is the one person watching a conversation; the product
   is "read what an agent produced, and mark it up"; whether live token text
   and progress labels serve that is unclear - the reading view already
   reports "working · elapsed" and the design pass has not asked for
   streaming; granting widens what the record holds (every delta becomes a
   durable frame) and what the window shows.
   Options: (a) the driver grants credit continuously, bounded by
   `DROPPABLE_QUEUE_MAX`, re-granting as droppable events land; (b) keep
   credit ungranted, and say so in `CONTEXT.md`'s `credit` row and in
   `src/server/client/activity.ts`, so the absence is a decision rather than
   a gap.
   Criterion: whether the design pass wants live text in the reading view.
   Recommended: (b), the reversible option. Machine-made default: (b);
   Phase 0 carries the two wording changes.
   Decider: the user, with the design pass.
2. **`isKnownEventKind`: delete, or wire it into the runner's boundary
   log?** Options: delete it (an unknown kind is already recorded verbatim
   and renders as `[kind]` in the transcript, so drift is visible to a
   person); or log `unknown_event_kind` once per kind from
   `createHcnRunner`. Recommended: delete; the `satisfies` table is the
   compile-time probe and the transcript is the runtime one. Machine-made
   default: delete. Decider: this RFC's review.
3. **The interactive ladder's strategy table.** D-030 gates the cooperative
   rung on A-003. Options: delete the table and `createInteractiveHost` now
   and rebuild when A-003 lands; keep them as a documented placeholder.
   Recommended: delete; `selectRung` and the vocabulary stay, and a
   placeholder with constant strategies is a seam with no adapter.
   Machine-made default: delete. Decider: this RFC's review.
4. **The HTTP status for `record-busy`.** 503 with `retry-after` says
   "try again"; 409 would match the damage report. Recommended: 503, because
   the condition clears on its own and a client can act on `retry-after`.
   Machine-made default: 503. Decider: this RFC's review.
5. **The RFC type.** `refactor` was chosen because every requirement
   restructures existing code; C7 is the one protocol-shaped change and it
   is additive. Recorded as machine-made.

## References

### Normative

- `docs/reports/codebase-audit.md` - the findings (A1-A17) and candidates
  (H1-H3, M1-M6, L1-L9) this RFC renders, with the evidence level each
  reached.
- `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` - the harness seam
  and the "rig changes, expected log does not" discipline.
- `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md` -
  the cursor, R2, the 500 ms cadence.
- `docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md` -
  `questionOpen` and the demotion path C7 retypes.
- `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md`
  and `08_revising-an-artifact-without-retyping-it.rfc.md` - the state block
  and the patch form `chat` regains.
- `docs/rfc/09_one-artifact-per-conversation.rfc.md` - the retire withdrawal
  C1 completes.
- `src/store/log.ts`, `src/store/conversation-host.ts`, `src/modes/host.ts`,
  `src/cli/runtime.ts`, `src/cli/chat.ts`, `src/protocol/events.ts` - the
  modules this RFC changes.

### Informative

- `CONTEXT.md` - the words, and "the interface is a prototype, not a
  design", which is why the client is out of scope.
- `AGENTS.md` - the verification discipline and the live lanes.
- `docs/decisions.md` - D-021 (the gate), D-030 (A-003 and the cooperative
  rung), D-032 (the oracle sweep).
- The `codebase-design` and `codebase-audit` skills - the vocabulary the
  audit and this RFC share.
