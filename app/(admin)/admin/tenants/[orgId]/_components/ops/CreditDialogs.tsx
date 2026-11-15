'use client';

import { useId, useState, useTransition } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { PlatformCreditTierDTO } from '@/lib/dto/platformCreditOps';
import {
  adjustCreditsAction,
  grantCreditsAction,
  setPlanAction,
  type CreditOpsFailureCode,
} from '../../creditActions';
import { adjustAmount, grantAmount, newRequestId } from './opsGate';
import { ReasonConfirmDialog } from './ReasonConfirmDialog';

/**
 * The CREDITS & PLAN dialogs — design `platform-admin` AMENDMENT 2026-10-03
 * Panel 2 (a) grant with the balance-after preview, (b) a large grant's typed
 * slug, (c) adjust with a signed amount that may not go below zero, (d) change
 * plan with the Stripe warning, (e) the reason gate, (f) the outcome toasts.
 * The plan dialog also says, before the admin confirms, when the org does not
 * count as a paid AI plan (bug MOTIR-8985): the tier it sets is never the
 * classification the fleet's paid-plan gate reads (`aiPlanGateService`).
 *
 * ⚠️ ONE `requestId` PER OPENING. It is minted when the dialog mounts and sent
 * again on a retry, so a retry after an unreachable answer can never grant
 * twice (`creditActions.ts`' header; motir-ai is idempotent on it). Closing the
 * dialog unmounts it, so the next opening is a new action with a new key.
 */

interface DialogBase {
  orgId: string;
  orgName: string;
  onClose: () => void;
  /** A write landed — the island refetches its newest ledger page. */
  onDone: () => void;
}

/** One toast per failure; the unreachable service has the design's own sentence. */
function useFailureToast() {
  const t = useTranslations('platformAdmin.ops');
  const { toast } = useToast();
  return (code: CreditOpsFailureCode) =>
    toast({
      variant: 'error',
      title:
        code === 'CREDIT_SERVICE_UNREACHABLE' ? t('result.creditUnreachable') : t('failedTitle'),
      description: code === 'CREDIT_SERVICE_UNREACHABLE' ? undefined : t(`error.${code}`),
    });
}

function BalanceAfter({ after, now }: { after: number | null; now: number }) {
  const t = useTranslations('platformAdmin.ops');
  const format = useFormatter();
  if (after === null) return null;
  return (
    <p
      className="font-sans text-sm tabular-nums text-(--el-text-secondary)"
      aria-live="polite"
      data-testid="ops-balance-after"
    >
      {t('balanceAfter', { after: format.number(after), now: format.number(now) })}
    </p>
  );
}

/** A caution in a dialog: the hue in the tint and the glyph, the words on strong ink. */
function Caution({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-xs text-(--el-text-strong)">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
      <span>{children}</span>
    </p>
  );
}

export function GrantCreditsDialog({
  orgId,
  orgName,
  slug,
  balance,
  threshold,
  onClose,
  onDone,
}: DialogBase & { slug: string; balance: number; threshold: number }) {
  const t = useTranslations('platformAdmin.ops');
  const format = useFormatter();
  const { toast } = useToast();
  const failure = useFailureToast();
  const [requestId] = useState(newRequestId);
  const [amount, setAmount] = useState('');
  const [pending, startTransition] = useTransition();
  const amountId = useId();
  // The reason and the slug live in the shared dialog; this reads only the
  // amount, and asks the dialog for the slug once the amount crosses the line.
  const gate = grantAmount(amount, threshold, balance);

  return (
    <ReasonConfirmDialog
      title={t('grant.title', { org: orgName })}
      description={t('grant.body')}
      confirmLabel={t('grant.confirm', { n: format.number(gate.credits ?? 0) })}
      typedSlug={gate.needsSlug ? slug : null}
      extraReady={gate.credits !== null}
      pending={pending}
      onCancel={onClose}
      onConfirm={(reason) =>
        startTransition(async () => {
          const credits = gate.credits;
          if (credits === null) return;
          const result = await grantCreditsAction(orgId, {
            credits,
            reason,
            requestId,
            confirmSlug: gate.needsSlug ? slug : null,
          });
          if (!result.ok) return failure(result.code);
          toast({
            variant: 'success',
            title: result.result.idempotent
              ? t('result.replayed')
              : t('result.granted', { n: format.number(credits), org: orgName }),
          });
          onClose();
          onDone();
        })
      }
    >
      <Input
        id={amountId}
        label={t('grant.amount')}
        inputMode="numeric"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        autoFocus
        data-testid="ops-amount"
      />
      <BalanceAfter after={gate.balanceAfter} now={balance} />
      {gate.needsSlug ? (
        <Caution>{t('grant.large', { threshold: format.number(threshold) })}</Caution>
      ) : null}
    </ReasonConfirmDialog>
  );
}

export function AdjustCreditsDialog({
  orgId,
  orgName,
  balance,
  onClose,
  onDone,
}: DialogBase & { balance: number }) {
  const t = useTranslations('platformAdmin.ops');
  const format = useFormatter();
  const { toast } = useToast();
  const failure = useFailureToast();
  const [requestId] = useState(newRequestId);
  const [amount, setAmount] = useState('');
  const [pending, startTransition] = useTransition();
  const amountId = useId();
  const gate = adjustAmount(amount, balance);
  const signed =
    gate.credits === null
      ? '0'
      : gate.credits > 0
        ? `+${format.number(gate.credits)}`
        : `−${format.number(-gate.credits)}`;

  return (
    <ReasonConfirmDialog
      title={t('adjust.title', { org: orgName })}
      description={t('adjust.body')}
      confirmLabel={t('adjust.confirm', { n: signed })}
      extraReady={gate.valid}
      pending={pending}
      onCancel={onClose}
      onConfirm={(reason) =>
        startTransition(async () => {
          const credits = gate.credits;
          if (credits === null) return;
          const result = await adjustCreditsAction(orgId, { credits, reason, requestId });
          if (!result.ok) return failure(result.code);
          toast({
            variant: 'success',
            title: result.result.idempotent
              ? t('result.replayed')
              : t('result.adjusted', { n: signed, org: orgName }),
          });
          onClose();
          onDone();
        })
      }
    >
      <Input
        id={amountId}
        label={t('adjust.amount')}
        helperText={t('adjust.hint')}
        error={gate.belowZero ? t('error.INSUFFICIENT_BALANCE') : undefined}
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        autoFocus
        data-testid="ops-amount"
      />
      <BalanceAfter after={gate.balanceAfter} now={balance} />
    </ReasonConfirmDialog>
  );
}

export function ChangePlanDialog({
  orgId,
  orgName,
  currentTier,
  paysThroughStripe,
  countsAsPaid,
  onClose,
  onDone,
}: DialogBase & {
  currentTier: PlatformCreditTierDTO | null;
  paysThroughStripe: boolean;
  /** The paid-AI-plan gate answered a definite yes for this org (a paying
   *  subscription, or Motir's own / internal billing). Anything else — no, or a
   *  read that did not answer — and the dialog warns that the tier alone will not
   *  make it paid. */
  countsAsPaid: boolean;
}) {
  const t = useTranslations('platformAdmin.ops');
  const format = useFormatter();
  const { toast } = useToast();
  const failure = useFailureToast();
  const [requestId] = useState(newRequestId);
  const [tierKey, setTierKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The plan ladder the storefront sells (`BILLING_CATALOG`) — the same keys as
  // motir-ai's `PlanTier`; motir-ai refuses a key it does not know (REJECTED). The
  // regular ladder only: a larger pool is bought from an estimate, never staff-set.
  const options: ComboboxOption<string>[] = BILLING_CATALOG.aiPlans
    .filter((plan) => plan.band === 'ladder')
    .map((plan) => ({
      value: plan.key,
      label: plan.name,
      secondary: !plan.allotment
        ? t('plan.allotmentCustom', { name: plan.name })
        : plan.allotment.cadence === 'monthly'
          ? t('plan.allotmentMonthly', {
              name: plan.name,
              credits: format.number(plan.allotment.credits),
            })
          : t('plan.allotmentOnce', {
              name: plan.name,
              credits: format.number(plan.allotment.credits),
            }),
    }));
  const chosen = BILLING_CATALOG.aiPlans.find((p) => p.key === tierKey) ?? null;

  return (
    <ReasonConfirmDialog
      title={t('plan.title', { org: orgName })}
      description={t('plan.body')}
      confirmLabel={t('plan.confirm', { tier: chosen?.name ?? '…' })}
      extraReady={chosen !== null}
      pending={pending}
      onCancel={onClose}
      onConfirm={(reason) =>
        startTransition(async () => {
          if (!chosen) return;
          const result = await setPlanAction(orgId, { tierKey: chosen.key, reason, requestId });
          if (!result.ok) return failure(result.code);
          toast({
            variant: 'success',
            title: result.result.changed
              ? t('result.planSet', { org: orgName, tier: result.result.tier.name })
              : t('result.planUnchanged', { org: orgName, tier: result.result.tier.name }),
          });
          onClose();
          onDone();
        })
      }
    >
      <p className="font-sans text-sm text-(--el-text-secondary)">
        {currentTier ? t('plan.current', { tier: currentTier.name }) : t('plan.currentNone')}
      </p>
      <Combobox
        label={t('plan.tier')}
        placeholder={t('plan.choose')}
        options={options}
        value={tierKey}
        onChange={setTierKey}
      />
      {paysThroughStripe ? <Caution>{t('plan.stripe', { org: orgName })}</Caution> : null}
      {countsAsPaid ? null : (
        <Caution>
          <span data-testid="ops-plan-not-paid">{t('plan.notPaid', { org: orgName })}</span>
        </Caution>
      )}
    </ReasonConfirmDialog>
  );
}
