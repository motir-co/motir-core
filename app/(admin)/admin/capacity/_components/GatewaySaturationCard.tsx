'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import type { PlatformGatewaySaturationDTO } from '@/lib/dto/platformCapacity';
import { CELL } from './CapacityLimitRow';
import { STATE_LOOK } from './capacityDisplay';

/**
 * The GATEWAY-SATURATION row (MOTIR-9675, design D6 of MOTIR-9667's gateway
 * design), composed from an entry card's limit row: connections in use, created
 * machines, hard limit, the share of created machines × hard limit, and the state
 * the judge decided.
 *
 * ⚠️ A MISSING NUMBER IS NEVER 0, as on the provider rows: a figure not read
 * prints "Unavailable", the share a dash, and with no source wired the row says
 * so instead of drawing a bar.
 */
export function GatewaySaturationCard({
  saturation,
}: {
  saturation: PlatformGatewaySaturationDTO;
}) {
  const t = useTranslations('platformAdmin.capacity');
  const format = useFormatter();
  const look = STATE_LOOK[saturation.state];
  const figure = (value: number | null) =>
    value === null ? (
      <span className="text-(--el-text-secondary) italic">{t('state.unavailable')}</span>
    ) : (
      format.number(value)
    );
  return (
    <Card
      data-testid="capacity-gateway-saturation"
      header={
        <div>
          <div className="text-sm font-semibold text-(--el-text)">{t('saturation.title')}</div>
          <div className="mt-1 text-xs text-(--el-text-secondary)">
            {t('saturation.hsub', { percent: saturation.alertPercent })}
          </div>
        </div>
      }
    >
      {saturation.unavailableReason && (
        <p className="mb-2 text-xs text-(--el-text-secondary)" role="status">
          {t(
            saturation.unavailableReason === 'not_configured'
              ? 'saturation.notConfigured'
              : 'saturation.readFailed',
          )}
        </p>
      )}
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="text-xs text-(--el-text-secondary)">
            <th className={`${CELL} font-medium`}>{t('saturation.connections')}</th>
            <th className={`${CELL} font-medium`}>{t('saturation.machines')}</th>
            <th className={`${CELL} font-medium`}>{t('saturation.hardLimit')}</th>
            <th className={`${CELL} font-medium`}>{t('col.share')}</th>
            <th className={`${CELL} font-medium`}>{t('col.state')}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-(--el-border-soft) tabular-nums text-(--el-text)">
            <td className={CELL} data-testid="saturation-connections">
              {figure(saturation.connectionsInUse)}
            </td>
            <td className={CELL} data-testid="saturation-machines">
              {figure(saturation.createdMachines)}
            </td>
            <td className={CELL} data-testid="saturation-hard-limit">
              {figure(saturation.hardLimit)}
            </td>
            <td className={CELL} data-testid="saturation-share">
              <ShareCell saturation={saturation} />
            </td>
            <td className={CELL}>
              <Pill {...look.pill}>{t(`state.${look.label}`)}</Pill>
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function ShareCell({ saturation }: { saturation: PlatformGatewaySaturationDTO }) {
  const t = useTranslations('platformAdmin.capacity');
  const format = useFormatter();
  if (saturation.sharePercent === null || saturation.capacityConnections === null) {
    return <span className="text-(--el-text-secondary) italic">—</span>;
  }
  const width = Math.min(100, Math.max(0, saturation.sharePercent));
  return (
    <span className="flex items-center gap-2.5 text-xs tabular-nums text-(--el-text)">
      <span
        aria-hidden
        className="block h-2 w-full min-w-21 overflow-hidden rounded-(--radius-badge) bg-(--el-surface)"
      >
        <span
          className={`block h-full rounded-(--radius-badge) ${STATE_LOOK[saturation.state].bar}`}
          style={{ width: `${width}%` }}
        />
      </span>
      <span className="shrink-0">
        {t('saturation.share', {
          value: Math.round(saturation.sharePercent),
          capacity: format.number(saturation.capacityConnections),
        })}
      </span>
    </span>
  );
}
