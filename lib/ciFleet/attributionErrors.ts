// The attribution reconciler's two alerts (Story MOTIR-6906 · MOTIR-6925,
// `docs/decisions/fleet-per-org-pool.md` §4–§5). Each is CAPTURED to Sentry and
// never thrown out of the job: the reconciler's pass must reach every other app
// and machine, and a throw would end it at the first one worth telling a person
// about. The messages are the record's own words, because the message is the
// whole of what the platform admin reads.

/** Why a machine was killed — the alert's own vocabulary. */
export type AttributionKillReason = 'no_record' | 'record_ended' | 'org_stopped';

/** Minutes, then hours, for a machine's age in an alert. */
export function describeAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 120) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * One per machine the reconciler destroyed — or stopped, for an agent instance's
 * persistent machine whose record says it should be resting.
 */
export class UnattributedMachineDestroyedError extends Error {
  constructor(
    readonly app: string,
    readonly machineId: string,
    readonly machineName: string,
    readonly ageMs: number,
    readonly reason: AttributionKillReason,
    readonly action: 'destroyed' | 'stopped' = 'destroyed',
    /** Whose machine it was: a hoster account's is an EC2 instance (MOTIR-9476). */
    readonly provider: string = 'fly',
  ) {
    const verb = action === 'stopped' ? 'Stopped' : 'Destroyed';
    const what = provider === 'aws' ? 'EC2 instance' : 'Fly machine';
    super(
      `${verb} ${what} ${machineId} (${machineName || 'unnamed'}) in ${app}, ` +
        `${describeAge(ageMs)} old: ${reason}.`,
    );
    this.name = 'UnattributedMachineDestroyedError';
  }
}

/**
 * One per DISK the reconciler deleted in an agent-hoster account (MOTIR-9476): an
 * unattached EBS volume past the grace that no live agent instance names — the
 * home disk a machine destroy left behind, or a failed teardown's. Names the
 * account, the volume, its age and the reason; never a credential.
 */
export class UnattributedVolumeDestroyedError extends Error {
  constructor(
    readonly app: string,
    readonly volumeId: string,
    readonly ageMs: number,
    readonly reason: AttributionKillReason,
  ) {
    super(`Destroyed EBS volume ${volumeId} in ${app}, ${describeAge(ageMs)} old: ${reason}.`);
    this.name = 'UnattributedVolumeDestroyedError';
  }
}

/**
 * The provider could not say what is running — an app list or one app's machine
 * list failed, a destroy was refused, or a machine came back with no creation
 * instant. Nothing was destroyed on a guess.
 */
export class FleetInventoryUnavailableError extends Error {
  constructor(
    readonly app: string,
    readonly detail: string,
  ) {
    // The provider's own sentence already ends in a full stop ("…(HTTP 502).");
    // drop it so the alert does not read "(HTTP 502).. Nothing was destroyed".
    super(
      `Could not list machines in ${app}: ${detail.replace(/\.+$/, '')}. ` +
        'Nothing was destroyed there.',
    );
    this.name = 'FleetInventoryUnavailableError';
  }
}
