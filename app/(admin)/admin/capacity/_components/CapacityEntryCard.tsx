'use client';

import { useTranslations } from 'next-intl';
import { Clock, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformCapacityEntryDTO } from '@/lib/dto/platformCapacity';
import { CELL, Capacity429Row, CapacityLimitRow } from './CapacityLimitRow';
import { NotEnforcedFold } from './NotEnforcedFold';

/**
 * One MODEL ENTRY (MOTIR-9614, design `platform-admin` AMENDMENT 2026-10-25,
 * Panels 1 and 4–7): the model id, its tier note and planning share, the limit
 * rows it enforces, the 429 row, and the units it does not enforce folded away.
 *
 * `storeLive` is the read's counter store: with it live, an entry whose rows
 * read Unavailable missed the read's deadline on its own (Panel 5), and says so.
 */
export function CapacityEntryCard({
  entry,
  storeLive,
  onEdit,
}: {
  entry: PlatformCapacityEntryDTO;
  storeLive: boolean;
  /** Absent when the viewer cannot edit: no Edit button is rendered at all. */
  onEdit?: (entry: PlatformCapacityEntryDTO) => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const enforced = entry.limits.filter((row) => row.limit.status !== 'not_applicable');
  const notEnforced = entry.limits
    .filter((row) => row.limit.status === 'not_applicable')
    .map((row) => row.unit);
  const slow = storeLive && enforced.some((row) => row.state === 'unavailable');

  return (
    <Card
      data-testid={`capacity-entry-${entry.provider}-${entry.model}`}
      header={<EntryHeader entry={entry} onEdit={onEdit} />}
    >
      {entry.unknownNote && (
        <p className="mb-2 text-xs text-(--el-text-secondary)">
          {t('entry.unknownNote', { note: entry.unknownNote })}
        </p>
      )}
      {slow && (
        <p
          role="status"
          className="mb-2 flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-yellow) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-xs text-(--el-text-strong)"
        >
          <Clock aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-(--el-warning)" />
          <span>{t('slow.notice')}</span>
        </p>
      )}
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="text-xs text-(--el-text-secondary)">
            <th className={`${CELL} w-[22%] font-medium`}>{t('col.limit')}</th>
            <th className={`${CELL} w-[30%] font-medium`}>{t('col.usage')}</th>
            <th className={`${CELL} w-[28%] font-medium`}>{t('col.share')}</th>
            <th className={`${CELL} font-medium`}>{t('col.state')}</th>
          </tr>
        </thead>
        <tbody>
          {enforced.map((row) => (
            <CapacityLimitRow key={row.unit} row={row} />
          ))}
          <Capacity429Row counts={entry.rateLimited429} />
        </tbody>
      </table>
      <NotEnforcedFold units={notEnforced} />
    </Card>
  );
}

function EntryHeader({
  entry,
  onEdit,
}: {
  entry: PlatformCapacityEntryDTO;
  onEdit?: (entry: PlatformCapacityEntryDTO) => void;
}) {
  const t = useTranslations('platformAdmin.capacity');
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="font-mono text-sm font-semibold text-(--el-text)">{entry.model}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-(--el-text-secondary)">
          {entry.tierNote ? (
            <span className="text-(--el-text)">
              {t('entry.tierNote', { note: entry.tierNote })}
            </span>
          ) : (
            <span className="italic">{t('entry.noTierNote')}</span>
          )}
          <Pill className="border-transparent bg-(--el-tint-lavender) text-(--el-text-strong)">
            {t('entry.planningShare', { share: entry.planningSharePercent })}
          </Pill>
        </div>
      </div>
      {onEdit && (
        <Button variant="secondary" size="sm" onClick={() => onEdit(entry)}>
          <Pencil aria-hidden className="h-3.5 w-3.5" />
          {t('entry.edit')}
        </Button>
      )}
    </div>
  );
}
