import 'server-only';

import {
  type CapacityAlertKey,
  DEFAULT_ALERT_SHARE_PERCENT,
  MAX_ALERT_SHARE_PERCENT,
  MIN_ALERT_SHARE_PERCENT,
  isCapacityLimitUnit,
  isCapacityProvider,
} from '@/lib/capacity/alertKeys';
import {
  CapacityAlertKeyInvalidError,
  CapacityAlertShareInvalidError,
  CapacityAlertShareUnchangedError,
} from '@/lib/capacity/errors';
import type { CapacityAlertShareDTO, CapacityRaisedAlertDTO } from '@/lib/dto/capacityAlerts';
import {
  toCapacityAlertShareDTO,
  toCapacityRaisedAlertDTO,
} from '@/lib/mappers/capacityAlertMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformWrite } from '@/lib/platform/context';
import { capacityAlertSettingRepository } from '@/lib/repositories/capacityAlertSettingRepository';
import { capacityRaisedAlertRepository } from '@/lib/repositories/capacityRaisedAlertRepository';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * The capacity ALERT STATE — Story MOTIR-9539 · MOTIR-9609.
 *
 * It STORES and ANSWERS; it decides nothing. The alert share (default 80) is a
 * platform setting a platform `operator` changes as an audited write. The raised
 * alerts are one row per (provider, model, limit unit), and `raise` / `clear`
 * each say whether THIS call changed the row — which is what lets the evaluation
 * send an alert once while it stays raised, whoever evaluates (the scheduled job
 * or a screen load), even when both evaluate at the same moment.
 *
 * No gateway read, no threshold arithmetic and no Sentry call live here: those
 * are the evaluation service's.
 */

/** The reason recorded when the screen supplies none (`inherited` policy). */
const DEFAULT_SHARE_REASON = 'set in the capacity screen';

export interface CapacityAlertSnapshot {
  /** The usage that crossed the share, and the limit it crossed. */
  observedValue: number;
  limitValue: number;
  /** The share in force when it crossed. */
  alertSharePercent: number;
}

function assertAlertShare(percent: unknown): asserts percent is number {
  if (
    typeof percent !== 'number' ||
    !Number.isInteger(percent) ||
    percent < MIN_ALERT_SHARE_PERCENT ||
    percent > MAX_ALERT_SHARE_PERCENT
  ) {
    throw new CapacityAlertShareInvalidError(percent);
  }
}

function assertAlertKey(key: CapacityAlertKey): void {
  if (!isCapacityProvider(key.provider)) throw new CapacityAlertKeyInvalidError('provider');
  if (typeof key.model !== 'string' || key.model.trim() === '') {
    throw new CapacityAlertKeyInvalidError('model');
  }
  if (!isCapacityLimitUnit(key.limitUnit)) throw new CapacityAlertKeyInvalidError('limitUnit');
}

export const capacityAlertStateService = {
  /**
   * The alert share in force. Read by the job (no principal) and by the doors,
   * so it is neither gated nor audited: it reads a platform setting, no tenant row.
   */
  async getAlertShare(): Promise<CapacityAlertShareDTO> {
    const row = await withSystemContext((tx) => capacityAlertSettingRepository.find(tx));
    return toCapacityAlertShareDTO(row);
  },

  /**
   * Change the alert share — an audited `operator` write. The current value is
   * read INSIDE the audited transaction, after the chain lock (taken first by
   * `withPlatformWrite`), so two concurrent saves serialize and their audit rows
   * chain: the later row's `fromPercent` is the earlier row's `toPercent`. An
   * unchanged value throws, which rolls the transaction back with no audit row.
   */
  async setAlertShare(
    principal: PlatformPrincipal,
    percent: unknown,
    reason?: string,
  ): Promise<CapacityAlertShareDTO> {
    await requirePlatformStaff('operator');
    assertAlertShare(percent);
    const stated = reason?.trim() ? reason : DEFAULT_SHARE_REASON;
    const row = await withPlatformWrite(principal, async (tx, record) => {
      const current = await capacityAlertSettingRepository.find(tx);
      const fromPercent = current?.alertSharePercent ?? DEFAULT_ALERT_SHARE_PERCENT;
      if (fromPercent === percent) {
        throw new CapacityAlertShareUnchangedError(percent);
      }
      const written = await capacityAlertSettingRepository.upsert(percent, principal.userId, tx);
      await record({
        action: 'capacity.alert_share.set',
        targetKind: 'platform',
        targetId: 'capacity.alert_share',
        reason: stated,
        metadata: { fromPercent, toPercent: percent },
      });
      return written;
    });
    return toCapacityAlertShareDTO(row);
  },

  /** Mark the key raised with the snapshot that raised it. `newlyRaised` is true
   *  only for the one call that inserted the row; a raised key keeps its first
   *  `raisedAt` and snapshot. A system effect: no principal, no audit row. */
  async raise(
    key: CapacityAlertKey,
    snapshot: CapacityAlertSnapshot,
  ): Promise<{ newlyRaised: boolean }> {
    assertAlertKey(key);
    const newlyRaised = await withSystemContext((tx) =>
      capacityRaisedAlertRepository.insertIfAbsent(
        {
          provider: key.provider,
          model: key.model,
          limitUnit: key.limitUnit,
          observedValue: BigInt(snapshot.observedValue),
          limitValue: BigInt(snapshot.limitValue),
          alertSharePercent: snapshot.alertSharePercent,
        },
        tx,
      ),
    );
    return { newlyRaised };
  },

  /** Clear the key. `cleared` is true only for the one call that deleted the row. */
  async clear(key: CapacityAlertKey): Promise<{ cleared: boolean }> {
    assertAlertKey(key);
    const cleared = await withSystemContext((tx) =>
      capacityRaisedAlertRepository.deleteByKey(key, tx),
    );
    return { cleared };
  },

  /** Every raised alert, by provider, model and unit. */
  async listRaised(): Promise<CapacityRaisedAlertDTO[]> {
    const rows = await withSystemContext((tx) => capacityRaisedAlertRepository.listAll(tx));
    return rows
      .map(toCapacityRaisedAlertDTO)
      .filter((d): d is CapacityRaisedAlertDTO => d !== null);
  },
};
