'use client';

import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { permissionSlug, type PermissionKey } from '@/lib/permissions/catalog';
import { GRANTABLE_PERMISSIONS } from '@/lib/tokens/grant';

// The live ADDING / REMOVING summary of a permission change (MOTIR-10188,
// design `account-settings--edit-token-permissions.mock.html` Panels 2, 3, 6 and
// the `/device` update panels 10–11). The edit-permissions modal pins it beside
// Save; `/device` in update mode renders it compact inside its Changes block.
//
// The chip grammar is the token row's scope-detail chip. The HUE is the tint
// (mint for added, rose for removed) with `--el-text-strong` ink — the AA pairing
// for text on a tint — and the MEANING is carried by the line's label and the
// `+` / `−` glyph as well, so it never rests on colour alone.

const CATALOGUE_ORDER = new Map<PermissionKey, number>(GRANTABLE_PERMISSIONS.map((k, i) => [k, i]));
const byCatalogue = (a: PermissionKey, b: PermissionKey) =>
  (CATALOGUE_ORDER.get(a) ?? Infinity) - (CATALOGUE_ORDER.get(b) ?? Infinity);

/** What changes between two grants: `added` holds the keys only `after` has,
 * `removed` the keys only `before` has — each in catalogue order, so the summary
 * reads the same whichever order the switches were flipped in. */
export function diffGrant(
  before: Iterable<PermissionKey>,
  after: Iterable<PermissionKey>,
): { added: PermissionKey[]; removed: PermissionKey[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: [...now].filter((k) => !was.has(k)).sort(byCatalogue),
    removed: [...was].filter((k) => !now.has(k)).sort(byCatalogue),
  };
}

export function PermissionChangeSummary({
  added,
  removed,
  compact = false,
}: {
  added: readonly PermissionKey[];
  removed: readonly PermissionKey[];
  /** Drop the box and its own label — for a host that already labels the block. */
  compact?: boolean;
}) {
  const t = useTranslations('settings.apiTokens.edit');
  const tp = useTranslations('permissions');
  const none = added.length === 0 && removed.length === 0;

  const chip = (key: PermissionKey, kind: 'add' | 'remove') => (
    <span
      key={key}
      className={`inline-flex items-center gap-1 rounded-(--radius-badge) border border-transparent px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) ${kind === 'add' ? 'bg-(--el-tint-mint)' : 'bg-(--el-tint-rose)'}`}
    >
      {kind === 'add' ? (
        <Plus className="size-3 text-(--el-text-strong)" aria-hidden />
      ) : (
        <Minus className="size-3 text-(--el-text-strong)" aria-hidden />
      )}
      {tp(`${permissionSlug(key)}.label`)}
    </span>
  );

  const line = (label: string, keys: readonly PermissionKey[], kind: 'add' | 'remove') =>
    keys.length === 0 ? null : (
      <div className="flex flex-wrap items-center gap-1.5" data-change={kind}>
        <span className="w-[5.5rem] shrink-0 font-sans text-xs font-medium text-(--el-text-secondary)">
          {label}
        </span>
        {keys.map((k) => chip(k, kind))}
      </div>
    );

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        compact
          ? 'flex flex-col gap-1.5'
          : 'flex flex-col gap-1.5 rounded-(--radius-card) border border-(--el-border-soft) bg-(--el-surface-soft) px-(--spacing-control-x) py-(--spacing-control-y)'
      }
    >
      {compact ? null : (
        <span className="font-mono text-[0.625rem] tracking-wide text-(--el-text-secondary) uppercase">
          {t('changes.label')}
        </span>
      )}
      {none ? (
        <span className="font-sans text-xs text-(--el-text-secondary)">{t('changes.none')}</span>
      ) : (
        <>
          {line(t('changes.adding'), added, 'add')}
          {line(t('changes.removing'), removed, 'remove')}
        </>
      )}
    </div>
  );
}
