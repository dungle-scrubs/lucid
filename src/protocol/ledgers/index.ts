/**
 * Ledgers barrel — re-exports the three reducers' sub-ledgers for granular tests.
 * The public `protocol` surface still re-exports LEASE constants and isLive via
 * `reducer.ts` so external import paths do not churn.
 */

export {
  AttachmentLedger,
  isLive,
  LEASE_RENEW_EVERY_MS,
  LEASE_TTL_MS,
  renewAttachment,
  renewLease,
} from "./attachment.js";
export { CreditLedger, clampedGrant, isStarved } from "./credit.js";
export {
  atCapacity,
  clearRedeliver,
  InputLedger,
  queueDepth,
  redeliverable,
} from "./input.js";
