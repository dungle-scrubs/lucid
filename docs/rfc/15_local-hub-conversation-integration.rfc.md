---
number: 15
title: "Local hub conversation integration"
type: feature
status: Draft
revision: 3
author: Kevin Frilot and Codex
date: 2026-09-07
---

# RFC-15: Local hub conversation integration

## Abstract

The hub needs to list actual local conversations and continue them when the person submits a prompt. This RFC defines automatic record discovery, project association, saved conversation settings, short titles, and submission-driven agent startup. Native session recall and explicit conversation-context transfer preserve continuity when processes, models, or harnesses change. Execution remains local and serialized by the record's existing executor lease; failures preserve input and expose available recovery actions.

## Introduction

This specification consolidates the five resolved decisions in [Connect the hub to local conversations](https://github.com/dungle-scrubs/lucid-v2/issues/199). It serves one person on one machine who reads, annotates, and continues coding-agent conversations. Discovery and continuity hold that scope; creating and starting conversations from the hub is the browser-workflow extension Kevin requested.

In scope: a real hub over a shared local record root; creation from the hub and terminal; repository/folder grouping; legacy records; XDG defaults and saved choices; stable titles of seven words or fewer; durable input-driven startup; native resume; model/harness changes; context transfer and automatic summarization; failure recovery. Existing artifact reading, editing, version navigation, attachments, and annotation delivery remain supported.

Out of scope: remote or multi-user coordination, importing every native harness session, combining several record roots, a second message transport, automatic relocation of projects, and unrelated reading-view redesign. This RFC does not expose provider inference state or promise restoration of unrecorded native history.

The accepted annotated-content comparison work in RFC 14 governs comparison inputs. This RFC reuses its repeat-safe browser submission and delivery holds, rather than establishing a competing input identity or receipt mechanism.

## Terminology

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL in this document are to be interpreted as described in RFC 2119.

- **Record**, **input**, **artifact**, **profile**, **harness**, **executor lease**, and **disposition** retain their meanings in CONTEXT.md.
- **Project**: a resolved repository root, or the starting folder when no enclosing repository exists. It groups conversations; it is not their storage location.
- **Working directory**: the exact folder selected when the conversation starts, retained for execution and deliberately replaced only through folder recovery or a later explicit choice.
- **Conversation title**: an editable display label for a conversation. The existing artifact **title** is separate.
- **Native session**: the session a harness identifies. Its ID is scoped to that harness and is distinct from the conversation ID.
- **Worker**: a local per-conversation driver process requested by the hub server. It uses the existing driven-conversation lifecycle and owns execution only while holding its executor lease.
- **Execution intent**: durable authorization, tied to an accepted input, for a worker to attempt that input. It is not a second copy of the prompt.
- **Context coverage**: the record range confirmed supplied to a particular native session. This is not the executor's delivery cursor.
- **Eligible input**: an accepted managed input with durable authorization for an initial attempt or explicit recovery, no unresolved external attempt, and satisfied current dispatch guards. An already-applied disposition prevents ordinary delivery but does not erase separately authorized post-start recovery. Eligibility combines execution facts with current folder metadata, saved preferences, capability evidence, ownership, and artifact state under the append lock. A historical hold records an observation, not an immutable truth.

## Motivation

The existing hub prototype uses its own sample list instead of enumerating the real record root. A document opened directly can therefore be absent from the hub. New records store a conversation ID but no project or working directory. The browser server currently appends input but does not request an agent to handle it.

Current native recall also falls short of the desired handoff. Interactive attachments exclude harness attribution from the saved native-session map. Headless-turn runner calls omit cwd; the strategy attempts native resume at most once per strategy lifetime and can retry fresh after a broad refusal. Pending-input replay and artifact context are not a demonstrated transfer of completed conversation history to a fresh harness. The [resume research](https://github.com/dungle-scrubs/lucid-v2/issues/201) distinguishes these implementation gaps from documented native capability.

## Design

### R1. Durable authority and discovery

The hub and terminal commands MUST resolve one effective record root: explicit invocation root, then LUCID_ROOT, then the user-config record location, then the existing `~/.lucid2/records`. They MUST use the same resolver. A custom root replaces the default; roots are not merged and records are not moved implicitly.

The hub MUST enumerate published record directories under that root and derive their identity from saved conversation metadata. A basename or display title MUST NOT substitute for the saved identity. Duplicate identities MUST produce an explicit conflict, not an arbitrary choice. Creation reserves dot-prefixed child directories for staging; discovery MUST exclude them even when they contain complete metadata. Atomic rename to a non-dot directory publishes the record. Existing dot-prefixed staging remnants remain excluded and are not duplicate identities. The discovery index MAY cache summaries, but the record remains authoritative and a cold start MUST rebuild discovery without a registration database.

All existing-record CLI and server operations MUST resolve a saved conversation ID through the same identity-to-directory index, including reads, attachments, artifact writes, settings, input, and launch. Verify metadata again under the selected record's lock before mutation. A missing ID returns not-found; an ambiguous ID returns E-HUB-01 on every route and launches nothing. Never reconstruct a record path by joining the ID to the root or implicitly mint a replacement. Direct path opening retains metadata identity and rejects ambiguous root registration before hub mutation.

Use filesystem notifications as hints and a periodic reconciliation no slower than five seconds for the whole lifetime of the running server, including with no connected tabs. Initial load, focus, and explicit refresh MUST reconcile. A missed notification MUST NOT permanently hide a valid record. Bound listing work through pagination with a stable identity tie-breaker and return an opaque continuation cursor. Changed ordering during pagination MAY require a fresh scan; duplicate rows MUST be deduplicated by identity. One malformed or unreadable record MUST NOT prevent valid records from appearing. An inaccessible root is an error, not an empty history.

### R2. Metadata and project identity

Extend record metadata additively, preserving the existing conversation identity and durable log. New conversation metadata contains:

| Field | Type and rule |
| --- | --- |
| `workingDirectory` | Optional absolute resolved path; absent on legacy records until recovered. |
| `projectDirectory` | Optional absolute resolved repository root or ordinary starting folder. |
| `conversationTitle` | Optional validated plain text. |
| `titleOrigin` | `generated`, `fallback`, or `manual`, present with a title. |
| `titleRevision` | Monotonic integer used to reject stale generation/rename writes. |
| `titleGeneration` | Bounded attempt state and source input identity; derived naming work, never the working native session. |

Metadata reads MUST preserve absent fields as unknown. Writes MUST preserve fields unknown to the writer and combine atomic file replacement with the record's append lock. This extends existing replacement-only sidecar writes; every writer of these fields MUST take that lock, including compare-and-replace validation. A metadata write MUST NOT create an artifact version, input, or new execution authorization. Correcting a prerequisite can release already-authorized pending work under R5; it does not authorize work by itself. A new record MUST publish its identity and known folder association atomically before it is discoverable.

At creation, resolve symlinks and find the nearest enclosing repository root. If none exists, the starting folder is the project. Compare project identity by resolved absolute path, not its display name. Distinct roots with identical basenames remain distinct. A nested repository is its own project; a Git worktree has its own working-tree root and therefore its own project under this path-based definition. Preserve the exact starting working directory even when it is below the project root.

A valid legacy record without folder metadata MUST appear under No project and remain readable. On its first submitted prompt, preserve the prompt and ask for a working folder before execution. A missing recorded working folder follows the same recovery path while retaining its existing project association until the person chooses a replacement. The choice updates only that conversation, not every conversation under an old prefix. Dismissing the chooser leaves execution pending. Listing or opening MUST NOT infer a working folder from the server's cwd or start a model to recover metadata.

### R3. User defaults and saved settings

Read TOML from `$XDG_CONFIG_HOME/lucid/config.toml`, falling back to `~/.config/lucid/config.toml` when the variable is unset or empty. Ignore a relative XDG_CONFIG_HOME value and use the same fallback, as required by the XDG absolute-path rule. The default file is equivalent to:

```toml
version = 1
records_dir = "~/.lucid2/records"

[defaults] # Defaults for new conversations
harness = "claude"
model = "opus"
effort = "high"
profile = "headless-turn"
```

Optional `provider` is allowed only where hcn supports it. Expand a leading `~/` in records_dir; accept absolute paths and reject other relative paths. Do not perform shell substitutions. A missing file uses built-ins. A malformed file, unsupported version, unknown field, invalid type, or invalid combined driver choice MUST be reported, not silently replaced with defaults.

New conversations use explicit creation choices over user defaults over built-ins. The settings bundle MUST be validated before the first start and persisted before dispatch. Existing conversations use their saved choices. A deliberate CLI override can win for that invocation but MUST be reported without rewriting standing preferences. The hub passes its resolved selection explicitly; inherited process environment MUST NOT replace it. A user's saved UI change applies at the next queue-input boundary. Settings remain a whole-bundle replacement with an expected preference revision: the browser sends the complete harness, concrete model, effort, and profile, plus applicable optional provider. A partial request that omits a required dimension is refused, never treated as legacy completion. Optional fields omitted from a valid complete bundle are cleared. Changing effort cannot discard the saved model.

Extend driver preferences with a selected profile and concrete model. hcn's public inspection owns canonical model IDs, aliases, effort vocabularies, and capability provenance. Extend Lucid's harness vocabulary and driver-choice projection to carry hcn's alias map, which the current projection drops; do not recreate aliases above that seam. Resolve aliases before the first start or deliberate model change and save the concrete result. An update to what `opus` names MUST NOT change a saved conversation. Installed hcn 0.6.1 currently maps opus to claude-opus-5; this is observed evidence, not a hard-coded Lucid model table. If hcn cannot resolve a configured alias, require a concrete supported selection. Unavailable saved models leave input pending.

User defaults are re-read for each new creation. A hub server's root is fixed for its invocation; a records_dir change MUST report that restarting the server is required. Existing URLs MUST NOT be silently retargeted. Default edits do not alter saved conversations. Pass resolved choices through hcn so its own defaults cannot override dimensions Lucid explicitly saved.

For legacy preferences, preserve valid saved choices first. Fill absent fields from the last actual driver for the same harness where known, then compatible user defaults. Do not combine a foreign model with a selected harness. A saved alias can use a matching concrete model in the record; otherwise resolve it once and expose the result before execution. Persist the completed bundle on first submission/start, not on open. A departed interactive profile follows R6 rather than launching a new human terminal. Malformed preferences MUST remain readable as a conversation but MUST block execution until corrected.

Preferred and actual driver state MUST remain distinct. A capability check MUST NOT silently substitute headless-session for selected headless-turn. An unsupported selected profile is an actionable refusal.

### R4. Stable short conversation titles

Conversation titles MUST contain one to seven word segments and at most 128 Unicode scalar values. Use a single shared word-segmentation function based on Unicode word boundaries, with locale `en`, across server validation, fallback generation, and browser count. Count word-like segments; punctuation alone is not a word. Normalize surrounding/repeated whitespace. Titles MUST be single-line plain text without controls; markup is displayed as text. Manual overlength input is rejected with the bound, not truncated.

Before a first meaningful input, display New conversation. A valid attachment-only input uses Attachment conversation; naming MUST NOT read attachment contents. A blank input with neither text nor attachments is refused by input validation. After the first durable text prompt, use its first up to seven complete word segments as the fallback, subject to the character bound. If no segment fits, use New conversation. The fallback is available immediately.

The independent worker also owns derived naming jobs, with bounded concurrency and no executor lease for those jobs. Submission durably marks naming eligible; it does not invoke a model in the HTTP handler. If settings are unresolved, retain eligibility and the fallback until the settings are corrected. A held task does not consume a naming attempt. Naming can run once a valid route and tool isolation are available, without needing the task's working folder. If isolation is unsupported, retain the fallback and record that generation is unavailable.

Schedule one separate tool-free naming operation through hcn with the conversation's resolved model and effort. It MUST NOT resume the working session, appear as an assistant answer, or delay the user's turn. Name the first prompt, treating its contents as data. Bound its input to a suitable excerpt. Validate the result and permit at most one repair attempt after an invalid title; any other failure leaves the fallback. Persist attempt consumption before each model launch so a restart cannot create an unlimited retry loop. An interrupted consumed attempt stays consumed.

A generated result can replace only the fallback revision from which it was scheduled. Manual rename increments titleRevision and wins over in-flight generation. After generation, topic changes or model/config changes MUST NOT regenerate the title. Titles need not be unique. Existing records without titles display deterministic fallbacks derived in memory on discovery; listing/opening MUST NOT persist a title or take a write lock. At the later text submission, persist that fallback and its initial revision before scheduling generation, using the original first prompt where available. Existing valid manual titles are preserved. Invalid legacy titles are retained as recoverable source data, shown with a valid fallback, and require validation on the next explicit rename; do not silently overwrite them.

### R5. Acceptance and execution intent

Extend the existing browser input acceptance transaction, including RFC 14's stable input ID and exact-payload retry rules. The accepted receipt MUST resolve duplicates before fresh admission checks. A repeated identical accepted request returns its original receipt. Reusing an ID with a different accepted payload is refused. An uncertain response keeps the same serialized request and identity; reload alone MUST NOT resend it.

For a hub-managed submission, append one newline-terminated, envelope-v1 internal entry with source managed-input and payload version 1. It contains the accepted input once and its initial requested intent. Folding this single entry assigns the accepted sequence and exposes both receipt and authorization together. Do not encode these as two independently valid log lines: process death can leave a complete input line without the second intent line, beyond the reach of exception rollback. A receipt is returned only after durable append; incomplete tails use existing recovery rules. Envelope-valid unknown sources remain carried by older readers without enqueuing the managed prompt. The extension to the accepted-input store operation MUST also be used when an annotation or comparison submission requests hub execution. A later recovery action references the original accepted input, never a new prompt. For post-start recovery, derive the new authorized attempt from execution facts even if the input already has an applied disposition; do not enqueue it as another input or emit a second initial-applied disposition.

Execution facts use an internal versioned log-entry family, separate from source-protocol frames. Input-execution facts carry an input ID, attempt number, kind, and validated kind-specific payload. Their kinds are `requested`, `held`, `retry-authorized`, `fresh-authorized`, `attempt-started`, and `attempt-ended`. A second internal fact type, `coverage-confirmed`, is session-scoped: its key is harness plus actual native session ID; its payload carries source range, supplying turn ID, acknowledgement evidence, and input/attempt identity when that turn belongs to a managed attempt. It does not require an invented managed input for interactive coverage. Both fact types share the versioned internal envelope and append-lock discipline; neither is a source-protocol event. `requested` is appended with initial acceptance. `held` carries the cause and applicable actions. Retry/fresh authorization uses an idempotent action ID and expected attempt number. `attempt-started` records the turn ID, selected concrete driver, native-session intent, context snapshot and offered coverage boundary before external dispatch; `attempt-ended` records completed, pre-start-failed, failed-after-start, or uncertain outcome, with typed failure evidence and any confirmed native identity/coverage. The reducer derives execution authorization and outcomes. Eligibility also rechecks the named sidecar and current artifact/ownership state in Terminology; an in-memory queue is not authority. A location or settings save takes the append lock, validates the referenced input and expected attempt, atomically replaces its sidecar, then requests reconciliation. A crash between replacement and that request is recovered by the server sweep. A cleared prerequisite hold becomes pending without inventing a new prompt or recording standing preferences in the log. Explicit failure authorization remains necessary where R9 requires it.

Persisting a hold MUST not mark the input applied. An execution authorization MUST NOT override RFC 14's reviewed-version and required-context guards. Recheck all dispatch prerequisites after any folder, settings, or recovery change. If an attempt-started fact exists without a confirmed outcome after recovery, classify it as uncertain and do not automatically repeat possible side effects. A durable terminal frame tied to the same turn ID may establish that outcome without re-dispatch; otherwise explicit recovery is required. Attempt numbers advance under the append lock at attempt-started, once per authorized dispatch attempt. A crash after that append but before process creation still consumes that attempt.

Comparison preparation uses E-COMP-07 and RFC 14's newer-artifact and explicit-source-attachment triggers, never a generic Retry or Resume action. Persist its failed-head/source-participation suppression with the managed hold. Automatic worker restart or reconciliation is not an explicit source attachment and MUST NOT reset suppression or launch solely to retry that hold. A qualifying newer head permits one bounded preparation attempt; failure renews suppression. Attach MUST carry attachmentOrigin (explicit or automatic) for managed-capable sources. An explicit attach also carries a stable explicitAttachmentId created by the human-initiated attach operation; retries/reconnects reuse it. The host records that ID and consumes it at most once as a comparison-recovery trigger. Automatic workers use automatic regardless of why they found eligible work; their fresh process/epoch is not a new explicit intent. Updated terminal/hook adapters mark genuine explicit attaches; absent origin is not authority to release a managed hold. These fields describe attachment intent only and confer no executor authority. Other hub prerequisite holds recheck when their named cause changes. E-HUB-06 covers only non-comparison context preparation.

### R6. Server launch boundary and worker lifetime

The server appends and requests a worker through one launch interface. It MUST NOT hold the executor lease, construct another harness driver, or dispatch source effects inside an HTTP handler. A worker uses openDrivenConversation and the existing append lock, presence/executor lease, epoch fencing, and hcn runner. Construct its launch environment explicitly: inherited LUCID_HARNESS and LUCID_ROOT MUST NOT pin the worker or retarget the record; use the resolved root and conversation settings. Resolved startup settings are not a lifetime harness pin for a managed worker; subsequent saved changes still apply at input boundaries. Preserve only the environment needed by the configured harness under existing policy, and pass resolved choices explicitly through hcn. This changes no credential policy.

An execution launch request names an existing conversation and eligible input, never a client-supplied executable. A derived-naming launch instead names that conversation and its durable eligible naming job; it follows R4 and cannot consume the task input or grant an execution attempt. Concurrent launch requests MAY start contender worker processes, but only the elected executor can launch a harness. Losing contenders exit. Durable intent is the reason to attempt execution; opening the hub is not. At server startup and on its reconciliation pass, request workers for eligible accepted hub inputs with no executor, including a crash between acceptance and launch. Historical pending inputs without a managed intent remain under their existing delivery policy.

A live attached compatible driver receives managed inputs through the record. An attached source without managed-input-v1 creates an incompatible-source prerequisite hold, reported as E-HUB-03 with Upgrade the source or wait for it to exit guidance. It cannot receive managed input or be displaced while alive. Source replacement or departure triggers eligibility reconciliation; there is no Retry button that bypasses compatibility. A living terminal owner that is currently unattached MUST be waited on; neither stale status text nor lease expiry alone authorizes stealing it. When that terminal process has departed, the next eligible submission can use headless-turn and its captured same-harness native ID and cwd, with a visible mode-change notice.

Closing a browser tab MUST NOT stop accepted work. Workers have lifetimes independent of request sockets and tab connections. A headless-turn worker can drain eligible work and exit at idle; it MUST release ownership and reconcile with incoming durable work so an idle-exit race cannot strand input. The server's periodic reconciliation is the fallback. A selected headless-session worker can retain its harness process. Worker exit MUST release locks and terminate any child it still owns; a completed turn leaves no unintended child process.

This extends the server role stated in CONTEXT.md and docs/architecture.md: it coordinates local worker launch for its invocation. ADR 0001's record transport and authorization decision remains intact; clarify its server description without invoking its remote/multi-user revisit condition. Local records remain the transport and ADR 0003's kernel ownership remains unchanged. The running hub server is an invocation-scoped local coordinator; it introduces no additional daemon or message bus. Its launch reconciliation runs at least every five seconds until server shutdown, independently of browser discovery requests.

### R7. Native recall, switches, and context coverage

Revise the source protocol's former R008 rule that discards interactive harness attribution. Capture native session identity for both interactive and headless sources, attributed to the correct harness. A named interactive harness can record emitted identity; an unnamed or unverified identity remains unknown, never guessed. Store the producing participation and corroborated owner alongside identity. A worker can use it only after confirming that owner has departed and acquiring the executor lease. Identity capture MUST NOT confer ownership over a living terminal process. Use the actual identity emitted by the harness, not a caller-side handle guessed to be the native ID.

For a supported resume adapter, every headless turn with a usable native session MUST resume it. Route support requires verified hcn command rendering and compatibility with the selected executable/version; unknown adapter support holds native takeover with E-HUB-03. Do not advertise pi or Muse native takeover based only on old fixtures or inaccessible documentation. Deterministic adapter checks remain the gate; live-model confirmation is separate evidence, never the only proof. A same-harness model change resumes that session with the selected model where supported. Returning to a previously used harness uses its own recorded native session. Never pass harness A's session ID to harness B. If a deliberate harness selection has no native session yet, the selection and submission authorize creating it; a subsequent unexpected resume failure requires the recovery choice in R9.

Prepare context through one conversation-context module used by initial start, fresh recovery, model switch, and return to a harness. A new native session MUST receive messages and recorded decisions, current artifact content/version, annotations, relevant recorded tool results, attachment references, and the pending prompt. Do not describe replay of outstanding inputs as transfer of completed history.

A resumed native session MUST receive missing record context since its last confirmed coverage, including work performed through another harness. Coverage is scoped to the native session and records an exclusive sequence boundary. Advance it only on evidence that the corresponding context was consumed by a completed or acknowledged turn, not merely process spawn. The RFC does not claim exactly-once external execution: a crash can make delivery uncertain. An uncertain range remains explicitly uncertain; it cannot be skipped as if confirmed. Persist coverage in internal coverage-confirmed facts keyed by harness and actual native session ID, carrying the source range, supplying attempt/turn ID, and acknowledgement evidence. Only the executor writes them under the append lock; completed attempt-ended may carry the same confirmation atomically. Repeated confirmation for the same attempt is idempotent. A native session obtained its own output during the completed turn, so the confirmed boundary includes that output through the acknowledged turn end. Retain offered-but-unconfirmed coverage in attempt-started. After uncertain delivery, neither advance coverage nor silently resend into that session: R9 requires a fresh context-bearing recovery, with the old session retained for inspection. Reintroduced history is labelled quoted context with stable record IDs, not new Lucid input events.

Context transfer MUST preserve roles, authorship, input identity, artifact version, and provenance. Historical messages and tool results are quoted context, not requests to rerun historical commands. A native transcript's imported history MUST NOT create duplicate user inputs or pretend that its source harness authored another harness's output. The full Lucid record remains canonical.

### R8. Context bounds and automatic summaries

Before dispatch, prepare context within the supported input budget of the target harness/model, reserving space for the pending prompt and current artifact. Obtain capabilities through hcn; unknown support is not proof of a transport or budget. The current Lucid capability projection does not expose a context budget or verified tool isolation. Implementation MUST supply those through hcn's public contract and the harness seam before enabling routes that need them; a mirrored model table in Lucid is prohibited. The contract needs a supported input bound and accounting method, provenance for the selected executable/model, native-resume budget handling, and enforceable tool-free/read-only operation modes. Extend and pin hcn where its current surface is insufficient. Include the built-in Claude/Opus route in deterministic contract validation before enabling default managed execution. If a usable bound or required isolation cannot be established, keep input pending with a context-preparation error; optional naming alone falls back without blocking execution. Do not equate a total model context window with space remaining in an existing native session.

When complete history does not fit, automatically summarize older history, retaining recent messages and current artifact context. Use the selected model through a separate read-only hcn operation; never alter the working native session to create its summary. Bounded multi-pass summarization MUST handle histories larger than one request. Preserve current user constraints, explicit decisions, unresolved work, failure state, and source references. Summaries are derived caches associated with their source sequence range and model; they do not replace or remove the durable record.

Provide a conversation-scoped projected context bundle copied outside the record, following ADR 0008's offered-attachment path discipline. Never offer the record directory or any path inside it. The bundle contains projected messages and explicitly referenced content with stable IDs, but no record credentials or unrelated records. A read-only CLI subcommand reads bounded slices from that bundle; its argument is the offered bundle location and range, not a record root or browser token. It performs no HTTP request and provides no unauthenticated server endpoint. The trusted driver refreshes the external bundle as needed; the agent cannot use this command to traverse beyond it. Path traversal and symlink escape tests are required. Use existing private offered-copy permissions and retain the bundle for the active execution lifetime, rebuilding it on subsequent preparation. Changing the record after summary preparation invalidates affected cached ranges; capture a dispatch snapshot and reconcile new durable work before its next turn.

Show a notice when summarized context is used. If required current artifact bytes or another mandatory context item cannot fit or be read, preserve the hold instead of silently dropping it. Existing RFC 14 comparison context requirements take precedence over generic summarization. A summary failure does not authorize a truncated, context-free start.

### R9. APIs and recovery actions

All HTTP API routes use the server's existing same-origin custom-token authorization. IDs are opaque validated identities resolved through R1, not directory names. Existing-record routes, including attachment upload, MUST return not-found instead of implicitly creating a record. Only explicit creation publishes a new record; terminal creation uses the same publication and metadata rules. Error bodies contain a stable code, human-readable reason, and applicable recovery actions; no route returns a record secret.

| Route | Contract |
| --- | --- |
| `GET /api/conversations` | Paginated summaries: conversation ID, title/origin, project and working-folder status, actual/pending execution status, and per-record errors. No agent starts. |
| `POST /api/conversations` | Idempotent creation with client creation ID and explicit working folder/settings where supplied. Return the durable conversation ID. No agent starts until input acceptance. Duplicate creation ID with a changed payload is a conflict. |
| `GET /api/conversations/:id` | Retain current projection; add project/title metadata, selected settings, and execution holds. |
| `POST /api/conversations/:id/input` | Existing repeat-safe acceptance extended by R5 for managed execution; accepted response means durable input, not a started turn. |
| `POST /api/conversations/:id/driver` | Atomically replace a complete validated settings bundle, including profile and concrete model, with expected preference revision; reject partial or stale bundles. Keep current pending/running distinction; no new input or execution authorization is created; correcting settings can release already-authorized work. |
| `POST /api/conversations/:id/location` | Save an explicitly selected valid working directory and derived project. Resolve a location hold for the referenced input only after validating its expected state. Saving location alone creates no new input. |
| `POST /api/conversations/:id/title` | Validate the title and expected titleRevision; atomic compare-and-replace, conflict on a stale revision. |
| `POST /api/conversations/:id/inputs/:inputId/recovery` | Idempotent action ID, expected attempt, and action `retry` or `continue-fresh`, plus acknowledgement of possible partial effects for post-start outcomes. Authorize the original recoverable held, failed, or uncertain input only; reject inapplicable or stale actions. |

The exact durable creation receipt is an immutable part of the new record metadata: creation ID and normalized creation request. It is included in atomic directory publication. Creation MUST serialize identity allocation within the effective root and reconcile a lost response against published records. Compare the normalized client request before applying current defaults, then retain the resolved settings separately; a changed default cannot turn an identical retry into a conflict. Creation-ID reconciliation uses the complete cold-rebuildable index, not a page of list results. On a cold root, scan incrementally with bounded I/O concurrency and permit a retryable busy response before allocation; do not mint a record until the lookup is complete. It is not a separate registry required for discovery. A collision with a different creation payload returns E-HUB-02.

A pre-start temporary resume failure offers Retry when applicable. A permanently missing native session offers Continue in a new session if a fresh launch can work. Fresh recovery waits for that choice and supplies R7/R8 context. If no agent can start, retain the prompt and state the remedy. Do not silently continue with the previous model after the person selected another. Keep the selection so the person can see why requested and actual state differ.

Execution retries after a known startup or external failure require explicit user action; there is no failure timer loop. This does not override RFC 14's event-driven comparison preparation recovery or rechecking a corrected folder/settings prerequisite. Transport-uncertain input acceptance uses the unchanged request to reconcile under the existing receipt rules. An interrupted external attempt is not a safe pre-start retry: expose its partial results and require explicit recovery, without claiming side effects can be undone. For failed-after-start or uncertain outcomes, Continue in a new session requires acknowledgement that partial effects may already exist; it includes the partial transcript and a direction to inspect current workspace state before continuing the original request. It preserves the original input identity and records a new attempt, not a new accepted prompt. Do not offer Retry into an uncertain native transcript. If fresh execution is unavailable, retain the outcome and explain the remedy. For an unknown-cause pre-start refusal, show the typed evidence, offer explicit Retry only when the same route remains valid, and offer fresh continuation only when that route can independently start; never label the native session missing without evidence.

There is an unavoidable crash window between durable attempt-started and process launch: the next process cannot infer from missing output whether launch occurred. Classifying this window as uncertain can require fresh recovery even when nothing actually ran. The UI says effects may exist, not that they occurred, and retains the old native session for inspection. A post-spawn marker narrows diagnostics but its absence cannot prove non-execution, since a crash may occur before the marker. Only positive durable evidence tied to the attempt can establish a safe pre-start failure. This conservative cost is explicit; do not weaken the rule by assuming no output means no effects.

## State Machine

Draft and Acceptance uncertain are browser states; they do not assert durable acceptance. The remaining states derive from accepted input, execution facts, dispositions, and current prerequisites as defined in Terminology. Opening a record never changes authorization.

| State | Trigger and guard | Next state / action |
| --- | --- | --- |
| Draft | Successful repeat-safe acceptance | Pending; append requested intent atomically. |
| Draft | Admission or storage failure | Draft; retain editable input, no worker. |
| Acceptance uncertain | Retry unchanged ID and payload | Original accepted receipt or explicit admission refusal; never a fresh identity by timeout. |
| Pending | Folder/settings/context unavailable, incompatible attached source, or live unattached terminal owner | Held with a cause and applicable actions. |
| Pending | All dispatch guards pass and executor acquired | Starting; append attempt-started before external dispatch. |
| Starting | Harness acknowledges actual execution | Running; report actual driver identity. |
| Starting | Proven no execution and startup/resume refusal | Held; record pre-start failure, preserve input. |
| Starting/Running | Worker loss with no confirmed outcome | Uncertain; show partial record, no automatic side-effect retry. |
| Running | Confirmed successful turn end | Completed and confirmed context coverage. |
| Running | Failed/interrupted turn end | Uncertain or Failed (failed-after-start), retaining actual partial output and explicit recovery. |
| Held | Applicable retry, fresh, or folder remedy authorized for current attempt | Pending; increment attempt only for a newly authorized external attempt. |
| Uncertain/Failed | Applicable continue-fresh with partial-effects acknowledgement | Pending with fresh authorization for the same input; old attempt stays recorded. |
| Held/Uncertain/Failed | Stale/inapplicable action | Remain unchanged; return conflict without dispatch. |

A worker MUST finish the current turn before applying a model change or later queued prompt. Choose eligible inputs in accepted sequence order, skipping held inputs exactly as RFC 14 requires. A newly eligible input resumes its ordered place at the next boundary. An uncertain external attempt blocks further execution for the conversation until explicitly resolved, because its external effects are unknown; that is distinct from a pre-dispatch comparison hold. Existing comparison delivery guards remain in force. Dispositions describe actual admission/delivery, not speculative UI states. A context coverage update or metadata mutation MUST NOT itself mark an input applied.

## Error Handling

Use the existing record/protocol codes where they already describe the failure. The existing input-ID payload conflict remains E-COMP-06 on the input endpoint; E-HUB-02 covers creation, metadata revision, and recovery-action conflicts. Comparison preparation remains E-COMP-07, with RFC 14 recovery guidance. Add this hub-specific taxonomy without parsing human prose:

| Code | Meaning | Recovery |
| --- | --- | --- |
| E-HUB-01 | Root/record unavailable or duplicate saved identities | Explain location/conflict; preserve other readable records; no guessed record. |
| E-HUB-02 | Stale revision/action or idempotency payload conflict | Reconcile current state; do not launch or duplicate an input. |
| E-HUB-03 | Config, saved settings, selected capability, or attached-source compatibility invalid | Keep prompt pending; correct the selection/config, or upgrade the incompatible source or wait for its departure. |
| E-HUB-04 | Working directory unknown/missing | Select folder for the same pending input. |
| E-HUB-05 | Startup/resume failed before execution | Report harness failure data and applicable Retry/Continue in a new session actions. |
| E-HUB-06 | Required context cannot be prepared | Preserve pending input; retry after context availability is restored. |
| E-HUB-07 | External outcome uncertain or failed after start | Show partial state and require explicit recovery; no automatic re-execution. |
| E-HUB-08 | Conversation title invalid or generation unavailable | Manual writes refuse; automatic work keeps the valid fallback. |

Honor existing 401 behavior: stop requests and offer Reload rather than silently renewing a stale token. Root/config errors MUST NOT be reported as empty history. Store failures MUST use the existing sanitized diagnostic path without recursive logging. Recovery MUST validate the current attempt and original input even if the UI held a previously applicable action. A broad hcn `rejected` class alone MUST NOT be treated as proof of a missing native session; use typed evidence available from hcn and otherwise report the cause as unknown. Never offer an action known not to work.

## Security Considerations

The existing local filesystem and same-origin custom-header token remain authorization boundaries. Bind the server to loopback. Creation, folder selection, model selection, and recovery require the same authenticated browser authority as input submission. Resolve and validate paths on the server; do not interpolate client fields into shell commands. hcn remains the only harness invocation path.

Agent-visible context exports MUST exclude record secrets, browser tokens, credentials, and unrelated records. Historical role and source boundaries MUST remain explicit so an old document or tool result cannot become a system instruction. Display titles as text. Tool-free naming and read-only summary operations have separate sessions and cannot run the user's pending task. Attached file contents are not sent merely to name a conversation.

Launch authorization is tied to a durable accepted input and expected attempt. Recovery cannot authorize another conversation's input. Workers MUST acquire the executor lease and respect corroborated terminal presence; browser access does not authorize killing a human-owned process. Authenticated browser authority now includes selecting any valid local working folder and starting the configured harness there. A compromised browser token can therefore direct permitted harness work into a different local folder; loopback and same-origin authorization are the accepted boundary, not confinement to the original terminal cwd. Existing harness permissions still bound operations, and this RFC introduces no broader tool grants. The external context bundle excludes storage credentials by construction; it cannot promise to scrub arbitrary sensitive text already recorded in conversation messages.

## Alternatives Considered

- **Explicit registration in the hub:** rejected because a valid terminal-created record could still be absent after registration loss. Filesystem discovery addresses the original problem.
- **A separate Resume button before submission:** rejected by Kevin; the prompt is the request to continue. Recovery controls appear only after a failure or missing prerequisite.
- **Automatic fresh fallback after resume failure:** rejected because it can conceal lost native history. The person chooses applicable recovery and receives recorded context.
- **Pass native IDs between harnesses:** rejected because IDs name harness-specific sessions. Lucid transfers its recorded conversation instead.
- **Follow the Opus alias forever:** rejected because updating hcn would silently change existing conversations. Resolve and save a concrete model.
- **Rename as the topic evolves:** rejected because stable names are easier to recognize. Manual rename remains available.
- **Second database or global daemon:** rejected for this one-person, one-machine scope. Durable records and their lock discipline remain sufficient authority.

## Implementation Plan

1. Expose discovery and legacy record reading with folder association and record-level errors. Keep existing reading/annotation behavior available; verify cold rebuild and missed notifications.
2. Add XDG defaults, concrete saved settings, explicit profile selection, and legacy preference completion. Verify defaults never overwrite existing selections and invalid settings cannot silently launch.
3. Deliver hub creation and stable title generation/rename without model work on mere open. Verify repeat-safe creation and late-title race handling.
4. Extend accepted input with durable execution intents, worker launch/reconciliation, and visible holds. Verify acceptance/launch crash windows, active terminal protection, and idle exit races with a fake harness.
5. Deliver native identity capture and repeated-turn same-session recall, then model/harness context transfer and summary/full-record access. Verify A-to-B-to-A continuity and supported-profile behavior.
6. Deliver explicit failure recovery end to end, including uncertain outcomes and compatibility with RFC 14's comparison holds. Verify full repository checks and browser behavior before enabling managed execution by default.

Each slice MUST keep deterministic checks green and update the current contracts it changes in the same change. Startup slices update CONTEXT.md, architecture, driver behavior, source protocol, and ADR descriptions; metadata and offered-copy slices preserve ADRs 0008/0009. The explicit-refusal behavior replaces automatic fresh or previous-model fallback for all compatible Lucid-driven sources on the record, including terminal-launched sources; do not ship different refusal policies based on launch origin. Implementation tickets are cut after the cross-family RFC review; they include complete observable behavior, not layer-only tasks. Existing source paths remain reusable seams, not a mandate to put every addition in one file.

### Revision-1 review disposition

Revision 2 answers [Claude Opus 5's independent revision-1 review](15_local-hub-conversation-integration.review-revision-1.md). Each finding is addressed below; no approved product decision changes.

| Finding | Disposition in revision 2 |
| --- | --- |
| F1 | Apply: skip comparison/pre-dispatch held inputs and retain order among eligible inputs. Uncertain external execution is a distinct conversation-wide execution block. |
| F2 | Apply: offer copied context outside the record under ADR 0008, never an inside-record path. |
| F3 | Apply: eligibility explicitly combines durable authorization with current locked sidecar, artifact, capability, and ownership state; sidecar remedies survive a missed launch notification. |
| F4 | Apply: one identity-to-directory resolver governs every read/write/launch; missing and ambiguous IDs never mint or select another record. |
| F5 | Apply: durable offered coverage in attempt-started and confirmed coverage facts name the native session, range, attempt, and evidence; uncertain coverage requires explicit fresh recovery. |
| F6 | Apply: comparison holds keep E-COMP-07, event-driven triggers, and durable suppression across automatic worker restart. |
| F7 | Apply: bounded retrieval is an offline CLI subcommand over an offered copy, with no HTTP auth exception. |
| F8 | Apply: worker environment cannot inherit root/harness pins over the resolved conversation selection. |
| F9 | Apply: discovery derives fallbacks in memory; submission persists the initial revision before generation. |
| F10 | Apply: the worker owns separate naming jobs; unresolved settings defer eligibility without consuming attempts. |
| F11 | Apply: existing-record endpoints no longer create; explicit creation and terminal minting share publication rules. |
| F12 | Apply: creation reserves dot-prefixed staging directories and discovery always excludes them. |
| F13 | Apply: failed-after-start is an explicit attempt outcome, state, error, and recovery transition. |
| F14 | Apply: specify managed-input-v1 attach capability, absence semantics, new envelope protection against old readers, and the interactive-attribution rule revision; cite the source contract. |
| F15 | Apply: the harness vocabulary and driver-choice projection carry hcn's alias map. |
| F16 | Apply: complete settings replacement requires a revision and all required dimensions; effort-only partial replacement is refused. |
| F17 | Apply adapter-support and unknown-failure rules in the normative body. Do not adopt live-model execution as a universal gate: repository policy makes deterministic adapter proof gating and live confirmation separate evidence. Unverified routes are not advertised as supported. |
| F18 | Apply: describe invocation-scoped coordination plainly and require current contract updates in each implementation slice. ADR 0001's transport decision remains unchanged. |
| F19 | Apply: disclose that authenticated browser authority now selects local execution folders; existing tool grants do not imply cwd confinement. |
| F20 | Apply: discovery and launch reconciliation last for the running server's lifetime, even with no connected browser. |
| S1 | Apply: define eligible input and its authorities in Terminology. |
| S2 | Apply: ignore relative XDG_CONFIG_HOME and use the standard fallback. |
| S3 | Apply: retain E-COMP-06 for accepted-input payload conflicts; scope E-HUB-02 to other conflicts. |
| S4 | Apply: separate browser acceptance uncertainty from durable execution states. |
| S5 | Apply: explicit refusal policy covers compatible terminal-launched and hub-launched drivers. |
| S6 | Apply: identify locked sidecar replacement as a new combination, required of every writer. |
| S7 | Apply: creation reconciliation uses a complete index with bounded I/O concurrency and busy/retry behavior, independent of list pagination. |
| S8 | Apply: use MUST for supported native resume adapters. |

The review cleared two-line append atomicity based on exception rollback. That conclusion does not cover abrupt process loss after one complete line reaches disk: cleanup cannot run, and the old reader accepts the complete prefix. Revision 2 therefore uses one managed-input envelope for input and authorization. Verification includes termination at each write boundary, not only thrown write errors.

Additional author checks: make hcn budget, alias, tool-isolation, and native-resume accounting prerequisites explicit; compare creation retries against the original client request before changed defaults; preserve post-start recovery authorization independently of an already-applied input disposition.

### Revision-2 follow-up disposition

Revision 3 answers the [focused Claude Opus 5 review of revision 2](15_local-hub-conversation-integration.review-revision-2.md).

| Finding | Disposition in revision 3 |
| --- | --- |
| F1 | Apply: distinguish session-scoped coverage-confirmed facts from input-execution facts, with explicit keys and optional managed-attempt association. |
| F2 | Apply: metadata/settings writes create no input or authorization, but may release work already authorized by submission. |
| F3 | Apply: incompatible live sources have a named E-HUB-03 hold, upgrade/wait guidance, and source-change/departure re-evaluation. |
| F4 | Apply: managed-capable attach carries explicit/automatic origin; a stable explicit-attachment identity is consumed once for hold recovery. Process restart alone never supplies this intent. |
| F5 | Record the conservative pre-launch crash cost rather than invent proof of non-execution. A post-spawn marker cannot close the crash window before its own write. Fresh recovery remains explicit, says partial effects may exist, and retains the old native session. Positive durable evidence can still establish pre-start failure. |

Additional author correction: distinguish derived-naming launch eligibility from execution launch eligibility so a task prerequisite hold does not contradict R4's independently eligible naming job.

### Migration and rollback

Existing records remain discoverable and readable without eagerly rewriting every record. Add metadata and completed preferences on creation, explicit edits, or first start as specified above. Preserve the original identity, log, artifacts, and attachments. Metadata/preference format revisions MUST distinguish missing values from invalid values, and old unknown log entries remain carried.

Deploy managed execution as an explicit new-writer capability. Existing drivers that cannot understand execution holds or context coverage MUST NOT execute new managed inputs. Extend attach with optional capabilities, an optional array of at most 16 distinct names of at most 64 ASCII characters each; managed-input-v1 declares support for R5 holds, attempts, coverage, and recovery. Absence means unsupported. The host records the declaration for the current participation and does not deliver managed inputs to a source lacking it; unknown capability names confer no authority. Codec and source documentation changes are part of this RFC. Old binaries cannot enforce a new declaration, which is why managed input uses a new source envelope rather than an ordinary input line followed by an intent. Older readers carry that envelope without dispatching it. Their delivery cursor MUST NOT control managed eligibility; compatible readers rebuild it from the managed facts. A record with managed inputs requires upgraded writers for execution; old executable use is an unsupported downgrade, not something new metadata can prevent on disk. Upgrade or wait for an incompatible live terminal session rather than sending it managed work it cannot safely honor.

Rollback first disables new managed acceptance and lets compatible workers settle or expose their outstanding attempts. Keep new execution facts and receipts readable; do not strip them to make an older binary run. Restoring an old binary for execution is supported only for records with no unresolved managed intent and a verified compatible format. Otherwise retain read-only access through the newer reader while reverting UI entry points. No downgrade rewrites artifact history or cancels accepted work implicitly.

### Verification

The implementation gate is `bun run check`, plus the prescribed build and rendered reference checks when browser code changes. Deterministic fake-hcn oracles cover all state transitions, preserved pending prompts, native-ID attribution, cwd, profile, concrete model stability, creation/input idempotency, worker crash windows, summary failures, read-only history access, and manual-title races. Browser proof covers the hub at 390, 768, and 1440 CSS pixels with intact artifact reading and annotation.

Native harness confirmation is separate evidence and runs on demand under the repository's local-model/hcn policy. Current docs or fixture comments alone MUST NOT be labelled live confirmation of the installed harness. pi spelling drift and inaccessible Muse details from the research remain compatibility limits to resolve before advertising those specific native-takeover paths; fresh continuation with explicit notice can remain available through a supported route.

## Open Questions

No product decision remains open. Revision 3 answers the independent reviews of revisions 1 and 2; it remains Draft for review of the revised specification and local ticket breakdown. Engineering choices made while rendering the settled contracts include TOML naming, metadata revisions, atomic execution-intent facts, the worker launch boundary, and bounded title generation. A review finding that changes product behavior returns to the corresponding decision ticket; it is not silently resolved by changing the agreed behavior.

## References

### Normative

- [Product vocabulary](../../CONTEXT.md) - record, artifact, input, profile, and one-machine scope.
- [Architecture](../architecture.md) - durable append, execution ownership, and recovery; server launch role changes are explicit in R6.
- [Drivers](../drivers.md) - hcn boundary and preference/actual distinction; recall and refusal changes are explicit here.
- [Local transport ADR](../adr/0001-local-records-are-the-transport.md) and [execution-lock ADR](../adr/0003-kernel-locks-divide-append-authority-from-execution.md) - governing authority boundaries.
- [hcn boundary ADR](../adr/0005-hcn-owns-harness-differences.md) and [preference ADR](../adr/0009-a-preference-is-not-an-event-or-a-claim-about-reality.md) - shared seams and provenance.
- [Source protocol](../skill-chat-substrate.md) and [browser/agent authority ADR](../adr/0008-browser-and-agent-content-have-separate-authority.md) - attach changes and offered-copy security.
- [RFC 14: Annotated content comparison](14_annotated-content-comparison.rfc.md) - repeat-safe input acceptance and required delivery context.
- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) - normative language.

### Informative

- [Wayfinder map](https://github.com/dungle-scrubs/lucid-v2/issues/199) - decision index.
- [Discovery decision](https://github.com/dungle-scrubs/lucid-v2/issues/200), [resume research](https://github.com/dungle-scrubs/lucid-v2/issues/201), [startup decision](https://github.com/dungle-scrubs/lucid-v2/issues/202), [configuration decision](https://github.com/dungle-scrubs/lucid-v2/issues/203), and [title decision](https://github.com/dungle-scrubs/lucid-v2/issues/204) - full decisions and evidence limits.
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/latest/) - absolute configuration paths and fallback, accessed 2026-09-07.
- [Claude session restoration](https://code.claude.com/docs/en/sessions) - documented native recall and model override, accessed 2026-09-07.
