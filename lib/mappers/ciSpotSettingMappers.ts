import type { User } from '@/generated/prisma/client';
import { CI_SPOT_DEFAULT_INSTANCE_TYPES } from '@/lib/ciFleet/ciSpotInstanceTypes';
import type { CiSpotSettingStateDTO, CiSpotSettingValue } from '@/lib/dto/ciSpotSetting';
import type { PlatformCiSpotSettingRow } from '@/lib/repositories/platformCiSpotSettingRepository';

/** A stored row (or none, which is OFF with the defaults) → the values system
 *  code launches by. A stored row is trusted as it stands: every write passed
 *  the same validation, so the read neither re-validates nor drops entries. */
export function toCiSpotSettingValue(
  row: Pick<PlatformCiSpotSettingRow, 'enabled' | 'instanceTypes'> | null,
): CiSpotSettingValue {
  if (!row) return { enabled: false, instanceTypes: [...CI_SPOT_DEFAULT_INSTANCE_TYPES] };
  return { enabled: row.enabled, instanceTypes: [...row.instanceTypes] };
}

/** A stored row (or none) → the console's stored state. */
export function toCiSpotSettingStateDTO(
  row: PlatformCiSpotSettingRow | null,
  updater: Pick<User, 'id' | 'email'> | null,
): CiSpotSettingStateDTO {
  const value = toCiSpotSettingValue(row);
  if (!row) {
    return { ...value, isDefault: true, lastReason: null, updatedBy: null, updatedAt: null };
  }
  return {
    ...value,
    isDefault: false,
    lastReason: row.lastReason,
    updatedBy: updater ? { userId: updater.id, email: updater.email } : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
