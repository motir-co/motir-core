'use client';

import { useTranslations } from 'next-intl';
import { Cloud, Info } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { SectionLabel } from '@/components/ui/SectionLabel';

// THE MOVE DIALOG OF AN AWS-TARGET REPOSITORY (Story MOTIR-9800 · MOTIR-12137 —
// design/repository-set/takeover--aws-handover.mock.html, panels 2 and 4).
//
// An AWS repository cannot be moved on its own the way a serverless or Fly one
// is: its app runs in the organisation's own AWS account, and that account
// leaves Motir WHOLE. So this dialog stands where the target picker would, in
// two moments:
//
//   - `others` EMPTY (panel 2): the organisation holds only this AWS
//     repository, so the flow's one primary is Take over AWS hosting.
//   - `others` NAMED (panel 4): the takeover route refused with
//     `TAKEOVER_SHARED_AWS_ACCOUNT`, naming the repositories that share the
//     account. Nothing has changed, and the dialog says so in words.
//
// A person who is not an organisation admin gets Close in place of the offer:
// hiding is presentation, and the handover routes keep their own gate.

export interface AwsHandoverRefusalProps {
  /** The repository whose Move was pressed. */
  repo: string;
  organizationName: string;
  /** The other repositories on the account, as the refusal named them. */
  others: readonly string[];
  /** Whether the reader administers the organisation. */
  canHandOver: boolean;
  onClose: () => void;
  onTakeOverAws: () => void;
}

export function AwsHandoverRefusal({
  repo,
  organizationName,
  others,
  canHandOver,
  onClose,
  onTakeOverAws,
}: AwsHandoverRefusalProps) {
  const t = useTranslations('repositoryTakeover');
  const ta = useTranslations('repositoryTakeover.awsHandover');
  const shared = others.length > 0;
  const title = shared
    ? ta('refusalTitle', { repo, count: others.length })
    : t('modalTitle', { repo });

  return (
    <Modal open onOpenChange={(open) => (open ? undefined : onClose())} srTitle={title} size="lg">
      <Modal.Body className="gap-4">
        <div className="flex flex-col gap-1">
          <SectionLabel>{t('modalEyebrow')}</SectionLabel>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">{title}</h2>
        </div>
        <p className="text-sm leading-relaxed text-(--el-text-secondary)">
          {shared
            ? ta('refusalLead', { org: organizationName })
            : ta('startLead', { org: organizationName })}
        </p>

        {shared ? (
          <ul
            aria-label={ta('refusalOthersLabel')}
            className="flex flex-col overflow-hidden rounded-(--radius-card) border border-(--el-border)"
          >
            {others.map((name) => (
              <li
                key={name}
                className="border-t border-(--el-border-soft) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-mono text-sm text-(--el-text) first:border-t-0"
              >
                {name}
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex gap-3 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-notice-info-bg) p-(--spacing-card-padding)">
            <Info className="mt-0.5 size-4 shrink-0 text-(--el-info)" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-1 text-sm leading-relaxed">
              <p className="font-semibold text-(--el-text)">{ta('oneAccountTitle')}</p>
              <p className="text-(--el-text-secondary)">
                {ta('oneAccountBody', { org: organizationName })}
              </p>
            </div>
          </div>
        )}

        {shared ? (
          <p
            role="status"
            className="rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) p-(--spacing-card-padding) text-sm text-(--el-text-secondary)"
          >
            <span className="font-semibold text-(--el-text)">{ta('nothingChanged')}</span>{' '}
            {ta('stillHosted', { repo })}
          </p>
        ) : null}

        {canHandOver ? null : (
          <p className="text-sm text-(--el-text-secondary)">{ta('askAnAdmin')}</p>
        )}
      </Modal.Body>
      <Modal.Footer>
        {canHandOver ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {ta('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={onTakeOverAws}
              leftIcon={<Cloud className="size-4 shrink-0" />}
            >
              {ta('takeOver')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {ta('close')}
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}
