<!-- Cross-family review of RFC-08, Draft 2026-08-26.
     Reviewer: muse-spark-1.2-contributor@muse, effort high, read-only.
     Routed by choose-model excluding the claude family, which wrote the RFC.
     The registry warned that no non-claude route meets the high-stakes
     minimums for `plan`.

     It could not read ~/.lucid2/records/demo, so the measured byte counts
     were supplied in the brief and it checked them for internal consistency
     rather than against the record. It says so per claim. Verbatim. -->

# Review: RFC-08 — Revising an artifact without retyping it

## What was reviewed

- **RFC path:** `docs/rfc/08_revising-an-artifact-without-retyping-it.rfc.md`
- **Version:** Draft, dated `2026-08-26` (frontmatter `number: 08`, `type: protocol`, `status: Draft`)
- **Status at review:** Draft, not implemented. Cross-family review, read-only, no edits or commits. Reviewer is `muse-spark` (Meta), disagreeing stance as instructed.
- **Read before writing:** `CONTEXT.md`, `docs/rfc/06_an-artifact-you-can-address.rfc.md`, `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.rfc.md` and its review at `docs/rfc/07_many-artifacts-in-one-record-and-the-history-you-can-move-through.review-draft-2026-08-26.md`, `src/protocol/artifacts.ts` (`ARTIFACT_PREAMBLE`, `ArtifactHeader`, `detectArtifactBlocks`, `composeArtifactPrompt`, `composeArtifactState`), `src/modes/host.ts` (`handleArtifactMessage`, `artifactState`, session `sendNow` preamble logic), `src/store/log.ts` (`ARTIFACT_BYTES_MAX`, `LogEntry` artifact shape, `hashArtifactBytes`, `coerceArtifactEntry`, `foldLog` unknown-src tolerance), `src/store/conversation-host.ts` (`writeArtifact`, `artifactIndex`, `readArtifact`), `~/dev/lucid/src/core/session.ts` (`commitIfChanged`, `baseline: "snapshot" | "cache"`), `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. Shell and `npx` were denied by sandbox (see Structural results). `~/.lucid2/records/demo` was not readable in this sandbox; arithmetic checked for internal consistency only.

## Structural results

Validator `npx tsx ~/.claude/skills/draft-rfc/scripts/validate-structure.ts <rfc>` was requested verbatim as required.

**Not run.** The sandbox denies shell execution (`bash`, `bash_input` denied). No structural validator output can be reported. The prior RFC-07 review reported the same denial and stopped at rung 2; this review does the same. The RFC's frontmatter and headings appear well-formed on inspection, but that is not a validator verdict. **Rung 1 — asserted, not run.**

## Measured claims — verdicts

All numbers below derive from the RFC's table and the prompt's byte list. No independent read of `~/.lucid2/records/demo` was possible; the check is for internal consistency and whether the conclusion follows.

Given bytes per version v1 6476, v2 6541, v3 8719, v4 12763, v5 14300, v6 14324, v7 14357, v8 16373, v9 18007, v10 19792, v11 23922, v12 26791, v13 27183. Authors: v2, v6, v7 human; rest agent. Tokens at 4 bytes/token.

### Claim: 10 agent emissions total 43,581 output tokens

**Holds arithmetically.** Agent versions are v1, v3, v4, v5, v8, v9, v10, v11, v12, v13 (10 versions; v2/v6/v7 are the three human saves). Sum = 6476+8719+12763+14300+16373+18007+19792+23922+26791+27183 = 174,326 bytes. /4 = 43,581.5, truncated to 43,581 as stated. **Rung 2 — pointed at table and recomputed sum.** Whether each byte count is true to the demo record is unverified (rung 1 for source data; rung 2 for arithmetic).

### Claim: the same 43,581 is also the accumulated context, because a headless-session driver keeps one harness session and every prior emission stays in window

**Unsupported as stated; weaker conclusion holds.** In `headless-session`, `src/modes/host.ts:sessionStrategy` keeps one harness session and each input's prompt is sent via `session.send` into that same session's context window. Prior assistant emissions remain in the session's history, so output bytes do accumulate. But context is not *equal* to output total: it also contains system prompts, the artifact preamble (`src/protocol/artifacts.ts:ARTIFACT_PREAMBLE`), the per-turn `[lucid artifact state]` block (`composeArtifactState`), user inputs / annotation batches, and the model's own reasoning tokens. The RFC's table equates "output across 10 agent revisions" with "context those emissions occupy by the last revision" and drops every other contributor. The asymptote `O(revisions x document)` is directionally correct, but the equality is a simplification that understates context (inputs make it larger) and overstates the patch's share of context (patches do not eliminate the human-save resends or preamble). The 43,581 figure is a lower bound on context from emissions alone, not the context.

**Rung 2 — pointed at code (`host.ts:337-362` preamble once per session, `host.ts:61-92` artifactState resent per non-answer input) and arithmetic.**

### Claim: a patch costs ~2048 bytes, so 10 revisions cost 5,120 output tokens, a 9x reduction

**Arithmetic holds given the premise; premise is an assumption, not a measurement.** 2048 bytes /4 = 512 tokens per patch. x10 = 5,120 tokens. 43,581 / 5,120 = 8.51x, rounded to "9x" in the RFC. The 2048-byte figure is stipulated ("a patch costs ~2048 bytes") with no derivation from demo documents, no distribution of edit counts, and no fence/header overhead counted (the `lucid-artifact` fence, header JSON with `form:patch`, and `{"edits":[...]}` wrapper are themselves bytes that count toward output tokens). If a typical edit anchor is a full HTML line (often 80-200 bytes) plus replacement, two edits can already exceed 2048. The reduction is real but the "9x" is the top of a range whose bottom is lower.

**Rung 1 — asserted from RFC text; arithmetic rung 2, premise rung 1.**

### Claim: patch-form context is 15,544 tokens = first emission + 10 patches + the three human saves resent in full

**Internally inconsistent with the RFC's own "never resend" premise and unsupported.** First emission v1 = 6476/4 = 1,619 tokens. 10 patches at 512 = 5,120. Three human saves resent in full: v2 6541 + v6 14324 + v7 14357 = 35,222 bytes /4 = 8,805 tokens. Sum = 1,619+5,120+8,805 = 15,544 — arithmetic matches. But two problems:

1. There are 9 patch revisions after v1, not 10, if first emission is counted separately (v1 is already one of the 10 agent emissions). Counting v1 + 10 patches double-counts one emission. If the intent is "v1 whole + 9 subsequent patches", patch tokens should be 9*512=4,608 and total 15,032.
2. More importantly, the model `first emission + patches + human saves resent` contradicts the RFC's own Open Question 1 premise that context saving "rests on the agent anchoring from its own context" without resending the document each turn. `composeArtifactState` (`src/protocol/artifacts.ts:256-297` and `src/modes/host.ts:61-92`) resends only `artifactId`, `version`, `author`, `basedOn`, `values`, and for human saves the bytes *once* as `[lucid artifact state]` — not the full document for agent versions. The RFC's patch-context model instead assumes human saves are resent *in full* every turn (8,805 tokens counted once), but `composeArtifactState` actually resends human-save bytes on *every* non-answer `sendNow` until overwritten. Over 10 turns that is up to 10*8,805 context, not 1*8,805. The 15,544 figure is a single-count sum of distinct bytes, not a harness-session context-window sum. The comparison "43,581 vs 15,544 = 2.8x saving" mixes two different accounting methods.

**Rung 2 — recomputed from RFC's numbers and pointed at `artifacts.ts:256` / `host.ts:362`.**

### Claim: the 127s wall clock for v12 is consistent with ~6,700 output tokens

**Plausible but unsupported and not sufficient to support the conclusion drawn.** v12 is 26,791 bytes /4 = 6,697 tokens, matching "~6,700". At typical hosted-model output rates of 50-90 tokens/s, 6,700 tokens takes 75-135s, so 127s is within range. But wall clock also includes time-to-first-token, reasoning, tool formatting, and harness streaming overhead (`harness` via `hcn` `openSession`/`session.send` in `host.ts:311-319`). No breakdown is given, and the RFC draws the stronger conclusion "It is the agent retyping what it is not changing" — that the *entire* 127s is retyping cost. Without a control (e.g., v12 patch prompt that changes one sentence and returns in ~20s), the attribution is an inference, not a measurement. The latency-growth claim is credible, the retyping-causation claim is not proven by timing alone.

**Rung 1 — asserted timing, rung 2 for token conversion, no code trace for timing.**

## Verdicts on the eight specified claims

### 1. "The patch is transport, never storage" — does appending the applied result leave the record shape unchanged?

**Largely holds, with two gaps.**

For `hash`, `author`, `basedOn`, `index`, and `restore`, the RFC's design does keep the record shape unchanged *if* implemented as described (apply in memory, then `writeArtifact` with `bytes = result`):

- **Hash:** `src/store/log.ts:153-155` `hashArtifactBytes` is `sha256(bytes)`. `src/store/conversation-host.ts:196-206` `writeArtifact` computes the hash over the passed `bytes` and stores it. A patch result hashed the same way is indistinguishable from a whole-form version. **Rung 2 — pointed at code.**
- **Author:** Both forms are agent emissions; `handleArtifactMessage` (`src/modes/host.ts:161-268`) passes `author: "agent"` regardless of body. No new author appears. **Rung 2.**
- **basedOn:** Agent emissions today carry no `basedOn` (`src/store/log.ts:80-88` comment: present on save, absent on agent emission). A patch revision also carries none, even though it names `replaces`. The durable shape is identical; the information "which version was replaced" is not stored for agent versions in either form — that is existing behavior, not a new omission. **Rung 2.**
- **Index:** `src/store/log.ts` `artifactIndex` is `Map<artifactKey(artifactId,version), offset>` built by folding artifact entries. Any entry appended via `writeArtifact` is indexed; transport choice is invisible. **Rung 2.**
- **Restore:** RFC-07 R8 is `readArtifact` of the chosen version plus `writeArtifact` with `author: "human"`, `basedOn: restored version`. It reads via `viewArtifactVersion` / `readArtifactVersion`, which dereferences the index and hash — no patch metadata to follow. Unaffected. **Rung 2.**

Gaps:

- **Version assignment race for two blocks in one message.** `handleArtifactMessage` maintains `localVersions` (`host.ts:171,218-219`) so the second block may name `replaces` equal to the version the first block just appended, without hitting the durable index. R3 step 1 ("Read the version named by `replaces`") must read from the same `localVersions` buffer if `replaces` equals the first block's output, otherwise the second patch would read stale bytes and apply to the wrong base. The state machine notes "The second MAY name the version the first produced" but Implementation Notes step 4 says "reads the version named by `replaces`" without mentioning the local buffer. An implementer following the text will read from the durable `artifactIndex` and miss the in-message dependency.
- **`version` and `at` still assigned by lucid.** The RFC says "same entry, same hash over the same kind of bytes" — true, but the entry's `version` and `at` (log timestamp) will differ from any whole-form re-emission that produced the same bytes via a different patch. That is not a shape change, but it is observable (ordering, `afterSeq`).

Overall the transport/storage split is sound and is the best part of the design.

### 2. Exactly-once literal matching — is refusing on zero and multiple matches right? What does it cost?

**Refusal policy is correct for safety; cost is understated.**

- **Security and correctness:** Literal byte matching (`find` compared as bytes, no regex) plus exactly-once refusal avoids ReDoS (`Security Considerations` first bullet) and avoids silent mis-application. This mirrors RFC-06 annotation anchoring ("a spot that cannot be found exactly is reported as lost rather than guessed"). Refusing ambiguity is the right default for a store that never rewrites. **Rung 2 — pointed at `artifacts.ts` literal path and `host.ts` error handling.**
- **Cost:** The RFC's examples use anchors like `"<li>Read the brief</li>"` and `"</ul>"`. The latter appears once per list but many documents contain repeated boilerplate: `</div>`, `</section>`, `class="card"`, `</li>`, `<hr>` etc. Any such anchor matches multiple times and is refused as `E-PATCH-03`. The agent must lengthen the anchor to include unique surrounding context that it must itself predict correctly. For a 27 KB HTML document, reliable single-occurrence anchors are often 100-300 bytes. A legitimate multi-location edit (e.g., rename a repeated label) cannot be done in one `find`; it needs one edit per occurrence, each with a distinct wide anchor, or must fall back to whole form per R5. The RFC acknowledges `E-PATCH-02` but frames `E-PATCH-03` as "lengthens the anchor and retries" — a single retry, not a potential cascade of broadening attempts. The cost model (`~2048 bytes` per patch) assumes one or two narrow anchors; ambiguous anchors break that model.
- **Missing guidance:** No mention of overlapping finds, of `find` that is a substring of `replace` (self-matching on re-application), or of the agent's need to escape JSON strings that themselves contain quotes/newlines.

The policy is defensible; the RFC should be explicit that exactly-once trades throughput for safety and that whole-form fallback is the expected path for repetitive changes.

### 3. Edits applied in order, each against the previous result — interaction with exactly-once

**Holds as specified but creates a failure mode the RFC does not discuss.**

R2 says "Edits MUST be applied in order, each against the result of the one before it. So a later edit MAY anchor on text an earlier edit introduced." This is intentional sequential semantics.

Interaction hazards:

- **Later anchor broken by earlier edit:** Edit 1 modifies a region that contains the text edit 2's `find` was meant to match in the original. Against the running result, edit 2 now matches zero (`E-PATCH-02`) though it would have matched once against the named version. The agent must order edits to avoid this, but the spec gives no rule (e.g., apply against original with non-overlapping constraint, or require edits to be order-independent).
- **Later anchor made ambiguous by earlier edit:** Edit 1 inserts text that duplicates a substring that edit 2 intended to match uniquely. Edit 2 now matches twice against the running result, refused as `E-PATCH-03`, though it was unambiguous against the original version. This is not a contrived case; inserting a list item containing `"</ul>"` then trying to match `"</ul>"` is an example drawn from the RFC's own sample.
- **Silent wrong-target:** If edit 2's `find` still matches once after edit 1, but at a different location than intended (because edit 1 shifted bytes), the patch applies "successfully" to the wrong place. Exactly-once does not protect against this.

Atomicity (R4: all-or-nothing) mitigates corruption but not confusion: the agent receives `E-PATCH-02`/`03` naming the failing edit index, but cannot tell whether the failure is due to ordering vs. stale base vs. wrong anchor width.

Alternatives the RFC rejected ("store the patch and reconstruct on read" and "structural patch") do not address this either. A safer semantics would be to check each `find` against the *original* `replaces` version for exactly-once, then apply all non-overlapping replacements simultaneously, or to forbid a later `find` that matches text introduced by an earlier edit unless explicitly marked. The RFC's choice is workable but the interaction should be specified.

**Rung 2 — pointed at R2/R4 and Security "MUST NOT partially apply".**

### 4. Deploy-order claim — older lucid stores patch body as document, preamble-ships-with-lucid makes ordering safe

**First half true, second half true with a caveat the RFC omits.**

- **Older lucid behavior:** `src/protocol/artifacts.ts:93-154` `parseHeader` extracts `id`, `replaces`, `contentType` and ignores unknown fields. `form` is unknown to an older build, so it is ignored. `bytes` is everything after the header line. A patch body `{"edits":[...]}` would be stored as `bytes` under `contentType: text/html`, hashed, and indexed — a corrupt artifact version that renders as JSON. The RFC's hazard statement is accurate. **Rung 2 — pointed at code.**
- **Preamble coupling:** `src/protocol/artifacts.ts:168-176` `composeArtifactPrompt` and `src/modes/host.ts:337-362` `sendNow` send the artifact preamble once per `headless-session` (guarded by `artifactPreambleSent`) and every turn for `headless-turn`. The preamble ships inside the lucid binary (it is a constant string, not fetched from the harness). So a new lucid knows to apply patches before any agent it starts is told the patch form exists — the safe deploy order is indeed "lucid first." **Rung 2.**
- **Caveat:** For a long-lived `headless-session`, the preamble is sent once when the session opens (`host.ts:340-360`). A session that started on the old lucid will not receive the new preamble until it restarts (next input after a `sessionStrategy` reopen, or a new `openSession`). During the window after lucid upgrades but before the session restarts, the agent still emits whole form, which the new lucid accepts (backward compat holds). So safety is preserved, but the benefit is delayed. Conversely, downgrading lucid after agents have learned the patch form leaves a window where new agents emit patches that an old lucid will corrupt. The RFC's "by construction" is correct for upgrades, not for downgrades/rollbacks, and should name the `headless-session` restart delay.
- **Irreversibility:** A stored patch-body-as-document is permanent (append-only, hashed). There is no `artifact-too-large` or `malformed` guard that would catch it as invalid HTML — `isArtifactField` checks `id`/`contentType`/`author` but not that `bytes` is valid HTML. One such entry pollutes the version history with a JSON document that future `restore` could resurface.

### 5. Size-checking the result rather than the patch — is ARTIFACT_BYTES_MAX at the right point, is reuse accurate?

**Correct placement; reuse claim accurate in effect, slightly inaccurate in mechanism.**

- **Right point:** `src/store/log.ts:137-138` `ARTIFACT_BYTES_MAX = 1_000_000`. `src/modes/host.ts:182-189` checks `bytes.length > ARTIFACT_BYTES_MAX` *before* `writeArtifact`. For a patch, the patch body itself is small; the hazard is `replace` being enormous or duplicating a large region. Checking the patch size would miss this, so checking the applied result before `writeArtifact` is the only correct place. `Security Considerations` bullet "A small patch can produce an arbitrarily large document" is accurate. **Rung 2 — pointed at constants and call site.**
- **Reuse accuracy:** The RFC says `E-PATCH-06` is "Identical in effect to an oversize whole form today, which is what makes this a reused rule." Whole-form oversize today emits `EventKind.error` with `artifact ... too large` and does not append (`host.ts:182-189`); the artifact entry is never written and `writeArtifact` is never called. Patch-result oversize would be refused after `APPLYING` but before `writeArtifact`, also emitting `EventKind.error` and not appending. `src/store/conversation-host.ts:196-206` `writeArtifact` itself also checks size (`artifact-too-large`), but `handleArtifactMessage` checks before calling it — the two layers are redundant, not conflicting. The effect ("nothing appended, reason on the turn") is identical; the issue string would differ slightly (`patch-result-too-large` vs `artifact too large`), but that is cosmetic.

### 6. State machine — reachable, errors land, APPLYING holds no durable state?

**Essentially correct; one transition missing, one error landing ambiguous, APPLYING claim holds.**

Machine as given:

```
ARRIVED -> PARSED / REFUSED (malformed header/body)
PARSED  -> RESOLVED (whole) / APPLYING (patch, readable base) / REFUSED (patch no base)
APPLYING-> RESOLVED / REFUSED (zero or multiple matches)
RESOLVED-> APPENDED / REFUSED (too large or stale replaces)
```

- **Reachability:** All non-terminal states are reachable: whole-form path (`PARSED->RESOLVED->APPENDED`), patch success path (`...->APPLYING->RESOLVED->APPENDED`), each refusal path. No dead state. **Rung 1 — asserted from spec.**
- **Errors landing:** `E-PATCH-01` at `PARSED->REFUSED`, `E-PATCH-04` at `ARRIVED->REFUSED` or `PARSED->REFUSED`, `E-PATCH-05` at `PARSED->REFUSED` or `APPLYING->REFUSED` depending where count bound is checked, `E-PATCH-02/03` at `APPLYING->REFUSED`, `E-PATCH-06` at `RESOLVED->REFUSED`, `E-PATCH-07` at `ARRIVED->REFUSED`. The RFC says "Every one of these refuses before any append. None is terminal for the turn. `replaces` being stale keeps the refusal RFC-06 already defines" — that lands at `RESOLVED->REFUSED` via the existing `header.replaces !== current` check (`host.ts:242-249`). Coverage is complete, but `E-PATCH-05` (too-many-edits) has no explicit transition — the RFC should state whether the bound is checked in `PARSED` (before `APPLYING`) or in `APPLYING`; either way it is `->REFUSED` before `RESOLVED`.

  The "stale `replaces`" refusal is shared between whole and patch, but the spec does not say whether the error code for stale `replaces` on a patch is the existing RFC-06 code or a new `E-PATCH-*`. That should be explicit.

- **APPLYING holds no durable state:** True. `apply` is described as a pure function `(document, edits) -> new document or refusal` with no I/O (`Implementation Notes` steps 2-3). `src/modes/host.ts:161-268` `handleArtifactMessage` does all artifact work synchronously within the turn's message handling, before any `log.append`. A crash during `APPLYING` before `writeArtifact` leaves the log unchanged. Even a crash between two blocks in one message (first APPENDED, second in APPLYING) is handled: `REFUSED` is per-block, not per-message (`host.ts:172-180` continues after malformed). The RFC's note that two blocks walk the machine independently is accurate and important.
- **Unspecified:** What `REFUSED` emits — `host.ts` today emits `EventKind.error` with `terminal: false` (`ctx.sequencer.emit`). The RFC's state machine does not name the emission, but `Error Handling` says "The turn continues: a refused artifact has never ended a turn." That matches.

### 7. Rejected file-watching alternative — is the `commitIfChanged` / `baseline: "snapshot" | "cache"` citation fair?

**Fair reading; the bug is real and the citation is accurate.**

`~/dev/lucid/src/core/session.ts:102-161` was read. `commitIfChanged` (`session.ts:485-512` onward) indeed takes `options: { baseline: "snapshot" | "cache" }`. The branch:

- `snapshot`: compares `hashContent(html)` vs `readSnapshotBytes(...)` (committed history, survives pull, cannot lie).
- `cache`: compares vs `readCurrent` (`current.html`, the serve cache in `run/`).

The comment at `session.ts:475-484` states:

> Not `commitWatchedChange`: that compares against `current.html`, which is a serve cache a refused commit may already have clobbered — exactly the state the old suspend bug left behind (cache == artifact, log still one version back).

And `openSession` (`session.ts:426-432`) explicitly reconciles against the newest committed *snapshot*, not `current.html`, because `current.html` is machine-local and absent on a pull.

The RFC quotes this as `"cache == artifact, log still one version back"` — the file's phrasing is `cache == artifact, log still one version back` (comment) and `The snapshot is committed history and cannot lie that way.` The paraphrase is faithful. The RFC uses it to argue that file + serve cache + log can disagree and that a patch refusal (atomic, at the boundary) avoids that reconcile window. That is a fair characterization: the v1 bug existed, the parameter documents the two-truth problem, and the RFC's rejection of file-watching on those grounds is reasoned, not convenient. Whether the *trade-off* (paying the patch failure mode to avoid the reconcile window) is correct is a product judgment, but the evidence is not misrepresented.

**Rung 2 — pointed at `session.ts:475-512` and its comments.**

### 8. Open Question 1 — is the admission honest enough, is recovery (refuse, resend on refusal) sound?

**Admission is unusually honest; recovery is partially sound but incomplete.**

- **Honesty:** The RFC does not bury the dependence. It states: "The context saving assumes it can write a correct `find` from its own prior emission plus its own patches, without lucid resending the document each turn. If that degrades over a long run, anchors stop matching, `E-PATCH-02` fires, and each failure costs a turn plus a resend — so the modelled 2.8x context saving is the top of a range whose bottom approaches changing nothing." And "What would settle it: the refusal rate over a real conversation of twenty or more revisions. It cannot be settled by reasoning." That is a candid admission that the headline saving is a best case and that measurement is needed before fixing the resend policy. It also lists three resend options without picking one. For a protocol RFC, that is the right stance. **Rung 1 — asserted from text, but the text is explicit.**
- **Recovery as specified:** `E-PATCH-02` says "lucid SHOULD include the current document in the next prompt so the retry is informed." That is the `composeArtifactState` path: for human saves it already includes `bytes` when `author === "human"` and `bytes.length <= ARTIFACT_STATE_BYTES_MAX` (60,000). For agent versions, `artifactState` (`host.ts:61-92`) deliberately omits `bytes` ("The agent wrote its own versions and does not need them read back"). On a patch `E-PATCH-02`, the "current document" is an agent version, so `composeArtifactState` would *not* include it. The RFC's SHOULD would require a new behavior: include the agent's own current document on refusal, which is a change from today's `artifactState`. The RFC does not name that change.
- **Soundness gaps:**
  - A retry after `E-PATCH-02` costs an entire extra turn (the refused turn still consumed model time and context, then the next turn carries the resent document). At a 10-20% refusal rate, the effective output saving drops sharply; at higher rates it approaches zero. The RFC notes this ("top of a range") but does not quantify the breakeven refusal rate.
  - No discussion of `E-PATCH-03` (ambiguous) recovery cost: the agent must guess a longer anchor, which may itself be wrong, causing a second refusal.
  - No idempotence guarantee: retrying the same patch after a resend may produce a different result if the document changed (human save) between attempts — `replaces` would then be stale and the retry refused again.
  - No backoff/bound: a tight loop of `E-PATCH-02 -> resend -> E-PATCH-02` could spin.

The admission is honest enough to act on; the recovery should be specified as a new `composeArtifactState`-on-refusal path with explicit byte inclusion and a bound, rather than a SHOULD.

## Findings

### F-01 — Patch-context arithmetic mixes accounting methods and overstates the 2.8x saving

**Lands in:** `Introduction` table, `Measured on ~/.lucid2/records/demo`, `Open Questions` Q1.

**What is wrong:** The 15,544-token patch-context figure sums distinct bytes once (v1 + 10 patches + 3 human saves), not the harness-session window sum. In `headless-session`, `composeArtifactState` is prepended on every non-answer input (`host.ts:362`), so human-save bytes resend every turn until superseded, and the session history retains all prior user inputs and assistant thinking. The 43,581 context figure is the sum of output bytes only. Comparing them as "2.8x saving" (43,581 / 15,544) conflates a single-count distinct-byte total with a window total and omits the per-turn resend multiplier. The internal arithmetic is correct given the definitions, but the definitions do not match the runtime.

**Why it matters:** The headline saving drives the motivation ("At twenty revisions ... 136,000 tokens"). If the dominant cost is actually the per-turn resend of human saves or the preamble, patch form saves less than claimed, and the trade-off (new failure mode for less saving) looks different.

**Rung:** 2 — recomputed sums, pointed at `artifacts.ts:256` / `host.ts:362`.

### F-02 — Exactly-once forces wide anchors; patch size premise is not measured

**Lands in:** `R2 - What an edit is`, `Security Considerations`, `Measured claims`.

**What is wrong:** The `~2048 bytes` per-patch premise assumes narrow anchors. Exactly-once literal matching on HTML with repeated substrings forces anchors that include surrounding unique context (often 100-300 bytes per edit). The RFC gives no distribution of anchor widths from real records and does not count fence/header/JSON overhead toward the 2048.

**Why it matters:** A patch with 2-3 wide anchors can exceed the budget that yields the 9x/2.8x claim. Cost estimates should be grounded in measured anchor lengths from the demo record's bytes, not a round number.

**Rung:** 1 — asserted from spec and missing measurement.

### F-03 — Sequential edit semantics can make a later anchor ambiguous or wrong-target, not just not-found

**Lands in:** `R2` last bullet, `R4`, `E-PATCH-02`/`03`.

**What is wrong:** Because edits apply against the running result, an earlier edit can (a) duplicate a later edit's `find` (now ambiguous, `E-PATCH-03`), (b) remove it (now not-found), or (c) shift it to a different occurrence that still matches once but at the wrong location (silent wrong-target, no error). The RFC permits "later edit MAY anchor on text an earlier edit introduced" but does not warn about (a)-(c) or give ordering guidance. Atomicity prevents partial apply but not mis-target.

**Why it matters:** The agent must reason about sequential effects; a spec that invites it without naming the hazards will produce patches that refuse for reasons the diagnostics cannot distinguish from stale-document not-found.

**Rung:** 2 — pointed at R2/R4 text.

### F-04 — Two-block message patch dependency on localVersions is not specified

**Lands in:** `State Machine` last bullet, `Implementation Notes` step 4, `R3`.

**What is wrong:** `State Machine` says "Two blocks in one message each walk this machine independently and in order, ... The second MAY name the version the first produced." `Implementation Notes` step 4 says `handleArtifactMessage` "reads the version named by `replaces`" and appends via `writeArtifact`. It does not say that the read must consult the in-message `localVersions` map (`host.ts:171`) before the durable `artifactIndex`. A literal reading implies the second patch reads the durable index, which does not yet contain the first block's version, causing a stale-read refusal.

**Why it matters:** The feature is normative ("MAY name") but the implementation note that makes it work is omitted. An implementer following the text will break the multi-block case.

**Rung:** 2 — pointed at `host.ts:171,218`.

### F-05 — Preamble coupling overstates deploy safety for rollbacks and headless-session restart delay

**Lands in:** `Versioning`.

**What is wrong:** "The preamble ships with lucid, so the two move together by construction" holds for upgrades but not for downgrades, and for `headless-session` the new preamble does not reach an already-running session until it restarts. The RFC does not name either gap or the irreversibility of a stored patch-body-as-document entry.

**Why it matters:** A rollback or a long-lived session straddling a deploy creates a corruption window the RFC claims is impossible "by construction."

**Rung:** 2 — pointed at `artifacts.ts:168` / `host.ts:337`.

### F-06 — `APPLYING` hash/author/index/restore claim omits the `version`/`at` observability and the in-message partial-append case

**Lands in:** `R3`, `Security Considerations` blast radius.

**What is wrong:** The record shape is preserved, but `version` and `at` are assigned fresh by lucid on the applied result, so a patch-result version is not byte-identical to a whole-form re-emission that would have produced the same bytes at a different time — callers that order by `afterSeq` will see a difference. And after a partial message (first block APPENDED, second APPLYING crashes), the record is not "exactly as it was" — it contains the first block's version.

**Why it matters:** Minor, but the RFC's "exactly as it was" and "byte-for-byte the same kind of entry" invite readers to assume idempotence that does not hold across time or partial messages.

**Rung:** 1 — asserted from spec reasoning.

### F-07 — Size reuse and `E-PATCH-06` escalation miss the event-payload bound distinction

**Lands in:** `R3` step 3, `E-PATCH-06`, `Error Handling`.

**What is wrong:** The RFC checks `ARTIFACT_BYTES_MAX` on the result, which is correct. It does not mention that artifact bytes also transit as an `event` payload capped at `TEXT_MAX` / `serializableObject` (RFC-06 B2: the same 1 MB bound). For whole form, the agent's emission hits that bound before `handleArtifactMessage`; for patch, only the small patch body transits as an event, so the payload bound is not a factor — the RFC should note that this is an *additional* saving, not just a reuse.

**Why it matters:** Clarifies why patch form helps even when the document is near the 1 MB limit: the wire event stays small.

**Rung:** 1 — asserted, with `log.ts:137` reference.

### F-08 — Open Question 1 recovery SHOULD is unsound against current `artifactState`

**Lands in:** `E-PATCH-02` recovery, `Open Questions` Q1, `Implementation Notes`.

**What is wrong:** `E-PATCH-02` recovery says "lucid SHOULD include the current document in the next prompt." `composeArtifactState` (`artifacts.ts:278-296`) today includes `bytes` only for `author === "human"` versions. The agent's own current version (the one a patch failed against) is omitted. The SHOULD would require new behavior — include the agent's current document on patch refusal — that the RFC does not call out as a change to `artifactState`. Without it, the retry is still uninformed.

**Why it matters:** The resend policy that the RFC says will be "measured before fixed" cannot be measured until this path exists. The cost of an uninformed retry is another refusal, eroding the saving.

**Rung:** 2 — pointed at `artifacts.ts:278` / `host.ts:61`.

### F-09 — Unknown-fields-on-edit tolerance is not motivated and creates a forward-compat footgun

**Lands in:** `Message Formats` / `The patch body` ("Unknown fields on an edit MUST be ignored...").

**What is wrong:** The RFC requires unknown fields on an edit to be ignored "so a later revision of this format does not break an older reader." But the patch body is never stored (`R3`: "The patch is never stored") and is only read by the current lucid applying it. There is no durable reader of the patch body's shape to keep compatible. Ignoring unknown fields means a future agent can send `{find, replace, mode: "regex"}` and an older lucid will silently ignore `mode` and apply a literal replace the agent meant to be a regex — a silent misinterpretation. Refusing unknown fields would be safer.

**Why it matters:** The tolerance rule is copied from `coerceArtifactEntry`'s additive-field handling for durable artifact entries, where it is correct. For a transient wire format, it is the wrong rule.

**Rung:** 1 — asserted from spec.

### F-10 — No bound named for `find`/`replace` lengths; prompt injection quoting bound also unnamed

**Lands in:** `R2`, `Message Formats`, `Security Considerations` (prompt injection), `E-PATCH-05`.

**What is wrong:** `E-PATCH-05` bounds edit *count* (proposed 50), but `find` and `replace` strings themselves are unbounded except via `ARTIFACT_BYTES_MAX` on the result. A single edit with a 900 KB `replace` is not refused until after it is applied in memory. `Security Considerations` says "Reasons MUST bound how much they quote" but gives no number, and `Error Handling` for `E-PATCH-02`/`03` quotes "the opening of the `find` text ... how many places it matched" with no truncation stated. The RFC needs explicit byte limits on `find`/`replace` and on quoted refusal text.

**Why it matters:** Without them, a small patch can still force a large in-memory allocation before the size check, and a crafted `find` can push a large payload into the next prompt via the refusal reason.

**Rung:** 1 — asserted from missing normative values.

## Cleared

What was checked and found sound, so the next reviewer need not repeat it.

- **Patch hashes and author correctly:** `hashArtifactBytes` over result bytes produces a hash over the bytes a reader gets (RFC-06 invariant "hash is over the bytes a reader gets" at `log.ts:153` and `Alternatives: Store the patch...` rejection). Agent author preserved. **Rung 2 — pointed at `log.ts:153` / `host.ts:223-256`.**
- **Size check on result before append is correct:** Rejects small-patch-large-result (`Security` bullet), reuses `ARTIFACT_BYTES_MAX` correctly. **Rung 2.**
- **Exactly-once before apply, total order, atomic refusal:** Security bullets "Exactly-once MUST be enforced before anything is applied" and "MUST NOT partially apply" match R4 atomicity. **Rung 2.**
- **Whole form remains legal and is the right fallback:** R5 `SHOULD emit whole form when unsure` is the correct safety valve for ambiguous anchors. **Rung 2.**
- **Two blocks in one message independent walk:** Matches current `host.ts:172-180` continue-after-malformed and `localVersions` handling. **Rung 2.**
- **Record unchanged shape (no new src, no migration):** `ENTRY_SOURCES` stays `["frame","input","credit","artifact"]` (`log.ts:91`), no version bump needed, old readers unaffected. **Rung 2.**
- **File-watching citation:** `commitIfChanged` baseline param and `cache == artifact, log one behind` comment verified at `~/dev/lucid/src/core/session.ts:485` and surrounding comments. **Rung 2.**
- **Preamble is not folded, `form` is not folded:** `ARTIFACT_PREAMBLE` (`artifacts.ts:33`) and the `form` header field are pure wire — nothing in `foldLog` or `coerceArtifactEntry` persists them. **Rung 2.**

## Not reviewed

- **Structure validator verbatim:** Shell denied (`bash` / `bash_input` permission denied). Could not run `npx tsx ~/.claude/skills/draft-rfc/scripts/validate-structure.ts` nor the `~/.agents` equivalent. Pattern matches prior RFC-07 review's denial.
- **Byte counts ground truth:** `~/.lucid2/records/demo` bytes per version and author assignments were not independently read (file not reachable in sandbox / would be private data). Arithmetic consistency only.
- **Wall-clock 127s ground truth:** No harness run was performed; no measurement of output tokens/s, time-to-first-token, or reasoning overhead.
- **`v1` file-watching server path (`src/server/artifact-watch.ts`):** Existence not verified; the RFC cites it but the file was not read (outside workspace read attempts would expand scope). The `commitIfChanged` evidence was verified; the watcher cost estimate (11,915 vs 15,544 tokens) was not.
- **Live system verification (Rung 4/5):** No `bun run check`, no `foldLog` synthetic artifact append, no browser launch. Every finding above is capped at Rung 2 unless marked Rung 1, per `EVIDENCE-LADDER.md` rule: name the rung you stopped at, and if you cannot reach 4, say so in the same sentence — done.

---

*Evidence ladder per `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md`. No writes were performed (read-only). All file:line citations are against the workspace at review time.*
