import { _resetOrgPlanCache, readOrgPlan } from '@/lib/services/orgPlanReader';

// THE PAID-AI-PLAN GATE (Story MOTIR-6906 · MOTIR-6909) —
// `docs/decisions/fleet-per-org-pool.md`: the fleet is paid-AI-plan only.
//
// ONE question, asked at every door that spends Motir's fleet: *does this
// organisation hold a paid monthly AI plan?* Motir Studio asks it before it
// creates a hosted repository (`projectRepoProvisioningService.establishSet`), and
// fleet admission asks it before it counts the org's pool (the CI, index and
// hosted-agent gates). The agent lane's create and wake (MOTIR-6918) ask it too,
// which is why the answer for Motir's own organisations is decided HERE, once.
//
// ── THE THREE ANSWERS ───────────────────────────────────────────────────────
//   `true`      — a paid plan: a Stripe subscription whose status grants the
//                 monthly allotment (`PAID_AI_SUBSCRIPTION_STATUSES`), OR one of
//                 Motir's own organisations (below), OR a self-hosted build, which
//                 has no billing at all (`isCloudBilling`, ADR billing-tiering §6).
//   `false`     — no paid plan. The doors refuse `ai_plan_required`.
//   `'unknown'` — the plan could not be read (motir-ai unreachable, or the org
//                 row). The doors refuse too — `plan_unknown` at establish, a
//                 deferral at admission — and NEVER fall through: a guessed "yes"
//                 is a free fleet for whoever motir-ai cannot see.
//
// ⚠️ MOTIR'S OWN ORGANISATIONS PASS WITHOUT A REMOTE READ. `isMeta` (moooon B.V.)
// and `internalBilling` (an internal org) are answered `true` from the org's own
// row, BEFORE motir-ai is asked — so neither is ever refused, and neither can be
// failed closed by an unreachable motir-ai (the product owner, 2026-09-29: "meta
// org and internal org have no limit", MOTIR-6902). Neither flag gains a meaning
// here: `isMeta` is already exempt from the AI paywall (`hasAiEntitlement`), and
// `internalBilling` orgs are charged like customers and offset
// (`internal-billing-classification.md`). This gate only reads them.
//
// ⚠️ A TIER A PLATFORM ADMIN ASSIGNS IS NOT A PAID PLAN (bug MOTIR-8985). The
// admin console's **Change plan** (`platformCreditOpsService.setPlan`) sets the
// tier motir-ai reads the credit allotment from, and touches no Stripe object —
// so an org it moves to Pro still has no subscription, and every door here
// answers `false` for it. That is the decided meaning, not an oversight: the
// fleet spends real money, and "paid" is a fact about who pays it. An org Motir
// comps or tests with is classified `internalBilling` (the switch beside Change
// plan on the same page), which is exactly the exemption above. The Change plan
// dialog says so before the admin confirms, so the tier is never mistaken for
// the classification.

/**
 * A paid Motir AI plan = a live Stripe subscription that grants the monthly
 * allotment (billing decision §5). `trialing` (the one-time free grant),
 * `canceled` (dropped to free) and "no subscription" are NOT paid.
 *
 * The ONE copy of this list. `billingService.getAiAccess` derives its
 * `hasPaidAiPlan` through {@link isPaidAiSubscriptionStatus} so the panel and the
 * fleet can never disagree about who has paid.
 */
const PAID_AI_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['active', 'past_due']);

export function isPaidAiSubscriptionStatus(status: string | null): boolean {
  return status !== null && PAID_AI_SUBSCRIPTION_STATUSES.has(status);
}

export type PaidAiPlanAnswer = boolean | 'unknown';

export const aiPlanGateService = {
  /** Does this organisation hold a paid monthly AI plan? See the module header
   *  for the three answers. Never throws.
   *
   *  The read itself — the org-row exemption, the no-billing short-circuit, the
   *  subscription and its 30-second cache — is `orgPlanReader`'s, shared with the
   *  plan caps (MOTIR-9372), so one admission pays for ONE subscription read. */
  async hasPaidAiPlan(organizationId: string): Promise<PaidAiPlanAnswer> {
    const read = await readOrgPlan(organizationId);
    if (read.kind === 'exempt') return true;
    if (read.kind === 'unknown') return 'unknown';
    return isPaidAiSubscriptionStatus(read.subscription.status);
  },
};

/** Test seam: forget every cached answer. */
export function _resetAiPlanCache(): void {
  _resetOrgPlanCache();
}

/** The words each door's refusal carries (`fleet-per-org-pool.md` §4). */
export const AI_PLAN_REQUIRED_ESTABLISH_MESSAGE =
  'Motir-hosted repositories need a paid AI plan. Upgrade your AI plan to create one here.';
export const AI_PLAN_REQUIRED_ADMISSION_DETAIL =
  "This organization has no paid AI plan, so its CI does not run on Motir's runners.";
export const PLAN_UNKNOWN_ESTABLISH_MESSAGE =
  "Motir could not read this organization's AI plan just now, so no repository was created. Try again in a moment.";
export const PLAN_UNKNOWN_ADMISSION_DETAIL =
  "Motir could not read this organization's AI plan, so the job waits until it can.";
