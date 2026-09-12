# 07: Normalize strict native interactive launch in HCN

Status: claimed
Blocked by: none

## What to build

A caller can resume a supported native terminal through one HCN operation and receive trustworthy process lifecycle evidence.

## Acceptance criteria

- [ ] Native terminal I/O remains separate from versioned control records carrying the caller launch ID.
- [ ] Strict resume validates exact session and folder without fresh fallback, prompt or model substitution.
- [ ] No-child refusals, started process identity and owned cleanup have distinct evidence; uncertain control loss is never reported as pre-start refusal.
- [ ] Descriptor, interpretation and injected execution boundaries remain intact in Node and Bun; CLI claims and captured fixtures match the updated operation.
- [ ] Every interface has an explicit supported or unavailable result; desktop remains an independent acceptance lane.

## Implementation checkpoint

HCN branch feat/strict-interactive-launch commit 6b5ecb9 implements the strict Codex native executable lane, separate control records, exact UUID/folder preflight, process provenance, uncertainty and owned cleanup. Muse review findings are resolved; 984 tests pass under Node and Bun, and build/package checks pass. A compiled synthetic process probe matches Lucid owner identity while the child is alive. This does not prove native history acceptance. Captured native fixtures, remaining interface launch lanes and Lucid caller integration remain pending.

## Parent

RFC 26 and planning map https://github.com/dungle-scrubs/lucid/issues/253. Machine-made implementation slice under the approved autonomous continuation.

## Lucid consumer seam

Consume the documented HCN interactive operation through HarnessRunner.openInteractive. A separate injected process primitive inherits terminal input/output and exposes only the control pipe to the parser. The handle owns one control stream, lifecycle completion and cancellation. Admission wraps its synchronous invocation, as in the native approval transport. Tests first prove exact argv, correlated ready/start/closed evidence, and cleanup settlement with fake HCN; then malformed/truncated or wrong-target control, refusal, cancellation and actual inherited terminal I/O. HCN owns native argv and native-process supervision. The ordinary headless supervisor and its headless-role marker cannot be reused for native terminal startup. No runtime activation is included in this transport slice.

The Lucid consumer now validates the versioned lifecycle, exact target, closed refusal-code set and separate owned completion. Cancellation after invocation waits for wrapper exit and retains missing native cleanup as uncertain. Structured diagnostics cannot change control evidence. Tests include invalid control, split records, single-use readers, throwing spawn, withheld invocation, cancellation ordering and inherited I/O. A synthetic Herdr TTY check confirms all three native terminal streams and typed input; its pane is closed. Four Muse review axes and scoped fixes pass 1,644 tests plus build. Detailed results are in ignored interactive-transport-review-01 evidence. Native acceptance and runtime integration remain pending.
