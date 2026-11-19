/**
 * Usage & cost's FAILED USAGE section (MOTIR-11794; design MOTIR-11793,
 * `platform-admin/design-notes.md` § AMENDMENT 2026-11-19 — Usage & cost ·
 * Failed usage). The gateway usage motir-ai could not apply, grouped by the error
 * it failed with, and what one replay did to its group.
 */

/** One error group, as the section lists it. */
export interface FailedUsageGroupDTO {
  /** The error text exactly as motir-ai stored it; `''` for a row with none. */
  error: string;
  rows: number;
  organizations: number;
  /** ISO 8601. */
  oldestReceivedAt: string;
  newestReceivedAt: string;
}

/** What one replay did to the group it named. */
export interface FailedUsageReplayDTO {
  error: string;
  /** Rows the replay put back to pending — the group as it stood. */
  reset: number;
  /** Of those, recorded. */
  applied: number;
  /** Of those, failed again; they stay listed under the error they failed with. */
  failedAgain: number;
  /** Of those, not reached before the answer; motir-ai finishes them. */
  pending: number;
}
