import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

// THE COSTS PAGE'S AWS READ (MOTIR-11712) — AWS Cost Explorer's daily cost for
// the whole Organization. This directory is the one place motir-core speaks to
// Cost Explorer (`tests/ciFleet/awsSdkBoundary.test.ts`), so the service that
// stores what it read sees plain lines and is tested offline.
//
// ⚠️ ONLY THE MANAGEMENT ACCOUNT SEES EVERY ACCOUNT'S SPEND. Cost Explorer in a
// member account answers for that account alone, so the reader assumes the
// read-only role motir-infra's management stack builds in the management
// account (`AWS_COST_EXPLORER_ROLE_ARN`) — a role whose one permission is
// `ce:GetCostAndUsage` and whose trust names core's worker task role. The
// assume itself runs on the SDK's default chain: the worker's task role on AWS.
//
// ⚠️ EVERY REQUEST IS BILLED (about $0.01 per paginated request). Only the fetch
// job and the backfill script construct a reader; no page load ever does.
//
// API references, read 2026-11-18:
//   https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html
//   https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html

/** The variable naming the management account's Cost Explorer read role. */
export const AWS_COST_EXPLORER_ROLE_ENV = 'AWS_COST_EXPLORER_ROLE_ARN';

/** Cost Explorer's API is served from us-east-1 only, as is STS's global endpoint. */
const COST_EXPLORER_REGION = 'us-east-1';
const SESSION_NAME = 'motir-aws-cost-fetch';
/** STS's minimum. A fetch is a handful of requests; the provider renews if one runs long. */
const SESSION_SECONDS = 900;

/** One line of one UTC day, as Cost Explorer grouped it. */
export interface CostExplorerLine {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Cost Explorer's `RECORD_TYPE`: `Usage`, `Tax`, `Credit`, `Refund`, `Fee`, … */
  recordType: string;
  /** Cost Explorer's `SERVICE` name, exactly as AWS returns it. */
  service: string;
  /** The UNBLENDED cost, in micro-USD (negative for a credit or refund). */
  amountMicroUsd: number;
}

/** What the fetch job reads. Throws when AWS does not answer. */
export interface CostExplorerReader {
  /**
   * Every day of `[fromDay, toDay]` (inclusive, `YYYY-MM-DD`, UTC), grouped by
   * record type and service, across every linked account.
   */
  readDailyCosts(fromDay: string, toDay: string): Promise<CostExplorerLine[]>;
}

/**
 * Cost Explorer holds no data that far back (it keeps 13 months by default, 38
 * with multi-year data enabled). The backfill stops at it; nothing else does.
 */
export class CostExplorerHistoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostExplorerHistoryUnavailableError';
  }
}

/** No role is configured: the install has no Cost Explorer read to make. */
export class CostExplorerNotConfiguredError extends Error {
  constructor() {
    super(`set ${AWS_COST_EXPLORER_ROLE_ENV}`);
    this.name = 'CostExplorerNotConfiguredError';
  }
}

/** The role ARN the reader assumes, or null when the install names none. */
export function costExplorerRoleArn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return env[AWS_COST_EXPLORER_ROLE_ENV]?.trim() || null;
}

/** A string of dollars (`"12.3456789"`) as whole micro-USD. */
export function toMicroUsd(amount: string | undefined): number {
  const usd = Number(amount ?? '0');
  if (!Number.isFinite(usd)) throw new Error(`Cost Explorer returned a non-numeric amount`);
  return Math.round(usd * 1_000_000);
}

/** The day after `day`, both `YYYY-MM-DD` — Cost Explorer's `End` is exclusive. */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function isHistoryUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'DataUnavailableException') return true;
  return (
    err.name === 'ValidationException' &&
    /historical|too old|older than|beyond|before/i.test(err.message)
  );
}

/** The reader, assuming `roleArn` from the SDK's default credential chain. */
export function createCostExplorerReader(
  roleArn: string | null = costExplorerRoleArn(),
): CostExplorerReader {
  if (!roleArn) throw new CostExplorerNotConfiguredError();
  const sts = new STSClient({ region: COST_EXPLORER_REGION });
  const client = new CostExplorerClient({
    region: COST_EXPLORER_REGION,
    credentials: async () => {
      const { Credentials } = await sts.send(
        new AssumeRoleCommand({
          RoleArn: roleArn,
          RoleSessionName: SESSION_NAME,
          DurationSeconds: SESSION_SECONDS,
        }),
      );
      if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey) {
        throw new Error('STS returned no credentials for the Cost Explorer role');
      }
      return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
        expiration: Credentials.Expiration,
      };
    },
  });

  return {
    async readDailyCosts(fromDay, toDay) {
      const lines: CostExplorerLine[] = [];
      let token: string | undefined;
      do {
        let page;
        try {
          page = await client.send(
            new GetCostAndUsageCommand({
              TimePeriod: { Start: fromDay, End: nextDay(toDay) },
              Granularity: 'DAILY',
              Metrics: ['UnblendedCost'],
              GroupBy: [
                { Type: 'DIMENSION', Key: 'RECORD_TYPE' },
                { Type: 'DIMENSION', Key: 'SERVICE' },
              ],
              NextPageToken: token,
            }),
          );
        } catch (err) {
          if (isHistoryUnavailable(err)) {
            throw new CostExplorerHistoryUnavailableError((err as Error).message);
          }
          throw err;
        }
        for (const result of page.ResultsByTime ?? []) {
          const day = result.TimePeriod?.Start;
          if (!day) continue;
          for (const group of result.Groups ?? []) {
            const [recordType = '', service = ''] = group.Keys ?? [];
            lines.push({
              day,
              recordType,
              service,
              amountMicroUsd: toMicroUsd(group.Metrics?.UnblendedCost?.Amount),
            });
          }
        }
        token = page.NextPageToken || undefined;
      } while (token);
      return lines;
    },
  };
}
