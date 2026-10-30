'use client';

import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { ProductionRefusalKey } from '@/lib/hosting/productionPanelClient';
import { shortCommit } from '@/lib/hosting/releaseStateLabel';
import { AbsoluteReleaseTime, CommitLabel } from '@/components/hosting/releaseParts';

// The ROLL BACK CONFIRMATION (Story MOTIR-9797 · MOTIR-10037, design MOTIR-10024
// panels 8–10): an alert dialog naming the release being LEFT and the one it
// RETURNS TO, saying the database schema is not reverted. While the rollback is
// in flight both buttons are disabled, the dialog is `aria-busy` and nothing
// dismisses it — not Escape, not the scrim. A refusal shows in the danger box
// with Try again, and the panel behind it still shows what is serving.
//
// Presentational: the panel owns the request, the pending flag and the refusal.

export function RollbackDialog({
  repositoryName,
  leaving,
  returningTo,
  address,
  pending,
  refusalKey,
  onConfirm,
  onCancel,
}: {
  repositoryName: string;
  leaving: HostedReleaseDto;
  returningTo: HostedReleaseDto;
  address: string | null;
  pending: boolean;
  refusalKey: ProductionRefusalKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations('settings.production');
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      role="alertdialog"
      size="md"
      hideClose
      title={t('dialog.title', { repository: repositoryName })}
    >
      <Modal.Body
        className="gap-3 font-sans text-sm text-(--el-text-secondary)"
        aria-busy={pending || undefined}
        data-testid="production-rollback-dialog"
      >
        <dl className="flex flex-col gap-2">
          <ReleaseTerm label={t('dialog.leaving')} release={leaving} />
          <ReleaseTerm label={t('dialog.returning')} release={returningTo} />
        </dl>
        <p>{address ? t('dialog.body', { address }) : t('dialog.bodyNoAddress')}</p>
        {refusalKey ? (
          <p
            role="alert"
            className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm text-(--el-danger-surface-text)"
            data-testid="production-rollback-error"
          >
            {t(refusalKey, { commit: shortCommit(leaving.commitSha) })}
          </p>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
          data-testid="production-rollback-cancel"
        >
          {t('dialog.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={pending}
          loading={pending}
          aria-busy={pending || undefined}
          leftIcon={pending ? undefined : <RotateCcw className="size-4" aria-hidden />}
          onClick={onConfirm}
          data-testid="production-rollback-confirm"
        >
          {pending ? t('dialog.submitting') : refusalKey ? t('dialog.retry') : t('dialog.confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

function ReleaseTerm({ label, release }: { label: string; release: HostedReleaseDto }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-sans text-xs font-medium text-(--el-text-secondary)">{label}</dt>
      <dd className="flex items-baseline gap-2">
        <CommitLabel sha={release.commitSha} />
        <AbsoluteReleaseTime release={release} />
      </dd>
    </div>
  );
}
