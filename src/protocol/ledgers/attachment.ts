/**
 * AttachmentLedger — the deep submodule that owns epoch fencing and lease accounting.
 *
 * Extracted from `src/protocol/reducer.ts` (01): the reducer was a facade over
 * three ledgers but they lived as comment blocks inside one 826-line file.
 * Now the lease discipline lives here behind a small interface; the reducer
 * imports it and re-exports the constants so the public surface does not move.
 * The ledger is pure (state, now) → boolean/Lease and has no dependency on the
 * reducer's refusal/accept helpers, so its invariants are unit-testable without
 * building a full ChannelState.
 *
 * Single clock: LEASE_TTL_MS / LEASE_RENEW_EVERY_MS live here; `src/protocol/liveness.ts`
 * imports the aliases HEARTBEAT_MS / ATTACH_GRACE_MS from here via the reducer's
 * re-export, never arithmetic on raw numbers.
 */

import type { Lease } from "../frames.js";
import type { Attachment, ChannelState } from "../reducer.js";

export const LEASE_TTL_MS = 15_000;
export const LEASE_RENEW_EVERY_MS = 5_000;

export const AttachmentLedger = {
  /** The ONE place the lease-expiry comparison lives. */
  isLive(state: ChannelState, now: number): boolean {
    return state.attachment !== null && now < state.attachment.lease.expires;
  },

  /** PLAN.md: "a lease is renewed by any frame plus explicit lease grants."
   * Re-minting is gated at renewEvery granularity so per-token frames do not
   * churn lease identity: `expires` only ever moves forward, and a writer
   * streaming frames always holds >= TTL - renewEvery of headroom. */
  renewLease(lease: Lease, now: number): Lease {
    return now + LEASE_TTL_MS - lease.expires >= LEASE_RENEW_EVERY_MS
      ? { expires: now + LEASE_TTL_MS, renewEvery: LEASE_RENEW_EVERY_MS }
      : lease;
  },

  renewAttachment(attachment: Attachment, now: number): Attachment {
    const lease = this.renewLease(attachment.lease, now);
    return lease === attachment.lease ? attachment : { ...attachment, lease };
  },
} as const;

/** Thin helpers so reducer call sites keep their short names if desired. */
export const isLive = (state: ChannelState, now: number): boolean =>
  AttachmentLedger.isLive(state, now);
export const renewLease = (lease: Lease, now: number): Lease =>
  AttachmentLedger.renewLease(lease, now);
export const renewAttachment = (attachment: Attachment, now: number): Attachment =>
  AttachmentLedger.renewAttachment(attachment, now);
