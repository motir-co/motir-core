'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Flag,
  Hourglass,
  Mail,
  MailX,
  RotateCw,
  Send,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { Tooltip } from '@/components/ui/Tooltip';
import { useToast } from '@/components/ui/Toast';
import type { InviteDeliveryState, PendingInviteDTO } from '@/lib/dto/invites';
import { resendInviteAction } from '../actions';

// The Members card's Pending invitations block (MOTIR-9997), drawn in
// `design/settings/members-pending-invitations--pending-list.mock.html`. The
// hosts pass invites only to a viewer who may invite, and each row's
// `canResend` comes from the server — this file holds no scope rule of its own.

/** Rows shown before the block collapses behind "Show all" (design panel 7). */
const COLLAPSED_ROWS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type Tone = { severity: 'info' | 'success' | 'warning' | 'danger' } | { tone: 'neutral' };

/**
 * How each delivery state is drawn. Total over `InviteDeliveryState` with no
 * fallback, so an eighth state fails typecheck here rather than rendering blank.
 * `problem` states put Resend in the secondary variant, so the fix is the
 * louder control on the rows that need it.
 */
const DELIVERY: Record<InviteDeliveryState, { pill: Tone; Icon: LucideIcon; problem: boolean }> = {
  queued: { pill: { tone: 'neutral' }, Icon: Clock, problem: false },
  // The provider has it — NOT delivered, so never the success tone.
  accepted: { pill: { severity: 'info' }, Icon: Send, problem: false },
  delivered: { pill: { severity: 'success' }, Icon: CheckCircle2, problem: false },
  bounced: { pill: { severity: 'danger' }, Icon: MailX, problem: true },
  complained: { pill: { severity: 'danger' }, Icon: Flag, problem: true },
  delayed: { pill: { severity: 'warning' }, Icon: Hourglass, problem: false },
  failed: { pill: { severity: 'danger' }, Icon: XCircle, problem: true },
};

/** A Resend refusal's message key, by the action's `code`. */
function refusalFor(code: string | undefined): {
  title: string;
  description?: string;
  refresh: boolean;
} {
  switch (code) {
    case 'RATE_LIMITED':
      return {
        title: 'members.pending.refusalRateLimited',
        description: 'members.pending.refusalRateLimitedBody',
        refresh: false,
      };
    case 'ALREADY_MEMBER':
      return { title: 'members.pending.refusalAlreadyMember', refresh: true };
    case 'INVITE_EXPIRED_OR_MISSING':
      return { title: 'members.pending.refusalNoLongerPending', refresh: true };
    case 'INVITE_NOT_ALLOWED_FOR_SCOPE':
    case 'INVITE_SCOPE_FORBIDDEN':
    case 'NOT_A_MEMBER':
      return { title: 'members.pending.refusalNotAllowed', refresh: false };
    default:
      return { title: 'members.errorUnexpected', refresh: false };
  }
}

export function PendingInvitesSection({ invites }: { invites: PendingInviteDTO[] }) {
  const t = useTranslations('settings');
  const [expanded, setExpanded] = useState(false);
  if (invites.length === 0) return null;

  const collapsible = invites.length > COLLAPSED_ROWS;
  const shown = collapsible && !expanded ? invites.slice(0, COLLAPSED_ROWS) : invites;

  return (
    <section
      className="border-(--el-border-soft) mt-4 border-t pt-4"
      aria-labelledby="pending-invitations-heading"
      data-testid="pending-invitations"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3
          id="pending-invitations-heading"
          className="font-sans text-sm font-semibold text-(--el-text)"
        >
          {t('members.pending.heading')}
        </h3>
        <Pill tone="neutral">{invites.length}</Pill>
      </div>
      <div
        className="border-(--el-border-soft) text-(--el-text-secondary) hidden items-center gap-3 border-b pb-2 font-mono text-[11px] uppercase tracking-wider sm:flex"
        aria-hidden
      >
        <span className="flex-1 pl-11">{t('members.pending.invitationColumn')}</span>
        <span className="w-[6.75rem]">{t('members.pending.deliveryColumn')}</span>
        <span className="w-[5.5rem]" />
      </div>
      <ul role="list" className="flex flex-col">
        {shown.map((invite) => (
          <PendingRow key={invite.id} invite={invite} />
        ))}
      </ul>
      {collapsible ? (
        <div className="pt-2">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            rightIcon={
              expanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )
            }
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded
              ? t('members.pending.showFewer')
              : t('members.pending.showAll', { count: invites.length })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function PendingRow({ invite }: { invite: PendingInviteDTO }) {
  const t = useTranslations('settings');
  const format = useFormatter();
  const now = useNow();
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  const sentAt = new Date(invite.sentAt);
  const expiresAt = new Date(invite.expiresAt);
  const sent = format.dateTime(sentAt, { month: 'short', day: 'numeric' });
  const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
  const lastDay = daysLeft < 1;
  const scope =
    invite.accessScope === 'full'
      ? t('members.scope.full')
      : `${t('members.scope.limited')} · ${t('members.projectCount', { count: invite.projectCount })}`;

  function handleResend() {
    startTransition(async () => {
      const result = await resendInviteAction(invite.id);
      if (result.ok) {
        toast({
          variant: 'success',
          title: t('members.pending.resentToast', { email: invite.email }),
        });
        router.refresh();
        return;
      }
      const refusal = refusalFor(result.code);
      toast({
        variant: 'error',
        title: t(refusal.title),
        ...(refusal.description ? { description: t(refusal.description) } : {}),
      });
      if (refusal.refresh) router.refresh();
    });
  }

  const delivery = DELIVERY[invite.deliveryState];
  const resend = (
    <Button
      variant={delivery.problem ? 'secondary' : 'ghost'}
      size="sm"
      leftIcon={<RotateCw className="h-3.5 w-3.5" />}
      loading={isPending}
      disabled={isPending || !invite.canResend}
      onClick={handleResend}
      aria-label={t('members.pending.resendLabel', { email: invite.email })}
    >
      {t('members.pending.resend')}
    </Button>
  );

  return (
    <li
      className="border-(--el-border-soft) flex items-center gap-3 border-b py-3 last:border-b-0"
      data-testid={`pending-invite-${invite.id}`}
    >
      <span
        className="border-(--el-border-strong) text-(--el-text-secondary) hidden h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed sm:inline-flex"
        aria-hidden
      >
        <Mail className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <Tooltip content={invite.email}>
          <p className="truncate font-sans text-sm font-medium text-(--el-text)" tabIndex={0}>
            {invite.email}
          </p>
        </Tooltip>
        <p className="text-(--el-text-secondary) flex min-w-0 items-center gap-1 font-sans text-xs">
          <span className="truncate">
            {invite.invitedBy.name
              ? t('members.pending.invitedBy', { name: invite.invitedBy.name, sent })
              : t('members.pending.invitedByFormer', { sent })}
            {' · '}
            {scope}
            {' · '}
          </span>
          <Tooltip
            content={t('members.pending.expiresOn', {
              date: format.dateTime(expiresAt, { dateStyle: 'medium', timeStyle: 'short' }),
            })}
          >
            <span
              tabIndex={0}
              className={`inline-flex shrink-0 items-center gap-1 ${lastDay ? 'text-(--el-text)' : ''}`}
            >
              {lastDay ? (
                <Clock className="text-(--el-warning) h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : null}
              {lastDay
                ? t('members.pending.expiresToday')
                : t('members.pending.expiresIn', { count: daysLeft })}
            </span>
          </Tooltip>
        </p>
      </div>
      <div className="shrink-0 sm:w-[6.75rem]">
        <DeliveryPill state={invite.deliveryState} />
      </div>
      <div className="flex w-[5.5rem] shrink-0 justify-end">
        {invite.canResend ? (
          resend
        ) : (
          <Tooltip content={t('members.pending.resendScopeTooltip')}>
            <span tabIndex={0}>{resend}</span>
          </Tooltip>
        )}
      </div>
    </li>
  );
}

function DeliveryPill({ state }: { state: InviteDeliveryState }) {
  const t = useTranslations('settings');
  const { pill, Icon } = DELIVERY[state];
  return (
    <Tooltip content={t(`members.pending.delivery.${state}.helper`)}>
      <span tabIndex={0} className="inline-flex" data-delivery={state}>
        <Pill {...pill}>
          <Icon className="h-3 w-3 shrink-0" aria-hidden />
          {t(`members.pending.delivery.${state}.label`)}
        </Pill>
      </span>
    </Tooltip>
  );
}
