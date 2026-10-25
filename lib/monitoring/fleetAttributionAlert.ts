import * as Sentry from '@sentry/nextjs';
import type {
  FleetInventoryUnavailableError,
  UnattributedMachineDestroyedError,
  UnattributedVolumeDestroyedError,
} from '@/lib/ciFleet/attributionErrors';

/**
 * Tell the platform admin about one reconciler finding (MOTIR-6925).
 *
 * ⚠️ FINGERPRINTED PER MACHINE, or per app for a listing failure. The record asks
 * for ONE issue per destroyed machine, so a leak of forty machines is forty
 * issues a person can count, and a listing that fails every pass is one issue
 * that keeps getting louder rather than a new one every five minutes.
 *
 * NEVER THROWS: an alert is not allowed to stop the pass that raised it. A build
 * with no DSN never called `Sentry.init`, so every call is a no-op there.
 */
export function alertFleetAttribution(
  error:
    | UnattributedMachineDestroyedError
    | UnattributedVolumeDestroyedError
    | FleetInventoryUnavailableError,
): void {
  try {
    // A deleted disk is one issue per disk, as a machine is (MOTIR-9476).
    const perMachine =
      error.name === 'UnattributedMachineDestroyedError' ||
      error.name === 'UnattributedVolumeDestroyedError';
    const machineId =
      error.name === 'UnattributedMachineDestroyedError'
        ? (error as UnattributedMachineDestroyedError).machineId
        : error.name === 'UnattributedVolumeDestroyedError'
          ? (error as UnattributedVolumeDestroyedError).volumeId
          : '';
    // An own account's machine names its owner, and a foreign record's org
    // (MOTIR-9584) — ids only, never a credential or a member-account email.
    const machine =
      error.name === 'UnattributedMachineDestroyedError'
        ? (error as UnattributedMachineDestroyedError)
        : null;
    Sentry.captureException(error, {
      level: perMachine ? 'warning' : 'error',
      tags: {
        fleet_app: error.app,
        fleet_alert: error.name,
        ...(machine?.ownerOrganizationId ? { fleet_owner_org: machine.ownerOrganizationId } : {}),
        ...(machine?.recordOrganizationId
          ? { fleet_record_org: machine.recordOrganizationId }
          : {}),
      },
      fingerprint: perMachine
        ? ['fleet-attribution', error.name, error.app, machineId]
        : ['fleet-attribution', error.name, error.app],
    });
  } catch {
    // Swallowed on purpose — see the header.
  }
}
