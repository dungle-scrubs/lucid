/**
 * Owns the pure chat-session reducer: (state, frame, now) -> result or refusal.
 * It covers the full lifecycle of frames, epoch fencing to reject stale writers,
 * lease accounting and renewal, deterministic replay from the folded log, and
 * liveness decisions computed from an injected clock. It performs no I/O of any
 * kind, so it stays fully testable and deterministic. It is NOT responsible for
 * durability or enforcement; the store hosts it and enforces its verdicts.
 */
export {};
