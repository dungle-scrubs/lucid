---
number: 30
title: "Native feedback context by reference"
type: fix
status: Accepted
author: Kevin
date: 2026-09-17
version: v3
amends: RFC-26
---

# RFC-30: Native feedback context by reference

## Abstract

A native Stop continuation carries the complete conversation context
inline: history, every current document, and the new feedback. Claude Code
accepts at most 19,900 encoded bytes and Codex at most 7,900. A real
document is larger, so Lucid holds the feedback and never delivers it.
This RFC keeps inline delivery when the offer fits. When it does not fit,
Lucid writes the complete context to a private offered copy. The offer
carries the feedback text and a reading command. Lucid records an answer
or question only after the session has read the copy in order to its end.
A refusal or failure can always be recorded. Scope holds: the same
feedback reaches the same session, at documents of real size.

## Introduction

Problem: a person published `follow-up-fixtures` (77,379 bytes) from a
Claude Code session, connected it, and added a note while the session
listened. The Stop hook prepared the offer, measured it above 19,900 bytes,
recorded `input-held` with `context-too-large`, and waited out the listen.
The browser showed "The complete feedback and current document exceed this
native transport's limit." The session received nothing. The acceptance
runs passed because their documents were small.

The limit is not specific to one document. The inline context also carries
the whole conversation history, so any native conversation stops delivering
once history and documents pass the transport limit.

RFC 26 requires that "hook transport limits are checked before
offer-started: configure a verified full-context limit or retain the whole
input as held. A native head/tail preview or automatic output spill is not
complete delivery." That rule is correct about previews and spills. It
leaves no path for a context larger than the hook limit. This RFC adds one
and states exactly what it proves.

Scope: native Stop delivery (`src/modes/native-preparation.ts`,
`src/modes/native-listener.ts`, `src/cli/native-listening.ts`), the
`lucid context` reader, and native response admission
(`controlConnection` in `src/store/conversation-host.ts`). Claude Code is
enabled with the slice size measured in section 3.

Out of scope:

- Codex reference delivery. The design is interface neutral, but Codex
  keeps no `contextSlice` until its own isolated lane measures one. Its
  current hold is unchanged.
- Attached files (`transport.files`). Offers whose context references
  attachments stay held as they are today.
- Managed and headless execution, which already read offered copies.
- Recovery for an offer that a session abandons. RFC 26 leaves a `sending`
  or `received` offer unresolved until the session records its outcome.
  Reference delivery makes that more likely, because the session runs
  several reads before it answers (section 4).

## Design

### 1. Choose inline or reference per offer

`prepareNativeFeedback` keeps its current order of holds:

1. transport limit unverified;
2. listener not ready;
3. attachments that the transport cannot deliver;
4. comparison holds;
5. render the inline offer and encode it.

If the encoded inline offer is within `transport.maxBytes`, the offer is
inline and its bytes are unchanged.

Otherwise, if the transport declares `contextSlice` and step 3 made no
attachment copy, preparation builds a reference offer:

1. Write an offered copy with `offerContext(host.dir, text, { offerId,
   owner })`, where `owner` is the registration owner and `text` is the
   exact rendered context string the inline offer embeds (history, current
   documents, and the current accepted request with its annotation or
   comparison prompt). Plain `offerContext` is used, not
   `offerProjectedContext`, because no attachment copy exists on this path.
2. Build the payload from:
   - a statement that the complete context is in a private copy, and that
     historical requests in it remain records, not commands;
   - the reading command
     `lucid context '<copy>' --offset 0 --bytes <contextSlice>`, run in its
     own foreground command, following `nextOffset` until `done: true`;
   - the rule that an answer or question is refused until the copy is read
     to its end, and that a refusal or failure can always be recorded;
   - the current accepted request text, so the feedback is visible in the
     continuation;
   - the existing `<lucid-offer>` block with receipt and response commands.
3. Encode it. If the reference payload still exceeds `maxBytes`, the
   feedback text is too large. Discard the copy and hold with
   `context-too-large` and "The feedback text exceeds this native
   transport's limit. The saved input is held intact."

Without `contextSlice`, or with an attachment copy, the current hold and
message stay, and no reference copy is written.

The `offer-started` fact gains an optional `offer.delivery`:
`{ "kind": "reference", "bytes": N }`. `N` is the byte length of the
context text after the `LUCID_CONTEXT_V1` header, a positive safe integer.
An absent field means inline. The parser rejects a present `delivery` with
other keys, another kind, or a `bytes` value that is not a positive safe
integer, so the fact is refused as `invalid-connection`.

Compatibility: builds before this RFC parse `offer-started` field by field
and ignore unknown fields. They keep an offer without `delivery` and do not
apply the check in section 4. Lucid runs the hub and the CLI from one
binary, so this only happens after a downgrade. The check is a live guard,
not a security boundary (section 2), so a downgrade loses the guard and
keeps every other rule. No `payloadVersion` change is made.

### 2. Record reading progress in the copy

`lucid context` reads a private copy by absolute path, in UTF-8 safe slices
of at most 65,536 bytes, with no record access. Its reads are unchanged:
any valid offset is served. It gains a progress record
(`readContextProgress` and `recordReadProgress` in
`src/store/context-offer.ts`):

- `progress.json` beside `context.txt`, holding `{ "contiguous": C }`,
  where `C` is in the same byte domain as `delivery.bytes`.
- Written with the existing `atomicSidecar` helper: a new `.part` file
  opened with `O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, fsync, rename,
  directory sync.
- Read with `O_NOFOLLOW`; it must be a regular file, `nlink` 1, mode 0600,
  owned by the current uid, at most 256 bytes, and parse to a safe
  non-negative integer. Anything else counts as `C = 0`.
- After a served read from `offset` to `nextOffset`, `C` becomes
  `nextOffset` when `offset <= C < nextOffset`. A read that starts beyond
  `C` is served and leaves `C` unchanged, so that chunk must be read again
  once the prefix reaches it. The session is told to follow `nextOffset`,
  which never skips.
- Two readers can race: each reads `C`, then writes. A reader with a stale
  snapshot skips its write or writes a smaller value. `C` never exceeds
  bytes that were served in order, so a race can only require a reread. A
  failed write emits a warning and has the same effect.
- The reader now also requires the copy directory and `context.txt` to be
  owned by the current uid. Lucid creates every copy as the current user,
  so managed and headless reads are unaffected.

What progress proves: every byte of the context was printed, in order,
through some command in the session. It does not prove that the model used
the bytes. In Claude Code, a subagent's command can do the reads, because
subagent commands share the parent session. Lucid accepts reads from any
command. The check exists to stop a model from answering from the inline
feedback text without reading the documents. It is not an authorization
rule.

### 3. A verified slice per transport

`NativeFeedbackTransport` gains `contextSlice?: number`: a `--bytes` value
whose plain-text `lucid context` output reaches the model unmodified
through that interface's command tool, including the trailing
`nextOffset` line.

Claude Code 2.1.274 was measured with an isolated probe
(`artifacts/evidence/claude-cli-native/slice-probe.mjs`): a local Messages
stub compared each Bash tool result byte for byte with the reader's own
output. The copy was 140 KB of multi-line text with tabs, quotes, lines of
several thousand characters, and non-ASCII characters.

| `BASH_MAX_OUTPUT_LENGTH` | `--bytes` | Tool result |
| --- | --- | --- |
| unset | 8,000 to 29,500 | intact |
| unset | 30,200 to 65,536 | replaced by a 2,370-character preview |
| 10000 | 7,000 to 9,800 | intact |
| 10000 | 10,500 | replaced by a preview |

The threshold follows `BASH_MAX_OUTPUT_LENGTH` in bytes of output, with a
default of 30,000. Claude Code's `contextSlice` is
`claudeContextSlice(process.env)` in `src/cli/native-listening.ts`,
evaluated in the hook process:

- unset or empty: 24,000 bytes, 80 percent of the default 30,000;
- a decimal integer: `min(24000, floor(0.8 * value))`;
- any other value, or a result below 4,096: no `contextSlice`.

The trailer is under 60 bytes; the rest of the 20 percent is margin.
Without `contextSlice`, oversized feedback keeps the existing
`context-too-large` hold and message, and no copy is written. The hook sees
the variable only when it is in the environment Claude Code passes to
hooks; a value that reaches only the Bash tool is not detected.

A 77,379-byte document plus history takes four reads.

### 4. Answers and questions require a complete read

Receipt is unchanged. The session confirms receipt at the start of the
continuation, as it does today.

`controlConnection` for `respond` builds the `offer-outcome` fact, then
checks it when the offer is `received` and has `delivery`. It parses the
fact with `parseConnectionFact` first. A fact that does not parse skips the
check, and the reducer refuses it as `invalid-connection`. For a parsed
`answer` or `question`, `nativeContextReadIssue(owner, offerId, bytes)`
decides:

1. The copy is the one directory in `realpath(tmpdir())` whose name starts
   with `lucid-context-offer-<scope>-`, where `<scope>` is
   `contextScope(registration.owner, offerId)`. It must be a private
   ordinary directory owned by the current uid and contain a `context.txt`
   whose post-header size equals `delivery.bytes`. Otherwise refuse with
   `context-missing`: "The offered context copy is no longer available.
   Record a failure response; the person can send the feedback again."
2. If progress `C` is below `delivery.bytes`, refuse with `context-unread`:
   "Read the offered context in order to its end with the lucid context
   command before recording an answer or question. Follow nextOffset until
   done is true."

The lookup uses `lstat` on names, not a held descriptor. The check is not a
security boundary (section 2), so a copy replaced between checks is not
defended against.

`refusal` and `failure` outcomes skip the check. That is the exit when a
copy is lost, for example after the reaper removes the copy of a departed
owner: the session records a failure and the offer finishes.

Both refusals leave the offer `received`. The session can read and retry;
no new offer or preparation is needed. In Claude Code, a refused response
commits through the PostToolUse proposal path like other refusals, and the
next `respond` command makes a new proposal.

Abandonment: if the turn ends before a response (Escape, a new prompt, the
Stop block cap), the offer stays `received` and fences later native
delivery for the record, as any unanswered offer does under RFC 26. The
same session can still read and respond later. A closed session cannot.
Reference delivery makes this more likely, because answering takes several
commands. A recovery control for abandoned offers is separate work.

The check runs only in the live writer. `receipt-confirmed` and
`offer-outcome` facts are unchanged, so replay of a recorded response does
not read the copy. The copy is removed after the response is accepted, as
today, or by the lazy reaper after its owner process exits. The reaper
keeps copies whose owner cannot be determined.

`context-unread` and `context-missing` are new entries in
`REFUSAL_ISSUES`, with messages in `src/cli/connection-control.ts`. They do
not reuse the preparation reason `context-unavailable`.

### 5. Tell the person when a listen expires with feedback held

After `input-held`, the listener keeps waiting for other deliverable
feedback. Today the Stop hook then ends silently at expiry, and the person
sees the hold only in the browser.

The listener keeps the holds it recorded for its own participation, in
order. When the listen ends as `expired` with no offer and at least one
such hold, `NativeListenerResult` is
`{ kind: "stopped", reason: "expired", held }`, where `held` lists
`{ inputId, message }`. `runClaudeHook` turns that result into its existing
`notice` result, which the dispatcher prints as `systemMessage`: "Lucid
could not send N saved feedback item(s): <first message> Listening has
ended; run lucid connection resume-listen after resolving it."

- No notice when an offer was delivered; the listen then returns `offered`.
- No notice when the listen ends as `interrupted`, because a new prompt or
  Escape already moved the person on.
- The block-cap notice happens before listening starts, so the two notices
  never compete.
- Codex output is unchanged.

## Alternatives considered

- Raise `maxBytes`. The 20,030-character probe is the largest verified
  Stop reason. History grows without bound, so any fixed cap fails later.
- Summarize or trim the context. That is the preview RFC 26 rejects.
- Send one slice per Stop continuation, each an inline offer with its own
  receipt. A 77 KB document needs four or more continuations, each counted
  against Claude Code's consecutive Stop block cap (default 8), and history
  growth pushes larger records past the cap. It also multiplies offers and
  receipts per feedback item.
- Route oversized feedback to the managed path, which already reads
  offered copies. That runs a different process, which breaks the
  same-session rule of RFC 26.
- Tell the session to open `context.txt` with its own file tool. Claude
  Code's Read tool has line and token limits and leaves no progress record.
- Require a digest with the response. A digest printed in the offer can be
  copied without reading.
- Check reads at receipt. The session would have to read before confirming
  receipt, and a lost copy would leave a `sending` offer with no outcome.
- Refuse out-of-order reads. Managed and headless execution share the
  reader, and a gap refusal would change their behavior for no benefit.
- Always use a reference. Small offers would need extra commands and a
  second path in the verified Codex lane.

## Acceptance

Deterministic:

- An offer within `maxBytes` is inline and its payload bytes are unchanged.
- An oversized offer with `contextSlice` writes a copy whose text equals
  the inline rendered context, records `delivery.bytes` equal to its size,
  and emits a payload within `maxBytes` containing the feedback text and
  the reading command.
- An oversized offer without `contextSlice` keeps the existing hold and
  message and writes no copy.
- Oversized feedback text holds with the new message and leaves no copy.
- A malformed `delivery` is refused; logs without it replay unchanged.
- An out-of-order read is served and leaves progress unchanged; in-order
  reads and rereads advance it; a corrupt, symlinked, or foreign-mode
  progress file counts as 0. Progress written by any process counts, which
  covers reads by a Claude Code subagent.
- On a reference offer: an answer before a complete read is refused with
  `context-unread` and accepted after it; a failure is accepted without
  reads; a missing copy refuses an answer with `context-missing` and
  accepts a failure; the recorded response replays without the copy; a
  malformed answer is refused as `invalid-connection`. Inline responses are
  unchanged.
- A Codex transport builds no reference offer.
- A listen that recorded a hold and expired returns `held`; one that
  offered, or was interrupted, does not. The Claude hook prints the notice
  only for the first case.
- `BASH_MAX_OUTPUT_LENGTH` lowers the Claude slice, and an invalid or small
  value removes it.

Not testable in this repository: an older build replaying a log with
`delivery`. Section 1 states that behavior from the current parser.

Native (Claude Code, isolated): the slice probe in section 3.

Live: the held note on `follow-up-fixtures` is delivered to its resumed
session after an explicit `resume-listen`, read to its end, and answered.

## Revision history

v2 resolves [review v1](30_native-feedback-context-by-reference.review-v1.md):
R1 states the real field-by-field parsing on older builds; R2 names
`controlConnection`; R3 and R4 move the check from receipt to answer and
question responses, so refusal and failure always close an offer; R5 states
what progress proves and accepts subagent reads; R6, R7 and R11 define the
progress file, lookup, byte domain and retry; R8 records the slice
measurement; R9 specifies the hold notice; R10 fixes preparation order and
the copy helper; R12 uses non-colliding refusal names; R13 expands
acceptance; R14 adds the per-slice and managed-path alternatives.

v3 resolves [review v2](30_native-feedback-context-by-reference.review-v2.md).
That review read the code while implementation was in progress, so V2-1 and
V2-4 described unfinished code. v3 matches the finished code: V2-1 and V2-2
serve out-of-order reads without counting them; V2-3 records the
`BASH_MAX_OUTPUT_LENGTH` measurement, read site and fallback; V2-4 routes
the held result through the `notice` result; V2-5 replaces the claim that
the window does not widen with an explicit abandonment limitation; V2-6
parses the outcome before the check; V2-7 to V2-10 cite the implementation,
the atomic write helper, the reader uid change and the `bytes` bounds.
Accepted for implementation under the standing autonomous instruction; the
v3 corrections are machine-made and were not re-reviewed.
