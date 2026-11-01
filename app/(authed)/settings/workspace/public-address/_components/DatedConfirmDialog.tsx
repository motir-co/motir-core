'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { SubdomainChangePreviewDto } from '@/lib/dto/publicAddresses';

// THE DATED CONFIRM (Story MOTIR-4528 · MOTIR-9514; `design/workspace-address`
// panels 5–7). It states, BEFORE the change is made, the date the old name
// returns to the pool (ADR §8 Amendment 3, story rule 5).
//
// ⚠️ THE RETURN DATE IS THE PREVIEW ROUTE'S, NEVER THE BROWSER'S. The dialog only
// opens once `GET …/public-subdomain/preview` has answered, and `returnsAt` comes
// from that answer, computed by the same pure functions the write then stores. A
// `return_now` outcome selects the "right away" wording and shows no date.
//
// The lock that will follow is `lockUntil`, which the control computes from the
// shared `nextChangeAllowedAt` rule at the moment the preview answered.

export type ConfirmKind = 'rename' | 'release';

export function DatedConfirmDialog({
  kind,
  preview,
  newHost,
  lockUntil,
  submitting,
  formatDate,
  onConfirm,
  onCancel,
}: {
  kind: ConfirmKind | null;
  preview: SubdomainChangePreviewDto | null;
  /** The host a rename would claim — only for `rename`. */
  newHost: string;
  lockUntil: string | null;
  submitting: boolean;
  formatDate: (iso: string) => string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('settings.workspaceAddress');
  const open = kind !== null && preview !== null;
  const isRename = kind === 'rename';
  const host = preview?.host ?? '';

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onCancel();
      }}
      role="alertdialog"
      title={
        isRename ? t('confirm.renameTitle', { host: newHost }) : t('confirm.releaseTitle', { host })
      }
    >
      {preview ? (
        <div className="flex flex-col gap-4">
          {/* Warn callout for a rename, danger callout for a release — the
              settled line and the return date, in `--el-text-strong` on a tint. */}
          <div
            data-testid="confirm-callout"
            className={`flex flex-col gap-1.5 rounded-(--radius-control) border-l-4 px-(--spacing-control-x-16) py-(--spacing-card-padding-12) ${
              isRename
                ? 'border-(--el-warning) bg-(--el-tint-yellow)'
                : 'border-(--el-danger) bg-(--el-tint-rose)'
            }`}
          >
            <span className="font-sans text-[13px] font-semibold text-(--el-text-strong)">
              {t('confirm.stops', { host })}
            </span>
            <span className="font-sans text-[13px] leading-[1.6] text-(--el-text-strong)">
              {preview.outcome === 'quarantine' && preview.returnsAt
                ? t('confirm.returnsOn', { date: formatDate(preview.returnsAt) })
                : t('confirm.returnsNow')}
            </span>
          </div>

          <p className="font-sans text-[13px] text-(--el-text-secondary)">
            {isRename ? t('confirm.noRedirectRename') : t('confirm.noRedirectRelease')}
          </p>

          {/* The application-host line (`confirm.appHosts`) is drawn only when
              the preview carries a count. It carries none until the application
              record exists (MOTIR-9797), so the line is absent today. */}

          {lockUntil ? (
            <p className="font-sans text-[13px] text-(--el-text-secondary)">
              {isRename
                ? t('confirm.lockAfterRename', { date: formatDate(lockUntil) })
                : t('confirm.lockAfterRelease', { date: formatDate(lockUntil) })}
            </p>
          ) : null}

          {/* At 390 wide the actions stack, the danger action first. */}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" size="md" disabled={submitting} onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button variant="danger" size="md" loading={submitting} onClick={onConfirm}>
              {isRename
                ? submitting
                  ? t('confirm.renaming')
                  : t('confirm.rename')
                : submitting
                  ? t('confirm.releasing')
                  : t('confirm.release')}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
