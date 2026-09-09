# 04 - Explain execution and recovery refusals

Status: draft
Blocked by: 02
Publication: local only
Source: RFC 20, version 2 - Authority and version policy; Check boundaries and lifetime; Diagnostic contract; Error Handling; Security Considerations.

## What to build

When a managed attempt, native-session handshake, or existing recovery check
refuses an operation, explain the evidence that caused that refusal through the
existing CLI or browser error surface. Name the selected installation and
manual repair where relevant. Preserve the original execution outcome and
recovery choices.

An independent worker describes its own observation. The browser's older
startup warning continues to identify when it was observed, even if a later
worker succeeds. This slice reuses the common facts and browser announcement
contract without requiring the selected-driver preview from ticket 03.

## Acceptance criteria

- [ ] Worker initialization, managed preparation, and native-session connection preserve fresh existing checks and report their own found/required versions, executable identity, operation, and observation origin. Cached browser diagnostics never authorize or refuse an attempt.
- [ ] A handshake below the HCN floor remains an error even when the executable probe passed. Found version, required floor, selected installation, and handshake origin survive the typed failure into the visible message; generic installation advice is replaced with the actual repair target.
- [ ] Runtime-inspection verified evidence and the verified value actually used by an admission check are retained separately. If they disagree, the message labels both and explains the comparison that determined admission. Inconsistent diagnostic evidence cannot change the gate; severity is an error only when an existing check refuses the operation.
- [ ] Structured harness/model/profile/capability refusals explain the affected operation without claiming versions alone establish support. Authentication, usage limits, absent native sessions or folders, and oversized context retain their existing classifications.
- [ ] Existing outer codes, including E-HUB-03 where used, execution outcomes, durable states, and recovery actions remain unchanged. A warning cannot independently block dispatch. A refusal explains why that attempt did not start, with safe known version and installation details.
- [ ] Existing recovery reasons become informative and safe while retaining their trigger conditions, per-server/key 1500 ms cache, fresh/resume checks, interactive recovery conversion, and actions. These probes neither depend on nor refresh the retained diagnostic memo.
- [ ] Safe formatting covers compatibility-related API errors, recovery reasons, and execution messages as well as diagnostics. Raw process output is not forwarded; historical stored events remain unchanged and their compatibility messages use safe presentation when projected.
- [ ] A fake-process scenario repairs the installation beneath a running browser runtime and permits a later independent worker to succeed. The browser retains its time-qualified startup observation, historical attempt messages remain unchanged, and a runtime restart obtains fresh evidence without this feature duplicating, submitting, resuming, or discarding input.
- [ ] Deterministic refusal and recovery tests prove unchanged admission/outcome behavior alongside richer facts. CLI and fake-HCN browser demonstrations cover handshake floor failure, harness mismatch, evidence disagreement, and safe recovery explanations, including announcement deduplication with the startup region.
- [ ] Current execution and recovery contracts document these explanations. Applicable visible error details remain readable with keyboard access at the three RFC viewport widths. Repository check, build, and whitespace gates pass; no live-model call or new recovery control is required.
