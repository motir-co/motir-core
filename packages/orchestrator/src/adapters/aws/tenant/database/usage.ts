import type { DatabaseUsage } from '../../../../database/types';
import type { TenantClients } from '../clients';
import { AwsTenantApiError } from '../errors';
import type { TenantClientsFactory } from '../factory';
import type { TenantCloudWatch, TenantMetricPoint } from '../function/lambdaClient';
import { databaseStackName } from './names';

// THE APPLICATION DATABASE'S USAGE READ (MOTIR-12191; Decision MOTIR-12100,
// Consequences): how much the application's Aurora PostgreSQL Serverless v2
// cluster ran and stored over a window, read from CloudWatch in the tenant
// account under its deploy role (`cloudwatch:GetMetricData`, granted by
// `tenantDeployPolicies`), reported as a `DatabaseUsage` with provider `aws`:
//
//   · COMPUTE, in ACU-seconds: `AWS/RDS` `ServerlessDatabaseCapacity` for the
//     cluster, its Average per period times the seconds of that period inside
//     the window. A period with no datapoint (a paused cluster) adds nothing.
//     The cluster has one instance (`database.yaml`), so the cluster's average
//     is that instance's capacity.
//   · STORAGE, in bytes: `VolumeBytesUsed`'s latest hourly Maximum at the
//     window's end — the meter prices it for the window's length (§2 notes).
//
// The window ends a few minutes before now, on a whole minute: CloudWatch
// publishes a minute's datapoint after it, and a window that ended at now would
// lose that minute for good, since the next window starts where this one ended.
// The cluster holds production and every preview's database; Motir pays for the
// cluster, so the whole of it is production's usage.
//
// API reference, read 2026-11-24:
//   https://docs.aws.amazon.com/AmazonCloudWatch/latest/APIReference/API_GetMetricData.html
//   https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html

const RDS_NAMESPACE = 'AWS/RDS';
export const AURORA_CAPACITY_METRIC = 'ServerlessDatabaseCapacity';
export const AURORA_VOLUME_METRIC = 'VolumeBytesUsed';

/** How long after a minute CloudWatch is trusted to hold its datapoint. */
export const AURORA_METRIC_SETTLE_MS = 5 * 60_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** How far back the storage read looks for its latest datapoint. */
const VOLUME_LOOKBACK_MS = DAY_MS;

export class TenantDatabaseUsageReadError extends Error {
  readonly code = 'AWS_DATABASE_USAGE_READ_FAILED' as const;
  constructor(
    readonly repositoryId: string,
    readonly awsCode: string,
  ) {
    super(`The usage of repository ${repositoryId}'s database could not be read (${awsCode}).`);
    this.name = 'TenantDatabaseUsageReadError';
  }
}

/**
 * The finest period CloudWatch still keeps for data as old as `start`: one
 * minute for 15 days, five minutes for 63, an hour after that (an hour's
 * margin, so the answer does not change while the query is in flight).
 */
export function capacityPeriodSeconds(start: Date, now: Date): number {
  const age = now.getTime() - start.getTime();
  if (age <= 15 * DAY_MS - HOUR_MS) return 60;
  if (age <= 63 * DAY_MS - HOUR_MS) return 300;
  return 3600;
}

/** The window's end: `now` less the settle time, down to a whole minute. */
export function auroraWindowEnd(now: Date): Date {
  const settled = now.getTime() - AURORA_METRIC_SETTLE_MS;
  return new Date(Math.floor(settled / MINUTE_MS) * MINUTE_MS);
}

/** Σ average × the seconds of its period inside `[since, until)`. */
export function capacitySeconds(
  points: readonly TenantMetricPoint[],
  periodSeconds: number,
  since: Date,
  until: Date,
): number {
  let total = 0;
  for (const point of points) {
    const start = Math.max(point.at.getTime(), since.getTime());
    const end = Math.min(point.at.getTime() + periodSeconds * 1000, until.getTime());
    if (end > start && point.value > 0) total += (point.value * (end - start)) / 1000;
  }
  return total;
}

/** The cluster identifier from its ARN (`arn:aws:rds:…:cluster:<id>`). */
export function clusterIdentifierOf(clusterArn: string): string {
  return clusterArn.slice(clusterArn.lastIndexOf(':') + 1);
}

function awsCodeOf(err: unknown): string {
  return err instanceof AwsTenantApiError ? err.awsCode : 'UnknownError';
}

/** The cluster's ACU-seconds over `[since, until)` and its bytes at `until`. */
async function readClusterUsage(
  cloudwatch: TenantCloudWatch,
  clusterIdentifier: string,
  since: Date,
  until: Date,
  now: Date,
): Promise<{ computeSeconds: number; storageBytes: number }> {
  const dimensions = { DBClusterIdentifier: clusterIdentifier };
  const period = capacityPeriodSeconds(since, now);
  // Start on a period boundary, so every point is a whole period CloudWatch
  // computed; the part of it before `since` is clipped below.
  const alignedStart = new Date(Math.floor(since.getTime() / (period * 1000)) * period * 1000);
  const capacity = await cloudwatch.metricPoints({
    namespace: RDS_NAMESPACE,
    metricName: AURORA_CAPACITY_METRIC,
    dimensions,
    stat: 'Average',
    periodSeconds: period,
    start: alignedStart,
    end: until,
  });
  const volume = await cloudwatch.metricPoints({
    namespace: RDS_NAMESPACE,
    metricName: AURORA_VOLUME_METRIC,
    dimensions,
    stat: 'Maximum',
    periodSeconds: 3600,
    start: new Date(until.getTime() - VOLUME_LOOKBACK_MS),
    end: until,
  });
  return {
    computeSeconds: capacitySeconds(capacity, period, since, until),
    storageBytes: Math.max(0, volume.at(-1)?.value ?? 0),
  };
}

/**
 * The production database's usage from `since` until the settled end of the
 * window. No database stack (the application has no database, or it is gone)
 * is zero usage, not an error; a CloudWatch failure is
 * `TenantDatabaseUsageReadError`, naming the repository and AWS's code.
 */
export async function applicationDatabaseUsageSince(
  clients: Pick<TenantClients, 'cloudformation' | 'cloudwatch'>,
  input: { readonly repositoryId: string; readonly since: Date; readonly now: Date },
): Promise<DatabaseUsage> {
  const { repositoryId, since, now } = input;
  const until = auroraWindowEnd(now);
  const usage = (end: Date, computeSeconds = 0, storageBytes = 0): DatabaseUsage => ({
    provider: 'aws',
    applicationRef: repositoryId,
    since,
    until: end,
    computeSeconds,
    storageBytes,
  });
  if (until.getTime() <= since.getTime()) return usage(since);
  let clusterArn: string | undefined;
  try {
    const stack = await clients.cloudformation.describeStack(databaseStackName(repositoryId));
    clusterArn = stack?.outputs['ClusterArn'];
  } catch (err) {
    throw new TenantDatabaseUsageReadError(repositoryId, awsCodeOf(err));
  }
  if (!clusterArn) return usage(until);
  try {
    const read = await readClusterUsage(
      clients.cloudwatch,
      clusterIdentifierOf(clusterArn),
      since,
      until,
      now,
    );
    return usage(until, read.computeSeconds, read.storageBytes);
  } catch (err) {
    throw new TenantDatabaseUsageReadError(repositoryId, awsCodeOf(err));
  }
}

/** Reads one application's production database usage, wherever its tenant
 *  account is. */
export interface AwsDatabaseUsageReader {
  /** The usage from `since`; zero, ending at `since`, while the organisation's
   *  tenant account is not ready. */
  usageSince(input: { readonly repositoryId: string }, since: Date): Promise<DatabaseUsage>;
}

export interface AwsDatabaseUsageDeps {
  /** The tenant account's clients, all under its deploy role. */
  readonly clientsFor: TenantClientsFactory;
  /** The tenant accounts' region. */
  readonly region: string;
  /** Whether the organisation's tenant account is ready, and its id. */
  readonly ensureTenantAccount: (
    organizationId: string,
  ) => Promise<{ readonly ready: boolean; readonly accountId: string | null }>;
  /** The organisation a repository row belongs to. */
  readonly organizationOf: (repositoryId: string) => Promise<string>;
  readonly now?: () => Date;
}

/** The reader over Motir's tenant accounts. */
export function createAwsDatabaseUsageReader(deps: AwsDatabaseUsageDeps): AwsDatabaseUsageReader {
  const now = deps.now ?? (() => new Date());
  return {
    async usageSince({ repositoryId }, since) {
      const organizationId = await deps.organizationOf(repositoryId);
      const account = await deps.ensureTenantAccount(organizationId);
      if (!account.ready || !account.accountId) {
        return {
          provider: 'aws',
          applicationRef: repositoryId,
          since,
          until: since,
          computeSeconds: 0,
          storageBytes: 0,
        };
      }
      const clients = deps.clientsFor({ accountId: account.accountId, region: deps.region });
      return applicationDatabaseUsageSince(clients, { repositoryId, since, now: now() });
    },
  };
}

/** The fake reader: nothing measured, so every window ends where it starts. A
 *  test that wants usage replaces `usageSince`. */
export function createFakeAwsDatabaseUsageReader(): AwsDatabaseUsageReader {
  return {
    async usageSince({ repositoryId }, since) {
      return {
        provider: 'aws',
        applicationRef: repositoryId,
        since,
        until: since,
        computeSeconds: 0,
        storageBytes: 0,
      };
    },
  };
}
