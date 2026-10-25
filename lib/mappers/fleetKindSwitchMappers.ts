import type { User } from '@/generated/prisma/client';
import type { FleetKindSwitchStateDTO } from '@/lib/dto/fleetKindSwitch';
import type { PlatformFleetKindSwitchRow } from '@/lib/repositories/platformFleetKindSwitchRepository';

/** A stored switch row (or none, which is OFF) → the console's stored state. */
export function toFleetKindSwitchStateDTO(
  row: PlatformFleetKindSwitchRow | null,
  updater: Pick<User, 'id' | 'email'> | null,
): FleetKindSwitchStateDTO {
  if (!row) return { onPool: false, updatedBy: null, updatedAt: null, lastReason: null };
  return {
    onPool: row.onPool,
    updatedBy: updater ? { userId: updater.id, email: updater.email } : null,
    updatedAt: row.updatedAt.toISOString(),
    lastReason: row.lastReason,
  };
}
