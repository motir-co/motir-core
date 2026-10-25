// The Motir commercial catalog — the "available paid prices for the UI" half of
// the billing surface (Story 8.1.6). Grounded ONE-TO-ONE in
// `docs/decisions/billing-tiering.md` §2/§3 (the locked tiering ADR) and the
// `design/billing/` panel-5 storefront. This is pure DISPLAY + CHECKOUT-routing
// config: it names each purchasable line, its USD price, and the Stripe price
// LOOKUP KEY the UI hands back to `startCheckout`. NO Stripe secret, no SDK — the
// open-core invariant (Stripe lives only in motir-ai).
//
// ── The lookup-key → Stripe `price_…` SEAM (read before wiring live checkout) ──
// The fields below carry the stable Stripe price LOOKUP KEYS (`pro_pool_annual`,
// `tracker_monthly`, …), the same identifiers `lib/billing/scaledTrackerState.ts`
// and the 8.1.4b webhook key off. The 8.1.5 motir-ai checkout endpoint, however,
// passes its `priceId` STRAIGHT into Stripe `line_items[].price`, which requires a
// concrete `price_…` id (contract.md §2.4 shows `"priceId": "price_123"`). The
// real `price_…` ids were provisioned in the Stripe sandbox (8.1.2 / MOTIR-1141)
// but are not recorded in code. So for LIVE checkout one of two things must hold,
// and is tracked as a seam (see the PR / the 8.1.5-side follow-up): EITHER the
// motir-ai checkout resolves a lookup key → Price (`prices.list({ lookup_keys })`),
// OR these keys are mapped to the sandbox `price_…` ids via config. Until then the
// lookup keys are the durable, catalog-stable identifier the rest of 8.1 uses.

export type BillingCadence = 'monthly' | 'annual';

/**
 * How often a tier's credit allotment is granted — motir-ai's `AllotmentCadence`
 * enum on `PlanTier.allotmentCadence`, mirrored verbatim rather than re-named.
 * A `one_time` tier is granted once and never refreshed (the allotment scheduler
 * grants only `monthly` tiers), so the storefront must never call it monthly
 * (MOTIR-5274). This is NOT `BillingCadence`: that is how a PRICE is billed.
 */
export type AllotmentCadence = 'one_time' | 'monthly';

/** A tier's credit grant: how many credits, and how often they are granted. */
export interface CreditAllotment {
  credits: number;
  cadence: AllotmentCadence;
}

/** One cadence's price point — the USD fee + the Stripe price lookup key. */
export interface CatalogPrice {
  /** Whole-USD recurring fee for this cadence (annual = the yearly total). */
  amountUsd: number;
  /** The Stripe price lookup key the UI hands to `startCheckout` (see the seam note). */
  priceLookupKey: string;
}

/**
 * Which part of the AI catalog an entry belongs to (MOTIR-8990). `ladder` is a
 * standing rung every owner can pick from the plan row (Free, Standard, Pro, Max,
 * Max ×2). `larger_pool` is a rung ABOVE the ladder's top, sold only to an org whose
 * own estimate passes it (MOTIR-8987). `host` is a standing plan sold from the plan
 * row (MOTIR-9364): it is never counted by the ladder ceiling, the rung table or the
 * calculator, and only the two allow-lists name it. The ceiling, the rung table and
 * both allow-lists are derived against this field, so neither a larger pool nor Host
 * ever moves the ladder's top.
 */
export type AiPlanBand = 'ladder' | 'larger_pool' | 'host';

/**
 * A Motir AI plan tier (the motir-ai `PlanTier`) as the storefront renders it.
 *
 * PRICED PER ORGANISATION (MOTIR-8390): an org holds ONE AI plan, its credits are
 * whole-org credits, and a plan is always bought at quantity 1 — its price is never
 * per user or per seat. Every paid plan includes ONE tracker seat at no charge
 * (`includedTrackerSeats`); seats beyond it are billed per user at `seatPlan`.
 */
export interface AiPlanCatalogEntry {
  /**
   * The `PlanTier.key` (matches the usage read's `tier.key`). A larger pool's key is
   * `pool_<N>k` — the template member fixes the SHAPE only; which rungs exist is the
   * array below, never this type.
   */
  key: 'free' | 'standard' | 'pro' | 'max' | 'max_x2' | `pool_${number}k` | 'host';
  /** Customer-facing name ("Standard", "Pro", …). */
  name: string;
  /**
   * The tier's credit grant (ADR §2) — its size AND its cadence, because Free's
   * 300 is a one-time signup grant while every paid tier refreshes monthly.
   */
  allotment: CreditAllotment | null;
  /** The recommended/anchor tier (Pro) — accent-bordered in the storefront. */
  recommended: boolean;
  /**
   * The recurring prices, keyed by cadence. `null` for a plan with no Stripe
   * object: Free (the one-time signup grant).
   */
  prices: Record<BillingCadence, CatalogPrice> | null;
  /**
   * Tracker seats included at no charge with this plan: 1 for every paid plan (the
   * solo founder's seat), 0 for Free, which holds no AI plan subscription. DATA only
   * — motir-core's seat resync bills `max(0, members - included)` while the plan is
   * live. Read `INCLUDED_TRACKER_SEATS_PER_AI_PLAN` rather than typing a 1.
   */
  includedTrackerSeats: number;
  /** A standing ladder rung, a larger pool above the ladder's top, or Host (`AiPlanBand`). */
  band: AiPlanBand;
}

/**
 * The Motir (seats / scaled-tracker) plan — PRICED PER USER, billed by membership
 * count. A different product from the AI plans: an org on a live AI plan has one
 * seat included (`AiPlanCatalogEntry.includedTrackerSeats`) and pays this fee for
 * each seat beyond it; an org with no AI plan pays it for every seat.
 */
export interface SeatPlanCatalogEntry {
  name: string;
  /** Per-seat prices by cadence (the `tracker_*` lookup keys). */
  prices: Record<BillingCadence, CatalogPrice>;
}

/** The one-time credit top-up bundle (`creditService.topUp`, `mode: 'payment'`). */
export interface CreditTopupCatalogEntry {
  /** Credits granted per purchased unit. */
  unitCredits: number;
  /** USD price per unit. */
  unitAmountUsd: number;
  priceLookupKey: string;
  /**
   * The bundle sizes the storefront offers, as unit MULTIPLIERS (1× / 5× / 10×).
   * The ONE place this set is written: the top-up card renders a button per entry
   * AND `startCheckout`'s quantity guard admits only these (MOTIR-2949). It used
   * to be a `[1, 5, 10]` literal inside the component, which is how the label
   * ("Buy 10,000 credits — $100") and the wire (`quantity: 1`) came to disagree.
   */
  bundleUnits: readonly number[];
}

export interface BillingCatalog {
  /** ② Motir AI — the credit-plan ladder (ADR §2/§3). */
  aiPlans: AiPlanCatalogEntry[];
  /** ① Motir — the per-seat scaled-tracker plan (ADR §3). */
  seatPlan: SeatPlanCatalogEntry;
  /** The pay-as-you-go credit top-up (ADR §3). */
  creditTopup: CreditTopupCatalogEntry;
}

// The v1 catalog — the exact §3 numbers (USD; v1 seed values per the
// ModelCreditRate stance — tunable without a code change). Annual is the yearly
// total (~33% off the 12× monthly), the Stripe annual-default.
export const BILLING_CATALOG: BillingCatalog = {
  aiPlans: [
    {
      key: 'free',
      name: 'Free',
      allotment: { credits: 300, cadence: 'one_time' },
      recommended: false,
      prices: null,
      includedTrackerSeats: 0,
      band: 'ladder',
    },
    // `starter` removed by the 2026-06-23 amendment (8.1.18 / MOTIR-1308).
    {
      key: 'standard',
      name: 'Standard',
      allotment: { credits: 5000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 25, priceLookupKey: 'standard_pool_monthly' },
        annual: { amountUsd: 200, priceLookupKey: 'standard_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'ladder',
    },
    {
      key: 'pro',
      name: 'Pro',
      allotment: { credits: 15000, cadence: 'monthly' },
      recommended: true, // the anchor tier; pro_pool_annual is Stripe's default Price
      prices: {
        monthly: { amountUsd: 75, priceLookupKey: 'pro_pool_monthly' },
        annual: { amountUsd: 600, priceLookupKey: 'pro_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'ladder',
    },
    {
      key: 'max',
      name: 'Max',
      allotment: { credits: 30000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 150, priceLookupKey: 'max_pool_monthly' },
        annual: { amountUsd: 1200, priceLookupKey: 'max_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'ladder',
    },
    // Max ×2 — a plan of its own (MOTIR-8390): twice Max's pool at twice its price,
    // on both cadences. The lookup keys are the ones the Stripe card (MOTIR-8395)
    // created. Bought at quantity 1 like every AI plan; there is no multiplier.
    {
      key: 'max_x2',
      name: 'Max ×2',
      allotment: { credits: 60000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 300, priceLookupKey: 'max_x2_pool_monthly' },
        annual: { amountUsd: 2400, priceLookupKey: 'max_x2_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'ladder',
    },
    // The larger pools above Max ×2 (MOTIR-8990), the rung table the approved record
    // MOTIR-8987 fixes: six pools strictly above the ladder's top. Monthly is Max ×2's
    // $300 plus $4.50 per 1,000 credits above 60,000 (10% off the top-up); annual is
    // the ladder's own annual rate, pool ÷ 1,000 × $40 — so annual is NOT 8 × monthly
    // here. `includedTrackerSeats` must equal `INCLUDED_TRACKER_SEATS_PER_AI_PLAN`,
    // which is declared after this literal and so cannot be read inside it.
    {
      key: 'pool_80k',
      name: 'Pool 80,000',
      allotment: { credits: 80000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 390, priceLookupKey: 'pool_80k_pool_monthly' },
        annual: { amountUsd: 3200, priceLookupKey: 'pool_80k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    {
      key: 'pool_100k',
      name: 'Pool 100,000',
      allotment: { credits: 100000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 480, priceLookupKey: 'pool_100k_pool_monthly' },
        annual: { amountUsd: 4000, priceLookupKey: 'pool_100k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    {
      key: 'pool_120k',
      name: 'Pool 120,000',
      allotment: { credits: 120000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 570, priceLookupKey: 'pool_120k_pool_monthly' },
        annual: { amountUsd: 4800, priceLookupKey: 'pool_120k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    {
      key: 'pool_150k',
      name: 'Pool 150,000',
      allotment: { credits: 150000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 705, priceLookupKey: 'pool_150k_pool_monthly' },
        annual: { amountUsd: 6000, priceLookupKey: 'pool_150k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    {
      key: 'pool_200k',
      name: 'Pool 200,000',
      allotment: { credits: 200000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 930, priceLookupKey: 'pool_200k_pool_monthly' },
        annual: { amountUsd: 8000, priceLookupKey: 'pool_200k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    {
      key: 'pool_250k',
      name: 'Pool 250,000',
      allotment: { credits: 250000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 1155, priceLookupKey: 'pool_250k_pool_monthly' },
        annual: { amountUsd: 10000, priceLookupKey: 'pool_250k_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'larger_pool',
    },
    // Host (MOTIR-9364): a regular plan of 300,000 credits a month, priced at the
    // ladder's own per-credit basis — pool ÷ 1,000 × $5 a month, × $40 a year — not
    // the rungs' 10%-off monthly rule. Its own band keeps it out of the ladder ceiling
    // (still Max ×2's 60,000), the rung table and the calculator.
    {
      key: 'host',
      name: 'Host',
      allotment: { credits: 300000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 1500, priceLookupKey: 'host_pool_monthly' },
        annual: { amountUsd: 12000, priceLookupKey: 'host_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'host',
    },
  ],
  seatPlan: {
    name: 'Motir',
    prices: {
      monthly: { amountUsd: 5, priceLookupKey: 'tracker_monthly' },
      annual: { amountUsd: 40, priceLookupKey: 'tracker_annual' },
    },
  },
  creditTopup: {
    unitCredits: 1000,
    unitAmountUsd: 5,
    priceLookupKey: 'credit_topup',
    bundleUnits: [1, 5, 10],
  },
};

/** The standing ladder (`band: 'ladder'`) — Free through Max ×2. */
function ladderPlans(): AiPlanCatalogEntry[] {
  return BILLING_CATALOG.aiPlans.filter((p) => p.band === 'ladder');
}

/** The Host band (`band: 'host'`) — sold from the plan row, outside the ladder ceiling. */
function hostPlans(): AiPlanCatalogEntry[] {
  return BILLING_CATALOG.aiPlans.filter(
    (p) => p.band === 'host' && p.prices !== null && p.allotment?.cadence === 'monthly',
  );
}

/**
 * Tracker seats included with any live AI plan — read this, never type a 1. Derived
 * over the LADDER band only: it states what every standing rung bundles, so a change
 * to a larger pool's data must not silently move it.
 */
export const INCLUDED_TRACKER_SEATS_PER_AI_PLAN: number = Math.max(
  ...ladderPlans()
    .filter((p) => p.prices !== null)
    .map((p) => p.includedTrackerSeats),
);

/**
 * The top of the LADDER band (60,000, Max ×2 today) — the ceiling every "is this
 * estimate past the ladder" question measures against. Computed from the entries so
 * it moves with the ladder, and never the largest pool on sale: a larger pool is
 * above it by construction (MOTIR-8990).
 */
export function maxMonthlyPlanCredits(): number {
  return Math.max(
    ...ladderPlans().flatMap((p) =>
      p.allotment?.cadence === 'monthly' ? [p.allotment.credits] : [],
    ),
  );
}

/**
 * The larger-pool rung table (MOTIR-8990): every `larger_pool` entry with a monthly
 * allotment strictly above `maxMonthlyPlanCredits()`, ascending by pool. A FRESH array
 * per call; it mutates nothing. A hoisted declaration on purpose — the allow-lists
 * below call it while the module initialises.
 */
export function largerPoolPlans(): AiPlanCatalogEntry[] {
  const ceiling = maxMonthlyPlanCredits();
  return BILLING_CATALOG.aiPlans
    .filter(
      (p) =>
        p.band === 'larger_pool' &&
        p.prices !== null &&
        p.allotment?.cadence === 'monthly' &&
        p.allotment.credits > ceiling,
    )
    .sort((a, b) => (a.allotment?.credits ?? 0) - (b.allotment?.credits ?? 0));
}

/** True when `priceLookupKey` is one of the rung keys this catalog sells. */
export function isLargerPoolPlanKey(priceLookupKey: string): boolean {
  return largerPoolPlans().some(
    (p) =>
      p.prices?.monthly.priceLookupKey === priceLookupKey ||
      p.prices?.annual.priceLookupKey === priceLookupKey,
  );
}

// A rung-shaped lookup key: `pool_<N>k_pool_<cadence>`, anchored at both ends.
const LARGER_POOL_KEY = /^pool_(\d+)k_pool_(monthly|annual)$/;

/**
 * How big a pool a rung-shaped lookup key NAMES, in credits a month — or `null` for
 * any other key. It says nothing about whether the catalog sells that pool; the
 * checkout path uses it to tell a request for a pool at or below the ladder's top
 * from a price that simply is not on sale.
 */
export function largerPoolCreditsForPrice(priceLookupKey: string): number | null {
  const match = LARGER_POOL_KEY.exec(priceLookupKey);
  return match ? Number(match[1]) * 1000 : null;
}

// Every lookup key a Checkout may legitimately start — the allow-list
// `startCheckout` validates against, so the boundary never forwards an arbitrary
// (or stale) price the UI didn't get from this catalog. The ladder's keys, the
// floored rung table's (so a rung at or below the ladder's top is never admitted)
// and Host's.
export const CHECKOUT_PRICE_LOOKUP_KEYS: ReadonlySet<string> = new Set<string>([
  ...[...ladderPlans(), ...largerPoolPlans(), ...hostPlans()].flatMap((p) =>
    p.prices ? [p.prices.monthly.priceLookupKey, p.prices.annual.priceLookupKey] : [],
  ),
  BILLING_CATALOG.seatPlan.prices.monthly.priceLookupKey,
  BILLING_CATALOG.seatPlan.prices.annual.priceLookupKey,
  BILLING_CATALOG.creditTopup.priceLookupKey,
]);

/** True when `key` is a price the catalog offers (the checkout allow-list). */
export function isKnownCheckoutPrice(key: string): boolean {
  return CHECKOUT_PRICE_LOOKUP_KEYS.has(key);
}

/** The unit count a Checkout defaults to when the caller names none. */
export const DEFAULT_CHECKOUT_QUANTITY = 1;

/**
 * True when `quantity` is a legitimate unit count for `key` — the quantity half
 * of the allow-list above (MOTIR-2949).
 *
 * Only the credit TOP-UP is a multi-unit line, and only at the bundle sizes the
 * storefront actually offers. Every recurring AI plan — Max ×2 included — is
 * exactly one unit: the AI pool is priced per org, and nothing here limits how
 * many plans an org holds (motir-ai routes a second plan checkout to the upgrade
 * path). The tracker seat's per-user quantity is carried by the seat flow
 * (`setSeatQuantity`), not by this guard: the scaled tracker's seat count is owned by the
 * `system.billing-seat-sync` job (`billingService.syncScaledTrackerSeats`), which
 * resets a subscription's quantity to the membership count. A one-time payment
 * has NO such reconciler — the Session IS the charge — so a client-supplied
 * multiplier on a recurring price is refused here rather than merely corrected
 * later.
 */
export function isAllowedCheckoutQuantity(key: string, quantity: number): boolean {
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (quantity === DEFAULT_CHECKOUT_QUANTITY) return true;
  const topup = BILLING_CATALOG.creditTopup;
  return key === topup.priceLookupKey && topup.bundleUnits.includes(quantity);
}

/**
 * The plan-change keys of `entries`: every paid plan with a monthly allotment,
 * ascending by that allotment. Sorted rather than concatenated, so the order holds
 * however the bands sit relative to each other (the larger pools move above Host
 * later, MOTIR-9366). A FRESH array; it mutates nothing.
 */
export function planChangeKeysOf(entries: readonly AiPlanCatalogEntry[]): string[] {
  return entries
    .flatMap((p) =>
      p.prices && p.allotment?.cadence === 'monthly'
        ? [{ key: p.key, credits: p.allotment.credits }]
        : [],
    )
    .sort((a, b) => a.credits - b.credits)
    .map((p) => p.key);
}

/**
 * The AI plans a change of plan may move between (MOTIR-8399): every paid,
 * recurring plan — the ladder, the rung table and Host — never Free, which is a
 * one-time trial and never a downgrade target. Ascending by monthly pool. motir-ai
 * holds the same list (`CHANGEABLE_PLAN_KEYS`); this one lets the service refuse a
 * stale or tampered key before the boundary.
 */
export const PLAN_CHANGE_KEYS: readonly string[] = planChangeKeysOf([
  ...ladderPlans(),
  ...largerPoolPlans(),
  ...hostPlans(),
]);

/** True when `key` names a plan a change of plan may target. */
export function isPlanChangeKey(key: string): boolean {
  return PLAN_CHANGE_KEYS.includes(key);
}
