// The tenant seam's CLIENT INTERFACES (MOTIR-10004): provider-neutral slices of
// the AWS services the hosting adapter calls in a tenant account. No AWS SDK
// type appears here; `sdk.ts` implements them over the SDK. A later card adds
// its service to `TenantClients` and to the fake beside it.

import type { TenantEcs, TenantElb, TenantSsm } from './container/ecsClient';
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

/** A stack as `ListStacks` names it (MOTIR-12130). ListStacks carries no tags
 *  or parameters; a caller that needs them describes the stack. */
export interface TenantStackSummary {
  readonly name: string;
  readonly status: string;
}

/** The CloudFormation calls the stack runner makes. */
export interface TenantCloudFormation {
  /** Every stack in the account that is not deleted, across every page
   *  (MOTIR-12130): what the handover's preview teardown selects from. */
  listStacks(): Promise<TenantStackSummary[]>;
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

/** The EC2 reads the network makes (MOTIR-11846). No create or change: every
 *  network resource is the network stack's. */
export interface TenantEc2 {
  /** The id of the AWS-managed prefix list of that name in the client's region,
   *  or null when the region has none. */
  managedPrefixListId(name: string): Promise<string | null>;
}

/** An IAM policy document, as IAM stores it once decoded. */
export interface TenantPolicyDocument {
  readonly Version: string;
  readonly Statement: readonly Readonly<Record<string, unknown>>[];
}

/** A role as the handover reads it: its name, path and trust policy. */
export interface TenantIamRole {
  readonly name: string;
  readonly arn: string;
  readonly path: string;
  readonly trust: TenantPolicyDocument;
}

/** A customer-managed policy, or a policy attached to a role. */
export interface TenantIamPolicyRef {
  readonly name: string;
  readonly arn: string;
}

/** The IAM calls the handover makes in a tenant account (MOTIR-12130): IAM is
 *  global, so the slice is the account's, whatever its region. Every delete
 *  answers quietly when the thing is already gone. */
export interface TenantIam {
  /** The role, or null when there is none of that name. */
  getRole(name: string): Promise<TenantIamRole | null>;
  createRole(input: {
    readonly name: string;
    /** The role's IAM path, `/` when absent. */
    readonly path?: string;
    readonly trust: TenantPolicyDocument;
    readonly description: string;
    readonly maxSessionSeconds: number;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<void>;
  updateAssumeRolePolicy(name: string, trust: TenantPolicyDocument): Promise<void>;
  /** An inline policy's document, or null when the role has none of that name. */
  getRolePolicy(role: string, policyName: string): Promise<TenantPolicyDocument | null>;
  putRolePolicy(role: string, policyName: string, document: TenantPolicyDocument): Promise<void>;
  deleteRolePolicy(role: string, policyName: string): Promise<void>;
  listRolePolicies(role: string): Promise<string[]>;
  listAttachedRolePolicies(role: string): Promise<TenantIamPolicyRef[]>;
  detachRolePolicy(role: string, policyArn: string): Promise<void>;
  /** The instance profiles the role sits in: IAM refuses to delete a role that
   *  is still in one. */
  listInstanceProfilesForRole(role: string): Promise<string[]>;
  removeRoleFromInstanceProfile(profile: string, role: string): Promise<void>;
  deleteInstanceProfile(profile: string): Promise<void>;
  deleteRole(name: string): Promise<void>;
  /** Every role in the account, across every page. */
  listRoles(): Promise<TenantIamRole[]>;
  /** The customer-managed policies under `pathPrefix`. */
  listPolicies(pathPrefix: string): Promise<TenantIamPolicyRef[]>;
  /** Delete a customer-managed policy, its non-default versions first (IAM
   *  refuses the policy while they exist). */
  deletePolicy(policyArn: string): Promise<void>;
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
  /** The container shape's (MOTIR-10009). */
  readonly ecs: TenantEcs;
  readonly elb: TenantElb;
  readonly ssm: TenantSsm;
  /** The network's (MOTIR-11846). */
  readonly ec2: TenantEc2;
  /** The handover's (MOTIR-12130). */
  readonly iam: TenantIam;
}
