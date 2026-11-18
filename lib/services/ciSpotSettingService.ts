import 'server-only';

import { isCiSpotInstanceType } from '@/lib/ciFleet/ciSpotInstanceTypes';
import { InvalidCiSpotInstanceTypesError } from '@/lib/ciFleet/errors';
import type {
  CiSpotSettingSaveDTO,
  CiSpotSettingStateDTO,
  CiSpotSettingValue,
} from '@/lib/dto/ciSpotSetting';
import { toCiSpotSettingStateDTO, toCiSpotSettingValue } from '@/lib/mappers/ciSpotSettingMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformWrite, type PlatformAuditEntry } from '@/lib/platform/context';
import {
  CI_SPOT_SETTING_SCOPE,
  platformCiSpotSettingRepository,
} from '@/lib/repositories/platformCiSpotSettingRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The CI runner Spot setting (MOTIR-11725) — whether CI runners on an AWS pool
 * account launch as Spot, and the ORDERED instance types a launch may walk.
 *
 * One persisted row (`scope = 'ci_runner'`). No row ⇒ Spot OFF and the default
 * types, so deploying this changes no launch until a person saves it. System code
 * (the CI runner boot and the CI shard's AWS adapter, MOTIR-11716) reads it
 * through {@link ciSpotSettingService.read} on every launch, never cached, so a
 * save applies to the next launch with no restart.
 *
 * Only a `superadmin` reads the stored state or saves it, through
 * `app/api/platform/fleet/ci-spot/route.ts` — there is no console screen. The
 * save is `agentHostingSettingService.setOnPool`'s order: role, reason,
 * validation, stored-state compare, then the audited transaction that locks,
 * re-reads, upserts and appends the `fleet.ci_spot.update` audit row.
 */

/** Thrown inside the transaction when the re-read under the lock already holds
 *  the asked values, so the transaction (and its row) rolls back. */
class UnchangedUnderLock extends Error {}

/**
 * Refuse a list that breaks a rule — empty, a type named twice, or a type outside
 * the closed allowlist — naming the rule and the offending type.
 */
function assertInstanceTypesValid(instanceTypes: unknown): asserts instanceTypes is string[] {
  if (!Array.isArray(instanceTypes) || instanceTypes.length === 0) {
    throw new InvalidCiSpotInstanceTypesError('empty');
  }
  const seen = new Set<string>();
  for (const type of instanceTypes) {
    if (typeof type !== 'string' || !isCiSpotInstanceType(type)) {
      throw new InvalidCiSpotInstanceTypesError('not_allowed', String(type));
    }
    if (seen.has(type)) throw new InvalidCiSpotInstanceTypesError('duplicate', type);
    seen.add(type);
  }
}

/** Same flag and the same types in the same ORDER — the launch walks the list in
 *  order, so a reorder is a change. */
function sameValue(a: CiSpotSettingValue, b: CiSpotSettingValue): boolean {
  return (
    a.enabled === b.enabled &&
    a.instanceTypes.length === b.instanceTypes.length &&
    a.instanceTypes.every((type, i) => type === b.instanceTypes[i])
  );
}

async function storedState(): Promise<CiSpotSettingStateDTO> {
  const row = await platformCiSpotSettingRepository.find();
  const updater = row?.updatedByUserId
    ? ((await userRepository.findByIds([row.updatedByUserId]))[0] ?? null)
    : null;
  return toCiSpotSettingStateDTO(row, updater);
}

export const ciSpotSettingService = {
  /**
   * THE SYSTEM READ — what a CI runner launch goes by. No principal, no session
   * and no platform transaction: the table's SELECT arm is unconditional. No row
   * ⇒ `{ enabled: false, instanceTypes: CI_SPOT_DEFAULT_INSTANCE_TYPES }`; it
   * never throws for a missing row. Read from the database on every call.
   */
  async read(): Promise<CiSpotSettingValue> {
    return toCiSpotSettingValue(await platformCiSpotSettingRepository.find());
  },

  /**
   * The setting as stored, with who saved it last, when and why. Not audited: it
   * reads no tenant row (the agent hosting `getState` reason).
   *
   * @throws NotPlatformStaffError below `superadmin`.
   */
  async getState(principal: PlatformPrincipal): Promise<CiSpotSettingStateDTO> {
    void principal;
    await requirePlatformStaff('superadmin');
    return storedState();
  },

  /**
   * Save whether CI runners launch as Spot and the ordered instance types. The
   * ORDER is the contract:
   *
   *   1. `superadmin`.
   *   2. The REASON, before any transaction.
   *   3. The list — not empty, no duplicate, every type allowed.
   *   4. The stored state: already as asked ⇒ `unchanged`, nothing written.
   *   5. The audited transaction: lock, re-read, upsert, audit row.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   * @throws InvalidCiSpotInstanceTypesError for a list that breaks a rule.
   */
  async save(
    principal: PlatformPrincipal,
    value: { enabled: boolean; instanceTypes: string[] },
    reason: string,
  ): Promise<CiSpotSettingSaveDTO> {
    await requirePlatformStaff('superadmin');
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const base = {
      action: 'fleet.ci_spot.update' as const,
      targetKind: 'platform' as const,
      targetId: CI_SPOT_SETTING_SCOPE,
      targetLabel: 'CI Spot',
      reason: trimmed,
    };
    assertReasonSatisfied(base);
    assertInstanceTypesValid(value.instanceTypes);
    const asked: CiSpotSettingValue = {
      enabled: value.enabled,
      instanceTypes: [...value.instanceTypes],
    };

    const before = await storedState();
    if (sameValue(before, asked)) return { outcome: 'unchanged', state: before };

    try {
      await withPlatformWrite(principal, async (tx, record) => {
        const locked = toCiSpotSettingValue(
          await platformCiSpotSettingRepository.lockForUpdate(tx),
        );
        if (sameValue(locked, asked)) throw new UnchangedUnderLock();
        await platformCiSpotSettingRepository.upsert(
          { ...asked, lastReason: trimmed, updatedByUserId: principal.userId },
          tx,
        );
        const entry: PlatformAuditEntry = {
          ...base,
          metadata: {
            from: { enabled: locked.enabled, instanceTypes: locked.instanceTypes },
            to: { enabled: asked.enabled, instanceTypes: asked.instanceTypes },
          },
        };
        await record(entry);
      });
    } catch (err) {
      if (err instanceof UnchangedUnderLock) {
        return { outcome: 'unchanged', state: await storedState() };
      }
      throw err;
    }
    return { outcome: 'changed', state: await storedState() };
  },
};
