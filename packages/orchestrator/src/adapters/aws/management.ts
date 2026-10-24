import {
  GetUserCommand,
  CreateUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  ListCreateAccountStatusCommand,
  OrganizationsClient,
  type Account,
  type CreateAccountStatus,
} from '@aws-sdk/client-organizations';
import {
  GetAWSDefaultServiceQuotaCommand,
  GetServiceQuotaCommand,
  ServiceQuotasClient,
} from '@aws-sdk/client-service-quotas';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsManagementCredentials } from './credentials';
import { AWS_SHARD_TAG_KEY } from './network';

// THE AWS MANAGEMENT HALF (Story MOTIR-9270 · MOTIR-9278) — what `fleet-admin
// add-shard --provider aws` calls to make an account a fleet account: find or
// create the AWS Organizations member account, assume its admin role, read its
// vCPU quota and create the IAM user its runners boot with. With `ec2Client.ts`
// it is the only place that imports an AWS SDK package (the story's architecture
// guard, MOTIR-9280).
//
// ⚠️ NO ENVIRONMENT READ AND NO KEY MINTED. Credentials arrive as arguments (the
// caller reads them with `awsManagementCredentials`), every assumed-role session
// lives in memory for one run, and `CreateAccessKey` is never called: creating
// the runner's key is a person's step, which add-shard only words.
//
// The credential chain (MOTIR-9271): the management IAM user's key assumes the
// management role (`AWS_ORG_ADMIN_ROLE_ARN`), which may call Organizations and
// assume `OrganizationAccountAccessRole` in a member account; that member role
// reads Service Quotas, manages IAM and builds the network.
//
// API references, read 2026-10-24:
//   Organizations — https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccounts.html,
//     API_ListCreateAccountStatus.html, API_CreateAccount.html, API_DescribeCreateAccountStatus.html
//   STS — https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
//   Service Quotas — https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_GetServiceQuota.html,
//     API_GetAWSDefaultServiceQuota.html
//   IAM — https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetUser.html, API_CreateUser.html,
//     API_GetUserPolicy.html, API_PutUserPolicy.html

/** The role Organizations creates in every account it creates (CreateAccount's
 *  `RoleName` default). */
export const AWS_MEMBER_ROLE_NAME = 'OrganizationAccountAccessRole';

/** EC2's "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" quota,
 *  measured in vCPUs — https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html */
export const AWS_EC2_VCPU_QUOTA_CODE = 'L-1216C47A';

/** The IAM user every account's runners boot with, and its inline policy. */
export const AWS_RUNNER_IAM_USER = 'motir-fleet-runner';
export const AWS_RUNNER_IAM_POLICY = 'motir-fleet-runner-ec2';

/** Organizations, STS and IAM are global; their endpoints answer in us-east-1. */
const GLOBAL_REGION = 'us-east-1';
/** How long an assumed session lasts. 15 minutes is STS's minimum, and a run of
 *  add-shard takes well under it after the account exists. */
const SESSION_SECONDS = 900;
const SESSION_NAME = 'motir-add-shard';
/** CreateAccount is asynchronous; AWS documents it as taking minutes. */
export const AWS_CREATE_ACCOUNT_TIMEOUT_MS = 10 * 60_000;
const CREATE_ACCOUNT_POLL_MS = 5_000;
/** A new account's admin role takes a moment to be assumable. */
const MEMBER_ROLE_ATTEMPTS = 6;
const MEMBER_ROLE_RETRY_MS = 5_000;

/** Short-lived credentials from `AssumeRole`. */
export interface AwsSessionCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date | null;
}

/** A member account of the organization. */
export interface AwsOrganizationAccount {
  readonly accountId: string;
  readonly name: string;
  readonly status: string;
}

/** What a lookup by name found: the account, a CreateAccount still running for
 *  that name, or neither. */
export interface AwsOrganizationAccountLookup {
  readonly account: AwsOrganizationAccount | null;
  readonly inProgressRequestId: string | null;
}

/** A management-API refusal — the service and AWS's error CODE, never its message. */
export class AwsManagementApiError extends Error {
  readonly code = 'AWS_MANAGEMENT_API_ERROR';
  constructor(
    readonly service: string,
    readonly awsCode: string,
    readonly httpStatus: number | null,
  ) {
    super(`${service} refused the call: ${awsCode}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
    this.name = 'AwsManagementApiError';
  }
}

/** CreateAccount ended `FAILED`; `reason` is AWS's `FailureReason`
 *  (`EMAIL_ALREADY_EXISTS`, `ACCOUNT_LIMIT_EXCEEDED`, …). */
export class AwsAccountCreationRefusedError extends Error {
  readonly code = 'AWS_ACCOUNT_CREATION_REFUSED';
  constructor(
    readonly accountName: string,
    readonly reason: string,
  ) {
    super(`AWS refused to create the account ${accountName}: ${reason}`);
    this.name = 'AwsAccountCreationRefusedError';
  }
}

/** The slice of an SDK client the module uses — what a test stubs. */
export interface AwsSdkClient {
  send(command: unknown): Promise<unknown>;
}

export type AwsManagementService = 'sts' | 'organizations' | 'service-quotas' | 'iam';

/** How the module builds each SDK client. The default is the real client. */
export type AwsManagementClientFactory = (
  service: AwsManagementService,
  config: {
    region: string;
    credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  },
) => AwsSdkClient;

/** The real SDK client for each service. */
export const createAwsManagementSdkClient: AwsManagementClientFactory = (service, config) => {
  switch (service) {
    case 'sts':
      return new STSClient(config);
    case 'organizations':
      return new OrganizationsClient(config);
    case 'service-quotas':
      return new ServiceQuotasClient(config);
    case 'iam':
      return new IAMClient(config);
  }
};

export interface AwsManagementOptions {
  clientFactory?: AwsManagementClientFactory;
  /** The test seams for CreateAccount's poll and the member role's retry. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The management calls add-shard makes. */
export interface AwsManagementApi {
  findOrganizationAccount(name: string): Promise<AwsOrganizationAccountLookup>;
  /** File CreateAccount and wait for it. */
  createOrganizationAccount(input: {
    name: string;
    email: string;
  }): Promise<AwsOrganizationAccount>;
  /** Wait on a CreateAccount an earlier run filed. */
  waitForCreateAccount(requestId: string, name: string): Promise<AwsOrganizationAccount>;
  assumeMemberRole(accountId: string): Promise<AwsSessionCredentials>;
  readVcpuQuota(credentials: AwsSessionCredentials, regionId: string): Promise<number>;
  /** The runner's IAM user and inline policy; answers what it created. */
  ensureRunnerIamUser(
    credentials: AwsSessionCredentials,
    policyDocument: AwsPolicyDocument,
  ): Promise<{ created: string[] }>;
}

interface SdkErrorShape {
  name?: unknown;
  Code?: unknown;
  $metadata?: { httpStatusCode?: unknown };
}

function errorCode(err: unknown): string {
  const shape = (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
  if (typeof shape.Code === 'string' && shape.Code) return shape.Code;
  if (typeof shape.name === 'string' && shape.name) return shape.name;
  return 'UnknownError';
}

function toApiError(service: AwsManagementService, err: unknown): AwsManagementApiError {
  if (err instanceof AwsManagementApiError) return err;
  const shape = (typeof err === 'object' && err !== null ? err : {}) as SdkErrorShape;
  const status =
    typeof shape.$metadata?.httpStatusCode === 'number' ? shape.$metadata.httpStatusCode : null;
  return new AwsManagementApiError(service, errorCode(err), status);
}

function required<T>(value: T | undefined | null, field: string): T {
  if (value === undefined || value === null || value === '') {
    throw new AwsManagementApiError('aws', `MissingField:${field}`, null);
  }
  return value;
}

function sessionOf(response: {
  Credentials?: {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    SessionToken?: string;
    Expiration?: Date;
  };
}): AwsSessionCredentials {
  const c = required(response.Credentials, 'Credentials');
  return {
    accessKeyId: required(c.AccessKeyId, 'AccessKeyId'),
    secretAccessKey: required(c.SecretAccessKey, 'SecretAccessKey'),
    sessionToken: required(c.SessionToken, 'SessionToken'),
    expiration: c.Expiration ?? null,
  };
}

function accountOf(account: Account): AwsOrganizationAccount {
  return {
    accountId: required(account.Id, 'Id'),
    name: account.Name ?? '',
    status: account.State ?? account.Status ?? '',
  };
}

export function createAwsManagementApi(
  management: AwsManagementCredentials,
  options: AwsManagementOptions = {},
): AwsManagementApi {
  const factory = options.clientFactory ?? createAwsManagementSdkClient;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  async function call<T>(service: AwsManagementService, client: AwsSdkClient, command: unknown) {
    try {
      return (await client.send(command)) as T;
    } catch (err) {
      throw toApiError(service, err);
    }
  }

  function client(
    service: AwsManagementService,
    creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string },
    region = GLOBAL_REGION,
  ) {
    return factory(service, {
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      },
    });
  }

  // The management role's session, assumed once per run and renewed a minute
  // before it expires.
  let managementSession: AwsSessionCredentials | null = null;
  async function managementRole(): Promise<AwsSessionCredentials> {
    const expiresAt = managementSession?.expiration?.getTime() ?? Infinity;
    if (managementSession && expiresAt - now() > 60_000) return managementSession;
    const response = await call<Parameters<typeof sessionOf>[0]>(
      'sts',
      client('sts', management),
      new AssumeRoleCommand({
        RoleArn: management.roleArn,
        RoleSessionName: SESSION_NAME,
        DurationSeconds: SESSION_SECONDS,
      }),
    );
    managementSession = sessionOf(response);
    return managementSession;
  }

  async function organizations(): Promise<AwsSdkClient> {
    return client('organizations', await managementRole());
  }

  async function waitForCreateAccount(requestId: string, name: string) {
    const deadline = now() + AWS_CREATE_ACCOUNT_TIMEOUT_MS;
    const orgs = await organizations();
    for (;;) {
      const { CreateAccountStatus: status } = await call<{
        CreateAccountStatus?: CreateAccountStatus;
      }>(
        'organizations',
        orgs,
        new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId }),
      );
      const state = status?.State;
      if (state === 'SUCCEEDED') {
        return {
          accountId: required(status?.AccountId, 'AccountId'),
          name: status?.AccountName ?? name,
          status: 'ACTIVE',
        };
      }
      if (state === 'FAILED') {
        throw new AwsAccountCreationRefusedError(name, status?.FailureReason ?? 'UNKNOWN');
      }
      if (now() >= deadline) {
        throw new Error(
          `CreateAccount request ${requestId} for ${name} was still ${state ?? 'unknown'} after ` +
            `${AWS_CREATE_ACCOUNT_TIMEOUT_MS / 60_000} minutes; run the command again to keep waiting`,
        );
      }
      await sleep(CREATE_ACCOUNT_POLL_MS);
    }
  }

  return {
    async findOrganizationAccount(name) {
      const orgs = await organizations();
      let nextToken: string | undefined;
      do {
        const page = await call<{ Accounts?: Account[]; NextToken?: string }>(
          'organizations',
          orgs,
          new ListAccountsCommand({ ...(nextToken ? { NextToken: nextToken } : {}) }),
        );
        const match = (page.Accounts ?? []).find((a) => a.Name === name);
        if (match) return { account: accountOf(match), inProgressRequestId: null };
        nextToken = page.NextToken ?? undefined;
      } while (nextToken);

      // A CreateAccount an earlier run filed and did not see finish: waited on,
      // never filed again (a second one would make a second account).
      do {
        const page = await call<{
          CreateAccountStatuses?: CreateAccountStatus[];
          NextToken?: string;
        }>(
          'organizations',
          orgs,
          new ListCreateAccountStatusCommand({
            States: ['IN_PROGRESS'],
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        );
        const match = (page.CreateAccountStatuses ?? []).find((s) => s.AccountName === name);
        if (match) return { account: null, inProgressRequestId: required(match.Id, 'Id') };
        nextToken = page.NextToken ?? undefined;
      } while (nextToken);
      return { account: null, inProgressRequestId: null };
    },

    async createOrganizationAccount({ name, email }) {
      const { CreateAccountStatus: status } = await call<{
        CreateAccountStatus?: CreateAccountStatus;
      }>(
        'organizations',
        await organizations(),
        new CreateAccountCommand({
          AccountName: name,
          Email: email,
          RoleName: AWS_MEMBER_ROLE_NAME,
        }),
      );
      return waitForCreateAccount(required(status?.Id, 'CreateAccountStatus.Id'), name);
    },

    waitForCreateAccount,

    async assumeMemberRole(accountId) {
      const sts = client('sts', await managementRole());
      const command = new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${accountId}:role/${AWS_MEMBER_ROLE_NAME}`,
        RoleSessionName: SESSION_NAME,
        DurationSeconds: SESSION_SECONDS,
      });
      for (let attempt = 1; ; attempt += 1) {
        try {
          return sessionOf(await call<Parameters<typeof sessionOf>[0]>('sts', sts, command));
        } catch (err) {
          // A just-created account's role propagates within seconds.
          if (!(err instanceof AwsManagementApiError) || err.awsCode !== 'AccessDenied') throw err;
          if (attempt >= MEMBER_ROLE_ATTEMPTS) throw err;
          await sleep(MEMBER_ROLE_RETRY_MS);
        }
      }
    },

    async readVcpuQuota(credentials, regionId) {
      const quotas = client('service-quotas', credentials, regionId);
      const input = { ServiceCode: 'ec2', QuotaCode: AWS_EC2_VCPU_QUOTA_CODE };
      let value: number | undefined;
      try {
        const answer = await call<{ Quota?: { Value?: number } }>(
          'service-quotas',
          quotas,
          new GetServiceQuotaCommand(input),
        );
        value = answer.Quota?.Value;
      } catch (err) {
        // An account whose quota was never changed may have no applied value
        // yet; the default is then what applies.
        if (!(err instanceof AwsManagementApiError) || err.awsCode !== 'NoSuchResourceException') {
          throw err;
        }
        const answer = await call<{ Quota?: { Value?: number } }>(
          'service-quotas',
          quotas,
          new GetAWSDefaultServiceQuotaCommand(input),
        );
        value = answer.Quota?.Value;
      }
      return Math.floor(required(value, 'Quota.Value'));
    },

    async ensureRunnerIamUser(credentials, policyDocument) {
      const iam = client('iam', credentials);
      const created: string[] = [];
      const absent = (err: unknown) =>
        err instanceof AwsManagementApiError &&
        (err.awsCode === 'NoSuchEntity' || err.awsCode === 'NoSuchEntityException');

      try {
        await call('iam', iam, new GetUserCommand({ UserName: AWS_RUNNER_IAM_USER }));
      } catch (err) {
        if (!absent(err)) throw err;
        await call(
          'iam',
          iam,
          new CreateUserCommand({
            UserName: AWS_RUNNER_IAM_USER,
            Tags: [{ Key: 'motir-role', Value: 'fleet-runner' }],
          }),
        );
        created.push(`iam-user:${AWS_RUNNER_IAM_USER}`);
      }

      const wanted = JSON.stringify(policyDocument);
      let current: string | null = null;
      try {
        const answer = await call<{ PolicyDocument?: string }>(
          'iam',
          iam,
          new GetUserPolicyCommand({
            UserName: AWS_RUNNER_IAM_USER,
            PolicyName: AWS_RUNNER_IAM_POLICY,
          }),
        );
        // IAM answers the document URL-encoded (RFC 3986).
        current = answer.PolicyDocument ? decodeURIComponent(answer.PolicyDocument) : null;
      } catch (err) {
        if (!absent(err)) throw err;
      }
      if (current === null || !samePolicy(current, wanted)) {
        await call(
          'iam',
          iam,
          new PutUserPolicyCommand({
            UserName: AWS_RUNNER_IAM_USER,
            PolicyName: AWS_RUNNER_IAM_POLICY,
            PolicyDocument: wanted,
          }),
        );
        created.push(`iam-policy:${AWS_RUNNER_IAM_POLICY}`);
      }
      return { created };
    },
  };
}

function samePolicy(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

/** An IAM policy document. */
export interface AwsPolicyDocument {
  Version: '2012-10-17';
  Statement: Array<Record<string, unknown>>;
}

/**
 * What a runner key may do: exactly the EC2 calls the adapter makes, scoped by
 * the `motir-shard` tag where the action supports a tag condition. Describe calls
 * support no resource-level permission, so they are `*`; a launch must TAG its
 * instance and volume with the shard (`aws:RequestTag`), and a terminate reaches
 * only the shard's own instances (`aws:ResourceTag`).
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html
 */
export function awsRunnerPolicyDocument(input: {
  shardTag: string;
  regionId: string;
}): AwsPolicyDocument {
  const arn = (resource: string, account = '*') =>
    `arn:aws:ec2:${input.regionId}:${account}:${resource}`;
  const tagged = { [`aws:RequestTag/${AWS_SHARD_TAG_KEY}`]: input.shardTag };
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Describe',
        Effect: 'Allow',
        Action: ['ec2:DescribeInstances', 'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups'],
        Resource: '*',
      },
      {
        Sid: 'LaunchTagged',
        Effect: 'Allow',
        Action: 'ec2:RunInstances',
        Resource: [arn('instance/*'), arn('volume/*')],
        Condition: { StringEquals: tagged },
      },
      {
        Sid: 'LaunchFrom',
        Effect: 'Allow',
        Action: 'ec2:RunInstances',
        Resource: [
          arn('image/*', ''),
          arn('subnet/*'),
          arn('security-group/*'),
          arn('network-interface/*'),
        ],
      },
      {
        Sid: 'TagAtLaunch',
        Effect: 'Allow',
        Action: 'ec2:CreateTags',
        Resource: [arn('instance/*'), arn('volume/*')],
        Condition: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
      },
      {
        Sid: 'TerminateOwn',
        Effect: 'Allow',
        Action: 'ec2:TerminateInstances',
        Resource: arn('instance/*'),
        Condition: {
          StringEquals: { [`aws:ResourceTag/${AWS_SHARD_TAG_KEY}`]: input.shardTag },
        },
      },
    ],
  };
}
