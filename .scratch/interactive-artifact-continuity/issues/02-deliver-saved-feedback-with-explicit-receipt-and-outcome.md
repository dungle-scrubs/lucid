# 02: Deliver saved feedback with explicit receipt and outcome

Status: done
Blocked by: 01

## What to build

A registered listener offers one eligible saved input and records receipt and response separately.

## Acceptance criteria

- [x] Ordinary and managed browser inputs use FIFO eligibility and complete current context with original annotation evidence.
- [x] Preparation is rechecked at dispatch; oversized or unsupported full context stays held intact.
- [x] Receipt and response require the same verified offer and native participation; repeats are idempotent and stale or conflicting acknowledgements fail.
- [x] Cancellation wins only before dispatch. Source loss without settled receipt and outcome blocks automatic replay and later offers.

## Parent

The normalized binding backend from 01 is available for this shared store work; native provenance acceptance remains pending in 01 and the interface lanes. The host and receipt/respond/cancel-input commands prove the checked control criteria with isolated records and injected native authority. Complete current artifact and original annotation preparation, final encoded transport limits, FIFO selection and dispatch rechecks are implemented. The internal listener waits without inference, offers one input, releases its lease, and requires settlement before continuation. Deterministic tests cover owner loss and interruption during preparation. A real-clock synthetic-registration probe confirms the 45-second wait, explicit-only renewal and abort cleanup. Durable per-input preparation holds survive continuation, retain original input, and let other eligible feedback proceed. New document heads, location changes, or explicit listening release the hold for another preparation attempt. Native preparation can make complete private attachment copies and current-location manifests for a verified local-file transport. The copies survive listener exit through receiving-process ownership; preparation and dispatch refusal dispose them. Missing or invalid file references stay held intact. Transports without verified file access hold inputs whose complete context references files, including history. Copies are removed only after a durable outcome; a new host recovers cleanup missed after append. Receipt retains copies, and cleanup matches both offer and process generation. The full gate passes 1,515 tests and the production build. Public listen/resume-listen commands and each native interface acceptance lane remain pending. This is not enabled native integration.

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Shared delivery acceptance complete

The shared listener, complete-context preparation, FIFO selection, dispatch revalidation and public controls are implemented and reviewed. Ticket 03 supplies actual Codex CLI delivery, interruption, cancellation and live-Qwen receipt/outcome evidence. The cancellation correction also excludes withdrawn content from later context while retaining the durable transcript. The full check passes 1,557 tests. Unverified file transports hold complete inputs; unsupported native interfaces remain disabled until their own lanes pass. This closes the common delivery work without claiming other adapters, automatic headless continuation or reconnect.
