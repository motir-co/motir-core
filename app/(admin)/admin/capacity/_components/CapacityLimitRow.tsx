'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Pill } from '@/components/ui/Pill';
import type {
  PlatformCapacity429DTO,
  PlatformCapacityEntryDTO,
  PlatformCapacityLimitRowDTO,
} from '@/lib/dto/platformCapacity';
import { STATE_LOOK } from './capacityDisplay';

/**
 * One LIMIT ROW of a model entry (MOTIR-9614, design `platform-admin`
 * AMENDMENT 2026-10-25 § How a row is judged, Panels 1 and 4–7).
 *
 * ⚠️ A MISSING NUMBER IS NEVER 0. `usage: null` prints a word and no bar,
 * `sharePercent: null` prints a dash, an `unknown` limit prints "limit not
 * known", and only a `set` limit of 0 prints "Limit 0". The state is the row's
 * own, decided by the threshold function; nothing here compares numbers.
 */

export const CELL = 'px-(--spacing-control-x-12) py-(--spacing-control-y-8) align-top';
const NA = 'text-(--el-text-secondary) italic';
const LANE = 'mt-0.5 block text-xs text-(--el-text-secondary)';

export function CapacityLimitRow({ row }: { row: PlatformCapacityLimitRowDTO }) {
  const t = useTranslations('platformAdmin.capacity');
  const look = STATE_LOOK[row.state];
  return (
    <tr className="border-t border-(--el-border-soft)" data-testid={`capacity-row-${row.unit}`}>
      <td className={`${CELL} font-medium text-(--el-text)`}>{t(`unit.${row.unit}`)}</td>
      <td className={`${CELL} tabular-nums text-(--el-text)`}>
        <UsageCell row={row} />
      </td>
      <td className={CELL}>
        <ShareCell row={row} />
      </td>
      <td className={CELL}>
        <Pill {...look.pill}>{t(`state.${look.label}`)}</Pill>
      </td>
    </tr>
  );
}

function UsageCell({ row }: { row: PlatformCapacityLimitRowDTO }) {
  const t = useTranslations('platformAdmin.capacity');
  const format = useFormatter();
  const { usage, limit } = row;
  const usageText = usage ? (
    format.number(usage.total)
  ) : (
    <span className={NA}>
      {t(row.state === 'usage_not_reported' ? 'state.unreported' : 'state.unavailable')}
    </span>
  );
  let limitText;
  if (limit.status === 'set') {
    limitText = limit.value === 0 ? t('limitZero') : format.number(limit.value);
  } else {
    limitText = <span className={NA}>{t('limitUnknown')}</span>;
  }
  return (
    <>
      {usageText} / {limitText}
      {usage && (
        <span className={LANE}>
          {t('lanes', {
            planning: format.number(usage.planning),
            agent: format.number(usage.agent),
          })}
        </span>
      )}
    </>
  );
}

function ShareCell({ row }: { row: PlatformCapacityLimitRowDTO }) {
  const t = useTranslations('platformAdmin.capacity');
  if (row.sharePercent === null) return <span className={NA}>—</span>;
  const width = Math.min(100, Math.max(0, row.sharePercent));
  return (
    <span className="flex items-center gap-2.5 text-xs tabular-nums text-(--el-text)">
      <span
        aria-hidden
        className="block h-2 w-full min-w-21 overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
      >
        <span
          data-testid="capacity-share-bar"
          className={`block h-full rounded-(--radius-badge) ${STATE_LOOK[row.state].bar}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="shrink-0">{t('percent', { value: Math.round(row.sharePercent) })}</span>
    </span>
  );
}

/** The 429 row: counts only — no limit, so no bar and no state (contract §5). */
export function Capacity429Row({ counts }: { counts: PlatformCapacityEntryDTO['rateLimited429'] }) {
  const t = useTranslations('platformAdmin.capacity');
  const format = useFormatter();
  const lane = (value: PlatformCapacity429DTO | null, pick: 'minute' | 'day') =>
    value ? format.number(value[pick]) : t('state.unavailable');
  const split = (pick: 'minute' | 'day') =>
    t('lanes', { planning: lane(counts.planning, pick), agent: lane(counts.agent, pick) });
  return (
    <tr
      className="border-t border-(--el-border-soft) bg-(--el-surface-soft) text-(--el-text)"
      data-testid="capacity-row-429"
    >
      <td className={`${CELL} font-medium`}>{t('r429.label')}</td>
      <td className={CELL}>
        {t('r429.minute')}
        <span className={LANE}>{split('minute')}</span>
      </td>
      <td className={CELL}>
        {t('r429.day')}
        <span className={LANE}>{split('day')}</span>
      </td>
      <td className={CELL}>
        <span className="text-xs text-(--el-text-secondary)">{t('r429.note')}</span>
      </td>
    </tr>
  );
}
