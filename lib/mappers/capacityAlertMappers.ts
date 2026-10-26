import type { CapacityAlertSetting, CapacityRaisedAlert } from '@/generated/prisma/client';
import {
  DEFAULT_ALERT_SHARE_PERCENT,
  isCapacityLimitUnit,
  isCapacityProvider,
} from '@/lib/capacity/alertKeys';
import type {
  CapacityAlertShareDTO,
  CapacityRaisedAlertDTO,
  GatewaySaturationRaisedAlertDTO,
} from '@/lib/dto/capacityAlerts';

/** The stored setting (or none) → its DTO. `updatedByUserId` is never copied. */
export function toCapacityAlertShareDTO(row: CapacityAlertSetting | null): CapacityAlertShareDTO {
  if (!row) return { percent: DEFAULT_ALERT_SHARE_PERCENT, isDefault: true, updatedAt: null };
  return { percent: row.alertSharePercent, isDefault: false, updatedAt: row.updatedAt };
}

/** A BigInt figure as a `number`. Every value is carried as a number: one past
 *  `Number.MAX_SAFE_INTEGER` cannot be a provider's figure, so it is refused. */
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('a capacity figure is past the safe integer range');
  }
  return Number(value);
}

/** A raised-alert row → its DTO, or `null` for a row whose key this build does not know. */
export function toCapacityRaisedAlertDTO(row: CapacityRaisedAlert): CapacityRaisedAlertDTO | null {
  if (!isCapacityProvider(row.provider) || !isCapacityLimitUnit(row.limitUnit)) return null;
  return {
    provider: row.provider,
    model: row.model,
    limitUnit: row.limitUnit,
    raisedAt: row.raisedAt,
    observedValue: safeNumber(row.observedValue),
    limitValue: safeNumber(row.limitValue),
    alertSharePercent: row.alertSharePercent,
  };
}

/** The gateway-saturation row → its DTO (MOTIR-9675). */
export function toGatewaySaturationRaisedAlertDTO(
  row: CapacityRaisedAlert,
): GatewaySaturationRaisedAlertDTO {
  return {
    raisedAt: row.raisedAt,
    observedValue: safeNumber(row.observedValue),
    limitValue: safeNumber(row.limitValue),
    alertSharePercent: row.alertSharePercent,
  };
}
