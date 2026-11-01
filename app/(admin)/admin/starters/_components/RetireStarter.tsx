'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Archive } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import { SEED_REGISTRY_ANY, type SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { StarterAlert } from './StarterAlert';

/**
 * RETIRE — design `starter-library` §3.4–3.5. A row's **Retire** opens an
 * alertdialog that says what retiring does and asks for the reason the audit log
 * keeps; **Retire starter** stays disabled until one is typed. On success the
 * dialog closes, a toast confirms, and the library is re-read
 * (`router.refresh()`), so the row leaves the Active filter.
 *
 * A role's default never shows the action, but if the route still refuses one
 * as `SEED_ENTRY_IS_DEFAULT` the dialog says why and offers a single Close.
 */

type RetireRefusal = { kind: 'default' } | { kind: 'other'; message: string };

export function RetireStarterButton({
  entryKey,
  label,
  role,
}: {
  entryKey: string;
  label: string;
  role: SeedRegistryEntryDto['role'];
}) {
  const t = useTranslations('platformAdmin.starters.retire');
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<RetireRefusal | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setReason('');
      setRefusal(null);
    }
  }

  async function onConfirm() {
    setPending(true);
    setRefusal(null);
    try {
      const res = await fetch(
        `/api/platform/seed-registry/${encodeURIComponent(entryKey)}/retire`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason.trim() }),
        },
      );
      if (res.ok) {
        onOpenChange(false);
        toast({ variant: 'success', title: t('done', { label }) });
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        code?: string;
        error?: string;
      } | null;
      setRefusal(
        body?.code === 'SEED_ENTRY_IS_DEFAULT'
          ? { kind: 'default' }
          : { kind: 'other', message: body?.error ?? t('failed') },
      );
    } catch {
      setRefusal({ kind: 'other', message: t('failed') });
    } finally {
      setPending(false);
    }
  }

  const b = (chunks: React.ReactNode) => <b className="font-semibold">{chunks}</b>;

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        leftIcon={<Archive aria-hidden="true" className="size-3.5" />}
        onClick={() => setOpen(true)}
        data-testid={`retire-${entryKey}`}
      >
        {t('action')}
      </Button>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        size="md"
        role="alertdialog"
        title={t('title', { label })}
      >
        {refusal?.kind === 'default' ? (
          <>
            <Modal.Body className="gap-3 text-sm text-(--el-text)">
              <StarterAlert title={t('defaultTitle')} testId="retire-refusal">
                {role === SEED_REGISTRY_ANY
                  ? t.rich('defaultBodyEveryRole', { key: entryKey, b })
                  : t.rich('defaultBody', { key: entryKey, role, b })}
              </StarterAlert>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
                {t('close')}
              </Button>
            </Modal.Footer>
          </>
        ) : (
          <>
            <Modal.Body className="gap-3 text-sm text-(--el-text)">
              <p className="m-0">{t('body')}</p>
              <Textarea
                label={t('reasonLabel')}
                helperText={t('reasonHelp')}
                required
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                data-testid="retire-reason"
              />
              {refusal?.kind === 'other' ? (
                <StarterAlert title={t('failedTitle')} testId="retire-refusal">
                  {refusal.message}
                </StarterAlert>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onClick={() => onOpenChange(false)} autoFocus>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                loading={pending}
                disabled={reason.trim() === '' || pending}
                onClick={onConfirm}
                data-testid="retire-confirm"
              >
                {t('confirm')}
              </Button>
            </Modal.Footer>
          </>
        )}
      </Modal>
    </>
  );
}
