import { describe, expect, it } from 'vitest';
import {
  AURORA_CAPACITY_METRIC,
  AURORA_METRIC_SETTLE_MS,
  AURORA_VOLUME_METRIC,
  AwsTenantApiError,
  TenantDatabaseUsageReadError,
  applicationDatabaseUsageSince,
  auroraWindowEnd,
  capacityPeriodSeconds,
  capacitySeconds,
  clusterIdentifierOf,
  createAwsDatabaseUsageReader,
  createFakeAwsDatabaseUsageReader,
  createFakeTenantClients,
  createStackRunner,
  databaseStackName,
  ensureApplicationDatabase,
  fakeMetricKey,
  sdkTenantCloudWatch,
  type AwsSdkClient,
  type TenantAccountContext,
} from '../src/index';

// MOTIR-12191 — the usage read of an AWS application's Aurora cluster: ACU-seconds
// from `ServerlessDatabaseCapacity` and bytes from `VolumeBytesUsed`, against the
// seam's fake CloudFormation and CloudWatch, plus the SDK client's series read.

const ORG = 'cmorg1';
const RID = 'cmrepo1';
const CLUSTER = `motir-${RID}`;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 2 ** 30;
const noSleep = async () => undefined;

/** A tenant account whose application database stack exists. */
async function accountWithDatabase() {
  const clients = createFakeTenantClients();
  clients.cloudformation.pollsToSettle = 0;
  const runner = createStackRunner(clients.cloudformation, { sleep: noSleep });
  const context: TenantAccountContext = { organizationId: ORG, clients, runner };
  await ensureApplicationDatabase(context, { repositoryId: RID });
  return clients;
}

/** One capacity point a minute, `acu` each, from `from` for `minutes`. */
function capacity(from: Date, minutes: number, acu: number) {
  return Array.from({ length: minutes }, (_, i) => ({
    at: new Date(from.getTime() + i * MINUTE),
    value: acu,
  }));
}

describe('the window and its arithmetic', () => {
  it('ends the window the settle time before now, on a whole minute', () => {
    const now = new Date('2026-11-24T12:34:56.789Z');
    expect(auroraWindowEnd(now)).toEqual(new Date('2026-11-24T12:29:00.000Z'));
    expect(AURORA_METRIC_SETTLE_MS).toBe(5 * MINUTE);
  });

  it('reads at the finest period CloudWatch still keeps for the window’s age', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    expect(capacityPeriodSeconds(ago(HOUR), now)).toBe(60);
    expect(capacityPeriodSeconds(ago(14 * DAY), now)).toBe(60);
    expect(capacityPeriodSeconds(ago(15 * DAY), now)).toBe(300);
    expect(capacityPeriodSeconds(ago(60 * DAY), now)).toBe(300);
    expect(capacityPeriodSeconds(ago(63 * DAY), now)).toBe(3600);
  });

  it('integrates each period’s average over its part inside the window', () => {
    const since = new Date('2026-11-24T10:00:30Z');
    const until = new Date('2026-11-24T10:03:00Z');
    const points = [
      // Half of this minute is before `since`.
      { at: new Date('2026-11-24T10:00:00Z'), value: 2 },
      { at: new Date('2026-11-24T10:01:00Z'), value: 1 },
      // A zero (or negative) average adds nothing.
      { at: new Date('2026-11-24T10:02:00Z'), value: 0 },
      // Wholly after the window.
      { at: new Date('2026-11-24T10:03:00Z'), value: 8 },
    ];
    expect(capacitySeconds(points, 60, since, until)).toBe(2 * 30 + 1 * 60);
    expect(capacitySeconds([], 60, since, until)).toBe(0);
  });

  it('takes the cluster identifier from its ARN', () => {
    expect(clusterIdentifierOf(`arn:aws:rds:us-east-1:210987654321:cluster:${CLUSTER}`)).toBe(
      CLUSTER,
    );
  });
});

describe('applicationDatabaseUsageSince', () => {
  it('reports the cluster’s ACU-seconds over the window and its bytes at the end, as aws', async () => {
    const clients = await accountWithDatabase();
    const since = new Date('2026-11-24T10:00:00Z');
    const now = new Date('2026-11-24T11:05:00Z');
    const dims = { DBClusterIdentifier: CLUSTER };
    // An hour at 2 ACU, then minutes past the window's end that must not count.
    clients.cloudwatch.series.set(fakeMetricKey(AURORA_CAPACITY_METRIC, dims), [
      ...capacity(since, 60, 2),
      ...capacity(new Date('2026-11-24T11:00:00Z'), 5, 16),
    ]);
    clients.cloudwatch.series.set(fakeMetricKey(AURORA_VOLUME_METRIC, dims), [
      { at: new Date('2026-11-24T09:00:00Z'), value: 1 * GIB },
      { at: new Date('2026-11-24T10:00:00Z'), value: 3 * GIB },
    ]);

    const usage = await applicationDatabaseUsageSince(clients, { repositoryId: RID, since, now });

    expect(usage).toEqual({
      provider: 'aws',
      applicationRef: RID,
      since,
      until: new Date('2026-11-24T11:00:00Z'),
      computeSeconds: 2 * 3600,
      storageBytes: 3 * GIB,
    });
    const [compute, volume] = clients.cloudwatch.seriesQueries;
    expect(compute).toEqual({
      namespace: 'AWS/RDS',
      metricName: AURORA_CAPACITY_METRIC,
      dimensions: dims,
      stat: 'Average',
      periodSeconds: 60,
      start: since,
      end: usage.until,
    });
    expect(volume).toMatchObject({
      metricName: AURORA_VOLUME_METRIC,
      stat: 'Maximum',
      periodSeconds: 3600,
      start: new Date(usage.until.getTime() - DAY),
      end: usage.until,
    });
  });

  it('starts an old window on its period’s boundary and clips the part before it', async () => {
    const clients = await accountWithDatabase();
    const now = new Date('2026-11-24T12:00:00Z');
    const since = new Date(now.getTime() - 20 * DAY + 90_000); // 1.5 min past a 5-minute boundary
    const boundary = new Date(since.getTime() - 90_000);
    clients.cloudwatch.series.set(
      fakeMetricKey(AURORA_CAPACITY_METRIC, { DBClusterIdentifier: CLUSTER }),
      [{ at: boundary, value: 4 }],
    );

    const usage = await applicationDatabaseUsageSince(clients, { repositoryId: RID, since, now });

    expect(clients.cloudwatch.seriesQueries[0]).toMatchObject({
      periodSeconds: 300,
      start: boundary,
    });
    // 300 s period, 90 s of it before `since`: 210 s at 4 ACU.
    expect(usage.computeSeconds).toBe(4 * 210);
    expect(usage.storageBytes).toBe(0);
  });

  it('reads nothing for a window that has not settled yet', async () => {
    const clients = await accountWithDatabase();
    const now = new Date('2026-11-24T11:00:00Z');
    const since = new Date(now.getTime() - 2 * MINUTE);

    const usage = await applicationDatabaseUsageSince(clients, { repositoryId: RID, since, now });

    expect(usage).toMatchObject({ since, until: since, computeSeconds: 0, storageBytes: 0 });
    expect(clients.cloudwatch.seriesQueries).toEqual([]);
  });

  it('is zero usage, not an error, when the application has no database stack', async () => {
    const clients = createFakeTenantClients();
    const since = new Date('2026-11-24T10:00:00Z');
    const now = new Date('2026-11-24T11:05:00Z');

    const usage = await applicationDatabaseUsageSince(clients, { repositoryId: RID, since, now });

    expect(usage).toMatchObject({
      until: auroraWindowEnd(now),
      computeSeconds: 0,
      storageBytes: 0,
    });
    expect(clients.cloudwatch.seriesQueries).toEqual([]);
  });

  it('names the repository and AWS’s code when CloudWatch or CloudFormation fails', async () => {
    const clients = await accountWithDatabase();
    const since = new Date('2026-11-24T10:00:00Z');
    const now = new Date('2026-11-24T11:05:00Z');
    clients.cloudwatch.failAt('metricPoints', 1);

    const failed = applicationDatabaseUsageSince(clients, { repositoryId: RID, since, now });
    await expect(failed).rejects.toBeInstanceOf(TenantDatabaseUsageReadError);
    await expect(failed).rejects.toMatchObject({
      code: 'AWS_DATABASE_USAGE_READ_FAILED',
      repositoryId: RID,
    });

    const stackDown = createFakeTenantClients();
    stackDown.cloudformation.describeStack = async () => {
      throw new AwsTenantApiError('cloudformation', 'Throttling', 400);
    };
    await expect(
      applicationDatabaseUsageSince(stackDown, { repositoryId: RID, since, now }),
    ).rejects.toMatchObject({ awsCode: 'Throttling' });

    const unknown = createFakeTenantClients();
    unknown.cloudformation.describeStack = async () => {
      throw new Error('boom');
    };
    await expect(
      applicationDatabaseUsageSince(unknown, { repositoryId: RID, since, now }),
    ).rejects.toMatchObject({ awsCode: 'UnknownError' });
  });
});

describe('createAwsDatabaseUsageReader', () => {
  it('reads in the organisation’s ready tenant account, and nothing before it is ready', async () => {
    const clients = await accountWithDatabase();
    clients.cloudwatch.series.set(
      fakeMetricKey(AURORA_CAPACITY_METRIC, { DBClusterIdentifier: CLUSTER }),
      capacity(new Date('2026-11-24T10:00:00Z'), 30, 1),
    );
    const since = new Date('2026-11-24T10:00:00Z');
    const now = new Date('2026-11-24T11:05:00Z');
    let ready = false;
    const asked: Array<{ accountId: string; region: string }> = [];
    const reader = createAwsDatabaseUsageReader({
      clientsFor: (target) => {
        asked.push(target);
        return clients;
      },
      region: 'us-east-1',
      organizationOf: async (repositoryId) => (repositoryId === RID ? ORG : 'other'),
      ensureTenantAccount: async (organizationId) => ({
        ready,
        accountId: ready && organizationId === ORG ? '210987654321' : null,
      }),
      now: () => now,
    });

    expect(await reader.usageSince({ repositoryId: RID }, since)).toMatchObject({
      provider: 'aws',
      until: since,
      computeSeconds: 0,
    });
    expect(asked).toEqual([]);

    ready = true;
    expect(await reader.usageSince({ repositoryId: RID }, since)).toMatchObject({
      until: new Date('2026-11-24T11:00:00Z'),
      computeSeconds: 30 * 60,
    });
    expect(asked).toEqual([{ accountId: '210987654321', region: 'us-east-1' }]);
  });

  it('uses the wall clock when no clock is given', async () => {
    const reader = createAwsDatabaseUsageReader({
      clientsFor: () => createFakeTenantClients(),
      region: 'us-east-1',
      organizationOf: async () => ORG,
      ensureTenantAccount: async () => ({ ready: true, accountId: '210987654321' }),
    });
    const since = new Date(Date.now() - HOUR);
    const usage = await reader.usageSince({ repositoryId: RID }, since);
    expect(usage.until.getTime()).toBeGreaterThan(since.getTime());
    expect(databaseStackName(RID)).toBe(`motir-database-${RID}`);
  });

  it('the fake measures nothing', async () => {
    const since = new Date('2026-11-24T10:00:00Z');
    expect(
      await createFakeAwsDatabaseUsageReader().usageSince({ repositoryId: RID }, since),
    ).toEqual({
      provider: 'aws',
      applicationRef: RID,
      since,
      until: since,
      computeSeconds: 0,
      storageBytes: 0,
    });
  });
});

describe('the SDK CloudWatch series read', () => {
  function stub(answer: (input: Record<string, unknown>) => unknown) {
    const sent: Array<Record<string, unknown>> = [];
    const client: AwsSdkClient = {
      async send(command) {
        const input = (command as { input: Record<string, unknown> }).input;
        sent.push(input);
        return answer(input);
      },
    };
    return { client, sent };
  }

  it('pages a series at the asked period and statistic, oldest first', async () => {
    let page = 0;
    const t = (m: number) => new Date(Date.UTC(2026, 10, 24, 10, m));
    const { client, sent } = stub(() =>
      (page += 1) === 1
        ? {
            MetricDataResults: [{ Timestamps: [t(2), t(1)], Values: [3, 2] }],
            NextToken: 'n',
          }
        : { MetricDataResults: [{ Timestamps: [t(0), t(3)], Values: [1] }, {}] },
    );
    const cw = sdkTenantCloudWatch(client);
    const query = {
      namespace: 'AWS/RDS',
      metricName: AURORA_CAPACITY_METRIC,
      dimensions: { DBClusterIdentifier: CLUSTER },
      stat: 'Average' as const,
      periodSeconds: 60,
      start: t(0),
      end: t(5),
    };

    expect(await cw.metricPoints(query)).toEqual([
      { at: t(0), value: 1 },
      { at: t(1), value: 2 },
      { at: t(2), value: 3 },
    ]);
    expect(sent[0]).toEqual({
      StartTime: t(0),
      EndTime: t(5),
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        {
          Id: 'series',
          ReturnData: true,
          MetricStat: {
            Metric: {
              Namespace: 'AWS/RDS',
              MetricName: AURORA_CAPACITY_METRIC,
              Dimensions: [{ Name: 'DBClusterIdentifier', Value: CLUSTER }],
            },
            Period: 60,
            Stat: 'Average',
          },
        },
      ],
    });
    expect(sent[1]!['NextToken']).toBe('n');

    const denied = sdkTenantCloudWatch(
      stub(() => {
        throw Object.assign(new Error('AccessDenied'), {
          name: 'AccessDeniedException',
          $metadata: { httpStatusCode: 403 },
        });
      }).client,
    );
    await expect(denied.metricPoints(query)).rejects.toMatchObject({
      service: 'cloudwatch',
      awsCode: 'AccessDeniedException',
    });
  });
});
