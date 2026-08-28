# Review of RFC-11: Attaching an image or a file as context

## What was reviewed

- **Path:** `docs/rfc/11_attaching-an-image-or-a-file-as-context.rfc.md`
- **Front matter:** `number: 11`, `status: Draft`, `date: 2026-08-28`, `type: protocol`, `author: Kevin Frilot`
- **Commit / tree at review time:** working tree on branch `master` (no RFC-11 implementation code committed; see git log 2026-08-28)
- **Review date:** 2026-08-28
- **Reviewer stance:** adversarial; author family excluded; no edits to the RFC were made

This review is stale the moment the draft moves. The version above is what was read.

---

## Findings

Each finding names the RFC section it lands in, what is wrong, why it matters, and its rung on the evidence ladder at `~/.agents/skills/blast-radius/references/EVIDENCE-LADDER.md` (1 asserted, 2 pointed at code, 3 traced, 4 ran, 5 saw in running system). A rung is named inline for every claim the reader would act on.

### F-01 — `ATTACHMENT_BYTES_MAX` is used normatively but never defined

- **Section:** `Error Handling` (table, `E-ATTACH-01`), `Security Considerations`, `Implementation Notes` step 1
- **What is wrong:** The RFC enforces `E-ATTACH-01 attachment-too-large` when "the file exceeds `ATTACHMENT_BYTES_MAX`" and says "Without `ATTACHMENT_BYTES_MAX` the endpoint accepts an arbitrarily large body" (rung 2, cited `src/store/log.ts:166` and `src/protocol/frames.ts:110`). No section defines the value. The task prompt asks whether "25 MB and no per-conversation total are defensible together" — the number 25 MB does not appear anywhere in the draft (rung 2, `grep -n 25` across the file returns zero matches). The only related constants in the codebase are `ARTIFACT_BYTES_MAX = 1_000_000` (`src/store/log.ts:166`) and `TEXT_MAX = 1_000_000` (`src/protocol/frames.ts:110`), both 1 MB (rung 2). A bound that is never given a number cannot be implemented, tested, or reasoned about for DoS.
- **Why it matters:** Every later size argument (DoS, "no per-conversation total", ordering cost) is vacuous without the bound. An implementer must guess whether to reuse the 1 MB artifact bound, to introduce a new 25 MB bound, or to leave it unbounded until someone picks a number. The RFC's own `E-ATTACH-01` check order ("MUST be checked before the bytes are copied and before they are hashed") is normative but untestable without the threshold.
- **Rung:** 2 — pointed at code (`src/store/log.ts:166`, `src/protocol/frames.ts:110`) and at the absence in the RFC text (full-file read).
- **Recommendation:** Define `ATTACHMENT_BYTES_MAX` once, with a number, a unit, and how it is measured (decoded bytes vs. on-wire bytes vs. string length, which matters for UTF-8 vs. string length counts used elsewhere in the store).

### F-02 — Record layout claim is half-true: `RecordPaths` exposes one lock, not two

- **Section:** `Abstract`, `Message Formats / The blob store`, `Security Considerations` ("so is `secret`"), and the verification claim (1) in the review brief
- **What is wrong:** The RFC (and `CONTEXT.md`) says the record directory holds `log.ndjson`, `meta.json`, `secret` and **two** locks. The code agrees on the durable files but not on the shape that proves it:
  - `src/store/errors.ts:30-39` `RecordPaths` holds `secretPath`, `logPath`, `metaPath`, `lockPath` where `lockPath = logPath + ".lock"` (the append lock only).
  - The second lock is `presence.lock`, defined separately in `src/store/presence.ts:16` `presenceLockPath` and used via `src/store/flock.ts:6-7`.
  - `src/store/store.ts:48-51` `createConversationRecord` writes `secret`, `log.ndjson`, `meta.json` with `0o600` and never creates either `.lock` file at creation time (locks are `flock(2)` rendezvous files created on demand). A naive reader that lists the directory after creation sees three files, not five.

  The RFC's claim that `secret` is a credential is correct (rung 2, `src/store/store.ts:45` generates 32 random bytes hex, `src/store/conversation-host.ts:152-161` validates `HEX_SECRET`, attach frames check it). The "two locks in the directory" claim is defensible only if you know `flock` files are implicit. The RFC states it as a filesystem fact without that caveat.
- **Why it matters:** Drift. A future implementer who trusts the RFC's filesystem picture may add `files/` cleanup that accidentally deletes or moves `presence.lock`, or may treat `RecordPaths` as the complete record layout. The distinction between durable files and lock rendezvous matters for backup/copy semantics ("Copy it and the attachments travel" — locks must *not* travel).
- **Rung:** 2 — pointed at `src/store/errors.ts:30-39`, `src/store/presence.ts:16`, `src/store/store.ts:48-51`, `src/store/flock.ts:6-7`.

### F-03 — `files/<hash>` is specified, but the fold's allowlist does not know `src: "attach"`

- **Section:** `Message Formats / The log entry`, `Versioning`, and the verification claim (3)
- **What is wrong:** The RFC defines a log entry with `src: "attach"` and says a reader that does not know it MUST carry it rather than fail, "as the fold already does for unknown sources" (rung 2, `src/store/log.ts:558-667`). That is true today: `ENTRY_SOURCES` (`src/store/log.ts:100`) is `["frame","input","credit","artifact","artifact-meta"]` and does not include `"attach"`, so `knownEntry` returns false and the fold carries it (rung 3, traced `foldLog` at `src/store/log.ts:606` and `foldCollect` at `src/store/log.ts:747`). The RFC's own `Implementation Notes` step 1 says the fold will read the new `src: "attach"` — but the code as shipped has no such case. An `attach` entry written by a newer build and opened by *this* build is carried, not indexed; opened by the newer build that is supposed to index it, the behavior is not yet specified and the RFC never says to add `"attach"` to `ENTRY_SOURCES` or to add a new `coerceAttachEntry` path.
- **Why it matters:** Drift / forward-compatibility. The RFC's versioning claim ("An `attach` entry is additive. A record containing them MUST open in an implementation that predates them, carrying the entries") is correct for the *current* code precisely because the entry is unknown. The *post-RFC* code must stop carrying and start validating. The RFC never names the code change, so an implementer could ship deduplicated blob handling but leave the fold carrying, and the hash/size/contentType would never be validated or surfaced.
- **Rung:** 3 — traced `foldLog`/`foldCollect` and `ENTRY_SOURCES` at `src/store/log.ts:100,128,143,606,666`.

### F-04 — `src/store/log.ts` hash claim is correct, but the RFC implies the bound is shared when it is not defined

- **Section:** `Message Formats / The blob store` ("This is the hash `src/store/log.ts` already computes"), and verification claim (2)
- **What is wrong:** `hashArtifactBytes` at `src/store/log.ts:182-183` is indeed `createHash("sha256").update(bytes,"utf8").digest("hex")` (rung 2). `ARTIFACT_BYTES_MAX` and `TEXT_MAX` are both `1_000_000` (rung 2, `src/store/log.ts:166`, `src/protocol/frames.ts:110`). The RFC is correct that a second hash for a second purpose MUST NOT be introduced — reuse is the right call. What is *not* correct is the implied corollary that attachments therefore share the 1 MB bound. They do not yet share any bound; `ATTACHMENT_BYTES_MAX` is undefined (F-01). The RFC never says whether attachments reuse `ARTIFACT_BYTES_MAX` or `TEXT_MAX` or define their own, so the "same bound `TEXT_MAX` guards" sentence is not a specification for attachments.
- **Why it matters:** An implementer who reuses `ARTIFACT_BYTES_MAX` for attachments will reject a 2 MB PNG that the "25 MB" discussion assumed would be allowed; one who defines a new 25 MB constant will allow a 25 MB text file that then becomes a 25 MB `input.text` and violates `TEXT_MAX` at `enqueueInput` (`src/protocol/reducer.ts:889-891` via `isWireText`).
- **Rung:** 2 — pointed at `src/store/log.ts:166,182-183`, `src/protocol/frames.ts:110`.

### F-05 — Annotation `Annotation` shape and validator claim: the RFC understates the forward-compatibility hazard it correctly identifies

- **Section:** `Message Formats / The reference, on an annotation` and verification claim (5)
- **What is wrong:** The RFC correctly states (rung 2):
  - `src/protocol/annotations.ts:62-67` `Annotation` is `{ note: string, spots: readonly AnnotationSpot[] }` (plus optional `selectors`), and `AnnotationBatch` is `{ artifactId, version, notes }` (`src/protocol/annotations.ts:69-74`).
  - The batch rides as a fenced block ```lucid-annotations JSON.stringify(batch) inside `input.text` (`src/protocol/annotations.ts:94-100` `encodeAnnotationBatch`), therefore it is **stored** in the log as part of the input entry and forever (fold carries `input` entries).
  - `src/protocol/patch.ts:86-98` `parsePatchBody` **refuses** unknown fields (`EDIT_FIELDS` check) because the patch body is never stored — the RFC's contrast is accurate.

  The RFC then mandates: "A batch carrying `files` MUST be readable by an implementation that does not know the field. The validator MUST ignore fields it does not recognise." The code at `src/protocol/annotations.ts:118-140` `isNote`/`isSpot`/`isBatch` currently checks only required fields and does not reject extra fields — it already ignores them (rung 3, traced `isBatch`/`isNote`). So the RFC's MUST is already the code's behavior for *top-level* `files`, but the draft leaves the nested validation unspecified: `Annotation.files?: AttachedFile[]` is added to `Annotation`, but `AttachedFile.path` is declared absolute and inside the record. An old validator that ignores `files` entirely will carry the batch but an old *projection* that strips the fence for display (`stripAnnotationBatch` at `src/protocol/annotations.ts:157-182`) will drop `files` silently, and a new validator that later *does* validate `AttachedFile` fields will need to decide whether to refuse the batch or to ignore malformed `files` entries.

- **Why it matters:** Stored-format forward compatibility is the highest-stakes kind. The RFC correctly distinguishes it from the patch (non-stored) case, but then stops at "MUST ignore" without specifying the validation rule for `files` entries that are present but malformed (e.g., `hash` not hex, `path` traversal). The correct rule for a stored batch is "ignore the `files` array entry-wise, never refuse the batch" — otherwise a malformed attachment poisons the note it rides with.
- **Rung:** 3 — traced `src/protocol/annotations.ts:62-74,94-100,118-182` and `src/protocol/patch.ts:86-98`.

### F-06 — `decodeHarnessLine` claim is correct; the RFC's reliance on it is incomplete

- **Section:** `Message Formats / The log entry` ("as `decodeHarnessLine` does for unknown event kinds") and verification claim (4)
- **What is wrong:** The claim is true (rung 2, `src/harness/events.ts:103-122` `decodeHarnessLine` returns `record as unknown as HarnessEvent` for any string `kind`, last union member `{kind: string, [field:string]:unknown}` at `src/harness/events.ts:78-80` is the carry). The incompleteness is that `decodeHarnessLine` lives in the harness runner, not in the durable store. The log-entry carry the RFC leans on is `foldLog` at `src/store/log.ts:666`, while the harness carry is a process-boundary decoder. Conflating the two as one principle ("carries rather than fails") hides that one is durable and auditable (log) and the other is ephemeral and lossy if the runner buffers overflow (`src/harness/hcn-runner.ts:265-268` `PRE_TURN_MAX = 256` drop-oldest for pre-turn events).
- **Why it matters:** A reviewer who checks only `decodeHarnessLine` will conclude the system is uniformly additive. It is not: the store's carry is total, the harness's carry is bounded.
- **Rung:** 2 — pointed at `src/harness/events.ts:78-80,103-122` and `src/store/log.ts:558-667`.

### F-07 — "Nothing in lucid sets `cwd` on a turn" is true but misleading about the trust boundary

- **Section:** Verification claim (6), `StreamTurnOptions` in `src/harness/runner.ts`
- **What is wrong:** The literal claim is true (rung 2, `src/harness/runner.ts:106-112` `StreamTurnOptions { cwd?: string }` exists, `grep -rn cwd src/modes --include="*.ts"` shows no assignment to `cwd` in `src/modes/host.ts`; `src/harness/hcn-runner.ts:140,183` merely forwards `opts.cwd` if supplied). What the RFC omits is that `cwd` *is* set on `OpenSessionOptions` (`src/harness/runner.ts:101`) via `src/harness/hcn-runner.ts:183` and via `src/harness/node-deps.ts:24,47-48` for the `hcn` binary resolution path. An interactive session's `cwd` is therefore process-inherited, and a named attachment path like `<record>/files/<hash>` is resolved relative to whatever directory the agent process was spawned in if the implementation later joins rather than verifies. The RFC's `cwd` sentence, as written, suggests the agent reads files against a neutral directory — it does not.
- **Why it matters:** The security analysis for Open Question 3 (path disclosure) assumes the agent reads the named path as an absolute path. If any harness resolves relative to `cwd`, the disclosure surface changes. The RFC should state whether named paths are absolute (it says `path: string // absolute, inside the record` for `AttachedFile` but not for the inlined-vs-named prompt text) and whether `cwd` is ever set for the agent process.
- **Rung:** 2 — pointed at `src/harness/runner.ts:101,106-112`, `src/harness/hcn-runner.ts:140,183`, `src/modes/host.ts:459,737,765`.

### F-08 — `hcn` has no attachment channel — verified, but the RFC overstates the permanence

- **Section:** `What it does not cover / Changing hcn`, `Why now`, and verification claim (7)
- **What is wrong:** `node_modules/.bin/hcn run --help` lists prompt sources as positional `prompt`, `--prompt <text>`, `--prompt-file <path|->` and has no `--image`, `--file`, `--attachment`, or `--files` flag (rung 4, ran `hcn run --help` 2026-08-28). `hcn inspect <h> --capabilities` reports `vision`/`images` per harness as true for `claude`/`codex` and false for `pi`/`muse` (rung 4, ran `hcn inspect claude --capabilities`, `pi`, `codex`, `muse` — outputs included `vision:true,images:true` vs `vision:false,images:false` with `source:curated,confidence:medium`). `hcn inspect --help` also shows `--capabilities --mode headless-turn|headless-session|interactive` but no attachment mode. So "no channel" is correct today.
  - The overstatement is "lucid cannot make one." `lucid` spawns `hcn` with arbitrary `cwd`/`env` and could in principle write a temporary file and name it on the prompt, which is exactly what the RFC proposes for "named" attachments. The limitation is not process-spawn capability but protocol: `hcn` has no typed attachment affordance, so any file reference is prompt-injected text.
- **Why it matters:** The RFC's workaround (inlining text, naming a path) is correctly presented as the only option, but the phrasing suggests an absolute barrier rather than a missing typed channel. That distinction matters for the security analysis: a named path is not a capability, it is a string the agent may or may not honor.
- **Rung:** 4 — ran `node_modules/.bin/hcn run --help` and `node_modules/.bin/hcn inspect <h> --capabilities` for all four harnesses.

### F-09 — Open Question 3: the RFC understates the secret-disclosure risk and its own recommendation is not a fix without a second decision

- **Section:** `Open Questions` Q3, `Security Considerations` ("Named paths leak the record's location")
- **What is wrong:**
  1. **Risk stated late and soft.** The leak is disclosed in `Security Considerations` as "an agent that can read the named file can read its neighbours, including `secret`", which is accurate (rung 2, `src/store/errors.ts:32-39` `secret` sits at `<record>/secret` beside `log.ndjson` and, under this RFC, beside `files/`). But the *exploitation* is not spelled out: `secret` is the sole credential that authenticates a driver to the host (`src/store/conversation-host.ts:152-161`, `src/protocol/frames.ts` attach `secret` field). Leaking the record directory is therefore not an information leak but a **credential disclosure** that allows any process that can read the agent's tool output (or that the agent itself colludes with) to attach to the conversation.
  2. **"Serve only from `files/` and validate hex" does not mitigate the agent path.** The MUST in `Security Considerations` about serving blobs to the *browser* (`MUST serve only from files/ and MUST resolve as sha256 hex ... before any filesystem access`) is correct for the HTTP surface (`src/server/server.ts:21` "The record secret never reaches the browser"). It does **not** mitigate the *agent* surface, where the RFC proposes naming `<record>/files/<hash>` as prompt text. The agent is not a browser; it reads the filesystem directly.
  3. **"Copy to a per-turn directory outside the record" is necessary but not sufficient.** Q3's recommendation — copy to a scratch directory and name that — removes the sibling `secret` adjacency if the copy is outside the record. But the RFC does not state: who owns the copy's lifetime, what filesystem permissions it has, whether the agent can still traverse from the copy's directory to the record via symlink or `..` if the scratch is predictable, or whether `hcn`'s `cwd` bleed (F-07) could make a relative path re-enter the record. The recommendation SHOULD be settled before step 3 (the RFC says SHOULD), but step 3 is "Delivery. Inlining into the input, and naming what cannot be inlined" — i.e., the vulnerable step. A SHOULD leaves the vulnerable default (inside-record path) as the shipped behavior until someone decides.
- **Why it matters:** This is the most valuable finding class the brief calls out. A shipped "named" path inside the record turns every non-text attachment into a credential leak. The RFC correctly identifies the leak but buries it in Open Questions and treats the browser blob-serving guard as if it also guards the agent.
- **Rung:** 3 — traced `src/store/errors.ts:30-39`, `src/store/conversation-host.ts:152-161`, `src/server/server.ts:21`, `src/store/log.ts:105-115` blob store location, plus RFC text at `Open Questions` Q3 and `Security Considerations` para 5-6.

### F-10 — Ordering rule is correct, but durability and orphan accumulation are unspecified

- **Section:** `Error Handling` (`E-ATTACH-03` and the "blob first, entry second" rule)
- **What is wrong:** The order "blob first, entry second — so a record never refers to bytes that are not there" is correct (rung 3, traced store transaction pattern at `src/store/log.ts:1050-1150` append discipline). The failure mode the RFC names — "The reverse order produces a log that lies" — is also correct. What is missing:
  1. **No `fsync` / durability contract.** `writeAllSync` at `src/store/log.ts:1044-1052` writes the blob file but the RFC does not require `fsync` before the log append, so a crash between blob write and log append can still leave the entry with a hash that points at a partially written or non-durable blob. The log append itself is `fsyncSync`'d (`src/store/log.ts:1070-1085` pattern), but the blob write is not.
  2. **Orphan blobs on crash after blob write.** Process death between the two writes leaves a blob with no log entry — safe (unreferenced, GC-able) but forever. The RFC never says orphans are tolerated or how they are collected, and `Nothing in lucid removes anything from a record` (`What it does not cover`) means orphans also never leave.
  3. **No atomicity via temp + rename.** The RFC says "write `files/<hash>`" but not whether to write to a temp file and `rename` into place. Without rename, a concurrent attach of the same hash can see a half-written file.

- **Why it matters:** The ordering rule is the kind of whole-document property reviewers are asked to find. The RFC states the order but not the durability that makes the order meaningful.
- **Rung:** 3 — traced `src/store/log.ts:1044-1085` write path and `src/store/store.ts:48-51` creation pattern (temp + rename used elsewhere but not specified for blobs).

### F-11 — `E-ATTACH-04` "not a failure of the turn" contradicts the RFC's own verifiability and reporting claims

- **Section:** `Error Handling` (`E-ATTACH-04`), `Protocol Overview` ("lucid never claims delivery"), `State Machine`
- **What is wrong:**
  1. **Missing not modeled.** The state machine has `stored -> inlined` / `stored -> named`. There is no `missing` state. `E-ATTACH-04` introduces a fourth outcome at send time ("The input names it as missing; the turn proceeds") that the diagram does not cover. A blob that was `stored` and then deleted (e.g., copied without `files/` via wrong tool — RFC's own example) transitions to what? The inlined-vs-named decision was already made at `stored` time (`text: boolean` on the entry), but the content is gone. The RFC does not define the prompt text for the missing case.
  2. **"The turn proceeds" vs. "lucid never claims delivery it did not make".** Proceeding with a turn whose context claims a file that is not there is a form of silent degradation. The RFC says lucid MUST report "what was inlined, what was named, and that whether a named file is opened is up to the agent" — but there is no specified report for "named as missing." The agent receives a prompt that says the file is missing — which is a delivery, but of an error message, not of the context the person thought they sent.
  3. **Hash verification gap.** `Message Formats` says "the log's copy of the hash verifies the bytes." If the blob is missing at send time, the hash cannot be verified, yet the RFC says to proceed. The verification claim is therefore not total.

- **Why it matters:** `E-ATTACH-04` is the RFC's most consequential error-handling choice. It avoids bricking the record (good) but at the cost of sending a turn whose context is not what the person attached. The next reviewer cannot tell whether "turn proceeded" is a success or a degraded success without a defined prompt shape for the missing case.
- **Rung:** 2 — pointed at RFC sections `State Machine` vs `Error Handling`; `src/store/log.ts:105-115` hash contract; `src/protocol/frames.ts:110` `TEXT_MAX` bound that any missing-file message must also respect.

### F-12 — "No *delivered* state" is inconsistent with the inlining path and the reporting requirement

- **Section:** `State Machine` ("There is no *delivered* state, and there MUST NOT be one"), `Protocol Overview`, `Error Handling` ("What is never an error")
- **What is wrong:** The RFC says lucid cannot observe whether an agent opened a named file, so there MUST NOT be a delivered state — correct for named files (rung 3, traced `src/harness/events.ts` — no event signals file read). For *inlined* files, however, the contents *are* the prompt text (`encodeAnnotationBatch` / inlined path at `Implementation Notes` step 3). The prompt text is durably `enqueueInput`'d (`src/protocol/reducer.ts:845-891` `enqueueInput` validates `isWireText`) and the resulting `input` entry is in the log; delivery is the `applied` disposition (`src/protocol/reducer.ts:469-490` input lifecycle). In that sense an inlined attachment *does* have a delivered-equivalent state: the input was applied. The RFC's blanket "no delivered state" conflates "file opened" with "input delivered" and then requires lucid to report "what was inlined, what was named" — which is a delivery-adjacent report that the state machine says must not exist.
- **Why it matters:** Whole-document property: the state machine and the observability requirement pull in opposite directions. An implementer must decide whether to surface "inlined content was delivered as prompt text" as a UI signal; the RFC says both "never claim delivery" and "report what happened."
- **Rung:** 3 — traced `src/protocol/reducer.ts:845-891`, `src/protocol/annotations.ts:94-100`, `src/harness/runner.ts:50-120` disposition Hadamard.

### F-13 — "No per-conversation total" with no deletion and with `TEXT_MAX` is not defensible as written

- **Section:** `Open Questions` Q4, `What it does not cover`, `Implementation Notes`
- **What is wrong:** The RFC states `Nothing in lucid removes anything from a record` and `Q4` leaves the total bounded question open with "No recommendation. Left open deliberately." It also (implicitly, via F-01) leaves the per-file bound undefined, while the codebase actually has a hard per-input bound `TEXT_MAX = 1_000_000` (`src/protocol/frames.ts:110`, `src/protocol/reducer.ts:891`). The combination:
  - Unbounded number of 1 MB (or 25 MB, if that is the intended bound) blobs per conversation
  - No deletion, no GC, no per-conversation quota
  - The log itself already holds `bytes` inline (`src/store/log.ts:166` 1 MB) and the RFC adds a second content type that is *larger* and *secondarily counted* (blob bytes are not `input.text` length, so `TEXT_MAX` does not gate them at attach time if measured separately)

  means a single conversation can grow without bound on disk (rung 1, asserted but follows directly from "nothing removes anything" + additive store). The RFC's Q4 paragraph acknowledges this ("attachments are the first thing that grows without bound") but draws the wrong implication: it frames the per-conversation total as "you may not attach anything else, ever" as the only failure mode. Quota exhaustion has standard answers (LRU orphan GC, per-conversation soft limit with explicit `E-ATTACH-01` variant, or rejecting the *log* append while keeping the blob) that are not discussed. Meanwhile the *inlined* path *does* have a bound — `TEXT_MAX` — so a large text file inlined into `input.text` will be refused at `enqueueInput` (`src/protocol/reducer.ts:891` `isWireText`) even though `E-ATTACH-01` already admitted it. The two bounds (attach-time vs. enqueue-time) are not reconciled.
- **Why it matters:** Storage exhaustion on a "one person, one machine" product is still a defect — it fills the disk, not just the conversation. Leaving both the per-file and per-conversation bounds open while shipping the blob store is shipping the growth without the control.
- **Rung:** 2 — pointed at `src/protocol/frames.ts:110`, `src/protocol/reducer.ts:889-891`, `src/store/log.ts:166`, and RFC text `Open Questions` Q4 + `What it does not cover`.

### F-14 — Text-vs-binary detection and control-character inlining are underspecified

- **Section:** `Security Considerations` ("Text detection reads attacker-influenced bytes ... a file containing control characters MUST NOT be inlined"), `Message Formats` (`text: boolean` on the entry), `Protocol Overview` (inlining path)
- **What is wrong:**
  1. **Detection not defined.** The RFC says detection MUST be on bytes, not extension or media type, and then gives no algorithm. The codebase has no attachment text detector. The artifact path uses `contentType: string` as an opaque field (`src/store/log.ts:184-195` `isArtifactField` checks length/control but not media type semantics). An implementer must invent `isText(bytes)` — charset sniffing, UTF-8 validation, binary heuristics — without guidance or tests.
  2. **Control-character rule overreaches or underreaches.** The RFC says "the record refuses control characters in every field it stores, and an inlined file becomes part of an input." The actual input-text guard is `isWireText` (`src/protocol/frames.ts:282`) which checks only `length <= TEXT_MAX`, **not** `CONTROL_CHARS` (rung 2, `src/protocol/frames.ts:182-183` `CONTROL_CHARS` vs. `src/protocol/frames.ts:282`). `isWireId` does check `CONTROL_CHARS`, but `isWireText` does not. So either the RFC's "refuses control characters in every field" is inaccurate for `input.text`, or inlining a control-char-heavy text file would be refused at `enqueueInput` while the entry claims `text: true`. The RFC never reconciles `text: boolean` (decided at attach time) with the input-text validation that happens at send time.
  3. **`text: false` entry still carries `contentType`/`name` that are attacker-controlled.** The RFC says "lucid MUST NOT treat a `contentType` as trustworthy" (good) but does not say the same for `name`, which becomes a log field and, if ever rendered, an XSS/storage concern.

- **Why it matters:** Inlining attacker bytes into `input.text` is the direct prompt-injection surface. The RFC's security paragraph is the most detailed in the draft and still leaves the decision procedure undefined.
- **Rung:** 2 — pointed at `src/protocol/frames.ts:182-183,282`, `src/protocol/reducer.ts:889-891`, `src/store/log.ts:184-203`, `src/protocol/annotations.ts:94-100`.

### F-15 — Terminology and normative contradictions that survive a whole-document read

- **Section:** `Terminology`, `Message Formats`, `Versioning`, `Open Questions` Q1/Q3, `Security Considerations`
- **What is wrong:**
  1. **"Reference" vs. `AttachedFile`.** `Terminology` defines **reference** as "What names a blob without carrying it: hash, size, media type, filename." `Message Formats` then defines `AttachedFile { hash, bytes, contentType, name, path }` — five fields, not four, adding `path`. The extra field is absolute and inside the record, which is the disclosure Q3 warns about. The term `reference` is never used again after the table (rung 1, asserted via grep — no later `reference` in the RFC body except the state-machine prose).
  2. **"Blob store" vs. `files/`.** Terminology says **blob store** is "The directory inside a record holding blobs." Message Formats and Open Questions Q1 both use `files/` as the concrete name. The RFC's Q1 recommendation is `files/` "because a person reading their own record is the audience" — but the term `blob` is used throughout Security and Error Handling. A whole-document reader cannot tell whether to import `BLOB_DIR` or `FILES_DIR`.
  3. **MUST inside vs. recommendation outside.** `Message Formats` says `files/ MUST be inside the record directory. It MUST NOT be a machine-global location.` Open Questions Q3 then recommends "copy to a per-turn directory **outside** the record and name that," which, if adopted, violates the MUST. The RFC acknowledges this is the one security-consequential question and leaves it as SHOULD before step 3, meaning the normative section and the open question cannot both hold if Q3 is accepted.
  4. **"Per harness" identity not tracked for attachments.** The RFC says a record can be handed between harnesses and capability is `curated`/`medium` (true per `hcn inspect --capabilities` rung 4). Attachments are not harness-scoped: a 25 MB file that is `vision:true` for `claude` is still `named` for `pi`. The RFC never says whether the inlined-vs-named decision is per-attachment or per-send — if the record is handed over, does a previously inlined attachment get re-evaluated?

- **Rung:** 1–2 — pointed at RFC table and sections; `src/store/errors.ts:30-39` record layout; `src/protocol/frames.ts:110` `TEXT_MAX`; no grep hit for `reference` outside Terminology (rung 2 via `grep -n reference` on the RFC file).

### F-16 — `Abstract` and `Introduction` scope over-claim vs. specification

- **Section:** `Abstract`, `Introduction / What this covers`, `Protocol Overview`
- **What is wrong:** The Abstract promises "lucid never tells the person the agent saw something it only offered" and the Overview promises "lucid never claims delivery it did not make." No section specifies the mechanism that enforces this. The UI surface that would prevent a false delivery claim (composer thumbnail state, send receipt wording, annotation batch status) is explicitly left to design (`What it does not cover`: "The interface beyond a thumbnail. Removing ... That is design work and `docs/design-brief.md` is out for design"). The RFC therefore makes a user-visible promise whose enforcement point is not in the RFC.
- **Why it matters:** A reviewer who checks only the protocol sections will conclude the promise holds. It holds only if the design also holds, which the RFC does not constrain.
- **Rung:** 1 — asserted from full-document read; no code path enforces the UI promise.

---

## Cleared — what was checked and found sound

These were verified against the codebase so the next reviewer does not repeat them. Each cites the evidence.

- **C-01 — `hashArtifactBytes` exists and is sha256 hex.** `src/store/log.ts:182-183` `createHash("sha256").update(bytes,"utf8").digest("hex")`. The RFC's "second hash MUST NOT be introduced" is sound reuse. (rung 2)
- **C-02 — `ARTIFACT_BYTES_MAX` and `TEXT_MAX` are both 1_000_000.** `src/store/log.ts:166`, `src/protocol/frames.ts:110`. (rung 2)
- **C-03 — Fold carries unknown `src`.** `src/store/log.ts:606-667` `knownEntry` / `offset = nl+1` unconditional on unknown src; `foldCollect` identical at `src/store/log.ts:747-800`. (rung 3)
- **C-04 — `decodeHarnessLine` carries unknown kinds.** `src/harness/events.ts:78-80` catch-all union, `103-122` `return record as unknown as HarnessEvent`. (rung 2)
- **C-05 — Annotation batch is stored in the log via `input.text`.** `src/protocol/annotations.ts:94-100` `encodeAnnotationBatch` appends ```lucid-annotations fenced JSON to the input text; the input is `enqueueInput`'d and durably `src: "input"`-logged. Patch body is never stored and refuses unknown fields (`src/protocol/patch.ts:86-98` `EDIT_FIELDS` check) — contrast is accurate. (rung 3)
- **C-06 — `hcn` has no attachment channel today.** `node_modules/.bin/hcn run --help` shows only `prompt`, `--prompt`, `--prompt-file` as prompt sources; no image/file/attachment flag. (rung 4)
- **C-07 — `hcn inspect --capabilities` vision/images claims.** `claude`/`codex` `vision:true,images:true` vs `pi`/`muse` `vision:false,images:false`, `source:curated,confidence:medium` (rung 4, ran for all four harnesses).
- **C-08 — `secret` is a credential.** `src/store/store.ts:45,48` random 32-byte hex at `0o600`; `src/store/conversation-host.ts:152-161` `HEX_SECRET` check; attach frame carries `secret` (`src/protocol/frames.ts` `str(r,"secret",ID_MAX)`). (rung 2)
- **C-09 — `StreamTurnOptions` carries `cwd` but headless host does not set it on a turn.** `src/harness/runner.ts:106-112` optional `cwd`; `grep -rn cwd src/modes` shows no assignment in `src/modes/host.ts`. (rung 2)

---

## Not reviewed

- **The GitHub map issue `https://github.com/dungle-scrubs/lucid-v2/issues/183` body and its six decisions.** The issue was not fetched (no authenticated `gh` access in this sandbox; `curl` to the HTML URL returns no structured decision text). The RFC says it "renders the decisions taken on the map and decides nothing new" — whether the rendering is faithful was not verified.
- **Visual design / browser surface beyond `docs/design-brief.md`.** The RFC explicitly defers "interface beyond a thumbnail" to design; no design artefact for attachments was reviewed.
- **Live `hcn` session behavior for resume and `cwd` with attachments.** Running a live harness turn with an attachment would require a built `hcn` harness binary (`claude` etc.) and a real session; not attempted.
- **Performance claim in `Message Formats`** ("Folding a 67 MB log costs 19 ms and 335 MB of resident memory") — measurement method was not re-run; taken as read.
- **Artifact catalog and `contentType` handling for inlined text.** The interaction between `AttachedFile.contentType` and the existing artifact `contentType` path (`src/protocol/artifacts.ts`, `src/server/server.ts`) was not exercised end to end.

---

## Summary of grading

- **Highest-value findings:** F-09 (credential disclosure via inside-record named path) and F-01 (undefined `ATTACHMENT_BYTES_MAX`) — either alone blocks a safe implementation.
- **Whole-document class:** F-10 through F-16 are properties only a whole-document read can find (state named but not in machine, field defined but not validated, normative MUST vs. open-question SHOULD contradiction, Introduction promise with no later specification).
- **Drift findings:** F-02, F-03, F-04, F-07 confirm or correct the RFC's claims about how lucid already works; each cites `file:line`.

---

*Review produced without editing the RFC. File under review recorded above; this review is stale if that file changes.*
