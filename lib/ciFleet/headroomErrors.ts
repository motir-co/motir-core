// The headroom pass's three alerts (Story MOTIR-8953 · MOTIR-8969,
// `docs/decisions/fleet-per-org-pool.md` AMENDMENT 1). Each is CAPTURED to Sentry
// and never thrown out of the pass: one subject over its threshold must not stop
// the pass reaching the others. The message is the whole of what the platform
// admin reads.

function percent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A fleet account at or over 70% of one of its limits. */
export class ShardHeadroomExceededError extends Error {
  constructor(
    readonly shardName: string,
    readonly fleetKind: string,
    readonly limit: string,
    readonly used: number,
    readonly capacity: number,
    readonly fraction: number,
  ) {
    super(
      `Fleet account ${shardName} (${fleetKind}) is at ${percent(fraction)} of its ${limit}: ` +
        `${used} of ${capacity}.`,
    );
    this.name = 'ShardHeadroomExceededError';
  }
}

/** A GitHub org at or over 70% of one of its limits — counted on the runner's
 *  org, whichever accounts booted the machines. */
export class GithubOrgHeadroomExceededError extends Error {
  constructor(
    readonly org: string,
    readonly limit: string,
    readonly used: number,
    readonly capacity: number,
    readonly fraction: number,
    /** The accounts whose machines made the calls. */
    readonly shardNames: readonly string[],
    /** True when no fleet account names the org, so its documented defaults were used. */
    readonly noAccountRow: boolean = false,
  ) {
    super(
      `GitHub org ${org} is at ${percent(fraction)} of its ${limit}: ${used} of ${capacity}` +
        `${noAccountRow ? ' (no fleet account names it; documented defaults)' : ''}` +
        `${shardNames.length > 0 ? `. Accounts: ${shardNames.join(', ')}` : ''}.`,
    );
    this.name = 'GithubOrgHeadroomExceededError';
  }
}

/** A fleet kind whose jobs keep waiting for capacity: its pool is not growing
 *  fast enough. */
export class SustainedDeferralError extends Error {
  constructor(
    readonly fleetKind: string,
    readonly deferred: number,
    readonly total: number,
    readonly windowMinutes: number,
  ) {
    super(
      `${deferred} of ${total} ${fleetKind} jobs in the last ${windowMinutes} min waited for ` +
        'capacity (shard_capacity). The pool needs more quota or another account.',
    );
    this.name = 'SustainedDeferralError';
  }
}

// ── The growth pass's alerts (Story MOTIR-9362 · MOTIR-9462) ─────────────────

/** A pool growth was refused — AWS would not create the account. The pool keeps
 *  the capacity it has; the pass backs off before trying again. */
export class PoolGrowthRefusedError extends Error {
  constructor(
    readonly fleetKind: string,
    readonly triggeringShardName: string,
    /** AWS's reason, as text. */
    readonly reason: string,
    readonly promotedSpareName: string | null,
  ) {
    super(
      `Growing the ${fleetKind} pool was refused (triggered by ${triggeringShardName}): ${reason}.` +
        `${promotedSpareName ? ` The spare ${promotedSpareName} was promoted first and stays in the pool.` : ''}` +
        ' The pass backs off before the next attempt.',
    );
    this.name = 'PoolGrowthRefusedError';
  }
}

/** AWS refused to create one of a Host organisation's own accounts (MOTIR-9582).
 *  No row is written; the reconcile backs the slot off before trying again. */
export class HostAccountRefusedError extends Error {
  constructor(
    readonly organizationId: string,
    readonly slot: string,
    readonly accountName: string,
    /** AWS's reason, as its code. */
    readonly reason: string,
    readonly consecutiveRefusals: number,
  ) {
    super(
      `Creating the Host account ${accountName} (organisation ${organizationId}, ${slot}) ` +
        `was refused: ${reason}. Refusal ${consecutiveRefusals} in a row; the reconcile backs ` +
        'off before the next attempt, and the organisation stays on the shared pools.',
    );
    this.name = 'HostAccountRefusedError';
  }
}

/** A quota raise still open after a day — AWS is slow, or wants a case answered. */
export class QuotaRequestSlowError extends Error {
  constructor(
    readonly requestId: string,
    readonly shardName: string,
    readonly fleetKind: string,
    readonly awsRequestId: string,
    readonly ageHours: number,
  ) {
    super(
      `The vCPU quota raise ${awsRequestId} for fleet account ${shardName} (${fleetKind}) ` +
        `has been open ${ageHours} hours.`,
    );
    this.name = 'QuotaRequestSlowError';
  }
}

/** A quota raise AWS turned down. The account keeps its granted quota. */
export class QuotaRequestDeniedError extends Error {
  constructor(
    readonly requestId: string,
    readonly shardName: string,
    readonly fleetKind: string,
    readonly awsRequestId: string,
    readonly status: string,
  ) {
    super(
      `The vCPU quota raise ${awsRequestId} for fleet account ${shardName} (${fleetKind}) ` +
        `closed ${status}; the account keeps its granted quota.`,
    );
    this.name = 'QuotaRequestDeniedError';
  }
}
