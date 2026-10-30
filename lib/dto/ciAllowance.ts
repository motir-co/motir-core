// The CI-minutes ENTITLEMENT state (Story MOTIR-1775 · MOTIR-1901) — the shape
// `ciAllowanceService.getEntitlementState` returns.
//
// ⚠️ THIS IS A DELIBERATE PUBLIC OUTPUT, not an internal branch. The card is
// explicit: *"EXPOSE the `ci_credits_exhausted` / `drawing_on_credits` /
// `within_allowance` state as a readable service result … the state is this
// card's output, not a private branch inside the claim handler."* Two consumers
// already depend on it:
//
//   * MOTIR-1907 drives the repository-side Actions pause off it (the refusal
//     this card raises only gates DISPATCH; GitHub bills on any push).
//   * MOTIR-1902 → MOTIR-1903 render it as the billing panel's third line, "Motir
//     CI" (§7.1), which needs every field below — §7.3 asks for used-vs-included,
//     HOW the pool was derived in words, the reset date, and both states.
//
// Wire-safe scalars only (dates as ISO-8601 strings), per the DTO convention in
// `lib/dto/workItems.ts` — this crosses to a client surface eventually, so it
// carries no Prisma types and no `Decimal`.

import type { CiEntitlementStateName } from '@/lib/ciMetering/allowance';

export interface CiEntitlementStateDTO {
  /**
   * Whether CI entitlement applies AT ALL. False off-cloud (`MOTIR_CLOUD` unset —
   * §8.5: a self-hoster's Actions bill is their own and Motir never hosts their
   * repos), with no provisioning org configured (nothing can be Motir-owned), and
   * for the META org (§4.4 — moooon B.V. pays its own GitHub bill; metering it
   * would bill the house to itself). When false, `state` is `'bypassed'`, nothing
   * is ever charged and no dispatch is ever refused. Off-cloud and with no
   * provisioning org the panel draws no CI line; for the META org (`internal`) it
   * draws a minutes-only line.
   */
  applicable: boolean;
  /**
   * True ONLY for the META org (§4.4): `applicable` is false and `state` is
   * `'bypassed'`, but `consumedMinutes` carries the measured figure so Billing &
   * plans can draw an internal CI line (minutes used, no allowance, no charge,
   * no buy control). False for every other bypass (off-cloud, no provisioning
   * org), which still draw no line at all.
   */
  internal: boolean;
  organizationId: string;
  /** Midnight UTC on the 1st of the calendar month (§4.5). */
  periodStart: string;
  /**
   * The first instant of the NEXT calendar month — the reset moment §7.3.3
   * renders as "Resets 1 Aug". Note it deliberately does NOT coincide with the
   * seat line's renewal date (§4.5's stated cost); the panel must say so rather
   * than let the user assume they match.
   */
  periodEnd: string;
  /** Org membership count the pool was derived from (§4.2). */
  memberCount: number;
  /** `max(members × 300, 1000)` Linux-equivalent minutes (§1). */
  poolMinutes: number;
  /** True when the 1,000-minute floor bound — §7.3.2's "1,000 minute minimum". */
  floorApplied: boolean;
  /** Linux-equivalent minutes consumed this period (the meter's one read). */
  consumedMinutes: number;
  /**
   * Where `consumedMinutes` went (MOTIR-5777): Actions minutes, and
   * pull-request previews converted at MOTIR-5769 §9's factors. Additive — a
   * surface that shows only the total is still right.
   */
  consumedBySource: { ci: number; preview: number };
  /** `max(0, pool − consumed)` — the "of 1,800 minutes" half of §7.3.1. */
  remainingMinutes: number;
  /** `max(0, consumed − pool)` — §7.3.4's "420 minutes over your included minutes". */
  overageMinutes: number;
  /**
   * Credits this period's overage has actually drawn (§7.3.4). The panel reports
   * this and LINKS to the AI line for the balance rather than restating it
   * (§7.2's non-duplication rule).
   */
  chargedCredits: number;
  /**
   * The AI credit balance the state was decided on, or `null` when motir-ai could
   * not be reached. `null` is a real value and is never treated as exhaustion —
   * refusing dispatch on a transport blip would fail closed on Motir's own
   * outage, and it must not render as a misleading zero either.
   */
  balance: number | null;
  /** §6.5's state machine — what MOTIR-1907 and the panel both switch on. */
  state: CiEntitlementStateName;
}
