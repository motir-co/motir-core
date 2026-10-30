'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { DomainApplicationDto, PublicAddressDto } from '@/lib/dto/publicAddresses';
import { ApplicationPicker, NO_APPLICATION } from './ApplicationPicker';

/**
 * THE APPLICATION CONTROL (MOTIR-9529), built to
 * `design/workspace-address/custom-domains--application.mock.html` panels B–D:
 * a ghost Button beside an issued row's Application line that opens the
 * application picker in a Modal titled for the domain.
 *
 * The write is `PATCH …/custom-domains/[addressId]` with `{ applicationId }`,
 * which changes ONLY which application the domain names — no certificate is
 * re-issued and no DNS record changes, which is what the confirm line says.
 * The row keeps naming its current application until the write answers: a
 * failure leaves it as it was, never half-changed.
 */
export function ApplicationControl({
  address,
  applications,
  onSave,
}: {
  address: PublicAddressDto;
  applications: readonly DomainApplicationDto[];
  /** Sends the PATCH; resolves `true` once the row holds the new application. */
  onSave: (applicationId: string | null) => Promise<boolean>;
}) {
  const t = useTranslations('settings.customDomains');
  const current = address.applicationId
    ? (applications.find((a) => a.id === address.applicationId) ?? null)
    : null;
  // Unbound: "No application yet" is the current choice, ticked. No longer
  // listed: nothing is preselected, since the picker cannot show it.
  const initial = address.applicationId ? (current?.id ?? null) : NO_APPLICATION;

  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const action = address.applicationId ? t('app.change') : t('app.choose');
  const target = choice === NO_APPLICATION ? null : choice;
  const changed = choice !== null && target !== address.applicationId;
  const chosen = applications.find((a) => a.id === target) ?? null;

  function openWith(next: boolean) {
    if (busy) return;
    if (next) {
      setChoice(initial);
      setFailed(false);
    }
    setOpen(next);
  }

  async function save() {
    setBusy(true);
    setFailed(false);
    const ok = await onSave(target);
    setBusy(false);
    if (ok) setOpen(false);
    else setFailed(true);
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('app.controlLabel', { action, host: address.hostname })}
        onClick={() => openWith(true)}
      >
        {action}
      </Button>
      <Modal open={open} onOpenChange={openWith} title={t('app.title', { host: address.hostname })}>
        <div className="flex min-h-0 flex-1 flex-col">
          <Modal.Body className="gap-4">
            <ApplicationPicker
              applications={applications}
              value={choice}
              onChange={(next) => {
                setChoice(next);
                setFailed(false);
              }}
              disabled={busy}
            />
            {changed && chosen ? (
              <p className="font-sans text-[13px] leading-[1.6] text-(--el-text-secondary)">
                {t('app.confirm', { host: address.hostname, app: chosen.name })}
              </p>
            ) : null}
            {changed && !chosen && current ? (
              <p className="font-sans text-[13px] leading-[1.6] text-(--el-text-secondary)">
                {t('app.confirmNone', { host: address.hostname, previous: current.name })}
              </p>
            ) : null}
            {failed ? (
              <p role="alert" className="font-sans text-[13px] text-(--el-danger-on-surface)">
                {t('app.error')}
              </p>
            ) : null}
          </Modal.Body>
          <Modal.Footer className="shrink-0">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => openWith(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              disabled={busy || !changed}
              onClick={() => void save()}
            >
              {busy ? t('app.saving') : failed ? t('action.retry') : t('app.save')}
            </Button>
          </Modal.Footer>
        </div>
      </Modal>
    </>
  );
}
