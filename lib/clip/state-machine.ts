import type { ClipStatus } from '@/generated/prisma/client';

/**
 * Every status a Clip may move to, from each status (spec §7, §9).
 *
 * Written as an allow-list rather than a list of forbidden moves. The
 * repository's tombstone predicate only refuses the terminal states, so two
 * damaging transitions commit happily without this table:
 *
 * - `ACTIVE -> ACTIVE` overwrites both archive ids and orphans two Discord
 *   messages the control plane can no longer address. No CHECK objects: the
 *   row is still a perfectly valid ACTIVE Clip, just pointing at the wrong
 *   pair.
 * - `ACTIVE -> FAILED` leaves both ids set on a Clip that reports its archive
 *   was never built, which is exactly the "already deleted vs never attempted"
 *   signal §9.3 depends on.
 *
 * `PENDING -> DELETING` is legal because the first clipper can unclip while
 * archive creation is still in flight or has already failed; the Clip then has
 * no archive to delete but its row still has to go.
 *
 * The terminal states have no outgoing transitions at all. Author/admin
 * removal overrides every preservation signal and its tombstone blocks
 * recreation (§7.4, §9.9); nothing in P0 lifts one except the admin's explicit
 * "delete Clip data" action, which deletes the row rather than transitioning it.
 */
const LEGAL_TRANSITIONS: Record<ClipStatus, readonly ClipStatus[]> = {
  PENDING: ['ACTIVE', 'FAILED', 'DELETING', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN'],
  FAILED: ['ACTIVE', 'DELETING', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN'],
  ACTIVE: ['DELETING', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN'],
  DELETING: ['ACTIVE', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN'],
  REMOVED_BY_AUTHOR: [],
  REMOVED_BY_ADMIN: [],
};

export function canTransition(from: ClipStatus, to: ClipStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * Throws unless `from -> to` is legal.
 *
 * For transitions decided under the same lock that read `from`, an illegal
 * move is a defect in the caller and must not reach the database. A transition
 * decided across a Discord round-trip is different: the status can legitimately
 * have moved on while the network call was in flight, so those call sites ask
 * `canTransition` and treat "no" as an outcome to clean up after, not as a bug.
 */
export function assertTransition(from: ClipStatus, to: ClipStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal Clip transition: ${from} -> ${to}`);
  }
}

/**
 * True for the removal tombstones, which are the states nothing transitions
 * out of. Derived from the table so the two definitions cannot drift.
 */
export function isTerminalStatus(status: ClipStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}
