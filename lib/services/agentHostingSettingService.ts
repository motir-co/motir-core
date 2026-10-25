import 'server-only';

import type { FleetKindSwitchFlipDTO, FleetKindSwitchStateDTO } from '@/lib/dto/fleetKindSwitch';
import { toFleetKindSwitchStateDTO } from '@/lib/mappers/fleetKindSwitchMappers';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformWrite, type PlatformAuditEntry } from '@/lib/platform/context';
import { platformFleetKindSwitchRepository } from '@/lib/repositories/platformFleetKindSwitchRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import { assertReasonSatisfied } from '@/lib/services/platformAuditService';

/**
 * The platform setting "Agent hosting" — the agent hoster's Fly↔AWS switch
 * (MOTIR-9503; design MOTIR-9534, `platform-admin/design-notes.md` § Fleet
 * settings · Agent hosting).
 *
 * One persisted row for the `agent_instance` fleet kind. OFF (or no row) ⇒ new
 * agent instances are created on Fly; ON ⇒ each new one is placed on an account
 * of the agent-hoster AWS pool. Neither moves an agent that already exists. The
 * switch has no precondition and no remote effect: placement reads the row on
 * every new instance through `agentHosterOnPool` (`lib/ciFleet/fleetKindSwitches.ts`),
 * so a flip applies to the next agent created, with no restart.
 *
 * Only a `superadmin` reads or flips it — the section has no read-only face.
 * `fleetOrgCiSettingService.setEnabled`'s order, without the GitHub half:
 * reason first, then the stored state, then the audited transaction that locks,
 * re-reads, upserts and appends the audit row.
 */

const KIND = 'agent_instance' as const;

/** Thrown inside the transaction when the re-read under the lock already holds
 *  the asked state, so the transaction (and its row) rolls back. */
class UnchangedUnderLock extends Error {}

async function storedState(): Promise<FleetKindSwitchStateDTO> {
  const row = await platformFleetKindSwitchRepository.find(KIND);
  const updater = row?.updatedByUserId
    ? ((await userRepository.findByIds([row.updatedByUserId]))[0] ?? null)
    : null;
  return toFleetKindSwitchStateDTO(row, updater);
}

export const agentHostingSettingService = {
  /**
   * The switch as stored. Not audited: it reads no tenant row — the last flip's
   * reason is kept on the row itself (the fleet org CI `getState` reason).
   *
   * @throws NotPlatformStaffError below `superadmin`.
   */
  async getState(principal: PlatformPrincipal): Promise<FleetKindSwitchStateDTO> {
    void principal;
    await requirePlatformStaff('superadmin');
    return storedState();
  },

  /**
   * Turn the agent hoster's pool ON (AWS) or OFF (Fly). The ORDER is the contract:
   *
   *   1. `superadmin`.
   *   2. The REASON, before any transaction.
   *   3. The stored state: already as asked ⇒ `unchanged`, nothing written.
   *   4. The audited transaction: lock, re-read, upsert, audit row.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws MissingAuditReasonError for a blank reason.
   */
  async setOnPool(
    principal: PlatformPrincipal,
    onPool: boolean,
    reason: string,
  ): Promise<FleetKindSwitchFlipDTO> {
    await requirePlatformStaff('superadmin');
    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    const base = {
      action: onPool
        ? ('fleet.agent_hosting.enable' as const)
        : ('fleet.agent_hosting.disable' as const),
      targetKind: 'platform' as const,
      targetId: KIND,
      targetLabel: 'Agent hosting',
      reason: trimmed,
    };
    assertReasonSatisfied(base);

    const before = await storedState();
    if (before.onPool === onPool) return { outcome: 'unchanged', state: before };

    try {
      await withPlatformWrite(principal, async (tx, record) => {
        const locked = await platformFleetKindSwitchRepository.lockForUpdate(KIND, tx);
        if ((locked?.onPool ?? false) === onPool) throw new UnchangedUnderLock();
        await platformFleetKindSwitchRepository.upsert(
          { fleetKind: KIND, onPool, lastReason: trimmed, updatedByUserId: principal.userId },
          tx,
        );
        const entry: PlatformAuditEntry = {
          ...base,
          metadata: { fleetKind: KIND, from: !onPool, to: onPool },
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
