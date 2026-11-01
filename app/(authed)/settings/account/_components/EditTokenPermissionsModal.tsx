'use client';

import { useId, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CircleAlert, KeyRound, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';
import { useToast } from '@/components/ui/Toast';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import {
  ApiError,
  TokenPermissionsRefusedError,
  updateTokenPermissions,
  type ApiTokenDto,
} from './apiTokensClient';
import { PermissionPicker } from './PermissionPicker';
import { PermissionChangeSummary, diffGrant } from './PermissionChangeSummary';
import { SettingsCallout } from './SettingsCallout';

// Edit an existing token's permissions (MOTIR-10188) — design
// `account-settings--edit-token-permissions.mock.html` Panels 2–7. ONE phase:
// nothing secret comes back, so there is no shown-once step. The token's label,
// prefix, binding and expiry read as fixed facts; the SAME `PermissionPicker`
// the create modal uses opens on the token's current grant; and the live
// Changes block is pinned between the scrolling body and the footer, so the diff
// is on screen beside Save however far the picker scrolls.
//
// The offer (`conferrable`) is what the owner may grant in the token's BOUND
// project today — the `grantable` list `listScopeOptions` already ships for the
// create modal. A key the token holds but the owner can no longer grant opens
// LOCKED and off and is listed under Removing, so the cut is visible before Save
// rather than after a refusal.
//
// Every refusal leaves the token as it was:
//   * a named permission the owner cannot grant (403) → the danger banner, that
//     row locked (Panel 6), the rest of the choice kept;
//   * not found (404 — revoked elsewhere) → the package's ErrorState and Close,
//     which removes the row (Panel 7);
//   * a staff "View as" session → an error toast (the control is disabled, so
//     this is the server's answer if it is ever bypassed);
//   * anything else → the generic error toast, modal still open.

export function EditTokenPermissionsModal({
  token,
  conferrable,
  onClose,
  onUpdated,
  onGone,
}: {
  /** The token being edited — a BOUND token (`project` non-null). */
  token: ApiTokenDto;
  /** What the owner may grant in the token's bound project. */
  conferrable: readonly PermissionKey[];
  onClose: () => void;
  /** The updated row from the route — the caller swaps it into its list. */
  onUpdated: (token: ApiTokenDto) => void;
  /** The token no longer exists — the caller removes the row. */
  onGone: (tokenId: string) => void;
}) {
  const t = useTranslations('settings.apiTokens');
  const tp = useTranslations('permissions');
  const locale = useLocale() as Locale;
  const { toast } = useToast();
  const permLabelId = useId();

  // Keys a refusal named: the offer changed after the modal opened, so they are
  // taken out of it here, which locks their rows exactly as an offer read would.
  const [refusedKeys, setRefusedKeys] = useState<PermissionKey[]>([]);
  const offer = new Set<PermissionKey>(conferrable.filter((k) => !refusedKeys.includes(k)));
  const [granted, setGranted] = useState<Set<PermissionKey>>(() => new Set(token.permissions));
  const [saving, setSaving] = useState(false);
  const [gone, setGone] = useState(false);

  // What Save would store: the switched-on keys the owner can grant.
  const next = [...granted].filter((k) => offer.has(k));
  const { added, removed } = diffGrant(token.permissions, next);
  const changed = added.length + removed.length > 0;
  const empty = next.length === 0;

  function toggle(key: PermissionKey) {
    setGranted((prev) => {
      const out = new Set(prev);
      if (out.has(key)) out.delete(key);
      else out.add(key);
      return out;
    });
  }

  function close() {
    if (gone) onGone(token.id);
    onClose();
  }

  async function save() {
    if (!changed || empty || saving) return;
    setSaving(true);
    try {
      const updated = await updateTokenPermissions(token.id, next);
      onUpdated(updated);
      toast({
        variant: 'success',
        title: t('edit.updatedTitle'),
        description: t('edit.updatedBody', { label: token.label }),
      });
      onClose();
    } catch (err) {
      setSaving(false);
      if (err instanceof TokenPermissionsRefusedError) {
        setRefusedKeys(err.permissions as PermissionKey[]);
        return;
      }
      if (err instanceof ApiError && err.code === 'API_TOKEN_NOT_FOUND') {
        setGone(true);
        return;
      }
      toast({
        variant: 'error',
        title: t('edit.errorTitle'),
        description:
          err instanceof ApiError && err.code === 'IMPERSONATION_CREDENTIAL_REFUSED'
            ? t('edit.staffUnavailable')
            : t('edit.errorGeneric'),
      });
    }
  }

  const refusedNames = refusedKeys.map((k) => tp(`${permissionSlug(k)}.label`)).join(', ');

  return (
    <Modal
      open
      onOpenChange={(o) => (!o && !saving ? close() : undefined)}
      title={t('edit.title')}
      description={gone ? undefined : t('edit.description')}
      size="md"
      // The create modal's width, so the picker's two columns read the same.
      className="max-w-[42rem]"
    >
      {gone ? (
        <>
          <div role="alert">
            <ErrorState title={t('edit.gone.title')} description={t('edit.gone.body')} />
          </div>
          <Modal.Footer>
            <Button type="button" variant="primary" onClick={close}>
              {t('edit.gone.close')}
            </Button>
          </Modal.Footer>
        </>
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Modal.Body className="gap-4">
            {refusedKeys.length > 0 ? (
              <div
                role="alert"
                className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-danger-surface) px-(--spacing-card-padding-12) py-(--spacing-card-padding-8) font-sans text-sm leading-relaxed text-(--el-danger-surface-text)"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  {t.rich('edit.refused', {
                    permission: refusedNames,
                    project: token.project?.name ?? '',
                    strong: (c) => <strong className="font-semibold">{c}</strong>,
                  })}
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <ReadonlyField label={t('edit.facts.label')}>
                  <span className="truncate">{token.label}</span>
                </ReadonlyField>
                <ReadonlyField label={t('edit.facts.token')}>
                  <code className="font-mono text-xs text-(--el-code-text)">
                    {token.tokenPrefix}…
                  </code>
                </ReadonlyField>
                <ReadonlyField label={t('edit.facts.boundTo')}>
                  <span className="truncate">
                    {token.project
                      ? `${token.workspace.name} · ${token.project.name}`
                      : token.workspace.name}
                  </span>
                </ReadonlyField>
                <ReadonlyField label={t('edit.facts.expires')}>
                  <span>
                    {token.expiresAt ? formatDate(token.expiresAt, locale) : t('expiresNever')}
                  </span>
                </ReadonlyField>
              </div>
              <span className="font-sans text-xs text-(--el-text-muted)">
                {t('edit.factsLocked')}
              </span>
            </div>
            <SettingsCallout icon={<KeyRound aria-hidden className="h-[18px] w-[18px]" />}>
              {t('edit.sameSecret')}
            </SettingsCallout>
            <div className="flex flex-col gap-2">
              <span id={permLabelId} className="font-sans text-sm font-medium text-(--el-text)">
                {t('scopes.permissionsLabel')}
              </span>
              <span className="font-sans text-xs text-(--el-text-muted)">
                {t('scopes.permissionsHelper')}
              </span>
              <PermissionPicker
                labelledBy={permLabelId}
                conferrable={offer}
                granted={granted}
                onToggle={toggle}
                lockedWhy={t('scopes.lockedWhy')}
                dangerTag={t('scopes.dangerTag')}
                disabled={saving}
              />
              {empty ? (
                <p
                  role="alert"
                  className="mt-1 flex items-center gap-1.5 font-sans text-xs text-(--el-danger-on-surface)"
                >
                  <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                  {t('edit.emptyError')}
                </p>
              ) : null}
            </div>
          </Modal.Body>
          {/* Pinned OUTSIDE the scrolling body, directly above the footer. */}
          <div className="mt-3 shrink-0">
            <PermissionChangeSummary added={added} removed={removed} />
          </div>
          <Modal.Footer className="shrink-0">
            <Button type="button" variant="ghost" onClick={close} disabled={saving}>
              {t('edit.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={saving}
              disabled={!changed || empty || saving}
            >
              {t('edit.save')}
            </Button>
          </Modal.Footer>
        </form>
      )}
    </Modal>
  );
}

/** A labelled read-only fact, styled like the form's inputs — the create modal's
 * `ReadonlyField`, with a node value so the prefix can render as code. */
function ReadonlyField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="font-sans text-sm font-medium text-(--el-text)">{label}</span>
      <div className="flex h-(--height-input) min-w-0 items-center gap-2 rounded-(--radius-input) border border-(--el-border) bg-(--el-muted) px-(--spacing-input-x) font-sans text-sm text-(--el-text-secondary)">
        {children}
      </div>
    </div>
  );
}
