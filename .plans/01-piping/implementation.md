# 01-piping - Implementation Plan

> Derived from the archived RFC
> (`artifacts/01_piping-cross-process-operation-of-the-chat-substrate.rfc.md`,
> revised + scope-cut, `D-011`). Live-send to a running host is **deferred**;
> handoff is a baton-pass. Decisions are canonical in `plan.db`
> (`D-001`..`D-014`); `<!-- D-NNN -->` markers cite them. This document is
> self-contained - the error taxonomy and security invariants are folded in
> below, so execution needs no other document.

## ⚠️ Execution Protocol

A progress report exists at `.plans/01-piping/progress-report.md`. It lists
every feature for every milestone as a checkbox.

**Mandatory rules for all agents working on this plan:**

1. Before starting a milestone, run `plan-db check-progress --plan
   "01-piping"` and read its section in the progress report - those
   current-cutoff checkboxes are your spec.
2. Check each box as you complete the feature, not at the end.
3. A milestone is NOT done until every current-cutoff checkbox under it is
   checked.
4. If you find features missing from the report, add them first.
5. Never declare a phase complete without updating the current focus marker
   and Summary.
6. Deferred follow-up and superseded/obsolete debt must not be counted as
   current blockers.
7. Testing discipline is per-milestone (`Testing:` field): **test-first**
   milestones follow the `tdd` loop; **test-after** milestones implement
   then run the named verification.
8. Milestones typed `Observability: required` load the `observability`
   doctrine - locks, `run`, hooks, presence, and the smokes all qualify.

## 0. Hard Dependencies

- **`00-chat-substrate`** (merged, `complete`) - the protocol reducer, the
  durable store (`src/store/store.ts`), the headless/interactive source
  adapters, and the controller. 01 wires these across processes; it does
  not change protocol semantics.
- **`@dungle-scrubs/harness-cli` (normalizer 0.1.0)** - the real spawn
  adapter (`nodeRunnerDeps`) and `claudeCode` descriptor. Consumed, not
  changed (`D-002`).
- No other plan blocks this one.

## Architecture

01 adds the **piping**: the machinery that lets more than one same-machine
process operate a single conversation record safely, with no daemon and no
socket. The conversation record on disk is the only channel; every process
coordinates through it.

Three pieces, layered on the substrate:

1. **The append transaction** - a single-writer critical section around
   `log.ndjson`. Any process that appends (the long-lived host or a
   short-lived hook) does: acquire the append `flock` -> catch-up-fold from
   the last byte offset -> reduce against current state -> write-all ->
   `fsync` -> release (`D-005`). The reduce sees current state, so the fold
   is REQUIRED under the lock, not skipped.
2. **The CLI and hooks** - `lucid run`/`send`/`watch` and the hook entry
   points `announce`/`inject`, each mapping to protocol frames, plus
   env-stamping and self-invocation ported from v1. `run` folds the log
   ONCE and drives as the single live source (no tailer - `D-011`).
3. **Interactive liveness** - a **presence `flock`** held for the session's
   lifetime, kernel-released on death (`D-009`). "Attached" ⟺ the presence
   lock is held. It supersedes the hook-driven heartbeat for the
   interactive profile (hooks have unbounded gaps during tool-free
   reasoning); the headless profile keeps the reducer's lease.

### Key Constraints

| Constraint | Impact |
|-----------|--------|
| The log is the one channel (`D-003`, no socket) | All cross-process coordination is file-mediated; liveness and durability cannot disagree because both live in / beside the log. |
| `flock(2)` is the only lock backend (`D-008`) | Ported from v1's `bun:ffi` path; the concurrent O_EXCL-lockfile fallback and stale-steal are NOT ported (they cannot release on death and do not interoperate). |
| Fold-decide-write serializes as one unit (`D-005`) | Byte-level locking is insufficient; the whole read-modify-append is inside the lock, or two writers reduce against stale state and mint colliding epoch/seq. |
| At most one live source per conversation (`D-011`) | No cross-process effect-dispatch contention; the executor-lease / delivery-cursor / at-least-once machinery is out of scope (deferred to a future live-delivery plan, `D-006`/`D-007`). |
| Same-machine, single-user (`D-004`, inherited) | Trust boundary defends cross-user access only; remote/multi-user deferred. |
| Env-stamp is a hint, not a trust boundary (`D-010`) | `announce`/`inject` MUST verify the resolved record against `meta.json` before writing. |

### Boundaries

- **New module: the lock (`src/store/lock.ts`).** Owns `flock(2)`
  acquire/release over `bun:ffi` and a read-only-viewer fallback. Exposes
  an inspectable backend (`lockBackend()`), an `acquire(path, {timeout})`
  that blocks or raises `E001 lock-timeout`, and a release bound to process
  death (the kernel does the reap). It owns NOTHING about protocol or fold
  logic - it is a pure OS primitive. What it is NOT: it is not a pid-file,
  not a stale-steal, not a userspace liveness clock.
- **The append transaction** wraps the existing store append. It belongs
  next to the store (`src/store/`), reusing the store's existing
  catch-up-fold and byte-offset tracking; the transaction is the store's
  append path made lock-safe and re-folding, not a new fold implementation.
- **The CLI (`src/cli/`)** is the entry-point / orchestration layer:
  subcommand -> frame mapping (pure, testable in isolation) sits apart from
  the process orchestration (`run` wiring store + source + presence lock).
- **The hooks (`src/cli/hooks/` or `announce`/`inject` subcommands)** are
  short-lived transactions. They resolve the record from the env-stamp,
  verify against `meta.json`, and perform one append transaction, then
  exit. They are the trust-verification boundary.
- **Presence-lock lifecycle** is owned by the source adapter wiring, not
  the reducer: the reducer stays pure (no OS handles). Acquire at attach,
  hold for the source's life, kernel-release on death.

New target files get a module-level comment: what it owns, and what it is
explicitly NOT responsible for (the lock comment names the pid-file /
stale-steal anti-patterns it rejects).

### Observability

01 changes cross-process runtime, transport (file-mediated), and recovery
behavior, so observability is part of the feature for every runtime
milestone (all of Phase 1 and Phase 2 except pure frame-mapping):

- **Inspectable state.** The lock exposes `lockBackend()` (which backend is
  live) and a snapshot of held/waiting state. `lucid watch` is the
  user-visible inspection surface for a conversation's live view-model.
- **Structured boundary events, always-on**, keyed by `conversationId` (the
  high-cardinality correlator): `lock.acquire` / `lock.timeout` (E001),
  `append.start` / `append.ok` / `append.failed` (E005, with the under-lock
  pre-write offset), `hook.resolve` / `hook.verify-failed` (E003),
  `inject.disposition` (E004), `presence.acquire` / `presence.released`.
- **Typed errors** map to the RFC's E001-E006 with context (which
  conversation, which offset, which disposition class).
- **Failure-path verification.** The two-process handoff smoke (M3.1) and
  the two-writer flock check (M1.3) are evidence-logged runs that assert
  the emitted telemetry and the durable outcome agree - the end-to-end
  proof that the visible failure surface matches what happened.

### Error taxonomy (folded from the RFC, self-contained)

| Code | Severity | Meaning | Handling |
|------|----------|---------|----------|
| E001 lock-timeout | warning | append could not acquire the append lock in time | surface conversation + wait duration; MUST NOT drop the frame; with `flock` a persistent timeout means a live holder - wait/report, never force-steal |
| E002 torn-interior-line | critical | corrupt newline-terminated line in fold | MUST NOT occur under the lock; if seen -> `corrupt-log` (indicates an unlocked writer) |
| E003 hook-resolution-failure | warning | a hook could not resolve or **verify** (`meta.json` mismatch) | exit non-destructively; the human's session proceeds without lucid, never writes the wrong record |
| E004 injection-refused | info | a `lucid inject` delivery refused by the reducer | report the disposition; refusal class dictates response, no blind retry |
| E005 append-failed | critical | write/`fsync` error | truncate to the **under-lock pre-write** offset and raise (`D-005`) |
| E006 double-or-zero-dispatch | deferred | live-delivery dispatch race | cannot arise in 01 (at most one live source); returns with the live-delivery plan (`D-011`) |

### Security invariants (folded from the RFC)

- **Trust boundary:** same-machine, single-user (`D-004`); defends
  cross-user access and accidental cross-talk only. Remote deferred.
- **Secret:** minted 0600 at creation, redacted before durable; the CLI
  MUST NOT print it or pass it on argv (visible in `ps`) - it travels via
  the file and the env-stamp (same-user-visible only).
- **Env-stamp is NOT a trust boundary** (`D-010`): `announce`/`inject` MUST
  verify the resolved conversation against `meta.json` before writing.
- **Locks as safety boundaries:** the append lock preserves
  single-writer-on-disk (epoch fencing stops two *logical* writers; the
  lock stops two OS processes interleaving bytes). The presence lock is the
  interactive **liveness signal only** in 01 - it does not gate dispatch
  (`D-011`).
- **Hook isolation** (`D-010`/`D-025`, spike-confirmed `D-014`):
  `--setting-sources project` loads ALL project `.claude` hooks, not only
  lucid's; lucid MUST coexist, never assume exclusivity; `HERDR_ENV` unset
  for the child.
- **Blast radius:** a hook is a short-lived transaction on one conversation,
  bounded by the append lock (no torn lines), the reducer (no half-applied
  frames, epoch fencing), and per-conversation directories (isolation,
  `00-chat-substrate` M7.1). Injected human text is opaque input;
  prompt-injection resistance is the harness's concern.

<!-- D-014 --> The A-002 spike is **validated** on claude 2.1.227
(`spikes/evidence/A-002.md`, sandbox `spikes/a002b-227/`): all three
contracts passed. Its learnings are folded into Phase 2 below - the
Assumptions section is removed per the spike lifecycle. `A-001` (a pure-Bun
lock spike) was **cancelled** - the lock backend is decided, not empirical
(`D-008`).

---

## Phases

### Phase 1: The append transaction (workstream A)

**Goal:** two OS processes can append to one conversation's log
concurrently without corrupting it or minting colliding epoch/seq -
fold-decide-write serializes under a real `flock`.

**Gate from previous:** none (does not depend on the A-002 spike; can start
immediately).

#### M1.1: The `flock` primitive

- **Dependencies:** none
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (inspectable `lockBackend()`; `lock.acquire` / `lock.timeout` boundary events keyed by conversationId)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `acquire(path, {timeoutMs})` / the returned release handle / `lockBackend()`.
  2. RED: acquire returns a held lock; a second acquire on the same path from the same process's second handle blocks then times out to `E001`.
  3. GREEN: `bun:ffi` `flock(2)` LOCK_EX|LOCK_NB in a bounded retry loop; port from `~/dev/lucid/src/core/lock.ts` (the `flock` path only - NOT the lockfile fallback / stale-steal).
  4. RED: releasing the handle frees the lock for the next acquirer.
  5. GREEN: release via `flock(LOCK_UN)` + close; module comment names the rejected pid-file/stale-steal anti-patterns.
  6. RED: `lockBackend()` reports the live backend; the read-only fallback path is inspectable.
  7. GREEN: fallback wiring.
  8. REFACTOR: fold the retry/timeout into one helper; confirm no O_EXCL path survives.

#### M1.2: The append transaction

- **Dependencies:** M1.1
- **Effort:** M
- **Testing:** test-first
- **Observability:** required (`append.start`/`append.ok`/`append.failed` with the under-lock pre-write byte offset; E005 typed error)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: the store's lock-wrapped append (`appendTransaction`) and its catch-up-fold.
  2. RED: an append re-folds from the last byte offset and reduces against **current** state (a second writer's committed entry is seen before this reduce).
  3. GREEN: wrap the store append: acquire -> catch-up-fold -> reduce -> write-all -> `fsync` -> release (`D-005`).
  4. RED: a short `writeSync` return loops until the whole entry is written; a partial write is never counted complete.
  5. GREEN: write-all loop.
  6. RED: a write/`fsync` failure truncates to the byte offset captured **under the lock immediately before the write** (never a stale open-time offset) and raises `append-failed` (E005).
  7. GREEN: under-lock rollback offset + typed raise.
  8. RED: a torn-interior line encountered under the lock is rejected as `corrupt-log` (E002) - it can only mean an unlocked writer.
  9. GREEN: torn-interior rejection.
  10. REFACTOR: confirm the fold reuses the store's existing fold, not a copy.

#### M1.3: Two-writer real-`flock` integration check

- **Dependencies:** M1.2
- **Effort:** S
- **Testing:** test-after (real-OS concurrency; the deterministic behavior is proven in M1.1/M1.2, this is the integration confirmation)
- **Observability:** required (asserts emitted `lock`/`append` telemetry agrees with the durable log outcome)
- **Prototyping:** none
- **Tasks:**
  1. Spawn two real processes appending to one log under the real `flock`; assert no torn lines, strictly-increasing seq, no epoch/seq collision.
  2. Verify: the integration test passes and the reopened fold matches the union of both writers' entries.

### Gate 1→2

- [ ] All Phase 1 tests pass (`bun test`)
- [ ] The two-writer integration check is green under the real `flock`
- [ ] `lockBackend()` reports `flock`; no O_EXCL/lockfile path is reachable
- [ ] Phase 1 lands per the Landing strategy (PR to `main`, boundary-reviewed)

### Phase 2: CLI, hooks, and interactive liveness (workstream C)

**Goal:** a user can `lucid run` a conversation headlessly, `lucid send`
into it, `lucid watch` it, and participate from a real claude session whose
liveness is a held presence lock - all mapped to protocol frames.

**Gate from previous:** Phase 1 merged; A-002 spike validated (gates M2.3).

#### M2.1: CLI frame mapping + `lucid send` + `lucid watch`

- **Dependencies:** M1.2
- **Effort:** M
- **Testing:** test-first (subcommand->frame mapping and the read-only view-model are behavior-bearing)
- **Observability:** omitted (pure mapping / read-only projection; the append it triggers is already instrumented by M1.2)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `mapSubcommand(argv) -> Frame` and the `watch` view-model emitter.
  2. RED/GREEN: `send <conversation> <text>` maps to a transient `input` append (folded by the NEXT `run`, `D-011`).
  3. RED/GREEN: `watch` folds the log and emits the TUI view-model, refreshing as the log grows, holding NO lock and dispatching nothing (Open Question 2: minimal read-only emitter, not the rich TUI app).
  4. REFACTOR: share the view-model shape with the existing `src/tui/` code rather than duplicating.

#### M2.2: `lucid run` (headless orchestration)

- **Dependencies:** M2.1, M1.2
- **Effort:** M
- **Testing:** test-after (glue/orchestration wiring store + source + presence lock; promotes `scripts/smoke-live.ts`)
- **Observability:** required (`presence.acquire`/`presence.released`; run-level boundary event keyed by conversationId)
- **Prototyping:** none
- **Tasks:**
  1. Create/open the record, fold the log ONCE, acquire the presence lock, open a headless source on `nodeRunnerDeps`, drive as the single live source (no tailer).
  2. Verify: promote `scripts/smoke-live.ts` to run through `lucid run`; the evidence-logged live smoke passes end-to-end.

#### M2.3: Hooks - `announce` / `inject` with identity verification

- **Dependencies:** M1.2 (A-002 spike validated, `D-014` - `spikes/evidence/A-002.md`)
- **Effort:** L
- **Testing:** test-first (identity verification is security-critical behavior; injection disposition is behavior-bearing)
- **Observability:** required (`hook.resolve`/`hook.verify-failed` E003; `inject.disposition` E004)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `announce(stdin, env)` and `inject(stdin, env)` resolving + verifying against `meta.json`.
  2. RED/GREEN: `announce` reads the SessionStart payload, resolves via env-stamp, **verifies identity against `meta.json`**, transiently appends `attach` (+ identity); a mismatch exits non-destructively (E003), never writes the wrong record.
  3. RED/GREEN: `inject` on the **PostToolUse boundary** resolves + verifies, reads queued input, transiently appends the delivery + `disposition`, emits the injection via hook stdout (`{decision: "block", reason}`, the A-002-proven shape); a reducer refusal reports the disposition class, no blind retry (E004).
  4. RED/GREEN: injected input is chunked under a cap measured in **encoded UTF-8 bytes** (post-JSON-escape), not code points.
  5. RED/GREEN: coexistence is **REQUIRED** (`D-014` C2 - `--setting-sources project` co-runs ALL project hook blocks, proven), so lucid detects and coexists with pre-existing project hooks and its `decision` output composes with, never clobbers, other hooks; `HERDR_ENV` unset for the child.
  6. RED/GREEN: Stop-hook turn-end delivery is **best-effort only** (`D-014` - Stop did not fire in the spike run); the injection contract MUST NOT depend on Stop firing - a tool-free turn's queued input waits for the next tool boundary or `lucid run` fold.
  7. REFACTOR: fold the resolve+verify into one guard shared by both hooks.

#### M2.4: Env-stamp + self-invocation (port from v1)

- **Dependencies:** M2.3
- **Effort:** S
- **Testing:** test-first (record resolution + exec-form argument arrays are behavior-bearing and security-relevant)
- **Observability:** omitted (covered by M2.3's hook boundary events)
- **Prototyping:** none
- **Tasks:**
  1. Seams under test: `envStamp(record) -> env` and `selfInvocation() -> argv[]`.
  2. RED/GREEN: port `launch/env-stamp.ts` + `cli/self.ts`; hook commands + self-invocation use **exec-form argument arrays**, never interpolated shell strings.
  3. RED/GREEN: a stale/reused `LUCID_RECORD_DIR` is caught by the M2.3 verification (the env-stamp is a hint, not a trust boundary, `D-010`).

#### M2.5: Presence-lock lifecycle

- **Dependencies:** M1.1, M2.2
- **Effort:** M
- **Testing:** test-after (OS process-lifecycle behavior - pipe-EOF reap is integration, not unit-deterministic)
- **Observability:** required (`presence.acquire`/`presence.released`; the reap is the one lifetime detail that must be right, Open Question 3)
- **Prototyping:** none
- **Tasks:**
  1. Acquire the presence lock at attach; hold for the source's lifetime; bind release to the claude process's death via pipe-EOF reap (as tmux/journald do).
  2. Verify: an integration test kills the session process and asserts the presence lock is kernel-released (a false-alive cannot persist); "attached" tracks the held lock, not a clock.

### Gate 2→3

- [ ] All Phase 2 tests pass (`bun test`)
- [ ] `lucid run` drives a live conversation (evidence-logged smoke)
- [x] A-002 validated pre-implementation (`D-014`, `spikes/evidence/A-002.md`): inject contract matches 2.1.227; project-hook coexistence proven; Stop best-effort
- [ ] Presence-lock reap proven (kill -> kernel release)
- [ ] Phase 2 lands per the Landing strategy

### Phase 3: Same-machine handoff smoke (workstream D)

**Goal:** two real processes share one conversation and hand off cleanly -
the live `D-020` baton-pass, proven across processes.

**Gate from previous:** Phases 1-2 merged.

#### M3.1: Two-process baton-pass handoff smoke

- **Dependencies:** M2.2, M2.5
- **Effort:** M
- **Testing:** test-after (live, nondeterministic; run-on-demand, evidence-logged, like `smoke-live.ts`)
- **Observability:** required (asserts emitted telemetry agrees with the durable transcript across the handoff)
- **Prototyping:** none
- **Tasks:**
  1. Run two real processes sharing one conversation - a headless `lucid run` and a second participant that `lucid send`s in; the incumbent yields (presence lock frees), the successor folds and takes over.
  2. Verify: the handoff is ordered and at-least-once (no lost input; deduped on replay via the reducer's death-before-ack idempotency, the in-scope `D-020` property), under the real `flock`, with the reopened fold matching the live transcript across the handoff. Evidence to `spikes/evidence/`.

### Gate 3 (release)

- [ ] The two-process handoff smoke passes on demand, evidence logged
- [ ] The full `bun test` suite is green
- [ ] All three phases merged to `main`

---

## Risk Register

| Risk | Severity | Likelihood | Mitigation | Owner |
|------|----------|------------|------------|-------|
| ~~A-002 injection contract changed on 2.1.227~~ | ~~high~~ | ~~medium~~ | **RETIRED** (`D-014`): spike validated all 3 contracts on 2.1.227, `spikes/evidence/A-002.md` | resolved |
| `bun:ffi` `flock` behaves differently across macOS/filesystem (e.g. network FS) | high | low | M1.3 two-writer integration check on the real FS; scope is same-machine local disk (`D-004`) | M1.1/M1.3 |
| Presence-lock reap leaks (false-alive persists) | high | medium | M2.5 kill-test is the gate; pipe-EOF binding, not a clock (`D-009`, Open Question 3) | M2.5 |
| Project-hook coexistence breaks a user's existing hooks | medium | medium | A-002 proves co-run behavior; M2.3 detects and coexists, never assumes exclusivity (`D-010`) | M2.3 |
| Scope creep back into live-send | medium | low | `D-011` firmly defers it; `lucid run` folds once and does not tail | plan |

---

## Escape Hatches

1. **~~If A-002 shows the inject contract changed materially~~ (RETIRED,
   `D-014`):** the spike passed on 2.1.227, so this hatch is closed. (Kept
   for the record: had it failed, the fix was to regress to DECOMPOSE and
   rework M2.3's inject tasks against the observed shape, Phase 1
   unaffected.)
2. **If `bun:ffi` `flock` proves unusable on the target FS (M1.3 fails):**
   this contradicts `D-008`; regress to CONVERGE to re-open the lock-backend
   decision - do NOT silently fall back to O_EXCL (it cannot release on
   death). Escalate to the user.
3. **If presence-lock reap cannot be made reliable (M2.5):** fall back to
   the headless profile's lease for interactive too, accepting the
   mid-reasoning-expiry gap as a known limitation, and record it - rather
   than shipping a false-alive.

---

## Landing Strategy

<!-- D-013 -->

| Field | Value |
|-------|-------|
| Merge target | `main` (`D-013`) |
| Branch model | branch per phase off `main` |
| PR cadence | PR per phase (3 PRs: A, C, D) |
| Independent reviewer | per-milestone boundary review = opus reviewers + a gpt-5.6-sol codex cross-family pass (matching `00-chat-substrate` discipline) |
| Ship mechanism | manual PR via `gh` / git; `.plans/` ledger updates ship to `main` per the implement-plan sequencing rule |

`complete` means merged, not merely checked. `.plans/` is version-controlled,
so each `phase_completed` / `plan_complete` ledger write must reach `main`
(follow-up commit or included in the phase merge).

---

## Progress Report Accounting

Normalized accounting per the invariants: current-cutoff blockers count
only active unchecked work; the deferred live-delivery workstream (B) is
NOT current-cutoff debt - it is out of 01 scope (`D-011`), recorded for a
future plan, not carried as `FP-` placeholders here. The current focus
marker matches the first unchecked current-cutoff checkbox. Run
`plan-db check-progress --plan "01-piping"` before resuming or converging.

---

## Validation Commands

```bash
bun test                        # full deterministic suite
bun test test/store/            # append-transaction + lock unit tests
bun scripts/smoke-live.ts       # headless live smoke (on-demand, evidence-logged)
# Phase 3 handoff smoke: scripts/smoke-handoff.ts (created in M3.1), on-demand
```

---

## Decisions

Canonical in `.plans/01-piping/plan.db`. Query:

```bash
npx tsx <skill-dir>/scripts/plan-db.ts query-decisions --plan "01-piping"
```

Key markers: `D-005` (fold-under-lock), `D-008` (flock-only backend),
`D-009` (presence-lock liveness), `D-010` (security/isolation), `D-011`
(defer live-send). `D-006`/`D-007` are the deferred live-delivery
decisions, recorded but out of 01 scope.
