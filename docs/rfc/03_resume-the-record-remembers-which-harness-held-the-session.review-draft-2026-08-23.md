## What was reviewed

Draft reviewed: `docs/rfc/03_resume-the-record-remembers-which-harness-held-the-session.rfc.md` — frontmatter `status: Draft`, `date: 2026-08-23`, no `version` field — on branch `docs/rfc-03-resume` at `/Users/kevin/dev/lucid-v2`.

Full read of the RFC plus the code it changes:

- `src/protocol/frames.ts` — `attach` / `attach-ok` / `AttachProfile` / `PROTOCOL_VERSION` / `ProtocolIssue` / validators
- `src/protocol/reducer.ts` (~line 53 `Attachment`, attach path `reduceAttach` line 373, `fold`/`ChannelState`/`TransitionRecord`/`Presence`)
- `src/protocol/events.ts` and `src/harness/events.ts` — `EventKind.identity`, `classOfEventKind`, `HarnessEvent` shape
- `src/modes/host.ts` — `sessionStrategy` / `turnStrategy` (`resumeId` in-memory capture line 165)
- `src/modes/sequencer.ts` — `createSequencer` attach handshake line 81, `attach-ok` consumption
- `src/harness/runner.ts` — `OpenSessionOptions` / `StreamTurnOptions` / `HarnessName`
- `src/harness/hcn-runner.ts` — `openSession` argv `--session-id` and `streamTurn` argv `--resume`
- `src/store/conversation-host.ts` and `src/store/log.ts` — `foldLog`, `applyEntry`, `collectTranscript`, `Transact` seam
- `spikes/evidence/resume.md` and `spikes/evidence/cross-harness-handoff.md`
- `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` — seam context

No file was edited. No credential file was read. No command was run that required install or auth (writes/shell are disabled for this session, findings are code-pointed at `file:line` and execution-traced, not tool-run).

---

## Findings

### 1. blocking — Protocol Overview / Message Formats / Finding the id — the proposed descending-seq walk has nowhere to read from

**What is wrong:** The RFC requires `lucid MUST derive resumeSessionId` by walking accepted `event` frames in descending `seq`, skipping non-`identity` payloads and skipping events whose attributed harness differs (RFC `## Message Formats — Finding the id` steps 1-5, `## Protocol Overview` rules 3-4).

The reducer has no store for that attribution:

- `src/protocol/reducer.ts:53` `Attachment` is `{profile, lastN, lease}` — no `harness`.
- `src/protocol/reducer.ts:84` `ChannelState` keeps only the *current* `attachment` (and `turn`/`seenTurns`/`inputs`/`credits`). It does not keep history of past attachments or a `map seq -> harness`.
- `src/protocol/reducer.ts:137` `TransitionRecord` and `src/store/log.ts:88` `TranscriptEvent` carry `seq/epoch/turnId/event` — no `harness`.
- `src/store/log.ts:48` `LogEntry` (`src: "frame"` field `frame`) stores the raw `event` frame's `event` payload opaquely — the reducer never writes attributed harness back into the durable entry.
- `src/store/log.ts:213` `foldLog` rebuilds `ChannelState` by replaying `applyEntry -> reduce`. After `reduceAttach` creates a new `attachment` the *old* attachment is discarded (`src/protocol/reducer.ts:428` `attachment: {profile, lastN:0, lease}` replaces prior). Any harness that held a prior epoch is gone after the epoch increments.

A fold therefore cannot walk historical `event` frames and know which harness was live when each was accepted without additional persisted state. The RFC's "MUST keep it for the life of that attachment" (rule 2) keeps it exactly as long as it is useless for the search — the search needs it *after* the attachment is gone.

**Why it matters:** As specified, `attach-ok.resumeSessionId` cannot be implemented. A naïve implementation that scans `TranscriptEvent.event.kind === "identity"` and looks at current `state.attachment.harness` will either always match or always miss, and in cross-harness records (the motivation from `spikes/evidence/cross-harness-handoff.md`) will resume the *wrong* harness's id — the exact failure the RFC exists to prevent. The fix requires persisting harness per accepted `event` (e.g. `TransitionRecord.harness` + `LogEntry` extension, or a `harnessBySeq` map in `ChannelState`, or storing `harness` on an extended `Attachment` that is also appended to the log and never truncated on `foldLog` recovery).

**Evidence level:** 3 — traced execution from `src/store/log.ts:151` `applyEntry` through `src/protocol/reducer.ts:373` `reduceAttach` and `src/store/log.ts:213` `foldLog` loop; pointed at `file:line` above. (Not run — level 4 would be a throwaway script folding a synthetic cross-harness log and observing the missing field.)

### 2. blocking — Versioning — incrementing `PROTOCOL_VERSION` breaks the "old records still fold" claim

**What is wrong:** `src/protocol/reducer.ts:47` `PROTOCOL_VERSION = 1`. `src/protocol/reducer.ts:385` `if (frame.version !== PROTOCOL_VERSION) return refusal(..., "version-unsupported", ...)`. Equality, not `>=`.

The RFC `## Versioning` says:

> Both new fields are OPTIONAL in the wire types, so an existing `log.ndjson` still decodes and folds. Events recorded before this RFC carry no attribution and are skipped.

Decoding (`src/protocol/frames.ts:254` `attach` decoder, line 259 `version: nat(r,"version")`) would indeed still decode. Folding would not — `src/store/log.ts:152` `applyEntry` calls `decodeFrame` then `reduce` on *every* durable attach entry. An old record's attach with `version: 1` replayed against a reducer now at `2` is refused (`version-unsupported`) inside `foldLog`, which `src/store/log.ts:240` throws as `StoreError("fold-refused", ...)` — the store fails to open every pre-RFC conversation. The RFC conflates wire-decodability with fold-acceptability.

**Why it matters:** A version bump as described is a breaking data migration, not the backward-compatible OPT-in the RFC promises. The running system before this RFC has `seq` and `epoch` records on disk; a correct design must either keep `PROTOCOL_VERSION` at `1` and treat `harness` as additive-optional without version fencing, or change `reduceAttach` to accept `<= PROTOCOL_VERSION` for historical entries and only refuse *new* attaches with old versions, or version the *log entry* separately from the *wire* version.

**Evidence level:** 2 — pointed at `src/protocol/reducer.ts:47` + `src/protocol/reducer.ts:385` + `src/store/log.ts:240`. (Level 3 trace: `readFoldRepair -> foldLog -> applyEntry -> reduce -> refusal` path.)

### 3. major — Conflicting normative statements — rules 3, 5 and R005 cannot all hold as written

**What is wrong:**

- Rule 5 (`## Protocol Overview`): `A source MUST NOT use a resumeSessionId it derived itself... only the reducer sees attribution.`
- Rule 3: `An event carrying an identity is attributed to the harness on the attachment that was live when it was accepted. The protocol does not re-derive this later; the fold does it as it goes.`
- R005 (`## Error Handling`): `The identity event carries an id lucid did not ask for. lucid MUST record the new id as the current session (it is what the harness actually has) and MUST emit an error event noting the substitution.`

R005's "new id" is supplied by the harness in its `identity` event payload (`src/harness/events.ts:39` `sessionId`), not derived by the reducer from the transcript. The reducer has no way to distinguish "harness honoured the resume" vs "harness substituted" except by reading the payload it otherwise treats as opaque (`src/modes/host.ts:222` identity capture). So the source *must* derive from the harness event, which rule 5 forbids, and rule 3's "attributed at acceptance" is after the harness has already chosen.

Also R005's mandated `error` event is itself an `event` frame from the source — it would be attributed to the same harness, polluting the next resume search (the most recent `identity` by `seq` is still the substituted one, but now there is also a trailing `error` at higher `seq`; walk step 2 "skip any whose payload is not an identity" handles it, but the spec never says the `error` event must not carry an `identity` kind, and the walk's ordering relative to the substitution's `seq` is not enumerated).

**Why it matters:** Implementors must break one MUST to satisfy another. The intended invariant — "the next resume targets exactly the session the harness confirmed" — is not expressed as a single derivation rule.

**Evidence level:** 2 — pointed at RFC `## Protocol Overview` rules 3/5 + `## Error Handling` R005 vs `src/harness/events.ts:39` + `src/protocol/reducer.ts:500` event path (payload opaque).

### 4. major — Scope / Implementation Notes — steps 1-4 cannot deliver "turn-mode resume against released hcn" as claimed without underspecified host wiring

**What is wrong:** `## Introduction` + `## Implementation Notes` claim `The turn-mode half is testable against hcn 0.5.5 today. The session-mode half is blocked on the hcn release, and the RFC is written so that landing steps 1-4 delivers turn-mode resume without waiting for it.` Steps 1-2 are `frames.ts` + `reducer.ts`; steps 3-4 are `sequencer.ts / host.ts` passing harness on attach and surfacing `resumeSessionId`.

Current code:

- `src/modes/sequencer.ts:81` `createSequencer` sends `attach {conversationId, profile, secret, version, resumeFrom}` — no `harness`, and its return extracts `epoch` and `attachReplay` (line 96-99) but never reads `resumeSessionId` from the `attach-ok` effect (`src/protocol/reducer.ts:442` `attach-ok`).
- `src/modes/host.ts:159` `turnStrategy` seeds `let resumeId: string|undefined = deps.resume` (line 165) and passes `...flag("--resume", resumeId)` to `src/harness/hcn-runner.ts:136` `streamTurn`. `createHeadlessHost` (line 273) accepts `deps: HeadlessDeps & {sessionId?, resume?}` but no caller ever supplies `resume` from a folded transcript — `resumeId` is only populated from observed `identity` events at line 222 *within* the running source (`resumeId` is in-memory, noted in RFC `turnStrategy`'s `resumeId` comment as does-not-survive restart).
- `src/harness/runner.ts:78` `OpenSessionOptions` has `sessionId` but no `resume` — RFC step 5 says to split them, but step 4's claim that "session mode passes it to `openSession` as a resume" requires that new field to exist *and* `src/harness/hcn-runner.ts:168` `openSession` to map it to `hcn session --resume` (today it only maps `--session-id` line 174, not `--resume` per `spikes/evidence/resume.md` and abstract ticket #97/99).

So even after the RFC's "harness on attach" is added, turn-mode resume requires a *new* read path: `attach-ok.resumeSessionId -> TurnSequencer -> HeadlessHost.turnStrategy resumeId` before the first `streamTurn`. That read path is described only as "surface the resumeSessionId from attach-ok to the strategy" with no error case (what if `attach-ok` has no field?), no ordering with `resumeFrom`, and no `deps.resume` source. An implementor following steps 1-4 verbatim would still start every reopened turn with `resumeId = undefined` and never hit `hcn run --resume`.

**Why it matters:** The incremental delivery claim is the RFC's main scope control. If turn-mode resume needs host plumbing that the RFC waves as "steps 3-4", the claim misleads planning and the `scripts/smoke-resume.ts` gate ("first for turn mode, then for session mode") will remain red after the supposedly sufficient slice.

**Evidence level:** 3 — traced `src/modes/host.ts:159` + `src/modes/sequencer.ts:81` + `src/harness/hcn-runner.ts:129` + `src/store/log.ts` fold path; pointed at `file:line`.

### 5. major — State Machine / Error Handling — uncovered lease, epoch, and second-attacher states

**What is wrong:**

- The State Machine (RFC `## State Machine`) enumerates `DETACHED -> ATTACHING -> {FRESH, RESUMING, REFUSED}` and `RESUMING -> {ATTACHED, FRESH}` but Error Handling enumerates `R001` (headless attach with no harness), `R002` (unknown `resumeSessionId`), `R003` (newest identity belongs to different harness), `R004` (duplicate `seq`), `R005` (substituted id). It *omits* the reducer's existing refusal reasons that also land in `REFUSED`: `auth-failed`, `wrong-conversation`, `version-unsupported`, `lease-held`, `presence-holds`, `resume-ahead-of-log` (`src/protocol/reducer.ts:382-408`). A reader cannot tell whether those older refusals keep their issue names or are collapsed into `invalid-grant` (R001).
- Conversely, R003's "info" case — record's newest identity is from a different harness, `attach-ok` reports no `resumeSessionId`, source opens fresh — has no distinct state; the machine merges it into `ATTACHING -> FRESH` indistinguishably from "record has no identity at all". That loses the signal needed for `## Open Questions` #2 (automatic vs opt-in resume) and for callers that might want to do cross-harness handoff prompt composition only when R003 fires.
- Not covered: attach races during `RESUMING`. `src/protocol/reducer.ts:390` refuses second attach with `lease-held` while live. After lease expiry, `epoch` increments on the next successful attach (`src/protocol/reducer.ts:410`). If source A is in `RESUMING` awaiting hcn's `identity` and source B wins the next attach, A is still `RESUMING` but its `epoch` is now stale; its next `event` will be refused as `stale-epoch` (`src/protocol/reducer.ts:476`). The machine has no `RESUMING -> DETACHED` via takeover. Similarly, a successful takeover mid-`RESUMING` should force `ATTACHING -> REFUSED` for stragglers, but the machine shows only initial `ATTACHING` branching.
- Two concurrent same-harness attachers racing after lease expiry would both compute the same `resumeSessionId` from the fold (fold is done pre-attach) and both would `hcn run --resume <same id>` concurrently, violating `src/protocol/reducer.ts` single-writer epoch fencing *below* lucid and harness-side single-session semantics. The RFC's rule 7 ("Resume is an attach-time decision. MUST NOT change mid-attachment") does not prevent two attachments from both deciding to resume the same session.

**Why it matters:** The attach path is the only place resume is decided, so races on that path determine whether the wrong session is continued.

**Evidence level:** 2 — pointed at `src/protocol/reducer.ts:390` + `src/protocol/reducer.ts:476` + RFC `## State Machine` vs `## Error Handling`.

### 6. major — `resumeFrom` / `ack` / `resumeSessionId` interaction is underspecified and risks silent queue loss

**What is wrong:** `src/protocol/reducer.ts:404` already has an `attach` field `resumeFrom` (exclusive replay watermark) with refusal `resume-ahead-of-log`. The RFC adds `resumeSessionId` to `attach-ok` but never says how `resumeFrom` and `resumeSessionId` interact. `src/store/log.ts:246` folds inputs independent of harness session, and `src/protocol/reducer.ts:417` replays `state.inputs` filtered by `resumeFrom`/`acked`. If a source resumes a harness session but also supplies a stale `resumeFrom`, the log replay and the harness's own replay could diverge (harness replays from its own offset, lucid replays from `seq`). The RFC's step 1-4 turn-mode path has `resumeFrom = undefined` (hence `0`), but a future session-mode resume with `resumeFrom` and `resumeSessionId` simultaneously would need ordering rules that are absent. Also `R002`'s recovery ("fall back to fresh, record an error event") does not say which `seq` the error event occupies nor how `resumeFrom` is rebased after the fallback.

**Why it matters:** Without a rule, a bad `resumeFrom` can silently drop the un-applied input queue (the replay gating comment at `src/protocol/reducer.ts:417` warns exactly that trusting a source claim would drop the queue). Adding a second attach dimension doubles that risk.

**Evidence level:** 2 — pointed at `src/protocol/reducer.ts:404` + `src/protocol/reducer.ts:417` + `src/store/log.ts:174` input replay.

### 7. minor — `harness` validation and wire shape leave an `interactive` gap

**What is wrong:** `src/protocol/frames.ts:253` `DECODERS.attach` validates `profile` against a closed enum but does not yet validate `harness`. The RFC says `harness MUST be validated against the closed set of known names before it reaches the reducer, the same way profile is` (`## Security Considerations`) and that `attach`'s `harness` is OPTIONAL so older sources still decode. The wire type change therefore needs `optEnumOf` for `harness?: HarnessName` with the four names (`HarnessName` at `src/harness/runner.ts:22`). The RFC never names the refusal issue for an *unknown* harness string vs a missing one: R001 is `invalid-grant` for missing; an unknown name should also be `invalid-grant` (or `wrong-type` at decode) but the decode-vs-reduce layer boundary is not specified. Also, an `interactive` attach that *does* supply a harness is not defined — should the reducer store it or ignore it? Today `src/protocol/reducer.ts:53` has no harness, so the question is absent; after the RFC the durable attribution for interactive-originated events would silently vary depending on caller.

**Why it matters:** A typo'd harness (`"claue"`) that decodes as an unknown enum at `wrong-type` (decode) vs `invalid-grant` (reduce) surfaces differently to the operator (`TransitionRecord.issue` wiring at `src/protocol/reducer.ts:271`), and a silently-ignored interactive harness would make the next headless attach's skip logic (`## Finding the id` step 3) non-deterministic.

**Evidence level:** 2 — pointed at `src/protocol/frames.ts:253` + `src/harness/runner.ts:22` + RFC `## Message Formats` + `## Error Handling` R001.

### 8. minor — `resumeSessionId` wire validation and presence semantics

**What is wrong:** `src/protocol/frames.ts:283` `attach-ok` decoder validates `lease` shape and `replayFrom`/`version` with `nat`, but the RFC's new `resumeSessionId?: string` has no stated wire bound. `src/harness/events.ts:39` harness session ids are opaque but `isWireId` (`src/protocol/frames.ts:249`) already bounds ids to `ID_MAX=128`. The spec should require `isWireId` for `resumeSessionId` and specify that `absent means no session of yours` (RFC `## Message Formats — attach-ok, extended`) does not distinguish "no session" from "record empty" — both are `absent`, which is probably correct but leaves the host with no observable distinction for metrics.

**Evidence level:** 2 — pointed at `src/protocol/frames.ts:283` + `src/protocol/frames.ts:88` + RFC `## Message Formats`.

---

## Cleared

What was checked and found sound (level 2 — pointed at code, or trace-level 3 where noted):

- **The gap itself is real.** `Attachment` (`src/protocol/reducer.ts:53`) has no harness, `frames.ts` has no harness anywhere, and `src/modes/host.ts:165` keeps resume only in a per-source local `resumeId`. The RFC's diagnosis that lucid cannot safely map a `sessionId` on a durable `identity` event (`src/harness/events.ts:39`) back to `claude|codex|pi|muse` matches the implementation. Level 3 — traced `host.ts:222` identity capture -> `turnStrategy` local vs `src/store/log.ts` transcript.
- **Cross-harness handoff history makes the most-recent-identity heuristic unsafe.** `spikes/evidence/cross-harness-handoff.md` proves `claude->codex` and similar passes, so the most recent `identity` by `seq` is routinely not the attaching harness's. The RFC's attribution requirement (rule 3 + Finding the id step 3) correctly addresses that. Level 2.
- **Old events must be skipped, not guessed.** The RFC's decision to treat unattributed historical events as unresumable (`## Message Formats — Finding the id` para 2, `## Open Questions` #4) matches `## Security Considerations` blast-radius reasoning and avoids heuristic misattribution. Level 2.
- **`resumeSessionId` as the sole source of truth.** Rule 5 (only reducer derives; source must consume `attach-ok`) is the right divergence avoidance. The seam is `src/modes/sequencer.ts:81` as the single attach issuer and `src/store/conversation-host.ts:229` as the durable host. Level 2.
- **`interactive` must remain optional.** `src/protocol/reducer.ts:398` `presence-holds` and the reducer comment that `presence` is interactive-only (`src/protocol/reducer.ts:175`) justify leaving `harness` optional for `interactive`. Level 2.
- **Harness name is a closed set already.** `src/harness/runner.ts:22` `HarnessName` is exactly the four names the RFC names; validation belongs at the codec seam as stated. Level 2.
- **Turn-mode `hcn run --resume` exists today, session-mode does not.** `src/harness/hcn-runner.ts:136` `streamTurn` forwards `flag("--resume", opts.resume)` while `src/harness/hcn-runner.ts:168` `openSession` has only `--session-id` — matches RFC abstract's split (issue #86/#97) and `spikes/evidence/resume.md:19`. Level 2.

---

## Not reviewed

- Credential or secret material (`~/.npmrc`, `~/.aws`/`~/.config`, `.env`, ssh private keys, 1Password CLI) — not read, per hard rule. No install or auth command was run; the "say so and stop" gate was not triggered because no such command was attempted (writes/shell are disabled in this session).
- Networked `hcn` behaviour on ticket #97 (`hcn session --resume`), ADR 0007, or harness-cli-normalizer repo internals beyond what lucid pins — read only references in the RFC, not external state.
- Full `bun test` / `bun run check` matrix or running `scripts/smoke-resume.ts` against a live harness — would be level 4 evidence for many findings but is out of scope for this read-only, no-shell session (would be throwaway `bun test` under `/tmp` per protocol; not performed here). Reported levels are capped at 3 accordingly.
- Exhaustive property-test of all `FrameKind` paths unrelated to `attach`/`event`/`attach-ok` (credit/heartbeat/detach replays).


