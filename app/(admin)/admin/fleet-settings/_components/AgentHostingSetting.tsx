'use client';

import { useId, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { CircleAlert, Cloud, Info, Server } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Pill } from '@/components/ui/Pill';
import { Switch } from '@/components/ui/Switch';
import type { FleetKindSwitchStateDTO } from '@/lib/dto/fleetKindSwitch';
import { setAgentHostingAction } from '../actions';

/**
 * The AGENT HOSTING section — where NEW agent instances are created, Fly or the
 * agent-hoster AWS pool. Design `platform-admin/design-notes.md` § Fleet
 * settings · Agent hosting (MOTIR-9534), Panels 1–10; card MOTIR-9503.
 *
 * Composed in `FleetOrgCiSetting.tsx`'s grammar: the same `Card` header, the
 * same `Switch` + word chip + action word row, the same bands, the same
 * last-changed line and Monitoring footer.
 *
 * ⚠️ THIS ISLAND OWNS A DIALOG AND AN ANSWER, NEVER A STORED STATE. The switch,
 * the chip and the last-changed line are the server-rendered `state` prop.
 * Moving the switch opens the confirm; the switch keeps showing the stored state
 * until the action answers and `revalidatePath` re-reads the page.
 *
 * ⚠️ A WRITE THAT FAILED KEEPS THE DIALOG OPEN (design difference 2), with the
 * reason the superadmin typed, so they can retry — unlike the Motir-CI row,
 * which closes its dialog and reports on the page.
 */

export interface AgentHostingSettingProps {
  state: FleetKindSwitchStateDTO;
}

export function AgentHostingSetting({ state }: AgentHostingSettingProps) {
  const t = useTranslations('platformAdmin.fleetSettings.agentHosting');
  const format = useFormatter();
  const titleId = useId();
  const reasonFieldId = useId();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonRefused, setReasonRefused] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [already, setAlready] = useState<boolean | null>(null);
  const [isPending, startTransition] = useTransition();

  const { onPool } = state;
  const toAws = !onPool;
  const hoster = (aws: boolean) => t(aws ? 'state.aws' : 'state.fly');

  function closeConfirm() {
    setConfirming(false);
    setReason('');
    setReasonRefused(false);
    setWriteFailed(false);
  }

  function submit() {
    const trimmed = reason.trim();
    // Refused inline, before any action call; the server's
    // `MissingAuditReasonError` is the rule (Panel 6).
    if (!trimmed) {
      setReasonRefused(true);
      return;
    }
    const asked = toAws;
    setWriteFailed(false);
    startTransition(async () => {
      const result = await setAgentHostingAction(asked, trimmed);
      if (!result.ok && result.code === 'REASON_REQUIRED') {
        setReasonRefused(true);
        return;
      }
      if (!result.ok) {
        // Panel 9 — the dialog stays open and the reason is kept.
        setWriteFailed(true);
        return;
      }
      closeConfirm();
      // Panel 8 — another superadmin got there first; the page re-read shows it.
      setAlready(result.outcome === 'unchanged' ? result.onPool : null);
    });
  }

  const reasonEmpty = reason.trim().length === 0;

  return (
    <div data-testid="agent-hosting">
      <Card
        header={<AgentHostingHeader titleId={titleId} />}
        footer={
          <p className="flex items-center gap-2 font-sans text-xs">
            <Server aria-hidden className="h-3.5 w-3.5 shrink-0 text-(--el-icon-muted)" />
            <Link href="/admin/monitoring" className="text-(--el-link) underline">
              {t('monitoringLine')}
            </Link>
          </p>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
            {t('explanation')}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Switch
              checked={onPool}
              disabled={isPending}
              aria-labelledby={titleId}
              onCheckedChange={() => {
                setAlready(null);
                setConfirming(true);
              }}
            />
            {onPool ? (
              <Pill severity="info" data-testid="agent-hosting-state" data-state="aws">
                {t('state.aws')}
              </Pill>
            ) : (
              <Pill tone="neutral" data-testid="agent-hosting-state" data-state="fly">
                {t('state.fly')}
              </Pill>
            )}
            <span className="font-sans text-sm text-(--el-text-secondary)">
              {t(onPool ? 'action.turnOffAws' : 'action.turnOnAws')}
            </span>
          </div>

          {onPool ? (
            <Band tone="info" role="status" testId="agent-hosting-on-note">
              {t('onNote')}
            </Band>
          ) : null}

          {already !== null ? (
            <Band tone="info" role="status" testId="agent-hosting-answer">
              <strong className="font-semibold">
                {t(already ? 'refused.alreadyAws' : 'refused.alreadyFly')}
              </strong>{' '}
              {t('refused.alreadyBody')}
            </Band>
          ) : null}

          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 font-sans text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-(--el-text-secondary)">{t('meta.lastChanged')}</dt>
            <dd className="text-(--el-text)" data-testid="agent-hosting-last-changed">
              {state.updatedBy ? (
                <>
                  {t('meta.changedBy', {
                    email: state.updatedBy.email,
                    when: state.updatedAt ? format.relativeTime(new Date(state.updatedAt)) : '',
                    reason: state.lastReason ?? '',
                  })}{' '}
                  <Link
                    href={`/admin/audit-log?action=${onPool ? 'fleet.agent_hosting.enable' : 'fleet.agent_hosting.disable'}`}
                    className="text-(--el-link) underline"
                  >
                    {t('meta.auditLink')}
                  </Link>
                </>
              ) : (
                t('meta.neverChanged')
              )}
            </dd>
          </dl>
        </div>
      </Card>

      <Modal
        open={confirming}
        onOpenChange={(next) => (next ? undefined : closeConfirm())}
        role="alertdialog"
        title={t(toAws ? 'confirm.toAwsTitle' : 'confirm.toFlyTitle')}
        description={t(toAws ? 'confirm.toAwsBody' : 'confirm.toFlyBody')}
        size="md"
      >
        <Modal.Body className="gap-4">
          {writeFailed ? (
            <Band tone="danger" role="alert" testId="agent-hosting-write-failed">
              <p>{t('refused.writeFailed', { hoster: hoster(toAws) })}</p>
              <p>{t('refused.nothingChanged', { previous: hoster(onPool) })}</p>
              <p>{t('refused.retryHint')}</p>
            </Band>
          ) : null}
          <Input
            id={reasonFieldId}
            label={t('confirm.reasonLabel')}
            placeholder={t(
              toAws ? 'confirm.reasonPlaceholderToAws' : 'confirm.reasonPlaceholderToFly',
            )}
            helperText={t(reasonEmpty ? 'confirm.reasonHintEmpty' : 'confirm.reasonHint')}
            error={
              reasonRefused ? t('refused.reasonMissing', { hoster: hoster(onPool) }) : undefined
            }
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonRefused(false);
            }}
            disabled={isPending}
            autoFocus
            maxLength={280}
          />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" onClick={closeConfirm} disabled={isPending}>
            {t('confirm.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={isPending}
            // A courtesy: the audit vocabulary's `required` reason policy is the
            // rule, asserted in the service.
            disabled={reasonEmpty}
          >
            {t(toAws ? 'confirm.confirmToAws' : 'confirm.confirmToFly')}
          </Button>
        </Modal.Footer>
      </Modal>
    </div>
  );
}

/**
 * Panel 10 — the switch could not be read. The section's header with the
 * console's error card and Retry as its body: NO switch, NO chip and no
 * last-changed line, so a superadmin never reads a guessed state.
 */
export function AgentHostingUnavailable() {
  const t = useTranslations('platformAdmin.fleetSettings.agentHosting');
  const router = useRouter();
  const titleId = useId();
  const [pending, startTransition] = useTransition();
  return (
    <div data-testid="agent-hosting">
      <Card header={<AgentHostingHeader titleId={titleId} />}>
        <ErrorState
          data-testid="agent-hosting-unavailable"
          title={t('unavailable.title')}
          description={t('unavailable.body')}
          retryLabel={t('unavailable.retry')}
          retry={() => startTransition(() => router.refresh())}
          retryPending={pending}
        />
      </Card>
    </div>
  );
}

function AgentHostingHeader({ titleId }: { titleId: string }) {
  const t = useTranslations('platformAdmin.fleetSettings.agentHosting');
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="flex min-w-0 items-start gap-3">
        <span
          aria-hidden
          className="flex h-(--height-control-32) w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-tint-sky) text-(--el-text-strong)"
        >
          <Cloud className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={titleId} className="font-sans text-sm font-semibold text-(--el-text)">
            {t('title')}
          </h2>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('subtitle')}</p>
        </div>
      </div>
      <Pill memberRole="admin">{t('superadminOnly')}</Pill>
    </div>
  );
}

/** An info / error band — the Motir-CI row's `Band`, the console's toast roles inline. */
function Band({
  tone,
  role,
  testId,
  children,
}: {
  tone: 'info' | 'danger';
  role: 'status' | 'alert';
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div
      role={role}
      data-testid={testId}
      data-tone={tone}
      className={`flex items-start gap-2 rounded-(--radius-card) px-(--spacing-control-x) py-(--spacing-control-y) font-sans text-sm text-(--el-text-strong) ${
        tone === 'info' ? 'bg-(--el-tint-sky)' : 'bg-(--el-tint-rose)'
      }`}
    >
      {tone === 'info' ? (
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-info)" />
      ) : (
        <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-danger)" />
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}
