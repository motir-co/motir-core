'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Clock, Download, Info, OctagonX, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Spinner } from '@/components/ui/Spinner';
import type { ProductionExportDto, ProductionHandoverDto } from '@/lib/dto/productionPanel';
import {
  productionHandoverClient,
  type HandoverRefusalKey,
} from '@/lib/hosting/productionPanelClient';
import { formatBytes } from '@/lib/utils/bytes';

// The GRACE WINDOW (Story MOTIR-9800 · MOTIR-12138), per the delta mock
// `design/hosting/production--takeover-handover.mock.html` panels 6–13 and
// `design/hosting/design-notes.md` § "Amendment 2026-11-23 — the takeover
// handover": the Grace notice banner, the Grace panel (Runs until, Database
// exports, Stop it early) and the Stop now confirmation.
//
// Presentational: the Production panel island owns the export and stop requests,
// their busy flags and their refusals. What an organisation admin may do is the
// read's `canManageHandover`; the export and stop routes stay the authority.

const DATE = { dateStyle: 'medium' } as const;
const DATE_TIME = { dateStyle: 'medium', timeStyle: 'short' } as const;

/** The notice recipe the design names: the shipped takeover `Notice`. */
const NOTICE =
  'flex items-start gap-2 rounded-(--radius-card) border border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text-strong)';

/** A member's note: who can act, in the soft notice treatment. */
export function HandoverMemberNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="note"
      className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-text-secondary)"
      data-testid="production-handover-member-note"
    >
      {children}
    </p>
  );
}

/**
 * The GRACE NOTICE BANNER: the newest grace notice recorded — at the transfer
 * (info), seven days before the stop and one day before it (warning). The
 * `stopped` notice is no banner (the Handed-over panel is the stop's record), and
 * with no notice recorded the banner renders nothing.
 */
export function GraceNoticeBanner({
  handover,
  repositoryName,
}: {
  handover: ProductionHandoverDto;
  repositoryName: string;
}) {
  const t = useTranslations('settings.production.handover.banner');
  const format = useFormatter();
  const kind = handover.latestGraceNotice?.kind;
  if (!kind || kind === 'stopped' || !handover.stopsAt) return null;
  const date = format.dateTime(new Date(handover.stopsAt), DATE);
  const key = { transferred: 'transferred', seven_days: 'sevenDays', one_day: 'oneDay' }[kind];
  const warning = kind !== 'transferred';
  const Icon = kind === 'transferred' ? Info : kind === 'seven_days' ? Clock : TriangleAlert;
  return (
    <div
      role="status"
      className={`${NOTICE} ${warning ? 'bg-(--el-warning-surface)' : 'bg-(--el-notice-info-bg)'}`}
      data-testid="production-grace-banner"
      data-kind={kind}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{t(`${key}.title`, { name: repositoryName, date })}</p>
        <p>{t(`${key}.body`)}</p>
      </div>
    </div>
  );
}

/** Where Download export stands: never asked, the dump running, or it ended
 *  without an export (a refusal, the network, or the re-read ran out). */
export type ExportView =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'failed'; refusalKey: HandoverRefusalKey };

/** The GRACE PANEL: Runs until, Database exports, and Stop it early. */
export function GracePanel({
  handover,
  applicationId,
  repositoryName,
  address,
  exportView,
  onExport,
  onStop,
}: {
  handover: ProductionHandoverDto;
  applicationId: string;
  repositoryName: string;
  address: string | null;
  exportView: ExportView;
  onExport: () => void;
  onStop: () => void;
}) {
  const t = useTranslations('settings.production.handover');
  const format = useFormatter();
  const stopsAt = handover.stopsAt ? new Date(handover.stopsAt) : null;
  const admin = handover.canManageHandover;
  const busy = exportView.kind === 'busy';
  const onDemand = handover.exports.filter((e) => e.kind === 'on_demand');
  return (
    <Card data-testid="production-grace-panel">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase">
              {t('grace.runsUntil')}
            </p>
            {stopsAt ? (
              <time
                dateTime={handover.stopsAt ?? undefined}
                className="font-sans text-base font-semibold text-(--el-text)"
                data-testid="production-grace-stops-at"
              >
                {format.dateTime(stopsAt, DATE_TIME)}
              </time>
            ) : null}
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {address
                ? t('grace.body', { name: repositoryName, address })
                : t('grace.bodyNoAddress', { name: repositoryName })}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-warning-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium whitespace-nowrap text-(--el-text-strong)">
            <Clock className="size-3" aria-hidden />
            {t('grace.pill')}
          </span>
        </div>

        <section
          className="flex flex-col gap-2 border-t border-(--el-border-soft) pt-4"
          aria-labelledby="production-exports-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="production-exports-heading"
              className="font-sans text-sm font-semibold text-(--el-text)"
            >
              {t('exports.title')}
            </h3>
            {admin ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                loading={busy}
                aria-busy={busy || undefined}
                leftIcon={busy ? undefined : <Download className="size-3.5" aria-hidden />}
                onClick={onExport}
                data-testid="production-export"
              >
                {busy ? t('exports.busy') : t('exports.download')}
              </Button>
            ) : null}
          </div>
          <p className="font-sans text-sm text-(--el-text-secondary)">{t('exports.help')}</p>
          {busy ? (
            <p
              role="status"
              className="flex items-center gap-2 font-sans text-sm text-(--el-text-secondary)"
              data-testid="production-export-busy"
            >
              <Spinner size="sm" aria-hidden />
              {t('exports.busyStatus')}
            </p>
          ) : null}
          {exportView.kind === 'failed' ? (
            <div
              role="alert"
              className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-danger-surface-text)"
              data-testid="production-export-error"
            >
              {exportView.refusalKey === 'handover.exports.failed'
                ? t.rich('exports.failed', {
                    retry: (chunks) => (
                      <button
                        type="button"
                        className="underline"
                        onClick={onExport}
                        data-testid="production-export-retry"
                      >
                        {chunks}
                      </button>
                    ),
                  })
                : t(refusalOf(exportView.refusalKey))}
            </div>
          ) : null}
          <ExportList
            exports={onDemand}
            organizationId={handover.organizationId}
            applicationId={applicationId}
            downloadable={admin}
          />
        </section>

        {admin ? (
          <section
            className="flex flex-col gap-2 border-t border-(--el-border-soft) pt-4"
            aria-labelledby="production-stop-heading"
          >
            <h3
              id="production-stop-heading"
              className="font-sans text-sm font-semibold text-(--el-text)"
            >
              {t('stop.title')}
            </h3>
            <p className="font-sans text-sm text-(--el-text-secondary)">
              {t('stop.body', {
                name: repositoryName,
                date: stopsAt ? format.dateTime(stopsAt, DATE) : '',
              })}
            </p>
            <div>
              <Button
                variant="secondary"
                size="sm"
                className="text-(--el-danger-on-surface)"
                leftIcon={<OctagonX className="size-3.5" aria-hidden />}
                onClick={onStop}
                data-testid="production-stop"
              >
                {t('stop.button')}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </Card>
  );
}

/** A refusal key with its `handover.` prefix dropped: the `t` here is scoped to
 *  `settings.production.handover`. */
function refusalOf(key: HandoverRefusalKey): string {
  return key.slice('handover.'.length);
}

/** The past exports, newest first: when, how big, who asked and until when it
 *  is kept, with Download for an organisation admin. */
export function ExportList({
  exports,
  organizationId,
  applicationId,
  downloadable,
}: {
  exports: ProductionExportDto[];
  organizationId: string;
  applicationId: string;
  downloadable: boolean;
}) {
  const t = useTranslations('settings.production.handover.exports');
  const format = useFormatter();
  if (exports.length === 0) {
    return (
      <p
        className="font-sans text-sm text-(--el-text-secondary)"
        data-testid="production-exports-empty"
      >
        {t('empty')}
      </p>
    );
  }
  return (
    <ul
      className="flex flex-col divide-y divide-(--el-border-soft) rounded-(--radius-card) border border-(--el-border)"
      data-testid="production-exports"
    >
      {exports.map((e) => {
        const taken = format.dateTime(new Date(e.createdAt), DATE_TIME);
        const meta = {
          size: formatBytes(Number(e.sizeBytes)),
          date: format.dateTime(new Date(e.expiresAt), DATE),
        };
        return (
          <li
            key={e.id}
            className="flex flex-wrap items-center justify-between gap-2 px-(--spacing-control-x-12) py-(--spacing-control-y-8)"
            data-testid="production-export-row"
          >
            <span className="flex min-w-0 flex-col gap-0.5 font-sans text-sm">
              <time dateTime={e.createdAt} className="text-(--el-text)">
                {taken}
              </time>
              <span className="text-(--el-text-secondary)">
                {e.requestedBy
                  ? t('row', { ...meta, name: e.requestedBy.name })
                  : t('rowUnnamed', meta)}
              </span>
            </span>
            {downloadable ? (
              <a
                href={productionHandoverClient.downloadHref(organizationId, applicationId, e.id)}
                className="inline-flex items-center gap-1 font-sans text-sm text-(--el-link) underline"
                aria-label={t('downloadAria', { date: taken })}
                data-testid="production-export-download"
              >
                <Download className="size-3.5" aria-hidden />
                {t('downloadLink')}
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The STOP NOW CONFIRMATION: what is deleted, that the final export is kept 30
 * days, and that it cannot be undone. While the stop runs both buttons are
 * disabled, the dialog is `aria-busy` and nothing dismisses it. A failed stop
 * says where it stopped, with Try again — which resumes from there.
 */
export function StopNowDialog({
  repositoryName,
  stopsAt,
  address,
  pending,
  refusalKey,
  onConfirm,
  onCancel,
}: {
  repositoryName: string;
  stopsAt: string | null;
  address: string | null;
  pending: boolean;
  refusalKey: HandoverRefusalKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('settings.production.handover');
  const format = useFormatter();
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      role="alertdialog"
      size="md"
      hideClose
      title={t('dialog.title', { name: repositoryName })}
    >
      <Modal.Body
        className="gap-3 font-sans text-sm text-(--el-text-secondary)"
        aria-busy={pending || undefined}
        data-testid="production-stop-dialog"
      >
        <p>
          {t('dialog.body', {
            name: repositoryName,
            date: stopsAt ? format.dateTime(new Date(stopsAt), DATE) : '',
          })}
        </p>
        <ul className="list-disc pl-5">
          <li>{address ? t('dialog.deleteApp', { address }) : t('dialog.deleteAppNoAddress')}</li>
          <li>{t('dialog.deleteDatabase')}</li>
        </ul>
        <p>{t('dialog.finalExport')}</p>
        {refusalKey ? (
          <p
            role="alert"
            className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-danger-surface-text)"
            data-testid="production-stop-error"
          >
            {t(refusalOf(refusalKey), { name: repositoryName })}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
          data-testid="production-stop-cancel"
        >
          {t('dialog.cancel')}
        </Button>
        <Button
          variant="danger"
          disabled={pending}
          loading={pending}
          aria-busy={pending || undefined}
          leftIcon={pending ? undefined : <OctagonX className="size-4" aria-hidden />}
          onClick={onConfirm}
          data-testid="production-stop-confirm"
        >
          {pending
            ? t('dialog.busy')
            : refusalKey
              ? t('dialog.retry')
              : t('dialog.confirm', { name: repositoryName })}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
