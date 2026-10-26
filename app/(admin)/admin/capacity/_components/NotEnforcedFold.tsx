'use client';

import { useTranslations } from 'next-intl';
import type { CapacityLimitUnit } from '@/lib/capacity/alertKeys';

/**
 * The UNITS-NOT-ENFORCED FOLD (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25 § How a row is judged): a native `<details>`, closed, each unit the
 * provider does not limit reading Not applicable — never a 0. Shared by the model
 * entry and the Edit dialog, which draws the same fold. Absent with no such unit.
 */
export function NotEnforcedFold({ units }: { units: CapacityLimitUnit[] }) {
  const t = useTranslations('platformAdmin.capacity');
  if (units.length === 0) return null;
  return (
    <details
      className="mt-2.5 border-t border-(--el-border-soft) pt-2 text-xs"
      data-testid="capacity-not-enforced"
    >
      <summary className="cursor-pointer font-medium text-(--el-text-secondary)">
        {t('fold', { count: units.length })}
      </summary>
      <ul className="mt-2 grid grid-cols-1 gap-x-3.5 gap-y-1.5 sm:grid-cols-3">
        {units.map((unit) => (
          <li key={unit} className="flex justify-between gap-2 text-(--el-text)">
            {t(`unit.${unit}`)}
            <span className="text-(--el-text-secondary) italic">{t('state.na')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
