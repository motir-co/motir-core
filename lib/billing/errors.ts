// Typed errors for the billing-propagation surface (Story 8.1). The route layer
// translates these to HTTP status codes; the service throws them. (Org-not-found
// reuses `OrganizationNotFoundError` from lib/organizations/errors.ts — the org
// is an existing entity, not a billing-owned one.)

import type { EntitlementKind } from '@/lib/billing/entitlements';
import type { PlanChangeRefusalReason } from '@/lib/ai/errors';

/**
 * The inbound billing-state body failed validation — a missing/empty
 * organizationId, or a `scaledTrackerSubscription` that is neither null nor a
 * well-formed `{ status, priceId, currentPeriodEnd }`. Maps to 400.
 */
export class ScaledTrackerStateValidationError extends Error {
  readonly code = 'SCALED_TRACKER_STATE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'ScaledTrackerStateValidationError';
  }
}

/**
 * The inbound AI-included-seat body failed validation — a missing/empty
 * organizationId or a non-boolean `included` (8.1.24 receiver). Maps to 400.
 */
export class AiIncludedSeatValidationError extends Error {
  readonly code = 'AI_INCLUDED_SEAT_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'AiIncludedSeatValidationError';
  }
}

// ── The billing boundary surface (Story 8.1.6) errors ──────────────────────

/**
 * Billing is not available on this build — a self-hosted (GPL-3.0) deploy where
 * `MOTIR_CLOUD` is off (ADR §6). Maps to 404: the commercial surface simply does
 * not exist off-cloud, rather than existing-but-forbidden.
 */
export class BillingNotAvailableError extends Error {
  readonly code = 'BILLING_NOT_AVAILABLE';
  constructor() {
    super('Billing is only available on Motir cloud.');
    this.name = 'BillingNotAvailableError';
  }
}

/**
 * The actor is an org member who lacks the role this billing action needs (ADR
 * §7: viewing billing is owner/admin; every MUTATION — checkout / portal /
 * change plan / cancel — is OWNER-ONLY). The org IS visible to them, so this is
 * 403, distinct from the not-found gate (404) that hides orgs they aren't in.
 */
export class BillingForbiddenError extends Error {
  readonly code = 'BILLING_FORBIDDEN';
  constructor(detail: string) {
    super(detail);
    this.name = 'BillingForbiddenError';
  }
}

/**
 * Checkout was asked to start a price the catalog does not offer — a stale or
 * tampered identifier. Maps to 400 (a client-correctable bad input).
 */
export class UnknownBillingPriceError extends Error {
  readonly code = 'BILLING_UNKNOWN_PRICE';
  constructor(priceLookupKey: string) {
    super(`Unknown billing price: ${priceLookupKey}`);
    this.name = 'UnknownBillingPriceError';
  }
}

/**
 * Checkout was asked to buy a unit count the catalog does not sell at that price
 * — a non-bundle top-up size, or ANY multiplier on a recurring plan (MOTIR-2949).
 * Maps to 400, like the unknown-price sibling: both are a tampered or stale
 * client input, and both are refused before the boundary so no Stripe Session
 * with the wrong quantity can ever be opened.
 */
export class InvalidBillingQuantityError extends Error {
  readonly code = 'BILLING_INVALID_QUANTITY';
  constructor(priceLookupKey: string, quantity: number) {
    super(`Quantity ${quantity} is not purchasable for ${priceLookupKey}.`);
    this.name = 'InvalidBillingQuantityError';
  }
}

/**
 * Checkout was asked for a larger pool at a size a standing plan already covers — a
 * rung-shaped key (`pool_<N>k_pool_<cadence>`) naming a pool at or below the floor it
 * is passed, Host's pool (MOTIR-8990, floored at Host by MOTIR-9366). Maps to 400, refused before the boundary like its two
 * siblings above, but with its own code so the owner is told the ladder covers it
 * rather than that the price is unknown. `requestedCredits` / `ceilingCredits` are
 * for logs; the owner-facing sentence takes no arguments.
 */
export class LargerPoolAtOrBelowCeilingError extends Error {
  readonly code = 'BILLING_POOL_AT_OR_BELOW_CEILING';
  readonly requestedCredits: number;
  readonly ceilingCredits: number;
  constructor(priceLookupKey: string, requestedCredits: number, ceilingCredits: number) {
    super(
      `${priceLookupKey} names a pool of ${requestedCredits} credits, at or below the larger-pool floor of ${ceilingCredits}.`,
    );
    this.name = 'LargerPoolAtOrBelowCeilingError';
    this.requestedCredits = requestedCredits;
    this.ceilingCredits = ceilingCredits;
  }
}

// ── The §4 entitlement-cap surface (Story 8.1.11) error ────────────────────

/**
 * A free-tier scale cap was hit (ADR §4) — the org tried to create a work item /
 * project / workspace / organization, or upload a file, beyond what its tier
 * allows. Maps to **402 Payment Required**: the action is legitimate but gated
 * behind the $5/seat scaled-tracker subscription (the upgrade path). Carries a
 * machine-readable `entitlement` so the client renders the right upgrade prompt
 * (8.1.7/8.1.8), plus the `limit` and current `usage` for the prompt copy.
 *
 * Distinct from `FileTooLargeError` (413, lib/blob/errors.ts), which the upload
 * path still throws for the PER-FILE size cap (a malformed-request shape); this
 * is the TOTAL-STORAGE / count caps and the tier-derived per-file overage that
 * an upgrade lifts.
 *
 * The default MESSAGE is the server-side string — logs, the API body's `error`,
 * an agent's tool result. It is English and is never what a READER is shown: a
 * reader-facing surface selects `errors.entitlementExceeded.<entitlement>` from
 * the catalogue by the discriminator (`lib/billing/entitlementCopy.ts`,
 * MOTIR-5133), whose `en` entries say exactly what this sentence says.
 */
export class EntitlementExceededError extends Error {
  readonly code = 'ENTITLEMENT_EXCEEDED' as const;
  constructor(
    readonly entitlement: EntitlementKind,
    readonly detail: { limit: number | null; usage?: number },
    message?: string,
  ) {
    super(message ?? `Your plan's ${entitlement.replace('_', ' ')} limit has been reached.`);
    this.name = 'EntitlementExceededError';
  }
}

/**
 * The ROW a §4 cap serializes on, and therefore what could not be locked.
 *
 * The three COUNT caps (§4.1 / §4.2 / §4.4) anchor on the `organization` row —
 * the single shared row every one of that org's creates contends on. The
 * org-CREATION gate (§4.5) cannot: it counts the ACTOR's owner/admin
 * memberships, and on the first create that set is EMPTY, so there is no shared
 * org row in existence to lock. Its anchor is the actor's own `user` row
 * (MOTIR-3717), which exists before the first organization does.
 */
export type CapLockSubject = 'organization' | 'user';

/**
 * A §4 cap could not take the row lock it serializes on, so the
 * `count → compare → create` guard would run UNSERIALIZED — two concurrent
 * creates could both observe `count = limit - 1` and both insert (MOTIR-3710),
 * or two concurrent FIRST creates could both observe zero orgs and both mint one
 * (MOTIR-3717).
 *
 * A cap that cannot serialize must REFUSE, not admit: the alternative is a
 * revenue control failing open with no error, no log line and no metric, which
 * is exactly how this shipped for months. Not a user error and not an upgrade
 * prompt — it is a server-side invariant failure, so it carries no
 * `entitlement` and maps to **500**. Reaching it means either the anchor row
 * vanished mid-transaction or the calling context cannot admit the lock.
 */
export class CapLockUnavailableError extends Error {
  readonly code = 'CAP_LOCK_UNAVAILABLE' as const;
  constructor(
    readonly subject: CapLockSubject,
    readonly subjectId: string,
  ) {
    super(
      `Could not lock ${subject} ${subjectId} for update; ` +
        'the scale cap cannot be enforced without serialization.',
    );
    this.name = 'CapLockUnavailableError';
  }
}

/**
 * A change of AI plan was refused (Story MOTIR-8387 · MOTIR-8399) — by motir-ai
 * (the org has no live plan, the target is not above / below it, the preview
 * expired, the card was declined, …) or by the service's own catalog check
 * (`unknown_plan`). `reason` is the stable code the dialog switches on. Maps to
 * 400, except `payment_failed` (402 — the plan is unchanged and the card needs
 * updating) and `org_closing` (409, like every billing mutation on a closing org).
 */
export class BillingPlanChangeRefusedError extends Error {
  readonly code = 'BILLING_PLAN_CHANGE_REFUSED' as const;
  constructor(
    readonly reason: PlanChangeRefusalReason,
    detail?: string,
  ) {
    super(detail ?? `The plan change was refused: ${reason}.`);
    this.name = 'BillingPlanChangeRefusedError';
  }
}
