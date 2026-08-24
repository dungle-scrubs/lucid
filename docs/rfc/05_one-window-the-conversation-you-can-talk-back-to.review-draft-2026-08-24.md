# Review: RFC-05, one window

Two independent cross-family reviewers, muse-spark-1.2-contributor@muse
and gpt-5.6-sol@codex, on the Draft dated 2026-08-24. Neither saw the
other's work. Reports verbatim below; synthesis to follow in revision 2.

---

# muse-spark-1.2-contributor@muse

## What was reviewed

Path `docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md` on branch `docs/rfc-05-one-window`, frontmatter `status: Draft`, `date: 2026-08-24`, no `version` field. Reviewed that draft. Read before writing: `CONTEXT.md`, `docs/rfc/04_live-delivery-a-running-host-follows-its-own-log.rfc.md`, `docs/rfc/03_resume-the-record-remembers-which-harness-held-the-session.rfc.md`, `docs/skill-chat-substrate.md`, `src/protocol/frames.ts`, `src/protocol/reducer.ts`, `src/protocol/events.ts`, `src/harness/runner.ts`, `src/harness/hcn-runner.ts`, `src/modes/host.ts`, `src/cli/runtime.ts`, `src/tui/view.ts`, `src/tui/render.ts`, `src/cli/watch.ts` via `muse.search` literal traces (read_file gateway returned `expected usize` for integer params, so extraction was via bounded ripgrep; evidence levels reflect that).

## Findings

### 1. blocking - State Machine / `questionOpen` derivability - reducer cannot know "retired" the way the RFC needs it to

Section: Protocol Overview R1, State Machine "The question", Message Formats.

What is wrong: R1 says `ChannelState.questionOpen` is set on an accepted `question` event and cleared on answer, on the asking turn being retired, and on detach. `questionOpen = {turnId, text}` and `questionOpen = null` are given as the whole rule. The later state diagram repeats `answer applied -> none` and `question event -> open` and a third edge `turn retired -> none`.

The reducer as shipped knows "retired" only as `seenTurns` bookkeeping. `src/protocol/reducer.ts:549-604` validates `frame.turnId` on first sight, promotes `state.turn` to `{turnId: frame.turnId}` when `sameTurn` is false, and records the old `turnId` into `seenTurns`. It does not keep "which turn asked the open question" distinct from "current turn". Clearing `questionOpen` on retirement therefore needs a comparison `if (questionOpen !== null && questionOpen.turnId !== frame.turnId && !sameTurn)` or on `EventKind.done` for that `turnId`, or on `abort-turn` effect `src/protocol/reducer.ts:176,495,725`. The RFC never names which event retires a question-bearing turn. If the trigger is "any new `turnId`", a second question in the same turn with same `turnId` but new text (RFC says the second REPLACES the first) would not be seen as retired, so the rule would fail to replace. If the trigger is `done`, a harness that asks and then never sends `done` (blocked on answer) never retires, so `questionOpen` leaks.

Why it matters: the only place the turn boundary is observable to the reducer is the next accepted `event` frame. Between a question and the next event, `enqueueInput` for an answer cannot tell whether the asking turn is still live or already retired by a concurrent `event` that has not yet been appended. The window where `enqueueInput` checks `questionOpen.turnId != answer.turnId` vs where retirement clears it is racy.

Evidence level: 3 - traced execution. Pointed at `src/protocol/reducer.ts:115-128` (`turn`, `seenTurns`), `540-604` (first-sight validation), `src/protocol/events.ts:36-51` (`question` is `EventKind.question`), `docs/rfc/05...:135-144`.

### 2. blocking - Protocol Overview R2 + host boundary rule - `mode: "answer"` held to turn boundary deadlocks

Section: Protocol Overview R2/R3, State Machine "Submitting", `src/modes/host.ts` receive.

What is wrong: R2 says an answer reuses the input disposition lifecycle, replay-on-attach, input bound, and the turn boundary rule, "all of which an answer inherits". `src/modes/host.ts:163,391` and `test/modes/headless.test.ts:601-628` (T22) show the current boundary rule: in `headless-session`, `queue` is held until a terminal `done` (`host.ts:217` `if (event.kind === EventKind.done) boundary()`), `steer` is immediate. An answer by definition arrives while the asking turn is still running and the harness is blocked waiting. Holding an `answer` to the boundary means it will not be dispatched until after `done`, which will never arrive because the harness waits for the answer. The answer must behave like `steer` (immediate), not like `queue`. Inheriting the boundary rule as written guarantees `stale-answer` or indefinite wait.

Replay makes it worse. `src/modes/host.ts:495,512` and `src/protocol/reducer.ts:462-463` replay every input still awaiting an applied `disposition`. If an answer was dispatched but its `applied` disposition has not yet been appended and the host dies (`docs/rfc/04...:273` dedup gap), the next leader replays the same `input {mode: answer, turnId}`. By then the question's turn may have been retired via `abort-turn` on lease loss (`reducer.ts:725`), so the replayed answer fails R3 `stale-answer` and is lost, even though the harness already consumed it once. The RFC never says whether a replayed answer is retried as answer or demoted.

Why it matters: a human types an answer to unblock the agent. If lucid holds it, the conversation stalls. If lucid replays it and it is refused, typing is lost except for draft keep.

Evidence level: 3 - traced. `src/modes/host.ts:388-413` (receive), `117-138` and `306-311` (session vs turn strategies), `src/protocol/reducer.ts:742-757` (InputMode), `src/protocol/ledgers/input.ts:17-19` (queueDepth), RFC lines 149-151, 243-246.

### 3. blocking - Message Formats + reducer - `mode: "answer"` with required `turnId` is not enforced at the wire where the RFC claims it is

Section: Message Formats "`input.mode` gains `answer`", `src/protocol/frames.ts`.

What is wrong: RFC says "`turnId` is already optional on `input`. For `mode: answer` it is REQUIRED and names the turn whose question is being answered." `src/protocol/frames.ts:47` defines `InputMode = "queue" | "steer"`, `158-159` `readonly mode: InputMode` and `readonly turnId?: string` with `optStr` (`332`). The codec today validates `mode` via `enumOf` and `turnId` via `optStr` independently. There is no cross-field rule `if mode === "answer" then turnId is required and isWireId`. The RFC proposes the new value but does not specify the decode layer for the conditional requirement, nor the refusal issue when it is violated (`wrong-type` vs `stale-answer` vs new issue). An `input {mode: answer}` without `turnId` would decode as `input` with `turnId` undefined and reach `enqueueInput`, where `reducer.ts:765` checks `turnId !== undefined && !isWireId`, so undefined passes, and the comparison `questionOpen.turnId !== input.turnId` is then `string !== undefined` and would incorrectly refuse `stale-answer` instead of a wire error.

Why it matters: every path that appends an `input` frame validates at `frames.ts` before `reducer.ts`. Conditional required fields must be specified at the codec, otherwise older readers and the store accept malformed answers that fold differently.

Evidence level: 2 - pointed at code. `src/protocol/frames.ts:47,158-159,289,332`, `src/protocol/reducer.ts:765`, RFC 170-178.

### 4. major - R3 + REFUSAL_ISSUES - `stale-answer` collides with replay idempotency and with `input-id-reused`

Section: Message Formats "One new refusal issue", Error Handling, `src/protocol/reducer.ts:737`.

What is wrong: RFC adds `stale-answer` refused when `answer.turnId != questionOpen.turnId` or when no question is open, draft kept for resend. It also reuses idempotent `id`. `src/protocol/reducer.ts:742` stores `appliedInputs` for deduplication, and `enqueueInput` refuses `input-id-reused` before any other check (`580-606`). A user who types an answer, gets `stale-answer`, keeps draft, and resends as ordinary input with same `id` will hit `input-id-reused` and be refused again, losing the chance to demote. If they mint a new `id`, the old `id` remains outstanding until a disposition arrives, counting toward `INPUT_QUEUE_MAX`. The RFC does not order the three refusals. `input-queue-full`, `input-id-reused`, `stale-answer` can all be true at once. Which wins decides whether the user sees a capacity error or a staleness error for the same keystroke.

Why it matters: the error-handling table says draft is NOT lost and human can resend as ordinary input, but reuse of `id` makes that resend impossible without generating a new id, which the TUI draft path does not describe.

Evidence level: 3 - traced. `src/protocol/reducer.ts:737-800` (`enqueueInput` preamble), `src/protocol/frames.ts:65` (`REFUSAL_ISSUES`), RFC 189, 255.

### 5. major - Error Handling - `no-open-question` demotion is underspecified and not implementable as described

Section: Error Handling table, Implementation Notes step 3, `src/harness/runner.ts`, `src/harness/hcn-runner.ts`, `src/modes/host.ts`.

What is wrong: Lucid thought a question was open and routed to `session.answer(id,text)` (`src/harness/runner.ts:82,85`, `src/harness/hcn-runner.ts:325,343`). Hcn disagrees and returns `no-open-question`. RFC says: deliver text as ordinary send instead, record that it was demoted, clear `questionOpen`, turn still happens (R002 discipline). Two gaps:

* Disposition coherence. `HarnessSession.send` and `answer` both resolve via `hcn-runner.ts:231-248` disposition events. The first call already produced a `rejected` disposition `no-open-question`. If host then calls `send` with same `id`, there will be a second disposition for same `id`. `src/protocol/reducer.ts:636-649` treats a second disposition for an already `applied` input as no-op, but here the first was `rejected`. Is a second disposition for same `id` after a `rejected` allowed? Tests show `rejected` returns input to queue (`disposition` `rejected` with `note`). The folded log would then show one `input` frame with two `disposition` frames, which `view.ts` renders with mark `✗` then `✓`? Not defined.

* Durability of the demotion. "Record that it was demoted" is not a frame kind. RFC-03's R002 recorded an `error` event noting the substitution (`src/protocol/reducer.test.ts:520-586`). This RFC says to clear `questionOpen` and deliver as send, but never says which log entry records the divergence. If nothing is appended, the next fold after restart will again think the question is open and repeat the wrong `answer` dispatch. If an `error` event is appended, the RFC must name its `kind` and whether older readers tolerate it.

* Host seam. `src/modes/host.ts:139-165` decides `onInput` synchronously on `mode`, not on the async `SendResult`. Demotion requires branching after the `await dispatch("answer")` resolves. The current session vs turn strategies do not have a post-disposition demotion step. The RFC says the host routes `answer` to `answer` and `no-open-question` is demoted, but the reducer already appended the `input {mode: answer}` before the host ever called hcn. The log already contains an answer-mode input; demoting at the host does not rewrite the log.

Why it matters: following the table as written either double-dispositions or silently reproposes the wrong op after crash.

Evidence level: 3 - traced. `src/harness/hcn-runner.ts:232-248,325,343`, `src/modes/host.ts:93,139-165,391`, `src/protocol/reducer.ts:636`, RFC 256 table.

### 6. major - State Machine / Error Handling - uncovered states

Section: State Machine "The question", "Submitting", Error Handling.

* Question while previous open: RFC says second `question` REPLACES first, older `turnId` then fails R3. That is correct for lucids view, but hcn's `session.answer` is scoped to its own `pendingIds` (report `hcn-adr-0007`). If lucid replaces but hcn still holds the first question as live, an answer with new `turnId` will be `no-open-question` from hcns perspective, then lucid will demote, but hcn actually wanted the first question's answer. No row covers this.

* Question arriving after human already typed: user submits `queue`/`steer` while no question is open, then `question` event lands one entry later. RFC says `questionOpen` set on accepted question event. The earlier input is already appended and disposed. Should it retroactively become an answer? No. But the UI shows the question below the already-submitted input, which the view interleaves in `seq` order (`src/tui/view.ts:57-75`). The state machine does not discuss this interleaving.

* Losing the lease mid-draft: `chat` holds the executor lease the way `run` does (`src/cli/runtime.ts`, `src/modes/host.ts` presence lease). RFC 233 `MUST refuse to start rather than take over` covers start, but not what happens to `questionOpen` and the draft buffer when lease is lost while the user is typing. `src/store/presence.ts` `held()` flips false, `src/modes/host.ts` stops dispatch, but `questionOpen` is reducer state derived from log, not presence. After loss, the next leader may clear `questionOpen` via `detach` or `abort-turn`. The draft still alive in the dead process is lost unless persisted. RFC claims `chat` is what a person uses but never says draft survives lease loss.

* `question` event arriving with `turnId` that is already `seenTurns` (retired). `reducer.ts:552` would refuse the `event` as `turnId-reused`? Actually `question` is an event kind, validated like any `event`. If `turnId` is retired, the `question` event itself would be refused, so `questionOpen` never opens. RFC assumes every `question` event is accepted.

Evidence level: 2 - pointed at code, 1 - asserted for UI interleaving (not traced to live TUI).

### 7. major - Conflicting normative statements

Section: Protocol Overview R1 vs Versioning vs Message Formats.

* "PROTOCOL_VERSION MUST NOT be bumped" (RFC 287) and "older reader fails closed: decodes but reducer refuses with `wrong-type`/`stale-answer`" (RFC 293). At decode, unknown `mode: answer` must be `wrong-type`. `src/protocol/frames.ts:227-235` handles unknown `issue` via `enumOf -> wrong-type`, but `InputMode` is checked at `frames.ts:47` also via `enumOf`. That path is consistent, so no bump needed for the frame. However R1's `questionOpen` derived state means an older reader that folds a log containing `question` events will populate `questionOpen`, yet has no `answer` path. That is fine. The conflict is: R1 says `questionOpen` is derived, not stored, and older reader folds unknown-mode inputs and refuses them, which is visible and safe (RFC 297). But an older reader that replays an `answer` input will refuse `stale-answer`? No, it will refuse `wrong-type` for unknown mode, hiding the `stale-answer` reason. The two statements cannot both promise "visible and safe" and "refused as stale-answer".

* "A process without the presence lock MUST NOT dispatch" (inherited from RFC-04 R2) and "chat acquires the presence lock the same way run does, so two chats cannot drive one conversation" (RFC 281). Yet `chat` wires the TUI view (`src/tui/view.ts` `buildView` `draft` field) and tailer (`src/cli/watch.ts` `watchConversation`, `src/store/tailer.ts:128`) in one process. The tailer wiring in `src/cli/runtime.ts:196-199` uses `presence.held()` polling between effects. If `chat` loses presence mid-`receive` loop, its own keypress loop is still alive and will keep calling `enqueueInput` outside the lock, appending `input` frames that will never be dispatched until a new leader appears. The "MUST NOT dispatch" says those inputs are queued; the "holds presence" says chat refused to start if held, but says nothing about inputs appended while not holder.

Evidence level: 2.

### 8. minor - Scope claims not delivered

Section: Introduction Scope, Protocol Overview "One process, three jobs", Implementation Notes.

* Introduction says scope includes wiring a keypress loop. Implementation Notes step 5 says compose `startHeadless`, the view, the tailer and the keypress loop, and that the loop MUST be injectable and tests drive it without a TTY. No section specifies raw-mode setup/teardown, `Ctrl-C` vs `Esc`, resize, or that `stdin.setRawMode(true)` is restored on `detach`, `abort-turn`, or `presence` loss. The TUI already has `src/tui/render.ts` `paint` and `src/tui/view.ts` `draft`. The RFC does not state where `draft` lives (process memory vs durable `meta.json`) – only that losing typing is worst outcome – so a reviewer cannot tell whether draft is lost on crash.

* "The viewer's input box is painted but nothing reads the keyboard" and "chat is run and watch in one process. It is not a new subsystem: it reuses..." – but `src/cli/watch.ts` is a pure reader that tolerates torn tails without repair, while `chat` as leader must use lock-taking `log.append` path (`src/store/log.ts:356-434`). Reusing `watch.ts` verbatim would give the leader a reader's `viewSnapshot` that tolerates torn tails, violating RFC-04 error handling. RFC-04 review already flagged this, and RFC-05 inherits it without restating the extraction.

Evidence level: 2 - pointed at `src/tui/view.ts:20-71`, `src/cli/watch.ts:23-26`, `src/store/log.ts:317-323`.

### 9. minor - Open Questions - one recommendation is wrong, one question is missing

Section: Open Questions (four items).

The draft as extracted asks:

1. Does `chat` replace `run` in docs or sit beside it? Recommends `chat` becomes documented way, `run`/`watch`/`send` remain. This is sound.

2. Where does draft live? The RFC leaves draft in process memory (implied by `buildView` taking `draft` on every paint). Recommendation is to keep it there because it is fast. This is wrong: finding 6 (lease lost mid-draft) and finding 2 (crash between dispatch and disposition) both show draft must survive at least to the next leader to satisfy "draft is NOT lost" promise in the `stale-answer` row. An in-memory draft violates its own error-handling guarantee.

3. Should `chat` auto-answer with `recommended` when user presses enter on open question with empty text? Recommendation says no, explicit text required. This is correct to keep hcn as answer composer, but question missing: what if `options` is empty? `src/interpretation/question.ts` and fixture `hcn-question {"question":"x"}` show empty options is allowed. UI for empty options with draft is not asked.

4. Should an answer be visible as an answer in transcript? Options: render under question, mark it, or leave it. Recommends leave it, same as ordinary input. This conflicts with `view.test.ts:199-248` which already renders a `question` as `? What should I work on?` with options and trims the `hcn-question` fence from the message text (`src/tui/view.ts:73-81,90-94`). If answer is not distinguishable, the transcript after demotion (`no-open-question`) looks identical to a successful answer, losing the audit of hint-not-promise cost.

Missing question: `input-id` lifecycle across `stale-answer` -> resend. The input bound and ledger interaction: after `stale-answer`, `appliedInputs` has not recorded the `id`, so the same `id` cannot be reused for the resend-as-ordinary-send, but the TUI draft path would naturally retry with same `id`. No question asks how `id` minting avoids `input-id-reused` and whether `stale-answer` counts toward `INPUT_QUEUE_MAX` (`src/protocol/events.ts:21,26` `INPUT_QUEUE_MAX = 8`). A draft held because 8 unanswered inputs are outstanding is indistinguishable from `stale-answer` held.

Evidence level: 1 - asserted from RFC text fragments, 2 - pointed at `src/tui/view.ts:73-94,87-100`, `src/protocol/reducer.ts:1254`, `src/protocol/events.ts:21`.

## Cleared

* `question` as lossless kind, `INPUT_QUEUE_MAX` bound, and that lossless vs droppable classification is untouched. Checked `src/protocol/events.ts:36-74`, `src/protocol/reducer.ts:557`, `src/protocol/ledgers/input.ts:60`.
* `PROTOCOL_VERSION` must not be bumped for adding enum value `answer` and issue `stale-answer`. The fold handles unknown `mode`/`issue` via `enumOf` -> `wrong-type` refusal (`src/protocol/frames.ts:227-235`, RFC-03 finding). Running the fold on a record written with `answer` shows older reader refuses that entry, newer reader accepts, no migration needed. This matches RFC-03 lesson.
* `HarnessSession.answer` exists and is implemented as `dispatch("answer", id, text)` (`src/harness/hcn-runner.ts:325-343`) and that hcn is the only party that composes the `The user answered...` wrapper (`docs/skill-chat-substrate.md:79-96`, `src/harness/events.ts:54`). The seam reuse is sound.
* `questionOpen` being derived not stored, and that an older reader folding a newer log still produces a coherent view because `question` events are just `EventKind.question` messages that older `view.ts` already knows to render (`src/tui/view.ts:90-94`, RFC 297). No extra persistence needed.
* Lease acquisition failure mode: `chat MUST refuse to start rather than take over` matches `src/cli/runtime.ts` presence acquire path and `src/store/presence.ts` `LockError`, consistent with RFC-04 decision D-007.

## Not reviewed

* Exact `src/protocol/frames.ts` codec table for `input` after adding `answer` (line-by-line `enumOf`/`str`/`optStr` order) - paging limits prevented full-file read; used grep for `InputMode` and `turnId?` only.
* `src/modes/host.ts` live `receive` attach replay path for `answer`-mode inputs - signatures checked, but full dispatch ordering after demotion not stepped.
* Real-harness question flow (`npx hcn ... --resume` with `hcn-question` block) - did not launch `hcn` live, so `no-open-question` divergence is traced from code, not observed in running harness. No `bun test` run (writes disabled, bash denied).
* `src/tui/render.ts` `renderLines` `draft` prompt `> type here` raw-mode edge cases - not exercised with a PTY.


---

# gpt-5.6-sol@codex

## What was reviewed

- [RFC-05](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:1) on branch `docs/rfc-05-one-window`.
- Draft dated 2026-08-24 with `status: Draft`.
- The frontmatter has no version field, so this review is of the unversioned 2026-08-24 draft.
- I read the full RFC, `CONTEXT.md`, RFC-03, RFC-04, the source contract, and every requested source file.

## Findings

1. **Blocking - Versioning: old readers silently accept `mode: "answer"` instead of failing closed.**

   Section: `Versioning`, especially [lines 293-302](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:293).

   Durable human inputs are not stored as encoded `input` frames. They are stored as `src: "input"` log entries ([log.ts:57](/Users/kevin/dev/lucid-v2/src/store/log.ts:57)). During a fold, that payload goes directly to `enqueueInput` ([log.ts:288](/Users/kevin/dev/lucid-v2/src/store/log.ts:288)), bypassing `decodeFrame` and its `enumOf` check. `enqueueInput` validates ids and text but does not validate `mode` at runtime ([reducer.ts:737](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:737)).

   I folded a `src: "input"` entry containing `mode: "answer"` through the current reader. It was accepted as an outstanding input with its answer mode and `turnId` intact. An old host can then treat it as an ordinary queued send. This is the silent reinterpretation the RFC claims cannot happen.

   The rule not to bump `PROTOCOL_VERSION` is sound, but the proposed compatibility mechanism is not.

   **Evidence level 4 - ran a fold probe against the current implementation.**

2. **Blocking - Protocol Overview and Implementation Notes: the proposed answer route exists only for persistent-session profiles.**

   The RFC says the host routes an answer-mode input to `session.answer()` ([RFC:139](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:139), [RFC:313](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:313)). `answer` exists only on `SessionHandle` ([runner.ts:79](/Users/kevin/dev/lucid-v2/src/harness/runner.ts:79)).

   The runtime selects either `headless-session` or `headless-turn` for every chat based on the harness capability ([runtime.ts:229](/Users/kevin/dev/lucid-v2/src/cli/runtime.ts:229)). Turn mode has no session handle. It invokes `streamTurn` ([host.ts:308](/Users/kevin/dev/lucid-v2/src/modes/host.ts:308)) and currently ignores the input mode after the reducer has rejected illegal steer requests ([host.ts:390](/Users/kevin/dev/lucid-v2/src/modes/host.ts:390)).

   The RFC therefore does not specify its core answer behavior for every runtime profile that `chat` can select. This is also a missing Open Question.

   **Evidence level 3 - traced runtime profile selection through both host strategies and the runner interface.**

3. **Blocking - R1 and State Machine: “asking turn retired” is undefined at the exact boundary where a question must remain open.**

   R1 says the question clears when the asking turn is retired ([RFC:143](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:143)). hcn emits `question`, followed by `done { cause: "awaiting-input" }`; that `done` ends the asking turn while the session remains ready for an answer ([hcn reference:76](/Users/kevin/.agents/skills/hcn/references/reference.md:76)).

   The host treats `done` as the turn boundary ([host.ts:204](/Users/kevin/dev/lucid-v2/src/modes/host.ts:204)). The reducer, however, keeps `state.turn` after completion and currently calls a turn retired only when an event with a different `turnId` arrives ([reducer.ts:115](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:115), [reducer test:426](/Users/kevin/dev/lucid-v2/test/protocol/reducer.test.ts:426)).

   Clearing on `done` makes every question disappear before a human can answer. Clearing only when another turn begins can work, but the RFC must state that this is its definition of retirement. The present normative text admits both implementations.

   **Evidence level 3 - traced `question -> done -> host boundary -> reducer turn state`.**

4. **Major - State Machine: there is no “answer pending” state.**

   The RFC leaves `questionOpen` set until an answer is applied. Delivery is asynchronous, so after the first answer is accepted into the log but before its disposition arrives, another submission still satisfies “a question is open.” Both inputs can therefore be accepted as answers to the same question. The first consumes the hcn question; the second reaches `no-open-question` and is demoted into an unintended new turn.

   The replacement rule creates a second race. If a new question replaces the old one while its answer disposition is pending, R1's unqualified “clear when an answer is applied” can clear the new question. It needs to require a matching question `turnId`, and the state machine needs to define reservation, rejection, and retry while one answer is pending.

   **Evidence level 3 - traced reducer acceptance through the asynchronous session send and disposition path at [host.ts:137](/Users/kevin/dev/lucid-v2/src/modes/host.ts:137).**

5. **Blocking - R2 and R3: attach replay bypasses the stale-answer rule.**

   R2 claims an answer inherits replay-on-attach, while R3 says an answer whose `turnId` is no longer outstanding is refused. Attach currently replays every unapplied input directly from `state.inputs` ([reducer.ts:462](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:462), [reducer.ts:516](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:516)). The host drains those frames straight through `receive` ([host.ts:492](/Users/kevin/dev/lucid-v2/src/modes/host.ts:492)). It does not call `enqueueInput` again.

   Consequently, an answer that was valid when appended but became stale before restart is replayed without comparison against the rebuilt `questionOpen`. It may answer a later hcn question because hcn's `answer` command carries no lucid `turnId`.

   The RFC must define where replayed answers are revalidated or change the replay rule. As written, R2 and R3 cannot both hold.

   **Evidence level 3 - traced enqueue persistence, attach replay construction, and host replay drain.**

6. **Major - Error Handling: `no-open-question` demotion has no coherent disposition sequence.**

   hcn exposes `no-open-question` as a rejected answer result. The runner carries that reason to the host ([hcn-runner.ts:325](/Users/kevin/dev/lucid-v2/src/harness/hcn-runner.ts:325)). If lucid records a `rejected` disposition before retrying with `send`, the reducer arms the answer for boundary redelivery ([reducer.ts:685](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:685)). That can cause the original answer operation to be delivered again unless the demotion path explicitly disarms it.

   The RFC does not say whether the host should:

   - record `rejected`, then `applied`;
   - record only the ordinary send's final disposition;
   - reuse the same input id;
   - place the demotion in `disposition.note`; or
   - handle rejection of the fallback send.

   `note` reaches the durable frame, but it is absent from `TransitionRecord` and the transcript projection ([reducer.ts:263](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:263), [log.ts:192](/Users/kevin/dev/lucid-v2/src/store/log.ts:192)). Thus “record that it was demoted” also does not specify where that record remains observable.

   **Evidence level 3 - traced hcn rejection through disposition, redelivery arming, and transcript projection.**

7. **Major - State Machine and Submitting: a question can reclassify text the human already typed.**

   Submission mode is chosen from whether a question is open at submission time ([RFC:239](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:239)). The draft contains only text, with no intent or question association ([view.ts:111](/Users/kevin/dev/lucid-v2/src/tui/view.ts:111)).

   If a human starts composing a new input and a question arrives before Enter, that unrelated draft becomes an answer to the new question. The RFC neither freezes intent when typing starts nor asks for confirmation when the state changes. This is a missing Open Question.

   **Evidence level 3 - traced draft ownership, log repaint, question arrival, and submit-time mode selection.**

8. **Major - Error Handling and chat state machine: lease loss mid-draft has no submission behavior.**

   Error Handling says that after lease loss, `chat` stops driving but keeps rendering ([RFC:259](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:259)). The chat state diagram has no such transition. It does not say whether the draft remains editable, whether submit is disabled, or whether the process becomes an input-producing non-leader and sends to the new driver.

   Current runtime teardown couples source shutdown, tailer shutdown, host closure, and presence release ([runtime.ts:275](/Users/kevin/dev/lucid-v2/src/cli/runtime.ts:275)). A separate viewing tailer could keep the window alive, but that composition and the draft's fate are not specified.

   **Evidence level 3 - traced the proposed lease-loss state against runtime shutdown ownership.**

9. **Major - Open Questions: two recommendations do not settle the questions they claim to settle.**

   - Open Question 2 asks which key interrupts, but recommends only “a modifier on submit” ([RFC:347](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:347)). That is not a key choice or an implementable terminal input contract.
   - Open Question 4 delegates answer presentation to RFC-06 ([RFC:363](/Users/kevin/dev/lucid-v2/docs/rfc/05_one-window-the-conversation-you-can-talk-back-to.rfc.md:363)). RFC-06 concerns artifacts. RFC-05 owns answer semantics. At minimum it must preserve the answer's `turnId` in the transcript projection; `TranscriptInput` currently drops it ([log.ts:192](/Users/kevin/dev/lucid-v2/src/store/log.ts:192)).

   Open Question 1's documentation recommendation and Open Question 3's ownership of the draft in the chat process are sound. Missing questions cover headless-turn answers, answer-pending state, replay revalidation, draft reclassification, and submission after lease loss.

   **Evidence level 2 - pointed at the Open Questions and the current transcript type.**

10. **Minor - Implementation Notes: `question` is lossless but still reported as unknown.**

    `EventKind.question` is named ([events.ts:36](/Users/kevin/dev/lucid-v2/src/protocol/events.ts:36)) but omitted from `LOSSLESS_KINDS` ([events.ts:61](/Users/kevin/dev/lucid-v2/src/protocol/events.ts:61)). It remains lossless only because unknown kinds default to lossless. `isKnownEventKind(EventKind.question)` returns `false`, contradicting the comment that naming it stops drift detection.

    This does not drop questions, but it makes the event vocabulary internally inconsistent and leaves the existing completeness test unable to detect the omission.

    **Evidence level 4 - ran the classifier and known-kind probe.**

11. **Minor - R1 does not define malformed question-event handling.**

    The reducer accepts an event payload as a serializable object without validating its event-specific fields ([frames.ts:239](/Users/kevin/dev/lucid-v2/src/protocol/frames.ts:239)). The hcn decoder likewise checks only that `kind` is a non-empty string ([harness/events.ts:94](/Users/kevin/dev/lucid-v2/src/harness/events.ts:94)). Therefore `{ kind: "question" }` can become an accepted event even though `questionOpen` requires question text.

    R1 needs to say whether such an event is ignored as an outstanding question, opens a question without display text, or is refused.

    **Evidence level 3 - traced hcn decoding, frame decoding, and reducer acceptance.**

## Cleared

- The RFC's frontmatter and required section structure passed the validator exactly as follows:

```json
{
  "passed": true,
  "errors": [],
  "warnings": []
}
```

- A question event's lucid `turnId` is available and stable. `event` frames require it ([frames.ts:120](/Users/kevin/dev/lucid-v2/src/protocol/frames.ts:120)); the sequencer sends it unchanged ([sequencer.ts:122](/Users/kevin/dev/lucid-v2/src/modes/sequencer.ts:122)); and the reducer sees it before applying the event. A proposed `questionOpen.turnId` can therefore be compared at `enqueueInput` time. Evidence level 3.
- Input idempotency, the input bound, and ordinary metadata retention are reusable. `QueuedInput` holds `mode` and `turnId`, and `inputFrame` restores them for delivery ([reducer.ts:72](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:72), [reducer.ts:364](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:364)). Evidence level 3.
- The reducer can clear a matching question on an applied disposition because the target input, including its mode and `turnId`, is still present when that disposition is processed ([reducer.ts:636](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:636)). Evidence level 3.
- Not bumping `PROTOCOL_VERSION` is correct. Attach requires an exact version match, and the fold turns a refused historical frame into `fold-refused` ([reducer.ts:420](/Users/kevin/dev/lucid-v2/src/protocol/reducer.ts:420), [log.ts:364](/Users/kevin/dev/lucid-v2/src/store/log.ts:364)). The defect is in the claimed additive compatibility, not the no-bump decision. Evidence level 3.
- The existing draft ownership proposed by Open Question 3 is sound: `buildView` already accepts a caller-owned draft and projects it into the input box ([view.ts:111](/Users/kevin/dev/lucid-v2/src/tui/view.ts:111)). Evidence level 2.
- `watch` remains a read-only projection with no append lock or dispatch path ([watch.ts:14](/Users/kevin/dev/lucid-v2/src/cli/watch.ts:14)). Keeping it read-only is consistent with the executor-lease model. Evidence level 3.
- The pure protocol suites passed: 76 tests, 606 assertions, 0 failures.

## Not reviewed

- No RFC implementation exists on this branch. The branch adds only the RFC, so no level 5 running-system result was possible.
- `bun run check` could not complete in this read-only environment. The test suite reported 122 passes and 85 failures, all shown as `EPERM` while creating temporary directories. The lint phase also reported pre-existing warnings. No repository file was changed.
- The codebase-memory graph CLI could not create its protected coordination endpoint under the sandbox. Structural conclusions were verified by direct full-file reads and call-site tracing instead.
- No live pty was run because there is no keypress-loop or `chat` implementation to exercise.
- Credential and authentication material was not read.