# lucid-v2 - plan

<!-- D-012 --> Registered as the RFC for the `00-chat-substrate` plan;
RFC+REVIEW treated as externally satisfied (Codex+Muse round 1, Claude Code
round 2, lucid ratification of all decisions). Revision history retained
below.

> Status: RFC (v4). Revised twice: v3 after an independent Codex + Muse
> review (docs/reviews/{codex,muse}-review.md), v4 after a round-2 review by
> Claude Code itself - the harness milestone 0 targets - which verified the
> round-1 fixes and settled the two factual questions the whole design leaned
> on. The round-2 facts, verified against the installed CLI (2.1.226) and
> current docs, not the plan's assumptions:
>
> 1. **Claude streams.** `claude -p --output-format stream-json --verbose
>    --include-partial-messages` emits token-level deltas. Bare `-p` buffers -
>    that was the v1 scar, and it is an invocation choice, not a harness fact.
> 2. **Claude holds persistent headless sessions.** `--input-format
>    stream-json` gives a lucid-owned, bidirectional, multi-turn process:
>    messages stream in, tokens stream out, across turns, in one process.
> 3. **No harness supports tapping an arbitrary live terminal session.** Not
>    claude (no inject API; `--resume` reattaches to the same id with no
>    concurrency guard - see D-018; MCP channel injection broken;
>    IDE socket is view-mostly), and pi's RPC mode changes process ownership.
>    What IS achievable for claude: sessions started lucid-aware (hooks
>    pre-installed) can be observed at message/tool granularity (transcript
>    tail) and injected at tool-call and turn boundaries (PostToolUse / Stop
>    hook feedback), without taking over the terminal.
>
> Consequences folded in below: a third integration mode (headless session),
> streaming as a granularity per (harness, mode, invocation), and milestone 0
> as a capability profile instead of a pass/fail tap.

## The inversion

v1 was built outside-in: browser review surface, then the CLI protocol, then
the headless launcher, then the harness registry. The harness layer arrived
last and carries the scars of being bolted on.

v2 inverts it. Start at the substrate and build up:

1. **harness-cli-normalizer** - direct, programmatic, headless access to every
   supported harness CLI. A standalone dependency.
2. **The streaming-chat transport** - a chat session protocol that a headless
   runner, a persistent headless session, and per-harness interactive adapters
   all map into. Route a live agent conversation into the app's chat and back,
   two-way, fully tested before anything else.
3. *(deferred)* Artifact, annotation, chrome, browser review surface.

## Governing constraint

**No artifact, no annotation, no chrome, no browser review surface until the
chat-routing substrate is fully tested through every integration mode.** And
"fully tested" means against failure oracles and invariants, not happy-path
demos - otherwise the substrate will still force the review surface to be
load-bearing, which is the exact inversion failure v2 exists to avoid.

---

## Part 0 - `harness-cli-normalizer` (the dependency)

`~/dev/harness-cli-normalizer`, published as
`@dungle-scrubs/harness-cli-normalizer`. A
standalone TypeScript library that gives any application direct, programmatic,
headless access to a set of supported harness CLIs.

### What it normalizes

| dimension | what it owns | v1 scar |
|---|---|---|
| **sessionId** | how native identity is established: caller-assigned vs discovered | v1 `SessionIdentityRecipe`; codex mints its own thread id |
| **resume** | resume a named session id | claude `--resume <id>`, muse positional `resume <id>` |
| **resumeLast** | resume the most recent session with no id | codex `--last` race |
| **provider** | provider/model-route flag where present | pi `--provider` |
| **effort** | per-model effort vocabulary | codex per-generation subsets |
| **model** | the harness's own model-id spelling + validation | `opus` alias vs `claude-opus-5` |
| **autonomy** | "run unattended without stops" flag | `--yolo` / `--dangerously-skip-permissions` |
| **tools** | allowlist flag + spelling | `{tools}`, `--allowedTools` |
| **output** | stdout shape + declared **streaming granularity per invocation**: `token` \| `message` \| `none`. Streaming is invocation-dependent, so the descriptor pins the flag set that produces each granularity (claude: `token` only under `--output-format stream-json --verbose --include-partial-messages`; bare `-p` is `none`). Owns parsing identity/progress/limit out of the stream. A reader cannot manufacture deltas the invocation does not emit | v1 stall watchdog existed because v1 used bare `-p`; the scar was the invocation, not the harness |
| **sessionMode** | can the harness hold a **persistent headless session** - one lucid-owned process, many turns, input mid-session - and the flags that open it | claude `--input-format stream-json`; v1 spawned a fresh process per turn and forked ids |
| **storePath** | where each harness files sessions and transcripts | `~/.claude/projects/<slug>/<id>.jsonl`, `~/.local/share/muse/sessions` |
| **presence** | is an interactive process attached now? (presence says a process exists - it does NOT create a tap or input handle, and it never decides attachment; see Part 1 liveness) | v1 `harnessPresence` + `ps` |
| **parseResume** | parse a pasted resume command back to `{ harness, sessionId, autonomy }` | v1 `parseHarnessResumeCommand` |
| **argvOrder** | positional vs flag prompt + ordering | claude `{prompt}` before `--allowedTools` |
| **limitMatchers** | "stopped on a limit" vs crash vs clean exit | v1 `NOT_FOUND_MATCHERS`, `weekly_limit` |
| **stdin** | backgrounded headless calls need stdin closed | pi hangs without `< /dev/null` |
| **contextHook** | how the harness exposes context-window usage, surfaced as a `context` HarnessEvent | claude statusline `context_window.used_percentage` |
| **capabilities** | per-(harness, model, mode) capability query - runtime-resolved, with source: vision, images, streaming granularity | v1 image annotations assume the agent sees them; pi's model set is runtime-extensible |
| **discoveryFlags** | auto-loads AGENTS.md/skills/MCP + the flags that disable them | pi `-nt -nc -ne -ns` |

### Architecture - three layers, scoped to a headless runner

```
knowledge      - per-harness descriptors as DATA. Changes when a harness ships
                 a new flag. No process logic.

interpretation - pure functions over the data: buildLaunchArgv, buildResumeArgv,
                 buildSessionArgv, decodeIdentity, parseResumeCommand,
                 detectLimit, capabilitiesOf(h, model, mode) -> CapabilityResult,
                 isInteractive(sessionId) -> boolean, validateModel/Effort.

execution      - A HEADLESS RUNNER with two shapes, one the degenerate case
                 of the other. SUPERSEDED as an interface lucid calls: these
                 are hcn's internals, and hcn's only supported surface is its
                 binary (its ADR 0001). lucid reaches both shapes as
                 subprocesses and owns no descriptor. See
                 `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md` and
                 `src/harness/` for what lucid actually calls.

                 `hcn session <harness> --json`
                 One hcn-owned process, many turns. NDJSON events on stdout -
                 a `turn` line opens each turn, its events follow, a
                 turn-scoped `done` ends it, one `closed` line ends the
                 process. NDJSON commands on stdin: send, answer, close. Only
                 for harnesses whose descriptor declares a sessionMode
                 (claude via stream-json in/out; pi via RPC mode); codex and
                 muse refuse, and lucid records the refusal.

                 `hcn run <harness> --json`
                 The one-turn degenerate case: spawn, drain, watchdog, done.
                 For harnesses with no persistent mode, and for one-shot work.

                 Runtime primitives stay injected on LUCID's side of the
                 boundary (`src/harness/process.ts`), so what tests fake is
                 the hcn process - its argv, stdin, NDJSON, exit code - and
                 not a harness's own framing.

                 Runtime primitives (spawn, clock, signalling) are INJECTED so
                 Node/Bun is a real portability boundary and tests run against
                 a fake spawner.
```

**The seam:** the normalizer owns *headless runner events* and the parsing
that produces them. It does NOT own the chat protocol, persistence, the
single-writer invariant, or input-writer delivery semantics. lucid-v2 owns the
chat session protocol and maps runner events into it. A non-lucid consumer can
use the runner without importing chat types.

```ts
type HarnessEvent =
  | { kind: "identity"; sessionId; authority; capabilities: CapabilityResult }
  | { kind: "token"; text }              // only when the invocation's declared
                                         // streaming granularity is "token"
  | { kind: "message"; role; text }      // message-granularity output (e.g. a
                                         // tailed transcript's completed entries)
  | { kind: "progress"; label }          // always available
  | { kind: "tool"; name; input? }
  | { kind: "context"; usedPct?; used?; total? }  // contextHook's outlet
  | { kind: "limit"; code; message }
  | { kind: "error"; message }
  | { kind: "done"; exitCode? };         // turn-scoped. A session's end is a
                                         // separate `closed` line on the
                                         // stream (RFC-01), not this event

type CapabilityResult = {
  vision: boolean; images: boolean;
  streaming: "token" | "message" | "none";   // per (harness, model, mode) -
                                             // interactive claude is "message",
                                             // headless stream-json is "token"
  session: boolean;                          // persistent headless session?
  source: "runtime-verified" | "curated" | "unknown";
  confidence: "high" | "medium" | "none";
};
```

**Event classes (load-bearing for backpressure, Part 1):** `token`, `progress`
and `context` are **droppable** - coalescible under pressure, latest-wins.
`identity`, `message`, `tool`, `limit`, `error`, `done` are **lossless** -
never dropped, covered by replay. The split is declared here because the
normalizer emits the events; the policy that uses it lives in lucid-v2.

### What it deliberately does not do

- No review surface, no annotations, no HTML.
- No chat protocol, no conversation/turn ids, no acks, no leases, no replay.
- No input-writer delivery semantics beyond `send` on a session it owns.
- No persistence beyond resuming a native session id.

### CI around harness updates (later - noted, not milestone 1)

Descriptors drift when a harness ships a new flag, changes output, or moves its
store. Later: pin the version each descriptor was written against; a scheduled
job that installs the latest of each harness and runs the interpretation
layer's contract tests against real output, failing on drift. Optionally
scrape `--help` to surface unknown flags. Streaming granularity is part of the
contract tests: an invocation pinned as `token` that stops emitting deltas is
drift, not a stall.

### Capability surfacing - runtime query, with source

A capability is resolved, not assumed. `capabilitiesOf(h, model, mode)` returns
a set with a **source**: `runtime-verified` (queried the active
harness/registry - the only authoritative source; for pi the registry is
runtime-extensible and exposes image capability as model data), `curated`
(descriptor baseline, a default not a final word), or `unknown` (degrade: no
raw images, no streaming claim, transcribe/hold). An LLM self-asserting
capabilities through the skill is not verification.

---

## Part 1 - the streaming-chat substrate (milestone 1)

### Three integration modes, one chat protocol

The convergence is at the **chat protocol**, not at `AgentEvent`. Three
sources map into it:

1. **headless turn** - `hcn run <harness> --json`, one process per turn. The
   fallback that works everywhere; today codex and muse.
2. **headless session** - `hcn session <harness> --json`, ONE process across
   many turns, with mid-session input and (for claude) token streaming. The
   preferred headless mode where the descriptor declares a session - today
   claude and pi. It removes fork-per-turn id churn and makes mid-turn input
   real. Which of the two lucid uses is hcn's answer, asked once per run via
   `hcn inspect`, never a local assumption.
3. **interactive adapter** - a per-harness adapter subscribed to a session a
   HUMAN owns, per the adapter contract below. lucid does not own the process.

`AgentEvent` is the one-way presentation the chat renders - a projection, not
the transport. The single-writer invariant, acks, leases, and replay live in
the protocol layer **lucid-v2 owns** (decision 7.1, now resolved).

### The chat session protocol (the enforced interface)

One bidirectional session protocol, designed up front and validated at the
boundary. Sequencing and identity authority, stated once:

- **lucid is the sequencing authority.** Every frame lucid accepts is assigned
  a `seq` in the conversation's durable log, exactly as v1's single log writer
  assigned `seq` under the lock. `covers` always references lucid's `seq`.
- **Sources number their own frames per attachment.** Each attached source
  holds an `epoch` (assigned by lucid at attach) and sends a per-epoch
  monotonic counter `n` on every frame, so lucid detects gaps and duplicates
  from that source and can ack them for replay-buffer trimming.
- **`epoch` is the fencing token.** Every post-attach frame carries it. A
  takeover increments it; frames carrying a stale epoch are refused, which is
  what makes the lease enforceable rather than advisory.
- **`turnId`** is minted by whoever owns the turn's process (lucid for
  headless turns/sessions, the adapter for human-driven turns), unique within
  the conversation, validated by lucid on first sight.

```
source -> lucid:
  attach      { conversationId, profile, resumeFrom?, secret, version }
              // resumeFrom: last lucid seq this source durably applied
  event       { epoch, n, turnId, event: <HarnessEvent> }
  ack         { epoch, covers }            // delivery claim over lucid seq
  disposition { epoch, inputId, outcome: applied | queued | rejected, note? }
  heartbeat   { epoch }
  detach      { epoch, reason: yield | shutdown }

lucid -> source:
  attach-ok   { epoch, lease: { expires, renewEvery }, replayFrom, version }
  refused     { issue }                    // bad attach or malformed frame -
                                           // named, never half-applied
  event-ack   { epoch, n }                 // source may trim replay buffer
  input       { seq, turnId?, id, text, mode: queue | steer }
  control     { seq, action: pause | end | switch-path }
  lease       { epoch, expires }           // renewal grant
  credit      { epoch, tokens }            // flow credits, droppable class only
```

`input.mode` is what lucid REQUESTS (`steer` only where the source's profile
allows it); `disposition` is what actually HAPPENED, and "accepted input"
means an input with a durable `applied` or `queued` disposition - that
definition is what makes the no-lost-input invariant testable. A `reject`
disposition returns the input to lucid's queue for boundary delivery or human
notification, never silently drops it.

Enforced three ways: every frame typed (unknown `kind` refused); every frame
validated (malformed rejected with an `issue`, never half-applied); the skill
documents the exact shape. The wire transport (decision 7.2) is chosen AFTER
the milestone-0 spike - but liveness semantics are transport-neutral and fixed
HERE, so the transport choice can never change the state machine.

### Liveness (the attached -> unattached detector)

v1 earned this lesson twice (`WORKING_GRACE_MS`, port-handshake-not-pid,
presence corroboration); v2 states it instead of re-deriving it:

- An attached source heartbeats every `HEARTBEAT_MS` whether or not a turn is
  running. lucid marks the channel dead after `ATTACH_GRACE_MS` without a
  frame. **Heartbeat timeout is the decider; transport close is only a hint**
  (a half-open socket looks alive; a closed one may reconnect in ms).
- The grace constants live in one place, and the protocol reducer takes an
  **injected clock**, so every timeout path is deterministic under test.
- `presence` (the normalizer's ps-level fact) **corroborates, never decides**:
  it distinguishes `interactive-unattached` (process alive, channel dead) from
  `agent-gone` (process gone). It never proves a channel.
- A lease is renewed by any frame plus explicit `lease` grants; a source that
  misses `renewEvery` long enough for `expires` to pass is takeover-eligible.
  Takeover is explicit: new attach, epoch increments, the old epoch's frames
  are refused from that moment.

### The interactive adapter contract (milestone 0)

`lucid wait` as a child of the agent cannot observe its parent's output or
inject input - its stdio connects only to itself, and presence only says "a
process exists," not "I have a tap." And round-2 established the stronger
fact: **no current harness lets an external process tap an arbitrary live
terminal session.** So the contract is a declared **capability profile**, not
a pass/fail bar:

```ts
type AdapterProfile = {
  observe: "token" | "message" | "none";
  inject:  "immediate" | "boundary" | "turn-end" | "none";
  attach:  "any-session" | "lucid-aware";   // lucid-aware = the session must
                                            // start with lucid's integration
                                            // (hooks, RPC flag) already present
};
```

The adapter contract, at whatever granularity the profile declares: subscribe
to the harness's native output/tool/turn events; deliver a human message and
report its `disposition`; heartbeat; detach cleanly; reconnect with
`resumeFrom` after a drop. A harness whose profile is `{none, none, -}` is
interactive-unsupported and falls back to headless.

**The claude-code adapter (the milestone-0 spike, shape known, to confirm):**

- **Attach**: `lucid-aware` only. Hooks are captured at session start, so the
  adapter covers sessions launched where lucid pre-installed hook config
  (project `.claude/settings.json`); it cannot join a bare session. A
  `SessionStart` hook announces identity and attaches - the agent never has to
  opt in per-turn.
- **Observe**: `message`. Tail the transcript JSONL
  (`~/.claude/projects/<slug>/<id>.jsonl`) - appended incrementally, one
  completed message/tool event per line, during the turn. No token deltas
  interactively; that is a harness fact, declared, not fought.
- **Inject**: `boundary`. `PostToolUse` hook feedback delivers queued input
  after any tool call (genuinely mid-turn, when the turn uses tools); a `Stop`
  hook drains the queue and blocks stop to continue the turn with the feedback
  (turn-end delivery, and strictly better than v1, where injection required
  the agent to voluntarily sit in `lucid wait`). Known constraints, stated:
  hook feedback is capped (~10k chars) and renders as hook output, not a human
  chat bubble, in the terminal user's view.

**The fallback ladder (claude, and the template for every harness).** Hooks
are the top rung, not the entry fee. Each rung is a declared profile; failing
one rung degrades to the next, never to silence:

1. **hooks adapter** - `{ observe: message, inject: boundary, attach:
   lucid-aware }`. Harness-mediated delivery: the harness makes the agent see
   feedback, no agent cooperation required.
2. **cooperative adapter** - `{ observe: message, inject: turn-end, attach:
   any-session }`. No hooks: the skill has the agent poll (`lucid wait` or a
   lucid MCP tool) at turn end. This is v1's D-068 model carried forward -
   injection is only as reliable as the agent's cooperation, and the moment
   polling stops it degrades to rung 3 rather than breaking.
3. **observe-only** - `{ observe: message, inject: none, attach:
   any-session }`. The transcript tail needs NO config at all - it works on
   any live claude session, lucid-aware or not. Output mirrors into the chat
   read-only; input queues with a resume instruction.
4. **headless takeover** - only in the `agent-gone` state.

**Not a rung:** firing `claude --resume <id> -p` while the interactive
session is still present. The harness does NOT fork or refuse - it appends
both writers into the same native session with no guard (D-018, measured on
2.1.226), so two writers land on one conversation. The presence gate is
necessary but NOT sufficient (D-021): in a headless-vs-headless resume both
contenders see `presence=false` and the gate does nothing, so **epoch fencing
plus the channel secret are the actual single-writer defense** - exactly one
attach wins, the loser is refused stale-epoch. "Headless takeover REFUSED
while presence holds" (4.5) covers the interactive case; the concurrent
headless-resume oracle covers the rest.

Milestone 0 proves rungs 1-3: the hooks profile against a live lucid-aware
interactive turn, the cooperative and observe-only tiers against a bare
session, plus the persistent headless session runner (mode 2) for the same
harness. What is deliberately given up, because no mechanism exists:
harness-mediated injection into a session started without lucid config, and
token-level steering of an interactive turn. Neither is load-bearing for the
review-feedback loop.

### States and the headless switch

The first draft's "v2 can wake the agent directly where v1 could not" was
wrong. While a channel is live, lucid can push through it; when the channel is
dead, lucid has no pipe, in either version. The honest state machine:

| state | meaning | policy |
|---|---|---|
| **interactive-attached** | human-owned process, live adapter channel (heartbeats current) | deliver input through the channel per the profile; render output |
| **interactive-unattached** | process alive (presence corroborates), channel dead (heartbeat timeout) | no pipe. Wait for authenticated re-attach (epoch++) or surface a resume instruction. Cannot wake directly. Headless takeover REFUSED while presence holds. |
| **agent-gone** | process gone (presence corroborates) | headless takeover: open a headless session or turn resuming the native id, or end |
| **headless-session** | lucid-owned persistent process (mode 2) | `send` mid-session; queue/steer per capability; token streaming where declared |
| **headless-turn** | lucid-owned process per turn (mode 1) | input queues between turns; a turn in flight cannot be interjected |

**Handoff is legal only at turn boundaries**, with one exception: lease-expiry
takeover, which ABORTS the in-flight turn (kill for lucid-owned processes,
abandon-and-refuse-stale-epoch for adapters) - it never silently drains it.
That single rule is what keeps delivery semantics consistent across a
mid-conversation path switch: no input is ever half-applied by two writers.

What v2 actually gains: not a new write path into a dead process, but a typed,
acknowledged, leased, replayable protocol + adapter profiles + a persistent
headless mode, so handoffs and recovery are defined instead of discovered.

### Streaming is a per-(harness, mode) capability

Token streaming is the declared `capabilities.streaming` granularity, pinned
to an invocation in the descriptor. For claude: `token` headless under the
stream-json flag set, `message` interactive via transcript tail, `none` only
for the legacy bare `-p` invocation v2 does not use. codex and pi stream
incrementally headless. Part 1 never demands a granularity Part 0 did not
declare - a reader cannot manufacture deltas the invocation does not emit.
Mid-turn interjection is likewise per-mode: `steer` where the profile or
session mode supports it, `queue` otherwise, with `disposition` reporting
which happened.

### Backpressure - who queues, what drops

Three stages, three declared policies, using the event classes from Part 0:

- **normalizer -> lucid** (headless): pull-based AsyncIterables; an unpulled
  child hits OS pipe backpressure. Acceptable and bounded: the child stalls,
  nothing is lost.
- **adapter/session -> lucid** (protocol): an adapter cannot backpressure a
  human's live session, so lucid grants `credit` for the **droppable** class
  only; under starvation the source coalesces `token`/`progress`/`context`
  (latest-wins) and NEVER drops the lossless class, which is replay-covered by
  `resumeFrom`/`event-ack`. Queue depth is bounded and named in one constant.
- **lucid -> render**: the chat renders at its own pace from lucid's durable
  log; render slowness never propagates past lucid.

### The test surface - invariants and failure oracles

"Fully tested" means invariant tests against a deterministic fake harness,
plus real-harness compatibility smoke - not demos. The protocol reducer is
pure `(state, frame) -> state | refusal` with an injected clock, which is what
makes every oracle below deterministic.

**Invariants (must hold under any sequence):** exactly one active writer per
conversation (enforced by epoch fencing, testable because stale-epoch frames
are observable refusals); no lost accepted input (accepted = durable
`applied`/`queued` disposition); no duplicated applied input (idempotent input
`id`s, dedup on replay); no cross-session leakage.

**Failure oracles (deterministic, fake harness, clock-injected):**
- two simultaneous attachments to one native session, including stale-lease
  takeover; the loser's frames refused by epoch, not by luck;
- lease expiry MID-TURN: the in-flight turn is aborted, never drained by the
  new writer;
- human interjection during streaming - queue/steer per the declared profile,
  disposition verified;
- process death after delivery but before durable ack - reconnect with
  `resumeFrom`, replay, dedupe;
- **mid-flight path handoff, exactly-once**: headless -> interactive and
  interactive -> headless while tokens are in flight; assert ordered,
  exactly-once application via `resumeFrom` + acks (the deterministic version
  of what v3 left to real-harness smoke);
- partial/malformed frames, stalled readers, bounded queues, credit
  starvation coalescing droppable events and never lossless ones;
- **channel auth** - an unrelated cross-user process impersonating an agent or
  sending `end`/`switch-path` is rejected (threat model in 7.6);
- heartbeat timeout vs slow-turn disambiguation (a long silent turn with
  current heartbeats is NOT unattached);
- **spawn-boundary security**: positional prompt swallowed as a flag
  (`argvOrder`), control characters in selectors, registry path traversal;
- **`resumeLast` race** (codex `--last`): two candidates, corroboration must
  rank, never guess;
- concurrent unrelated sessions and identity collisions; killing one
  conversation's source disturbs no other.

**Real-harness compatibility smoke (the original seven):** headless
single-turn; interactive single-turn; session continuity across paths; path
handoff; streaming fidelity; limit/error propagation; kill and resume.
Necessary but no longer the proof.

Human-facing surface for testing: a minimal TUI or raw stdio. No browser.

### What milestone 1 deliberately excludes

Artifact authoring, annotation, the addressable surface, version snapshots, the
review log, chrome, the shell, the hub, fork launching - until the substrate is
green against the invariants.

---

## Deferred

- **Artifact as a chat message** - once transport is proven, an agent emits a
  self-contained HTML document as a special message type the chat renders inline
  and makes addressable.
- **Annotation, chrome, versions, the review log, the shell** - as v1, on top of
  the substrate.
- **The artifact-authoring skill** (v1 `lucid` / `lucid-design`) - separate,
  later.
- **Remote attach** - a source not on this filesystem needs out-of-band secret
  provisioning and a socket transport; deferred with 7.2, and nothing in the
  protocol precludes it (the frames are transport-neutral).

---

## The milestone-1 skill

The third enforcement layer. Tells an agent how to participate: how a
lucid-aware session attaches, how a bare session participates cooperatively
(rung 2 - poll at turn end, never busy-loop), or how it is driven headless;
the chat session protocol; closing cleanly. Covers: the frames, epoch fencing, and the
single-writer rule; declaring capabilities with source (runtime-verified, not
self-asserted), including streaming granularity and vision; adapter profiles
and the per-harness truth about injection granularity; `disposition`
discipline; limit/error reporting; when to yield vs keep the turn open.

---

## Decisions

The ten below (D-001..D-010) were ratified in the artifact review,
2026-08-10. The planning pipeline added further decisions (D-011 onward:
create-interview choices, the adapter fallback ladder, the spike-derived
resume-identity and hook-isolation findings, and the pre-CONVERGE review
outcomes). **The canonical, complete decision ledger lives in
`docs/decisions.md`** - all 48 decisions from both planning passes, each
with the reason it was taken. It was exported from the retired plan-db
tooling; this prose is a summary and defers to it rather than
re-enumerating every code. Note that codes are per-plan: a bare `D-011` is
ambiguous between the two passes. Resolved in this revision:

1. **Protocol ownership (was 7.1): lucid-v2 owns it.** Inside lucid-v2 the
   protocol is a pure reducer (frame schemas + `(state, frame) -> state |
   refusal` + lease/epoch logic, injected clock) hosted by the durable store,
   which does the enforcement. That reducer/host seam is a module boundary,
   not a package: the normalizer never imports chat types (Part 0 seam), the
   adapters live in lucid-v2, so a standalone protocol package would have one
   consumer. Extract it the day a second consumer exists; the pure reducer
   makes that extraction mechanical.
2. **Sequencing authority: lucid mints `seq`; sources mint per-epoch `n`;
   `epoch` fences.** Stated in 4.2; recorded here because it gates all
   protocol code.
3. **Milestone-1 scope (was 7.3): one fully-proven vertical slice,
   claude-code.** Both headless modes plus the hooks adapter profile, end to
   end - then pi (whose RPC mode should yield the strongest adapter profile),
   then codex, then muse.
4. **Channel authentication (was 7.6): the secret is minted when lucid
   creates the conversation record**, stored 0600 in the record dir, read by
   the attaching CLI/adapter from disk - possession of file read access IS the
   authorization, so the interactive path has no bootstrap chicken-and-egg.
   Threat model, stated: this defends against cross-user access and
   accidental cross-talk; a same-user local process is OUT of scope (it can
   read the file, and could ptrace regardless). "Bound at attach" is dead -
   a first attacher must never mint the secret. Remote attach: deferred.
5. **Runtime target (was 7.4): both, via injected primitives** - what makes
   fake-spawner tests possible.
6. **Knowledge (was 7.5): code defaults + validated override file**, override
   wins, load failure throws with the file's path (v1's behavior preserved).

Ratified with the recommended option:

7. **Wire transport: deferred by decision.** Chosen AFTER the milestone-0
   spike. stdio only works when lucid owns the child; a remote agent or a
   non-ancestor hub needs a socket/RPC. Liveness is already fixed
   transport-neutrally (4.2), so this choice cannot change the state machine.
8. **Capability authority: the adapter queries the active harness/registry
   at attach (runtime-verified); curated is the fallback.**
9. **Human-facing test surface: minimal TUI.**
10. **Package name: `@dungle-scrubs/harness-cli-normalizer`** (published;
    the working name in this plan was `@dungle-scrubs/harness-cli`). lucid
    depends on its `hcn` binary, not on the package as a library - see
    `docs/rfc/02_consume-the-normalizer-through-hcn.rfc.md`.

---

## Build order

1. **Milestone 0 - the claude-code spike, three parts.** (a) The persistent
   headless session runner: stream-json in/out, `--include-partial-messages`,
   multi-turn over one process, mid-session input. (b) The hooks adapter on a
   lucid-aware interactive session: SessionStart announce, transcript-tail
   observation, PostToolUse/Stop boundary injection, without taking over the
   terminal. (c) The degraded rungs on a BARE session: transcript tail with
   zero config (observe-only), and skill-driven cooperative polling
   (turn-end inject). Together they confirm the profile vocabulary and the
   fallback ladder against reality before any protocol code.
2. **Scaffold `~/dev/harness-cli-normalizer`.** Knowledge + interpretation for
   claude-code, then codex, pi, muse.
3. **Execution layer.** `openSession()` + `streamTurn()` with injected
   spawn/clock/stall, returning `HarnessEvent`. Prove with a fake spawner.
   (Done, inside hcn. lucid reaches both as `hcn run|session --json`
   subprocesses; the fake it proves against is the hcn process, not a
   harness.)
4. **The protocol reducer in lucid-v2.** Frames, epoch fencing, leases,
   replay - with the invariants as tests against a fake harness and an
   injected clock.
5. **lucid-v2 mapping.** Map all three modes into the protocol; implement
   states + liveness + handoff.
6. **The milestone-1 skill.**
7. **Run the full test surface** (invariants + failure oracles + real-harness
   smoke). Fix until green.
8. **Only then:** artifact, annotation, review surface as a layer on top.
