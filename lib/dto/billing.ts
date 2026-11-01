import { z } from 'zod';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import type { BillingCadence, BillingCatalog } from '@/lib/billing/catalog';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import type { SearchSpendDTO } from '@/lib/dto/aiUsage';

// DTOs for the billing surfaces (Story 8.1). Defines EXACTLY what crosses the
// HTTP boundary — no Prisma model leaks. The inbound propagation route returns
// the confirmation DTO so motir-ai's coreClient (8.1.4d) can read back the
// persisted state; the org-facing billing status DTO feeds the 8.1.7 settings
// panel + storefront.

export interface ScaledTrackerStateDTO {
  organizationId: string;
  /** The persisted state, or `null` when no scaled-tracker subscription is set. */
  scaledTrackerSubscription: ScaledTrackerSubscription | null;
}

/** Confirmation of the AI-included-seat propagation (8.1.24 receiver). */
export interface AiIncludedSeatDTO {
  organizationId: string;
  aiIncludedSeat: boolean;
}

// ── The org-facing billing status (Story 8.1.6 → renders in 8.1.7) ──────────

/** What the actor may DO with billing (ADR §7: view = owner/admin, mutate = owner). */
export interface BillingAccessDTO {
  /** The actor's org role. */
  role: 'owner' | 'admin' | 'member';
  /** True only for an org OWNER — may start checkout / open portal / change plan. */
  canManageBilling: boolean;
}

/**
 * The Motir AI Stripe SUBSCRIPTION lifecycle (Subtask 8.1.13) — what the design's
 * panel 2 status `Pill` + panel 5 "renews {date}" render. Folded from motir-ai's
 * `GET /v1/stripe/subscription`. EVERY field is nullable: a free / never-transacted
 * org has `status: null` (no AI subscription yet), NOT an error.
 */
export interface MotirAiSubscriptionDTO {
  /** The Stripe subscription lifecycle (decision §5), or `null` = no subscription. */
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | null;
  /** ISO-8601 renewal date ("renews {date}"), or `null` before a period is known. */
  currentPeriodEnd: string | null;
  /** The subscribed Stripe Price, or `null`. */
  priceId: string | null;
  /** The tier the subscription resolves to, or `null` until the webhook binds one. */
  planTier: { key: string; name: string; monthlyCreditAllotment: number } | null;
}

/**
 * ② The Motir AI line — the org's AI plan over the boundary: the `PlanTier` +
 * balance folded from the `/v1/usage` read, plus the Stripe `subscription`
 * lifecycle (status `Pill` + renewal date, design panels 2/5) folded from the
 * 8.1.13 `/v1/stripe/subscription` read.
 */
export interface MotirAiBillingDTO {
  /** The active AI tier, or `null` before any ledger is provisioned. */
  tier: { key: string; name: string; monthlyCreditAllotment: number } | null;
  /** The current credit balance (allotment remainder + any top-up). */
  balance: number;
  /** The Stripe AI-subscription lifecycle (status + renewal); `status: null` = none. */
  subscription: MotirAiSubscriptionDTO;
  /**
   * The downgrade the live plan has scheduled for its period end (MOTIR-8399), or
   * `null` — none scheduled, no live paid plan, or the read did not answer (the
   * cards then show no pending state; the dialogs' previews still report it).
   */
  pendingDowngrade: PendingPlanChangeDTO | null;
}

/**
 * The org's billing status — the two billed lines + the catalog + access, cloud
 * only. The Motir (seat) line is the LOCAL scaled-tracker subscription (full
 * status + period end, read from the Organization); the Motir AI line is the
 * tier/balance from the usage read; `catalog` is the storefront's price list.
 */
export interface BillingStatusDTO {
  organizationId: string;
  access: BillingAccessDTO;
  /** The META org (moooon B.V.) — internal, never billed, every cap lifted.
   *
   *  ⚠️ WHAT IT DRIVES, as of MOTIR-4818: the EXEMPT variant of each of panel 2's
   *  two lines — the `.pill-exempt` chip and its banner in place of the tier
   *  chip, the caps block, the seat calculator and both checkout CTAs. It does
   *  NOT suppress the page: an org with `isMeta: false` — paying, free, OR
   *  `internalBilling` — renders the storefront unchanged
   *  (`design/billing/design-notes.md` § AMENDMENT 2026-09-07).
   *
   *  It used to say the page renders an "Internal plan" state INSTEAD of the
   *  storefront. That early return was deleted by MOTIR-4572 and the sentence
   *  outlived it — which is how a reader arrives at the wrong fix. */
  isMeta: boolean;
  /** Whether the org is charged exactly like a CUSTOMER and then made whole —
   *  every debit lands and is paired, in the same transaction, with an
   *  offsetting credit (`Organization.internalBilling`, MOTIR-4565;
   *  `docs/decisions/internal-billing-classification.md` §2).
   *
   *  ⚠️ IT CHANGES NO FIGURE ON THIS DTO, and that is the whole point. Every
   *  line, every state and every number above and below is computed exactly as
   *  it is for a paying org — this field says only WHICH KIND of org the reader
   *  is looking at, so the surface can draw a chip. It is a second field beside
   *  `isMeta` rather than a widening of it because the two mean opposite things:
   *  that one suppresses, this one charges and credits. */
  internalBilling: boolean;
  /** ① Motir (seats): the scaled-tracker subscription, or `null` = free/unscaled. */
  motir: {
    scaledTrackerSubscription: ScaledTrackerSubscription | null;
    /** True when a PAID Motir AI plan bundles 1 Motir seat → caps lifted, first
     *  seat included (8.1.22). The SeatsView surfaces the included seat from this. */
    aiIncludedSeat: boolean;
  };
  /** ② Motir AI: the credit plan tier + balance. */
  motirAi: MotirAiBillingDTO;
  /**
   * ③ Motir CI (MOTIR-1903, ADR `ci-minutes-allowance.md` §7.1): the CI-minutes
   * entitlement — used vs included this period, how the pool was derived, the
   * reset date, and the credits the overage drew, DISTINCT from AI's spend.
   *
   * NOT nullable, and deliberately so. `ciAllowanceService.getEntitlementState`
   * already models "no CI here" as a real value (`applicable: false`,
   * `state: 'bypassed'` — off-cloud, no provisioning org, or the META org), so
   * the panel switches on a field that is always present. An optional field
   * would invite the always-null wiring that renders nothing while every test
   * stays green.
   */
  ci: CiEntitlementStateDTO;
  /**
   * ④ Motir Search (MOTIR-4334, `motir-gateway` `docs/decisions/motir-search-channel.md`
   * §4.4 · motir-ai `docs/credit-model.md` §4b): the FOURTH billed line — what the
   * org has spent on web search, DISTINCT from AI's spend and from CI's.
   *
   * It comes off the `getOrgUsage` call this service ALREADY makes, so there is no
   * second request; `usage.balance` and `usage.tier` above come from the same read.
   *
   * ⚠️ NULLABLE, and for the OPPOSITE reason `ci` is not. `ci` is not nullable
   * because `ciAllowanceState` models "no CI here" as a real value. Search has no
   * such state to model — §5 of the ADR decides an out-of-credit org goes into
   * overdraft and search refuses nothing, so there is no paused, bypassed or
   * not-applicable arm to carry. What CAN happen is the boundary not reporting the
   * block at all (a rolling deploy), and `null` is exactly that: FIGURES
   * UNAVAILABLE, never zero spend. The panel must render the two differently.
   */
  search: SearchSpendDTO | null;
  /**
   * The Agents line (MOTIR-6920, `docs/decisions/agent-instance-storage.md` §6,
   * `design/billing/design-notes.md` "Delta 2026-09-29"): this month's machine
   * and storage credits for the org's agents, off the same `getOrgUsage` read.
   */
  agents: AgentsBillingDTO;
  /** The purchasable prices the storefront renders + checkout routes through. */
  catalog: BillingCatalog;
}

/** This month's agent credits, by kind. */
export interface AgentSpendDTO {
  machineMonthSpend: number;
  storageMonthSpend: number;
}

export interface AgentsBillingDTO {
  /**
   * `null` = FIGURES UNAVAILABLE (the boundary did not report `agentMachine` /
   * `agentStorage`), never zero spend — the `search` rule, applied here.
   */
  spend: AgentSpendDTO | null;
  /**
   * Whether the org may run agents at all: a paid AI plan (`active` /
   * `past_due`), or a meta / internal-billing org, which §5 of the record lets
   * through the agent limits. False draws the "Agents need a paid AI plan" note.
   */
  hasPaidAiPlan: boolean;
}

/** A started Stripe session — the hosted URL the client redirects to. */
export interface BillingSessionDTO {
  url: string;
}

/**
 * What starting a checkout answers (MOTIR-8394): a hosted session URL, or — when the
 * org already holds a live AI plan — that plan's lookup key, because an org holds
 * ONE AI plan and a change of plan goes through the upgrade path. Both are 200s.
 */
export type BillingCheckoutDTO = { url: string } | { existingPlan: { livePriceLookupKey: string } };

// ── Changing the AI plan mid-period (Story MOTIR-8387 · MOTIR-8399) ─────────
//
// Every figure the plan-change dialogs show is one of these fields — motir-ai's
// previews and confirms passed through — so no amount, date or count is composed
// in the browser. Amounts are integer cents of `currency`; dates are ISO-8601.

/** A lower plan scheduled for the period end. */
export interface PendingPlanChangeDTO {
  planKey: string;
  effectiveDate: string;
}

/** A cadence change a plan change would make — never one today (the cadence is kept). */
export type PlanChangeCadenceChangeDTO = { from: BillingCadence; to: BillingCadence } | null;

/** What an upgrade costs now and grants (`POST …/billing/upgrade/preview`). */
export interface UpgradePreviewDTO {
  /** Unix seconds — sent back unchanged with the confirm. */
  prorationDate: number;
  fromPlan: string;
  toPlan: string;
  cadence: BillingCadence;
  cadenceChange: PlanChangeCadenceChangeDTO;
  amountDueCents: number;
  currency: string;
  periodEnd: string;
  /** Whole days left in the billing period, which the amount covers. */
  billingDaysLeft: number;
  /** Whole days left in the monthly credit window, which the extra credits cover. */
  daysLeft: number;
  creditWindowEnd: string;
  extraCredits: number;
  extraIndexAllowance: number | null;
  fromPool: number;
  fullPool: number;
  fullAllowance: number | null;
  toPriceCents: number;
  pendingDowngrade: PendingPlanChangeDTO | null;
}

/** What an upgrade did (`POST …/billing/upgrade`). */
export interface UpgradeResultDTO {
  status: 'upgraded';
  fromPlan: string;
  toPlan: string;
  extraCredits: number;
  extraIndexAllowance: number | null;
  /** The downgrade the upgrade cancelled, or `null`. */
  clearedPending: PendingPlanChangeDTO | null;
}

/** What a downgrade at the period end would do (`POST …/billing/downgrade/preview`). */
export interface DowngradePreviewDTO {
  fromPlan: string;
  toPlan: string;
  cadence: BillingCadence;
  cadenceChange: PlanChangeCadenceChangeDTO;
  effectiveDate: string;
  fromPool: number;
  fullPool: number;
  fullAllowance: number | null;
  toPriceCents: number;
  currency: string;
  pendingDowngrade: PendingPlanChangeDTO | null;
}

/** What scheduling a downgrade did (`POST …/billing/downgrade`). */
export type DowngradeResultDTO =
  | {
      status: 'scheduled';
      fromPlan: string;
      toPlan: string;
      effectiveDate: string;
      replacedPending: PendingPlanChangeDTO | null;
    }
  | { status: 'cleared'; fromPlan: string; toPlan: string; clearedPending: PendingPlanChangeDTO };

/**
 * The members-page SEAT summary (Story 8.1.14, design/org-admin
 * members-billing) — the in-context seat/billing layer the org Members admin
 * renders for a SCALED org. `null` (the service returns it, not this shape)
 * means NO seat UI: a self-host build (`MOTIR_CLOUD` off), a free org (no
 * scaled-tracker subscription), or a canceled one — the members page is
 * UNCHANGED. This card RENDERS the seat state; it never writes Stripe (8.1.12
 * owns the seat-quantity sync). The seat COUNT is the org membership count, read
 * client-side from the roster total (the same source 8.1.12 syncs to Stripe), so
 * it tracks add/remove live; this DTO carries only the pricing + lifecycle the
 * count is priced against.
 */
export interface SeatSummaryDTO {
  /** Scaled-tracker lifecycle — only `active` / `past_due` reach the UI (a
   *  `canceled`/absent subscription resolves to `null`, the unchanged page). */
  status: 'active' | 'past_due';
  /** Billing cadence, derived from the subscription's `tracker_*` price id. */
  cadence: 'monthly' | 'annual';
  /** Per-seat fee for the active cadence (whole USD), from `BILLING_CATALOG`. */
  perSeatUsd: number;
  /** The monthly per-seat fee — feeds the "annual saves $X/yr" figure. */
  monthlyPerSeatUsd: number;
  /** The annual per-seat fee. */
  annualPerSeatUsd: number;
  /** Stripe `current_period_end` (unix epoch SECONDS) — the renewal the
   *  prorated add-charge / remove-credit copy targets. */
  currentPeriodEnd: number;
  /** True only for an org OWNER — may manage the seat plan (ADR §7). An admin
   *  manages membership but sees the seat band READ-ONLY (no manage CTA). */
  canManageBilling: boolean;
}

// ── The Calculator (Story MOTIR-8381 · MOTIR-8637) ───────────────────────────
//
// The engine's public calculator (motir-ai `src/services/calculatorService.ts`,
// MOTIR-8627) answered through motir-core's own door. Every figure below is the
// engine's: motir-core composes no pool, price, plan name or model name, and the
// route answers these bodies unaltered. ONE declaration, read by the client's
// return types, the service and the HTTP boundary.

/** The bounds the engine's request parser enforces (`src/calculatorRequest.ts`). */
export const CALCULATOR_REQUEST_LIMITS = {
  maxItemsPerMonth: 1_000_000,
  maxCategories: 3,
  /** The whole a request's `shares` must total — each share is a whole percentage. */
  sharesTotal: 100,
} as const;

export const CALCULATOR_CADENCES = ['annual', 'monthly'] as const;
export type CalculatorCadence = (typeof CALCULATOR_CADENCES)[number];

export type CalculatorLane = 'planning' | 'running';

/**
 * Where the high end lands (motir-ai docs/contract.md): inside the ladder, on a larger
 * pool that covers it, on the LARGEST larger pool with top-ups for the rest
 * (`largest_pool`, MOTIR-8988 approved 2026-10-22), or on top-ups alone when the
 * cadence offers no larger pool.
 */
export type CalculatorCeilingOutcome =
  | 'within_ladder'
  | 'larger_pool'
  | 'largest_pool'
  | 'top_ups_only';

const calculatorCount = z.number().int().min(0).max(CALCULATOR_REQUEST_LIMITS.maxItemsPerMonth);

const calculatorCategoriesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .max(CALCULATOR_REQUEST_LIMITS.maxCategories)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'categories must be unique' });

/**
 * The estimate request — STRICT, as the engine's parser is: an unknown key (a
 * `quantity`, a `seats`, an organization id) is refused by name rather than
 * forwarded or dropped. `cadence` defaults to the engine's own default.
 */
const calculatorRange = (name: string) =>
  z
    .object({ low: calculatorCount, high: calculatorCount })
    .strict()
    .refine((r) => r.low <= r.high, {
      message: `${name}.low must not exceed ${name}.high`,
      path: ['low'],
    });

/** One category's share of the run: a whole percentage (MOTIR-9832). */
const calculatorShare = z
  .number()
  .int({ message: 'must be a whole number' })
  .min(1, { message: 'must be between 1 and 100' })
  .max(CALCULATOR_REQUEST_LIMITS.sharesTotal, { message: 'must be between 1 and 100' });

/**
 * Items are counted per lane (MOTIR-9224): items PLANNED in Motir a month and items
 * RUN on Motir's runner a month. Either range may be 0–0, never both; the old single
 * `itemsPerMonth` is refused by name as an unknown key.
 *
 * `shares` (MOTIR-9832) weights the picked categories in the run, keyed by exactly the
 * `categories` keys and totalling 100 — the same rules the engine's parser holds
 * (motir-ai `src/calculatorRequest.ts`), so a bad one is refused here naming the field
 * rather than proxied. Absent, the engine splits the run evenly.
 */
export const calculatorEstimateRequestSchema = z
  .object({
    plannedPerMonth: calculatorRange('plannedPerMonth'),
    runPerMonth: calculatorRange('runPerMonth'),
    categories: calculatorCategoriesSchema,
    shares: z.record(z.string(), calculatorShare).optional(),
    cadence: z.enum(CALCULATOR_CADENCES).default('annual'),
  })
  .strict()
  .refine((r) => r.plannedPerMonth.high > 0 || r.runPerMonth.high > 0, {
    message: 'plannedPerMonth and runPerMonth must not both be 0',
    path: ['plannedPerMonth'],
  })
  .superRefine((r, ctx) => {
    if (!r.shares) return;
    const shares = r.shares;
    const stray = Object.keys(shares).find((key) => !r.categories.includes(key));
    if (stray !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'names no picked category; shares are keyed by categories',
        path: ['shares', stray],
      });
      return;
    }
    const missing = r.categories.find((key) => !Object.hasOwn(shares, key));
    if (missing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'is required',
        path: ['shares', missing],
      });
      return;
    }
    const total = Object.values(shares).reduce((sum, share) => sum + share, 0);
    if (total !== CALCULATOR_REQUEST_LIMITS.sharesTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must total ${CALCULATOR_REQUEST_LIMITS.sharesTotal}, not ${total}`,
        path: ['shares'],
      });
    }
  });

/** What the browser may send (cadence optional). */
export type CalculatorEstimateRequestInput = z.input<typeof calculatorEstimateRequestSchema>;
/** What motir-core forwards to the engine — exactly these keys (`shares` only when sent). */
export type CalculatorEstimateRequestDTO = z.output<typeof calculatorEstimateRequestSchema>;

/** The categories the pickers offer — a band with an EMPTY `models` is listed on purpose. */
export interface CalculatorCategoriesDTO {
  version: number;
  categoryRuleVersion: string;
  modelsReadAt: string;
  cadences: CalculatorCadence[];
  defaultCadence: CalculatorCadence;
  categories: { key: string; models: { id: string; provider: string }[] }[];
}

/** A top-up in whole purchase units, at the catalog rate. */
export interface CalculatorTopUpAmountDTO {
  units: number;
  credits: number;
  priceUsd: number;
}

/**
 * What the estimate was computed over: the picked categories and the share each
 * carries (equal across them), with the models each serves as EXAMPLES — never an
 * input. The surface prints the split from this, with no share arithmetic of its own.
 */
export interface CalculatorSplitDTO {
  count: number;
  categories: { key: string; weight: number; models: string[] }[];
}

export interface CalculatorEstimateDTO {
  version: number;
  kind: 'estimate';
  profilesVersion: string;
  categoryRuleVersion: string;
  cadence: CalculatorCadence;
  /** The two ranges the engine priced, echoed so the answer states what it priced. */
  plannedPerMonth: { low: number; high: number };
  runPerMonth: { low: number; high: number };
  credits: { low: number; high: number };
  perItemCredits: Record<CalculatorLane, number>;
  split: CalculatorSplitDTO;
  recommendation: {
    planKey: string | null;
    planName: string | null;
    monthlyPriceUsd: number;
    /**
     * The recommended plan's own monthly credit pool, `0` for top-up alone
     * (motir-ai MOTIR-9189). Optional until every motir-ai this core talks to
     * sends it: an older engine's answer has no such field (MOTIR-9262).
     */
    poolCredits?: number;
  };
  topUp: { low: CalculatorTopUpAmountDTO; high: CalculatorTopUpAmountDTO };
  /** The largest REGULAR pool on this cadence; `credits` null when none is offered. */
  ceiling: {
    credits: number | null;
    exceeded: boolean;
    excessCredits: number;
    outcome: CalculatorCeilingOutcome;
  };
}

/** Picked categories with no live model — the engine gives no number. */
export interface CalculatorEmptyCategoryDTO {
  version: number;
  kind: 'empty_category';
  categoryRuleVersion: string;
  categories: string[];
}

export type CalculatorAnswerDTO = CalculatorEstimateDTO | CalculatorEmptyCategoryDTO;
