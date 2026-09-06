# Codebase audit - lucid-v2

Read-only audit of the whole repository at `d9c8de0` on `design-reading-view`,
2026-09-05. Nothing was edited, committed, or fixed. Two parts: a
whole-application audit (Part 1) and the `codebase-audit` skill's deepen +
drift pass (Part 2), each candidate ranked with its payoff and churn graded on
the evidence ladder.

**Evidence ladder rungs used throughout:** 1 asserted, 2 pointed at the code
(`file:line`), 3 traced through execution, 4 ran a script or test against the
real code, 5 seen in the running system. Every payoff and churn claim in Part 2
names its rung.

## How this was done

- Orientation in the order asked: `CONTEXT.md`, `AGENTS.md`,
  `docs/smoke-seven.md`, `docs/decisions.md`, every `docs/rfc/*.rfc.md`
  (02 through 12), `docs/skill-chat-substrate.md`. `PLAN.md` treated as
  history.
- Every file under `src/` was read in full with the `Read` tool, plus
  `scripts/*`, `test/harness/fakes.ts`, `test/protocol/helpers.ts`,
  `test/support/dom.ts`, `test/cli/chat.test.ts` (first 220 lines),
  `test/protocol/artifacts-emission.test.ts` (first 160 lines), and the names
  of all 931 tests.
- The codebase-memory graph (`get_architecture`, `trace_path`,
  `check_index_coverage`) was used for callers and coverage. The index is
  dated 2026-08-28, so four RFC-12 files are not in it at all
  (`src/modes/honor.ts`, `src/store/driver-preference.ts`,
  `src/server/driver-choices.ts`, `src/server/client/driver-menus.ts`) and
  two are flagged partial on one comment line each (`src/cli/runtime.ts:375`,
  `src/server/client/timeline.ts:47`). Claims about those files come from the
  source, which was read directly. Graph-derived caller counts were
  cross-checked with grep.
- hcn behaviour was taken from the pinned package's README
  (`node_modules/@dungle-scrubs/harness-cli-normalizer/README.md`), not
  re-derived.
- Two probes were run against the real code from the session scratchpad,
  neither touching the repository: one for event-kind classification, one for
  the `chat` path's artifact seam (Part 1, A1 and A3).

---

## Part 1 - Whole-application audit

### 1.1 `bun run check`

Green (rung 4, run at the start of the audit).

| Gate | Result |
|---|---|
| `biome check .` | 181 files, 0 errors, 12 warnings |
| `tsc --noEmit` and `tsc -p src/server/client` | pass |
| `bun test` | 931 pass, 0 fail, 72 files, 6.3 s |

The 12 warnings, which `GLOBAL.md` says to fix regardless of who caused them:

| File | Rule | Count |
|---|---|---|
| `test/store/cursor.test.ts:13,201-204` | `suspicious/noExplicitAny` | 5 |
| `test/modes/demotion.test.ts:26,41,60` | `suspicious/noExplicitAny` | 3 |
| `src/server/client/app.css:1512,1791,1954` | `style/noDescendingSpecificity` | 3 |
| `test/server/seams.test.ts:20` | `correctness/noUnusedVariables` | 1 |

### 1.2 Correctness and robustness

Severity is the audit's judgement of user-visible effect. Each finding names
the rung its evidence reached.

#### A1 - `lucid2 chat` cannot apply a patch and never sends the artifact state block (High, rung 4)

`src/cli/chat.ts:216-228` builds the source's host seam without
`readArtifact`; `src/cli/runtime.ts:237-250` builds the same seam with it.
Two things in `src/modes/host.ts` depend on that method:

- `artifactState` returns an empty list when it is absent
  (`src/modes/host.ts:92-93`), so `composeArtifactState` prepends nothing.
  Under `chat` the agent is never told the current version, a person's save,
  or the values they left in controls (RFC-07 R8, RFC-06's state block).
- A patch-form emission reads its base through the same method
  (`src/modes/host.ts:387-395`) and is refused with
  `v<n> could not be read, so there is nothing to patch`. RFC-08's whole
  contribution is unreachable from `chat`.

Reproduced (rung 4) with a scratch script that builds `createHeadlessHost`
twice with a fake hcn, once with each shape, drives a whole-form v1 then a
patch against it:

| Host seam shape | v2 after the patch | state block in the second prompt | error events |
|---|---|---|---|
| as `runtime.ts` builds it | `<p>alpha gamma</p>` | present | none |
| as `chat.ts` builds it | none | absent | `artifact doc refused: v1 could not be read, so there is nothing to patch` |

`CONTEXT.md` names `chat` as "the way in". The rig in
`test/protocol/artifacts-emission.test.ts:61-64` carries a comment warning of
exactly this omission, and `test/cli/chat.test.ts` never exercises an
artifact (grep: no match). The root cause is the duplicated lifecycle
(`src/cli/chat.ts:8-14` says the runtime's lifecycle "is replicated here"),
and the optional-method type on `HeadlessDeps.host`
(`src/modes/host.ts:184-211`) let the two copies drift without a type error.
Part 2, candidate H2.

#### A2 - No production process grants credit, so droppable events never reach the log (Medium, rung 3)

`ConversationHost.grantCredit` has no caller outside the fold's own replay of
existing credit entries (`src/store/log.ts:550`; grep across `src/` finds no
other). `runtime.ts` and `chat.ts` never grant; only `scripts/smoke-live.ts:129`
and the tests do. The sequencer starts at zero credit
(`src/modes/sequencer.ts:119`), sends a droppable event only while
`credits > 0`, and otherwise coalesces it forever
(`src/modes/sequencer.ts:219-225`); `onCredit` fires only on a `credit` frame
delivered through `receive` (`src/modes/host.ts:1198-1200`). So under
`lucid2 run` and `lucid2 chat`, `token`, `progress` and `context` events are
never recorded.

Consequences:

- The record holds no streaming text and no progress labels; the terminal and
  browser show only the trailing `message`. The view's token/message dedup
  (`src/tui/view.ts:176-186`) never has tokens to dedup in production.
- The browser's activity model treats "a turn appends nothing between its
  input and its terminal event" as a fact about the record
  (`src/server/client/activity.ts:5-10`, `src/server/server.ts:290-297`).
  It is a consequence of the credit ledger never being opened, not a property
  of hcn. The stall alarm's tuning (`TURN_STALL_AFTER = 180`) sits on top of
  that absence.

Whether lucid should grant credit is a product decision (record growth against
live feedback). The finding is that `CONTEXT.md`'s "credit: flow control for
the droppable class" and PLAN 4.5 describe a mechanism that no shipped process
turns on, and nothing says so.

#### A3 - Event-kind classification does not cover the vocabulary; the "drift probe" has no runtime caller (Medium, rung 4)

`EventKind` names 11 kinds (`src/protocol/events.ts:36-57`).
`DROPPABLE_KINDS` and `LOSSLESS_KINDS` together name 9
(`src/protocol/events.ts:62-72`). A bun probe (rung 4):

```
EventKind values: 11  classified: 9  unclassified: [ "question", "failure" ]
isKnownEventKind(question)= false  isKnownEventKind(failure)= false
```

The comment at `src/protocol/events.ts:45-50` says naming `question` "stops
the drift probe reporting a kind hcn documents". It does not: the probe reads
the two class lists, not `EventKind`. `isKnownEventKind` has one caller,
`test/protocol/events.test.ts` (graph `trace_path`, confirmed by grep), and
`test/protocol/events.test.ts:16` pins the lossless list to exactly the six,
so the test enforces the gap. The comments in `src/harness/events.ts:12-13`
and `src/protocol/events.ts:83-86` describe a probe that does not run.
Behaviour today is unaffected (an unknown kind defaults to lossless), but the
D-032 per-class completeness oracle (`test/oracle-sweep.test.ts:22-46`)
iterates the same incomplete lists.

#### A4 - The question-demotion contract is a substring match on free text (Medium, rung 3)

The host records a demotion as an error event whose message is
`answer demoted: no-open-question for <id>` (`src/modes/host.ts:588-592`).
The reducer clears `questionOpen` when any accepted `error` event's message
contains `no-open-question` (`src/protocol/reducer.ts:466-471`). The protocol
between two modules is therefore a substring of prose, and it mirrors an hcn
reason string (README line 102) inside the reducer. Any other error event that
happens to carry that text (a stand-in error from
`src/modes/sequencer.ts:186-190` quoting an hcn failure, for instance) clears
an open question.

#### A5 - `ConversationLog.readArtifact` swallows every error, including lock timeouts (Medium, rung 2)

`src/store/log.ts:1614-1616` returns `null` on any throw, so a `LockError`
(30 s timeout) or a `corrupt-log` reads as "no such version". Callers then
report it as something else: restore answers `version-unreadable` 404
(`src/server/server.ts:588-589`); a patch is refused with "could not be read"
(`src/modes/host.ts:387-395`); the state block silently omits the artifact
(`src/modes/host.ts:108-109`). The same function is also the one lock
acquisition in the module without `onEvent: deps.onLockEvent`
(`src/store/log.ts:1594`), so the timeout is invisible to the boundary log
too.

#### A6 - Artifact, meta and attachment appends bypass the injected clock (Medium, rung 2)

`src/store/log.ts:1393`, `:1442`, `:1636` stamp `at` with `Date.now()`. Every
frame, input and credit entry takes `HostDeps.now`
(`src/store/conversation-host.ts:334,380,388`), and `advanceCursor` forwards
`deps.now()` (`:280`). `AGENTS.md` describes the suite as "deterministic,
clock-injected". The `at` on artifact versions is the one durable timestamp
tests cannot control.

#### A7 - `chat` folds the whole log under the append lock 20 times a second and once per keystroke (Medium, rung 2)

`src/cli/chat.ts:346` sets the tailer poll to 50 ms; `doRender` calls
`tailer.read()` (`:275`), which takes the append lock, folds every byte and
repairs the tail (`src/store/log.ts:992-1011`); `onDraft` calls `doRender` on
every key (`:450-455`). `src/store/tailer.ts:28-30` says the 500 ms cadence is
deliberate and "do not tighten it"; `runtime.ts` keeps 500. The chat process
is the driver and already holds a `ConversationHost` whose `snapshot()` reads
the cached fold; a second locked fold per paint contends with its own source's
appends (a separate fd, so `flock` blocks in the 3 ms retry loop at
`src/store/flock.ts:125-141`). Not measured; the cost is stated from the code.

#### A8 - `driver.json` is read once per turn boundary but honoured only on `queue` inputs at an idle session (Low, rung 2)

`src/modes/host.ts:647-655`: at an idle session a `steer` or `answer` skips the
boundary check by design (RFC-12: a running turn is never interrupted). With no
turn running there is no turn to protect, so an `answer` typed into an idle
session after a preference change runs on the old driver and the switch waits
for the next `queue` input. Consistent with the RFC's letter, not with its
"honored at the next turn boundary" summary in `CONTEXT.md`.

#### A9 - `honor.receive` drops non-input frames during a switch (Low, rung 2)

`src/modes/honor.ts:331-333` returns for every frame while `switching`; the
comment says non-input frames "wait for the swap", but nothing queues them.
Today the only non-input frame a source receives is `credit`, and A2 shows no
production process sends one, so the drop has no effect yet.

#### A10 - `hcn session` refused on version leaves the child running (Low, rung 2)

`src/harness/hcn-runner.ts:250-254` records a `HarnessVersionError` and
settles the open; `:347-351` throws it with `void pump`, never calling
`close()` or `kill()`. The hcn child and its harness stay up until they exit
on their own. The spawn-error path has the same shape.

#### A11 - `writeAttachment` differs from the other four appenders on failure (Low, rung 2)

`src/store/log.ts:1408-1421`: no `ftruncateSync(fd)` before the path
truncate, and `closeSync(fd)` outside a try, so a throwing close masks the
append error. `writeArtifactMeta` and `writeAttachment` also refresh only
`curGoodBytes` after their fold (`:1404-1405`, `:1452-1453`), leaving the
cached `curState` and transcript behind the file until the next append. A
contentType from the browser's `content-type` header longer than 128 units
writes the blob and then refuses the entry (`:1385-1390`,
`src/server/server.ts:725`), an orphan by design but an unvalidated header.

#### A12 - `advanceCursor(0)` writes a cursor line (Low, rung 2)

`src/store/log.ts:1528-1541`: `offset === curCursor` returns only when
`offset !== 0`, so offset 0 against cursor 0 falls through and appends
`{"src":"cursor","offset":0}`. Both callers guard on `goodBytes > cursor`
(`src/modes/host.ts:1240`, `src/cli/runtime.ts:451` behind a non-empty batch),
so it is unreachable today. The surrounding comments (`:1525-1540`) are
working notes rather than a rule.

#### A13 - `Conversations.ensure` matches a typed error by regex (Low, rung 2)

`src/cli/record-addressing.ts:198` tests `/exists/` against `e.message`
instead of `StoreError.code === "record-exists"`. `createConversationRecord`
also throws `record-exists` for a failed publish (`src/store/store.ts:54`),
which is a different fault under the same code.

#### A14 - `HarnessName` is defined three times (Low, rung 2)

`src/protocol/frames.ts:43-44` (`HARNESS_NAMES`), `src/harness/runner.ts:22`
(literal union), `src/store/driver-preference.ts:44-49`
(`DRIVER_HARNESS_NAMES`), plus the alias table in `src/cli/harness.ts:14-24`
and a hand-written check in `scripts/smoke-live.ts:24-31`. Structurally equal
today, so nothing fails; a fifth harness is four or five edits. Part 2, M4.

#### A15 - `interactive-host.ts` conjoins a live half and a dead half (Low, rung 2)

`guardHookEntry`, `readQueuedInputs`, `deliverFirstQueued`, `chunkHookInput`
reach production through the hooks. The ladder half (`RUNGS`, `PROFILES`,
`selectRung`, the three strategies, `createInteractiveHost`,
`attachCapabilities`, `chunkInjection`, `INJECTION_CAP`) has no caller
outside `src/modes/index.ts` re-exports and `test/modes/interactive.test.ts`
(grep). `cooperativeStrategy` and `observeStrategy` return constants
(`src/modes/interactive-host.ts:351-363`); `A003_GATE_OPEN` is a `false`
constant (`:252`). `deliverFirstQueued` deletes `process.env.HERDR_ENV` as a
side effect of a library call (`:182`).

#### A16 - Server: the catalog parses every version's bytes to read one field (Low, rung 2)

`viewArtifactCatalog` seeks and `JSON.parse`s each version line, document
bytes included, to read `author` (`src/store/conversation-host.ts:493-498`
via `readArtifactVersion`). The page polls it every 2 s
(`src/server/client/app.tsx:1515`). RFC-06 chose "seek per request, never
cache", and this honours it, but the catalog is defined as carrying "no
document bytes" and pays for all of them. Not measured.

#### A17 - Dead or test-only exports (Low, rung 2, grep)

| Symbol | Where | Callers in `src`/`scripts` |
|---|---|---|
| `openHeadlessSessionViaHost`, `openHeadlessTurnsViaHost` | `src/modes/host.ts:1261-1267` | 0 |
| `DeliverResultDurable` | `src/modes/interactive-host.ts:220` | 0 |
| `artifactPlaceholder` | `src/protocol/artifacts.ts:290` | 0 |
| `bindToProcess`, `presencePaths` | `src/store/presence.ts:19,55` | 0 |
| `_REDACTED`, `_isCursorEnvelope`, `curArtifactRefusals` (written, never read) | `src/store/log.ts:342,489,1229`; `src/store/store.ts:27` | 0 |
| `applyEntry` cases for `artifact`, `artifact-meta`, `attach` | `src/store/log.ts:551-572` | unreachable: both folds branch before it (`:672-706`, `:813-836`) |
| `isKnownEventKind`, `HARNESS_AWAITING_INPUT`, `heldLocks`, `lockBackend`, `backendFor`, `readInput` | `src/protocol/events.ts:86`, `src/harness/events.ts:35`, `src/store/flock.ts:53-54,88`, `src/tui/input.ts:292` | tests only |
| free-function ledger aliases (`queueDepth`, `atCapacity`, `redeliverable`, `clearRedeliver`, `isStarved`, `clampedGrant`, `renewLease`, `renewAttachment`) | `src/protocol/ledgers/*.ts` tail exports, re-exported at `src/protocol/index.ts:46-58` | 0 outside the ledgers and reducer |

#### Things checked and found sound

- Append transaction: lock, catch-up fold, reduce, write-all, fsync, rollback
  on failure (`src/store/log.ts:1243-1327`). Torn-tail repair truncates only
  behind `goodBytes`; a cursor past `goodBytes` refuses to drive
  (`:357-403`).
- `flock` primitive: fd ownership on every exit path, idempotent release,
  no fallback backend (`src/store/flock.ts:96-171`); both locks are instances.
- Reducer: epoch fencing before anything else on post-attach frames
  (`src/protocol/reducer.ts:634-639`); refusal order in `enqueueInput`
  matches RFC-05's stated order (`:881-933`); attach replay rewrites `answer`
  to `queue` (`:559-566`).
- R2 gate reads the presence handle, never the ps-probe
  (`src/store/conversation-host.ts:264`, `src/cli/runtime.ts:167`).
- Cursor advances after dispatch, lease checked between effects
  (`src/cli/runtime.ts:437-456`).
- Server: loopback bind, per-start token, custom header, origin allowlist,
  no cookies, blob names checked as hex before the filesystem, image type
  sniffed from bytes (`src/server/server.ts:135-180, 684-710`).
- Offered attachment path is outside the record, `0o700`/`0o600`, filename
  sanitised (`src/store/deliver.ts:134-142`).
- Frame sandbox: `allow-scripts` only, source-window identity check, message
  shape validated (`src/server/client/app.tsx:1651-1817, 1927-1934`).
- `blobs.ts` `new Uint8Array(readFileSync(p))` copies, so the `.buffer`
  handed to `Response` is exact (`src/store/blobs.ts:97`,
  `src/server/server.ts:698`).

### 1.3 Test coverage against `docs/smoke-seven.md`

Every file the table names exists and carries a test whose name matches the
row (rung 2, from the full test-name listing).

| # | Smoke | Named proof | Found |
|---|---|---|---|
| 1 | headless single-turn | `test/modes/headless.test.ts` | `:144` session mode, one turn mapped event-for-event |
| 2 | interactive single-turn | `test/modes/interactive.test.ts` "tail + announce"; `test/tui/view.test.ts` | announce parse at `:108`; **no tail test exists** - `tailTranscript` was removed by RFC-02 ("What is removed"), so the row is stale |
| 3 | continuity across paths | `test/gate-5-6.test.ts` | `:18` three modes, two handoffs |
| 4 | path handoff | `test/modes/controller.test.ts` D-020 both directions | `:101`, `:162`; the row's "DF-SMOKE (live)" column predates `scripts/smoke-handoff.ts`, which `AGENTS.md` lists |
| 5 | streaming fidelity | `headless.test.ts` coalescing + credit; `events.test.ts` | `:310`; `events.test.ts:31` |
| 6 | limit/error propagation | `headless.test.ts` | `:360`; the limit sequence is composed inline (allowed by `AGENTS.md`); RFC-02's named `run-claude-limit` and `session-claude-stall` fixtures were never captured (`test/fixtures/hcn` holds four files) |
| 7 | kill and resume | `store.test.ts` fold/reopen; death-before-ack in controller/reducer | `store.test.ts:149`; controller `:101,:162`; the reducer oracle's exact name was not individually verified |

Beyond the seven, each RFC has deterministic coverage: RFC-04
(`test/live-delivery.test.ts` ×6, `idle-redelivery`, `store/cursor`,
`store/collect-effects`), RFC-05 (`cli/chat`, `protocol/answer`, `question`,
`stale-answer`, `modes/demotion`), RFC-06 to 09 (`protocol/artifacts-emission`,
`server/*`, `store/artifacts`, `store/artifact-title`), RFC-11
(`protocol/attachment`, `store/blobs`, `store/deliver`,
`protocol/annotation-files`, `server/attachments`), RFC-12 (`modes/honor` ×4,
`store/driver-preference` ×6, `server/driver`, `driver-choices`,
`driver-menus`).

Gaps (rung 2):

- **`chat` + artifacts.** No test drives an artifact through `chatConversation`;
  A1 would have been caught by one.
- **Hook delivery.** No test file references `guardHookEntry`,
  `deliverFirstQueued`, `announce(` or `inject(`; only the live lane
  `scripts/smoke-interactive.ts` exercises them.
- **Dispatch and mapping.** `test/cli/` holds `chat`, `runtime`, `send`,
  `watch`; `mapSubcommand` and the `serve`/`run`/`help` branches of `dispatch`
  have no named test.
- **Event-kind completeness** (A3): the test pins the incomplete list.
- **`hcn-runner` open refusal cleanup** (A10): untested.

### 1.4 Build

`scripts/build.ts` matches `AGENTS.md`: `Bun.build` with `compile`, the
Tailwind plugin, and a post-build read of the binary for both the Tailwind
banner and a project-only selector (`scripts/build.ts:35-67`). No `bun build`
CLI use anywhere in `package.json` or scripts (rung 2). The scratch
`.bun-build` file is cleaned (`:70`) and ignored.

Two notes:

- CI never runs `bun run build` (`.github/workflows/ci.yml`), so the
  Tailwind-compiled check that the script exists for runs only by hand.
- The local `dist/lucid2` (2026-08-29) predates the hcn 0.6.0 bump commit
  `e37dbba` (2026-08-31). `dist/` is ignored, so this is a workstation fact,
  but `scripts/measure-patch-anchoring.ts:49` drives that binary.

### 1.5 Dependency pinning

Exact pins hold end to end (rung 2):

| Package | `package.json` | `bun.lock` | Floor in code |
|---|---|---|---|
| `@dungle-scrubs/harness-cli-normalizer` | `0.6.0` (`:32`) | `0.6.0` (`:9`, `:70`) | `HCN_MIN_VERSION = "0.6.0"` (`src/harness/version.ts:13`); installed `0.6.0` |
| `tailwindcss` | `4.1.14` (`:27`) | `4.1.14` (`:24`, `:316`) | - |
| `bun-plugin-tailwind` | `0.1.2` (`:24`) | `0.1.2` (`:21`, `:218`) | - |

CI installs with `--frozen-lockfile`. The fixtures were re-captured in the
same commit as the last hcn bump (`git log -- test/fixtures/hcn`: `e37dbba`).
Everything else is caret; `@assistant-ui/react ^0.10` moves patch-only under
caret on a 0.x, and `typescript ^7.0.2` is the only major-range risk.

### 1.6 Drift: `CONTEXT.md`, `AGENTS.md`, the RFCs, and the code

| Where | What the doc says | What the code does | Rung |
|---|---|---|---|
| RFC-09 Implementation step 2 | remove the `RETIRED` marking from the state block | `ArtifactState.retired` and the RETIRED wording remain (`src/protocol/artifacts.ts:323-330,359,399-403`); `HeadlessDeps.host.artifactRetired` remains (`src/modes/host.ts:103,119,189-190`) with no provider anywhere | 2 |
| `CONTEXT.md` "record" row | `log.ndjson`, `meta.json`, `driver.json`, `secret`, the two locks | RFC-11 added `files/` (`src/store/blobs.ts:32`); "What works today" omits attachments, which shipped (`git log`: `abc2d89`..`cd56aa3`) | 2 |
| `CONTEXT.md` "credit" row, PLAN 4.5 | flow control for the droppable class | never granted in production (A2) | 3 |
| RFC frontmatter | 05, 06, 07, 08, 09, 11, 12 are `status: Draft` | `CONTEXT.md` describes all of them as landed; "highest number wins" navigation has no landed/superseded marker; RFC-07's withdrawn rules are not marked in RFC-07 | 2 |
| `docs/smoke-seven.md` row 2 | "tail + announce" | the tail was removed by RFC-02 | 2 |
| `docs/smoke-seven.md` row 4 and closing section | path handoff is DF-SMOKE; failures "triage to plan-db findings" | `scripts/smoke-handoff.ts` exists; plan-db is retired (`docs/decisions.md:3-8`) | 2 |
| RFC-02 "The fakes" | five named fixtures | four exist; no limit or stall recording | 2 |
| RFC-11 "The log entry" | an implementation MUST stop relying on the unknown-`src` carry for `attach` | `attach` is in `ENTRY_SOURCES`; the RFC-04 `cursor` entry is not, and relies on the carry (`src/store/log.ts:139` vs `:329-403`) | 2 |
| `src/protocol/events.ts:45-50` comment | naming `question` stops the drift probe | it does not (A3) | 4 |
| `src/modes/honor.ts:331` comment | non-input frames wait for the swap | they are dropped (A9) | 2 |
| `AGENTS.md` "deterministic, clock-injected" | - | artifact appends use `Date.now()` (A6) | 2 |
| `lefthook.yml:9-11` | pre-commit typecheck | runs `tsc --noEmit` only; `bun run typecheck` also checks `src/server/client` (`package.json:12`), so a client type error passes the hook and fails CI | 2 |

`docs/reports/design-delta-v2.md` section 3 is marked superseded by RFC-12 as
that RFC required (`:99`). `docs/design-brief.md` and the two reading-view
reports do not mention the withdrawn list, pane or retire surfaces (grep).

### 1.7 Part 1 summary

| Id | Severity | One line |
|---|---|---|
| A1 | High | `chat` builds the host seam without `readArtifact`: no patch form, no state block, reproduced |
| A2 | Medium | no shipped process grants credit; droppable events never land; the browser's activity model was tuned around that absence |
| A3 | Medium | `question` and `failure` are unclassified; the drift probe has no runtime caller; the test pins the gap |
| A4 | Medium | question demotion is a substring match on an error message |
| A5 | Medium | `readArtifact` turns lock timeouts and corruption into "no such version" |
| A6 | Medium | artifact/meta/attachment `at` bypasses the injected clock |
| A7 | Medium | `chat` takes the append lock and folds the whole log at 50 ms and per keystroke |
| A8-A17 | Low | see above |

---

## Part 2 - Code audit - whole repository (deepen + drift)

Resolved scope: the whole repository, both families. The `codebase-design`
vocabulary is used throughout: module, interface, seam, adapter, depth,
deletion test.

One caveat on the browser client: `CONTEXT.md` says the browser surface is a
prototype awaiting a design pass from scratch and must not be built on. So
`src/server/client/app.tsx` (4,613 lines, one component holding most of the
page's state) is not proposed for deepening here; a redesign would be
designing it twice. Only domain-rule drift into the client is listed.

### High

#### H1 - `src/store/log.ts`: two folds and five appenders for one discipline

**Smell:** reconstructed meaning (drift) inside one module; callsite
boilerplate; convention-enforced consistency.

**Evidence:**

- `foldLog` (`src/store/log.ts:620-746`) and `foldCollect` (`:762-875`) are
  the same walk with one extra output; the comment at `:752-759` says "this is
  the same fold, not a second policy", and
  `test/store/collect-effects.test.ts:148-174` keeps them equal by comparing
  their results.
- The "append one line, fsync, roll back on failure" block appears five
  times: `append` (`:1282-1307`), `writeAttachment` (`:1408-1421`),
  `writeArtifactMeta` (`:1456-1481`), `advanceCursor` (`:1545-1563`),
  `writeArtifact` (`:1696-1717`), with A11's variations between them.
- The "refresh the cached snapshot from a fold" block appears five times
  (`:1249-1268`, `:1357-1370`, `:1506-1517`, `:1597-1607`, `:1654-1665`) and
  is done partially in two more places (`:1404-1405`, `:1452-1453`).
- `ConversationLog`'s interface (`:1085-1183`) has one deep method for
  reducer entries (`append(produce)`) and four bespoke writers for the
  non-reducer entry kinds, each re-implementing the lock, the catch-up and
  the rollback.

**Proposal:** one private fold (`walkEntries(raw, {collectFrom?})`) that
returns everything both public folds return, with `foldLog` and `foldCollect`
as thin projections of it; one private `appendLine(entry, at)` that owns
lock, catch-up fold, cache refresh, write-all, fsync, rollback and boundary
events, used by all five writers; `at` supplied by the caller from the host's
injected clock (closes A6). The public interface does not move.

**Payoff:** roughly 250 lines of duplicated fold and append code become one
path (rung 2, counted from the ranges above); the partial cache refresh in
`writeArtifactMeta`/`writeAttachment` (A11) and the divergent rollback (A11)
cannot recur; the clock is injected once (A6); a future entry source is one
`case`, not two folds and a writer.

**Churn:** one source file; tests that reach past the interface -
`test/store/collect-effects.test.ts` imports `foldCollect` and
`collectEffectsUnderAppendLock` directly, and `src/store/store.ts:85-93`
re-exports them - would keep working if the names survive as projections
(rung 2 for the import sites; rung 1 for the estimate that no other test
depends on the split).

#### H2 - `src/cli/chat.ts` and `src/cli/runtime.ts`: one driven-conversation lifecycle, written twice

**Smell:** reconstructed meaning across two surfaces; configuration sprawl on
the `HeadlessDeps.host` seam; a hypothetical seam made of optional methods.

**Evidence:**

- The lifecycle ensure → D-021 gate → presence → host → honoring driver →
  base deps → tailer → release is `src/cli/runtime.ts:132-291` and again
  `src/cli/chat.ts:93-252`; `chat.ts:8-14` says so.
- The two copies already disagree: A1 (`readArtifact` present at
  `runtime.ts:242`, absent at `chat.ts:216-228`), the poll cadence (500 vs
  50 ms, A7), and `chat` running a second tailer over a host it already holds.
- `HeadlessDeps.host` (`src/modes/host.ts:184-211`) declares every artifact
  method optional; `artifactState` returns nothing when one is missing
  (`:92-93`) and `handleArtifactMessage` emits "no host" errors (`:247-265`).
  Production has exactly one adapter for this seam, `ConversationHost`; the
  optionality exists for test rigs, which is the one-adapter case the design
  vocabulary calls hypothetical.

**Proposal:** one `openDrivenConversation(opts)` in `runtime.ts` returning
`{host, source, presence, profile, release, follow}`; `startHeadless` and
`chatConversation` become adapters (run: block on `done`; chat: render from
`host.snapshot()` on the runtime's own trigger and read keys). Build the host
seam once with a `hostSeamFor(host: ConversationHost)` function and make
`HeadlessDeps.host` a required interface with a named test fake in
`test/harness/` (two adapters, one real seam).

**Payoff:** fixes A1 by construction; RFC-12 honor wiring, R2 gating and the
`receive` closure exist once; A7's second lock-taking fold goes away; a
future third command (a daemon, which RFC-04 names) does not copy the
lifecycle a third time (rung 3 for the A1 mechanism, traced and reproduced;
rung 1 for the daemon claim).

**Churn:** `src/cli/runtime.ts`, `src/cli/chat.ts`, `src/modes/host.ts`
(type only), `test/cli/chat.test.ts` and `test/cli/runtime.test.ts` (they
inject `createHeadlessHostFn` and a fake host shape), plus the test rigs that
build `host:` objects by hand (`test/protocol/artifacts-emission.test.ts`,
`test/store/cursor.test.ts`, others) - rung 1, estimated six to ten files, not
counted.

#### H3 - The harness event vocabulary is owned in four places

**Smell:** parallel vocabularies; mirrored artifacts (a test that re-encodes
the list by hand).

**Evidence:**

- `EventKind` (`src/protocol/events.ts:36-57`) is the declared single source.
- `DROPPABLE_KINDS`/`LOSSLESS_KINDS` (`:62-72`) do not cover it (A3, rung 4).
- `src/harness/events.ts:59,61` spell `"failure"` and `"question"` as literals
  beside `typeof EventKind.*` for the other kinds.
- `TERMINAL_EVENT_KINDS` (`src/protocol/ledgers/input.ts:48`) and
  `UNRENDERED` (`src/tui/view.ts:160`) are two more hand-picked subsets.
- `test/protocol/events.test.ts:15-16` re-encodes both class lists as
  literals, so the test cannot catch a missing kind.

**Proposal:** one `EVENT_CLASS: Record<HarnessEventKind, EventClass>` table
in `src/protocol/events.ts`, with the two lists derived from it and a
`satisfies` check that every `EventKind` value has a class; `harness/events.ts`
uses `EventKind.failure`/`EventKind.question`; the test asserts coverage of
`Object.values(EventKind)` rather than a literal list. Either wire
`isKnownEventKind` into the sequencer's boundary log or delete it with the
three comments that promise a probe.

**Payoff:** adding a kind is one row; the D-032 completeness oracle covers the
whole vocabulary; the false comments go (rung 2 for the sites; the "one row"
claim is rung 1).

**Churn:** three source files and two test files (rung 2, counted above).

### Medium

#### M1 - The non-holder "writer host" is constructed by hand at nine sites

**Smell:** callsite boilerplate; the R2 rule ("this process never drives")
encoded as a repeated literal.

**Evidence:** `createConversationHost(dir, {now: () => Date.now(), presence:
() => undefined, executorLease: () => false, onEffect: () => {}, onRecord:
() => {}})` at `src/server/server.ts:435-441`, `:514-520`, `:569-575`,
`:737-743`, `:789-795`; the same shape in `src/cli/send.ts:76-85`,
`src/cli/hooks/announce.ts:31-39`, `src/modes/interactive-host.ts:184-192`,
and every smoke script. Five of them carry the same "R2: never the lease
holder" comment.

**Proposal:** `openWriter(dir, {now?})` beside `createConversationHost` in
`src/store/conversation-host.ts`, returning a host whose lease gate is
`false` and whose sinks are silent; the server, `send`, the hooks and the
scripts call it.

**Payoff:** the rule is stated once; A6's clock injection reaches the server
paths too (rung 2, nine sites counted).

**Churn:** nine call sites, one new function, no test changes needed beyond
the sites (rung 2 for the sites, rung 1 for the tests).

#### M2 - "The current version of each artifact" is derived from the index key at six sites

**Smell:** reconstructed meaning; a private key format (`artifactId\0version`)
decoded outside its owner.

**Evidence:** `artifactKey` encodes at `src/store/log.ts:230-231`; the decode
by `indexOf("\0")` is hand-rolled at `src/store/conversation-host.ts:474-484`,
`src/modes/host.ts:95-101`, `:272-279`, `src/server/server.ts:448-453`,
`:527-533`, `:578-583`. RFC-09's "the record holds one artifact" guard reads
one of those copies (`host.ts:301`).

**Proposal:** `ConversationLog.artifactHeads(): ReadonlyMap<artifactId,
version>` (and a matching `ConversationHost` method), built in the fold
beside the index; the six sites read it. `artifactKey`'s format becomes
private to `log.ts`.

**Payoff:** one owner for "what the record holds"; the RFC-09 predicate and
the save/restore/meta "current" lookups cannot disagree (rung 2, six sites).

**Churn:** six sites plus the `HeadlessDeps.host` type (rung 2).

#### M3 - Pass-through modules and alias exports that exist only to preserve an import path

**Smell:** thin wrapper; callers reaching past the API; mirrored artifacts
(each facade re-describes the deep module in its header).

**Evidence:** `src/cli/conversations.ts`, `src/cli/env-stamp.ts`,
`src/cli/self.ts`, `src/cli/hooks/resolver.ts` (full re-exports of
`record-addressing.ts`); `src/cli/hooks/delivery.ts:19-35` (re-exports of
`interactive-host.ts` plus two real functions); `src/modes/headless.ts`,
`src/modes/interactive.ts` (re-exports of `host.ts`/`interactive-host.ts`);
`src/store/lock.ts` (re-export of `flock.ts`); alias exports `chunkInput`,
`CHUNK_CAP_BYTES`, `chunkInjection`, `INJECTION_CAP`, `DeliverResultDurable`
(`src/modes/interactive-host.ts:106-108,220,264-269`),
`openHeadlessSessionViaHost`/`openHeadlessTurnsViaHost`
(`src/modes/host.ts:1261-1267`, zero callers). Each facade's comment invokes
the deletion test and then keeps the file.

**Proposal:** delete the facades and aliases; one import path per module;
keep the three barrels (`protocol/index.ts`, `store/index.ts`,
`modes/index.ts`) since `log.ts`, `conversation-host.ts`, `runtime.ts` and
most tests import through them (grep).

**Payoff:** about 250 lines and nine duplicated header comments removed; a
reader of `src/cli/` sees six modules, not eleven (rung 2 for the file list;
the line count is rung 1).

**Churn:** import-path edits in scripts and tests (`scripts/smoke-*.ts`
import `modes/headless.js`; tests import `modes/interactive.js`,
`cli/env-stamp.js`) - mechanical, rung 1, roughly 15 files.

#### M4 - `HarnessName` has three definitions and two hand-written validators

**Smell:** parallel vocabularies.

**Evidence:** A14. `src/harness/events.ts:20` already imports from
`src/protocol/events.ts`, so the layering protocol → harness is established.

**Proposal:** `HARNESS_NAMES`/`HarnessName` in `src/protocol/frames.ts` stay
the one definition; `src/harness/runner.ts` and
`src/store/driver-preference.ts` import them; `scripts/smoke-live.ts:24-31`
uses `harnessForName`.

**Payoff:** a new harness is one constant plus the alias table (rung 2).

**Churn:** three files (rung 2).

#### M5 - Question demotion needs a typed signal, not a substring

**Smell:** reconstructed meaning (an hcn reason string mirrored as prose and
re-parsed in the reducer).

**Evidence:** A4.

**Proposal:** carry a `code: "answer-demoted"` field on the error event the
host emits (`src/modes/host.ts:588-592`) and key
`nextQuestionOpenAfterEvent` on it (`src/protocol/reducer.ts:466-471`); or
clear the question on the demoted `send`'s `applied` disposition, which the
reducer already handles for the answer case (`:770-771`).

**Payoff:** the reducer stops depending on prose; an unrelated error cannot
close a question (rung 3, traced).

**Churn:** reducer, host, `test/modes/demotion.test.ts:196` which asserts on
the message text (rung 2).

#### M6 - RFC-09's retire residue

**Smell:** mirrored artifact (a withdrawn rule still shipped in the prompt
path).

**Evidence:** Part 1, 1.6 first row.

**Proposal:** delete `ArtifactState.retired`, the RETIRED wording, and
`HeadlessDeps.host.artifactRetired`; keep `LogEntry.retired` as `log.ts:108-113`
documents.

**Payoff:** the state block the agent reads matches RFC-09; one fewer optional
method on the seam H2 tightens (rung 2).

**Churn:** two source files, `test/protocol/artifact-state.test.ts` if it
asserts the marking (not checked, rung 1).

### Low

#### L1 - Dead and test-only exports

**Smell:** shallow surface. **Evidence:** A17. **Proposal:** delete; where a
test is the only caller (`readInput`, `heldLocks`, `lockBackend`,
`backendFor`, `HARNESS_AWAITING_INPUT`, the ledger free functions), delete the
test's use too or move the symbol under `@internal`. **Payoff:** interface
shrinks by about twenty names (rung 2). **Churn:** small, scattered (rung 1).

#### L2 - The interactive ladder is a one-adapter seam

**Smell:** hypothetical seam; temporal decomposition of a gate that is a
constant. **Evidence:** A15. **Proposal:** keep `selectRung` as a pure
function if the CLI will ever report the rung; delete the strategy table and
`createInteractiveHost` until A-003 opens the cooperative rung, or wire the
host into `announce`/`inject` so it has a production adapter. **Payoff:** the
module holds only what the hooks use (rung 2). **Churn:**
`src/modes/interactive-host.ts`, `src/modes/index.ts`,
`test/modes/interactive.test.ts` (rung 2).

#### L3 - The cursor entry is the one entry source that relies on the unknown-`src` carry

**Smell:** convention-enforced consistency (RFC-11 states the rule; RFC-04's
own entry breaks it). **Evidence:** `src/store/log.ts:139` vs `:329-403`.
**Proposal:** add `"cursor"` to `ENTRY_SOURCES` with `validCursorOffset` as
its coercion, or record in the file why the cursor differs. **Payoff:** one
rule for entry sources (rung 2). **Churn:** one file, one test (rung 1).

#### L4 - `ARTIFACT_BYTES_MAX` lives in the store and is imported by the protocol

**Smell:** one bound, two layers. **Evidence:** `src/protocol/artifacts.ts:28`
and `src/protocol/patch.ts:20` import `../store/log.js`; `TEXT_MAX` is in
`src/protocol/frames.ts:110`; RFC-08 R3 says they are "the same bound" and a
test pins them together. The graph reports `protocol` as a zero-fan-out core
package, which these two imports contradict. **Proposal:** define the
artifact bound beside `TEXT_MAX` in `frames.ts` and have `log.ts` import it.
**Payoff:** the protocol layer imports nothing below it (rung 2). **Churn:**
three files (rung 2).

#### L5 - `FRAME_TOKENS` duplicates the page's `:root` tokens by hand

**Smell:** convention-enforced consistency. **Evidence:**
`src/server/client/instrument.ts:88-126` says "this block and app.css's
:root move together: same names, same values"; the behaviour reference
(`src/server/client/reference.tsx`) exists partly to catch drift.
**Proposal:** one token map in TypeScript emitted into both the injected
sheet and the page (or a test that parses both and compares). Deferred by
the pending design pass; listed so the pass inherits it (rung 2). **Churn:**
two client files plus the build (rung 1).

#### L6 - `Conversations.ensure` matches an error by regex

**Evidence:** A13. **Proposal:** branch on `StoreError.code`; give the failed
publish its own code. **Churn:** two files (rung 2).

#### L7 - Pre-commit typecheck covers one of the two projects

**Evidence:** `lefthook.yml:9-11` vs `package.json:12`. **Proposal:** run
`bun run typecheck` in the hook. **Churn:** one line (rung 2).

#### L8 - CI never builds

**Evidence:** `.github/workflows/ci.yml` runs lint, typecheck, test and the
import gate; `scripts/build.ts`'s Tailwind verification never runs in CI.
**Proposal:** a `bun run build` job, or at least the reference build.
**Churn:** one workflow step (rung 2).

#### L9 - Documentation drift

**Evidence:** Part 1, 1.6. **Proposal:** RFC frontmatter statuses
(`Implemented`, and a superseded-in-part note on RFC-07); `CONTEXT.md` record
row gains `files/` and "What works today" gains attachments; `smoke-seven.md`
rows 2 and 4 and its closing paragraph; RFC-02's fixture list; the two
comments in `events.ts` and `honor.ts`. **Churn:** docs and comments only
(rung 2).

### Considered and rejected

- **`src/store/flock.ts` with its two lock instances.** Two adapters at one
  seam (append lock, presence lock) - a real seam, and the primitive is deep.
  `lock.ts` as a facade is in M3; the primitive stays.
- **The three ledgers under `src/protocol/ledgers/`.** Small, but each owns
  one discipline the reducer composes, and the reducer is deep behind
  `reduce`/`enqueueInput`/`grantCredit`. Depth is not size. Only their free-
  function aliases are shallow (L1).
- **`src/store/conversation-host.ts` vs `src/store/store.ts` vs
  `src/store/index.ts`.** The mint sits in `store.ts` with re-exports; the
  barrels are imported widely (grep). Consolidating three files into two is
  churn without a source-of-truth gain beyond M3's facade list.
- **Per-request fold with no cache in the server.** RFC-06 decided it; A16
  notes the cost. A cache is a functionality decision for the fit check, not
  a smell.
- **`AsyncQueue` without backpressure.** `src/harness/queue.ts:9-24` states
  the bound and the condition under which it stops holding. Documented, not
  drift.
- **`view.ts` serving both the terminal and the browser.** Deliberate single
  derivation (`src/server/server.ts:58-62`); the opposite would be drift.
- **`driver-menus.ts` re-declaring the driver wire shapes with `string`
  fields.** Deliberate tolerance of an older or newer server; not the same
  concept as `HarnessName`.
- **`app.tsx` as one 4,613-line component.** Out of scope per `CONTEXT.md`'s
  "the interface is a prototype, not a design"; deepening it before the
  design pass is designing twice.
- **`chat.ts`'s duplicated TTY check** (`:116-137` and `requireTty` at
  `:358`, plus `openKeys` in `src/tui/input.ts:255`). Three checks of one
  fact, but each is a guard on a different path and the cost is nil; folds
  into H2 if that lands.

---

## Ranked candidate list

Ranking is `(callers or surfaces benefiting) × (clarity of the proposed
boundary) ÷ (estimated churn)`. Ranking is not choosing.

| Rank | Id | Candidate | Family | Payoff rung | Churn rung |
|---|---|---|---|---|---|
| 1 | H2 | one driven-conversation lifecycle; required, typed host seam (fixes A1, A7) | deepen + drift | 3 | 1 |
| 2 | H1 | one fold and one appender in `log.ts` (fixes A6, A11) | deepen + drift | 2 | 2 |
| 3 | H3 | one event-class table derived from `EventKind` (fixes A3) | drift | 2 | 2 |
| 4 | M2 | `artifactHeads()` owns "current version per artifact" | drift | 2 | 2 |
| 5 | M1 | `openWriter()` for the nine non-holder hosts | deepen | 2 | 2 |
| 6 | M5 | typed demotion signal (fixes A4) | drift | 3 | 2 |
| 7 | M4 | one `HarnessName` | drift | 2 | 2 |
| 8 | M6 | delete the retire residue | drift | 2 | 1 |
| 9 | M3 | delete the pass-through modules and alias exports | deepen | 2 | 1 |
| 10 | L4 | artifact bound beside `TEXT_MAX` | drift | 2 | 2 |
| 11 | L2 | interactive ladder: one adapter or none | deepen | 2 | 2 |
| 12 | L3 | `cursor` in `ENTRY_SOURCES` | drift | 2 | 1 |
| 13 | L1 | dead and test-only exports | deepen | 2 | 1 |
| 14 | L6 | typed error branch in `ensure` | drift | 2 | 2 |
| 15 | L7, L8 | hook typecheck scope; CI build step | - | 2 | 2 |
| 16 | L5 | one token source for page and frame (after the design pass) | drift | 2 | 1 |
| 17 | L9 | documentation drift | drift | 2 | 2 |

Not in the ranking because they are product decisions rather than design
candidates: A2 (whether any shipped process should grant credit) and A16
(whether the catalog may cache).
