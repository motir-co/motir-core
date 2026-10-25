'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Coins,
  CreditCard,
  Crown,
  ExternalLink,
  Info,
  Layers,
  Lock,
  Pause,
  Search,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { AiPlanCatalogEntry, BillingCadence } from '@/lib/billing/catalog';
import { ciLineFigures, type CiLineVariant } from './ciFigures';
import { searchLineFigures } from './searchFigures';
import { agentLineFigures } from './agentFigures';
import { fmt, fmtDate } from './billingFormat';
import { DowngradeDialog, UpgradeDialog, type PlanNames } from './PlanChangeDialog';
import { CalculatorView } from './CalculatorView';

// The §4 free-tier scale caps the Motir (free) line draws — mirrors
// `lib/billing/entitlements.ts` PM_ENTITLEMENTS.free (the locked ADR §4 numbers).
// The DTO carries the org's PLAN, not its live usage counts (those live in the
// sibling Usage & cost dashboard), so the line shows the CAP ceiling, not a
// used/limit ratio — honest to the contract, not a faked meter.
const FREE_CAPS = { workItems: 250, projects: 3, storageGb: 2 } as const;

// THE EXEMPT PREDICATE — one flag, read once (MOTIR-4818; design/billing
// AMENDMENT 2026-09-07). An org that is never charged and never capped cannot
// be shown the paying-customer storefront: its price, its caps and its two
// checkouts are not figures it will not be charged, they are figures that are
// FALSE. This mirrors the policy the server already enforces in two places:
//
//   • `lib/billing/entitlements.ts` `pmTierForOrg` — *"the META org (moooon
//     B.V., `isMeta`) short-circuits to the internal `meta` tier — EVERY CAP
//     LIFTED — regardless of subscription"*, the single chokepoint
//     `entitlementsService` resolves every §4 cap gate through;
//   • `lib/services/billingService.ts:252` — `if (org?.isMeta) return
//     notApplicableAiAccess();`, which switches the AI paywall off outright.
//
// ⚠️ It keys on `isMeta` and NEVER on `internalBilling`, which means the
// OPPOSITE thing: such an org IS charged (every debit lands, then a paired
// `internal_offset` credit makes it whole, MOTIR-4570) and IS capped, so every
// line of the storefront is a true statement about it and MOTIR-4572 was right
// to stop hiding them. Widening this to the classification flag would hide a
// real price from an org that really owes it — the more expensive direction.
function isBillingExempt(data: BillingStatusDTO): boolean {
  return data.isMeta;
}

// The exempt status chip — panel 3 (d)/(e)'s `.pill-exempt`.
// ⚠️ `--el-tint-peach`, deliberately NOT `--el-tint-sky`: sky is `.pill-trial`
// on this same surface, and "exempt" reading as "on the free trial" is the
// exact confusion this state exists to end.
function ExemptPill({ t }: { t: T }) {
  return (
    <Pill className="border-transparent bg-(--el-tint-peach) text-(--el-text-strong)">
      {t('exempt.pill')}
    </Pill>
  );
}

// The exempt body — `.banner.banner-info`, reused verbatim from the mock.
// Informational, never a warning: nothing here is wrong.
function ExemptBanner({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
      <Info className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--el-info)' }} aria-hidden />
      <p className="font-sans text-sm text-(--el-text-strong)">{text}</p>
    </div>
  );
}

export interface BillingClientProps {
  orgId: string;
  orgName: string;
  /** The org's member count (resolved server-side) — the seat count for the
   *  seat preview + the panel-6 seat calc (one seat per member, ADR §3). */
  memberCount: number;
}

type View = 'home' | 'plans' | 'seats' | 'calculator';
type LoadState = 'loading' | 'idle' | 'error' | 'forbidden';

// The billing settings surface (Story 8.1.7 · design/billing panels 1–6, 8). A
// client island: it fetches the org's plan from /api/organizations/[orgId]/billing
// over the 8.1.6 boundary (so the loading skeleton + the error/retry state are
// genuine, never a misleading zero), then renders the two billed lines, the
// lifecycle states, the role gate, and the AI-plan / seat-plan screens. Stripe
// Checkout / Portal sessions are started over the same boundary and the browser
// redirects to the returned hosted URL. The PAYWALL (panel 7) is the sibling
// 8.1.8; this card never renders it.
export function BillingClient({ orgId, orgName, memberCount }: BillingClientProps) {
  const t = useTranslations('billing');
  const { toast } = useToast();
  const [data, setData] = useState<BillingStatusDTO | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [view, setView] = useState<View>('home');
  // ONE billing period for the page (MOTIR-8639): the plans view and the Calculator
  // read and write this, so the two can never show different cadences.
  const [cadence, setCadence] = useState<BillingCadence>('annual');
  // The plan the Calculator's next step distinguishes on arrival — a marker for that
  // arrival only, apart from the catalog's own `recommended` flag.
  const [markedPlan, setMarkedPlan] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  // The post-Checkout return banner (the webhook is the source of truth, so the
  // tier may still be settling — show a pending note until the refetch confirms).
  const [returnBanner, setReturnBanner] = useState<'success' | 'cancel' | null>(null);
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mySeq = ++seq.current;
    setState('loading');
    try {
      const res = await fetch(`/api/organizations/${orgId}/billing`);
      if (mySeq !== seq.current) return;
      if (res.status === 403) {
        setState('forbidden');
        return;
      }
      if (!res.ok) {
        setState('error');
        return;
      }
      const body = (await res.json()) as BillingStatusDTO;
      if (mySeq !== seq.current) return;
      setData(body);
      setState('idle');
    } catch {
      if (mySeq === seq.current) setState('error');
    }
  }, [orgId]);

  useEffect(() => {
    // Read the Stripe return marker (?checkout=success|cancel) the billingService
    // redirect appends, show the matching banner, then strip it so a reload is clean.
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');
    if (checkout === 'success' || checkout === 'cancel') {
      // A one-time read of the Stripe return marker from the URL (an external
      // system) — the sanctioned set-state-in-effect case, not a render cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReturnBanner(checkout);
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState(null, '', url.toString());
    }
    // Initial fetch on mount — an external-system sync (the billing API). The
    // synchronous setState lives inside load(), not this effect body.
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start a Stripe session over the boundary, then redirect the browser to the
  // hosted URL. A failure surfaces a toast (the session/credits are untouched),
  // unless `onRefused` reads the failed body and handles it — the Calculator's pool
  // offer shows its refusal as a notice beside the offer instead (MOTIR-8997).
  const startSession = useCallback(
    async (
      path: 'checkout' | 'portal',
      body?: Record<string, string | number>,
      onRefused?: (payload: unknown) => boolean,
    ) => {
      setRedirecting(true);
      try {
        const res = await fetch(`/api/organizations/${orgId}/billing/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
        if (!res.ok) {
          setRedirecting(false);
          const payload: unknown = await res.json().catch(() => null);
          if (onRefused?.(payload)) return;
          toast({ variant: 'error', title: t('states.errorTitle') });
          return;
        }
        const answer = (await res.json()) as { url?: string };
        if (answer.url) {
          window.location.href = answer.url;
          return;
        }
        // The org already holds a live AI plan (MOTIR-8394): nothing was opened.
        // Re-read the status so the cards show that plan as current and offer no
        // checkout — a change of plan goes through the upgrade path.
        setRedirecting(false);
        await load();
      } catch {
        setRedirecting(false);
        toast({ variant: 'error', title: t('states.errorTitle') });
      }
    },
    [orgId, t, toast, load],
  );

  // `quantity` is the credit top-up's bundle multiplier and is omitted for every
  // other line — the subscription CTAs buy exactly one unit, and the service
  // refuses a multiplier on a recurring price outright (MOTIR-2949). A selector
  // whose value never reaches this call is how the button's label and the charge
  // came to be computed from two different numbers.
  const checkout = useCallback(
    (priceLookupKey: string, quantity?: number) =>
      startSession('checkout', {
        priceLookupKey,
        ...(quantity === undefined ? {} : { quantity }),
      }),
    [startSession],
  );
  const portal = useCallback(() => startSession('portal'), [startSession]);

  const live = (
    <div aria-live="polite" className="sr-only">
      {state === 'loading' ? t('states.loading') : ''}
    </div>
  );

  if (state === 'loading' && !data) {
    return (
      <div className="mx-auto w-full max-w-[64rem]">
        {live}
        <BillingSkeleton />
      </div>
    );
  }

  if (state === 'forbidden') {
    return (
      <div className="mx-auto w-full max-w-[64rem]">
        {live}
        <EmptyState
          icon={<Lock className="h-12 w-12 text-(--el-accent-on-surface)" aria-hidden />}
          title={t('member.gateTitle')}
          description={t('member.gateDescription', { org: orgName })}
          action={
            <Link
              href="/settings/organization/members"
              className={buttonVariants({ variant: 'secondary', size: 'md' })}
            >
              {t('member.contactOwner')}
            </Link>
          }
        />
      </div>
    );
  }

  if (state === 'error' || !data) {
    return (
      <div className="mx-auto w-full max-w-[64rem]">
        {live}
        <ErrorState
          title={t('states.errorTitle')}
          description={t('states.errorDescription')}
          retry={() => load()}
        />
      </div>
    );
  }

  // ⚠️ AN `if (data.isMeta)` EARLY RETURN STOOD HERE AND IS DELETED (Story
  // MOTIR-4337 · MOTIR-4572). It replaced the entire storefront — the home view,
  // the plans, the seats, all four billed lines and the CI line — with one
  // read-only card, on the single organization that uses the product every day.
  // The states most worth exercising were the states it switched off.
  //
  // An org classified `internalBilling` is charged exactly like a customer and
  // made whole by a paired ledger credit (MOTIR-4570), so every view below is
  // TRUE for it: the figures are real, the balance nets to zero, and nothing
  // here is a fiction that has to be hidden. What survives is a LABEL — a chip
  // beside the tier, rendered from `data.internalBilling` — which says what kind
  // of org this is and changes no number.

  const canManage = data.access.canManageBilling;
  const shared = {
    data,
    t,
    canManage,
    orgName,
    memberCount,
    checkout,
    portal,
    redirecting,
  } as const;

  return (
    // Every view keeps the 64rem column except the Motir AI plans view, whose five
    // cards take the full page width (design/billing § "Amendment 2026-10-23 — the
    // Host plan", point 7, MOTIR-9403).
    <div
      className={`mx-auto flex w-full flex-col gap-5 ${view === 'plans' ? '' : 'max-w-[64rem]'}`}
      aria-busy={state === 'loading'}
    >
      {live}

      {/* THE LABEL THAT REPLACED THE BRANCH (MOTIR-4572). A chip, above the
          ordinary storefront rather than instead of it: it says what kind of
          organization this is and changes no line, no state and no figure
          below. `internalBilling` — never `isMeta`, which means something else
          and is not what makes these screens honest. */}
      {data.internalBilling ? (
        <p className="flex flex-wrap items-center gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
          <Pill className="border-transparent bg-(--el-page-bg) text-(--el-text-strong)">
            {t('internalBilling.badge')}
          </Pill>
          <span>{t('internalBilling.note')}</span>
        </p>
      ) : null}

      {returnBanner ? (
        <ReturnBanner kind={returnBanner} onClose={() => setReturnBanner(null)} t={t} />
      ) : null}

      {view === 'home' ? (
        <HomeView {...shared} goPlans={() => setView('plans')} goSeats={() => setView('seats')} />
      ) : null}
      {view === 'plans' ? (
        <PlansView
          {...shared}
          orgId={orgId}
          reload={load}
          back={() => {
            setMarkedPlan(null);
            setView('home');
          }}
          cadence={cadence}
          setCadence={setCadence}
          markedPlan={markedPlan}
          openCalculator={() => {
            setMarkedPlan(null);
            setView('calculator');
          }}
        />
      ) : null}
      {view === 'calculator' ? (
        <CalculatorView
          orgId={orgId}
          orgName={orgName}
          data={data}
          cadence={cadence}
          onCadence={setCadence}
          back={() => setView('plans')}
          goToPlan={(planKey) => {
            setMarkedPlan(planKey);
            setView('plans');
          }}
          checkout={(priceLookupKey, onRefused) =>
            void startSession('checkout', { priceLookupKey }, onRefused)
          }
          portal={portal}
          reload={load}
          redirecting={redirecting}
        />
      ) : null}
      {view === 'seats' ? <SeatsView {...shared} back={() => setView('home')} /> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared props + helpers
type T = ReturnType<typeof useTranslations>;

interface SharedViewProps {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  orgName: string;
  memberCount: number;
  checkout: (priceLookupKey: string, quantity?: number) => void;
  portal: () => void;
  redirecting: boolean;
}

export { fmt };

function cadenceFromPriceId(priceId: string | null): BillingCadence {
  return priceId?.endsWith('_monthly') ? 'monthly' : 'annual';
}

type AiStatus = BillingStatusDTO['motirAi']['subscription']['status'];

function statusKey(status: AiStatus): 'active' | 'trialing' | 'past_due' | 'canceled' | 'none' {
  if (status === 'active') return 'active';
  if (status === 'trialing') return 'trialing';
  if (status === 'past_due') return 'past_due';
  if (status === 'canceled') return 'canceled';
  return 'none';
}

const STATUS_TINT: Record<string, string> = {
  active: 'bg-(--el-tint-mint)',
  trialing: 'bg-(--el-tint-sky)',
  past_due: 'bg-(--el-tint-yellow)',
  canceled: 'bg-(--el-tint-rose)',
  none: 'bg-(--el-surface)',
};

function StatusPill({ status, t }: { status: AiStatus; t: T }) {
  const key = statusKey(status);
  const icon =
    key === 'active' ? (
      <Check className="h-3 w-3" aria-hidden />
    ) : key === 'trialing' ? (
      <Sparkles className="h-3 w-3" aria-hidden />
    ) : key === 'past_due' ? (
      <AlertTriangle className="h-3 w-3" aria-hidden />
    ) : key === 'canceled' ? (
      <X className="h-3 w-3" aria-hidden />
    ) : null;
  return (
    <Pill
      className={`${STATUS_TINT[key]} text-(--el-text-strong) border-transparent`}
      title={t(`status.${key}`)}
    >
      {icon}
      {t(`status.${key}`)}
    </Pill>
  );
}

function TierPill({ name }: { name: string }) {
  return (
    <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
      {name}
    </Pill>
  );
}

// A token-only allotment meter (the `.meter` pattern shared with ai-usage).
// `tickPct` is the CI line's pool-boundary notch (design-notes amendment,
// `.meter.over .tick`): inside a SATURATED bar it marks where the included pool
// ended, so "2,220 of 1,800" reads as a bar that is full plus an overshoot
// rather than an unexplained 100%. It is a notch cut in `--el-page-bg`, not a
// colour, so it stays legible under every palette.
function Meter({ pct, low, tickPct }: { pct: number; low?: boolean; tickPct?: number | null }) {
  return (
    <div
      className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)"
      role="presentation"
    >
      <span
        className="block h-full rounded-full"
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          backgroundColor: low ? 'var(--el-warning)' : 'var(--el-accent)',
        }}
      />
      {tickPct == null ? null : (
        <i
          className="absolute inset-y-0 w-0.5"
          style={{
            left: `${Math.max(0, Math.min(100, tickPct))}%`,
            backgroundColor: 'var(--el-page-bg)',
          }}
          aria-hidden
        />
      )}
    </div>
  );
}

// A small decorative member-avatar cluster for the seat calc (avatars are
// decorative per the design — the seat COUNT is the load-bearing figure).
function AvatarCluster({ count }: { count: number }) {
  const shown = Math.min(count, 5);
  return (
    <span className="flex items-center" aria-hidden>
      {Array.from({ length: shown }).map((_, i) => (
        <span
          key={i}
          className="-ml-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--el-tint-lavender) ring-2 ring-(--el-page-bg) first:ml-0"
        />
      ))}
      {count > shown ? (
        <span className="ml-1 font-sans text-xs text-(--el-text-secondary)">+{count - shown}</span>
      ) : null}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ `InternalPlanCard` STOOD HERE AND IS DELETED (MOTIR-4572), with its five
// `internal.*` i18n keys. It was the whole of what a meta org's billing page
// rendered. Leaving a component nothing renders would leave the next reader to
// work out whether it is dead or merely unreached — and its copy ("unlimited,
// never billed") is now the opposite of what the product does.

// ─────────────────────────────────────────────────────────────────────────────
// Panel 2 — the billing home (the two billed lines + payment)
function HomeView({
  data,
  t,
  canManage,
  orgName,
  memberCount,
  portal,
  redirecting,
  goPlans,
  goSeats,
}: SharedViewProps & { goPlans: () => void; goSeats: () => void }) {
  // ⚠️ THE ORDERING RULE (design-notes amendment, panel 8) — measured, not a
  // preference. In its normal third position the Motir CI card starts 756 px
  // down the page, below the ~700 px fold of a 1280×800 laptop, so a PAUSED
  // admin would land above the decision and have to scroll to find it. When CI
  // is paused the card is hoisted FIRST; otherwise it keeps third position. This
  // orders by urgency without a second decision surface, without a page-level
  // banner to keep in sync, and without changing ① or ② at all — they are
  // identical, just below.
  const ciPaused = data.ci.state === 'ci_credits_exhausted';
  const ciLine = <MotirCiLine data={data} t={t} canManage={canManage} goPlans={goPlans} />;

  return (
    <>
      <header className="flex flex-col gap-1">
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">{t('subtitle')}</p>
      </header>

      {ciPaused ? ciLine : null}
      <MotirLine
        data={data}
        t={t}
        canManage={canManage}
        memberCount={memberCount}
        goSeats={goSeats}
      />
      <MotirAiLine
        data={data}
        t={t}
        canManage={canManage}
        goPlans={goPlans}
        portal={portal}
        redirecting={redirecting}
      />
      {ciPaused ? null : ciLine}
      {/* Agents sits after ③ and before ④ whether or not CI is hoisted: it has
          no paused state, so it never joins the hoist (MOTIR-6917 delta). */}
      <AgentsLine data={data} t={t} canManage={canManage} goPlans={goPlans} />
      <MotirSearchLine data={data} t={t} />
      <PaymentCard t={t} canManage={canManage} portal={portal} redirecting={redirecting} />
    </>
  );
}

// ① Motir (seats) line — free caps + seat preview, or the scaled summary.
function MotirLine({
  data,
  t,
  canManage,
  memberCount,
  goSeats,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  memberCount: number;
  goSeats: () => void;
}) {
  const locale = useLocale();
  const sub = data.motir.scaledTrackerSubscription;
  const scaled = sub?.status === 'active';
  const seat = data.catalog.seatPlan.prices;
  const annualSeat = seat.annual.amountUsd;
  const renews = fmtDate(sub?.currentPeriodEnd ?? null, locale);
  // Panel 3 (d) — REPLACES this line's body for an exempt org; never renders
  // beside it. GONE, each for its own reason: the CAPS block (there are none),
  // the seat calculator and its `N × $5` total (a price quote to the house),
  // and `Upgrade Motir` (a checkout for an org that is never charged).
  const exempt = isBillingExempt(data);

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint) text-(--el-text-strong)">
              <Layers className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('motir.name')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('motir.tagline')}</p>
            </div>
          </div>
          {exempt ? (
            <ExemptPill t={t} />
          ) : scaled ? (
            <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
              {t('motir.scaled')}
            </Pill>
          ) : (
            <Pill tone="neutral">{t('motir.free')}</Pill>
          )}
        </div>
      }
    >
      {exempt ? (
        <ExemptBanner text={t('exempt.motir')} />
      ) : scaled ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-sans text-sm text-(--el-text)">
              {t('seats.seatsBilled', { n: memberCount })}
            </span>
            <span className="font-sans text-sm font-medium text-(--el-text-strong)">
              {t('seats.planFeeYr', { yr: fmt(memberCount * annualSeat, locale) })}
            </span>
          </div>
          {renews ? (
            <p className="font-sans text-xs text-(--el-text-muted)">
              {t('ai.renews', { date: renews })}
            </p>
          ) : null}
          {canManage ? (
            <div>
              <Button variant="secondary" size="sm" onClick={goSeats}>
                {t('motir.manageSeats')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="font-sans text-sm text-(--el-text-secondary)">
            {t('motir.freeExplainer', { seat: seat.monthly.amountUsd })}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <CapCell
              label={t('motir.capWorkItems')}
              value={t('motir.capWorkItemsValue', { limit: fmt(FREE_CAPS.workItems, locale) })}
            />
            <CapCell
              label={t('motir.capProjects')}
              value={t('motir.capProjectsValue', { limit: FREE_CAPS.projects })}
            />
            <CapCell
              label={t('motir.capStorage')}
              value={t('motir.capStorageValue', { limit: FREE_CAPS.storageGb })}
            />
          </div>
          <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <div className="flex items-center gap-2">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('motir.seatPreview', { n: memberCount })}
              </span>
            </div>
            <span className="font-serif text-lg text-(--el-text)">
              {t('motir.seatTotalMo', {
                n: memberCount,
                seat: seat.monthly.amountUsd,
                total: fmt(memberCount * seat.monthly.amountUsd, locale),
              })}
            </span>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" size="md" onClick={goSeats}>
                {t('motir.upgrade')}
              </Button>
              <span className="font-sans text-xs text-(--el-text-muted)">
                {t('motir.seatsFollow')}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function CapCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-(--radius-control) border border-(--el-border-soft) p-(--spacing-control-x-12)">
      <span className="font-sans text-xs text-(--el-text-muted)">{label}</span>
      <span className="font-sans text-sm font-medium text-(--el-text)">{value}</span>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-(--el-muted)"
        role="presentation"
      >
        <span
          className="block h-full rounded-full"
          style={{ width: '24%', backgroundColor: 'var(--el-accent)' }}
        />
      </div>
    </div>
  );
}

// ② Motir AI line — tier, status, allotment, lifecycle states.
function MotirAiLine({
  data,
  t,
  canManage,
  goPlans,
  portal,
  redirecting,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  goPlans: () => void;
  portal: () => void;
  redirecting: boolean;
}) {
  const locale = useLocale();
  const { tier, balance, subscription } = data.motirAi;
  const status = subscription.status;
  const key = statusKey(status);
  const allotment = tier?.monthlyCreditAllotment ?? 0;
  const pct = allotment > 0 ? Math.round((Math.min(balance, allotment) / allotment) * 100) : 0;
  const low = key === 'past_due' || (allotment > 0 && balance / allotment < 0.1);
  const cadence = cadenceFromPriceId(subscription.priceId);
  const catalogTier = data.catalog.aiPlans.find((p) => p.key === tier?.key);
  // A one-time grant (Free) is never "per month", and has no month to measure
  // against — its meter reads as the one grant it is (MOTIR-5274).
  const oneTime = catalogTier?.allotment?.cadence === 'one_time';
  const fee = catalogTier?.prices?.[cadence]?.amountUsd ?? null;
  const renews = fmtDate(subscription.currentPeriodEnd, locale);
  // Panel 3 (e) — REPLACES this line's body for an exempt org. GONE: the `Free`
  // chip and "on the one-time free trial" (it is EXEMPT, not trialing — the AI
  // paywall is off for it, `billingService.ts:252`), and `Choose a Motir AI
  // plan`. The Usage & cost cross-link STAYS: those figures are real, and they
  // are the reason this org reads this page — so it is rendered for every
  // member here rather than under `canManage`, which the ordinary line's whole
  // action row sits behind. The usage page itself admits any org member (an
  // admin sees the org view, a member their own project slice, gated
  // server-side in `aiUsageService`), so the link never leads somewhere shut.
  const exempt = isBillingExempt(data);

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-lavender) text-(--el-text-strong)">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('ai.name')}</h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('ai.tagline')}</p>
            </div>
          </div>
          {exempt ? <ExemptPill t={t} /> : <StatusPill status={status} t={t} />}
        </div>
      }
    >
      {exempt ? (
        <div className="flex flex-col gap-4">
          <ExemptBanner text={t('exempt.ai')} />
          <div>
            <Link
              href="/settings/organization/usage"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-link) hover:underline"
            >
              <Coins className="h-4 w-4" aria-hidden />
              {t('ai.viewUsage')}
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {key === 'past_due' ? <PastDueBanner t={t} /> : null}
          {key === 'canceled' ? <CanceledBanner t={t} /> : null}

          {tier && status !== 'canceled' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <TierPill name={tier.name} />
                  <span className="font-sans text-sm text-(--el-text)">
                    {t(oneTime ? 'ai.creditsOneTime' : 'ai.creditsPerMo', {
                      n: fmt(allotment, locale),
                    })}
                  </span>
                </div>
                {fee !== null ? (
                  <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                    {t('ai.planFee')} {t('ai.feePerMo', { n: fee })}
                  </span>
                ) : null}
              </div>
              <div>
                <p className="font-sans text-xs text-(--el-text-muted)">
                  {oneTime ? t('trial.label') : t('ai.allotmentThisMonth')}
                </p>
                <Meter pct={pct} low={low} />
                <p className="mt-2 font-sans text-xs text-(--el-text-muted)">
                  {t('ai.creditsLeft', {
                    left: fmt(Math.max(0, balance), locale),
                    total: fmt(allotment, locale),
                  })}
                </p>
              </div>
              {key === 'trialing' || oneTime ? (
                <p className="font-sans text-xs text-(--el-text-muted)">
                  <strong className="text-(--el-text-secondary)">{t('trial.label')}.</strong>{' '}
                  {t('trial.note')}
                </p>
              ) : (
                <p className="font-sans text-xs text-(--el-text-muted)">{t('ai.creditsNote')}</p>
              )}
              {renews ? (
                <p className="font-sans text-xs text-(--el-text-muted)">
                  {t('ai.renews', { date: renews })}
                </p>
              ) : null}
            </>
          ) : (
            <p className="font-sans text-sm text-(--el-text-secondary)">{t('ai.noPlanYet')}</p>
          )}

          {canManage ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={goPlans}>
                {key === 'canceled'
                  ? t('canceled.cta')
                  : status === null
                    ? t('ai.choosePlan')
                    : t('ai.changePlan')}
              </Button>
              {status !== null ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={portal}
                  loading={redirecting}
                  leftIcon={<ExternalLink className="h-4 w-4" />}
                >
                  {t('ai.managePlan')}
                </Button>
              ) : null}
              <Link
                href="/settings/organization/usage"
                className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-link) hover:underline"
              >
                <Coins className="h-4 w-4" aria-hidden />
                {t('ai.viewUsage')}
              </Link>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function PastDueBanner({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--el-warning)' }}
        aria-hidden
      />
      <p className="font-sans text-xs text-(--el-text-strong)">{t('pastDue.banner')}</p>
    </div>
  );
}

function CanceledBanner({ t }: { t: T }) {
  return (
    <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-rose) p-(--spacing-card-padding)">
      <X
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: 'var(--el-danger-on-surface)' }}
        aria-hidden
      />
      <p className="font-sans text-xs text-(--el-text-strong)">{t('canceled.banner')}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ Motir CI line (MOTIR-1903 · design/billing "Amendment 2026-07-30" ·
// ADR ci-minutes-allowance.md §7). A THIRD billed line, not a second usage kind
// on the AI line: its own unit (minutes), its own period (the calendar month —
// deliberately NOT the seat/AI renewal date, which the copy says out loud) and
// its own exhaustion state.
//
// It reports MINUTES and the credits its own overage drew, and LINKS to the AI
// line for the balance rather than restating it (§7.2's non-duplication rule) —
// so a reader can tell CI's spend from AI's. Every figure comes from
// `ciLineFigures(data.ci)`, i.e. from `getEntitlementState`'s real reads; the
// card renders nothing it cannot trace to one.
function MotirCiLine({
  data,
  t,
  canManage,
  goPlans,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  goPlans: () => void;
}) {
  const locale = useLocale();
  const ci = ciLineFigures(data.ci);
  // `null` is the ADR's not-applicable set (self-host, no provisioning org, the
  // META org) — no line at all, which is what §7.3.7 asks for.
  if (!ci) return null;

  // The META org (§4.4, MOTIR-8886): bypassed, so no pool, meter, credits or buy
  // control — only the minutes its own fleet runner has used, so the house can
  // see what its CI costs on the one page every other org reads it on.
  if (ci.variant === 'internal') {
    return (
      <Card
        header={
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-peach) text-(--el-text-strong)">
                <Zap className="h-4 w-4" aria-hidden />
              </span>
              <div>
                <h2 className="font-sans text-base font-semibold text-(--el-text)">
                  {t('ci.name')}
                </h2>
                <p className="font-sans text-xs text-(--el-text-muted)">{t('ci.tagline')}</p>
              </div>
            </div>
            <CiStatePill variant={ci.variant} t={t} />
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-sans text-xs text-(--el-text-muted)">{t('ci.usedLabel')}</span>
            <span className="font-sans text-sm font-medium text-(--el-text-strong)">
              {t('ci.internalUsed', { used: fmt(ci.usedMinutes, locale) })}
            </span>
          </div>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('ci.internalNote')}</p>
        </div>
      </Card>
    );
  }

  const paused = ci.variant === 'paused';
  const resets = fmtDate(ci.resetsAt, locale);
  const derivation = ci.floorApplied
    ? t('ci.deriveFloor', { pool: fmt(ci.poolMinutes, locale) })
    : t('ci.deriveSeats', { perSeat: ci.perSeatMinutes, n: ci.memberCount });

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-peach) text-(--el-text-strong)">
              <Zap className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('ci.name')}</h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('ci.tagline')}</p>
            </div>
          </div>
          <CiStatePill variant={ci.variant} t={t} />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* The paused banner leads: it is the reason the card was hoisted to the
            top of the stack, so the state comes before the numbers. */}
        {paused ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
            <Pause
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: 'var(--el-warning)' }}
              aria-hidden
            />
            <p className="font-sans text-xs text-(--el-text-strong)">
              <strong>{canManage ? t('ci.pausedTitle') : t('ci.pausedTitleMember')}</strong>{' '}
              {canManage
                ? t('ci.pausedBody', {
                    pool: fmt(ci.poolMinutes, locale),
                    over: fmt(ci.overageMinutes, locale),
                    credits: fmt(ci.chargedCredits, locale),
                  })
                : t('ci.pausedBodyMember')}
            </p>
          </div>
        ) : null}

        {ci.variant === 'nothing_to_bill' ? (
          // §7.3.6 — deliberately NOT an empty state and NOT a "0 of 1,800"
          // meter: an org whose repositories are all its own has a pool it will
          // never draw on, and saying so beats drawing a zero as if something
          // were wrong.
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <Coins className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              <strong className="text-(--el-text-strong)">{t('ci.zeroTitle')}</strong>{' '}
              {t('ci.zeroBody', { pool: fmt(ci.poolMinutes, locale) })}
            </p>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-sans text-xs text-(--el-text-muted)">{t('ci.usedLabel')}</span>
              <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                {t('ci.usedOfPool', {
                  used: fmt(ci.usedMinutes, locale),
                  pool: fmt(ci.poolMinutes, locale),
                })}
              </span>
            </div>
            <Meter pct={ci.meterPct} low={ci.over} tickPct={ci.tickPct} />
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-sans text-xs text-(--el-text-muted)">{derivation}</span>
              <span className="font-sans text-xs font-medium text-(--el-text-secondary)">
                {paused
                  ? t('ci.creditsDrawn', { credits: fmt(ci.chargedCredits, locale) })
                  : ci.over
                    ? t('ci.minutesOver', { over: fmt(ci.overageMinutes, locale) })
                    : t('ci.minutesLeft', { left: fmt(ci.remainingMinutes, locale) })}
              </span>
            </div>
          </div>
        )}

        {/* §6.1 — crossing the pool is a NORMAL, VISIBLE event that blocks
            nothing. Stated as its own banner so it can't read as a failure. */}
        {ci.variant === 'drawing_on_credits' ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding)">
            <Coins
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: 'var(--el-warning)' }}
              aria-hidden
            />
            <p className="font-sans text-xs text-(--el-text-strong)">
              <strong>{t('ci.drawingTitle')}</strong>{' '}
              {t('ci.drawingBody', {
                over: fmt(ci.overageMinutes, locale),
                credits: fmt(ci.chargedCredits, locale),
              })}
            </p>
          </div>
        ) : null}

        {ci.variant === 'within_allowance' ? (
          <p className="font-sans text-xs text-(--el-text-muted)">
            {resets ? `${t('ci.resets', { date: resets })} ` : ''}
            {t('ci.overageRate')}
          </p>
        ) : null}
        {ci.variant === 'drawing_on_credits' && resets ? (
          <p className="font-sans text-xs text-(--el-text-muted)">
            {t('ci.resetsRefill', { date: resets })}
          </p>
        ) : null}
        {paused && resets ? (
          <p className="font-sans text-xs text-(--el-text-muted)">
            {t('ci.resets', { date: resets })}
          </p>
        ) : null}

        {/* A transport blip on the balance read is a REAL value (`balance:
            null`), never exhaustion and never a misleading zero: the minutes
            half above is local data and stays accurate; only the credit half is
            missing. Suppressed when paused, where the balance is known to be 0. */}
        {ci.balanceUnavailable && !paused ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('ci.balanceUnavailable')}
            </p>
          </div>
        ) : null}

        {paused ? (
          canManage ? (
            <CiPausedDecision t={t} goPlans={goPlans} />
          ) : (
            // Never a disabled control: a sentence explaining who can act beats
            // a button this user cannot press. It routes WITHOUT naming owners —
            // naming them would leak org membership (the shipped `askOwner`
            // paywall variant routes the same way).
            <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
              <p className="font-sans text-xs text-(--el-text-secondary)">
                {t('ci.memberLockNote')}
              </p>
            </div>
          )
        ) : null}

        {/* §7.2 — CI links to the AI line for the balance instead of restating
            it, so there is one place a balance is authored. */}
        {ci.variant !== 'nothing_to_bill' ? (
          <div>
            <Link
              href="/settings/organization/usage"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-(--el-link) hover:underline"
            >
              <Coins className="h-4 w-4" aria-hidden />
              {t('ci.viewUsage')}
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function CiStatePill({ variant, t }: { variant: CiLineVariant; t: T }) {
  if (variant === 'nothing_to_bill') return <Pill tone="neutral">{t('ci.stateNothing')}</Pill>;
  if (variant === 'internal') return <Pill tone="neutral">{t('ci.stateInternal')}</Pill>;
  if (variant === 'within_allowance') {
    return (
      <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
        <Check className="h-3 w-3" aria-hidden />
        {t('ci.stateIncluded')}
      </Pill>
    );
  }
  // Both over-pool states are WARNING, never danger — the panel's own rule for
  // "you are paying more" and "this is stopped": nothing is broken and nothing
  // has been deleted.
  const paused = variant === 'paused';
  return (
    <Pill className="bg-(--el-tint-yellow) text-(--el-text-strong) border-transparent">
      {paused ? (
        <Pause className="h-3 w-3" aria-hidden />
      ) : (
        <Coins className="h-3 w-3" aria-hidden />
      )}
      {paused ? t('ci.statePaused') : t('ci.stateDrawing')}
    </Pill>
  );
}

// The two-option DECISION (amendment §D). TWO PEERS, NO DEFAULT — neither is the
// `primary` variant, because one keeps the hosted arrangement and one ends it,
// and dressing either as *the* answer is Motir's thumb on the scale. Each states
// its real cost under it: the top-up states the §B resume latency instead of
// implying "instant"; the takeover states the GitHub account, the asynchronous
// transfer and the App re-install, never "one click". The takeover is never
// hidden and never gated on a stored GitHub identity — motir-core's only social
// provider is Google, so NO admin has one and gating would hide it from everyone
// (MOTIR-711/MOTIR-1939's room collects the destination inside its own flow).
function CiPausedDecision({ t, goPlans }: { t: T; goPlans: () => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding)">
        <h3 className="flex items-center gap-1.5 font-sans text-sm font-semibold text-(--el-text)">
          <Coins className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          {t('ci.optionCreditsTitle')}
        </h3>
        <p className="font-sans text-xs text-(--el-text-secondary)">{t('ci.optionCreditsBody')}</p>
        <p className="font-sans text-xs text-(--el-text-muted)">{t('ci.optionCreditsCost')}</p>
        <div className="mt-auto pt-1">
          <Button variant="secondary" size="sm" onClick={goPlans}>
            {t('ci.optionCreditsCta')}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding)">
        <h3 className="flex items-center gap-1.5 font-sans text-sm font-semibold text-(--el-text)">
          <ArrowUpRight className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          {t('ci.optionMoveTitle')}
        </h3>
        <p className="font-sans text-xs text-(--el-text-secondary)">{t('ci.optionMoveBody')}</p>
        <p className="font-sans text-xs text-(--el-text-muted)">{t('ci.optionMoveCost')}</p>
        <div className="mt-auto pt-1">
          <Link
            href="/settings/project/repositories"
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            {t('ci.optionMoveCta')}
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </div>
  );
}

// Agents line — machine time and storage for the org's agents (MOTIR-6920; the
// asset is `design/billing/billing--agents-line.mock.html`, `design-notes.md`
// "Delta 2026-09-29"). Search's figure band with a third figure for the sum; no
// meter (no pool) and no paused state (storage is never refused for balance).
function AgentsLine({
  data,
  t,
  canManage,
  goPlans,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  goPlans: () => void;
}) {
  const locale = useLocale();
  const agents = agentLineFigures(data.agents);
  const noPlan = agents.variant === 'no_plan' || agents.variant === 'no_plan_with_charges';
  const unavailable = agents.variant === 'unavailable';

  const figure = (label: string, value: number | null, headline: boolean) => (
    <div
      className={
        headline
          ? 'flex min-w-0 flex-col gap-0.5 border-l border-(--el-border) pl-7'
          : 'flex min-w-0 flex-col gap-0.5'
      }
    >
      <span className="font-sans text-xs text-(--el-text-secondary)">{label}</span>
      {value === null ? (
        // ⚠️ AN EM-DASH, NEVER A ZERO — the Search line's rule.
        <span
          className="font-sans text-xl font-medium tracking-wide text-(--el-text-secondary)"
          aria-label={t('agents.unavailableValue')}
        >
          &mdash;
        </span>
      ) : (
        <span
          className={
            headline
              ? 'font-sans text-xl font-semibold text-(--el-text) tabular-nums'
              : 'font-sans text-xl font-medium text-(--el-text-secondary) tabular-nums'
          }
        >
          {fmt(value, locale)}
          <span className="ml-1 font-sans text-sm font-medium text-(--el-text-secondary)">
            {t('agents.creditsUnit')}
          </span>
        </span>
      )}
    </div>
  );

  return (
    <Card
      data-testid="billing-agents-line"
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* mint, lavender, peach and sky are ①–④; rose and yellow are
                states. Sage is the one shipped tint left (MOTIR-5140). */}
            <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sage) text-(--el-text-strong)">
              <Bot className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('agents.name')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('agents.tagline')}</p>
            </div>
          </div>
          {noPlan ? null : <Pill tone="neutral">{t('agents.perUse')}</Pill>}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {agents.showFigures ? (
          <div className="flex flex-wrap items-end gap-7">
            {figure(t('agents.machineLabel'), agents.machine, false)}
            {figure(t('agents.storageLabel'), agents.storage, false)}
            {figure(t('agents.totalLabel'), agents.total, true)}
          </div>
        ) : null}

        {agents.variant === 'figures' ? (
          <p className="font-sans text-xs text-(--el-text-secondary)">
            {agents.nothingCharged ? t('agents.zero') : t('agents.rate')}
          </p>
        ) : null}

        {agents.showNoPlanNote ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('agents.noPlan')}{' '}
              {/* The page has no plan-picker URL: it is the in-page plans view,
                  opened the way ②'s own button opens it. Owner-only, as ②'s is. */}
              {canManage ? (
                <button
                  type="button"
                  onClick={goPlans}
                  className="font-sans text-xs font-medium text-(--el-link) hover:underline"
                >
                  {t('agents.choosePlan')}
                </button>
              ) : null}
            </p>
          </div>
        ) : null}

        {unavailable ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)"
              aria-hidden
            />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('agents.unavailable')}
            </p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ④ Motir Search line — the fourth billed line (MOTIR-4557; the asset is
// `design/billing/search-line.mock.html`, `design-notes.md` "Amendment
// 2026-09-05"). The customer sees a search charge as its own kind alongside AI
// turns and Motir CI, and NOT merged into the AI line — decided in the same words
// by `motir-search-channel.md` §4.4 and `credit-model.md` §4b.
//
// ⚠️ It looks like ③ and behaves differently, and building it as a copy of ③
// would invent two things the product does not have: a METER (search has no pool
// to divide by) and a PAUSED state (§5 — an out-of-credit org goes into overdraft
// and search refuses nothing). Neither is an omission; both are in the asset as
// drawn absences.
//
// It takes no `canManage`: the line is figures, not a control. There is no
// button, no checkout and no owner-only affordance on it, so the shipped
// permission split reaches it unchanged and it needs no member variant of its own.
function MotirSearchLine({ data, t }: { data: BillingStatusDTO; t: T }) {
  const locale = useLocale();
  const search = searchLineFigures({
    search: data.search,
    balance: data.motirAi.balance,
  });
  // `null` no longer has a META arm to mean (MOTIR-4572) — every org renders the
  // ordinary billed lines. The helper keeps its nullable return for the cases
  // that are genuinely about figures rather than about which org is looking.
  if (!search) return null;

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {/* The FOURTH product hue. mint = Motir, lavender = Motir AI, peach =
                Motir CI, so search takes the unused SKY tint slot rather than
                inventing one — and sky is the only remaining slot not already
                spent on a STATE (rose is danger, yellow warning; either would
                read as an alarm on a line that never alarms). */}
            <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)">
              <Search className="h-4 w-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('search.name')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('search.tagline')}</p>
            </div>
          </div>
          <Pill tone="neutral">{t('search.perUse')}</Pill>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {search.variant === 'nothing_to_bill' ? (
          // Deliberately NOT a "0 credits" figure with a zero meter beside it: an
          // org whose runs never search has nothing wrong with it. Same shape ③
          // uses for its own zero-consumption case.
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <Coins className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-secondary)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              <strong className="text-(--el-text-strong)">{t('search.zeroTitle')}</strong>{' '}
              {t('search.zeroBody')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-7">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t('search.monthLabel')}
              </span>
              {/* ⚠️ AN EM-DASH, NEVER A ZERO. `null` means the boundary did not
                  report the block — a rolling deploy where the motir-ai half has
                  not landed — and a `0` here tells a customer they were not
                  charged. The label carries the meaning for a reader who cannot
                  see the dash. */}
              {search.figuresUnavailable ? (
                <span
                  className="font-sans text-xl font-medium tracking-wide text-(--el-text-secondary)"
                  aria-label={t('search.unavailableValue')}
                >
                  &mdash;
                </span>
              ) : (
                <span className="font-sans text-xl font-semibold text-(--el-text) tabular-nums">
                  {fmt(search.monthSpend ?? 0, locale)}
                  <span className="ml-1 font-sans text-sm font-medium text-(--el-text-secondary)">
                    {t('search.creditsUnit')}
                  </span>
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-sans text-xs text-(--el-text-secondary)">
                {t('search.totalLabel')}
              </span>
              {search.figuresUnavailable ? (
                <span
                  className="font-sans text-xl font-medium tracking-wide text-(--el-text-secondary)"
                  aria-label={t('search.unavailableValue')}
                >
                  &mdash;
                </span>
              ) : (
                <span className="font-sans text-xl font-medium text-(--el-text-secondary) tabular-nums">
                  {fmt(search.totalSpend ?? 0, locale)}
                  <span className="ml-1 font-sans text-sm font-medium text-(--el-text-secondary)">
                    {t('search.creditsUnit')}
                  </span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* §5 — the one place a reader of ①②③ expects a refusal and must be told
            there is none. INFO, never the warning family: nothing is blocked. */}
        {search.overdraft ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)">
            <Coins
              className="mt-0.5 h-4 w-4 shrink-0"
              style={{ color: 'var(--el-info)' }}
              aria-hidden
            />
            <p className="font-sans text-xs text-(--el-text-strong)">
              <strong>{t('search.overdraftTitle')}</strong> {t('search.overdraftBody')}
            </p>
          </div>
        ) : null}

        {search.figuresUnavailable ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">
              {t('search.unavailable')}
            </p>
          </div>
        ) : (
          <p className="font-sans text-xs text-(--el-text-muted)">{t('search.rate')}</p>
        )}

        {/* "What am I charged for" is this panel; "where did it go" is the usage
            dashboard's, and this line links across rather than re-drawing it —
            the same cross-link ② and ③ already use. */}
        <div>
          <Link
            href="/settings/organization/usage"
            className="inline-flex items-center gap-1 font-sans text-xs font-medium text-(--el-link) hover:underline"
          >
            <Coins className="h-3.5 w-3.5" aria-hidden />
            {t('search.viewRuns')}
          </Link>
        </div>
      </div>
    </Card>
  );
}

function PaymentCard({
  t,
  canManage,
  portal,
  redirecting,
}: {
  t: T;
  canManage: boolean;
  portal: () => void;
  redirecting: boolean;
}) {
  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          <h2 className="font-sans text-base font-semibold text-(--el-text)">
            {t('payment.title')}
          </h2>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {canManage ? (
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={portal}
              loading={redirecting}
              leftIcon={<ExternalLink className="h-4 w-4" />}
            >
              {t('payment.portal')}
            </Button>
          </div>
        ) : null}
        <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
          <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('payment.note')}</p>
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 5 — Motir AI plans & subscription (AI-only)
function PlansView({
  data,
  t,
  canManage,
  orgName,
  checkout,
  portal,
  redirecting,
  back,
  orgId,
  reload,
  cadence,
  setCadence,
  markedPlan,
  openCalculator,
}: SharedViewProps & {
  back: () => void;
  orgId: string;
  /** Re-read the billing status — after a change of plan (MOTIR-8399). */
  reload: () => Promise<void>;
  /** The page's one billing period, owned by BillingClient (MOTIR-8639). */
  cadence: BillingCadence;
  setCadence: (cadence: BillingCadence) => void;
  /** The plan the Calculator sent the owner to, distinguished for this arrival. */
  markedPlan: string | null;
  /** Open the Calculator view. */
  openCalculator: () => void;
}) {
  const locale = useLocale();
  // The plan-change dialog open, if any (MOTIR-8399). Mounted only while open, so
  // each opening prices the change afresh.
  const [change, setChange] = useState<{ kind: 'upgrade' | 'downgrade'; planKey: string } | null>(
    null,
  );
  const reasonId = useId();
  const { tier, balance, subscription, pendingDowngrade } = data.motirAi;
  const allotment = tier?.monthlyCreditAllotment ?? 0;
  const renews = fmtDate(subscription.currentPeriodEnd, locale);
  const aiPlans = data.catalog.aiPlans;
  const oneTime = aiPlans.find((p) => p.key === tier?.key)?.allotment?.cadence === 'one_time';
  const paidActive =
    !!tier &&
    tier.key !== 'free' &&
    (subscription.status === 'active' || subscription.status === 'past_due');
  // An org holds ONE AI plan (MOTIR-8394): while a paid plan is live no card offers
  // a checkout; a change of plan is the upgrade path's, whose controls own the slot.
  const holdsPlan =
    !!tier &&
    tier.key !== 'free' &&
    (subscription.status === 'active' ||
      subscription.status === 'trialing' ||
      subscription.status === 'past_due');
  const planNames: PlanNames = Object.fromEntries(aiPlans.map((p) => [p.key, p.name]));
  // "Above / below" is the catalog order by monthly pool (MOTIR-8399), the rule
  // motir-ai's direction guards use.
  const currentPool = aiPlans.find((p) => p.key === tier?.key)?.allotment?.credits ?? null;
  const planChangeLocked = holdsPlan && !canManage;
  // The cards are the PAID plans (MOTIR-7598): Free is not a plan to choose but
  // the one-time trial grant, said in the strip above the row, and a price-less
  // plan has no card (Enterprise is gone — MOTIR-7592).
  // The standing rungs only: a larger pool is offered and sold from the Calculator's
  // answer, never in this row (MOTIR-8997, design/billing § "Amendment 2026-10-21 —
  // the larger credit pool plan", approved 2026-10-22). The row is the standing
  // LADDER plus Host, each said positively: Host is the fifth card, after Max ×2, in
  // catalog order (design/billing § "Amendment 2026-10-23 — the Host plan", MOTIR-9403).
  const paidPlans = aiPlans.filter(
    (p) => p.key !== 'free' && p.prices && (p.band === 'ladder' || p.band === 'host'),
  );
  // An org that HOLDS a larger pool sees that one plan, with the regular plans folded
  // behind a toggle (design panels 9–10).
  const heldPool =
    (holdsPlan && aiPlans.find((p) => p.key === tier?.key && p.band === 'larger_pool')) || null;
  const [showRegular, setShowRegular] = useState(false);
  const regularId = useId();
  // The callout names the LADDER's top (Max ×2), never Host: its sentence is about
  // outgrowing the ladder, and Host is not a rung of it (MOTIR-9403).
  const topRung = paidPlans
    .filter((p) => p.band === 'ladder')
    .reduce<AiPlanCatalogEntry | null>(
      (top, p) => ((p.allotment?.credits ?? 0) > (top?.allotment?.credits ?? 0) ? p : top),
      null,
    );
  const renderCard = (
    plan: AiPlanCatalogEntry,
    previous: AiPlanCatalogEntry | null,
    solo: boolean,
  ) => (
    <PlanCard
      key={plan.key}
      plan={plan}
      previous={previous}
      cadence={cadence}
      currentKey={tier?.key ?? null}
      status={subscription.status}
      holdsPlan={holdsPlan}
      canManage={canManage}
      redirecting={redirecting}
      checkout={checkout}
      currentPool={currentPool}
      pendingDowngrade={pendingDowngrade}
      planNames={planNames}
      marked={markedPlan === plan.key}
      solo={solo}
      describedBy={planChangeLocked ? reasonId : undefined}
      openChange={(kind) => setChange({ kind, planKey: plan.key })}
      t={t}
    />
  );

  // The org is on the one-time trial: its tier is the catalog's `free` grant and
  // it holds no paid plan. The strip reads the same balance and grant the home
  // line's meter reads.
  const onTrial = !holdsPlan && tier?.key === 'free';

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('plans.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.breadcrumb', { org: orgName })}
        </p>
        <h1 className="font-serif text-3xl font-semibold text-(--el-text)">{t('plans.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">
          {t('plans.subtitle')}
        </p>
      </header>

      {tier && tier.key !== 'free' && subscription.status ? (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <TierPill name={tier.name} />
              <StatusPill status={subscription.status} t={t} />
              <span className="font-sans text-sm text-(--el-text-muted)">
                {oneTime
                  ? t('plans.currentStripOneTime', {
                      n: fmt(allotment, locale),
                      left: fmt(Math.max(0, balance), locale),
                    })
                  : t('plans.currentStrip', {
                      n: fmt(allotment, locale),
                      left: fmt(Math.max(0, balance), locale),
                      date: renews ?? '—',
                    })}
              </span>
            </div>
            {canManage ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={portal}
                loading={redirecting}
                leftIcon={<ExternalLink className="h-4 w-4" />}
              >
                {t('plans.managePlan')}
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      <div className="flex flex-col gap-2">
        <h2 className="font-sans text-lg font-semibold text-(--el-text)">
          {heldPool ? t('plans.yourPlanTitle') : t('plans.chooseTitle')}
        </h2>
        {heldPool ? null : (
          <p className="max-w-prose font-sans text-sm text-(--el-text-muted)">
            {t('plans.chooseSub')}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Segmented<BillingCadence>
          label={t('plans.cadenceLabel')}
          value={cadence}
          onChange={setCadence}
          options={[
            { value: 'monthly', label: t('plans.monthly') },
            { value: 'annual', label: t('plans.annual') },
          ]}
        />
        {cadence === 'annual' ? (
          <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
            {t('plans.saveBadge')}
          </Pill>
        ) : null}
      </div>

      {onTrial ? <FreeTrialStrip left={balance} granted={allotment} t={t} /> : null}

      {planChangeLocked ? (
        <p
          id={reasonId}
          className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)"
        >
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('plans.upgrade.disabledReason')}
        </p>
      ) : null}

      {/* Tall, equal-height cards in ONE row (the SaaS storefront pattern); below
          the row's natural width the container scrolls horizontally (scroll-snap)
          rather than wrapping — the tiers stay one comparable ladder (design 8.1.21). */}
      {heldPool ? (
        <>
          <div className="flex snap-x snap-proximity items-stretch gap-3 overflow-x-auto pb-1.5">
            {renderCard(heldPool, null, true)}
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showRegular}
              aria-controls={regularId}
              onClick={() => setShowRegular((open) => !open)}
              rightIcon={
                showRegular ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )
              }
            >
              {showRegular ? t('plans.larger.hideRegular') : t('plans.larger.showRegular')}
            </Button>
          </div>
          {showRegular ? (
            <div
              id={regularId}
              className="flex snap-x snap-proximity items-stretch gap-3 overflow-x-auto pb-1.5"
            >
              {paidPlans.map((plan, i) => renderCard(plan, paidPlans[i - 1] ?? null, false))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex snap-x snap-proximity items-stretch gap-3 overflow-x-auto pb-1.5">
          {paidPlans.map((plan, i) => renderCard(plan, paidPlans[i - 1] ?? null, false))}
        </div>
      )}

      <NeedMoreCredits held={heldPool} topRung={topRung} openCalculator={openCalculator} t={t} />

      {change?.kind === 'upgrade' ? (
        <UpgradeDialog
          orgId={orgId}
          toPlanKey={change.planKey}
          planNames={planNames}
          onClose={() => setChange(null)}
          onChanged={() => void reload()}
          portal={portal}
        />
      ) : null}
      {change?.kind === 'downgrade' ? (
        <DowngradeDialog
          orgId={orgId}
          toPlanKey={change.planKey}
          planNames={planNames}
          onClose={() => setChange(null)}
          onChanged={() => void reload()}
        />
      ) : null}

      <TopupCard
        data={data}
        t={t}
        canManage={canManage}
        paidActive={paidActive}
        checkout={checkout}
        redirecting={redirecting}
      />

      <p className="max-w-prose font-sans text-xs text-(--el-text-muted)">
        {t('plans.footer', { org: orgName })}
      </p>
    </>
  );
}

function PlanCard({
  plan,
  previous,
  cadence,
  currentKey,
  status,
  holdsPlan,
  canManage,
  redirecting,
  checkout,
  currentPool,
  pendingDowngrade,
  planNames,
  marked,
  describedBy,
  openChange,
  solo = false,
  t,
}: {
  plan: AiPlanCatalogEntry;
  /** The paid plan one rung below, or null for the first — the ladder line's base. */
  previous: AiPlanCatalogEntry | null;
  cadence: BillingCadence;
  currentKey: string | null;
  status: AiStatus;
  /** The org holds a live paid AI plan — no card then offers a checkout. */
  holdsPlan: boolean;
  canManage: boolean;
  redirecting: boolean;
  checkout: (priceLookupKey: string) => void;
  /** The current plan's monthly pool — which cards are above and below it. */
  currentPool: number | null;
  /** The downgrade the live plan has scheduled, or null (MOTIR-8399). */
  pendingDowngrade: BillingStatusDTO['motirAi']['pendingDowngrade'];
  planNames: PlanNames;
  /** The Calculator's next step ended here: distinguish this card for this arrival. */
  marked: boolean;
  /** The visible reason the plan-change controls are disabled (a non-manager). */
  describedBy: string | undefined;
  openChange: (kind: 'upgrade' | 'downgrade') => void;
  /** The one card a pool holder's row shows: its natural width, not a share of the row. */
  solo?: boolean;
  t: T;
}) {
  const locale = useLocale();
  // A larger pool has no per-tier copy (no use case, features or ladder line): its
  // name, price and pool are the catalog entry's (MOTIR-8997).
  const pool = plan.band === 'larger_pool';
  const isCurrent = currentKey === plan.key && status !== null && status !== 'canceled';
  const isRecommended = plan.recommended;
  const accent = isCurrent || isRecommended || marked;
  const accentIcon =
    plan.key === 'pro' ? (
      <Zap className="h-4 w-4 text-(--el-accent-on-surface)" aria-hidden />
    ) : plan.key === 'max' ? (
      <Crown className="h-4 w-4 text-(--el-accent-on-surface)" aria-hidden />
    ) : null;

  // Price block by cadence (per-month-equivalent for annual, dollar savings).
  // Only paid plans reach a card (PlansView filters), so `prices` is set.
  const prices = plan.prices!;
  let priceBlock: React.ReactNode;
  if (cadence === 'annual') {
    const annual = prices.annual.amountUsd;
    const monthly = prices.monthly.amountUsd;
    const perMo = Math.round(annual / 12);
    const save = monthly * 12 - annual;
    priceBlock = (
      <div>
        <div>
          <span className="font-serif text-2xl text-(--el-text)">
            {t('plans.perMoEquiv', { n: fmt(perMo, locale) })}
          </span>
        </div>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.annualSub', { yr: fmt(annual, locale) })}
        </p>
        {save > 0 ? (
          <Pill className="mt-1 bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
            {t('plans.annualSave', { n: fmt(save, locale) })}
          </Pill>
        ) : null}
      </div>
    );
  } else {
    const monthly = prices.monthly.amountUsd;
    const annual = prices.annual.amountUsd;
    const save = monthly * 12 - annual;
    priceBlock = (
      <div>
        <span className="font-serif text-2xl text-(--el-text)">
          {t('plans.perMoEquiv', { n: fmt(monthly, locale) })}
        </span>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('plans.monthlySub', { yr: fmt(monthly * 12, locale), n: fmt(save, locale) })}
        </p>
      </div>
    );
  }

  // CTA
  let cta: React.ReactNode;
  if (isCurrent) {
    cta = (
      <Button variant="secondary" size="sm" disabled className="w-full">
        {t('plans.ctaCurrent')}
      </Button>
    );
  } else if (holdsPlan) {
    // The action slot is the upgrade path's (MOTIR-8399): a higher plan upgrades
    // now, a lower one is scheduled for the period end, and the plan a downgrade
    // is already scheduled to shows when — with no cancel or undo.
    const pool = plan.allotment?.credits ?? 0;
    const scheduled = pendingDowngrade?.planKey === plan.key ? pendingDowngrade : null;
    if (scheduled) {
      cta = (
        <Button
          variant="secondary"
          size="sm"
          disabled
          className="h-auto min-h-(--height-btn-sm) w-full whitespace-normal"
          leftIcon={<Clock className="h-4 w-4" />}
        >
          {t('plans.downgrade.scheduledButton', {
            date: fmtDate(scheduled.effectiveDate, locale) ?? '—',
          })}
        </Button>
      );
    } else if (currentPool !== null && pool !== currentPool) {
      const up = pool > currentPool;
      cta = (
        <Button
          variant={up && isRecommended ? 'primary' : 'secondary'}
          size="sm"
          className="w-full"
          disabled={!canManage}
          aria-describedby={describedBy}
          aria-haspopup="dialog"
          onClick={() => openChange(up ? 'upgrade' : 'downgrade')}
        >
          {up
            ? t('plans.upgrade.cta', { plan: plan.name })
            : t('plans.downgrade.cta', { plan: plan.name })}
        </Button>
      );
    } else {
      cta = null;
    }
  } else {
    const priceKey = prices[cadence].priceLookupKey;
    cta = (
      <Button
        variant={isRecommended ? 'primary' : 'secondary'}
        size="sm"
        className="w-full"
        disabled={!canManage}
        loading={redirecting}
        onClick={() => checkout(priceKey)}
      >
        {isRecommended
          ? t('plans.ctaUpgrade', { plan: plan.name })
          : t('plans.ctaChoose', { plan: plan.name })}
      </Button>
    );
  }

  // Per-tier copy (keyed by plan.key in messages; arrays via t.raw). The cumulative
  // "Everything in {prev}, plus" lead shows only on tiers that name a `prev`.
  const tierBase = `plans.tiers.${plan.key}`;
  const features = pool ? [] : ((t.raw(`${tierBase}.features`) as string[] | undefined) ?? []);
  const hasPrev =
    plan.key === 'pro' || plan.key === 'max' || plan.key === 'max_x2' || plan.key === 'host';
  // The bundled Motir seat (8.1.22): every paid plan includes its catalog count of
  // tracker seats at no charge (MOTIR-8394 reads it, never a typed 1).
  const seatIncluded = plan.includedTrackerSeats > 0;
  const ladder = pool ? null : ladderLine(plan, previous, t);

  return (
    <div
      data-marked={marked || undefined}
      aria-current={marked ? 'true' : undefined}
      className={`flex ${solo ? 'w-full max-w-[22rem]' : 'grow basis-0'} shrink-0 snap-start flex-col gap-2 rounded-(--radius-card) border bg-(--el-surface) p-(--spacing-card-padding) shadow-(--shadow-card)`}
      style={{
        minWidth: '10rem',
        borderColor: accent ? 'var(--el-accent)' : 'var(--el-border-soft)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-sans text-base font-semibold text-(--el-text)">
          {accentIcon}
          {plan.name}
        </span>
        {isCurrent ? (
          <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
            {t('plans.current')}
          </Pill>
        ) : isRecommended ? (
          <Pill className="bg-(--el-tint-lavender) text-(--el-text-strong) border-transparent">
            {t('plans.recommended')}
          </Pill>
        ) : null}
        {marked ? (
          <Pill className="bg-(--el-tint-sky) text-(--el-text-strong) border-transparent">
            {t('calculator.marked')}
          </Pill>
        ) : null}
      </div>
      {isCurrent && pendingDowngrade ? (
        // NEUTRAL on purpose: every tint on this surface already means a status.
        <Pill
          data-testid="plan-pending-downgrade"
          className="w-fit gap-1 border-(--el-border-strong) bg-(--el-surface) text-(--el-text-strong)"
        >
          <Clock className="h-3 w-3" aria-hidden />
          {t('plans.downgrade.pendingPill', {
            plan: planNames[pendingDowngrade.planKey] ?? pendingDowngrade.planKey,
            date: fmtDate(pendingDowngrade.effectiveDate, locale) ?? '—',
          })}
        </Pill>
      ) : null}
      {/* per-tier use-case — min-height keeps the price rows aligned across cards */}
      {pool ? null : (
        <p className="min-h-[2.75rem] font-sans text-xs text-(--el-text-secondary)">
          {t(`${tierBase}.useCase`)}
        </p>
      )}
      {priceBlock}
      {plan.allotment ? (
        <p className="font-sans text-sm font-semibold text-(--el-text-strong)">
          {t(
            plan.allotment.cadence === 'one_time'
              ? 'plans.creditsAllotmentOneTime'
              : 'plans.creditsAllotment',
            { n: fmt(plan.allotment.credits, locale) },
          )}
        </p>
      ) : null}
      {/* the ladder line (MOTIR-7598): how this pool relates to the rung below */}
      {ladder ? (
        <p data-testid="plan-ladder" className="font-sans text-[11.5px] text-(--el-text-secondary)">
          {ladder}
        </p>
      ) : null}
      {/* bundled Motir seat (8.1.22) */}
      {seatIncluded ? (
        <p
          data-testid="plan-included-seat"
          className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)"
        >
          <Users className="h-3.5 w-3.5 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
          {t('plans.seatIncluded', { count: plan.includedTrackerSeats })}
        </p>
      ) : null}
      {/* cumulative feature list */}
      <ul className="flex flex-col gap-1.5 font-sans text-xs text-(--el-text-secondary)">
        {hasPrev ? (
          <li className="flex items-center gap-1.5 font-medium">
            <Check className="h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
            {t('plans.everythingIn', { prev: t(`${tierBase}.prev`) })}
          </li>
        ) : null}
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {cta ? <div className="mt-auto pt-1">{cta}</div> : null}
    </div>
  );
}

// "Need more credits?" (MOTIR-8997; design/billing § "Amendment 2026-10-21 — the
// larger credit pool plan", panels 1 and 9): the plans view's ONE way into the
// Calculator, which offers and sells a larger pool sized to the estimate. A pool
// holder reads it worded for the pool they hold.
function NeedMoreCredits({
  held,
  topRung,
  openCalculator,
  t,
}: {
  held: AiPlanCatalogEntry | null;
  topRung: AiPlanCatalogEntry | null;
  openCalculator: () => void;
  t: T;
}) {
  const locale = useLocale();
  return (
    <Card tint="sky" data-testid="plans-need-more">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex max-w-prose flex-col gap-1">
          <p className="font-sans text-sm font-semibold text-(--el-text-strong)">
            {t('plans.needMore.title')}
          </p>
          <p className="font-sans text-sm text-(--el-text-strong)">
            {held
              ? t('plans.needMore.bodyHeld', { credits: fmt(held.allotment?.credits ?? 0, locale) })
              : t('plans.needMore.body', {
                  plan: topRung?.name ?? '',
                  credits: fmt(topRung?.allotment?.credits ?? 0, locale),
                })}
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={openCalculator}
          leftIcon={<Calculator className="h-4 w-4" />}
        >
          {t('plans.needMore.action')}
        </Button>
      </div>
    </Card>
  );
}

// The ladder line (MOTIR-7598; design billing § MOTIR-7596): the first paid rung
// says every plan prices a credit the same; each later rung says how many times
// the rung below's pool it holds. The multiple is computed from the catalog's
// pools, never typed, and shown only when it is whole — a fractional "2.5×"
// would read as a different price per credit, which it is not.
export function ladderLine(
  plan: AiPlanCatalogEntry,
  previous: AiPlanCatalogEntry | null,
  t: T,
): string | null {
  if (!previous) return t('plans.ladder.first');
  const pool = plan.allotment?.credits;
  const below = previous.allotment?.credits;
  if (!pool || !below) return null;
  const multiple = pool / below;
  if (!Number.isInteger(multiple)) return null;
  return t('plans.ladder.multiple', { multiple, plan: previous.name });
}

// The free-trial strip (MOTIR-7598; design billing § MOTIR-7596, revision 2).
// Free is not a plan: an org on the one-time trial grant is told so in one
// bordered line above the card row — how much of the grant is left, or that it
// is spent — instead of being shown a Free card to "choose".
function FreeTrialStrip({ left, granted, t }: { left: number; granted: number; t: T }) {
  const locale = useLocale();
  const remaining = Math.max(0, left);
  const spent = remaining === 0;
  return (
    <p
      data-testid="plan-free-trial"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) font-sans text-[12.5px] text-(--el-text-secondary)"
    >
      <Pill
        className={`border-transparent text-(--el-text-strong) ${spent ? 'bg-(--el-surface)' : 'bg-(--el-tint-sky)'}`}
      >
        {spent ? t('plans.trial.pillUsed') : t('plans.trial.pill')}
      </Pill>
      <span>
        {spent
          ? `${t('plans.trial.spent', { n: fmt(granted, locale) })} ${t('plans.trial.pickPlan')}`
          : `${t('plans.trial.left', {
              left: fmt(remaining, locale),
              n: fmt(granted, locale),
            })} ${t('trial.note')}`}
      </span>
    </p>
  );
}

// Credit top-up (one-time overage purchase). The checkout route forwards only the
// price lookup key; Stripe collects the quantity on its hosted page, so the bundle
// selector below sets the user's INTENT (and the CTA total) while the boundary
// starts a `credit_topup` Checkout. Owner-only and gated to a paid AI plan (ADR §2).
function TopupCard({
  data,
  t,
  canManage,
  paidActive,
  checkout,
  redirecting,
}: {
  data: BillingStatusDTO;
  t: T;
  canManage: boolean;
  paidActive: boolean;
  checkout: (priceLookupKey: string, quantity?: number) => void;
  redirecting: boolean;
}) {
  const locale = useLocale();
  // `bundleUnits` comes from the catalog, so the sizes the label prices and the
  // sizes `startCheckout` will accept are the SAME list (MOTIR-2949). A local
  // `[1, 5, 10]` here is a set the service knows nothing about.
  const { unitCredits, unitAmountUsd, priceLookupKey, bundleUnits } = data.catalog.creditTopup;
  const [units, setUnits] = useState(bundleUnits[0] ?? 1);
  const credits = units * unitCredits;
  const total = units * unitAmountUsd;
  const enabled = canManage && paidActive;

  return (
    <Card
      header={
        <div className="flex items-center gap-2">
          <Coins className="h-4 w-4 text-(--el-text-muted)" aria-hidden />
          <div>
            <h3 className="font-sans text-base font-semibold text-(--el-text)">
              {t('topup.title')}
            </h3>
            <p className="font-sans text-xs text-(--el-text-muted)">{t('topup.subtitle')}</p>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="font-sans text-sm text-(--el-text)">
          {t('topup.balance', { n: fmt(Math.max(0, data.motirAi.balance), locale) })}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('topup.title')}>
          {bundleUnits.map((u) => {
            const selected = u === units;
            return (
              <button
                key={u}
                type="button"
                disabled={!enabled}
                onClick={() => setUnits(u)}
                aria-pressed={selected}
                className="flex flex-col items-start gap-0.5 rounded-(--radius-control) border px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-left disabled:opacity-50"
                style={{
                  borderColor: selected ? 'var(--el-accent)' : 'var(--el-border)',
                  backgroundColor: selected ? 'var(--el-surface)' : 'transparent',
                }}
              >
                <span className="font-sans text-sm font-medium text-(--el-text)">
                  {t('topup.bundleCredits', { n: fmt(u * unitCredits, locale) })}
                </span>
                <span className="font-sans text-xs text-(--el-text-muted)">
                  {t('topup.bundlePrice', { n: u * unitAmountUsd })}
                </span>
              </button>
            );
          })}
        </div>
        {enabled ? (
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={redirecting}
              onClick={() => checkout(priceLookupKey, units)}
            >
              {t('topup.buy', { n: fmt(credits, locale), total: fmt(total, locale) })}
            </Button>
          </div>
        ) : null}
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('topup.rate', { unit: unitAmountUsd, credits: fmt(unitCredits, locale) })}
        </p>
        {!paidActive ? (
          <div className="flex items-start gap-2 rounded-(--radius-card) border border-dashed border-(--el-border-strong) bg-(--el-surface-soft) p-(--spacing-card-padding)">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
            <p className="font-sans text-xs text-(--el-text-secondary)">{t('topup.gate')}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel 6 — Motir (seats) plan & upgrade screen
function SeatsView({
  data,
  t,
  canManage,
  orgName,
  memberCount,
  checkout,
  portal,
  redirecting,
  back,
}: SharedViewProps & { back: () => void }) {
  const locale = useLocale();
  const sub = data.motir.scaledTrackerSubscription;
  const scaled = sub?.status === 'active';
  const seat = data.catalog.seatPlan.prices;
  const annualSeat = seat.annual.amountUsd;
  const monthlySeat = seat.monthly.amountUsd;
  // A PAID Motir AI plan bundles the first seat (8.1.22 / 8.1.25): the org is
  // billed for members BEYOND the included one, so the seat totals net it out.
  const aiIncludedSeat = data.motir.aiIncludedSeat;
  const billableSeats = aiIncludedSeat ? Math.max(0, memberCount - 1) : memberCount;
  const annualTotal = billableSeats * annualSeat;
  const monthlyTotal = billableSeats * monthlySeat;
  const annualMoEquiv = Math.round(annualTotal / 12);
  const annualSave = monthlyTotal * 12 - annualTotal;
  const renews = fmtDate(sub?.currentPeriodEnd ?? null, locale);

  // Checkout-screen cadence (the non-scaled upgrade flow), default annual — drives
  // the total line, the terms rows, the CTA, and the seat price Checkout starts on
  // (8.1.16). The scaled branch shows the EXISTING subscription, so it has no toggle.
  const [cadence, setCadence] = useState<BillingCadence>('annual');
  const isAnnual = cadence === 'annual';

  return (
    <>
      <header className="flex flex-col gap-1">
        <button
          type="button"
          onClick={back}
          className="flex w-fit items-center gap-1 font-sans text-xs text-(--el-link) hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {t('seats.back')}
        </button>
        <p className="font-sans text-xs text-(--el-text-muted)">
          {t('seats.breadcrumb', { org: orgName })}
        </p>
      </header>

      {aiIncludedSeat ? (
        <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-mint) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t('seats.includedSeatNote', { n: billableSeats })}
        </p>
      ) : null}

      {scaled ? (
        <Card
          header={
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-(--height-control-28) w-7 items-center justify-center rounded-(--radius-control) bg-(--el-tint-mint) text-(--el-text-strong)">
                  <Layers className="h-4 w-4" aria-hidden />
                </span>
                <div>
                  <h2 className="font-sans text-base font-semibold text-(--el-text)">
                    {t('motir.name')}
                  </h2>
                  <p className="font-sans text-xs text-(--el-text-muted)">{t('seats.scaledSub')}</p>
                </div>
              </div>
              <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                <Check className="h-3 w-3" aria-hidden />
                {t('status.active')}
              </Pill>
            </div>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                  {t('motir.scaled')}
                </Pill>
                <span className="font-sans text-sm text-(--el-text)">
                  {t('seats.seatsCount', { n: memberCount })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-sans text-sm font-medium text-(--el-text-strong)">
                  {t('seats.planFeeYr', { yr: fmt(annualTotal, locale) })}
                </span>
                {annualSave > 0 ? (
                  <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                    {t('seats.annualSaves', { n: fmt(annualSave, locale) })}
                  </Pill>
                ) : null}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('seats.seatsBilled', { n: memberCount })}
              </span>
              <span className="ml-auto font-serif text-base text-(--el-text)">
                {t('seats.annualTotal', {
                  n: memberCount,
                  seat: annualSeat,
                  total: fmt(annualTotal, locale),
                })}
              </span>
            </div>
            <p className="font-sans text-xs text-(--el-text-muted)">
              {t('seats.scaledDesc', { mo: annualMoEquiv, date: renews ?? '—' })}
            </p>
            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/settings/organization/members"
                  className={buttonVariants({ variant: 'secondary', size: 'sm' })}
                >
                  <Users className="h-4 w-4" aria-hidden />
                  {t('seats.manageSeats')}
                </Link>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={portal}
                  loading={redirecting}
                  leftIcon={<ExternalLink className="h-4 w-4" />}
                >
                  {t('plans.managePlan')}
                </Button>
                <button
                  type="button"
                  onClick={portal}
                  className="font-sans text-sm text-(--el-link) hover:underline"
                >
                  {t('seats.switchMonthly')}
                </button>
              </div>
            ) : null}
          </div>
        </Card>
      ) : (
        <Card
          header={
            <div>
              <h2 className="font-sans text-base font-semibold text-(--el-text)">
                {t('seats.title')}
              </h2>
              <p className="font-sans text-xs text-(--el-text-muted)">{t('seats.subtitle')}</p>
            </div>
          }
        >
          <div className="mx-auto flex max-w-[34rem] flex-col gap-4">
            <div className="flex items-center gap-3">
              <Segmented<BillingCadence>
                label={t('plans.cadenceLabel')}
                value={cadence}
                onChange={setCadence}
                options={[
                  { value: 'monthly', label: t('plans.monthly') },
                  { value: 'annual', label: t('plans.annual') },
                ]}
              />
              {isAnnual && annualSave > 0 ? (
                <Pill className="bg-(--el-tint-mint) text-(--el-text-strong) border-transparent">
                  {t('seats.annualSaves', { n: fmt(annualSave, locale) })}
                </Pill>
              ) : null}
            </div>
            <div className="flex items-center gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding)">
              <AvatarCluster count={memberCount} />
              <span className="font-sans text-sm text-(--el-text)">
                {t('seats.membersToSeats', { n: memberCount })}
              </span>
              <span className="ml-auto font-serif text-lg text-(--el-text)">
                {isAnnual
                  ? t('seats.annualTotal', {
                      n: memberCount,
                      seat: annualSeat,
                      total: fmt(annualTotal, locale),
                    })
                  : t('seats.monthlyTotal', {
                      n: memberCount,
                      seat: monthlySeat,
                      total: fmt(monthlyTotal, locale),
                    })}
              </span>
            </div>

            <dl className="flex flex-col gap-2 rounded-(--radius-card) border border-(--el-border-soft) p-(--spacing-card-padding)">
              <p className="font-sans text-sm font-semibold text-(--el-text)">
                {t('seats.termsTitle')}
              </p>
              <TermRow
                k={t('seats.termBilling')}
                v={
                  isAnnual
                    ? t('seats.termBillingValue', {
                        yr: fmt(annualTotal, locale),
                        mo: annualMoEquiv,
                      })
                    : t('seats.termBillingValueMonthly', { mo: fmt(monthlyTotal, locale) })
                }
              />
              <TermRow
                k={t('seats.termDueToday')}
                v={
                  isAnnual
                    ? t('seats.termDueTodayValue', { yr: fmt(annualTotal, locale) })
                    : t('seats.termDueTodayValueMonthly', { mo: fmt(monthlyTotal, locale) })
                }
              />
              <TermRow k={t('seats.termAddMember')} v={t('seats.termAddMemberValue')} />
              <TermRow k={t('seats.termRemoveMember')} v={t('seats.termRemoveMemberValue')} />
            </dl>

            <p className="font-sans text-xs text-(--el-text-muted)">{t('seats.prorationNote')}</p>

            {canManage ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  size="md"
                  loading={redirecting}
                  onClick={() => checkout(seat[cadence].priceLookupKey)}
                >
                  {isAnnual
                    ? t('seats.continueCheckout', { yr: fmt(annualTotal, locale) })
                    : t('seats.continueCheckoutMonthly', { mo: fmt(monthlyTotal, locale) })}
                </Button>
                <Button variant="ghost" size="md" onClick={back}>
                  {t('seats.cancel')}
                </Button>
              </div>
            ) : null}
          </div>
        </Card>
      )}
    </>
  );
}

function TermRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-(--el-border-soft) pt-2 first:border-t-0 first:pt-0 sm:flex-row sm:gap-3">
      <dt className="font-sans text-xs font-medium text-(--el-text-secondary) sm:w-40 sm:shrink-0">
        {k}
      </dt>
      <dd className="font-sans text-xs text-(--el-text-muted)">{v}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared chrome
function ReturnBanner({
  kind,
  onClose,
  t,
}: {
  kind: 'success' | 'cancel';
  onClose: () => void;
  t: T;
}) {
  const isSuccess = kind === 'success';
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-(--radius-card) p-(--spacing-card-padding) ${isSuccess ? 'bg-(--el-tint-sky)' : 'bg-(--el-surface-soft)'}`}
    >
      {isSuccess ? (
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-strong)" aria-hidden />
      ) : (
        <X className="mt-0.5 h-4 w-4 shrink-0 text-(--el-text-muted)" aria-hidden />
      )}
      <p className="flex-1 font-sans text-xs text-(--el-text-strong)">
        {isSuccess ? t('states.checkoutPending') : t('states.checkoutCanceled')}
      </p>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('states.retry')}
        className="text-(--el-text-muted) hover:text-(--el-text)"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}

// Panel 8b — loading skeleton.
function BillingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <span className="block h-(--height-control-28) w-1/3 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <span className="block h-4 w-1/4 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="mt-3 block h-3 w-3/5 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
          <span className="mt-3 block h-2 w-full animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        </Card>
      ))}
    </div>
  );
}
