// The tenant seam's CLIENT INTERFACES (MOTIR-10004): provider-neutral slices of
// the AWS services the hosting adapter calls in a tenant account. No AWS SDK
// type appears here; `sdk.ts` implements them over the SDK. A later card adds
// its service to `TenantClients` and to the fake beside it.

import type { TenantCloudWatch, TenantLambda } from './function/lambdaClient';

/** A stack as the runner reads it. */
export interface TenantStack {
  readonly name: string;
  readonly status: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
  /** When the stack was created, when CloudFormation says. */
  readonly createdAt?: Date;
}

export interface TenantStackWrite {
  readonly name: string;
  readonly templateBody: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

/** The CloudFormation calls the stack runner makes. */
export interface TenantCloudFormation {
  /** The stack, or null when there is none of that name. */
  describeStack(name: string): Promise<TenantStack | null>;
  /** The template the stack was last applied with, as submitted. */
  getTemplateBody(name: string): Promise<string>;
  createStack(input: TenantStackWrite): Promise<void>;
  /** `no_change` when CloudFormation finds nothing to update. */
  updateStack(input: TenantStackWrite): Promise<'updating' | 'no_change'>;
  deleteStack(name: string): Promise<void>;
}

/** One SQL value as the RDS Data API returns it. */
export type TenantSqlValue = string | number | boolean | null;

export interface TenantStatement {
  /** The cluster's ARN and the secret that authorises the call (the master's). */
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
  readonly sql: string;
  /** Named `:parameters`, all strings. */
  readonly parameters?: Readonly<Record<string, string>>;
}

/** The RDS Data API (MOTIR-10007): SQL on a private cluster without a
 *  connection. A paused Serverless v2 cluster answers `DatabaseResumingException`. */
export interface TenantRdsData {
  executeStatement(statement: TenantStatement): Promise<TenantSqlValue[][]>;
}

/** Read and put a secret's value (MOTIR-10007). No create, tag or delete: every
 *  secret is a stack's resource. */
export interface TenantSecretsManager {
  getSecretValue(secretId: string): Promise<string>;
  /** With `versionId`, the value is that version of the secret: putting the same
   *  value under the same id again is a no change (MOTIR-10008). */
  putSecretValue(secretId: string, value: string, versionId?: string): Promise<void>;
}

/** Every client of one tenant account, all under its deploy role. */
export interface TenantClients {
  readonly accountId: string;
  readonly region: string;
  readonly cloudformation: TenantCloudFormation;
  readonly rdsData: TenantRdsData;
  readonly secretsManager: TenantSecretsManager;
  /** The function shape's (MOTIR-10008). */
  readonly lambda: TenantLambda;
  readonly cloudwatch: TenantCloudWatch;
}
