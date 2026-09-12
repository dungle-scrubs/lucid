---
number: 27
title: "Native approvals during headless continuation"
type: protocol
status: Accepted
author: Kevin
date: 2026-09-12
version: 2
---

# RFC-27: Native approvals during headless continuation

## Abstract

Lucid needs to preserve the native session's permission behavior when saved feedback continues after its interactive owner exits. Codex's ordinary headless command can change that behavior even when the session ID and model are preserved. This protocol gives HCN a native approval response channel for one resumed turn and lets the person answer pending requests in Lucid. The same process waits for the answer; loss of that process never authorizes a replacement or a repeated action.

## Introduction

RFC 26 requires same-session continuation and retained approval authority. A disposable Codex 0.154.0 probe records an on-request interactive turn followed by a never-approval exec turn. App-server resume retains saved approval policy, but a second probe shows the legacy sandbox following changed current settings. Neither session identity nor a transport change proves permission preservation.

Fit check: Kevin reads and annotates coding-agent artifacts in Lucid. Lucid routes a live conversation into a durable record and back to the person using it. Native approval controls serve that purpose by letting saved feedback continue without changing who grants access. This widens the browser interaction surface; Kevin explicitly approved it with "yes, continue" after the native approval decision. Correlation, recovery and verification hold that approved scope.

This extends RFC 26 with native permission requests, explicit answers and a supported HCN transport. Codex is the first implementation lane. Other interfaces retain their existing acceptance requirements. Unsupported recorded settings hold feedback before a prompt is submitted. Unsupported requests arising during a turn fail that attempt after cleanup and leave feedback visibly held; this is staged implementation, not removal from RFC 26's scope.

General persistent Codex sessions, automatic approval decisions, arbitrary native RPC forwarding, model questions, MCP elicitation, cross-process approval brokers and new users are out of scope. A one-turn subprocess serves the existing feedback flow without adding those capabilities.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Native ID**: the exact resumable Codex `thread.id`, including for a fork. HCN's established normalized `sessionId` means this resumable ID; it is not Codex app-server's root-group `thread.sessionId`. HCN MUST resume and compare `thread.id` and MUST NOT substitute the root-group ID.
- **Request**: a native permission question pending in the current owned process.
- **Choice**: an HCN-normalized label and scope mapped privately to one supported native response.
- **Decision**: the person's selection of a choice for an exact request.
- **Write intent**: a durable fact recorded before attempting to send a decision to HCN. It prevents a second write after uncertain delivery.
- **Cleared**: the native request stopped waiting. This says nothing about the selected answer or the tool's result.
- **Attempt**, **executor lease**, **input** and **record** retain Lucid's existing meanings.

## Protocol Overview

1. Lucid performs RFC 26's departed-owner and related-record admission. It saves the prepared attempt and launch notice atomically before creating a process.
2. HCN passively rechecks the requested native-settings fingerprint immediately before spawn. Unsupported or changed evidence refuses without spawning.
3. The opt-in run starts one Codex app-server process, initializes it, resumes only the supplied native ID, restores supported recorded settings and verifies its effective settings before submitting the one prompt. There is no fresh-session or ordinary-exec fallback.
4. HCN normalizes native requests. Lucid accepts them only from its current managed attempt, saves them losslessly and shows them in chat.
5. A browser decision is saved under the append lock. The worker durably claims its one write, then sends it to the same HCN process. HCN validates it against its live request map and writes the corresponding native response once.
6. Native completion, interruption or process loss settles pending requests. HCN cleans up its owned process before the terminal done event. Lucid retains the executor lease through that cleanup.

HCN owns native formats, permissions and process supervision. Lucid owns durable user decisions and presentation. HCN MUST NOT persist or recover decisions across its own process lifetime.

## Message Formats

### HCN command and framing

The opt-in command is `hcn run codex --json --native-approvals --resume ID --cwd ABSOLUTE --native-settings-fingerprint HASH --prompt TEXT`.

`--native-approvals` reserves stdin for UTF-8 NDJSON decision messages. It MUST require JSON output, an exact resume ID, an absolute folder and a valid fingerprint. It MUST refuse fresh sessions, prompt input from stdin, passthrough flags, caller model/effort/provider/access/sandbox overrides, unsupported harnesses and incompatible output modes before spawn. File-backed prompts use the existing `--prompt-file PATH` flag. Existing runs without this flag retain their contract.

Each inbound decision line is at most 4 KiB, including newline. HCN MUST reject invalid JSON, unknown properties and unsupported operations with a disposition. An oversized or unterminated oversized line ends the channel and triggers owned cleanup. HCN MUST process complete buffered messages in order.

### Recorded settings authority

The existing public operation `hcn inspect codex --native-settings --resume ID --cwd ABSOLUTE --json` returns the HCN-owned typed snapshot and a 64-character lowercase SHA-256 fingerprint. Lucid passes that fingerprint, never caller-authored settings. HCN re-reads the native source and retains the matching snapshot for field-by-field comparison; the hash is not used to reconstruct values.

The current source implementation is HCN `src/execution/native-settings.ts:inspectNativeSettings`, using `src/interpretation/native-settings.ts:parseCodexSettingsRecord`. Its bounded Codex rollout read selects the session header's provider and latest turn's model, effort and recognized permission profile. Its fingerprint covers source kind, harness, ID, requested folder, file device/inode/size/modification/change identity, selected record ordinal and all normalized settings. These files own the algorithm; Lucid treats the hash as opaque. The new transport MUST extend that native read to retain reviewer authority and detect newer thread-settings events before using it as restoration evidence. Missing reviewer evidence is unknown; it MUST NOT default to user. Until a newer settings-event form is supported, it MUST invalidate restoration evidence rather than reuse an older turn.

For the first verified lane, the recorded triple is a read-only sandbox, a managed filesystem profile with exactly root-read access, and restricted network access. The profile's exact field checks already live in the pure parser. HCN restores the supported snapshot through native resume parameters, including `sandbox: "read-only"`, and compares returned `sandbox: {type:"readOnly", networkAccess:false}`, model, effort, provider, folder, exact thread ID, approval policy and recorded reviewer. Field names in the native protocol remain HCN-private. Native-returned aggregate sandbox data does not prove custom profile contents. Unsupported additions remain unavailable.

### Lossless events

All approval events carry `v: 1` and these exact `kind` values. Existing HarnessEvent output remains available on the same stdout stream.

| Event | Required fields and meaning |
|---|---|
| `approval-request` | `requestId` (opaque HCN UUID), `sessionId`, `turnId` (native identities), `category` (`command`, `file-change`, `permissions`), `details` (plain text), `choices` (nonempty array) |
| `approval-disposition` | `id` (decision UUID or null for malformed input), `requestId` (UUID or null), `status` (`sent` or `rejected`); rejected events also carry a stable `reason` |
| `approval-cleared` | `requestId`, `reason` (`native-resolved`, `turn-ended`, `process-ended`, `channel-failed`) |

Each choice has exactly `id` (opaque request-local string), `label` (plain text), and `scope` (`once`, `turn`, `session`, `persistent`, `deny`, `cancel`). Choice IDs convey no native authority outside their request. HCN privately retains the native payload for each choice; callers MUST NOT supply native response JSON.

HCN MUST present the complete approval-relevant command, folder, file change or permission scope and native reason in details. It MUST NOT offer approval if these details cannot be represented completely. Details are bounded to 64 KiB UTF-8, choice labels to 512 bytes, choices to 16 and simultaneous pending requests to 32. Exceeding a bound or encountering an unsupported approval variant fails the turn explicitly and cleans up; it never truncates authority into an approvable request.

A request is one native server-initiated RPC requiring one response, not one queued tool action. A native grouped network request remains one request and one write. Its details MUST state that the choice covers the offered destination and queued actions in that native group, including host, protocol and port when supplied. HCN MUST NOT invent sibling requests for the group or infer their resolution. Each subsequent native clear is matched to the original native RPC ID. A grouping form whose scope cannot be fully shown is unsupported.

Native offered choices alone define the supported answers. Persistent policy amendments and session grants MUST identify their duration and exact effects. A request with no supported native choices is an unsupported interaction. Known native defaults can be used only when that method's documented protocol defines them. Native permission-subset requests MAY be represented as exact grant choices plus refusal; there is no caller-authored arbitrary subset editor in v1.

The native command/file choice mapping is:

| Native decision | Label | Scope |
|---|---|---|
| `accept` | Approve once | once |
| `acceptForSession` | Approve for this native session | session |
| `decline` | Deny | deny |
| `cancel` | Cancel this response | cancel |
| `acceptWithExecpolicyAmendment` | Approve and save this rule | persistent |

For permission requests, an exact requested subset with native scope `turn` maps to "Grant for this response" / turn; scope `session` maps to "Grant for this native session" / session. An empty grant maps to "Deny" / deny. The native protocol's default scope is used only when verified. Persistent means the native harness saves a policy; HCN itself still stores no cross-process decisions. The scope field is a presentation classification, including denial and cancellation, not a native enum.

Plain-text details intentionally keep native schema interpretation inside HCN. The HCN normalizer MUST verify that every selected native permission, extra path, grant root, network destination and rule amendment is represented in the shown text and choice label. Tests compare native response payloads against this projection. Lucid records and displays that exact text; it does not independently parse native permissions. Lossless refers to durable event delivery, not forwarding native RPC objects.

### Decision command

```json
{"v":1,"op":"approval","id":"decision-uuid","requestId":"request-uuid","choiceId":"choice-id"}
```

HCN MUST validate the request belongs to this process and is still pending. The first valid decision consumes its request's response right before the HCN-to-native JSON-RPC response write. A repeated decision ID with identical content returns its recorded disposition without another write. Reuse with different content, a different decision for a consumed request, an unknown choice and a cleared request are rejected. Native write failure after consumption is uncertain, not retryable. `sent` means the write was submitted, not that the tool ran or succeeded.

Native server request IDs remain private to HCN. HCN MUST correlate method, native thread and native turn as well as request ID, including requests arriving during turn-start acknowledgement. It MUST NOT associate another thread's request with this attempt.

### Lucid durable authority

Lucid's browser API accepts only decision ID, request ID and choice ID. The server binds these to the conversation's current epoch and attempt. Existing browser authentication, origin and agent-content separation apply. Only the managed executor can append a request or a write-intent fact. Generic source events and artifact content MUST NOT create actionable approvals.

Under one append transaction, the host checks current attempt, unresolved request, exact offered choice and absence of a prior conflicting decision before appending the decision. Identical browser retries return the saved result. Before native dispatch the worker appends write intent under the same guards. Restart or missing write acknowledgement MUST NOT resend a decision with write intent. GET, reload and transcript replay never dispatch decisions.

## State Machine

| Request state | Trigger | Next state |
|---|---|---|
| absent | validated current-attempt native request | pending |
| pending | explicit browser decision | decided |
| decided | current executor saves write intent | sending |
| sending | HCN sent disposition | sent |
| pending, decided, sending, sent | native clear or completed turn | cleared |
| any unresolved state | process/channel loss, executor replacement or hard deadline | unavailable |

An unavailable request is terminal for answering. Sending or sent decisions retain their factual history when a request clears. Native resolution can race a browser decision or pipe write: a cleared request loses its response right and a delayed acknowledgement cannot reopen it. Pipe submission cannot establish native acceptance. UI text therefore distinguishes "You chose ...", "Answer sent" and "Request is no longer waiting" from subsequent tool output.

If the process disappears while state is decided with no write intent, the UI states "Your choice was saved but was not sent. The session stopped." If write intent exists without a sent disposition, it states "Your choice may have reached the session. Delivery is unknown." If sent is known, it states "Answer sent. The session stopped before a result was confirmed." None offers decision retry against a replacement process. The 33rd pending request fails the whole attempt; cleanup makes all pending requests unavailable, rather than dropping only the excess request.

The worker MUST hold its executor lease while requests wait. Reconnect follows RFC 26's current-response and cleanup fences. Cancelling the response uses existing owned cancellation; it does not synthesize an approval answer. HCN's existing runner inactivity timeout (injected `RunnerDeps.stallMs`, with its existing default) pauses while requests await a person, then restarts when none remain; the caller's explicit hard deadline continues running. Initialization, resume and turn-start acknowledgement each have a 30-second HCN protocol deadline, shortened by any caller hard deadline. The hard deadline is the existing explicit `--timeout` budget, with 0 disabling it. Tests use the injected clock. No native timer is changed. Model `tool/requestUserInput`, including `autoResolutionMs`, is outside this responder and triggers unsupported-interaction cleanup; HCN never automatically answers it.

## Error Handling

| Reason | Result and recovery |
|---|---|
| `native-settings-unavailable` / `native-settings-changed` | No prompt submitted. Preserve input and ID; refresh evidence after repair. Spawn evidence, not exit code, determines whether launch was attempted. |
| `native-settings-mismatch` | Resumed process reports different identity/settings. Submit no prompt, clean up and hold feedback. |
| `unsupported-native-interaction` | Unsupported request, choice or unrepresentable details. End owned attempt with non-retryable failure after cleanup. Reconnect is available after cleanup. |
| `invalid-decision` / `request-unavailable` / `choice-unavailable` / `decision-conflict` | Reject decision without a native response write. Keep other valid pending requests intact. |
| `approval-channel-lost` | Close/terminate the owned native process and mark unresolved requests unavailable. No automatic command or decision replay. |
| existing cancellation/deadline/native failure | Preserve normal execution evidence and clean up, making pending requests unavailable. |

End of decision stdin is channel loss even if a request has not arrived yet. Native stderr is drained through existing bounded diagnostics. Output backpressure MUST remain bounded; broken stdout triggers cleanup rather than leaving an invisible native process waiting. Unknown native requests receive no fabricated answer. Ordinary tool denial is not by itself terminal failure if the native turn continues normally.

## Security Considerations

The worst failure is executing an action under authority the person never granted. Every approval therefore binds the exact live attempt, request and offered choice. No default choice, model-generated text, elapsed timeout, reconnect or auto-review setting authorizes a response. Artifact frames and agent sources remain unable to call the protected decision surface.

Native details are untrusted text. The UI MUST render them without HTML interpretation or executable links, expose the full scope before selection, and provide keyboard-accessible controls. Secrets in native details are not copied into model prompts, logs outside the conversation, or external review reports. Lucid retains only the request content needed for the person's decision and audit.

Permission restoration MUST use HCN-owned native evidence and compare effective settings before turn start: exact session, folder, model, effort, provider, approval policy, reviewer and filesystem/network scope. Newer native settings events MUST NOT be overwritten with older turn-context authority. Unknown reviewers, named profile contents, custom policies and unverified restrictions remain unavailable until their restoration is proven. Profile names alone are not a permission snapshot. No broader preset, automatic reviewer or default config supplies missing authority.

The fingerprint detects source changes; it does not lock arbitrary native writers. RFC 26's owned process and related-record guards remain required. If ownership changes before prompt submission, Lucid MUST stop the prepared attempt through its existing cancellation/fencing path.

## Versioning

Approval messages use version 1 with closed decision parsing. HCN event kinds remain additive for ordinary consumers. Explicit opt-in selects this transport; an old HCN refuses the flag rather than silently using ordinary exec. Lucid uses operation outcomes and does not gate on package or harness version numbers. The pinned dependency and recordings change only after upstream tests and native confirmation pass.

## Implementation Notes

HCN integration points are `src/cli/plan-turn.ts:planTurn`, `src/cli/run.ts:run`, `src/execution/stream-turn.ts:streamTurn` and `src/execution/deps.ts:RunnerDeps`. Lucid integration points are the `HarnessRunner` interface in `src/harness/runner.ts`, `ConversationHost` in `src/store/conversation-host.ts`, and the attempt reducer in `src/protocol/execution.ts`. Their existing interfaces do not yet implement approvals; this RFC specifies the extension and its tests, not current support. Use HCN's descriptor-owned protocol vocabulary, pure interpretation and injected process primitives. Extend the one-turn runner rather than advertising general persistent Codex sessions. The first permission-preservation lane is the exact recorded read-only, restricted-network, user-reviewed on-request or never policy. Broader recorded settings remain acceptance work under RFC 26.

Deterministic tests MUST cover public CLI admission, changed evidence before spawn, effective mismatch before prompt, request/decision round trips, concurrent requests, duplicate decisions, clear/write races, channel loss, timeout pause, hard deadline and cleanup-before-done on Node and Bun. Lucid real-record tests MUST cover authority, durable write intent, reload and crash recovery, related-record fencing and duplicate browser submission. Browser verification covers pending, decided, sending, sent, cleared and unavailable states at 390, 768 and 1440 pixels. A disposable native Codex CLI session confirms exact ID/settings and one answered native request. It does not substitute for desktop interface acceptance.

The existing native-interaction termination policy in concurrent HCN/Lucid work remains applicable to requests without this supported responder. Integrate its surviving contract without overwriting that work or misrepresenting the unpublished patch as the installed dependency here.

## Open Questions

This v2 responds to [Muse's v1 review](27_native-approvals-during-headless-continuation.review-v1.md):

- F1/F2: named the existing passive settings operation, typed snapshot, fingerprint owner and exact permission evidence. The proposed caller-authored settings channel is declined because HCN already owns the read and comparison.
- F3: defined the resumable thread ID and its distinction from Codex's root-group ID.
- F4: clarified one RPC versus multiple queued effects. The predicted sibling-write problem is not present when native RPC IDs remain the correlation owner.
- F5: explicitly retained unsupported handling for model questions and their timers.
- F6: separated pre-turn held feedback from an in-turn unsupported request's failed attempt.
- F7: retained HCN-owned scope projection, added completeness tests; a native-schema audit in Lucid would duplicate upstream ownership.
- F8: added native decision labels, scope mapping and native persistence ownership.
- F9: identified each pipe and the uncertainty messages, plus decided/sending browser checks.
- F10: named injected HCN timers, existing caller budget and 30-second protocol deadlines.
- F11: specified bounded pre-ack buffering, whole-attempt overflow failure and unsent-decision UI.
- F12: named existing extension seams and stated their current lack of approval support.

Muse Spark reviewed v2 and found all actionable v1 findings resolved as specification. Implementation and native acceptance remain required. Accepted under Kevin's explicit scope approval and autonomous implementation instruction.

No product decision remains open. Kevin approved native permission controls. Machine-made choices under the autonomous instruction are: one-turn opt-in transport, HCN-owned choice payloads, durable write intent, the listed bounds, and staged exact permission support. Native protocol compatibility and race behavior remain implementation acceptance checks, not permission to weaken these requirements.

## References

### Normative

- [Lucid scope and vocabulary](../../CONTEXT.md)
- [RFC 26](26_interactive-artifact-conversation-continuity.rfc.md)
- [Agent and browser authority](../adr/0008-browser-and-agent-content-have-separate-authority.md)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)

### Informative

- [Codex exec policy, rust-v0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/lib.rs)
- [Native persisted resume settings](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/persisted_resume_settings.rs)
- [Native thread resume](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/app-server/src/request_processors/thread_processor.rs)

Disposable probe and review output lives in ignored artifacts/evidence/interactive-artifact-wayfinder. It is development evidence, not a permanent runtime guarantee.
