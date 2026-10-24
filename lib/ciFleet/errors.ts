import type { ContainerSize, OrchestratorProvider } from '@motir/orchestrator';

// Typed refusals from the HOSTED-AGENT metering seam (Story MOTIR-4336 ·
// MOTIR-4713). Both fire BEFORE anything is reserved or provisioned, so a throw
// leaks neither a fleet slot nor a container.

/**
 * A hosted-agent container was asked for on a machine class the rate table does
 * not price.
 *
 * ⚠️ THE METER WOULD NOT HAVE THROWN, AND THAT IS WHY THIS DOES. `buildContainerUsage`
 * records an unpriced triple at `usdPerSecond = 0` with a null
 * `rateEffectiveFrom` and a log line — the right posture for a container that
 * already ran, and the wrong one for the single workload whose price the agent
 * lane's multiplier is calibrated against: its hosting share would read as zero.
 * The remedy is a new row in `packages/orchestrator/src/rates.ts`, which is the
 * deliverable of whichever decision picked the machine class.
 */
export class HostedAgentContainerUnpricedError extends Error {
  readonly code = 'HOSTED_AGENT_CONTAINER_UNPRICED' as const;
  constructor(
    readonly provider: OrchestratorProvider,
    readonly size: ContainerSize,
    readonly region: string,
  ) {
    super(
      `no container rate prices ${provider} ${size.cpuKind}-${size.cpus}x/${size.memoryMb}MB in ` +
        `${region}; a hosted-agent container is not booted unpriced — add the rate row first`,
    );
    this.name = 'HostedAgentContainerUnpricedError';
  }
}

/** A hosted-agent container request that cannot be supervised as asked — a
 *  timeout outside the seam's bounds. A dispatcher bug, never a transient. */
export class HostedAgentContainerRequestInvalidError extends Error {
  readonly code = 'HOSTED_AGENT_CONTAINER_REQUEST_INVALID' as const;
  constructor(readonly detail: string) {
    super(`invalid hosted-agent container request: ${detail}`);
    this.name = 'HostedAgentContainerRequestInvalidError';
  }
}

// ── The fleet account record (Story MOTIR-8953 · MOTIR-8961) ────────────────

/** What about a fleet account input was refused — one name per invariant the
 *  database also holds, so a caller can answer each without reading a message. */
export type FleetShardInvalidField =
  | 'name'
  | 'fleetKind'
  | 'credentialRef'
  | 'githubOrg'
  | 'githubInstallationId'
  | 'flyLocation'
  | 'awsLocation'
  | 'machineLimit'
  | 'limit'
  | 'limitsSource';

/** A fleet account input that breaks an invariant — refused BEFORE the write, so
 *  the caller gets this rather than a raw constraint violation. */
export class FleetShardInvalidError extends Error {
  readonly code = 'FLEET_SHARD_INVALID' as const;
  constructor(
    readonly field: FleetShardInvalidField,
    readonly detail: string,
  ) {
    super(`invalid fleet account: ${field} — ${detail}`);
    this.name = 'FleetShardInvalidError';
  }
}

/** No fleet account has that id. */
export class FleetShardNotFoundError extends Error {
  readonly code = 'FLEET_SHARD_NOT_FOUND' as const;
  constructor(readonly shardId: string) {
    super(`no fleet account ${shardId}`);
    this.name = 'FleetShardNotFoundError';
  }
}

/** The name, or the provider location, is already another account's. */
export class FleetShardTakenError extends Error {
  readonly code = 'FLEET_SHARD_TAKEN' as const;
  constructor(readonly shardName: string) {
    super(`a fleet account already holds the name or the provider location of ${shardName}`);
    this.name = 'FleetShardTakenError';
  }
}

/** `fleet-admin add-shard` / `refresh-limits` refused the run BEFORE its first
 *  external call (Story MOTIR-8953 · MOTIR-8967) — every problem found, at once. */
export class FleetShardProvisioningRefusedError extends Error {
  readonly code = 'FLEET_SHARD_PROVISIONING_REFUSED' as const;
  constructor(readonly problems: string[]) {
    super(`add-shard refused: ${problems.join('; ')}`);
    this.name = 'FleetShardProvisioningRefusedError';
  }
}

// ── Quota requests and growth events (Story MOTIR-9362 · MOTIR-9457) ────────

/** A quota-request status, or a growth outcome, outside the named values —
 *  refused before anything is written. */
export class FleetPoolValueInvalidError extends Error {
  readonly code = 'FLEET_POOL_VALUE_INVALID' as const;
  constructor(
    readonly field:
      | 'status'
      | 'outcome'
      | 'fleetKind'
      | 'desiredValue'
      | 'grantedValue'
      | 'quotaCode'
      | 'awsRequestId'
      | 'figures',
    readonly value: unknown,
  ) {
    super(`invalid fleet pool ${field}: ${String(value)}`);
    this.name = 'FleetPoolValueInvalidError';
  }
}

/** An account already has an OPEN raise of the same quota for a different
 *  value — AWS allows one pending request per quota, so this one is refused. */
export class FleetQuotaRequestOpenError extends Error {
  readonly code = 'FLEET_QUOTA_REQUEST_OPEN' as const;
  constructor(
    readonly shardId: string,
    readonly quotaCode: string,
    readonly openRequestId: string,
  ) {
    super(
      `fleet account ${shardId} already has open quota request ${openRequestId} for ${quotaCode}`,
    );
    this.name = 'FleetQuotaRequestOpenError';
  }
}

/** No quota request has that id. */
export class FleetQuotaRequestNotFoundError extends Error {
  readonly code = 'FLEET_QUOTA_REQUEST_NOT_FOUND' as const;
  constructor(readonly requestId: string) {
    super(`no fleet quota request ${requestId}`);
    this.name = 'FleetQuotaRequestNotFoundError';
  }
}
