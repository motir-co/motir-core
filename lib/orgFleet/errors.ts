/**
 * Typed errors for an organisation's own fleet stops (`orgFleetStopService`).
 *
 * The domain-`errors.ts` convention: the service throws these, the surface above
 * translates them. Each answers the SAME refusal for "not this organisation's",
 * "ended" and "never existed", so a caller cannot probe another organisation's
 * runs or agents by id. The message names the id the caller sent and nothing
 * the database holds.
 */

/** The run is not one of the organisation's live hosted-agent runs. */
export class OrgFleetRunNotFoundError extends Error {
  readonly code = 'ORG_FLEET_RUN_NOT_FOUND';

  constructor(readonly dispatchRunId: string) {
    super(`No live Motir agent run ${dispatchRunId} in this organization`);
    this.name = 'OrgFleetRunNotFoundError';
  }
}

/** The agent instance is not a live instance of the organisation. */
export class OrgFleetInstanceNotFoundError extends Error {
  readonly code = 'ORG_FLEET_INSTANCE_NOT_FOUND';

  constructor(readonly instanceId: string) {
    super(`No live agent instance ${instanceId} in this organization`);
    this.name = 'OrgFleetInstanceNotFoundError';
  }
}
