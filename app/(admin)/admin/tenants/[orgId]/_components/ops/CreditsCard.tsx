'use client';

import { useRef, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Coins, Pencil, Plus, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type {
  PlatformCreditLedgerEntryDTO,
  PlatformCreditLedgerPageDTO,
} from '@/lib/dto/platformCreditOps';
import { loadCreditLedgerPageAction } from '../../creditActions';
import { AdjustCreditsDialog, ChangePlanDialog, GrantCreditsDialog } from './CreditDialogs';

/**
 * CREDITS & PLAN — design `platform-admin` AMENDMENT 2026-10-03 Panels 1, 2, 8b,
 * 8d (MOTIR-752; the reads and writes are MOTIR-747's `creditActions.ts`).
 *
 * ⚠️ A CLIENT ISLAND THAT OWNS ITS LEDGER PAGE. Newer / Older page the ledger in
 * place through `loadCreditLedgerPageAction`, so the page the island shows lives
 * in `useState` — which a `router.refresh()` cannot reach (CLAUDE.md's page-state
 * contract, case 3). So every write made from INSIDE this island refetches the
 * newest page itself once it lands; the server-rendered rest of the tab (the
 * audit slice) re-reads through the action's `revalidatePath`. Reads are
 * seq-guarded: a slow older page can never overwrite a newer answer.
 *
 * ⚠️ AN UNREACHABLE CREDIT SERVICE IS A STATE, NEVER A ZERO (Panel 8b). `initial`
 * is null when the server read failed; the card then says so and offers Retry,
 * and draws no balance at all.
 */
export interface CreditsCardProps {
  orgId: string;
  orgName: string;
  slug: string;
  /** The org pays for its AI plan through Stripe — the plan dialog warns (Panel 2d). */
  paysThroughStripe: boolean;
  /** The paid-AI-plan gate counts this org as paid — when not, the plan dialog
   *  says a tier will not change that (MOTIR-8985). */
  countsAsPaid: boolean;
  canWrite: boolean;
  /** The newest ledger page, or null when the credit service did not answer. */
  initial: PlatformCreditLedgerPageDTO | null;
}

type Dialog = 'grant' | 'adjust' | 'plan' | null;

export function CreditsCard({
  orgId,
  orgName,
  slug,
  paysThroughStripe,
  countsAsPaid,
  canWrite,
  initial,
}: CreditsCardProps) {
  const t = useTranslations('platformAdmin.ops');
  const format = useFormatter();
  const { toast } = useToast();
  const [data, setData] = useState<PlatformCreditLedgerPageDTO | null>(initial);
  // The cursors that produced the pages BEHIND the current one: Older pushes the
  // current page's cursor, Newer pops it. Empty = the newest page.
  const [stack, setStack] = useState<(string | null)[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loading, startLoading] = useTransition();
  const seq = useRef(0);

  function load(nextCursor: string | null, nextStack: (string | null)[]) {
    const mine = ++seq.current;
    startLoading(async () => {
      const result = await loadCreditLedgerPageAction(orgId, nextCursor);
      if (mine !== seq.current) return;
      if (result.ok) {
        setData(result.result);
        setCursor(nextCursor);
        setStack(nextStack);
        return;
      }
      if (result.code === 'CREDIT_SERVICE_UNREACHABLE') {
        setData(null);
        return;
      }
      toast({ variant: 'error', title: t('failedTitle'), description: t(`error.${result.code}`) });
    });
  }

  /** After a write landed: the newest page, so the new row is the first one. */
  function refreshNewest() {
    load(null, []);
  }

  const header = (
    <div className="flex flex-col gap-1">
      <h2 className="flex items-center gap-2 font-sans text-sm font-semibold text-(--el-text)">
        <Coins aria-hidden className="h-4 w-4 text-(--el-success)" />
        {t('credits.title')}
      </h2>
      <p className="font-sans text-xs text-(--el-text-secondary)">{t('credits.subtitle')}</p>
    </div>
  );

  if (!data) {
    return (
      <Card header={header} data-testid="ops-credits">
        <ErrorState
          title={t('credits.error.title')}
          description={t('credits.error.body')}
          retry={() => refreshNewest()}
          retryPending={loading}
        />
      </Card>
    );
  }

  const tier = data.tier;
  const lastAssignment =
    data.explainsCurrentTier && data.lastTierAssignment ? data.lastTierAssignment : null;

  return (
    <Card header={header} data-testid="ops-credits">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <dl className="flex flex-wrap gap-8">
            <div className="flex flex-col gap-1">
              <dt className="font-sans text-xs text-(--el-text-secondary)">
                {t('credits.balance')}
              </dt>
              <dd
                className="font-serif text-2xl tabular-nums text-(--el-text)"
                data-testid="ops-balance"
              >
                {t('credits.amount', { n: format.number(data.balanceCredits) })}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-sans text-xs text-(--el-text-secondary)">{t('credits.plan')}</dt>
              <dd className="flex flex-col gap-1">
                <Pill severity="info" className="self-start">
                  {tier ? tier.name : t('credits.noPlan')}
                </Pill>
                {lastAssignment ? (
                  <span className="max-w-[28rem] font-sans text-xs text-(--el-text-secondary)">
                    {t('credits.lastPlanChange', {
                      operator: lastAssignment.actor.label,
                      at: format.dateTime(new Date(lastAssignment.at), { dateStyle: 'medium' }),
                      reason: lastAssignment.reason,
                    })}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Button
                leftIcon={<Plus aria-hidden className="h-4 w-4" />}
                onClick={() => setDialog('grant')}
              >
                {t('credits.grant')}
              </Button>
              <Button
                variant="secondary"
                leftIcon={<Pencil aria-hidden className="h-4 w-4" />}
                onClick={() => setDialog('adjust')}
              >
                {t('credits.adjust')}
              </Button>
              <Button
                variant="secondary"
                leftIcon={<Wallet aria-hidden className="h-4 w-4" />}
                onClick={() => setDialog('plan')}
              >
                {t('credits.changePlan')}
              </Button>
            </div>
          ) : null}
        </div>

        {data.entries.length === 0 && stack.length === 0 ? (
          <EmptyState
            icon={<Coins className="h-10 w-10" aria-hidden />}
            title={t('ledger.empty.title')}
            description={t('ledger.empty.body', { org: orgName })}
          />
        ) : (
          <LedgerTable entries={data.entries} busy={loading} />
        )}

        {stack.length > 0 || data.nextCursor ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={stack.length === 0 || loading}
              onClick={() => load(stack[stack.length - 1] ?? null, stack.slice(0, -1))}
            >
              {t('ledger.newer')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!data.nextCursor || loading}
              onClick={() => load(data.nextCursor, [...stack, cursor])}
            >
              {t('ledger.older')}
            </Button>
          </div>
        ) : null}
      </div>

      {dialog === 'grant' ? (
        <GrantCreditsDialog
          orgId={orgId}
          orgName={orgName}
          slug={slug}
          balance={data.balanceCredits}
          threshold={data.largeGrantThresholdCredits}
          onClose={() => setDialog(null)}
          onDone={refreshNewest}
        />
      ) : null}
      {dialog === 'adjust' ? (
        <AdjustCreditsDialog
          orgId={orgId}
          orgName={orgName}
          balance={data.balanceCredits}
          onClose={() => setDialog(null)}
          onDone={refreshNewest}
        />
      ) : null}
      {dialog === 'plan' ? (
        <ChangePlanDialog
          orgId={orgId}
          orgName={orgName}
          currentTier={tier}
          paysThroughStripe={paysThroughStripe}
          countsAsPaid={countsAsPaid}
          onClose={() => setDialog(null)}
          onDone={refreshNewest}
        />
      ) : null}
    </Card>
  );
}

/** A ledger kind's pill tone — grant reads as success, adjustment as caution. */
function kindPill(kind: string): { severity?: 'success' | 'warning' | 'info' } {
  if (kind === 'grant') return { severity: 'success' };
  if (kind === 'adjustment') return { severity: 'warning' };
  if (kind === 'top_up') return { severity: 'info' };
  return {};
}

/** Signed credits with the design's minus sign (U+2212). */
export function signedCredits(n: number, formatNumber: (n: number) => string): string {
  if (n > 0) return `+${formatNumber(n)}`;
  if (n < 0) return `−${formatNumber(-n)}`;
  return formatNumber(0);
}

function LedgerTable({
  entries,
  busy,
}: {
  entries: PlatformCreditLedgerEntryDTO[];
  busy: boolean;
}) {
  const t = useTranslations('platformAdmin.ops.ledger');
  const format = useFormatter();
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full font-sans text-sm"
        data-testid="ops-ledger"
        aria-busy={busy || undefined}
      >
        <thead>
          <tr className="text-left text-xs text-(--el-text-secondary)">
            <th className="py-1 pr-3 font-medium">{t('col.when')}</th>
            <th className="py-1 pr-3 font-medium">{t('col.kind')}</th>
            <th className="py-1 pr-3 text-right font-medium">{t('col.credits')}</th>
            <th className="py-1 pr-3 text-right font-medium">{t('col.balanceAfter')}</th>
            <th className="py-1 pr-3 font-medium">{t('col.by')}</th>
            <th className="py-1 font-medium">{t('col.reason')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-(--el-border) align-top">
              <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-(--el-text-secondary)">
                <time dateTime={e.at}>
                  {format.dateTime(new Date(e.at), { dateStyle: 'medium', timeStyle: 'short' })}
                </time>
              </td>
              <td className="py-2 pr-3">
                <Pill
                  {...kindPill(e.kind)}
                  tone={kindPill(e.kind).severity ? undefined : 'neutral'}
                >
                  {t.has(`kind.${e.kind}`) ? t(`kind.${e.kind}`) : e.kind}
                </Pill>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--el-text)">
                {signedCredits(e.credits, (n) => format.number(n))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-(--el-text)">
                {format.number(e.balanceAfter)}
              </td>
              <td className="py-2 pr-3 text-(--el-text-secondary)">{e.actor?.label ?? '—'}</td>
              <td className="py-2 text-(--el-text)">{e.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
