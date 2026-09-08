# Architecture decisions

One decision per numbered file. These ten ADRs consolidate the existing
decisions; their numbers record this organization, not original decision dates.
Current behavior lives in the [reference docs](../README.md). Historical
D-numbers resolve through the [archive](../README.md#historical-references).

- [0001: Local records are the transport](0001-local-records-are-the-transport.md)
- [0002: The host owns sequence and protocol](0002-the-host-owns-sequence-and-protocol.md)
- [0003: Kernel locks divide append authority from execution](0003-kernel-locks-divide-append-authority-from-execution.md)
- [0004: Recovery follows the durable log](0004-recovery-follows-the-durable-log.md)
- [0005: hcn owns harness differences](0005-hcn-owns-harness-differences.md)
- [0006: One conversation has one artifact](0006-one-conversation-has-one-artifact.md)
- [0007: Document edits preserve evidence](0007-document-edits-preserve-evidence.md)
- [0008: Browser and agent content have separate authority](0008-browser-and-agent-content-have-separate-authority.md)
- [0009: A preference is not an event or a claim about reality](0009-a-preference-is-not-an-event-or-a-claim-about-reality.md)
- [0010: Deterministic oracles are the verification gate](0010-deterministic-oracles-are-the-verification-gate.md)

Allocate the next unused four-digit number. Keep the context, choice, and
reason concise. When a new decision supersedes an old one, link them and
mark the old ADR as superseded. Git preserves prior wording.
