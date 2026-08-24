# Review: RFC-06, an artifact you can address

Two independent cross-family reviewers on the Draft dated 2026-08-24,
neither seeing the other's work. muse-spark-1.2-contributor@muse found
13; gpt-5.6-sol@codex found 10. They agree on the two blockers that
matter most and diverge everywhere else.

Reports verbatim. Synthesis is in revision 2's header.

---

# muse-spark-1.2-contributor@muse

## What was reviewed

- Path: `docs/rfc/06_an-artifact-you-can-address.rfc.md`
- Frontmatter: `status: Draft`, `date: 2026-08-24`, no `version` field
- Branch `main` at `/Users/kevin/dev/lucid-v2`, read 2026-08-24
- Cross-read: `CONTEXT.md`, `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md`, `docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md`, `src/store/log.ts`, `src/store/conversation-host.ts`, `src/store/store.ts`, `src/store/flock.ts`, `src/store/tailer.ts`, `src/cli/runtime.ts`, `src/cli/send.ts`, `src/protocol/frames.ts`, `src/protocol/reducer.ts`, `src/protocol/events.ts`, `src/protocol/ledgers/input.ts`, `src/tui/view.ts`

Ticket resolution comments for #60 through #69 not accessed in this session - shell and `gh` were denied by sandbox, so drift from tickets is reported as not verified.

## Findings

### 1. Storage envelope is underspecified - the fold will reject an artifact entry that follows the RFC's field list literally

Severity: blocking - lands in Design / Storage: in the log, not folded

What is wrong: The RFC says each artifact entry carries artifact id, version, author, content type, hash, bytes. It omits the envelope every entry must carry. `src/store/log.ts:77-93` defines `Envelope { v:1, at:number, src:string }` and `validEntry` requires `v===1`, `at` safe integer `>=0`, `src` string. `foldLog:377-378` throws `corrupt-log` if `validEntry` fails before any `knownEntry` check. An artifact entry written without `v` and `at` is corrupt, not carried. The RFC also says the entry kind is `artifact` but `ENTRY_SOURCES:70` today is `["frame","input","credit"]` - an unknown `src` is carried (RFC-04 P1) which matches the intent "never reduced", but the envelope must still be present and typed.

Why it matters: First artifact written from the field list alone bricks the record on next open. The index derivation also assumes the fold counted the entry's bytes as good - which only happens for envelope-valid unknown `src`.

Evidence level: 2 - pointed at code `src/store/log.ts:83-93`, `350-406`

### 2. The "never reduced" claim is true by current mechanism but the RFC leaves the new `src` value unnamed and the index unwired

Severity: major - lands in Design / Storage

What is wrong: The RFC never names the `src` string for artifact entries. Callers cannot implement without inventing it. It also says an index `(artifact id, version) -> offset` is derived during the fold that already happens at open, but `foldLog` and `foldCollect` derive no such index today - they derive transcript and `scanCursor` derives cursor. The index needs a new return value and a new validator for the artifact payload (hash shape, id bounds). None is specified, so two implementations will diverge on where the index lives and whether it scans `goodBytes` or the whole buffer.

Why it matters: Storage is the prereq for every later slice. Ambiguous `src` and missing index contract produce incompatible logs.

Evidence level: 2 - `src/store/log.ts:70-100`, `344-408`

### 3. Envelope-valid vs payload-valid split is glossed over - hash and bytes are not covered by the skip

Severity: major - lands in Design / Storage

What is wrong: RFC-04 P1 tolerates an unrecognised `src` by counting its bytes and moving on (`src/store/log.ts:404-405`). That tolerance checks envelope only. It does not validate the artifact payload. The RFC says hash MUST be written from the first version and is not used until slice three. It never says what a reader built before slice three should do with a malformed artifact payload (missing hash, non-UTF8 bytes, content-type not serializable). If the fold skips payload validation, a corrupt artifact is silently carried. If a later slice adds strict validation, it will throw `corrupt-log` on old records. The RFC needs to state whether artifact payload validation is envelope-only until slice three or strict from the start.

Why it matters: Silent carry hides corruption; strict later breaks forward compatibility.

Evidence level: 3 - traced `foldLog` unknown-src path `402-405` vs `knownEntry` path `379-401`

### 4. Server as "append exactly as `lucid2 send` does" hides a lifecycle difference

Severity: blocking - lands in Design / The browser surface - The server is a writer, not a driver

What is wrong: `src/cli/send.ts:75-86` creates a fresh `createConversationHost` per invocation with `executorLease: () => false`, calls `host.enqueueInput`, discards effects via `onEffect: () => {}`, then exits and `log.close()` is implicit in host close. The live driver `src/cli/runtime.ts:332-378` tails the log with `followRecord` poll 500ms + `fs.watch`, peeks lock-free then `collectEffects` under the append lock, dispatches outside the lock, then `advanceCursor`. A long-lived server that reuses one `ConversationHost` across requests holds one `Flock` fd and one `secret` in memory, while `send` recreates both per request. Reusing the host changes contention: concurrent HTTP POSTs now contend on a single host instance's `log.append` critical section plus Node's event loop, rather than on the kernel `flock` alone. The RFC never says whether the server creates a host per request or one host for its lifetime, nor how it serializes concurrent appends, nor how it surfaces `input-queue-full` or `lock-timeout` (30s default in `src/store/flock.ts:24-30`) to the browser.

Why it matters: The correctness claim "whatever it appends reaches the agent through live delivery" assumes the same durability and error semantics as `send`, but a long-lived process introduces queuing, backpressure, and shared-state failure modes `send` does not have.

Evidence level: 3 - traced `src/cli/send.ts:70-94` vs `src/store/conversation-host.ts:204-220` `transact` gate `deps.executorLease()` and `src/cli/runtime.ts:333-379` tailer loop

### 5. Encoding a save and an annotation batch in `input.text` collides with TEXT_MAX and with the input bound

Severity: blocking - lands in Design / Encoding

What is wrong: `src/protocol/frames.ts:110` `TEXT_MAX = 1_000_000`. The codec `text()` at `207-213` and host helper `isWireText:282` enforce it. `enqueueInput` ultimately calls the reducer which checks `INPUT_QUEUE_MAX` in `src/protocol/ledgers/input.ts:56-58` and `src/protocol/events.ts:30`. The RFC says a save carries both the document as it now stands and a structured map of control values. A self-contained HTML document plus inline assets routinely exceeds 1 MB. An annotation batch carrying per-spot snippets for a command-click multi-select can also exceed it. Both would be refused `wrong-type` and never land. The RFC never acknowledges the bound.

Why it matters: The primary user action - saving edits - fails for any non-trivial artifact, with an error the UI has no handling for.

Evidence level: 2 - `src/protocol/frames.ts:207-213`, `src/protocol/events.ts:30`

### 6. The same encoding collides with transcript projection - raw HTML would leak into the transcript until view is updated

Severity: major - lands in Design / Encoding

What is wrong: The RFC says the projection MUST render an annotation batch as annotations, never as raw encoded text, same split as hcn's question block. `src/tui/view.ts:79-88` implements `stripQuestionBlock` for `hcn-question` only and `eventText` strips it before rendering. There is no stripping for the artifact fence nor for annotation-batch / save encodings. Without a new strip rule, `lucid2 chat` and `lucid2 watch` will render raw encoded HTML and raw JSON in the transcript. The RFC mandates the behavior but does not mention updating `view.ts`, nor does it define the fence language for annotation batches and saves distinct from the artifact fence and the `hcn-question` fence.

Why it matters: The transcript is the security and readability boundary - leaking raw HTML or control maps violates it.

Evidence level: 2 - `src/tui/view.ts:79-88`, `85-108`

### 7. Conflicting normative statements on what a save is

Severity: blocking - lands in Design / Editing and save vs Design / Encoding

What is wrong: Two MUSTs cannot hold together:

- `Design / Editing and save`: "A save produces a new artifact version whose author is the human. ... A save MUST NOT start a turn. It appends a version and stops... An annotation ... becomes an input; a save is a statement of fact"

- `Design / Encoding`: "An annotation batch and a save are encoded in the input text, taught by a preamble, exactly as the artifact block is. No frame gains a field"

If a save is encoded as an `input` entry, it is an input. Every input is enqueued via `src/store/conversation-host.ts:289-301` and `src/protocol/reducer.ts:enqueueInput`, counted against `INPUT_QUEUE_MAX`, produces a `send` effect the live holder dispatches, and participates in disposition lifecycle `outstanding`/`queued`/`applied`/`rejected` (`src/store/log.ts:306-338`). It cannot be "not an input" and "not start a turn" while using the input channel. If a save is meant to be a direct `src: "artifact"` append, it is not encoded in input text and the Encoding section is wrong. The RFC needs one consistent story and, if saves stay on the input channel, a new mode or flag that exempts them from queue bound and turn-start - which contradicts "no frame gains a field".

Why it matters: Implementers must choose which MUST to break. The delivered semantics will diverge from the tested input discipline.

Evidence level: 3 - traced `src/store/conversation-host.ts:289-301` `enqueueInput` vs `src/protocol/ledgers/input.ts:51-78` queue vs in-flight

### 8. Artifact version input-vs-artifact duality also confuses durability and idempotency

Severity: major - lands in Design / Editing and save

What is wrong: Annotation batch is specified as one input with one idempotent id, one disposition, one charge against `INPUT_QUEUE_MAX`. Save as described ("both the document as it now stands and a structured map") could be implemented either as one artifact entry or as one input that later materializes into an artifact entry. The RFC says neither which entry is written first, what its idempotency key is, nor how a retry after `lock-timeout` avoids duplicating a human-authored version. `sendInput:87` mints `send-${Date.now()}...` - saves would need a distinct id space and dedup rule, otherwise a retried save creates two versions with different ids but identical content.

Why it matters: Without an idempotency rule, exactly the crash window RFC-04 R3/R4 closes for inputs reopens for saves.

Evidence level: 1 - asserted from spec text, no code path yet exists for artifact entries

### 9. Version switching and concurrent saves leave an uncovered state

Severity: major - lands in Design / The browser surface

What is wrong: The RFC says with no pending marks and no unsaved edits, a new version may be shown directly, otherwise the page reports that one exists and stays until the human switches. It never specifies what happens if the human saves while a newer agent version landed concurrently, or if two saves race, or if an annotation is submitted against version N after N+1 is already durable. `INPUT_QUEUE_MAX` refusal handling (`src/cli/send.ts:89-93` throws, `src/protocol/frames.ts:74-99` REFUSAL_ISSUES) would refuse the annotation, but the UX - keep draft, mint new id, re-anchor - is not described. The same gap exists for the artifact index: seeking by `(artifact id, version)` while a concurrent append extends `goodBytes` races with `viewSnapshot` which is lock-free (`src/store/conversation-host.ts:321-351`).

Why it matters: The most likely real-world race - edit while agent writes - has no defined resolution.

Evidence level: 2 - `src/store/conversation-host.ts:321-351` lock-free read vs `src/store/log.ts:406` `goodBytes` advance

### 10. Security Considerations is missing token lifecycle and leaves origin handling underspecified

Severity: major - lands in Security Considerations

What is wrong: The RFC correctly identifies drive-by POST to `127.0.0.1:17454` and mandates a session token in a custom header to force a preflight, plus rejecting unexpected `Origin`. It does not specify: token entropy/length, where it is stored (memory only vs persisted), rotation on server restart, whether one token covers all conversations or per-conversation, how token leakage via browser history or `Referer` is avoided (query param explicitly rejected, but `Origin` and `Referer` handling for `file://` and `null` origin not mentioned), or how DNS rebinding to `127.0.0.1` is handled. It also says the record secret MUST NOT reach the browser but does not say the server never reads `secret` - which it must not, but a naive implementation that serves artifacts by folding the log needs `secret` to call `foldLog`. The server as specified needs to `seek` per request - that seek is either via `viewSnapshot` (needs `secret`) or raw byte seek (no secret). Which path is taken determines whether the secret is held by the HTTP process.

Why it matters: The server is the only network surface lucid has ever had. Under-specification here is where vulnerabilities survive review.

Evidence level: 1 - asserted, informed by `src/store/conversation-host.ts:138-152` `readRecordFiles` requiring `secret`

### 11. Instrumentation boundary is sound but the RFC's own MUSTs conflict with the agent's script

Severity: minor - lands in Design / Rendering and selection: the instrumented iframe

What is wrong: The RFC says lucid's instrumentation MUST NOT appear in anything sent to the agent, and MUST NOT mistake the agent's own scripted DOM changes for the human's edits. The instrumentation adds ids per element plus a script that draws hover inside the frame and posts out ids and values via `postMessage`. An agent script that rewrites `innerHTML`, clones nodes, or removes ids will collide with those ids. The RFC says neither may break the other but offers no isolation mechanism (mutation observer scope, id namespace, shadow boundary). This is not a flaw in the iframe choice - the choice `srcdoc` sandboxed without `allow-same-origin` is correctly justified - but a gap in the coexistence rule.

Why it matters: Real agent HTML will mutate the instrumented DOM; silent id loss breaks anchoring before slice three exists.

Evidence level: 1 - asserted

### 12. Scope claim vs slice deferral

Severity: minor - lands in Introduction / Scope

What is wrong: Introduction says in scope: artifact emission, storage and versioning; the browser surface; element selection and annotation; in-place editing and save; anchoring across versions. Slices then defers anchoring across versions to slice three and, within the browser surface, defers the conversation-update channel choice entirely to implementation (Open Question 1). The RFC claims to specify anchoring (selectors, drift, orphans) while marking it as slice three. A reader expecting slice one to cover anchoring will find selectors mentioned only as "written at annotation time" with no slice-one behavior.

Why it matters: Scope vs plan mismatch causes reviewers to miss that slice one has no re-anchoring and no drift handling.

Evidence level: 1 - asserted from document structure

### 13. Open questions - one wrongly deferred, two missing

Severity: major - lands in Open Questions

What is wrong: Q3 "What the artifact fence carries besides the document - whether one block can hold metadata the renderer needs, and how a version declares its predecessor. Deferred from #60 as format question rather than mechanism one. Decider: this RFC's review." This is not a question for reviewers - it is the artifact entry's on-wire format, prerequisite to Storage. Deferring it to review means storage and emission cannot be implemented without inventing the format, contradicting the RFC's claim that each decision below links the ticket that holds its reasoning - the format decision has no ticket.

Missing questions the RFC never asks:

- How does a document-bearing save stay within `TEXT_MAX` and `INPUT_QUEUE_MAX`? (see finding 5)

- What is the idempotency and version-predecessor rule for human saves vs agent versions? (see finding 8)

These should be open questions or be answered; they are neither.

Evidence level: 1 - asserted

## Cleared

What was checked and found sound, with level:

- Fold tolerant of unknown `src` (RFC-04 P1) - artifact entries counted as good bytes, not folded, not in transcript. Verified `src/store/log.ts:70-100`, `350-406`, `424-483` and `scanCursor` still works within `goodBytes`. Level 2.

- `lucid2 send` appends without lease and reaches a live holder via tailer: `src/cli/send.ts:78-83` `executorLease: () => false`, `onEffect: () => {}`, `src/store/conversation-host.ts:217` `if (deps.executorLease()) ...` gate, and `src/cli/runtime.ts:332-378` tailer `peek` then `collectEffects` then dispatch then cursor. Level 3.

- `TEXT_MAX` and `INPUT_QUEUE_MAX` enforcement exists at both codec and reducer - the bound the RFC steps on is consistently enforced. Level 2.

- Presence lock as executor lease is kernel-elected via `flock(2)` (`src/store/flock.ts:30-50`, `96-171`), not a claim file - the server's "never hold presence lock" rule does not create a second writer election. Level 2.

- Iframe `srcdoc` sandboxed without `allow-same-origin`, parent not touching frame DOM, messages as narrow `postMessage` of ids/values - matches HTML sandbox model and avoids `allow-same-origin` reach-back. Level 1, checked against spec text and HTML spec, not code.

- Per-spot provenance (`snippet` plus author per spot) rather than per-annotation - correctly identifies mixed human/agent content. Level 1, no code yet but rationale sound and matches `view.ts` `stripQuestionBlock` precedent for keeping snippets verbatim in log and stripped in view.

- Loopback bind `127.0.0.1` never wildcard, port 17454 disjoint from v1 `17412-17419,17428` - `~/.agents/PORTS.md` recording mandated. Level 1, checked `CONTEXT.md` "one user, one machine, filesystem be whole transport" scope and existing port range stated in RFC.

## Not reviewed

- Drift from tickets #60 through #69: `gh issue view` requires shell and network. Shell was denied in this session, so resolution comments not read. The RFC's claim "Nothing here is new" not verified - listed as a gap rather than a pass.

- Live execution: `bun test`, `bun run check`, or throwaway probes under `/tmp` not run - shell denied. Findings above are at most level 3 (traced execution), not level 4/5.

- Browser rendering, assistant-ui `ExternalStoreRuntime` integration, `src/anchors/` v1 discipline, and Harness attribution - read spec text only, not implemented code.


---

# gpt-5.6-sol@codex

## What was reviewed

I reviewed [`docs/rfc/06_an-artifact-you-can-address.rfc.md`](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:1) on branch `main`.

- Frontmatter date: `2026-08-24`
- Status: `Draft`
- Version: none stated
- Working tree: clean
- Ticket evidence: issue #59 and closed issues #60 through #69, including every resolution comment
- Supporting material: `CONTEXT.md`, RFC-04, RFC-05, and all requested source files

## Findings

1. **Blocking - `Editing and save` and `Encoding`: a save has two incompatible durable meanings.**

   [`Editing and save`](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:195) says a save appends a human-authored artifact version and MUST NOT start a turn. [`Encoding`](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:237) says a save is encoded in input text.

   Those cannot both use the current delivery model:

   - An input is reduced by `enqueueInput` and produces a `send` effect when a live attachment exists ([`reducer.ts:841`](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:841)).
   - The holder delivers that frame to the harness ([`runtime.ts:361`](/Users/kevin/dev/lucid-v2/src/cli/runtime.ts:361)).
   - An artifact-shaped unknown entry produces no effects, and the live follower advances past a no-effect range ([`log.ts:457`](/Users/kevin/dev/lucid-v2/src/store/log.ts:457), [`runtime.ts:350`](/Users/kevin/dev/lucid-v2/src/cli/runtime.ts:350)).

   Therefore input encoding starts harness work, while an unfurled artifact entry never reaches the harness. The RFC defines no third path. It carried the conflict between the [#65 resolution](https://github.com/dungle-scrubs/lucid-v2/issues/65#issuecomment-5396292556) and [#67 resolution](https://github.com/dungle-scrubs/lucid-v2/issues/67#issuecomment-5396320031) into the assembled document instead of resolving it.

   **Why it matters:** save is a core slice. Implementers cannot decide what entry to append or how the agent learns about it without making a new architectural decision.

   **Evidence level: 4 - ran the real fold and reducer.** An artifact-shaped entry produced no state, transcript, or effects; the save-shaped input was accepted with a `send` effect.

2. **Major - `Storage`: the current skip behavior cannot produce the promised offset index or recovery record.**

   The existing fold does parse an envelope-valid unknown source, counts all its bytes in `goodBytes`, and excludes it from state and transcript ([`log.ts:343`](/Users/kevin/dev/lucid-v2/src/store/log.ts:343)). It also:

   - Does not increment `entries`.
   - Does not validate the source-specific payload.
   - Does not retain its offset.
   - Does not expose it through `ConversationLog` or the recovery record ([`log.ts:629`](/Users/kevin/dev/lucid-v2/src/store/log.ts:629), [`conversation-host.ts:101`](/Users/kevin/dev/lucid-v2/src/store/conversation-host.ts:101)).

   The RFC simultaneously promises that `(artifact id, version) -> offset` is derived during the fold ([RFC-06 line 125](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:125)). That needs a third fold outcome: recognized and validated, accumulated into the artifact index, but not reduced into `ChannelState` or transcript. The RFC does not specify this outcome, its validation failures, or its recovery accounting.

   **Why it matters:** leaving `artifact` unknown makes malformed artifact payloads silently good and produces no index. Adding it to `ENTRY_SOURCES` requires new `applyEntry` semantics that the RFC does not define.

   **Evidence level: 4 - ran `foldLog`.** The proof returned `goodBytes: 85` for an 85-byte artifact entry, with `entries: 0`, `seq: 0`, an empty transcript, and no refusal.

3. **Blocking - `Encoding`: the whole-document save does not fit the existing text bound.**

   `TEXT_MAX` is 1,000,000 characters ([`frames.ts:105`](/Users/kevin/dev/lucid-v2/src/protocol/frames.ts:105)). Both event payloads and input text are checked against it ([`frames.ts:207`](/Users/kevin/dev/lucid-v2/src/protocol/frames.ts:207), [`frames.ts:251`](/Users/kevin/dev/lucid-v2/src/protocol/frames.ts:251)).

   A save must contain the whole document, structured control values, and protocol framing. The RFC defines no smaller artifact limit, chunking, compression, or alternate storage reference. A document that is valid when emitted can therefore become invalid when wrapped as a save.

   **Why it matters:** even a no-op save can fail for an artifact lucid already accepted.

   **Evidence level: 4 - ran both codecs.** A 999,850-character document was accepted inside an artifact message. Adding a 200-character control value and the save wrapper produced a 1,000,107-character input that was refused.

4. **Major - `Emission`: the mechanism does not cover the substrate’s integration modes.**

   The Introduction invokes all three integration modes, but Emission only describes text handed to `session.send` and a preamble composed once at session start ([RFC-06 line 95](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:95)).

   Current execution has three materially different paths:

   - Session mode calls `session.send` ([`host.ts:190`](/Users/kevin/dev/lucid-v2/src/modes/host.ts:190)).
   - Turn mode calls `streamTurn` with one prompt per process ([`host.ts:300`](/Users/kevin/dev/lucid-v2/src/modes/host.ts:300)).
   - Interactive mode is attached by a `SessionStart` hook that only appends attach state and emits no agent context ([`announce.ts:24`](/Users/kevin/dev/lucid-v2/src/cli/hooks/announce.ts:24)).

   The RFC neither specifies preamble injection and parsing for turn and interactive modes nor scopes artifact emission to session mode.

   **Why it matters:** implementers must invent how two integration modes learn the protocol, including attach replay and resumed sessions.

   **Evidence level: 3 - traced all three execution paths.**

5. **Major - `Encoding` and `Implementation Notes`: saves have no transcript projection.**

   The RFC requires special rendering only for annotation batches ([RFC-06 line 248](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:248)). It does not give saves the same rule.

   Current projection copies every accepted input’s text into the transcript ([`log.ts:322`](/Users/kevin/dev/lucid-v2/src/store/log.ts:322)) and renders human input text unchanged ([`view.ts:150`](/Users/kevin/dev/lucid-v2/src/tui/view.ts:150)). The hcn precedent is not directly reusable because it strips a block from an agent message, not from human input ([`view.ts:73`](/Users/kevin/dev/lucid-v2/src/tui/view.ts:73)).

   **Why it matters:** RFC-06 keeps `lucid2 chat`. A browser save can consequently paint the entire encoded HTML document into the terminal transcript.

   **Evidence level: 4 - ran `buildView`.** A save-shaped input rendered verbatim as `SAVE:<html></html>`.

6. **Major - `Security Considerations` and Open Questions 1-2 conflict.**

   The token is injected into the page served by the server, but the RFC also requires the token as a custom header on every request ([RFC-06 line 264](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:264)). The initial page request cannot already carry the token found inside that page. The bootstrap request needs an explicit exception or a different bootstrap mechanism.

   The transport question also is not implementation-neutral:

   - Native `EventSource` accepts only `withCredentials`, not arbitrary headers ([`lib.dom.d.ts:761`](/Users/kevin/dev/lucid-v2/node_modules/@typescript/typescript-darwin-arm64/lib/lib.dom.d.ts:761)).
   - Native `WebSocket` accepts a URL and subprotocols, not arbitrary headers ([`lib.dom.d.ts:40935`](/Users/kevin/dev/lucid-v2/node_modules/@typescript/typescript-darwin-arm64/lib/lib.dom.d.ts:40935)).

   This conflicts with the custom-header MUST while Open Question 1 lists SSE and WebSocket as interchangeable choices. Implementation step 3 also says only “token”; it omits the required header, preflight refusal, and Origin validation.

   **Why it matters:** the server cannot implement both the listed transports and the stated authentication contract without changing one of them.

   **Evidence level: 2 - pointed at the RFC and the installed browser API type definitions.**

7. **Major - `Rendering and selection`: `postMessage` is not yet the claimed trust boundary.**

   The RFC says lucid’s instrumentation and agent-written script share the iframe, while the parent trusts a narrow message containing ids and values ([RFC-06 line 162](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:162)). Both scripts occupy the same frame and can send parent messages. Checking `event.source` identifies the iframe, not which script inside it sent the message.

   The RFC gives no private message capability, message schema and size validation, trusted-event rule, or treatment for programmatic DOM changes. It nevertheless states that lucid MUST NOT mistake the agent’s scripted changes for human edits.

   **Why it matters:** untrusted artifact script can impersonate the instrumentation and manufacture selections or saved values. Security Considerations discuss origin isolation but not this same-frame authority problem.

   **Evidence level: 1 - asserted from the assembled browser design; no RFC-06 browser implementation exists to run.**

8. **Blocking - Open Question 3 is wrongly deferred.**

   The artifact fence format must supply enough information to create the required log entry: artifact id, version, author, content type, hash, bytes, and possibly predecessor ([RFC-06 line 121](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:121)). Open Question 3 leaves that format undecided ([RFC-06 line 319](/Users/kevin/dev/lucid-v2/docs/rfc/06_an-artifact-you-can-address.rfc.md:319)).

   Issue #60 deliberately deferred this to #61 once storage was settled. Issue #61 settled the entry fields but did not settle how emission supplies them. Deferring it again leaves implementation steps 1 and 2 without a shared contract.

   **Why it matters:** parser behavior, identity, version ordering, hashing, duplicate blocks, and replay cannot be implemented independently of this format. The RFC review would have to make a new decision despite the opening claim that nothing is new.

   **Evidence level: 2 - pointed at the RFC and the linked ticket resolutions.**

9. **Major - whole-document structural validation fails.**

   Validator output, verbatim:

   ```json
   {
     "passed": false,
     "errors": [
       "Missing required section: ## Motivation",
       "Missing required section: ## State Machine",
       "Missing required section: ## Error Handling",
       "Missing required section: ## Alternatives Considered",
       "Missing required section: ## Implementation Plan"
     ],
     "warnings": []
   }
   ```

   Some content exists under other headings, but the missing State Machine and Error Handling sections are substantive. The save lifecycle, server bootstrap, rejected save, stale browser version, malformed artifact entry, and iframe-message failure states are not specified.

   **Evidence level: 4 - ran the repository’s RFC structural validator.**

10. **Minor - the ticket-link and ticket-fidelity claim has one omission.**

   Issue #62’s resolution explicitly says the server follows the conversation with the tailer’s lock-taking `read`, not `peek`. RFC-06 omits that rule. The distinction exists in [`tailer.ts:76`](/Users/kevin/dev/lucid-v2/src/store/tailer.ts:76).

   Issue #64’s decisions are present - `lucid2 chat` remains, one explicit server serves all records - but #64 is the only decision ticket with no direct link in the decision sections. This contradicts the opening statement that each decision below links its ticket.

   **Why it matters:** an implementer following only the RFC can choose a read path that differs from the recorded resolution, and cannot follow the claimed link for #64.

   **Evidence level: 2 - pointed at the RFC, ticket resolution, and tailer interface.**

## Cleared

- The server is not inherently a second driver. `sendInput` constructs a host with `executorLease: () => false` ([`send.ts:70`](/Users/kevin/dev/lucid-v2/src/cli/send.ts:70)); the append still runs under the append lock, and the running holder discovers its effect through the tailer. A long-lived caller does not change that serialization because every append performs a locked catch-up fold. Evidence level 3.

- One annotation batch as one input is consistent with the existing queue bound. `INPUT_QUEUE_MAX` is eight, and capacity is charged by one `enqueueInput`, not by the number of marks inside its text. Evidence level 3.

- The current unknown-entry behavior does preserve `goodBytes` and leaves state and transcript unchanged, exactly as the RFC assumes for those three properties. The missing index and recovery semantics are covered in Finding 2. Evidence level 4.

- The artifact version-switch policy matches issue #69: no automatic replacement while marks or unsaved edits exist.

- The annotation payload, per-spot provenance, selector order, ambiguity refusal, snapshot guard, unresolved presentation, and partial paint match issues #63 and #66.

- One explicit server for all records and retention of `lucid2 chat` match issue #64.

- Except for the unresolved fence format and omissions listed above, I found no already-made normative decision that the RFC invented independently of issue #59 or tickets #60 through #69.

## Not reviewed

- No RFC-06 implementation exists, so no browser UI, HTTP server, iframe isolation, or end-to-end artifact loop could be observed at evidence level 5.

- Disk-backed tests could not run in this read-only sandbox. The selected store, cursor, and tailer tests all stopped before assertions because `mkdtemp` returned `EPERM`. Pure in-process proofs were run successfully.

- The indexed codebase graph could not create its secure `/private/tmp` coordination directory. Structural conclusions therefore use direct complete file reads and execution traces, without graph coverage verification.

- The external W3C, assistant-ui, `dom-anchor-text-quote`, and lucid v1 implementations were not independently reviewed. The review checks only how this RFC uses their stated decisions.