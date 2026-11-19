import { afterEach, describe, expect, it, vi } from 'vitest';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  AWS_COST_EXPLORER_ROLE_ENV,
  CostExplorerHistoryUnavailableError,
  CostExplorerNotConfiguredError,
  costExplorerRoleArn,
  createCostExplorerReader,
  nextDay,
  toMicroUsd,
} from '@/lib/awsCost/costExplorerReader';

// THE COSTS PAGE'S AWS READ (MOTIR-11712). Both SDK clients are driven at their
// `send`, so what is asserted is the role the reader assumes, the one command it
// sends per page, and the plain lines it answers with.

const ROLE = 'arn:aws:iam::111122223333:role/motir-cost-explorer-read';

afterEach(() => vi.restoreAllMocks());

function stsAnswering(credentials: unknown) {
  return vi
    .spyOn(STSClient.prototype, 'send')
    .mockImplementation((async () => ({ Credentials: credentials })) as never);
}

const CREDENTIALS = {
  AccessKeyId: 'AKIA',
  SecretAccessKey: 'secret',
  SessionToken: 'token',
  Expiration: new Date('2030-01-01T00:00:00Z'),
};

function group(recordType: string, service: string, amount: string | undefined) {
  return {
    Keys: [recordType, service],
    Metrics: { UnblendedCost: { Amount: amount, Unit: 'USD' } },
  };
}

describe('costExplorerRoleArn', () => {
  it('reads the role from the environment, trimmed, or answers null', () => {
    expect(AWS_COST_EXPLORER_ROLE_ENV).toBe('AWS_COST_EXPLORER_ROLE_ARN');
    expect(costExplorerRoleArn({ AWS_COST_EXPLORER_ROLE_ARN: ` ${ROLE} ` })).toBe(ROLE);
    expect(costExplorerRoleArn({ AWS_COST_EXPLORER_ROLE_ARN: '  ' })).toBeNull();
    expect(costExplorerRoleArn({})).toBeNull();
  });
});

describe('toMicroUsd and nextDay', () => {
  it('turns dollars into whole micro-USD, negatives included, and a missing amount into 0', () => {
    expect(toMicroUsd('12.3456789')).toBe(12_345_679);
    expect(toMicroUsd('-500')).toBe(-500_000_000);
    expect(toMicroUsd(undefined)).toBe(0);
    expect(() => toMicroUsd('abc')).toThrow('non-numeric');
  });

  it('answers the next UTC day, across a month and a year', () => {
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('createCostExplorerReader', () => {
  it('refuses to build without a role', () => {
    expect(() => createCostExplorerReader(null)).toThrow(CostExplorerNotConfiguredError);
  });

  it('assumes the role, asks DAILY unblended cost by record type and service, and follows every page', async () => {
    const sts = stsAnswering(CREDENTIALS);
    const ce = vi
      .spyOn(CostExplorerClient.prototype, 'send')
      .mockImplementationOnce((async () => ({
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-11-17', End: '2026-11-18' },
            Groups: [group('Usage', 'Amazon Elastic Container Service', '71.76')],
          },
          { TimePeriod: {}, Groups: [group('Usage', 'ignored', '1')] },
        ],
        NextPageToken: 'page-2',
      })) as never)
      .mockImplementationOnce((async () => ({
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-11-18', End: '2026-11-19' },
            Groups: [group('Credit', 'AWS Support', '-3.5'), { Metrics: {} }],
          },
          { TimePeriod: { Start: '2026-11-18' } },
        ],
        NextPageToken: '',
      })) as never);

    const lines = await createCostExplorerReader(ROLE).readDailyCosts('2026-11-17', '2026-11-18');

    expect(lines).toEqual([
      {
        day: '2026-11-17',
        recordType: 'Usage',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 71_760_000,
      },
      {
        day: '2026-11-18',
        recordType: 'Credit',
        service: 'AWS Support',
        amountMicroUsd: -3_500_000,
      },
      { day: '2026-11-18', recordType: '', service: '', amountMicroUsd: 0 },
    ]);
    const [first, second] = ce.mock.calls.map((c) => c[0] as GetCostAndUsageCommand);
    expect(first).toBeInstanceOf(GetCostAndUsageCommand);
    expect(first!.input).toEqual({
      TimePeriod: { Start: '2026-11-17', End: '2026-11-19' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        { Type: 'DIMENSION', Key: 'RECORD_TYPE' },
        { Type: 'DIMENSION', Key: 'SERVICE' },
      ],
      NextPageToken: undefined,
    });
    expect(second!.input.NextPageToken).toBe('page-2');

    // The client is us-east-1 (Cost Explorer's one endpoint), and its credentials
    // are the assumed role's.
    const client = ce.mock.contexts[0] as CostExplorerClient;
    expect(await client.config.region()).toBe('us-east-1');
    const creds = await client.config.credentials();
    expect(creds).toMatchObject({
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      sessionToken: 'token',
    });
    const assume = sts.mock.calls[0]![0] as AssumeRoleCommand;
    expect(assume).toBeInstanceOf(AssumeRoleCommand);
    expect(assume.input).toEqual({
      RoleArn: ROLE,
      RoleSessionName: 'motir-aws-cost-fetch',
      DurationSeconds: 900,
    });
  });

  it('throws when STS hands back no credentials', async () => {
    stsAnswering({ AccessKeyId: 'AKIA' });
    vi.spyOn(CostExplorerClient.prototype, 'send').mockImplementation(async function (
      this: CostExplorerClient,
    ) {
      await this.config.credentials();
      return {};
    } as never);
    await expect(
      createCostExplorerReader(ROLE).readDailyCosts('2026-11-01', '2026-11-01'),
    ).rejects.toThrow('STS returned no credentials');
  });

  it('turns "no data that far back" into the history error, and passes any other failure through', async () => {
    const send = vi.spyOn(CostExplorerClient.prototype, 'send');
    const reader = createCostExplorerReader(ROLE);
    const named = (name: string, message: string) => Object.assign(new Error(message), { name });

    send.mockRejectedValueOnce(named('DataUnavailableException', 'no data'));
    await expect(reader.readDailyCosts('2020-01-01', '2020-01-31')).rejects.toBeInstanceOf(
      CostExplorerHistoryUnavailableError,
    );

    send.mockRejectedValueOnce(
      named('ValidationException', 'start date is too old; historical data beyond 38 months'),
    );
    await expect(reader.readDailyCosts('2020-01-01', '2020-01-31')).rejects.toBeInstanceOf(
      CostExplorerHistoryUnavailableError,
    );

    send.mockRejectedValueOnce(named('ValidationException', 'GroupBy is malformed'));
    await expect(reader.readDailyCosts('2026-01-01', '2026-01-31')).rejects.toThrow(
      'GroupBy is malformed',
    );

    send.mockRejectedValueOnce('a string, not an Error');
    await expect(reader.readDailyCosts('2026-01-01', '2026-01-31')).rejects.toBe(
      'a string, not an Error',
    );
  });
});
