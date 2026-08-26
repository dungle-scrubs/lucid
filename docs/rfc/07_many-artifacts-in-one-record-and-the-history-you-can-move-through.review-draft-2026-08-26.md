<!-- Cross-family review of RFC-07, Draft 2026-08-26.
     Reviewer: muse-spark-1.2-contributor@muse, effort high, read-only access.
     Routed by choose-model with excludeFamilies ["claude"], because a Claude
     model wrote the RFC. The registry warned that no non-Claude route meets the
     high-stakes minimums for `plan` (intelligence >= 9, taste >= 7) and returned
     its most capable survivor; findings are graded on the evidence ladder and
     the reviewer capped its own rungs at 2 because its sandbox denied shell.
     One stray character was corrected in the F-12 heading. Otherwise verbatim. -->

# Review: RFC-07 — Many artifacts in one record, and the history you can move through

## What was reviewed

- **RFC path:** `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md`
- **Version:** Draft, dated `2026-08-26` (frontmatter `number: 07`, `type: feature`, `status: Draft`)
- **Status at review:** Draft, not implemented. This review is cross-family, read-only, no edits.
- **Read before writing:** `CONTEXT.md`, `docs/rfc/06_an-artifact-you-can-address.rfc.md`, `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md` (Implemented, including its prerequisites P1/P2 and its review draft), `src/store/log.ts` (ENTRY_SOURCES, Envelope, validEntry, knownEntry, coerceArtifactEntry, applyEntry, foldLog), `src/store/conversation-host.ts` (viewArtifactCatalog, viewArtifactVersion, artifactIndex), `src/server/server.ts` (routes, save endpoint, catalog endpoint), `src/server/client/app.tsx` (catalog poll, DocumentFrame, sandbox, artifact selection), `src/server/client/instrument.ts`, `src/server/client/layout.ts`, `src/protocol/artifacts.ts` (fence, id/replaces, ARTIFACT_STATE_MARKER, composeArtifactState), `src/protocol/annotations.ts` (artifactId@version, batch shape), `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. Shell and `gh` were denied by the sandbox; ticket comments for wayfinder #59 / #60-69 were not accessed and are reported as not verified.

## Structural results

Validator `npx tsx ~/.claude/skills/draft-rfc/scripts/validate-structure.ts <rfc>` returns verbatim:

```json
{ "passed": true, "errors": [], "warnings": [] }
```

Do not re-derive. Structure is well-formed; substance is what this review attacks.

## Claims to attack — verdicts

Each claim below is load-bearing. Verdict is whether the RFC's statement matches the codebase today.

### 1. `viewArtifactCatalog` already returns every artifact and the client discards all but the last

**Holds.** `src/store/conversation-host.ts:420` builds the catalog from `foldLog(...).artifactIndex` — every key in the index, no filter — and returns sorted `ArtifactCatalogEntry[]` with every `artifactId`. `src/server/server.ts:272` serves it as `{ artifacts: viewArtifactCatalog(dir), notes }` with no truncation. The browser at `src/server/client/app.tsx:935` does `artifacts[artifacts.length - 1]` and renders only that. The Introduction defect 1 is accurately described. **Rung 2 — pointed at code** (`conversation-host.ts:420`, `server.ts:300`, `app.tsx:935`). Rung 4 would require running a two-artifact record through the server and observing the payload; not run in this sandbox, so stopped at 2.

### 2. An unrecognised `src` is carried rather than dropped (RFC-04 P1), justifying `artifact-meta` with no version bump

**Holds in mechanism, fails in justification.** The fold does carry an envelope-valid entry whose `src` this build does not know. `src/store/log.ts:104` defines `validEntry` as `v===1 && at safe-int >=0 && src string`; `src/store/log.ts:119` defines `knownEntry` as `ENTRY_SOURCES includes src`; `src/store/log.ts:521` and `:641` branch on `knownEntry(parsed)` and count bytes good without calling `applyEntry` when unknown. An `artifact-meta` entry with `{v:1, at, src:"artifact-meta"}` would be carried, not `corrupt-log`, after P1. **However** the RFC's analogy at Data model — "the same property that let `basedOn` and `values` be added to the artifact entry" — is false. `basedOn`/`values` are additive *fields on a known src* (`artifact`). `src/store/log.ts:184` shows `coerceArtifactEntry` ignores absent additive fields and the fold ignores what it does not name; no unknown-src tolerance was needed. The new entry is additive *vocabulary*, the old ones were additive *payload*. Using one to justify the other's compatibility claim is a conflation. No version bump is still defensible, but not for the reason stated. **Rung 2 — pointed at code** (`log.ts:91-122`, `log.ts:171-216`, `log.ts:481` comment, `log.ts:521`). Rung 4 would be a one-line `foldLog` with an `artifact-meta` envelope; not run — stopped at 2 and the ladder requires saying so.

### 3. `artifactId` is identity in `replaces` and in every annotation batch, which is why rename writes a title instead

**Holds.** `src/protocol/artifacts.ts:49` header is `{id, replaces, contentType}` where `id` is the `artifactId` reused to revise; `src/protocol/annotations.ts:79` batch carries `artifactId` and `version`; `src/store/log.ts:74` artifact entry carries `artifactId` and `version`. `src/server/server.ts:348` save path keys on `artifactId` and increments version; `src/server/server.ts:282` groups notes by `` `${batch.artifactId}@${batch.version}` ``. Changing `artifactId` would orphan notes and break `replaces`. The rejected alternative is correctly rejected. **Rung 2 — pointed at code** (`artifacts.ts:49`, `annotations.ts:79`, `log.ts:74`, `server.ts:348`).

### 4. R6/R7 make old versions read-only in the page while requiring the save endpoint to keep tolerating a stale `basedOn` — coherent, and reversibility argument sound?

**Mechanically coherent, reversibility argument is weak and creates a deferred inconsistency.** The page guard and the server tolerance can co-exist: `src/server/server.ts:383-415` already accepts a stale `basedOn` and returns `supersededSince: b.basedOn !== current` — R6 codifies existing behaviour, it does not add it. Error Handling `E-ART-03` correctly names the case where a client that should have been prevented still posts. **But** the RFC's reversibility claim — "Removing the endpoint's tolerance would make this RFC's decision irreversible" — is inverted as stated. Keeping tolerance does preserve the option to relax the page later, but it also preserves the option for any old or malicious client to write a stale-base save that the page claims is impossible. The "decision stays in the page" framing hides that the server's permissiveness is itself a policy: once clients rely on refusal, relaxing to acceptance is breaking in the opposite direction. The RFC never specifies whether `E-ART-03` is a success (append + `supersededSince`) or a refusal — it says both "accepts it and reports supersededSince" and "the page treats the response as a defect in itself." Which party reports what to whom is underspecified. **Rung 2 — pointed at code** (`server.ts:391-415`, `log.ts:80` `basedOn` comment).

### 5. R4's resize rule: conversation grip absorbs evenly across both artifact panes

**Underspecified for the shape it governs.** The two-grip description is exact for the two-pane case, but:

- With one artifact pane, the "grip between the artifact panes and the conversation pane" still exists, but "absorb evenly across both artifact panes" has no meaning — does it absorb across one? The single-pane case is never defined.
- "Every pane MUST keep a minimum width, and a drag MUST stop at it" never states the minimums. `src/server/client/layout.ts` today defines `CONVERSATION_MIN`/`MAX` and `clampConversationWidth`; artifact pane minima do not exist in code, so implementers will invent them.
- "Widths MUST persist across a reload, as the conversation width already does" — `src/server/client/layout.ts` persists conversation width via `readConversationWidth`/`writeConversationWidth` (localStorage). No such store is named for artifact widths, and with two panes plus a conversation pane the persisted shape is three values with an invariant (sum = viewport), not one.

The rule is therefore not implementable without invention. **Rung 2 — pointed at code and spec gap** (`app.tsx:48-54` layout import, `07.rfc.md: R4`, `07.rfc.md: R3`).

### 6. State machine covers LIVE, VIEWING_OLD, COMPARING — any reachable state missing, does Error Handling cover every named state?

**Missing states and mismatched error coverage.** The machine at `07.rfc.md: State Machine` is defined "One artifact pane, with respect to which version it shows." With two panes (`R3`), the reachable product is 3×3 = 9 joint states (e.g., left LIVE + right VIEWING_OLD). The RFC never says whether panes share a viewing state or are independent; `R3` says "Document mode is shared. One mode governs both," but that is about `use`/`markup`, not about viewed version. A comparison is defined per artifact (`R9` says comparing two versions of *one* artifact) — can two panes each be in COMPARING simultaneously? Unspecified.

Error Handling names seven errors; at least three have no state to land in:

- `E-ART-01 unknown-artifact` and `E-ART-02 artifact-retired` describe what the URL does when naming a missing/retired artifact, but the state machine has no `UNKNOWN` or `RETIRED` state — the page is said to "render with a message" but no transition leads there.
- `E-ART-05 restore-of-current` is a server refusal that can happen from LIVE (the only state that permits restore, per R8, but R8 permits it from VIEWING_OLD only — so how does it arise?).

Conversely, the machine names `COMPARING` but no error row covers a failure inside a comparison (e.g., bytes unreadable for one side, `E-ART-??`). The `LIVE -> COMPARING` transition is allowed even when there is only one version — then comparison is vacuous, not prohibited. **Rung 2 — pointed at spec** (`07.rfc.md: State Machine` vs `07.rfc.md: Error Handling`).

### 7. Artifact bytes are contained by the sandboxed frame and a title is not

**Holds.** `src/server/client/app.tsx:342-353` comment and `src/server/client/app.tsx:578` element `sandbox="allow-scripts"` — no `allow-same-origin`. The comment is explicit: without `allow-same-origin` the frame is an opaque origin, `allow-scripts` alone is safe because the two together would not be. Parent checks `e.source !== frame.contentWindow` at `app.tsx:427` and validates `FRAME_MESSAGE_SOURCE`. Artifact `bytes` go via `srcdoc` and fetch nothing (`app.tsx:345`). A `title` per `R11`/`Security Considerations` renders in chrome outside that frame — `title MUST be rendered as text` and `MUST NOT be interpreted as HTML`. The containment claim matches the code; the title exposure claim is therefore correctly flagged as the one new chrome-side injection surface. **Rung 2 — pointed at code** (`app.tsx:347`, `app.tsx:578`, `app.tsx:422`).

---

## Findings

Each finding cites where in the RFC it lands, what is wrong, why it matters, and its rung.

### F-01 — Data model conflates two compatibility mechanisms

**Lands in:** `Data model` (paragraph beginning "A new entry source is added").

**What is wrong:** The RFC says RFC-04 P1's unknown-src tolerance "is the same property that let `basedOn` and `values` be added to the artifact entry." `basedOn`/`values` were optional fields on the *same* `artifact` src; `src/store/log.ts:182-214` shows they are additive payload tolerated by `coerceArtifactEntry` ignoring what it does not name. `artifact-meta` is a new `src`. Those are different gates (`validEntry` vs field-optional). The sentence is a false analogy, even though the conclusion (no version bump) is separately defensible via P1.

**Why it matters:** A reader reasoning from the analogy will believe any additive field and any new src have the same deploy ordering. They do not. A reader built before P1 still throws on a new src (`corrupt-log`), but tolerates a new field on a known src. The prerequisites section duplicates RFC-04's one-way compatibility warning but then leans on the conflated claim to argue the change is safe.

**Rung:** 2 — pointed at code (`log.ts:91-122`, `log.ts:171-216`).

### F-02 — Endpoints drift from the codebase: title/retired, restore, meta, and catalog shape

**Lands in:** `Endpoints` table and `Data model` last bullet, `R2`, `R8`, `R11`, `R12`.

**What is wrong:** The table says `GET /api/conversations/:id/artifacts` "MUST also return each artifact's title and retired flag," `POST .../restore` and `POST .../meta` exist with defined bodies. Today `src/server/server.ts:271-307` returns `viewArtifactCatalog` which at `src/store/conversation-host.ts:420` produces `{artifactId, versions, latest, authors}` — no `title`, no `retired`. No restore or meta route exists; `src/server/server.ts:312` and `:347` are the only artifact routes. The catalog's shape change is not additive — clients polling today will get the same shape, but the spec's clients will expect new fields that never arrive, and the new POST routes will 404.

**Why it matters:** This is spec-code drift on the primary integration seam. An implementer following code will ship a browser that renders `artifactId` as title and never hides retired; an implementer following spec will write a client that breaks against the live server. Drift compounds across R2/R11/R12 which all depend on those fields.

**Rung:** 2 — pointed at code (`server.ts:271-420`, `conversation-host.ts:420-451`). Not run against a live server — stopped at 2.

### F-03 — R1 routing has no server or client counterpart

**Lands in:** `R1 - The URL names the artifact` and `Security Considerations` (`artifactId` in the URL).

**What is wrong:** R1 mandates `GET /c/:conversationId/:artifactId/:version` serving the page, validation of `artifactId` "on the same terms as `conversationId` before it reaches the filesystem," and `history.pushState` updates without navigation. `src/server/server.ts:133` routes only `routes: { "/c/:id": index }`; `src/server/client/app.tsx:88` parses only `^\/c\/([^/]+)\/?$`. No artifact segment is read, no validation of `artifactId` occurs before `join(dir, ...)`, and no filesystem joinder uses `artifactId` today. The security requirement about `artifactId` reaching the filesystem is therefore vacuously satisfied — there is no path that does.

**Why it matters:** Linkability and validation are load-bearing for the security claim. A post-RFC implementation that naively joins a URL `artifactId` into a filesystem path without the promised validation reintroduces directory traversal. The RFC's claim that R1 "preserves today's behaviour for one artifact" cannot be verified because today's code has no R1 to preserve — it always shows the last artifact by recency, not by URL.

**Rung:** 2 — pointed at code (`server.ts:133`, `app.tsx:88`, `server.ts:274-307`).

### F-04 — R4 is underspecified for the one-pane case, minima, and persistence

**Lands in:** `R4 - How the grips resize`.

**What is wrong:** (a) With one artifact pane only one grip exists, but the spec says the conversation grip "MUST absorb the change evenly across both artifact panes" — undefined for one. (b) "Every pane MUST keep a minimum width" never states the widths. Today only conversation clamps exist (`src/server/client/layout.ts: CONVERSATION_MIN/MAX`); artifact minima must be invented. (c) "Widths MUST persist across a reload, as the conversation width already does" names no store for two artifact widths plus the conversation width, and no invariant for viewports narrower than the sum of minima.

**Why it matters:** Two implementers will produce different clamping and different persisted shapes, and both will satisfy the spec. The review cannot verify correct behaviour without a number, and the one-pane branch will be guessed.

**Rung:** 1 — asserted from spec text and absence of code. Could reach 2 by pointing at `layout.ts` minima, but the gap is the missing spec, not a code pointer.

### F-05 — R2's list promise conflicts with R12's retired handling

**Lands in:** `R2` vs `R12`.

**What is wrong:** R2: "The page MUST list every artifact in the record that is not retired." R12: "The artifact list SHOULD say how many artifacts are retired and offer revealing them." If retired artifacts are revealed, are they listed? R2 says no, R12 says offer revealing them — the condition under which a retired entry re-enters the R2 list is never stated (filter vs separate section). Also R12: "Retiring MUST be reversible ... The page for a retired artifact MUST offer un-retiring it. A person who can reach the URL can bring it back." But R1 says a URL naming a retired artifact "MUST say it was retired rather than behaving as though it never existed" — that page is the *only* path to un-retire, yet R12 also says the list should offer revealing retired — two recovery paths with no priority.

**Why it matters:** The list is the primary discovery surface. Ambiguity about whether retired entries live in the same list, a separate collapsed section, or only via URL determines whether `E-ART-02` is a recovery path or a dead end.

**Rung:** 1 — asserted from normative text contradiction. No code to point at because the feature does not exist.

### F-06 — State machine vs error handling vs data model mismatch on `artifact-meta`

**Lands in:** `State Machine`, `Error Handling` (`E-ART-06`), `Data model` ("An entry naming an artifact with no version entries MUST be ignored").

**What is wrong:** The data model says an `artifact-meta` entry for an unknown artifact "MUST be ignored rather than creating one" and "MUST NOT be reduced into ChannelState." Error Handling `E-ART-06 meta-for-unknown-artifact` (warning) says "the fold ignores it. It MUST NOT create an artifact." But the Endpoints table for `POST .../meta` never defines what the server does when `artifactId` is unknown — does it 404, append and let the fold ignore, or refuse? The state machine has no `IGNORED` or `WARNING` state; the only way to observe `E-ART-06` is to write an entry and then see nothing happen, which is indistinguishable from success. The spec simultaneously says `artifactId MUST be present and MUST match an artifact the record holds` (data model) and that a non-matching entry is a warning, not a corrupt log — the MUST is therefore not enforced at the fold, only at the POST.

**Why it matters:** Implementers must choose between validating at the API (refuse) or at the fold (ignore). One logs a warning, the other returns 4xx. Both satisfy different sentences of the same section.

**Rung:** 2 — pointed at spec (`Data model` bullets, `Endpoints` POST .../meta, `E-ART-06`).

### F-07 — `title` length bound is normative with no value and no client enforcement

**Lands in:** `Data model` ("MUST be bounded in length"), `R11`, `E-ART-07 title-too-large`, `Security Considerations`.

**What is wrong:** Title is optional string, "MUST be bounded in length" at the data model, and `E-ART-07` says a title exceeding the bound is refused with nothing appended. No bound is stated (bytes? chars? 128 like `artifactId`? 1M like bytes?). `src/store/log.ts:160` bounds `artifactId` at `<=128, no control chars`; title has no such `isArtifactField` equivalent in spec. The security section adds "MUST be truncated for display rather than allowed to push controls off screen" — a second, display-side bound with no value either.

**Why it matters:** Without a number, the server cannot enforce and the client cannot validate. A long title becomes the XSS-adjacent chrome injection the security section warns about. Two servers with different bounds will disagree on whether a record is valid.

**Rung:** 1 — asserted from missing normative value. Could reach 2 by pointing at `log.ts:158-162` for the existing 128 bound on neighboring fields, but the absence is the point.

### F-08 — R6's reversibility argument misstates the failure mode

**Lands in:** `R6 - A version that is not current is read-only` (last two bullets).

**What is wrong:** The RFC says the endpoint *must* stay tolerant so R6 "stays a decision about the page and not a change to the record" and "Removing the endpoint's tolerance would make this RFC's decision irreversible." In reality, tolerance is what makes the page's decision *unenforceable*. With tolerance, any client — old browser, `curl`, or the agent via a future tool — can still append a stale-base save that the page claims is forbidden. Removing tolerance would make the record *enforce* the page's policy, not make it irreversible. The argument conflates "reversible in spec" with "reversible in deployment" and ignores that `supersededSince` already leaks the stale-base information to clients that ignore the page.

**Why it matters:** If the intent is truly page-only, the server should enforce nothing and `E-ART-03` is informational. If the intent is record integrity, the server should refuse. The RFC wants both — a tolerant record with an intolerant page — and justifies it with an irreversibility claim that does not hold after any client ships.

**Rung:** 1 — asserted from reasoning about normative text. The tolerant code at `server.ts:391-415` is rung 2, but the argument's soundness is not a code pointer.

### F-09 — R3 + R10 + `INPUT_QUEUE_MAX` interaction is unspecified

**Lands in:** `R3 - Two artifact panes at most`, `R10 - The note queue is bounded`, `R3` shared mode.

**What is wrong:** Each pane has its own queue, bound 20 (`R10`). Each queue "still goes as one input" (`R10` last bullet, citing RFC-06). With two panes, a person can queue 20 against artifact A and 20 against B and send either — that is two inputs, not one, each counting against `INPUT_QUEUE_MAX` (RFC-04's in-flight bound). The RFC never says whether sending from one pane blocks the other's queue, whether both can be sent in one turn, or whether `Send ⌘⏎` sends the focused pane's queue only. `R3` says "One conversation, whichever artifact a note or a save came from" — that is about record membership, not about input ordering or bound accounting.

**Why it matters:** The unbounded-queue defect the RFC claims to fix is only half-fixed: two bounded queues can still double the input pressure and the agent's next `replaces` is ambiguous when two artifacts have pending notes at once.

**Rung:** 1 — asserted from spec composition. No code implements the two-queue model to point at.

### F-10 — Comparison is a view, but its inputs and error handling are absent

**Lands in:** `R9 - Versions can be compared`, `State Machine` (COMPARING), `Error Handling`.

**What is wrong:** R9 says comparison is computed from stored bytes, not rendered frame, is not sent to agent, is not editable. It then specifies side-by-side vs inline by horizontal room, threshold as "width where column becomes too narrow," not device class. No threshold value, no diff algorithm (text diff? DOM diff? unified vs split?), and no error when bytes for one version are unreadable (`artifact-too-large` refusal at `src/store/log.ts:218` means `viewArtifactVersion` can be null even when catalog claims the version exists). The state machine makes `COMPARING -> VIEWING_OLD` on leaving, but no path `COMPARING -> LIVE` or `COMPARING -> RESTORE` — restore is explicitly "leave comparison first," yet R8 says restore appends a copy and follows new current, which from `COMPARING` would require two transitions the machine does not allow in one step.

**Why it matters:** Two implementations will diff differently, threshold differently, and handle missing bytes differently, and both will satisfy the spec. The "MUST NOT be computed from the rendered frame" is the only hard requirement; the rest is visual design delegated without a number, despite `Scope` saying visual design is out of scope.

**Rung:** 1 — asserted from missing normative values.

### F-11 — Introduction scope vs later sections: design pass and terminal rendering

**Lands in:** `Introduction / Scope` vs `R5`, `R9`, `Alternatives Considered`.

**What is wrong:** `Scope` says "Visual design. `CONTEXT.md` records that the browser surface is a prototype and a design pass is expected. This RFC specifies behaviour and the state each control reflects, not how any of it looks." Yet `R5` specifies dropdown vs badge, newest-first, author-vs-person labeling; `R9` specifies side-by-side vs inline columns and threshold wording; `R4` specifies grip behaviour. Those *are* visual/interaction design, not just state. The disclaimer that design is not specified is contradicted by sections that do specify it in feature terms. Separately, `Scope` says "Rendering an artifact in the terminal. Unchanged from RFC-06" — but RFC-06 is not cited for what "unchanged" means for the transcript's artifact stripping; a reader cannot verify.

**Why it matters:** A later design pass will conflict with normative MUSTs on layout that the RFC claims are out of scope. The "prototype not design" claim in `CONTEXT.md` is used to justify deferring design, but the RFC then locks design choices.

**Rung:** 1 — asserted from text contradiction.

### F-12 — Terminology drift with CONTEXT and unused terms

**Lands in:** `Terminology`.

**What is wrong:** The RFC says "Terms defined in `CONTEXT.md` — record, artifact, version, save, annotation batch, note, spot, orphan, document mode, note box, browser surface — carry their meaning." Of those, `orphan` and `note box` never appear again in the normative sections; `spot` appears only in `R3`'s "Selecting in one pane MUST clear the selection in the other" without defining what a spot is in a two-pane context. New terms: `title`, `retired`, `artifact pane`, `conversation pane`, `grip`, `restore` are all used, but `conversation pane` is used only in `R3`/`R4` and never appears in Endpoints or State Machine, so a reader cannot tell whether it has a version state.

**Why it matters:** Small, but the "name things once" rule from `CONTEXT.md` matters for drift. Two terms with no normative use become dead definitions that later RFCs will reuse differently.

**Rung:** 1 — asserted from text search (no code to point at beyond `CONTEXT.md:71-85`).

---

## Cleared

What was checked and found sound, so the next reviewer need not repeat it.

- **One artifact reachable today:** Verified at `app.tsx:935` and `conversation-host.ts:420` — catalog is complete, client picks last. **Rung 2.**
- **Version list not scaling (defect 2):** `app.tsx` header renders one button per version today (checked via search `artifacts\[` and catalog poll vs version fetch split `app.tsx:340` — catalog poll is versions+ids only, version fetch is per-version bytes. The unbounded button row is as described. **Rung 2.**
- **Old version editable/annotatable (defects 3/4):** `app.tsx` has no guard today — selecting/editing/saving is always permitted regardless of viewed version; annotation batch at `annotations.ts:79` carries `artifactId` + `version` and server at `server.ts:348` records `basedOn` but never refuses stale `basedOn`. Defects are real. **Rung 2.**
- **No compare, no restore (defect 5):** No compare or restore code exists; artifact is append-only via `src/store/log.ts:218` `ArtifactRefusal` and `server.ts:348` `writeArtifact`. Defect is real. **Rung 2.**
- **Queue unbounded (defect 6):** `app.tsx` queue is `pending: readonly PendingNote[]` with no bound check; `R10` 20-bound is new and not yet enforced — defect is real. **Rung 2.**
- **No declared relationship between artifacts — siblings:** Matches `CONTEXT.md: What is not built — More than one document at a time. The newest ... is the one shown` and `annotations.ts:79` batch names one `artifactId` and one `version`. Out-of-scope exclusion is consistent. **Rung 2.**
- **Log is append-only, retire is tombstone, restore is copy-append:** Consistent with `log.ts:481` fold comment "never rewritten" and `server.ts:383` "There is no branching: a save based on a version ... still appends at the end." **Rung 2.**
- **No mutation of `artifactId`:** `isArtifactField` at `log.ts:160` (`<=128, no control chars`) and `store/conversation-host.ts` indexing on `artifactKey` (`\0` join) make `artifactId` the stable key; rename via title is the correct seam. **Rung 2.**
- **`composeArtifactState` and `[lucid artifact state]` block:** At `artifacts.ts:247` `composeArtifactState` carries `artifactId`, `version`, `author`, `basedOn`, `values` — the agent learns about saves/retires via that block, as R8 and the retired-data paragraph claim. Shape matches. **Rung 2.**
- **Sandbox without `allow-same-origin` — artifact bytes contained:** At `app.tsx:578` `sandbox="allow-scripts"` and `app.tsx:347` comment, the containment model is correctly stated. **Rung 2.**
- **Text-in-chrome risk for title:** The RFC correctly identifies that `title` renders outside the frame and therefore `MUST be rendered as text` and `MUST NOT be used to build URL/selector/path` at `Security Considerations`. That is a genuine new exposure. **Rung 2.**
- **`artifactId` validation before filesystem use:** Stated as MUST in `R1` and `Security Considerations`; today `validConversationId` at `server.ts:169` guards `conversationId`, and the same validation will be needed for `artifactId` when R1 lands. The requirement itself is sound. **Rung 2.**

## Not reviewed

- **Ticket lineage (`#59` → `#60-69`) and wayfinder map decisions:** Shell and `gh` were denied by the sandbox (`EPERM` on `mkdtemp` in prior reviews, same here). Whether the RFC accurately renders ticket #61's entry shape or #67's encoding strip is reported as not verified. This is a gap, not an absence of problems.
- **Performance of catalog + per-version seeks:** `viewArtifactCatalog` at `conversation-host.ts:420` re-reads the log and calls `readArtifactVersion` per version per artifact to fill `authors`. Cost with 100 versions × N artifacts was not measured; no budget is stated.
- **Diff algorithm for R9:** No implementation exists to review; whether text diff vs DOM diff vs snapshot diff is intended is not specified, so no choice was checked.
- **Browser layout persistence and responsive threshold numbers:** `layout.ts` was read for `CONVERSATION_MIN/MAX` but artifact pane minima and the comparison threshold width do not exist to point at; they are reported as missing above rather than verified.
- **Live delivery cursor interaction with new entry sources:** `src/store/log.ts:230` `CursorEntry` and `scanCursor` were read for envelope shape, but the cursor's ordering with `artifact-meta` (whether a meta entry is in the effect-collection range) was not traced end-to-end because the meta entry does not produce effects.
- **Running-system verification (Rung 5):** No browser was launched, no `bun run check` was executed, no `foldLog` synthetic log was folded in-process. Every finding that could reach Rung 4 states that it stopped at 2; no claim is presented as Rung 4 or 5.

---

*Validator verbatim as required — see Structural results. All file:line citations are against `main` at review time. Rungs are per `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`; no finding is inflated beyond its evidence.*
