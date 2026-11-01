'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorState } from '@/components/ui/ErrorState';
import { Input } from '@/components/ui/Input';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import type {
  PublicSubdomainDto,
  SubdomainChangePreviewDto,
  SubdomainReleaseDto,
} from '@/lib/dto/publicAddresses';
import { nextChangeAllowedAt } from '@/lib/publicAddresses/nameHold';
import { MIN_SUBDOMAIN_LENGTH } from '@/lib/publicAddresses/reservedNames';
import { AddressRow } from './AddressRow';
import { DatedConfirmDialog, type ConfirmKind } from './DatedConfirmDialog';
import {
  FIELD_MAX_LABEL_LENGTH,
  refusalFromResponse,
  refuseLabelInput,
  type RefusalBody,
  type RefusalMessage,
} from './refusal';

/**
 * THE WORKSPACE ADDRESS CONTROL (Story MOTIR-4528 · MOTIR-9514), built to
 * `design/workspace-address/workspace-address.mock.html` panels 1–12. The
 * successor of project settings' `PublicSubdomainCard`, written fresh against
 * the one-name rules (ADR §8 Amendment 3): one address row, no aliases, no
 * rename counter, a dated confirm and a 30-day lock.
 *
 * ── ONE SUBMIT PATH, TWO PRESENTATIONS ──────────────────────────────────────
 * `PUT …/public-subdomain` claims when the workspace has no name and renames
 * when it has one. Claim submits straight from the field; a rename goes through
 * Review → the dated confirm first, because it gives a name up.
 *
 * ── REFRESH, NEVER PATCH ────────────────────────────────────────────────────
 * After a claim, rename or release the pane re-reads the server
 * (`router.refresh()`): the DTO carries server-derived fields (the URL, the next
 * change date). This is a client island seeded from props, so it RESEEDS when
 * the refreshed `subdomain` names a different host (the page-state rule's case
 * 3) — the field must never keep a label that was just claimed or released.
 */
export function PublicAddressControl({
  workspaceId,
  baseDomain,
  subdomain,
  canManage,
  loadFailed = false,
}: {
  workspaceId: string;
  /** `motir.site` — the suffix the field shows and every host is built from. */
  baseDomain: string;
  subdomain: PublicSubdomainDto | null;
  /** The WORKSPACE role's answer (`roleMayManageAddress`). `false` → every control absent. */
  canManage: boolean;
  /** The server read failed — render the load error with a retry. */
  loadFailed?: boolean;
}) {
  const t = useTranslations('settings.workspaceAddress');
  const format = useFormatter();
  const { toast } = useToast();
  const router = useRouter();
  const [retrying, startRetry] = useTransition();

  const [label, setLabel] = useState('');
  const [fieldError, setFieldError] = useState<RefusalMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
  const [preview, setPreview] = useState<SubdomainChangePreviewDto | null>(null);
  const [lockUntil, setLockUntil] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState<ConfirmKind | null>(null);
  const [previewFailed, setPreviewFailed] = useState<ConfirmKind | null>(null);
  const [released, setReleased] = useState<{
    host: string;
    returnsAt: string | null;
    lockUntil: string;
  } | null>(null);

  // RESEED when the server's answer names a different host (see the header).
  const [seededHost, setSeededHost] = useState(subdomain?.hostname ?? null);
  if ((subdomain?.hostname ?? null) !== seededHost) {
    setSeededHost(subdomain?.hostname ?? null);
    setLabel('');
    setFieldError(null);
    setEditing(false);
    if (subdomain) setReleased(null);
  }

  const formatDate = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'long', timeZone: 'UTC' });

  function render(message: RefusalMessage): string {
    const values = message.date
      ? { ...message.values, date: formatDate(message.date) }
      : message.values;
    return t(message.key, values);
  }

  const trimmed = label.trim();
  const hostOf = (value: string) => `${value}.${baseDomain}`;
  const liveRefusal = refuseLabelInput(trimmed);
  const shownError = fieldError ?? liveRefusal;

  function onLabelChange(value: string) {
    setLabel(value);
    // The server's refusal is cleared on edit: the Input shows `error` INSTEAD
    // of `helperText`, so a stale complaint would hide the live preview.
    if (fieldError) setFieldError(null);
  }

  async function claim(): Promise<void> {
    setSaving(true);
    setFieldError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as RefusalBody;
        setFieldError(
          refusalFromResponse(body, { act: 'claim', label: trimmed, host: hostOf(trimmed) }),
        );
        return;
      }
      const dto = (await res.json()) as PublicSubdomainDto;
      toast({ variant: 'success', title: t('toast.claimed', { host: dto.hostname }) });
      router.refresh();
    } catch {
      setFieldError({ surface: 'field', key: 'refusal.generic', values: {} });
    } finally {
      setSaving(false);
    }
  }

  /** Review → read the dated preview → only then open the confirm. */
  async function openConfirm(kind: ConfirmKind): Promise<void> {
    setLoadingPreview(kind);
    setPreviewFailed(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain/preview`);
      if (!res.ok) {
        setPreviewFailed(kind);
        return;
      }
      const answer = (await res.json()) as SubdomainChangePreviewDto;
      if (!answer.changeAllowed && answer.nextChangeAllowedAt) {
        // The lock began in another tab since this page was drawn.
        toast({
          variant: 'error',
          title: t('toast.refusedTitle'),
          description: t('toast.refusedLimit', { date: formatDate(answer.nextChangeAllowedAt) }),
        });
        router.refresh();
        return;
      }
      setPreview(answer);
      setLockUntil(nextChangeAllowedAt(new Date()).toISOString());
      setConfirm(kind);
    } catch {
      setPreviewFailed(kind);
    } finally {
      setLoadingPreview(null);
    }
  }

  function closeConfirm() {
    setConfirm(null);
    setPreview(null);
  }

  /** A refused change: close the dialog, toast the reason, keep the control as it was. */
  function refuse(body: RefusalBody, act: 'rename' | 'release') {
    closeConfirm();
    const message = refusalFromResponse(body, {
      act,
      label: trimmed,
      host: act === 'rename' ? hostOf(trimmed) : (subdomain?.hostname ?? ''),
    });
    toast({ variant: 'error', title: t('toast.refusedTitle'), description: render(message) });
  }

  async function confirmChange(): Promise<void> {
    if (!confirm || !subdomain) return;
    const act = confirm;
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/public-subdomain`, {
        method: act === 'rename' ? 'PUT' : 'DELETE',
        ...(act === 'rename'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ label: trimmed }),
            }
          : {}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as RefusalBody;
        // Released elsewhere already: show the current state, not a complaint.
        if (act === 'release' && body.code === 'SUBDOMAIN_NOT_FOUND') {
          closeConfirm();
          router.refresh();
          return;
        }
        refuse(body, act);
        return;
      }
      const old = subdomain.hostname;
      closeConfirm();
      if (act === 'rename') {
        const dto = (await res.json()) as PublicSubdomainDto;
        toast({
          variant: 'success',
          title: t('toast.renamed', { host: dto.hostname }),
          description: t('toast.renamedBody', { old }),
        });
      } else {
        const dto = (await res.json()) as SubdomainReleaseDto;
        setReleased({
          host: old,
          returnsAt: dto.returnsAt,
          lockUntil: lockUntil ?? nextChangeAllowedAt(new Date()).toISOString(),
        });
        toast({ variant: 'success', title: t('toast.released', { host: old }) });
      }
      router.refresh();
    } catch {
      refuse({}, act);
    } finally {
      setSaving(false);
    }
  }

  if (loadFailed) {
    return (
      <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
        <ErrorState
          title={t('loadError')}
          retry={() => startRetry(() => router.refresh())}
          retryLabel={t('retry')}
          retryPending={retrying}
        />
      </Card>
    );
  }

  const locked = subdomain?.nextChangeAllowedAt ?? null;

  return (
    <Card className="flex flex-col gap-4 p-(--spacing-card-padding)">
      {/* The page's header carries the title and subtitle; a reader who cannot
          manage is told why every control is absent (design panel 9). */}
      {canManage ? null : (
        <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('readOnly')}</p>
      )}

      {subdomain && !editing ? (
        <div className="flex flex-col gap-3">
          <AddressRow
            host={subdomain.hostname}
            url={subdomain.url}
            pill={<Pill severity="success">{t('row.live')}</Pill>}
          />
          {canManage ? (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={locked !== null}
                  onClick={() => {
                    setLabel(subdomain.label);
                    setFieldError(null);
                    setPreviewFailed(null);
                    setEditing(true);
                  }}
                >
                  {t('rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full sm:w-auto"
                  disabled={locked !== null}
                  loading={loadingPreview === 'release'}
                  onClick={() => void openConfirm('release')}
                >
                  {t('release')}
                </Button>
              </div>
              {locked ? <LockLine text={t('lock', { date: formatDate(locked) })} /> : null}
              {previewFailed === 'release' ? (
                <PreviewError onRetry={() => void openConfirm('release')} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {subdomain && editing && canManage ? (
        <div className="flex flex-col gap-4">
          <NameField
            label={t('field.renameLabel')}
            value={label}
            onChange={onLabelChange}
            baseDomain={baseDomain}
            error={shownError ? render(shownError) : undefined}
            helperText={trimmed ? undefined : t('field.hint', hintValues)}
            preview={trimmed ? hostOf(trimmed) : null}
            disabled={loadingPreview !== null}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setEditing(false);
                setLabel('');
                setFieldError(null);
                setPreviewFailed(null);
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              className="w-full sm:w-auto"
              disabled={trimmed === '' || trimmed === subdomain.label || shownError !== null}
              loading={loadingPreview === 'rename'}
              onClick={() => void openConfirm('rename')}
            >
              {t('review')}
            </Button>
          </div>
          {previewFailed === 'rename' ? (
            <PreviewError onRetry={() => void openConfirm('rename')} />
          ) : null}
        </div>
      ) : null}

      {!subdomain ? (
        <div className="flex flex-col gap-4">
          {released ? (
            <div
              role="status"
              className="flex flex-col gap-1 rounded-(--radius-control) bg-(--el-tint-lavender) px-(--spacing-control-x-16) py-(--spacing-card-padding-12)"
            >
              <span className="font-sans text-[13px] text-(--el-text-strong)">
                {released.returnsAt
                  ? t('released.held', {
                      host: released.host,
                      date: formatDate(released.returnsAt),
                    })
                  : t('released.free', { host: released.host })}
              </span>
              <span className="font-sans text-[13px] text-(--el-text-strong)">
                {t('released.lock', { date: formatDate(released.lockUntil) })}
              </span>
            </div>
          ) : null}

          {canManage ? (
            <>
              <NameField
                label={t('field.label')}
                value={label}
                onChange={onLabelChange}
                baseDomain={baseDomain}
                error={shownError ? render(shownError) : undefined}
                helperText={trimmed ? undefined : t('field.hint', hintValues)}
                preview={trimmed ? hostOf(trimmed) : null}
                disabled={saving}
              />
              <div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={saving}
                  disabled={trimmed === '' || shownError !== null}
                  onClick={() => void claim()}
                >
                  {t('claim')}
                </Button>
              </div>
            </>
          ) : (
            <p className="font-sans text-[13px] text-(--el-text-secondary)">{t('none')}</p>
          )}
        </div>
      ) : null}

      <DatedConfirmDialog
        kind={confirm}
        preview={preview}
        newHost={hostOf(trimmed)}
        lockUntil={lockUntil}
        submitting={saving}
        formatDate={formatDate}
        onConfirm={() => void confirmChange()}
        onCancel={closeConfirm}
      />
    </Card>
  );
}

const hintValues = { min: MIN_SUBDOMAIN_LENGTH, max: FIELD_MAX_LABEL_LENGTH };

/** The name field — the `.motir.site` suffix, the hint or the live preview, the refusal. */
function NameField({
  label,
  value,
  onChange,
  baseDomain,
  error,
  helperText,
  preview,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  baseDomain: string;
  error?: string;
  helperText?: string;
  preview: string | null;
  disabled: boolean;
}) {
  const t = useTranslations('settings.workspaceAddress');
  return (
    <Input
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      addonEnd={
        <span className="font-mono text-[13px] text-(--el-text-secondary)">.{baseDomain}</span>
      }
      helperText={preview ? t('field.preview', { host: preview }) : helperText}
      error={error}
      disabled={disabled}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="none"
    />
  );
}

function LockLine({ text }: { text: string }) {
  return (
    <p data-testid="address-lock" className="font-sans text-[13px] text-(--el-text-secondary)">
      {text}
    </p>
  );
}

/** A preview that failed: the load error and a retry, never an undated dialog. */
function PreviewError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('settings.workspaceAddress');
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <span className="font-sans text-[13px] text-(--el-danger-on-surface)">{t('loadError')}</span>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}
