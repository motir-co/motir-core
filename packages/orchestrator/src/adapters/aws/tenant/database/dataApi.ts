import type { TenantRdsData, TenantSqlValue } from '../clients';
import { AwsTenantApiError } from '../errors';

// SQL on the tenant cluster through the RDS DATA API (MOTIR-10007). The cluster
// is private and Motir's identity is outside the VPC, so no connection is
// opened: each statement is one `ExecuteStatement`, authorised by the master
// secret's ARN. A Serverless v2 cluster that has paused answers
// `DatabaseResumingException` until it is back; that is retried with bounded
// backoff and then becomes a typed timeout. Any other failure becomes a typed
// error naming the OPERATION — never the statement, which can hold a password.

const RESUMING = 'DatabaseResumingException';
/** Backoff while the cluster resumes: 1 s doubling to 16 s, at most ~2 minutes. */
const RESUME_DELAYS_MS = [
  1_000, 2_000, 4_000, 8_000, 16_000, 16_000, 16_000, 16_000, 16_000, 16_000,
];

/** The cluster did not resume in time. */
export class DatabaseResumeTimeoutError extends Error {
  readonly code = 'AWS_DATABASE_RESUME_TIMEOUT' as const;
  constructor(readonly operation: string) {
    super(`The database was still resuming when "${operation}" gave up.`);
    this.name = 'DatabaseResumeTimeoutError';
  }
}

/** A statement failed. Carries the operation's name and AWS's code only. */
export class DatabaseStatementError extends Error {
  readonly code = 'AWS_DATABASE_STATEMENT_FAILED' as const;
  constructor(
    readonly operation: string,
    readonly awsCode: string,
  ) {
    super(`The database refused "${operation}" (${awsCode}).`);
    this.name = 'DatabaseStatementError';
  }
}

export interface SqlTarget {
  readonly clusterArn: string;
  /** The master secret: what the Data API authenticates with. */
  readonly masterSecretArn: string;
  readonly database: string;
}

export interface SqlRunner {
  /** Run one statement. `operation` names it in errors in place of its text. */
  run(
    operation: string,
    sql: string,
    parameters?: Readonly<Record<string, string>>,
  ): Promise<TenantSqlValue[][]>;
}

export function createSqlRunner(
  rdsData: TenantRdsData,
  target: SqlTarget,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): SqlRunner {
  return {
    async run(operation, sql, parameters) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await rdsData.executeStatement({
            resourceArn: target.clusterArn,
            secretArn: target.masterSecretArn,
            database: target.database,
            sql,
            ...(parameters ? { parameters } : {}),
          });
        } catch (err) {
          const code = err instanceof AwsTenantApiError ? err.awsCode : 'UnknownError';
          if (code !== RESUMING) throw new DatabaseStatementError(operation, code);
          const delay = RESUME_DELAYS_MS[attempt];
          if (delay === undefined) throw new DatabaseResumeTimeoutError(operation);
          await sleep(delay);
        }
      }
    },
  };
}
