muse: workspace root: /Users/kevin/dev (cwd default)
Findings ranked: sink-the-project first, then under-specified mechanics, then decisions to lock before code.

### 1. LOAD-BEARING - would sink the project if built as written

**[LB1] The interactive path has no pipe into the harness - `lucid wait` as described cannot capture agent output.**
- Files: [PLAN.md](/Users/kevin/dev/lucid-v2/PLAN.md:170-193) `Part 1 - interactive path + enforced lucid wait interface` vs ground truth [CONTRACT.md](/Users/kevin/dev/lucid/docs/CONTRACT.md:399-411) (`wait` tails the log), [CONTEXT.md](/Users/kevin/dev/lucid/CONTEXT.md:268-279) (D-068)
- Plan claims: agent "already running in a terminal" opts in by running `lucid wait` as a long-lived subprocess that "emits one JSON object per line (agent output chunks)" and "reads one JSON object per line (human input)".
- Risk: `lucid wait` is a child of the interactive harness process, not its parent. It has no handle on the harness's stdout/harness transcript. There are only two ways output gets into the channel: (a) harness transcript is tailed (like v1 `wait` tails the log / `~/.claude/sessions` / `~/.local/share/muse/sessions`), or (b) the agent voluntarily copies its own tokens into `lucid wait`'s stdin (cooperative). Plan picks (b) implicitly via the skill, but never says so. That makes the headless path machine-parsed (normalizer parses `stdout-jsonl` vs buffered) and the interactive path trust-the-agent - opposite ownership and failure semantics - yet [PLAN.md:176-179] calls them "one AgentEvent shape" and a "transport swap."
- v1 scar this papers over: `harnessTranscriptPath` is per-harness, and claude buffers whole turn (stall watchdog needed) while codex streams `thread.started`. If interactive path relies on cooperative echo, the stall watchdog, limit matchers, and streaming fidelity guarantees of the normalizer never apply. If it relies on tailing the store, the NDJSON-over-stdio transport is wrong - it should be a file tail + presence `ps` check as in [presence.ts].
- Would change mind: a one-paragraph concrete mechanism diagram: does `lucid wait` (interactive) tail the harness store file and translate it to `AgentEvent` using the same `decodeIdentity`/`output` parsers as the headless path, or does it require the agent to `echo` tokens? If tail, define who translates buffered claude output to streaming tokens and where backpressure queues. If cooperative, admit the two paths have disjoint trust/fidelity and the "one shape" is a semantic claim, not a transport claim.

**[LB2] "Two paths, one stream" hides 3 real divergences: backpressure, ownership, failure. The slogan will break.**
- Files: [PLAN.md](/Users/kevin/dev/lucid-v2/PLAN.md:158-179), [PLAN.md:89-94] execution layer `streamTurn() -> async iterator + input writer`
- Risks:
  - **Ownership:** Headless: lucid owns the child and can `kill`+`resume` same native id. Interactive: lucid does not own the process (D-068 `hub yields and spawns nothing`), cannot kill, cannot guarantee single-writer without `flock` + `harnessPresence` + `ps`. A shared `AgentEvent` shape does not make `input writer` mean the same thing - in headless it is stdin of a child you spawned, in interactive it is a promise that a cooperating agent will poll `lucid wait` and inject.
  - **Backpressure:** Headless backpressure is OS pipe: normalizer drains stdout, stalls if consumer slow. Interactive backpressure is NDJSON queue between `lucid wait` subprocess and app server. A slow chat halts one but not the other. Plan lists backpressure as "first-class test concern" [PLAN.md:210-211] but specifies no queue depth, drop vs block policy, or ordering guarantee across path handoff.
  - **Failure:** Headless death => `limit|error|done` event from parser. Interactive death => `lucid wait` subprocess death, which is indistinguishable from "agent idle and closed wait" vs "terminal killed" without presence check. Recovery is `presence`+`resumeCommand` in v1, not an event.
- The "mode switch becomes a transport swap" is false where it matters: you still need D-068's presence-gated single-attendant invariant, `flock`, and `WORKING_GRACE_MS` split predicates ([CONTEXT.md:633-640]). That logic cannot live in the normalizer's execution layer without lucid's log.
- Would change mind: a state machine that models `interactive + channel live` vs `interactive + channel dead` vs `headless` with explicit ownership arrows, and an `AgentEvent` type that carries transport provenance (`source: harness-stdout | cooperative-echo`) plus a spec for what `inputWriter.write()` is allowed to do mid-turn per harness (claude headless `-p` is non-interactive, so mid-turn inject is impossible).

**[LB3] 4.4 "v2 can tell the agent directly" contradicts its own fallback and overstates vs v1.**
- Files: [PLAN.md](/Users/kevin/dev/lucid-v2/PLAN.md:233-241) vs [PLAN.md:222-227] `interactive + channel dead -> surface resume command`
- Plan claims v2 removes v1's limit where lucid never owned interactive stdin and could only hand a copyable `interactiveResumeCommand`. Benefit: lucid holds the live `lucid wait` channel so it can "push input or wake the agent" without copy-paste.
- Risk: the next bullet defines the state where the channel is dead as needing exactly that copyable command or a headless re-launch. The agent is most likely to be unreachable precisely when wake matters (after `wait` timed out to `suspended`, agent exited wait loop per [CONTRACT.md:154-155] `suspended -> must stop re-issuing`). At that point lucid has no pipe. The "can wake directly" holds only for the narrow window where the agent is still blocked inside `lucid wait` - which is exactly when v1 also could wake it by returning the wait payload ([CONTRACT.md:400-405] `wait` returns `feedback` immediately if queued). The mechanism is not new, the window is not larger, and the hard case still requires human action.
- v1 `wait` already was the wake mechanism: `wait` blocks, server returns `feedback`. Renaming it NDJSON stdio does not create a new write path into the harness.
- Would change mind: proof that interactive harness stdin is actually writable via `lucid wait` (e.g., harness exposes an `approve` fifo, or `wait` injects via harness native API), or a narrowed claim: "wake without copy-paste only while wait is alive; otherwise fallback" plus a metric for what fraction of idle time wait stays alive.

### 2. GAPS - under-specified, will cause rework

**[G1] Normalizer execution layer line is undefined and couples reuse.**
- Files: [PLAN.md:73-100] 3 layers, [PLAN.md:89-94] execution owns spawn/stdio/stall/identity; [recipes.ts](/Users/kevin/dev/lucid/src/launch/recipes.ts:39-74) shows v1 keeps recipes as data and execution lives outside (attend/launch)
- Risk: putting `runTurn/streamTurn` that does `spawn + stdio drain + stall watchdog + identity discovery` in the library bakes in: runtime (Bun vs Node child_process - [PLAN.md:143] open), signal policy, timeout values, log location, `requiredArgument` handling, and the fallback quarantine for `HSI004/HSI005` ([LAUNCHER.md:132-138]). A consumer that wants different supervision (hub daemon vs ephemeral TUI vs test harness) cannot reuse parsing without inheriting process policy. "Direct headless CLI access" is ambiguous between "library runs the turn" vs "library gives you a function that runs the turn given a spawn primitive."
- Where the line should be: `knowledge` (descriptors) + `interpretation` (pure `buildLaunchArgv`, `decodeIdentity`, `detectLimit`, `capabilitiesOf`, `isInteractive`) is clearly reusable. `execution` should be a thin `spawn -> event stream` adapter parameterized by a `Spawner` interface, so lucid-v2 can supply daemon-aware spawning but share the parser. As written, the seam is all-or-nothing.
- Would change mind: an interface sketch: `streamTurn(opts, { spawn, clock, stallMs })` where `spawn` is injected, and proof that kill/resume tests can run with a fake spawner. Or explicit decision to keep execution in lucid-v2 and let normalizer export only interpretation + `decodeChunk`.

**[G2] Capability surfacing as static per-(harness,model) data will silently misroute images for pi.**
- Files: [PLAN.md:130-137] `capabilities: per-(harness,model) ... carries on identity event`
- Risk: for `claude-code`/`codex`/`muse-code` the model set is enumerable, but for `pi` the model id is open (`--model <id>` can be any provider string, see [recipes.ts:177] `pi --model`) and the normalizer cannot enumerate vision capability. Declaring `vision: false` for an unknown pi model when the harness could handle it drops feedback. Declaring `true` sends raw images to a text-only model (plan notes agent "silently cannot" see them [PLAN.md:132]). The `capabilities` map being extensible does not fix stale knowledge - drift detection is explicitly deferred ([PLAN.md:122] CI later).
- Is it knowable statically? No for pi. Even for claude, `opus` alias vs `claude-opus-5` ([PLAN.md:64] model spelling) means static list must track aliases. The harnesses themselves know at runtime (pi knows if `--model` supports vision). The right level is harness-reported, not normalizer-declared.
- Would change mind: evidence that `pi` model list is closed and enumerable in normalizer, or a design where normalizer declares `capabilitiesOf(h, model) -> Capabilities | unknown` and `unknown` triggers runtime probe / graceful transcription fallback (already mentioned [PLAN.md:134] "transcribed to text ... or held") with a defined fallback.

### 3. DECISIONS deferred that need lock before code

**[D1] 7.6 AgentEvent ownership is load-bearing and must be decided first - but it is not alone; 7.4 transport is co-first.**
- Files: [PLAN.md:323-326] open decision 7, [PLAN.md:73-100] architecture, [PLAN.md:188-193] NDJSON-over-stdio assumption
- Why first: who owns `AgentEvent` decides dependency direction and publish shape. If normalizer owns it, lucid-v2 depends on normalizer's release for every new event kind (artifact as chat message later). If lucid-v2 owns chat protocol and normalizer maps into it, convergence is an adapter, not a shared shape, and "transport swap" is not a single type. This choice determines whether execution layer returning `AsyncIterator<AgentEvent>` is the chat protocol or a harness-private stream.
- Why 7.4 is equal: NDJSON-over-stdio vs SSE vs socket decides whether the interactive path can work across the hub's process boundary (hub is a daemon, maybe not ancestor of terminal). Stdio only works when `lucid wait` is child of the agent shell; if the agent is remote or hub needs to reach it, a long-lived socket/long-poll is required. Choosing stdio now and discovering you need a socket later forces a second protocol.
- What to decide now: pick stdio + a framing spec (NDJSON lines, `kind` enum, `issue` on malformed [PLAN.md:195-202]) and commit that `AgentEvent` is owned by the normalizer as `HarnessEvent` and lucid-v2 defines `ChatEvent = HarnessEvent + provenance`, with an explicit adapter tested on both paths. Would change mind if a prototype proves stdio can be tunneled through hub's existing per-session loopback (`server.json` port handshake [CONTEXT.md:415-418]) without a socket.

**[D2] 7.2 Runtime (Bun vs Node vs both) gates Execution layer correctness.**
- Files: [PLAN.md:141-142], [PLAN.md:61-72] `stdin` pi hang `< /dev/null`
- Impact: `spawn` semantics differ (Bun `$` vs `node:child_process`, stdin close, `setsid` for detached hub, Keychain access for detached [LAUNCHER.md:308-317]). Library claiming "direct headless access" must pin this or tests on Bun will not prove Node and vice versa. This is a publish/package decision with security fallout (`shell: false` vs shell).
- Lock: "Bun first, Node types pass" or "both, with injected spawner" before writing `streamTurn`.

**[D3] 7.1 Knowledge as code vs data determines user overrides and CI drift story.**
- Files: [PLAN.md:140-142], [harness.ts](/Users/kevin/dev/lucid/src/core/harness.ts:17-46) (normalization is pure code), [LAUNCHER.md:14-18] registry is `harnesses.json` data-file today
- Impact: code-shipped defaults plus validated override file ([PLAN.md:140-141]) preserves v1 behavior (load failure throws `ValidationError` with path [recipes.ts:169-170]) but execution layer centralizing stall/limit matchers as code means a harness flag change requires a library release, not a user edit. Deferred decision invites two sources of truth.
- Lock: agree on "code defaults, `$LUCID_HARNESSES` override validated exactly as v1 does, with version pin per descriptor" before scaffolding `~/dev/harness-cli-normalizer` so tests can assert override wins.

---

**Governing constraint audit - milestone-1 test surface insufficient even if it passes**

Files: [PLAN.md:242-262] 7 tests vs [CONTEXT.md:268-279] D-068 hardest problem, [CONTRACT.md:399-411] cursor + at-least-once, [LAUNCHER.md:188-193] flag insertion ordering

Missing cases that would falsely green-light substrate:

- **Concurrency / single-writer under race:** two feedback POSTS while a headless turn is spawning - does `flock` + presence still prevent double-drive? Not in 4.2 "path handoff" alone. Add: parallel `wait` callers with same cursor, verify dedupe by high-entropy IDs ([CONTEXT.md:292-294]).
- **Human interjecting mid-turn:** human sends input while `streamTurn` is emitting tokens. Headless `claude -p` cannot interject; interactive can. What does substrate do - queue, reject, or interrupt? Tests need explicit "input during streaming" case.
- **Multi-session / hub topology:** hub hosting many artifacts (`/s/<id>` + `server.json` per session [CONTEXT.md:256-257]) - does killing one session's server not kill others? Not covered by "kill app / kill agent / kill wait channel" alone.
- **Security:** `argvOrder` positional prompt swallowed as tool name [PLAN.md:71], `XDG_CONFIG` path traversal, `hasControlCharacters` selector bounds [recipes.ts:264-265] - none exercised.
- **Presence race / resumeLast:** `resumeLast` race ([PLAN.md:56] codex `--last`) and corroboration ranking ([LAUNCHER.md:125]) not in "session continuity" which only tests explicit id.
- **Backpressure fidelity under slow consumer:** plan says "no drops, no dupes" [PLAN.md:255] but defines no queue depth / `highWaterMark` / what happens when NDJSON writer blocks.
- Added test that would falsify the slogan: resume same native id headless->interactive and interactive->headless while tokens are in flight, assert ordered, exactly-once delivery via `nextCursor` echo.

If these are deferred, the substrate will pass milestone 1 yet still require the review surface to be load-bearing to hide transport gaps - the exact inversion failure v2 exists to avoid.


