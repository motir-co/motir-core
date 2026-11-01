'use client';

import { Fragment, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronDown, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Locale } from '@/lib/i18n/locales';
import { formatDate } from '@/lib/utils/datetime';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { EmptyState } from '@/components/ui/EmptyState';
import { Tooltip } from '@/components/ui/Tooltip';
import { CreateTokenModal } from './CreateTokenModal';
import { RevokeTokenDialog } from './RevokeTokenDialog';
import { EditTokenPermissionsModal } from './EditTokenPermissionsModal';
import type { ApiTokenDto } from './apiTokensClient';
import type { TokenScopeOrgDTO } from '@/lib/dto/apiTokens';
import { grantedPermissionMeta, grantsDelete, summarizeGrant } from './permissionMeta';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';

// The Tokens pane's CLIENT ISLAND (Story 7.8 · Subtask 7.8.3) — design
// `account-settings.mock.html` Panels 3 + 7. It owns the token-list state
// (`useState(initialTokens)`) and does its OWN optimistic insert (on create) /
// mark-revoked (on revoke) from the route responses — the
// page-state-after-mutation contract: an island seeded from server props can't
// be reached by `router.refresh()`, and create/revoke fire from INSIDE the
// island, so a local update is the correct mechanism (no re-fetch).
//
// The page server-reads the initial list via `apiTokensService.listForUser`
// (account-level) + the org → workspace tree (`listScopeOptions`) the create
// modal scopes a new token within (bug 7.21).

// The MCP setup guide the empty state links to.
//
// ⚠️ It used to be `https://github.com/…/blob/main/docs/mcp.md` — a raw file on a
// source-code host, handed to a user at the exact moment they have just minted
// their first token and have nothing to do with it. Story MOTIR-2309 published
// the guide (ADR Amendment 13 Q1), so this points INTO the product.
//
// `/docs/mcp` and not `/docs/mcp/tools`: this reader holds a credential and has
// no client wired yet, so the catalogue is the wrong first thing to hand them —
// they need the wiring procedure, which links on to the catalogue itself.
//
// Now an INTERNAL link, so it opens in this tab like every other in-product
// navigation rather than in a new one the way an off-site handoff did.
const MCP_GUIDE_HREF = '/docs/mcp';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An expiry within this window shows the peach "expiring soon" warning chip. */
const EXPIRING_SOON_DAYS = 7;

export function ApiTokensManager({
  initialTokens,
  scopeOrgs,
  activeWorkspaceId,
  activeProjectId,
  staffSession = false,
}: {
  initialTokens: ApiTokenDto[];
  /** The org → workspace tree the create modal scopes a token within (bug 7.21). */
  scopeOrgs: TokenScopeOrgDTO[];
  /** The active workspace, pre-selected in the create modal (or null). */
  activeWorkspaceId: string | null;
  /** The project the reader is in — the create modal's default binding. */
  activeProjectId: string | null;
  /** The reader is in a staff "View as" session (MOTIR-749): editing a token's
   * permissions is refused there, so the edit control renders disabled. */
  staffSession?: boolean;
}) {
  const t = useTranslations('settings.apiTokens');
  // The permission LABELS come from the shipped `permissions.*` catalogue copy —
  // the same strings Roles & permissions renders — never from a second table
  // written for this screen (MOTIR-2579).
  const tp = useTranslations('permissions');
  const locale = useLocale() as Locale;

  // A token's scope spans one org (so don't repeat the org name when the account
  // has a single org); show the workspace name, with the org as a muted prefix
  // only when there is more than one org.
  const multiOrg = scopeOrgs.length > 1;

  const [tokens, setTokens] = useState<ApiTokenDto[]>(initialTokens);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenDto | null>(null);
  const [editTarget, setEditTarget] = useState<ApiTokenDto | null>(null);

  // What the owner may grant in a token's BOUND project — the same `grantable`
  // offer the create modal reads, so the edit modal can never show a switch the
  // update would refuse. A project no longer in the tree (the owner lost access)
  // offers nothing, and the update would answer not-found.
  function conferrableFor(token: ApiTokenDto): PermissionKey[] {
    const projectId = token.project?.id;
    for (const org of scopeOrgs) {
      for (const ws of org.workspaces) {
        const project = ws.projects.find((p) => p.id === projectId);
        if (project) return project.grantable;
      }
    }
    return [];
  }

  // `now` is established AFTER mount so the relative "expires in N days" math is
  // hydration-safe: SSR and the first client render both see `now === null` and
  // fall back to the absolute date; the relative form appears post-hydration.
  // Reading the clock is the whole point of this effect (the mount-flag pattern),
  // so the set-state-in-effect lint is intentionally relaxed here.
  const [now, setNow] = useState<number | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => setNow(Date.now()), []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Which rows have their scope-detail sub-row expanded (the chevron disclose).
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleCreated(token: ApiTokenDto) {
    setTokens((prev) => [token, ...prev]);
  }
  // Revoking DELETES the row (MOTIR-3546), so the island SPLICES it out rather
  // than flipping it to a muted state. Still no `router.refresh()`: this list is
  // a client island seeded once from `initialTokens`, which a refresh cannot
  // reach (the page-state-after-mutation contract).
  function handleRevoked(revokedId: string) {
    setTokens((prev) => prev.filter((tk) => tk.id !== revokedId));
    setRevokeTarget(null);
  }
  // An update keeps the token, so the island REPLACES the row in place from the
  // route's answer — the same page-state-after-mutation contract as create.
  function handleUpdated(updated: ApiTokenDto) {
    setTokens((prev) => prev.map((tk) => (tk.id === updated.id ? updated : tk)));
  }
  function handleGone(goneId: string) {
    setTokens((prev) => prev.filter((tk) => tk.id !== goneId));
  }

  // Newest first — the order the service returns. There is no second group to
  // sort below the live ones any more: every listed token is a live credential.
  const ordered = tokens;

  return (
    <div className="flex flex-col gap-6">
      {tokens.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-12 w-12" aria-hidden />}
          title={t('empty.title')}
          description={
            <>
              {t('empty.body')}{' '}
              <a
                href={MCP_GUIDE_HREF}
                className="text-(--el-link) underline hover:text-(--el-link-pressed)"
              >
                {t('empty.guideLink')}
              </a>
              {t('empty.bodyAfterLink')}
            </>
          }
          action={
            <Button
              variant="primary"
              leftIcon={<Plus className="size-4" />}
              onClick={() => setCreateOpen(true)}
            >
              {t('card.create')}
            </Button>
          }
        />
      ) : (
        <Card
          header={
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="font-sans text-base font-semibold text-(--el-text)">
                  {t('card.title')}
                </h3>
                <p className="mt-0.5 font-sans text-sm text-(--el-text-muted)">
                  {t('card.subtitle')}
                </p>
              </div>
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Plus className="size-4" />}
                onClick={() => setCreateOpen(true)}
              >
                {t('card.create')}
              </Button>
            </div>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-(--el-border)">
                  <Th>{t('columns.label')}</Th>
                  <Th>{t('columns.token')}</Th>
                  <Th>{t('columns.scopes')}</Th>
                  <Th>{t('columns.workspace')}</Th>
                  <Th>{t('columns.created')}</Th>
                  <Th>{t('columns.expires')}</Th>
                  <Th>{t('columns.lastUsed')}</Th>
                  <Th className="text-right">{t('columns.actions')}</Th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((token) => {
                  // Dates are supporting text, not disabled controls, so they
                  // take `--el-text-secondary` rather than `--el-text-faint`
                  // (2.61:1) (MOTIR-2475).
                  const dateClass = 'text-(--el-text-secondary)';
                  const summary = summarizeGrant(token.permissions);
                  const hasDelete = grantsDelete(token.permissions);
                  const expanded = expandedIds.has(token.id);
                  return (
                    <Fragment key={token.id}>
                      <tr
                        className={`border-(--el-border-soft) ${expanded ? '' : 'border-b last:border-0'}`}
                      >
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <span className="font-sans text-sm font-medium text-(--el-text)">
                            {token.label}
                          </span>
                        </td>
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <code className="rounded-(--radius-control) bg-(--el-code-bg) px-(--spacing-control-x-6) py-(--spacing-control-y-2) font-mono text-xs text-(--el-code-text)">
                            {token.tokenPrefix}…
                          </code>
                        </td>
                        {/* Scopes — a semantic summary Pill (mint "Full access" /
                            neutral Standard·Read only·Custom), a persistent rose
                            "Can delete" pill whenever delete is granted (never
                            hidden behind the summary), and a chevron disclosing
                            the per-scope detail (7.7.18 Panel 4). */}
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <span className="inline-flex items-center gap-1.5">
                            {summary === 'full' ? (
                              <Pill severity="success">{t('scopes.summary.full')}</Pill>
                            ) : (
                              <Pill tone="neutral">{t(`scopes.summary.${summary}`)}</Pill>
                            )}
                            {hasDelete ? (
                              <Pill severity="danger">
                                <Trash2 className="size-3" aria-hidden />
                                {t('scopes.canDelete')}
                              </Pill>
                            ) : null}
                            <button
                              type="button"
                              aria-label={t(expanded ? 'scopes.hideScopes' : 'scopes.showScopes', {
                                label: token.label,
                              })}
                              aria-expanded={expanded}
                              onClick={() => toggleExpanded(token.id)}
                              className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-text) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                            >
                              <ChevronDown
                                className={`size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
                                aria-hidden
                              />
                            </button>
                          </span>
                        </td>
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <span className="font-sans text-sm text-(--el-text-secondary)">
                            {multiOrg
                              ? `${token.organization.name} · ${token.workspace.name}`
                              : token.workspace.name}
                          </span>
                        </td>
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <span className={`font-sans text-sm ${dateClass}`}>
                            {formatDate(token.createdAt, locale)}
                          </span>
                        </td>
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          {renderExpires(token, now, locale, t)}
                        </td>
                        <td className="py-(--spacing-control-y) pr-4 align-middle">
                          <span className={`font-sans text-sm ${dateClass}`}>
                            {token.lastUsedAt
                              ? formatDate(token.lastUsedAt, locale)
                              : t('lastUsedNever')}
                          </span>
                        </td>
                        <td className="py-(--spacing-control-y) text-right align-middle">
                          {/* Every listed token is live, so every row keeps its
                              revoke control. The "Revoked" pill that used to
                              take this cell INSTEAD of the button is gone with
                              the state it described (MOTIR-3546) — spending the
                              Actions cell on a badge is what left a dead row
                              with no way to remove it. */}
                          <span className="inline-flex items-center gap-1">
                            <EditPermissionsButton
                              label={token.label}
                              // A CLI sign-in (the device-credential shape, no
                              // project) has the CLI's fixed grant; only
                              // `motir auth refresh` changes it (MOTIR-10189).
                              unavailable={
                                staffSession
                                  ? t('edit.staffUnavailable')
                                  : token.project === null
                                    ? t('edit.cliUnavailable')
                                    : null
                              }
                              onEdit={() => setEditTarget(token)}
                            />
                            <button
                              type="button"
                              aria-label={t('revokeAria', { label: token.label })}
                              onClick={() => setRevokeTarget(token)}
                              className="inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-surface) hover:text-(--el-danger) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
                            >
                              <Trash2 className="size-4" aria-hidden />
                            </button>
                          </span>
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className="border-b border-(--el-border-soft) last:border-0">
                          <td colSpan={8} className="pr-4 pb-3.5 align-top">
                            <div className="flex flex-wrap items-center gap-1.5 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)">
                              <span className="mr-1 font-sans text-xs text-(--el-text-secondary)">
                                {t('scopes.detailLead')}
                              </span>
                              {grantedPermissionMeta(token.permissions).map((m) => {
                                const Icon = m.Icon;
                                const chipName = tp(`${permissionSlug(m.key)}.label`);
                                return m.danger ? (
                                  <span
                                    key={m.key}
                                    className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-transparent bg-(--el-tint-rose) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong)"
                                  >
                                    <Icon className="size-3 text-(--el-danger)" aria-hidden />
                                    {chipName}
                                  </span>
                                ) : (
                                  <span
                                    key={m.key}
                                    className="inline-flex items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-secondary)"
                                  >
                                    <Icon className="size-3 text-(--el-text-muted)" aria-hidden />
                                    {chipName}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CreateTokenModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        scopeOrgs={scopeOrgs}
        activeWorkspaceId={activeWorkspaceId}
        activeProjectId={activeProjectId}
      />
      {editTarget ? (
        <EditTokenPermissionsModal
          key={editTarget.id}
          token={editTarget}
          conferrable={conferrableFor(editTarget)}
          onClose={() => setEditTarget(null)}
          onUpdated={handleUpdated}
          onGone={handleGone}
        />
      ) : null}
      {revokeTarget ? (
        <RevokeTokenDialog
          token={revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onRevoked={handleRevoked}
        />
      ) : null}
    </div>
  );
}

/**
 * The row's Edit permissions control (MOTIR-10188), BEFORE Revoke: the reversible
 * action reads first and the destructive one keeps the trailing edge. When the
 * edit is unavailable (a staff session, a CLI sign-in) it stays in place,
 * `aria-disabled` and inert, and its tooltip says why — a removed control would
 * leave the reader no way to learn the route that does exist.
 */
function EditPermissionsButton({
  label,
  unavailable,
  onEdit,
}: {
  label: string;
  /** Why the edit is unavailable, or null when it is available. */
  unavailable: string | null;
  onEdit: () => void;
}) {
  const t = useTranslations('settings.apiTokens');
  const aria = t('editAria', { label });
  return (
    <Tooltip content={unavailable ?? aria}>
      <button
        type="button"
        aria-label={aria}
        aria-disabled={unavailable ? true : undefined}
        onClick={unavailable ? undefined : onEdit}
        className={`inline-flex size-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none ${unavailable ? 'cursor-not-allowed opacity-50' : 'hover:bg-(--el-surface) hover:text-(--el-text)'}`}
      >
        <Pencil className="size-4" aria-hidden />
      </button>
    </Tooltip>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`py-(--spacing-control-y) pr-4 font-sans text-xs font-medium tracking-wide text-(--el-text-secondary) uppercase ${className}`}
    >
      {children}
    </th>
  );
}

/** The Expires cell: "Never" when null, the relative "in N days" (warning chip
 * within ~7 days) once `now` is known, and the absolute date as the
 * hydration-safe fallback before mount. */
function renderExpires(
  token: ApiTokenDto,
  now: number | null,
  locale: Locale,
  t: ReturnType<typeof useTranslations>,
) {
  if (!token.expiresAt) {
    return (
      <span className="font-sans text-sm text-(--el-text-secondary)">{t('expiresNever')}</span>
    );
  }
  if (now === null) {
    return (
      <span className="font-sans text-sm text-(--el-text-secondary)">
        {formatDate(token.expiresAt, locale)}
      </span>
    );
  }
  const days = Math.ceil((new Date(token.expiresAt).getTime() - now) / DAY_MS);
  if (days < 0) {
    // Past expiry — show the (muted) date; verify already rejects it. An
    // expired token is still a listed, deletable row (it keeps its revoke
    // button); only the REVOKED state was removed (MOTIR-3546).
    return (
      <span className="font-sans text-sm text-(--el-text-secondary)">
        {formatDate(token.expiresAt, locale)}
      </span>
    );
  }
  const text = t('expiresIn', { days });
  if (days <= EXPIRING_SOON_DAYS) {
    return <Pill severity="warning">{text}</Pill>;
  }
  return <span className="font-sans text-sm text-(--el-text-secondary)">{text}</span>;
}
