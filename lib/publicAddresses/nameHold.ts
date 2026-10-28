// THE NAME HOLD — what a released workspace subdomain leaves behind, and how
// often a workspace may change its name. Story MOTIR-4528 · Subtask MOTIR-9506.
//
// `docs/decisions/public-tenant-addresses.md` §8 Amendment 3 settles two rules
// this file is the ONE definition of:
//
//   * Rule 3 — a label held strictly less than 24 hours returns to the pool the
//     moment it is renamed or released; one held longer is quarantined for 90
//     days. The only reason to hold a released name is that somebody may link to
//     it, and a label abandoned within a day was never indexed, bookmarked or
//     linked. Exactly 24 hours held is quarantined.
//   * Rule 4 — one subdomain change per workspace per 30 days, counting renames
//     and releases alike, with no cap on the number of changes.
//
// ⚠️ PURE BY CONSTRUCTION. No Prisma, no database, no clock: every instant is an
// argument, so the 24-hour boundary is testable to the millisecond and the
// confirm dialog's preview and the write that follows it compute the same date
// from the same function. Arithmetic is on UTC milliseconds, so a daylight-saving
// shift in any viewer's zone moves no boundary.

export const GRACE_HOURS = 24;
export const QUARANTINE_DAYS = 90;
export const CHANGE_INTERVAL_DAYS = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** What renaming or releasing a label does to it. */
export type HoldOutcome =
  | { readonly kind: 'return_now' }
  | { readonly kind: 'quarantine'; readonly returnsAt: Date };

/** The instant `days` UTC days after `from`. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * The hold a label takes when it stops being a workspace's name.
 *
 * `claimedAt` is when the workspace took the label (the live address row's
 * creation), `releasedAt` when it renamed or released it. A `return_now` writes
 * no reservation at all; a `quarantine` reserves the name until `returnsAt`.
 */
export function holdOutcome(input: { claimedAt: Date; releasedAt: Date }): HoldOutcome {
  const heldMs = input.releasedAt.getTime() - input.claimedAt.getTime();
  if (heldMs < GRACE_HOURS * HOUR_MS) return { kind: 'return_now' };
  return { kind: 'quarantine', returnsAt: addDays(input.releasedAt, QUARANTINE_DAYS) };
}

/** The earliest instant a workspace may change its name again. */
export function nextChangeAllowedAt(lastChangedAt: Date): Date {
  return addDays(lastChangedAt, CHANGE_INTERVAL_DAYS);
}

/**
 * Whether a rename or release is allowed at `now`.
 *
 * `null` means the workspace has never changed its name — a first claim is not a
 * change, so it starts no clock.
 */
export function canChangeNow(lastChangedAt: Date | null, now: Date): boolean {
  if (!lastChangedAt) return true;
  return now.getTime() >= nextChangeAllowedAt(lastChangedAt).getTime();
}
