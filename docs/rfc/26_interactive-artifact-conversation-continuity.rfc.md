---
number: 26
title: "Interactive artifact conversation continuity"
type: feature
status: Accepted
version: v4
author: Kevin Frilot
date: 2026-09-11
---

# RFC-26: Interactive artifact conversation continuity

## Abstract

An interactive agent can publish a Lucid artifact without connecting the native conversation that authored it. Browser feedback then has no ready recipient, and changing a response preference cannot establish that connection. This RFC binds publication to verified native registration, separates saved feedback from native receipt, and resumes the same native conversation headlessly only after confirmed interactive departure. A returning interactive interface waits for the current headless response and process cleanup before it starts. The scope includes Codex CLI, Codex desktop, Claude CLI, Pi CLI, and Muse CLI, each with separate native acceptance evidence.

## Introduction

Lucid serves one person reviewing and annotating agent-authored artifacts on one machine. Connecting the author, preserving accepted feedback, and controlling same-session handoff serve that purpose. These changes hold the agreed product scope; the additional Claude/Pi reconnect entry point was explicitly accepted in the planning map. The user's instruction to implement authorizes rendering the resolved decisions using the prototype's presentation. The planning resolutions establish behavior; each native interface still requires its own acceptance evidence.

This RFC renders the resolved decisions in the [planning map](https://github.com/dungle-scrubs/lucid/issues/253). Production implementation follows this specification and its review. A throwaway prototype is not a durable queue or an integration implementation.

Out of scope: multiple artifacts per conversation, remote or multi-user operation, a general agent dashboard, a new coordinating daemon, arbitrary terminal control, importing unrelated native history, automatic approval answers, and automatic fresh-session fallback. Direct native resume in Claude/Pi is outside the protected reconnect workflow. It remains possible and is detected as a conflict when observable.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

Use the existing conversation, record, input, native session, source, participation, epoch, append lock, presence lock, and driver preference terms from CONTEXT.md.

- **Registration**: integration-captured native identity, interface, working folder, and corroborated native owner. Registration is not execution authority or readiness.
- **Binding**: the verified association between one exact Lucid conversation and its native registration.
- **Listener**: an active, bounded delivery path into an admitted native participation.
- **Offer**: one prepared input whose dispatch has begun, with its input ID, participation, epoch, and context snapshot.
- **Receipt**: a correlated native/integration acknowledgement of an offer. A response outcome is a separate fact.
- **Reconnect request**: durable intent reserving the next interactive admission. It is not a second executor lease.
- **Launch attempt**: a stable identity recorded before process creation, later associated with process provenance or a confirmed pre-start refusal.

## Motivation

The observed failure began with publication through the local artifact API without native registration or an attached source. The browser's interactive preference produced an attachment refusal whose specific reason was hidden by a generic diagnostic. Existing code has native-owner corroboration, execution attempts, append serialization, and process-lifetime executor locks. Existing hook delivery excludes managed input envelopes and records applied disposition before native receipt. Reuse the former boundaries and replace the latter assumptions for registered interactive delivery.

The implementation MUST reproduce creation, feedback, listener loss, and same-ID handoff in disposable records before claiming those paths repaired. No test can infer native client closure from the browser closing, the listener ending, a heartbeat expiring, or an executor lock being released.

## Design

### 1. Public operations and ownership

Lucid adds the following CLI operations. Names below are the proposed CLI contract for implementation, rather than commands claimed available today.

| Operation | Caller and result |
| --- | --- |
| `lucid connection register --interface <interface>` | Installed native lifecycle integration supplies its payload on stdin. Returns an opaque registration reference and a typed identity/ownership result. |
| `lucid artifact publish --request <file>` | Authoring skill publishes valid artifact content and returns the authoritative conversation ID, artifact URL, publication result, and separate connection result. |
| `lucid connection listen <conversationId>` | Existing native integration verifies the exact binding, obtains execution authority, prepares at most one eligible input, and waits within its declared bound. |
| `lucid connection receipt <conversationId> --offer <offerId>` | The native agent acknowledges an offer through a verified in-session command; the host verifies native identity and current participation. It is not a browser action. |
| `lucid connection respond <conversationId> --offer <offerId> --request <file>` | The verified native participation records its answer, question, refusal, or failure after receipt. |
| `lucid connection resume-listen <conversationId>` | Runs in the intended existing native session to re-enable listening. It refuses mismatched native identity and never creates another record. |
| `lucid reconnect <conversationId>` | Terminal entry point reserves return before launching the native interactive runtime. An already-live native owner gets resume-listening instructions instead of another process. |
| `lucid connection status <conversationId>` | Read-only detection and current projection. It creates no input, authority, or native process. |

The integration and command adapters SHOULD remain thin. Record addressing owns exact record resolution; the conversation host owns serialized binding, offers, receipts, cancellation, reconnect requests, and launch facts. The harness seam owns native process operations, including any new HCN operation required for interactive launch. Lucid MUST NOT construct a second native argument registry or treat HCN's headless session transport as a native terminal interface.

### 2. Registration and publication

Registration contains a generated registration ID; harness; interface (`codex-cli`, `codex-desktop`, `claude-cli`, `pi-cli`, `muse-cli`); native session ID; exact native working folder; native process identity (PID, start identity, executable); and provenance from the supported lifecycle callback. Interface and harness MUST agree. The host MUST validate bounds and identity formats through the existing shared validators, corroborate the native owner, and distinguish unknown evidence from confirmed absence.

The integration MUST capture native identity. A model-supplied native ID, a shell title, a working-folder match, or a shared desktop server process is insufficient evidence. The publication command resolves the registration from verified native process ancestry plus integration context. If that identifies multiple registrations, it refuses connection as ambiguous instead of selecting the newest. Unverified desktop client ownership remains unknown.

Registration state before a record exists lives under the already-configured Lucid root in a private registrations directory. Atomic create/replace and a registration-scoped kernel lock protect binding updates. Registration references contain no record credential. Registration material is local integration state, not an alternate feedback queue.

The publication request contains an idempotent creation key or an existing conversation ID, artifact identity and content, and an optional registration reference. Existing artifact admission, cardinality, size, and path rules still apply. A valid document MUST be publishable even when connection fails. The result separates `publication` from `connection`; neither the API nor the skill can report ready merely because a file or hook exists.

Publication first obtains the authoritative record through existing idempotent creation or exact lookup, then records the binding under that record's append transaction. Retrying a connection MUST reuse that record. A crash after publication but before binding leaves a readable artifact and a repairable disconnected result. A changed registration cannot overwrite a conflicting binding. New, clear, fork, and resume lifecycle events refresh registration and cannot silently carry a binding to another native session.

The authoring skill MUST use this operation, open its returned URL, and enter the installed integration's listener when connection succeeds. It MUST retain the published record and specific failure when connection does not succeed. It MUST NOT switch a browser response preference to simulate attachment.

### 3. Durable connection facts

Connection control is an additive, validated log record family owned by the conversation host. Replay and writes use the same parser and transition function. Facts include registration binding; listener enabled/disabled; offer started; receipt confirmed; offer outcome; input cancelled; reconnect requested/withdrawn; launch intended/started/refused/settled. Every control action has a stable action ID and conflicting repeats are refused. Dynamic process probes are not replayed as historical facts.

A binding identifies the registration and native session. A listener participation identifies its epoch, native owner, enabled state, and bounded wait expiry. An offer identifies its input ID, participation, epoch, attempt, prepared-context digest, and turn ID. A reconnect request identifies the existing conversation/native target, request ID, requester process identity, and pending/withdrawn/launched state. A launch fact identifies its attempt ID, role, target, requester, and, once known, native child identity.

The append lock serializes these facts with accepted inputs, artifact changes, and managed execution attempts. The presence lock continues to elect one executor. A listener or reconnect waiter MUST NOT create another independent executor lock. Expiry revokes readiness; it never records native departure. Disabling a participation survives later unrelated terminal turns until explicit exact-record reconnect.

The browser API returns a connection projection derived from these facts plus fresh owner checks. It does not return credentials or raw process-table contents. Existing input endpoints continue to accept and durably save messages and annotation batches before reporting acceptance.

### 4. Delivery and receipt

At a safe native turn boundary, the admitted listener selects the earliest eligible accepted input. Managed inputs (the existing managed-input-v1 capability and managed: true input flag) and ordinary inputs share this path; they MUST NOT be ignored merely because an execution entry exists. Existing comparison/context holds can skip independently ineligible work. An uncertain native offer blocks later offers to that same native session.

The listener prepares the complete current artifact and comparison context through the existing preparation seam. It preserves the input ID and original annotation snippets/versions. It rechecks the prepared snapshot and binding under append serialization immediately before recording dispatch. Unsupported or oversized input stays held as a single input. No truncation or synthetic chunk inputs are permitted.

Dispatch began, receipt, and outcome are separate. A successful hook return, pipe write, or local queue add MUST NOT mark an input received or complete. Receipt identifies the offered input, epoch, participation, and native identity captured by the integration. Matching repeats are idempotent; a different input, native identity, or stale epoch is refused. Native callback data is validated at the adapter boundary, and model text alone is not a native-identity claim.

A resulting answer, artifact revision, question, refusal, or failure records an outcome for the input. Ordinary unrelated terminal output is not imported. Source loss after dispatch leaves the offer uncertain until durable receipt/outcome evidence or proved non-delivery settles it. Receipt without a settled outcome after source loss still blocks further dispatch. Neither exit nor reconnect silently replays uncertain work.

Cancellation addresses a stable input ID and action ID. Under the same append/control ordering, cancellation succeeds only before dispatch begins and records a terminal cancelled state. A dispatch race has one winner. Cancelling feedback never stops a human-owned native process.

### 5. Listening by interface

Codex CLI and Muse CLI use their supported synchronous Stop continuation path. Waiting performs no model inference. A listener wait has an implementation-declared bound shorter than the verified native hook deadline; timeout, interruption, and parent loss revoke readiness. Implementation MUST record exact configured values and confirm timeout/interruption through the native interface. It MUST NOT manufacture empty model turns to renew a wait.

Claude CLI uses supported lifecycle/turn-boundary hooks. Pi CLI uses the current native session's extension API, rather than starting a replacement RPC session. Both adapters deliver complete context, capture correlated receipt/output, and return to listening after a browser response while enabled.

Codex desktop has its own setup, trust, callback, per-client ownership, listening, interruption, and same-ID acceptance lane. CLI evidence MUST NOT satisfy it. Unsupported or unavailable native operations give a specific disconnected result and keep feedback. An unverified interface cannot be shipped as supported or silently removed from scope.

Setup uses the selected harness's supported extension/hook mechanism, preserves other registrations, and explains trust, restart, or reload where required. Permanent installation follows the user's shared hook/dotfiles arrangement; tests use isolated configuration. File installation alone is not readiness. Managed headless children carry launch-role provenance and MUST NOT register as returning interactive clients or enter the interactive wait loop.

### 6. Automatic headless continuation

Only confirmed departure of every corroborated native owner, exact native identity and folder, a never-dispatched eligible input, and absence of contenders/reconnect reservations permit automatic headless admission. Unknown owners hold work. Revalidation occurs after executor acquisition and again at the dispatch boundary. Driver preferences cannot change the bound native identity or resume it through a different harness.

Before native process creation, after the final admission check, append this transcript item with a stable launch-attempt identity:

> No interactive session detected. Resuming headlessly with session <id>.

A losing contender emits no notice. A confirmed pre-start refusal follows the attempt notice with the specific failed operation. Retrying a repaired pre-start refusal uses the same accepted input and native session with a new attempt ID. Uncertain started attempts cannot be replayed automatically. A successful response and process cleanup settle the attempt separately from the historical notice.

### 7. Returning to interactive use

`lucid reconnect` targets an existing record and resolves its stored harness, native ID, and working folder. It MUST reserve reconnect intent before native process creation or history loading. Claude/Pi users MUST use this route after headless handoff within the protected workflow. Help at the command and browser instruction MUST state that direct native resume bypasses its protection. Codex CLI and Muse native conflict handling can require explicit retry/reopen; Lucid does not promise to click it automatically. Desktop launch requires its own supported operation.

The command first persists an idempotent request with requester provenance. Duplicate requests join or report that pending request. Future managed dispatch is held; the current response continues through its terminal outcome and resource cleanup. The waiter holds no executor lease while that executor finishes. A response that ends in a question or failure still reaches its normal outcome; the handoff does not answer the question or clear the failure.

After cleanup and receipt/outcome settlement, the waiter acquires the presence lock, rechecks the request and all owners, and records launch intent. The reconnect reservation prevents a managed worker from winning the transition gap. HCN starts the native interactive runtime with the exact saved session and folder, returning child provenance. Only the new integration's verified identity and listener establish readiness and permit the next queued input.

If reconnect races a headless launch before creation, the request prevents that creation. If creation already started, reconcile the launch and wait for its process cleanup. The same native conversation MUST NOT be intentionally started in two places by this workflow.

Cancelling the wait before launch withdraws only that request. It preserves the active response and queued feedback. Requester death permits withdrawal only after corroborated exit and proof that native creation never started. Persisted launch intent with unknown child state holds admission. Parent death or released locks alone cannot establish that a native child is gone. Owned process cleanup precedes orderly executor release.

If direct native resume creates an observable contender, Lucid explains the conflict and holds subsequent dispatch/admission. It neither claims to have prevented existing processes nor kills a human-owned process.

### 8. Connection projection and recovery controls

The UI places current connection above feedback, with nearby help, exact conversation reference, and native session identity. The saved response preference and earlier transcript notices remain separate. The server's projection provides typed status, reason, and supported actions so browser and CLI do not independently infer ownership.

| Evidence | Current label or message | Available action |
| --- | --- | --- |
| Admitted listener ready | Interactive session connected and listening | Send/save feedback |
| Corroborated native owner alive, listener not ready | Your interactive session is still open. Tell it to resume listening. | Exact-record resume-listening instructions |
| Publication succeeded, integration missing | Artifact published; connection needs setup. Interactive mode needs a connected session. | Setup instructions; retry connection when supported |
| Owner unverified | Cannot confirm whether the session is open; specific evidence failure | Retry session detection, read-only |
| Headless launch intended | Resuming the same session headlessly | Reconnect instructions |
| Headless process running | The same session is responding headlessly | Reconnect instructions; current response finishes first |
| Terminal outcome recorded, owned process cleanup pending | Response ended; waiting for process cleanup | Reconnect instructions, or cancel an existing wait before launch |
| `closed`: all native owners confirmed gone, no active response or pending input; the record remains readable |  No interactive session detected; feedback will resume the same session headlessly | Reconnect instructions |
| Reconnect pending | Waiting to reconnect; response/cleanup stage explained | Cancel this wait before launch |
| Known pre-start refusal | Headless resume failed; specific refusal retained | Retry same-session resume after repair |
| Dispatch without receipt | Sending; receipt not confirmed | No cancel or automatic resend |
| Receipt but unresolved outcome after source loss | Received; response outcome unknown | Reconciliation status, no automatic resend |
| Conflicting owners | Two processes are using this session; further delivery held | Explain native conflict, then detection retry |

An accepted input shows Saved, Sending, Received, Response finished, Cancelled, or Delivery uncertain as appropriate. A failed/refused/question outcome retains its actual result rather than implying success. Unsupported actions have no working-action button. There is no Assume closed action, automatic model switch, package installation, or fresh-session fallback. The initial hidden refusal reason remains visible even without historical HCN inspection.

Controls MUST have text labels, visible keyboard focus, and plain explanations. Dynamic status is announced once through a polite live region. Focus survives recovery updates. Instructions are usable from keyboard and name the exact record. Verification covers 390, 768, and 1440 pixels, both appearance themes, and the accepted prototype scenarios.

### 9. Concrete integration and control contract

This section resolves the v1 review gaps and controls where earlier prose was less specific.

#### Registration identity and lock order

Registration IDs, action IDs, offer IDs, participation IDs, and launch IDs are UUIDs generated by the local integration/host. They are references with at least 122 random bits, validated through the existing wire-ID validator plus UUID syntax where generation is required. Native IDs use the existing wire-ID validator, including its 128-character bound and control-character rejection; an additional 512 UTF-8 byte ceiling cannot widen that validator. A native ID outside these bounds returns unsupported identity without substitution. Folder and executable paths are absolute, nonempty, control-character-free strings of at most 4096 UTF-8 bytes. PID/start/executable use the existing ProcessOwner parser and corroboration.

| Interface | Harness | Identity callback | Working folder | Native owner evidence |
| --- | --- | --- | --- | --- |
| codex-cli | codex | SessionStart `session_id`; later callbacks MUST match | Callback `cwd`, with its original spelling retained | Matching native executable ancestor plus process start identity |
| codex-desktop | codex | Supported desktop SessionStart `session_id`; independently verified | Desktop callback `cwd`, original spelling retained | Evidence for the particular client/conversation, not a shared server PID; otherwise unknown |
| claude-cli | claude | SessionStart `session_id`; later callbacks MUST match | Callback `cwd`, original spelling retained | Matching native executable ancestor plus process start identity |
| pi-cli | pi | Extension `session_start`; current session manager ID | Extension context `cwd`, original spelling retained | Extension's own native process PID/start/executable |
| muse-cli | muse | SessionStart `session_id`; later callbacks MUST match | Callback `cwd`, original spelling retained | Matching native executable ancestor plus process start identity |

Realpath is recorded as supplementary path evidence. It MUST NOT silently replace the original native cwd or override a native workspace refusal. HCN strict-resume validation checks the native ID and folder only; it does not open or continue an interactive interface through headless transport. A folder match never supplies missing identity. Callback mappings above are proposed integration contracts whose installed behavior remains part of the native acceptance lane. Subagent callbacks cannot register the parent session: adapters MUST reject subagent provenance even where a callback carries the parent's session ID.

The registrations directory uses mode 0700, individual records/lock handles mode 0600, and regular files created without following attacker-selected links. References resolve only inside that configured root. Local filesystem access remains the authority; no HTTP registration endpoint accepts model/browser-declared ownership. The command checks actual caller ancestry against the registration's native process and current lifecycle identity before using the reference. A stale lifecycle generation cannot bind or acknowledge work. Multiple matching registrations return `native-identity-conflict` with detection/setup guidance; no automatic selection or rebinding is offered.

The record is the authoritative binding. A registration stores lifecycle identity and optional discoverability hints, not a second authoritative record-to-session map. Operations needing both locks always acquire the registration lock before the record append lock and release them in reverse order. They keep the registration generation stable while the append transaction corroborates the owner and validates binding, receipt, or response. Record-only operations never acquire a registration lock while holding an append lock. Lifecycle updates use the registration lock. A changed expected generation refuses connection as stale-registration; publication still succeeds. A hint can be repaired from a recorded binding and cannot authorize a conflicting one. Rebinding a record to a different native identity is not an operation in this RFC.

#### Receipt and response operations

The in-session operation is named `lucid connection resume-listen <conversationId>` to distinguish it from the terminal-launch command `lucid reconnect`. All commands that return data support `--json`; `--help` explains their result and whether they may start a native process.

Every prepared offer includes its generated offer ID, input ID, epoch, and participation ID as a delimited integration instruction beside the complete feedback context. Before working on that input, the native agent invokes `lucid connection receipt <conversationId> --offer <offerId>`. The command resolves current registration from native ancestry/lifecycle evidence; the model supplies no native-ID or owner override. The host validates the stored offer against that registration, current epoch, and participation, then appends receipt. That verified in-session tool invocation is the acknowledgement boundary for all five interfaces. The offer reference is not a credential and is insufficient from a different native process or lifecycle generation.

Native lifecycle callbacks supply identity and timing, not receipt merely because they ran. Codex/Claude/Muse Stop continuations carry the offer instruction through their supported hook response; Pi sends the same offer instruction through its current-session extension API. No implicit receipt is inferred from those transports. If the agent does not invoke receipt, the input remains unconfirmed. It cannot be automatically sent again just because a subsequent callback ran.

The listener releases its presence lease after recording and returning an offer. The durable unresolved offer fences other executor admission during the native agent's work. Receipt and response commands are narrowly authorized control writers: they validate native ancestry and lifecycle under the registration/append lock order, and may only settle their recorded offer. They do not acquire an executor lease, attach another source, select work, or renew readiness. A later matching listener must acquire the existing presence lease before selecting another input. Hook transport limits are checked before offer-started: configure a verified full-context limit or retain the whole input as held. A native head/tail preview or automatic output spill is not complete delivery.

`lucid connection respond <conversationId> --offer <offerId> --request <file>` records a correlated answer, question, refusal, or failure from the same verified native participation. Its request is a bounded object with `kind` from that four-value set and plain-text `text` within the existing event limit. It requires an already-confirmed receipt. Artifact publication for an existing offer may associate the artifact version with that offer, but a version write alone is not a terminal response outcome. The authoring/integration instructions require receipt before work and an explicit response operation afterward. Unrelated terminal output is never selected by a latest-transcript heuristic. Adapter tests MUST reject response before receipt, cross-offer response, stale lifecycle, wrong native owner, and subagent provenance. Each native lane MUST establish its supported subagent marker or equivalent provenance before enabling registration. Where parent and subagent callbacks cannot be distinguished, that adapter stays unavailable with subagent-provenance-unverified; no heuristic treats an absent marker as proof of a parent callback. A later durable response can settle a lost-source outcome only through the host's evidence reconciliation path; it is not fabricated by reading arbitrary model text.

A receipt or response command that crashes after its append can be repeated with the same offer/action identity. The host returns the recorded result without duplicate transcript entries. A stale epoch cannot create a new receipt; an exact repeat of an already-recorded receipt is a readback of that historical receipt, not renewed execution authority.

The default integration wait is 45 seconds, with a native hook deadline of at least 60 seconds where that deadline is configurable. A shorter verified native limit requires a correspondingly shorter explicit listener bound, recorded in the installed integration's manifest and acceptance evidence. Pi's extension uses the same 45-second wait bound and its native cancellation signal. These are chosen settings, not claims that every installed interface supports them. An adapter remains unavailable until its configured deadline, cancellation, identity, and receipt/response commands pass its isolated native lane.

#### HCN interactive launch and evidence

The required new HCN operation is `hcn interactive <harness> --interface <interface> --launch-id <id> --resume <nativeId> --cwd <folder> --control-fd <fd>`. It accepts a structured native-interface selector and integration environment through HCN's existing validated runtime inputs. Native stdin/stdout/stderr are inherited from the terminal; a separate caller-provided pipe carries normalized control NDJSON. Session IDs and folders remain separate argv entries. It supports only strict resume, no prompt, fork, fresh fallback, injected model switch, or caller-supplied native argv. HCN normalizes invocation and supervises only the native process it starts. It stores no cross-process conversation or reconnect state.

The operation emits one `ready` after preflight (not proof of native launch), then either `refused` before process creation or `started`, followed by `closed`. Control records carry `v: 1`, operation `interactive`, and the caller's launch ID. `started` includes the native process owner `{pid, startedAt, executable}` and the exact requested session/folder/interface. `closed` includes terminal exit status and whether owned-process cleanup completed. A `started` record proves process creation, not that native history loaded; the integration's verified attachment proves that later. No TUI bytes appear on the control pipe. A malformed/truncated control stream or missing provenance yields `launch-uncertain`, never a synthesized refusal.

`refused` has `evidence: spawn-not-attempted` and a reason code from `unsupported-interface`, `resume-unavailable`, `cwd-refused`, `invalid-request`, `executable-unavailable`, or `spawn-rejected`. HCN emits that evidence only when its validation prevented spawn or the OS spawn primitive returned a known no-child error. Native failure after process creation, a generic failure event, timeout, disconnected pipe, signal, or parent exit cannot carry it. The Lucid harness seam adds `openInteractive` returning the control stream, owned-lifecycle completion, and cancellation before creation. The HCN implementation and fixtures establish this public operation before Lucid uses it. An unavailable operation keeps the reconnect request held with `operation-unavailable`.

Lucid records launch intent before invoking HCN. For automatic headless continuation, that one durable launch-intended fact projects the native-ID transcript notice; a separate notice write is forbidden. Exact replay emits one notice per launch ID. An explicitly admitted new attempt after proven pre-start refusal has a new ID and a new notice. Invocation is the creation boundary: after it begins, lack of a started record is uncertainty. Proven pre-start refusal is only a parsed HCN `spawn-not-attempted` result or Lucid's own `dispatch-not-called` evidence recorded before invocation. Existing headless `harness-refusal`/`dispatch-not-called` evidence is retained at its existing dispatch seam; other headless failure results stay uncertain. For a disappeared requester, absence of any launch-intended fact proves that this request did not cross creation. Presence of intent without a terminal operation result requires reconciliation and cannot be auto-withdrawn. There is no automatic non-delivery inference after an interactive offer was recorded; matching durable receipt/outcome or explicit native rejection is needed.

The reconnect command holds the presence lock through launch intent and the `started` provenance record. It then releases that lock while keeping the reconnect reservation restricted to that native child/request. Only the matching verified listener may acquire it and attach. That attach fulfills the reservation under the append lock. Managed workers remain fenced throughout this interval. If the command dies before provenance is recorded, or the listener never establishes identity, the reservation remains held/uncertain. This avoids asking the listener to acquire a lock that the command retains for the native session's whole lifetime.

#### Durable fence and projection

Connection control facts use the existing recognized log source `execution` with `payloadVersion: 2` and a separately parsed `connection` payload. Version 1 execution facts keep their current parser. Version 2 carries `actionId`, `kind`, and the typed binding/listener/offer/reconnect/launch payload defined above. The in-memory channel state adds a connection projection from those facts. The host exposes one `writeConnection` transaction and one read projection; command adapters cannot append raw control records.

`managedCandidates` returns no new candidate while a reconnect reservation, uncertain offer, uncertain launch, or owner conflict exists. The server launch reconciler and managed-worker initial check consume that same result. The managed preparation transaction rechecks the fence after context preparation and before `attempt-started`; the existing source's per-turn dispatch check rechecks before invoking HCN. Work whose creation boundary already passed follows ordinary settlement; later work stays queued. A reconnect request racing candidate selection has a deterministic oracle at this shared seam. A control append that conflicts with a stale preparation snapshot refuses the dispatch and consumes no native attempt.

All executor entry points use a shared record admission operation around the existing presence lock, including managed workers, manual headless run/resume, interactive listeners, and reconnect. It first checks the current control projection, attempts the existing presence lock, then rechecks control under the append lock before granting an executor lease. The short-lived OS lock acquired for revalidation grants no authority to attach, append execution, or launch until admission succeeds. Rejection releases it immediately. No entrant can bypass the post-acquisition guard. Reconnect and its matching verified native child are the only entrants allowed by their reservation; an unresolved offer permits only its verified settlement commands, not a new executor. The host's writeConnection and managed preparation transactions serialize reconnect intent against attempt creation; per-turn dispatch revalidation closes the preparation-to-invocation gap. Tests exercise these concrete operations and every entry point, rather than assuming candidate filtering fences manual callers.

The connection read projection has `state` (one of `setup-required`, `listening`, `not-listening`, `owner-unknown`, `headless-starting`, `headless-running`, `cleanup`, `reconnect-waiting`, `resume-failed`, `delivery-uncertain`, `outcome-unknown`, `owner-conflict`, `closed`), `message`, `reason` (a reason family or null), `actions` (action IDs), `conversationId`, `nativeSessionId` (nullable), `interface` (nullable), and `observedAt`. It includes input delivery projections and a distinct saved preference field, never infers actual execution from that preference.

Action IDs are `setup-instructions`, `resume-listening-instructions`, `retry-connection`, `retry-detection`, `reconnect-instructions`, `cancel-reconnect`, `retry-resume`, and `cancel-unsent-input`. All are intersected with implemented operation support and current evidence. Setup/identity-missing offers setup instructions; a live owner with disabled/expired listener offers resume-listening instructions; unknown/conflicting ownership offers retry-detection; an eligible disconnected/managed state offers reconnect instructions; a pending owned request before launch offers cancel-reconnect; settled resume-refused offers retry-resume; an accepted input before dispatch offers cancel-unsent-input. Delivery/outcome/launch uncertainty offers status only. Native-identity-conflict never offers rebinding. Folder-unverified uses the existing folder-repair control and a subsequent detection/retry check. Unsupported operations offer explanatory instructions only, with no fake retry button.

Read-only status returns HTTP 200 with its typed state, including unknown; malformed identifiers return 400, missing records 404, and conflicting control mutations 409 with the reason. Status probes current PID/start/executable through the existing non-shell process probe; repeated owners are deduplicated within that read, not cached across requests. An unavailable or failed probe immediately yields unknown. No network calls, model calls, waiting, or native launches occur during status reads. The browser fetches this projection on initial load, after each control mutation, and every two seconds while the conversation is visible, cancelling an obsolete request when the conversation changes. Each HTTP read performs a fresh projection; no server-side polling cache is authoritative. An old browser snapshot cannot authorize a mutation. Mutations always repeat their own owner/admission checks under control ordering.

Version-1 readers in the current supported baseline recognize the `execution` source and refuse `payloadVersion: 2` as `corrupt-log: Unsupported execution payload`. The new reader reports `unsupported-connection-payload` for unknown connection versions and leaves bytes untouched. Unknown noncritical log sources retain their existing carried/skipped contract. Verification MUST run an opted-in record against the baseline reader and prove it refuses without truncation or native launch. Downgrade of an opted-in record is not supported by this RFC, even after work settles; preserving the critical admission facts is preferable to silently discarding them. This tightens the v1 draft's incomplete conditional downgrade claim without changing the product's normal workflow.

### Review response

Version v4 applies the remaining minor findings from [Muse v3](26_interactive-artifact-conversation-continuity.review-v3.md): R1 explicitly names the closed row, R2 makes per-interface subagent provenance an acceptance gate and test case, and R3 derives the notice from the single durable launch-intended fact. All design blockers are resolved. Accepted status authorizes implementation of the settled flow; it does not certify the explicitly pending native lanes.

Version v3 resolves [Muse's v2 review](26_interactive-artifact-conversation-continuity.review-v2.md): N1 retains the shared native-ID validator; N2 fixes registration-before-append ordering; N3 guards every executor entry point before authority is granted; N4 supplies the remaining projection rows; N5 separates prototype presentation from native acceptance; N6 limits strict-resume inspection to validation; N7 names the transactional arbiter and browser refresh schedule. It also specifies offer settlement without a listener-held presence lease, subagent exclusion, and complete hook-context admission. These are implementation constraints on the accepted flow.

This v2 answers [Muse's v1 review](26_interactive-artifact-conversation-continuity.review-v1.md).

- F1: explicit verified in-session receipt and response commands, with per-interface transport and native acceptance requirements.
- F2: closed pre-start evidence set; unknown creation and interrupted dispatch stay held.
- F3/F6: registration ID, ownership/callback, original-folder, filesystem, and lock-order contracts.
- F4: proposed HCN operation, separated terminal/control channels, provenance, and refusal taxonomy; implementation remains a prerequisite.
- F5: shared managed-candidate, preparation, and dispatch fence plus lock transfer to the matching listener.
- F7: typed projection, action vocabulary, HTTP results, and uncached read-only process probes.
- F8: critical version-2 execution envelope and explicit no-downgrade policy, preserving unrelated unknown-source handling.
- F9: `resume-listen` distinguishes existing-session listening from native launch.
- F10: existing managed input vocabulary replaces the undefined envelope term.

## State Machine

Presence (`alive`, `gone`, `unknown`), listener readiness, executor authority, and input delivery are independent state dimensions. Only admitted ownership plus a ready delivery path permits interactive dispatch. Native departure enables headless admission only after the other guards in Design 6 pass.

Input path: accepted -> dispatch-begun -> received -> outcome. Accepted -> cancelled is terminal. Dispatch-begun or received -> uncertain on lost source; only matching evidence resolves uncertainty. A pre-dispatch preparation hold can return to accepted eligibility. Invalid transitions and conflicting idempotent repeats are refused without mutation.

Reconnect path: absent -> requested -> launch-intended -> child-confirmed -> attached. Requested -> withdrawn is allowed only before creation. Launch-intended -> pre-start-refused requires proof of no child. Unknown process creation remains held. The active headless executor observes requested before scheduling another input and releases only after cleanup. Browser/server restart reconstructs control from the log; it is not a transition to native gone.

## Error Handling

Use a typed connection reason alongside existing protocol/store refusal classes. Required reason families are connection-setup-required, native-identity-missing, native-identity-conflict, folder-unverified, owner-unknown, owner-alive, listener-disabled, listener-expired, delivery-uncertain, receipt-stale, reconnect-pending, launch-uncertain, resume-refused, and operation-unavailable. Every refusal includes a plain message and only supported action IDs. Adapter/native diagnostics retain their provenance; an unavailable historical inspection does not replace the current cause.

There is no automatic retry of an external failure or uncertain delivery. Read-only detection can be repeated. Connection retry revalidates its prerequisites. A user-authorized same-session retry is idempotent by action ID and uses the existing input. Internal lock contention remains safely pending for the existing reconciler, without consuming a native attempt or emitting a false launch notice.

## Security Considerations

The local filesystem and existing loopback browser token remain the authorization boundary. Opaque registration IDs are addressing references, not credentials. Commands resolve and verify record identity before internal credential use. Browser responses, model-visible publication results, and transcript notices MUST NOT expose record secrets. Registration and input lengths are bounded and parsed as data.

Native invocation belongs to HCN and uses structured arguments, never shell interpolation of a session ID or folder. Reconnect cannot execute arbitrary browser-supplied commands. Artifact content cannot nominate its owner, approve a handoff, fabricate a receipt, or alter a native launch role. Native approvals retain native authority. The failure boundary is one local record and its exact bound native conversation, with uncertain/conflicting evidence preventing further dispatch.

## Alternatives Considered

- Changing browser mode to attach: rejected because saved preference is not native participation or readiness.
- Headless takeover when a listener expires: rejected because the interactive client can still be open.
- Starting native interactive use immediately and relying on native locks: rejected as a shared policy because Claude/Pi probes allowed concurrent same-ID use. Codex/Muse conflict behavior is supplementary evidence.
- A background global agent coordinator or separate feedback queue: rejected because existing record, append ordering, and executor lock own the required durability.
- Marking a hook write applied: rejected because transport success does not establish native receipt.
- Fresh-session fallback: rejected because it breaks the accepted native continuity contract and can replay uncertain work.

## Implementation Plan

The sequence and test seams below are machine-made implementation details under the user's instruction to continue autonomously. They render the existing ownership and delivery decisions rather than change product scope. Tickets remain local until shared publication is separately requested.

1. Publication/registration and connection projection: verify idempotent publication survives failed binding, exact identity is checked, and setup failure remains visible. Seam: artifact publication command/API through record addressing and the conversation host, plus the shared connection projection.
2. Durable interactive input lifecycle: verify managed and ordinary input delivery, full-context preparation, receipts/outcomes, cancellation races, replay, and uncertainty holds. Seam: conversation host append transactions and replay, exercised by the interactive delivery boundary with injected clock/process evidence.
3. Existing-session integration: implement verified native adapters and bounded listeners for Codex CLI, Claude, Pi, and Muse; retain a separate Codex desktop lane. Seam: lifecycle payload adapters and listener service, using isolated native fixture configurations and real model/process confirmation where needed.
4. Same-session automatic headless continuation: verify owner evidence, managed role, attempt notice ordering, refusals, and strict native identity at the existing managed preparation/execution and HarnessRunner seams.
5. Protected reconnect: specify/add the HCN native interactive launch/provenance operation, then wire durable reservation, worker dispatch fence, cleanup, admission, cancellation, and crash recovery. Seam: host control transactions and reconnect command with fake HCN/process lifecycle and multiprocess lock oracles.
6. Authoring and browser workflow: wire real supported controls, clarify preferences/current execution/history, update the authoring skill and setup instructions, and verify the accepted prototype flows against the actual product.
7. Integration acceptance and review: full deterministic check, build, separate native acceptance for every named interface, code review and fixes, then scoped commits. Unsupported/unverified lanes remain explicitly incomplete; none are silently waived.

Highest-priority cases are owner alive/not listening, owner unknown, stale/mismatched receipt, cancel-versus-dispatch, reconnect-versus-launch, response-versus-cleanup, duplicate request, and parent death with an unverified child. Tests attach at those public seams one behavior at a time. Browser composition and adapter orchestration use integration/visual checks rather than brittle test-first markup assertions.

Existing records without registration keep their current behavior. New connection facts require the new reader; replay MUST fail clearly on unsupported control records rather than drop the admission fence. Downgrade of an opted-in record is unsupported; Design 9 defines the critical envelope and baseline refusal check. Existing preferences and artifact history are preserved. Each incomplete integration returns an explicit unavailable result; no release claims full continuity before all acceptance lanes pass.

## Open Questions

1. Native acceptance: Design 9 specifies the HCN operation and callback contract. Actual operation support and Codex desktop client provenance still require implementation verification. Keep the affected ticket incomplete if no supported desktop path can be established. The user decides any later scope change; this RFC does not waive desktop.
2. Installed integration verification: Design 9 selects explicit receipt/response operations and a 45-second wait within a verified native deadline. Confirm each adapter against its installed native interface before enabling it. A failed check blocks that adapter; it does not permit receipt inference from hook exit.

## References

### Normative

- [Product vocabulary](../../CONTEXT.md), [architecture](../architecture.md), [drivers](../drivers.md), and [source protocol](../skill-chat-substrate.md).
- [ADRs](../adr/README.md), especially kernel execution ownership, durable recovery, HCN ownership, and preferences versus events.
- [Connection decision](https://github.com/dungle-scrubs/lucid/issues/257), [delivery decision](https://github.com/dungle-scrubs/lucid/issues/258), [ownership decision](https://github.com/dungle-scrubs/lucid/issues/259), and [interface prototype](https://github.com/dungle-scrubs/lucid/issues/260).

### Informative

- [Prototype source](https://github.com/dungle-scrubs/lucid/blob/7076289a1ad4fe962af3aa49ea20052f40917c4e/src/server/client/interactive-connection.prototype.html).
- [Native listener evidence](https://github.com/dungle-scrubs/lucid/blob/98e8a3b/docs/research/interactive-artifact-session-listener.md).
- [Native competing-resume evidence](https://github.com/dungle-scrubs/lucid/blob/98e8a3b/docs/research/interactive-artifact-resume-admission.md).
- [Registration design](https://github.com/dungle-scrubs/lucid/blob/98e8a3b/docs/research/interactive-artifact-connection-draft.md).
