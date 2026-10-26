import { assertOrgNotClosing } from '@/lib/organizations/closingGuard';
import { organizationsService } from '@/lib/services/organizationsService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { bindOrganizationContext, withOrgContext } from '@/lib/organizations/context';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { orgCan } from '@/lib/organizations/capabilities';
import {
  createCheckoutSession,
  createPortalSession,
  estimateCalculator,
  getCalculatorCategories,
  getOrgSubscription,
  getOrgUsage,
  getPendingPlanChange,
  previewPlanDowngrade,
  previewPlanUpgrade,
  schedulePlanDowngrade,
  setSeatQuantity,
  upgradePlan,
  type SeatQuantityResult,
} from '@/lib/ai/motirAiClient';
import {
  CalculatorRequestRefusedError,
  MotirAiError,
  MotirAiPlanChangeRefusedError,
} from '@/lib/ai/errors';
import { isCloudBilling } from '@/lib/billing/availability';
import { isPaidAiSubscriptionStatus } from '@/lib/services/aiPlanGateService';
import {
  BILLING_CATALOG,
  DEFAULT_CHECKOUT_QUANTITY,
  hostMonthlyPlanCredits,
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  isAllowedCheckoutQuantity,
  isKnownCheckoutPrice,
  isPlanChangeKey,
  largerPoolCreditsForPrice,
  type BillingCadence,
} from '@/lib/billing/catalog';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  BillingPlanChangeRefusedError,
  InvalidBillingQuantityError,
  LargerPoolAtOrBelowCeilingError,
  UnknownBillingPriceError,
} from '@/lib/billing/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { Organization } from '@/generated/prisma/client';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import {
  calculatorEstimateRequestSchema,
  type CalculatorAnswerDTO,
  type CalculatorCategoriesDTO,
} from '@/lib/dto/billing';
import type {
  BillingCheckoutDTO,
  BillingSessionDTO,
  BillingStatusDTO,
  DowngradePreviewDTO,
  DowngradeResultDTO,
  PendingPlanChangeDTO,
  SeatSummaryDTO,
  UpgradePreviewDTO,
  UpgradeResultDTO,
} from '@/lib/dto/billing';
import {
  toDowngradePreviewDTO,
  toDowngradeResultDTO,
  toPendingPlanChangeDTO,
  toUpgradePreviewDTO,
  toUpgradeResultDTO,
} from '@/lib/mappers/billingMappers';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// A paid Motir AI plan = a live Stripe subscription that grants the monthly
// allotment (decision §5). `trialing` (the one-time free grant), `canceled`
// (dropped to free) and "no subscription" are NOT paid — they take the tier-gate
// paywall ("AI is a paid feature"), not the out-of-credits one. The status list
// lives in `aiPlanGateService` (MOTIR-6909), so the billing panel and the fleet's
// plan gate read ONE definition.

// The OPEN-CORE side of billing (Story 8.1.6). motir-core holds NO ledger and NO
// Stripe key (the open-core invariant): it READS the org's plan over the boundary
// and INITIATES Stripe sessions through motir-ai (8.1.5), which owns the SDK and
// the secret. This service is the email.ts-style leaf-client pattern the
// aiUsageService already established — it (1) REUSES the 6.10.4 org gate
// (`resolveOrgAccess`), (2) enforces the ADR §7 billing gate (viewing AND
// mutating billing are owner/admin — the `manageBilling` capability; a plain
// member has neither, MOTIR-6305), and (3) enforces the ADR §6
// CLOUD-ONLY gate (`MOTIR_CLOUD`) so a self-hosted build has no billing at all.
//
// The two billed products (ADR §1) read from two stores: ① Motir (seats) is the
// LOCAL `Organization.scaledTrackerSubscription` (written by 8.1.4c); ② Motir AI
// is the `PlanTier` + balance folded from the `/v1/usage` read, plus the Stripe
// subscription lifecycle (status + renewal) folded from the 8.1.13
// `/v1/stripe/subscription` read (the seam 8.1.5 did not ship, now landed).

export interface OrgActorInput {
  organizationId: string;
  actorUserId: string;
}

// The org-settings billing surface the Stripe redirects (success / cancel /
// portal-return) come back to. 8.1.7 owns the final route; this is the area the
// design names (`app/(authed)/settings/organization/billing`).
function billingPagePath(): string {
  return '/settings/organization/billing';
}

function billingPageUrl(query?: string): string {
  return `${resolveBaseUrlTrimmed()}${billingPagePath()}${query ?? ''}`;
}

/**
 * The billing page's VIEW gate (the three statements `getBillingStatus` makes):
 * cloud only (404 off-cloud), a member of the org (404 otherwise, the no-leak
 * rule), holding `manageBilling` (403 for a plain member).
 */
async function assertCanViewBilling(input: OrgActorInput): Promise<void> {
  if (!isCloudBilling()) throw new BillingNotAvailableError();
  const access = await organizationsService.resolveOrgAccess(
    input.actorUserId,
    input.organizationId,
  );
  if (!orgCan(access.role, 'manageBilling')) {
    throw new BillingForbiddenError('Viewing billing requires an org owner or admin.');
  }
}

export const billingService = {
  /**
   * The org's billing status — the two billed lines + the catalog (Story 8.1.6).
   * Cloud-only (BillingNotAvailableError → 404 off-cloud). VIEW is owner/admin
   * (the `manageBilling` capability, `lib/organizations/capabilities.ts`);
   * a plain member gets BillingForbiddenError (→ 403, the routed-to-owner state).
   * Throws OrganizationNotFoundError (→ 404) for a non-member (the no-leak rule),
   * and lets a motir-ai failure propagate as a MotirAiError (→ the route's 502).
   */
  async getBillingStatus(input: OrgActorInput): Promise<BillingStatusDTO> {
    if (!isCloudBilling()) throw new BillingNotAvailableError();

    // (1) Gate — reuse the 6.10.4 org access check (404 for a non-member); VIEW
    // requires the billing capability (owner/admin, ADR §7), so a plain member
    // is forbidden.
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!orgCan(access.role, 'manageBilling')) {
      throw new BillingForbiddenError('Viewing billing requires an org owner or admin.');
    }

    // (2) ① Motir (seats) — the LOCAL scaled-tracker subscription (8.1.4c). Read
    // under the org context so the membership/org RLS admits the self-read.
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => organizationRepository.findByIdInTx(input.organizationId, tx),
    );
    // (3) ② Motir AI — fold the tier + balance from the usage read AND the Stripe
    // subscription lifecycle (status + renewal) from the 8.1.13 subscription read,
    // so 8.1.7 renders the status `Pill` + "renews {date}". Both are over the
    // boundary; a motir-ai outage throws a MotirAiError the route maps to 502 (the
    // design's "couldn't load billing" state), never a fake zero. The subscription
    // read returns an EMPTY shape (status: null) for a free org — not an error.
    //
    // (4) ③ Motir CI (MOTIR-1903) — the entitlement state MOTIR-1901 already
    // EXPOSES as a readable service result, taken whole rather than re-derived
    // here: re-resolving the pool or re-reading the balance on this surface is
    // exactly how two surfaces come to disagree about whether an org is
    // exhausted. It carries its own balance read (and its own `balance: null`
    // treatment for a boundary blip), which is why the panel can render the
    // balance-unavailable state at all — the AI line's read having succeeded
    // does not make the CI line's read succeed.
    return assembleBillingStatus(org, input.organizationId, {
      role: access.role,
      canManageBilling: orgCan(access.role, 'manageBilling'),
    });
  },

  /**
   * The Calculator's pickers (MOTIR-8637): the engine's model categories, band
   * for band, including a band with no live model. Gated exactly as the billing
   * page's status read is — the calculator is for whoever that page is for.
   * Nothing is cached; every call reaches the engine.
   */
  async getCalculatorCategories(input: OrgActorInput): Promise<CalculatorCategoriesDTO> {
    await assertCanViewBilling(input);
    return getCalculatorCategories();
  },

  /**
   * One calculator estimate (MOTIR-8637). The gate runs FIRST, then the body is
   * parsed by the strict request schema — so a refused body never reaches the
   * engine, and a non-member learns nothing from a malformed one. The answer is
   * the engine's, unaltered: an `estimate`, or its `empty_category`.
   */
  async estimateCalculator(input: OrgActorInput & { body: unknown }): Promise<CalculatorAnswerDTO> {
    await assertCanViewBilling(input);
    const parsed = calculatorEstimateRequestSchema.safeParse(input.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.') ?? '';
      // An unknown key's issue sits on its PARENT's path and names the key.
      const unknownKey = issue?.code === 'unrecognized_keys' ? (issue.keys[0] ?? null) : null;
      const field = unknownKey ? (path ? `${path}.${unknownKey}` : unknownKey) : path || null;
      throw new CalculatorRequestRefusedError(
        field,
        `${field ?? 'body'}: ${issue?.message ?? 'invalid'}`,
      );
    }
    return estimateCalculator(parsed.data);
  },

  /**
   * The members-page SEAT summary (Story 8.1.14) — the in-context seat/billing
   * layer the org Members admin renders for a SCALED org. Returns `null` (→ NO
   * seat UI, the unchanged members page) for the three gated-out cases:
   *   • a self-host build (`MOTIR_CLOUD` off — ADR §6),
   *   • a non-owner/admin actor (the no-leak default; the members page already
   *     forbids non-admins, so this is belt-and-braces),
   *   • a free or `canceled` org (no scaled-tracker subscription).
   * When scaled+`active`/`past_due`, returns the pricing (from `BILLING_CATALOG`),
   * cadence (from the `tracker_*` price id), renewal (`currentPeriodEnd`) and the
   * `canManageBilling` flag (owner or admin since MOTIR-6305). This is a pure
   * READ — it never writes Stripe (8.1.12 owns the seat-quantity sync); the seat COUNT is the membership
   * count, read client-side from the roster total.
   */
  async getSeatSummary(input: OrgActorInput): Promise<SeatSummaryDTO | null> {
    if (!isCloudBilling()) return null;

    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!orgCan(access.role, 'manageBilling')) return null;

    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => organizationRepository.findByIdInTx(input.organizationId, tx),
    );
    const sub = (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;
    // Free (null) or a wound-down (`canceled`) subscription → the page is unchanged.
    if (!sub || sub.status === 'canceled') return null;

    const cadence: BillingCadence = sub.priceId === 'tracker_annual' ? 'annual' : 'monthly';
    const seatPrices = BILLING_CATALOG.seatPlan.prices;
    return {
      status: sub.status,
      cadence,
      perSeatUsd: seatPrices[cadence].amountUsd,
      monthlyPerSeatUsd: seatPrices.monthly.amountUsd,
      annualPerSeatUsd: seatPrices.annual.amountUsd,
      currentPeriodEnd: sub.currentPeriodEnd,
      canManageBilling: orgCan(access.role, 'manageBilling'),
    };
  },

  /**
   * The MEMBER-SAFE AI entitlement read that drives the 8.1.8 paywall. Unlike
   * `getBillingStatus` (owner/admin VIEW gate), this admits ANY org member —
   * because the paywall must render its variant for everyone, and a plain member
   * gets the "ask an owner" state rather than a 403. It exposes only the upsell's
   * needs (blocked? can-buy? paid-plan vs tier-gate? org name + tier), never the
   * financial detail.
   *
   * - Off-cloud (`MOTIR_CLOUD=false`) → `applicable: false`: a self-host build is
   *   uncapped and never metered, so there is no paywall. The caller renders
   *   nothing.
   * - On cloud → verifies org membership (`resolveOrgAccess`; a non-member throws
   *   OrganizationNotFoundError, the no-leak rule), then folds the AI tier +
   *   balance (usage read) and the Stripe subscription lifecycle into the entitlement.
   *   A motir-ai outage propagates as a MotirAiError (the route degrades to
   *   "not applicable" so a transient boundary blip never flashes a false gate).
   */
  /**
   * The AI entitlement for the actor's ACTIVE PROJECT context (the form the AI
   * entry points have — they hold a `ProjectContext`, not an org id). Resolves
   * the workspace's org RLS-aware (the same seam aiChatService uses) then folds
   * the entitlement. Off-cloud short-circuits BEFORE any read.
   */
  async getAiAccessForContext(input: {
    actorUserId: string;
    workspaceId: string;
  }): Promise<AiAccessDTO> {
    if (!isCloudBilling()) return notApplicableAiAccess();
    const organizationId = await resolveOrganizationId(input.actorUserId, input.workspaceId);
    return this.getAiAccess({ actorUserId: input.actorUserId, organizationId });
  },

  async getAiAccess(input: OrgActorInput): Promise<AiAccessDTO> {
    if (!isCloudBilling()) return notApplicableAiAccess();

    // Membership gate ONLY (any role) — NOT the owner/admin VIEW gate. Owner or
    // admin vs member just selects the paywall variant (canManageBilling), never
    // access.
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );

    // The META org (moooon B.V.) is exempt from the AI paywall: `applicable:
    // false` makes the upsell never render (the same shape as a self-host build —
    // useAiAccess only blocks when `applicable === true`). The motir-ai credit
    // gate is bypassed in parallel (the org's `isMeta` rides the job envelope).
    //
    // The exemption is decided by a LOCAL column, so the row is read FIRST and
    // the method short-circuits on it (MOTIR-2594, shape (a)). This read used to
    // sit inside the `Promise.all` below, which made a meta org — whose answer
    // needs nothing across the boundary — pay two motir-ai round trips it then
    // discarded, and, worse, made its answer DEPEND on them: `aiFetch` maps both
    // a transport failure and its MOTIR_AI_REQUEST_TIMEOUT_MS (30s) deadline to
    // MotirAiUnavailableError, so a motir-ai outage failed `/settings/organization`
    // for the one organization most likely to be reading it during one.
    //
    // The common (non-meta) path pays one serialised local read for that.
    // MEASURED rather than assumed, per the card: 100 `withOrgContext` +
    // `findByIdInTx` reads against a real Postgres → p50 1.06ms, p95 3.58ms,
    // against a cross-service call bounded at 30_000ms. Shape (b) (keeping the
    // parallel group and making the remote reads tolerant) was rejected: it costs
    // more code AND still issues both requests, which the card's first acceptance
    // criterion — zero calls for a meta org — forbids.
    const org = await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => organizationRepository.findByIdInTx(input.organizationId, tx),
    );
    if (org?.isMeta) return notApplicableAiAccess();

    const [usage, subscription] = await Promise.all([
      getOrgUsage({ coreOrganizationId: input.organizationId, scope: 'org' }),
      getOrgSubscription({ coreOrganizationId: input.organizationId }),
    ]);

    return {
      applicable: true,
      organizationId: input.organizationId,
      organizationName: org?.name ?? null,
      canManageBilling: orgCan(access.role, 'manageBilling'),
      hasPaidAiPlan: isPaidAiSubscriptionStatus(subscription.status),
      balance: usage.balance,
      tierName: usage.tier?.name ?? null,
      tierAllotment: usage.tier?.monthlyCreditAllotment ?? null,
      renewsAt: subscription.currentPeriodEnd,
    };
  },

  /**
   * Start a Stripe Checkout Session for a selected catalog price, returning the
   * hosted URL to redirect to. Cloud-only; OWNER-ONLY (ADR §7). Validates the
   * price AND the unit count against the catalog allow-list before touching the
   * boundary.
   *
   * `quantity` is the credit top-up's bundle multiplier (1× / 5× / 10×), absent
   * for every other line and defaulted to 1 here — so what reaches Stripe is
   * always an explicit number rather than a boundary default two services away
   * (MOTIR-2949). The guard is deliberately stricter than the route's shape
   * check: the route proves the field is a positive integer, this proves the
   * catalog actually SELLS that many of that price. A recurring plan can never
   * be multiplied from the client, because a subscription's quantity is the seat
   * sync's to own and a one-time payment has no reconciler at all.
   */
  async startCheckout(
    input: OrgActorInput & { priceLookupKey: string; quantity?: number },
  ): Promise<BillingCheckoutDTO> {
    await this.assertBillingManagerForMutation(input);

    // A larger pool at or below Host's pool — a size Host or the ladder already
    // covers, or a stale key for one of the removed first rungs — earns its own
    // refusal (MOTIR-8990, floored at Host by MOTIR-9366), before the generic
    // unknown-price one would swallow it.
    const requestedPool = largerPoolCreditsForPrice(input.priceLookupKey);
    const floor = hostMonthlyPlanCredits();
    if (requestedPool !== null && requestedPool <= floor) {
      throw new LargerPoolAtOrBelowCeilingError(input.priceLookupKey, requestedPool, floor);
    }

    if (!isKnownCheckoutPrice(input.priceLookupKey)) {
      throw new UnknownBillingPriceError(input.priceLookupKey);
    }

    const quantity = input.quantity ?? DEFAULT_CHECKOUT_QUANTITY;
    if (!isAllowedCheckoutQuantity(input.priceLookupKey, quantity)) {
      throw new InvalidBillingQuantityError(input.priceLookupKey, quantity);
    }

    // NOTE the catalog seam (lib/billing/catalog.ts): the boundary's `priceId` is
    // the Stripe price lookup key; motir-ai resolves it to the concrete Price.
    const result = await createCheckoutSession({
      coreOrganizationId: input.organizationId,
      priceId: input.priceLookupKey,
      quantity,
      successUrl: billingPageUrl('?checkout=success'),
      cancelUrl: billingPageUrl('?checkout=cancel'),
    });
    // An org already on a live AI plan is pointed at the upgrade path, never sold a
    // second plan subscription (MOTIR-8394; motir-ai answers it, MOTIR-8386).
    return result.outcome === 'existing_plan'
      ? { existingPlan: { livePriceLookupKey: result.livePriceLookupKey } }
      : { url: result.url };
  },

  /**
   * Open a Stripe Billing Portal session, returning its short-lived URL. Cloud-
   * only; OWNER-ONLY. A 404 from motir-ai (the org has no Stripe customer yet)
   * surfaces as a MotirAiJobNotFoundError the route maps via the boundary path.
   */
  async openPortal(input: OrgActorInput): Promise<BillingSessionDTO> {
    await this.assertBillingManagerForMutation(input);

    return createPortalSession({
      coreOrganizationId: input.organizationId,
      returnUrl: billingPageUrl(),
    });
  },

  // ── Changing the AI plan mid-period (Story MOTIR-8387 · MOTIR-8399) ──────
  //
  // An org holds ONE AI plan; a change of it goes up now (charged for the days
  // left, the extra credits granted when the invoice is paid) or down at the
  // period end (nothing charged, refunded or granted until then). motir-ai owns
  // every figure and every rule; these methods gate the actor, refuse a key the
  // catalog does not sell, and pass the answer through as a DTO. Previews are
  // gated like the writes: they price a change only an owner or admin can make.

  /** What an upgrade to `toPlanKey` costs now and grants. Writes nothing. */
  async previewUpgrade(input: OrgActorInput & { toPlanKey: string }): Promise<UpgradePreviewDTO> {
    await this.assertPlanChangeAllowed(input);
    return toUpgradePreviewDTO(
      await planChangeCall(() =>
        previewPlanUpgrade({
          coreOrganizationId: input.organizationId,
          toPlanKey: input.toPlanKey,
        }),
      ),
    );
  },

  /** Upgrade now, at the `prorationDate` the preview returned. */
  async upgradePlan(
    input: OrgActorInput & { toPlanKey: string; prorationDate: number },
  ): Promise<UpgradeResultDTO> {
    await this.assertPlanChangeAllowed(input);
    return toUpgradeResultDTO(
      await planChangeCall(() =>
        upgradePlan({
          coreOrganizationId: input.organizationId,
          toPlanKey: input.toPlanKey,
          prorationDate: input.prorationDate,
        }),
      ),
    );
  },

  /** What a downgrade to `toPlanKey` at the period end would do. Writes nothing. */
  async previewDowngrade(
    input: OrgActorInput & { toPlanKey: string },
  ): Promise<DowngradePreviewDTO> {
    await this.assertPlanChangeAllowed(input);
    return toDowngradePreviewDTO(
      await planChangeCall(() =>
        previewPlanDowngrade({
          coreOrganizationId: input.organizationId,
          toPlanKey: input.toPlanKey,
        }),
      ),
    );
  },

  /** Schedule the move to `toPlanKey` for the period end. */
  async scheduleDowngrade(
    input: OrgActorInput & { toPlanKey: string },
  ): Promise<DowngradeResultDTO> {
    await this.assertPlanChangeAllowed(input);
    return toDowngradeResultDTO(
      await planChangeCall(() =>
        schedulePlanDowngrade({
          coreOrganizationId: input.organizationId,
          toPlanKey: input.toPlanKey,
        }),
      ),
    );
  },

  /** The billing gate, then the catalog: only a paid, recurring plan is a target. */
  async assertPlanChangeAllowed(input: OrgActorInput & { toPlanKey: string }): Promise<void> {
    await this.assertBillingManagerForMutation(input);
    if (!isPlanChangeKey(input.toPlanKey)) {
      throw new BillingPlanChangeRefusedError(
        'unknown_plan',
        `'${input.toPlanKey}' is not a plan a change of plan can move to.`,
      );
    }
  },

  /**
   * The billing page's VIEW gate, exposed (Story MOTIR-9368 · MOTIR-9661) so the
   * Fleet use read refuses exactly whom Billing & plans refuses: 404 off-cloud and
   * for a non-member, 403 for a plain member.
   */
  async assertCanViewBilling(input: OrgActorInput): Promise<void> {
    await assertCanViewBilling(input);
  },

  /**
   * Shared mutation gate: cloud-on + the actor holds the `manageBilling`
   * capability — the Owner or an Admin (ADR §7 as amended 2026-09-25 by
   * MOTIR-6305: billing mutations were owner-only until the role model,
   * `role-model.md` §1, gave billing to the Admins). Throws
   * BillingNotAvailableError (404) / OrganizationNotFoundError (404, non-member)
   * / BillingForbiddenError (403, a plain member).
   */
  async assertBillingManagerForMutation(input: OrgActorInput): Promise<void> {
    if (!isCloudBilling()) throw new BillingNotAvailableError();
    const access = await organizationsService.resolveOrgAccess(
      input.actorUserId,
      input.organizationId,
    );
    if (!orgCan(access.role, 'manageBilling')) {
      throw new BillingForbiddenError(
        'Managing billing is limited to the organization owner and admins.',
      );
    }
    // No checkout and no portal while the org closes (MOTIR-6396). The portal is
    // refused too, not only checkout: from it a customer can resume the very
    // subscriptions closing set to cancel at period end.
    await withOrgContext(
      { userId: input.actorUserId, organizationId: input.organizationId },
      (tx) => assertOrgNotClosing(input.organizationId, tx),
    );
  },

  /**
   * Resync an org's scaled-tracker Stripe seat `quantity` to its current
   * active-member count (Subtask 8.1.12). The background half of the
   * membership → seat-quantity sync: the `system.billing-seat-sync` Inngest job
   * calls this after an org-membership add/remove commits (best-effort enqueue
   * via `enqueueScaledTrackerSeatSync`), so a failed Stripe call NEVER rolls back
   * or blocks the membership change.
   *
   * Has no actor — it runs as a background job — so it reads the org + member
   * count under `withSystemContext`. Gated twice: off-cloud there is no billing
   * (no-op), and only an org whose `scaledTrackerSubscription.status === 'active'`
   * has seats to bill (every other org is a no-op — the read is cheap).
   *
   * The quantity is the recomputed count read HERE, at run time — an ABSOLUTE
   * target, never a delta. Combined with the endpoint's idempotent skip-if-equal,
   * this makes the sync converge with no drift under concurrent membership writes
   * (rapid adds can't double-count: each job re-derives the live committed count,
   * and the last membership change's job always reads the final count) AND makes
   * this method itself the reconcile primitive — re-running it re-derives truth.
   */
  async syncScaledTrackerSeatQuantity(organizationId: string): Promise<SeatQuantityResult> {
    // Off-cloud there is no billing at all — nothing to bill is the honest shape.
    if (!isCloudBilling()) return { applied: false, outcome: 'no_active_tracker_subscription' };

    const { isScaledActive, memberCount, aiIncludedSeat, closing } = await withSystemContext(
      async (tx) => {
        // ⚠️ BIND THE ORG (MOTIR-2880). `organization` and `organization_membership`
        // have no `system_admin` arm — their SELECT policies read `app.organization_id`
        // (and, for the membership, `app.user_id`) — so under `motir_app` both reads
        // below returned empty: `org` null and `count` 0. The method then answered
        // `no_active_tracker_subscription` for every org, and seat billing silently
        // stopped converging. Additive to the flag, and the id is a trusted argument
        // (the job's own envelope), which is `withOrgServiceWriteContext`'s constraint.
        await bindOrganizationContext(tx, organizationId);
        const org = await organizationRepository.findByIdInTx(organizationId, tx);
        const scaled = (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;
        const count = await organizationMembershipRepository.countByOrg(organizationId, tx);
        return {
          isScaledActive: scaled?.status === 'active',
          memberCount: count,
          aiIncludedSeat: org?.aiIncludedSeat ?? false,
          closing: org?.closingSince != null,
        };
      },
    );

    // A closing org's seat count is frozen (MOTIR-6396): its subscriptions are set
    // to cancel at period end, and motir-ai refuses a quantity change for it. The
    // honest answer is that nothing was applied; a cancel's next membership change
    // resyncs from the live count, as every run does.
    if (closing) return { applied: false, outcome: 'unchanged' };

    // Only an active scaled-tracker org has seats to bill; everything else is a
    // benign no-op (a free org, a past_due/canceled one — its caps are already
    // handled by the webhook flag, not the seat count).
    if (!isScaledActive) return { applied: false, outcome: 'no_active_tracker_subscription' };

    // A PAID Motir AI plan BUNDLES the first seat (ADR §4, amended 2026-06-24 /
    // 8.1.22): net it out of the billed scaled-tracker quantity so the org pays
    // for members BEYOND the included one. Floors at 0 (a 1-member org never bills
    // a seat). An org WITHOUT the AI seat bills every member, as before.
    const billableSeats = aiIncludedSeat
      ? Math.max(0, memberCount - INCLUDED_TRACKER_SEATS_PER_AI_PLAN)
      : memberCount;

    return setSeatQuantity({ coreOrganizationId: organizationId, quantity: billableSeats });
  },
};

// A motir-ai plan-change refusal becomes the billing domain's typed refusal, so
// the route maps it by `reason`; every other boundary error passes through.
async function planChangeCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof MotirAiPlanChangeRefusedError) {
      throw new BillingPlanChangeRefusedError(err.reason, err.message);
    }
    throw err;
  }
}

// The pending downgrade the plan cards show (MOTIR-8399), read only for an org on
// a live paid plan. It is the one read here that reaches Stripe live, so a
// failure DEGRADES to `null` (no pill on the cards) instead of failing the whole
// billing page: the dialogs' previews read the same schedule and still report it.
async function readPendingDowngrade(
  organizationId: string,
  status: BillingStatusDTO['motirAi']['subscription']['status'],
): Promise<PendingPlanChangeDTO | null> {
  if (status !== 'active' && status !== 'trialing' && status !== 'past_due') return null;
  try {
    const { pendingDowngrade } = await getPendingPlanChange({ coreOrganizationId: organizationId });
    return toPendingPlanChangeDTO(pendingDowngrade);
  } catch (err) {
    if (!(err instanceof MotirAiError)) throw err;
    console.warn('[billing] pending plan change unavailable', { organizationId, code: err.code });
    return null;
  }
}

// Resolve the active workspace's organization id — RLS-aware (the workspace
// policy admits the self-read under the non-bypass app role). Mirrors
// aiChatService.resolveOrganizationId so the AI paywall reads the SAME org the
// AI jobs are metered against.
async function resolveOrganizationId(actorUserId: string, workspaceId: string): Promise<string> {
  return withWorkspaceContext({ userId: actorUserId, workspaceId }, async (tx) => {
    const workspace = await workspaceRepository.findByIdInTx(workspaceId, tx);
    if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
    return workspace.organizationId;
  });
}

// The "no paywall here" entitlement — a self-host build (or any non-cloud
// context). Every flag is inert so the client renders nothing.
function notApplicableAiAccess(): AiAccessDTO {
  return {
    applicable: false,
    organizationId: null,
    organizationName: null,
    canManageBilling: false,
    hasPaidAiPlan: false,
    balance: 0,
    tierName: null,
    tierAllotment: null,
    renewsAt: null,
  };
}

/**
 * The billing status's ASSEMBLY — every read after the gate (Story MOTIR-727 ·
 * MOTIR-7289 split it out of `getBillingStatus`).
 *
 * ⚠️ IT GATES NOTHING. Its two callers each gate first: the tenant path through
 * `getBillingStatus`'s org-role check (an owner or admin of THIS org), and the
 * operator's read-only Billing tab through `platformOrgBillingService`, behind
 * `requirePlatformStaff` and an audited platform read. Never call it from anywhere
 * else.
 */
export async function assembleBillingStatus(
  org: Pick<
    Organization,
    'isMeta' | 'internalBilling' | 'aiIncludedSeat' | 'scaledTrackerSubscription'
  > | null,
  organizationId: string,
  access: BillingStatusDTO['access'],
): Promise<BillingStatusDTO> {
  const scaledTrackerSubscription =
    (org?.scaledTrackerSubscription as ScaledTrackerSubscription | null) ?? null;
  const [usage, subscription, ci] = await Promise.all([
    getOrgUsage({ coreOrganizationId: organizationId, scope: 'org' }),
    getOrgSubscription({ coreOrganizationId: organizationId }),
    ciAllowanceService.getEntitlementState(organizationId, new Date()),
  ]);
  const pendingDowngrade = await readPendingDowngrade(organizationId, subscription.status);

  return {
    organizationId: organizationId,
    access,
    isMeta: org?.isMeta ?? false,
    internalBilling: org?.internalBilling ?? false,
    motir: { scaledTrackerSubscription, aiIncludedSeat: org?.aiIncludedSeat ?? false },
    motirAi: { tier: usage.tier, balance: usage.balance, subscription, pendingDowngrade },
    ci,
    // The FOURTH billed line, off the SAME `getOrgUsage` read `motirAi` above
    // uses — no second request. `?? null` is load-bearing: an absent block is
    // UNAVAILABLE, and zeroing it here would render "you spent nothing on
    // search" on a boundary that never answered.
    search: usage.search ?? null,
    // The Agents line (MOTIR-6920), off the same read. Either block missing is
    // UNAVAILABLE — a total over one real figure and one invented zero would
    // understate the charge.
    agents: {
      spend:
        usage.agentMachine && usage.agentStorage
          ? {
              machineMonthSpend: usage.agentMachine.monthSpend,
              storageMonthSpend: usage.agentStorage.monthSpend,
            }
          : null,
      hasPaidAiPlan:
        isPaidAiSubscriptionStatus(subscription.status) ||
        (org?.isMeta ?? false) ||
        (org?.internalBilling ?? false),
    },
    catalog: BILLING_CATALOG,
  };
}
