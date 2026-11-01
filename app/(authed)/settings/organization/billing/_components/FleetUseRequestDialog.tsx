'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { useToast } from '@/components/ui/Toast';
import type { FleetUseHostAccountDTO } from '@/lib/dto/fleetUse';
import { fmt } from './billingFormat';
import { ACCOUNT_KIND_KEYS } from './fleetUseFormat';

// REQUEST MORE CAPACITY (Story MOTIR-9368 · MOTIR-9663; design/billing
// § Amendment 2026-10-26 element 8, mock panels 11a–11i). An owner or admin asks
// Motir for a quota raise on one of the org's own accounts, by fleet kind. The
// client checks only the shape (a whole number above what is granted, a reason);
// the server's answer is the authority and every refusal is told apart by `code`.
// A 200 closes the dialog, confirms with a toast and re-reads the section.

const REASON_MAX = 2000;

type Refusal = 'open' | 'notFound' | 'forbidden' | 'network' | 'invalid' | 'failed';
type FieldError = 'figure' | 'reason';
type Problem = { kind: 'field'; field: FieldError } | { kind: 'refused'; refusal: Refusal };

/** The client's early check — the server's 400 `field` stays the authority. */
export function checkCapacityRequest(
  figure: string,
  reason: string,
  granted: number | null,
): FieldError | null {
  const n = Number(figure.trim());
  if (!/^\d+$/.test(figure.trim()) || !Number.isSafeInteger(n) || n <= (granted ?? 0)) {
    return 'figure';
  }
  if (reason.trim().length === 0 || reason.length > REASON_MAX) return 'reason';
  return null;
}

/** A refused POST, told apart by status and `code` — never by its message. */
export function problemFromResponse(status: number, body: unknown): Problem {
  const { code, field } = (body ?? {}) as { code?: string; field?: string };
  if (status === 400) {
    if (field === 'desiredVcpu') return { kind: 'field', field: 'figure' };
    if (field === 'reason') return { kind: 'field', field: 'reason' };
    return { kind: 'refused', refusal: 'invalid' };
  }
  if (status === 409 || code === 'FLEET_CAPACITY_REQUEST_OPEN') {
    return { kind: 'refused', refusal: 'open' };
  }
  if (status === 403) return { kind: 'refused', refusal: 'forbidden' };
  if (status === 404) return { kind: 'refused', refusal: 'notFound' };
  return { kind: 'refused', refusal: 'failed' };
}

async function postRequest(
  orgId: string,
  body: { fleetKind: string; desiredVcpu: number; reason: string },
): Promise<Problem | null> {
  try {
    const res = await fetch(`/api/organizations/${orgId}/billing/fleet-use/capacity-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    return problemFromResponse(res.status, await res.json().catch(() => null));
  } catch {
    return { kind: 'refused', refusal: 'network' };
  }
}

export function FleetUseRequestDialog({
  orgId,
  account,
  onClose,
  onSent,
}: {
  orgId: string;
  account: FleetUseHostAccountDTO;
  onClose: () => void;
  onSent: () => Promise<void>;
}) {
  const t = useTranslations('billing.fleetUse');
  const { toast } = useToast();
  const [figure, setFigure] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const send = async () => {
    if (sending) return;
    const local = checkCapacityRequest(figure, reason, account.vcpuGranted);
    if (local) return setProblem({ kind: 'field', field: local });
    setSending(true);
    setProblem(null);
    const outcome = await postRequest(orgId, {
      fleetKind: account.requestKind,
      desiredVcpu: Number(figure.trim()),
      reason,
    });
    setSending(false);
    if (outcome) return setProblem(outcome);
    toast({ variant: 'success', title: t('dialog.sent') });
    onClose();
    await onSent();
  };

  return (
    <Modal
      open
      onOpenChange={(next) => (next ? null : onClose())}
      size="md"
      title={t('dialog.title')}
    >
      <Modal.Body className="gap-4">
        <DialogLead t={t} account={account} />
        {problem?.kind === 'refused' ? <RefusalBox t={t} refusal={problem.refusal} /> : null}
        <RequestFields
          t={t}
          account={account}
          figure={figure}
          reason={reason}
          fieldError={problem?.kind === 'field' ? problem.field : null}
          onFigure={setFigure}
          onReason={setReason}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          {t('dialog.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void send()} disabled={sending} loading={sending}>
          {sending ? t('dialog.sending') : t('dialog.send')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

type T = ReturnType<typeof useTranslations<'billing.fleetUse'>>;

function DialogLead({ t, account }: { t: T; account: FleetUseHostAccountDTO }) {
  const locale = useLocale();
  const name = t(ACCOUNT_KIND_KEYS[account.accountKind]);
  return (
    <p className="font-sans text-sm text-(--el-text-secondary)">
      {account.vcpuGranted === null
        ? t('dialog.accountNoneGranted', { account: name })
        : t('dialog.account', { account: name, vcpu: fmt(account.vcpuGranted, locale) })}
    </p>
  );
}

function RefusalBox({ t, refusal }: { t: T; refusal: Refusal }) {
  return (
    <p
      role="alert"
      className="rounded-(--radius-control) bg-(--el-danger-surface) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs text-(--el-danger-surface-text)"
    >
      {t(`dialog.refused.${refusal}`)}
    </p>
  );
}

function RequestFields({
  t,
  account,
  figure,
  reason,
  fieldError,
  onFigure,
  onReason,
}: {
  t: T;
  account: FleetUseHostAccountDTO;
  figure: string;
  reason: string;
  fieldError: FieldError | null;
  onFigure: (v: string) => void;
  onReason: (v: string) => void;
}) {
  const locale = useLocale();
  const granted = fmt(account.vcpuGranted ?? 0, locale);
  return (
    <>
      <Input
        label={t('dialog.figureLabel')}
        inputMode="numeric"
        placeholder={t('dialog.figurePlaceholder')}
        value={figure}
        onChange={(e) => onFigure(e.target.value)}
        helperText={fieldError === 'figure' ? undefined : t('dialog.figureHelp')}
        error={fieldError === 'figure' ? t('dialog.figureInvalid', { granted }) : undefined}
      />
      <Textarea
        label={t('dialog.reasonLabel')}
        rows={3}
        placeholder={t('dialog.reasonPlaceholder')}
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        helperText={fieldError === 'reason' ? undefined : t('dialog.reasonHelp')}
        error={fieldError === 'reason' ? t('dialog.reasonInvalid') : undefined}
      />
    </>
  );
}
