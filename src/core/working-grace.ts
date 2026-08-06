/**
 * The working-grace threshold (M4.5/M5.1): how long an agent may be quiet
 * before its turn reads as "stale" / no longer actively working. The shared
 * home so the fold (core/fold.ts), the attend engine (server/attend.ts), and
 * the chrome's working clock (client/shared/working-grace.ts) all read ONE
 * constant rather than each importing the fold module just for this number.
 *
 * Owned here - a pure core leaf - so neither the attend engine nor the client
 * reaches into core/fold.ts for a single constant.
 */
export const WORKING_GRACE_MS = 10 * 60 * 1000;
