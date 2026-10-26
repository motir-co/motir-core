'use client';

import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import type { PlatformCapacityRaisedDTO } from '@/lib/dto/platformCapacity';
import { utcClock } from './capacityDisplay';

/**
 * The RAISED-ALERTS BANNER (MOTIR-9614, design `platform-admin` AMENDMENT
 * 2026-10-25, Panels 1–2): one line per limit currently over the alert share,
 * from core's raised-alert state. With nothing raised it renders NOTHING — no
 * "all clear" stands in its place (Panel 2).
 *
 * The share is the one the alert was raised at (`observedValue / limitValue`),
 * not this read's: the banner says what raised the alert and since when.
 */
export function RaisedAlertsBanner({ raised }: { raised: PlatformCapacityRaisedDTO[] }) {
  const t = useTranslations('platformAdmin.capacity');
  if (raised.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="capacity-raised-alerts"
      className="flex items-start gap-2 rounded-(--radius-card) border border-(--el-border) bg-(--el-tint-rose) px-(--spacing-control-x-12) py-(--spacing-control-y-8) text-xs text-(--el-text-strong)"
    >
      <TriangleAlert aria-hidden className="mt-px h-4 w-4 shrink-0 text-(--el-danger)" />
      <div>
        <strong>{t('alerts.title', { count: raised.length })}</strong>
        <ul className="mt-1.5 list-disc pl-4.5 leading-relaxed">
          {raised.map((alert) => (
            <li key={`${alert.provider}/${alert.model}/${alert.unit}`}>
              <strong>
                {t('alerts.line', {
                  provider: t(`provider.${alert.provider}`),
                  model: alert.model,
                  limit: t(`unit.${alert.unit}`),
                  share: sharePercent(alert),
                })}
              </strong>
              ,{' '}
              <span className="text-(--el-text-secondary)">
                {t('alerts.since', { time: utcClock(alert.raisedAt, false) })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function sharePercent(alert: PlatformCapacityRaisedDTO): number | string {
  // A limit of 0 is over at any usage and has no share (design § How a row is
  // judged): it reads a dash, never a number nobody measured.
  return alert.limitValue > 0 ? Math.round((alert.observedValue * 100) / alert.limitValue) : '—';
}
