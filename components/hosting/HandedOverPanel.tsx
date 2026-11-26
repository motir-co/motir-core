'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, CircleCheckBig, Copy, Download, Info, OctagonX } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { ProductionHandoverDto } from '@/lib/dto/productionPanel';
import { productionHandoverClient } from '@/lib/hosting/productionPanelClient';
import { REPOSITORIES_ROOM_HREF } from '@/lib/hosting/productionRoom';
import { formatBytes } from '@/lib/utils/bytes';
import { COPIED_MS } from '@/components/hosting/CurrentReleaseCard';
import { HandoverMemberNote } from '@/components/hosting/GracePanel';

// The HANDING-OVER NOTICE and the HANDED-OVER PANEL (Story MOTIR-9800 ·
// MOTIR-12138), per the delta mock
// `design/hosting/production--takeover-handover.mock.html` panels 2–3 and 16–19.
// An AWS app has left with its account: the panel names the account and the
// address the app answers on without Motir. A serverless or Fly app has stopped:
// the panel names the stop date and the final export, kept 30 days, which only an
// organisation admin downloads. Neither carries a deploy or rollback control.

const DATE = { dateStyle: 'medium' } as const;
const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** The takeover-in-progress notice (`handing_over`): it replaces every deploy
 *  control. An admin follows the handover in Repositories; a member reads who
 *  takes the hosting over. */
export function HandingOverNotice({ handover }: { handover: ProductionHandoverDto }) {
  const t = useTranslations('settings.production.handover.notice');
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-notice-info-bg) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text-strong)"
      data-testid="production-handing-over"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-1">
        <p className="font-medium">{t('title')}</p>
        <p>{t('body', { organization: handover.organizationName })}</p>
        {handover.canManageHandover ? (
          <Link
            href={REPOSITORIES_ROOM_HREF}
            className="text-(--el-link) underline"
            data-testid="production-handing-over-link"
          >
            {t('link')}
          </Link>
        ) : (
          <p className="text-(--el-text-secondary)">{t('memberNote')}</p>
        )}
      </div>
    </div>
  );
}

export function HandedOverPanel({
  handover,
  applicationId,
  repositoryName,
}: {
  handover: ProductionHandoverDto;
  applicationId: string;
  repositoryName: string;
}) {
  return handover.target === 'aws' ? (
    <AwsHandedOver handover={handover} repositoryName={repositoryName} />
  ) : (
    <StoppedHandedOver
      handover={handover}
      applicationId={applicationId}
      repositoryName={repositoryName}
    />
  );
}

function PanelPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-muted) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium whitespace-nowrap text-(--el-text-strong)">
      {icon}
      {label}
    </span>
  );
}

function AwsHandedOver({
  handover,
  repositoryName,
}: {
  handover: ProductionHandoverDto;
  repositoryName: string;
}) {
  const t = useTranslations('settings.production.handover.handedOver');
  const format = useFormatter();
  const since = handover.handedOverAt ? format.dateTime(new Date(handover.handedOverAt), DATE) : '';
  return (
    <Card data-testid="production-handed-over" data-target="aws">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="font-sans text-base font-semibold text-(--el-text)">{t('aws.title')}</h3>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('aws.body', {
                organization: handover.organizationName,
                name: repositoryName,
                date: since,
              })}
            </p>
          </div>
          <PanelPill
            icon={<CircleCheckBig className="size-3" aria-hidden />}
            label={t('aws.pill')}
          />
        </div>
        <dl className="flex flex-col gap-3 border-t border-(--el-border-soft) pt-4">
          {handover.handedOverAccountId ? (
            <CopyRow
              label={t('aws.account')}
              shown={formatAwsAccount(handover.handedOverAccountId)}
              value={handover.handedOverAccountId}
              copyLabel={t('aws.copyAccount')}
              testId="production-handed-over-account"
            />
          ) : null}
          {handover.upstreamAddress ? (
            <CopyRow
              label={t('aws.upstream')}
              shown={handover.upstreamAddress}
              value={handover.upstreamAddress}
              copyLabel={t('aws.copyUpstream')}
              testId="production-handed-over-upstream"
            />
          ) : null}
        </dl>
      </div>
    </Card>
  );
}

/** A twelve-digit AWS account id in groups of four, as AWS's console shows it. */
function formatAwsAccount(id: string): string {
  return /^\d{12}$/.test(id) ? id.replace(/(\d{4})(?=\d)/g, '$1 ') : id;
}

function CopyRow({
  label,
  shown,
  value,
  copyLabel,
  testId,
}: {
  label: string;
  shown: string;
  value: string;
  copyLabel: string;
  testId: string;
}) {
  const t = useTranslations('settings.production.handover.handedOver');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // The browser refused the clipboard; the value stays on screen to select.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <dt className="font-sans text-xs font-medium text-(--el-text-secondary)">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm text-(--el-text-identifier)">{shown}</code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={copyLabel}
          onClick={() => void copy()}
          leftIcon={
            copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )
          }
        >
          {copied ? t('copied') : t('copy')}
        </Button>
        <span className="sr-only" aria-live="polite">
          {copied ? t('copied') : ''}
        </span>
      </dd>
    </div>
  );
}

function StoppedHandedOver({
  handover,
  applicationId,
  repositoryName,
}: {
  handover: ProductionHandoverDto;
  applicationId: string;
  repositoryName: string;
}) {
  const t = useTranslations('settings.production.handover.handedOver');
  const format = useFormatter();
  const finalExport = handover.exports.find((e) => e.kind === 'final') ?? null;
  const admin = handover.canManageHandover;
  return (
    <div className="flex flex-col gap-4">
      {admin ? null : <HandoverMemberNote>{t('final.memberNote')}</HandoverMemberNote>}
      <Card data-testid="production-handed-over" data-target={handover.target}>
        <div className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase">
                {t('stopped.title')}
              </p>
              {handover.handedOverAt ? (
                <time
                  dateTime={handover.handedOverAt}
                  className="font-sans text-base font-semibold text-(--el-text)"
                  data-testid="production-stopped-at"
                >
                  {format.dateTime(new Date(handover.handedOverAt), DATE)}
                </time>
              ) : null}
              <p className="font-sans text-sm text-(--el-text-secondary)">
                {t('stopped.body', { name: repositoryName, target: handover.target })}
              </p>
            </div>
            <PanelPill
              icon={<OctagonX className="size-3" aria-hidden />}
              label={t('stopped.pill')}
            />
          </div>
          <section
            className="flex flex-col gap-2 border-t border-(--el-border-soft) pt-4"
            aria-labelledby="production-final-export-heading"
          >
            <h3
              id="production-final-export-heading"
              className="font-sans text-sm font-semibold text-(--el-text)"
            >
              {t('final.title')}
            </h3>
            {finalExport ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-(--radius-card) border border-(--el-border) px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
                data-testid="production-final-export"
              >
                <span className="flex min-w-0 flex-col gap-0.5 font-sans text-sm">
                  <span className="text-(--el-text)">
                    {t('final.taken', {
                      date: format.dateTime(new Date(finalExport.createdAt), DATE_TIME),
                    })}
                  </span>
                  <span className="text-(--el-text-secondary)">
                    {t('final.meta', {
                      size: formatBytes(Number(finalExport.sizeBytes)),
                      date: format.dateTime(new Date(finalExport.expiresAt), DATE),
                    })}
                  </span>
                </span>
                {admin ? (
                  <a
                    href={productionHandoverClient.downloadHref(
                      handover.organizationId,
                      applicationId,
                      finalExport.id,
                    )}
                    className="inline-flex items-center gap-1 font-sans text-sm text-(--el-link) underline"
                    aria-label={t('final.downloadAria')}
                    data-testid="production-final-export-download"
                  >
                    <Download className="size-3.5" aria-hidden />
                    {t('final.download')}
                  </a>
                ) : null}
              </div>
            ) : (
              <p
                className="font-sans text-sm text-(--el-text-secondary)"
                data-testid="production-final-export-expired"
              >
                {handover.finalExportExpiresAt
                  ? t('final.expired', {
                      date: format.dateTime(new Date(handover.finalExportExpiresAt), DATE),
                    })
                  : t('final.none')}
              </p>
            )}
          </section>
        </div>
      </Card>
    </div>
  );
}
