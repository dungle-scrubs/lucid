# Code review: RFC 30 implementation

Read the RFC v3 and all changed sources plus the three test files. No shell access in this session, so `git diff` and `bun test` were not run; every claim below is from reading code. No files edited (read-only review).

## Findings

### C1 - minor: `claudeContextSlice("")` deviates from the RFC

RFC section 3: unset yields 24,000; a decimal integer yields `min(24000, floor(0.8*value))`; **any other value** yields no slice.

[invocation-adjacent code](/Users/kevin/dev/lucid/src/cli/native-listening.ts:44) treats empty string as unset:

```ts
if (raw === undefined || raw === "") return CLAUDE_CONTEXT_SLICE;
```

`""` is not unset and not a decimal integer, so strictly it should return `undefined`.

Fix: change to `if (raw === undefined) return CLAUDE_CONTEXT_SLICE;` (empty string then fails the digit regex and returns `undefined`), or amend the RFC to bless `""` as unset. Harmless in practice; the existing test at [claude-delivery.test.ts:635](/Users/kevin/dev/lucid/test/cli/claude-delivery.test.ts:635) pins the current behavior, so update the test with whichever reading is chosen.

### C2 - minor: held notice keys off `held` presence instead of `reason === "expired"`

[claude.ts:311-312](/Users/kevin/dev/lucid/src/cli/hooks/claude.ts:311):

```ts
const [first] = result.kind === "stopped" ? (result.held ?? []) : [];
if (result.kind === "stopped" && first) { ...notice... }
```

Correct today because [native-listener.ts:298](/Users/kevin/dev/lucid/src/modes/native-listener.ts:298) attaches `held` only on `expired`. But the RFC's "no notice when interrupted" guarantee then rests on the producer. A future path that attaches `held` to an interrupted result would notify a person who already moved on.

Fix: gate on the reason explicitly:

```ts
if (result.kind === "stopped" && result.reason === "expired" && first) {
```

### C3 - major (test gap): copy-text equality with the inline context is not asserted

Acceptance requires "a copy whose text equals the inline rendered context." The large-document test ([claude-delivery.test.ts:507-522](/Users/kevin/dev/lucid/test/cli/claude-delivery.test.ts:507)) reassembles slices and asserts `contains(document)`, `endsWith(feedback)`, and `delivery.bytes` equality. That is strong but not equality: a copy that wrapped, reordered, or duplicated the rendered text could pass.

Fix: prepare the same input with a generous `maxBytes` (inline path), extract the rendered section from that payload, and assert byte equality with the reassembled copy text. The implementation itself is correct by construction (the same `rendered` variable feeds both `transport.encode` and `offerContext` at [native-preparation.ts:224-236](/Users/kevin/dev/lucid/src/modes/native-preparation.ts:224)); only the proof is missing.

### C4 - minor (test gap): no replay test for a recorded reference response without the copy

"The recorded response replays without the copy" is untested. The code is correct: the copy check lives only in the live `controlConnection` produce callback ([conversation-host.ts:1389-1404](/Users/kevin/dev/lucid/src/store/conversation-host.ts:1389)), while the reducer's `offer-outcome` branch ([connection.ts:1530-1561](/Users/kevin/dev/lucid/src/protocol/connection.ts:1530)) has no filesystem read, so a fold replays deterministically.

Fix: fold a log containing a reference `offer-started` + `offer-outcome` with the copy deleted and expect `finished`. Low risk, but it is the determinism claim; pin it.

### C5 - minor (test gap): no explicit Codex no-reference case

"A Codex transport builds no reference offer" has no named test. The behavior is covered generically (a transport without `contextSlice` holds with `context-too-large` at [connection-delivery.test.ts:2540](/Users/kevin/dev/lucid/test/store/connection-delivery.test.ts:2540), and the Codex transport declares no slice at [native-listening.ts:61-64](/Users/kevin/dev/lucid/src/cli/native-listening.ts:61)), and Codex hook output is correctly unchanged (its dispatcher handles only `offered`/`held`, so `stopped`+`held` stays silent per spec).

Fix: one case calling `prepareNativeFeedback` with the Codex-shaped transport on oversized input, expecting `held`/`context-too-large` and no new `lucid-context-offer-*` directory.

### C6 - minor: refused `context-unread` discards its own `nextOffset`

`nativeContextReadIssue` returns `{ kind: "context-unread", nextOffset }` ([context-offer.ts:357](/Users/kevin/dev/lucid/src/store/context-offer.ts:357)), but the caller keeps only the kind ([conversation-host.ts:1403](/Users/kevin/dev/lucid/src/store/conversation-host.ts:1403)) and the message tells the session to "follow nextOffset" without its value.

Fix: append the resume point, e.g. in [connection-control.ts:65](/Users/kevin/dev/lucid/src/cli/connection-control.ts:65): `"... Follow nextOffset until done is true. The copy has been read contiguously to offset ${nextOffset}; resume from there."` Requires threading the number through `controlConnection`'s `{ issue }` return. RFC does not require it; purely session UX.

### C7 - minor: `readContextProgress` trusts the directory to its callers

[context-offer.ts:312-340](/Users/kevin/dev/lucid/src/store/context-offer.ts:312) opens `join(path, PROGRESS)` with `O_NOFOLLOW`, but that flag covers only the final component; a symlinked copy directory would redirect the read. Both current call sites check the directory first (`readOfferedContext` at :260-264, `nativeContextReadIssue` at :379-380), so no live bug, but the function is exported.

Fix: `lstatSync` the directory inside `readContextProgress` (private, uid-owned) and return 0 otherwise, or document the caller contract in its docstring.

### C8 - minor: `nativeContextReadIssue` never checks the `LUCID_CONTEXT_V1` header

It verifies directory privacy/ownership, file regularity/`nlink`/mode/ownership, and `size - HEADER.length === bytes` ([context-offer.ts:380-389](/Users/kevin/dev/lucid/src/store/context-offer.ts:380)), but not header content. A header-corrupt copy of the right size yields `context-unread` forever instead of `context-missing`. The `failure` exit still closes the offer, so no deadlock.

Fix: read and compare the header bytes; return `context-missing` on mismatch.

### C9 - minor: ready-at-expiry silently discards a deliverable offer

[native-listener.ts:262-264](/Users/kevin/dev/lucid/src/modes/native-listener.ts:262): if preparation succeeds exactly as the wait expires, the offer is discarded and the listen returns `expired` with empty `held`, so no notice. Feedback stays saved and a later `resume-listen` retries, but the person gets zero indication. Same for a refused `listener-disabled` write at :296-300, which drops accumulated `held`.

Fix (optional): leave behavior, but record the case in a comment, or return the expired result with a synthetic held entry pointing at the unattempted input. Rare timing window; retry path is intact.

## Checked and found correct (no finding)

- Inline path bytes: the inline payload uses one shared construction (`rendered` + `offerBlock` + `transport.encode`); the reference branch only reassigns `payload` when oversized, and the fact gains `delivery` only then. Byte-identity holds by construction, though no golden test pins it (see C3/C10 - covered by C3's fix direction).
- Copy lifetime: every hold path after a copy exists calls `discard()` (attachment-oversize at :212-220, second encode failure, reference-oversize at :258-266); the listener discards on abort/expiry (:263) and on failed dispatch (:289); the host removes the copy on accepted response and reaps finished-offer copies on open. The `offerContext` throw path returns without `discard`, but nothing exists to discard there.
- Response check: parses the fact first and skips the copy check on parse failure, so malformed answers refuse as `invalid-connection` before any copy logic (tested); owner comes from the offer's participation registration, matching the preparation owner; refusal/failure skip the check.
- Progress: served-but-uncounted out-of-order reads, reread idempotence, `atomicSidecar` semantics (O_EXCL|O_NOFOLLOW, 0600, fsync, rename, dir sync), and the strict progress-file validation all match section 2.
- Held notice: text, singular/plural, `held` ordering, and the offered/interrupted/block-cap exclusions match section 5; dispatcher maps `notice` to `systemMessage` ([dispatch.ts:227](/Users/kevin/dev/lucid/src/cli/dispatch.ts:227)).
- `delivery.bytes` domain (post-header byte length) is consistent between preparation (`Buffer.byteLength(rendered)`) and lookup (`file.size - HEADER.length`).

## Verdict: ship with fixes

No blocking findings. C3 is the one gap worth closing before ship (the RFC's central equality claim lacks an equality assertion). C1, C2, C6-C9 are minor robustness/UX items safe to defer; C4 and C5 are cheap test pins.