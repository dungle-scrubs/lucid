# Lasting decisions

This register holds choices whose rationale still matters. Current behavior
belongs in the [reference docs](README.md), not in an immutable list of every
implementation step. Update a decision when it is superseded; Git preserves
the old wording. Historical D-numbers resolve through the
[archive](README.md#historical-references).

## Local records are the transport

lucid serves one person on one machine. Durable files carry the conversation;
an optional browser server reads and appends to them. There is no coordinating
daemon or socket transport. This keeps process lifetime separate from the
conversation and makes local filesystem access the authorization boundary.

Revisit only if the product's users and scope change to require remote or
multi-user coordination. That is a product decision, not a refactor.

## The host owns sequence and protocol

lucid owns a pure reducer with injected time, host sequence numbers, and epoch
fencing. Sources supply per-epoch event counters, not durable sequence numbers.
This gives every integration mode the same replay and refusal rules. Keep the
protocol in this repository until a second real consumer needs a package.

Revisit packaging with that consumer; do not change sequencing ownership to
accommodate one harness or browser feature. The substrate remains independent
of the browser surface; its invariants are not adjusted to fit presentation.

## Kernel locks divide append authority from execution

Use one flock implementation. The append lock protects a transaction; the
presence lock elects the effect executor for its participation. Kernel release
on death avoids stale lock-file guesses. Epoch and lease checks remain as
protocol defenses. Mixing flock and exclusive-create lock backends would let
two processes each believe they own the record.

Revisit only with a supported platform that cannot provide the same semantics,
with crash and concurrent-writer oracles for the replacement.

## Recovery follows the durable log

Delivery cursors advance after dispatch. Replay is at-least-once and input IDs
provide idempotence. A notification is only a hint to read durable work. There
is no second transient transport whose loss would strand an accepted input.
Append failure must roll back both durable bytes and the corresponding state.

Revisit only with an explicit durability model and crash tests that preserve
accepted inputs across process death.

## hcn owns harness differences

lucid invokes hcn as a subprocess through one harness seam. hcn normalizes and
supervises one process; lucid owns the conversation across processes. Exact
pins and captured fixtures make a dependency change deliberate. Runtime
capability claims retain provenance, and unknown event kinds are carried.

Revisit the boundary only if hcn's public contract cannot express a required
interaction. Do not mirror its descriptors, flags, or model registry locally.

## One conversation has one artifact

An artifact is the document being read and discussed in that conversation.
Multiple documents introduced selection, pane, and retirement rules without
an established user need. Keep one stable artifact ID and create a separate
conversation for another document. Older multi-artifact records stay readable
and revisable without reopening the product scope.

Revisit only with a concrete workflow that a separate conversation cannot
serve, followed by an explicit scope decision.

## Document edits preserve evidence

Every save, restore, or agent revision appends a complete immutable version.
Patches are an emission optimization, never stored instructions that future
readers must execute. Human saves retain ancestry even when another version
arrives first. lucid does not guess a merge. Unresolved annotation anchors
retain their original evidence instead of pointing at unrelated text.

Revisit storage representation only with equivalent independent readability
and recovery guarantees. Revisit merging only with a defined user operation.

## Browser and agent content have separate authority

The browser uses a server-lifetime token; the more powerful attach secret stays
on the filesystem. Artifacts run outside lucid's origin, and frame messages
are validated. Attachments offered to an agent are copies outside the record,
so a context path does not reveal the record directory.

Revisit each boundary only with a concrete threat model and equivalent tests;
do not widen authority for convenience.

## A preference is not an event or a claim about reality

The person's driver choice lives in an atomically replaced file. The log says
what actually ran. Keeping them separate makes a refused change explainable
without silently overwriting the choice or pretending the requested model ran.
Changes apply at queue-input boundaries and never respawn human-owned sessions.

Revisit if user intent becomes a historical product feature; do not turn
ordinary preference writes into transcript noise by default.

## Deterministic oracles are the verification gate

Fake harnesses and injected clocks prove invariants reproducibly. Live harness
lanes add dated process evidence but do not replace those oracles or gate CI.
Interactive capability is offered only when its delivery mechanism is proven;
the cooperative rung remains gated rather than advertised optimistically.

Revisit a gate when its stated evidence exists, not merely when a harness
claims the capability. See [smoke verification](smoke-seven.md).
