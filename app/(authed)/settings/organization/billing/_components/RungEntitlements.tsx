'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { largerPoolPlans, type AiPlanCatalogEntry } from '@/lib/billing/catalog';

// The rung entitlement lines (MOTIR-9654; design/billing § "Amendment 2026-10-26 — the
// larger pools above Host", panels 2–5 and 9): what a larger pool on sale brings — three
// AWS accounts of the org's own, and Max's limits on the shared pools until their quotas
// are granted. Static copy in the Host entitlement lines' register: it reads no account
// state, so it never says an account is ready or pending (that is the org admin view's).
// Shared by the Calculator's offer card and the held rung card so the two never drift.

/**
 * A rung the catalog sells: a `larger_pool` entry `largerPoolPlans()` lists. Decided
 * from that one definition, never from `band` alone or a typed key list.
 */
export function isOnSaleRung(plan: Pick<AiPlanCatalogEntry, 'key' | 'band'>): boolean {
  return plan.band === 'larger_pool' && largerPoolPlans().some((p) => p.key === plan.key);
}

export function RungEntitlements({
  plan,
  testId = 'rung-entitlements',
}: {
  plan: Pick<AiPlanCatalogEntry, 'key' | 'band'>;
  testId?: string;
}) {
  const t = useTranslations('billing');
  if (!isOnSaleRung(plan)) return null;
  return (
    <ul
      data-testid={testId}
      className="flex flex-col gap-1.5 font-sans text-xs text-(--el-text-secondary)"
    >
      {(['ownAccounts', 'sharedUntilGranted'] as const).map((line) => (
        <li key={line} className="flex items-start gap-1.5">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-success)" aria-hidden />
          <span>{t(`plans.larger.${line}`)}</span>
        </li>
      ))}
    </ul>
  );
}
