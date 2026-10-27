import {
  CloudFormationClient,
  CreateStackInstancesCommand,
  DescribeStackInstanceCommand,
  DescribeStackSetOperationCommand,
  DescribeStacksCommand,
  UpdateStackInstancesCommand,
  type StackInstance,
} from '@aws-sdk/client-cloudformation';
import {
  CreateRoleCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  GetUserCommand,
  CreateUserCommand,
  GetUserPolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
  PutUserPolicyCommand,
} from '@aws-sdk/client-iam';
import {
  CreateAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  ListCreateAccountStatusCommand,
  ListParentsCommand,
  MoveAccountCommand,
  OrganizationsClient,
  type Account,
  type CreateAccountStatus,
} from '@aws-sdk/client-organizations';
import {
  GetAWSDefaultServiceQuotaCommand,
  GetRequestedServiceQuotaChangeCommand,
  GetServiceQuotaCommand,
  ListRequestedServiceQuotaChangeHistoryByQuotaCommand,
  RequestServiceQuotaIncreaseCommand,
  ServiceQuotasClient,
} from '@aws-sdk/client-service-quotas';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsManagementCredentials } from './credentials';
import { AWS_SHARD_TAG_KEY } from './network';
import {
  AWS_STACK_SET_OPERATION_RUNNING,
  AwsStackInstanceFailedError,
  AwsStackOutputsMissingError,
  awsStackSetOperationId,
  parameterOverridesFor,
  parameterOverridesOf,
  sameParameterOverrides,
  stackInstanceOutcome,
  type AwsStackInstanceState,
  type AwsStackInstanceTarget,
} from './stackSet';

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
//     API_GetAWSDefaultServiceQuota.html, API_RequestServiceQuotaIncrease.html,
//     API_GetRequestedServiceQuotaChange.html, API_ListRequestedServiceQuotaChangeHistoryByQuota.html
//     (MOTIR-9459: the fleet's own quota raises)
//   IAM — https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetUser.html, API_CreateUser.html,
//     API_GetUserPolicy.html, API_PutUserPolicy.html
//   Organizations, the unit (MOTIR-9844) — API_ListParents.html, API_MoveAccount.html
//   CloudFormation StackSets (MOTIR-9844) — see `./stackSet.ts`
//
// THE STACKSET HALF (MOTIR-9844): a pool account is built by the pool-account
// StackSet (motir-infra), not by code. The account is moved into its fleet
// kind's unit, its stack instance created with this account's parameters, and
// the instance's stack outputs read back. A StackSet run by a delegated
// administrator can only be driven from that account (the services account), so
// those calls run on `stackSetAdmin.roleArn`, assumed from the management
// session, or on the default chain when it is unset.

/** The role Organizations creates in every account it creates (CreateAccount's
 *  `RoleName` default). */
export const AWS_MEMBER_ROLE_NAME = 'OrganizationAccountAccessRole';

/** EC2's "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" quota,
 *  measured in vCPUs — https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-instance-quotas.html */
export const AWS_EC2_VCPU_QUOTA_CODE = 'L-1216C47A';

/** The IAM user every account's runners boot with, and its inline policy. */
export const AWS_RUNNER_IAM_USER = 'motir-fleet-runner';
/** The runner's IAM ROLE in a member account an unattended add-shard created
 *  (MOTIR-9460): the management role assumes it, so no person mints a key.
 *  Roles and users are separate IAM namespaces; the name matches the user's. */
export const AWS_RUNNER_IAM_ROLE = 'motir-fleet-runner';
export const AWS_RUNNER_IAM_POLICY = 'motir-fleet-runner-ec2';

/** Organizations, STS and IAM are global; their endpoints answer in us-east-1. */
const GLOBAL_REGION = 'us-east-1';
/** How long an assumed session lasts. 15 minutes is STS's minimum, and a run of
 *  add-shard takes well under it after the account exists. */
const SESSION_SECONDS = 900;
const SESSION_NAME = 'motir-add-shard';
/** A runner session (MOTIR-9460): an hour, the role's maximum; the SDK renews it
 *  through the credential provider before it lapses. */
const RUNNER_SESSION_SECONDS = 3600;
const RUNNER_SESSION_NAME = 'motir-fleet-runner';
/** CreateAccount is asynchronous; AWS documents it as taking minutes. */
export const AWS_CREATE_ACCOUNT_TIMEOUT_MS = 10 * 60_000;
const CREATE_ACCOUNT_POLL_MS = 5_000;
/** A new account's admin role takes a moment to be assumable. */
const MEMBER_ROLE_ATTEMPTS = 6;
const MEMBER_ROLE_RETRY_MS = 5_000;

/** How long `ensureStackInstance` waits for CURRENT before asking for a re-run. */
export const AWS_STACK_INSTANCE_TIMEOUT_MS = 30 * 60_000;
const STACK_INSTANCE_POLL_MS = 10_000;
/** The refusals of a create or update that mean another call got there first:
 *  the instance exists, or an operation (auto-deployment's, or ours) runs. */
const STACK_SET_RACE_CODES = [
  'OperationInProgressException',
  'OperationIdAlreadyExistsException',
  'NameAlreadyExistsException',
  'StaleRequestException',
];

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

export type AwsManagementService =
  | 'sts'
  | 'organizations'
  | 'service-quotas'
  | 'iam'
  | 'cloudformation';

/** How the module builds each SDK client. The default is the real client. */
export type AwsManagementClientFactory = (
  service: AwsManagementService,
  config: {
    region: string;
    /** Absent: the SDK's default credential chain (the management role's first
     *  AssumeRole when no management key is set — MOTIR-9839). */
    credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
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
    case 'cloudformation':
      return new CloudFormationClient(config);
  }
};

export interface AwsManagementOptions {
  clientFactory?: AwsManagementClientFactory;
  /** Where the StackSet calls run (MOTIR-9844): `roleArn`, the services
   *  account's StackSet-operator role, assumed from the management session.
   *  Absent: the default credential chain (core's task role on Fargate). */
  stackSetAdmin?: { roleArn: string };
  /** The test seams for CreateAccount's poll and the member role's retry. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** One Service Quotas increase request, as AWS answers it (MOTIR-9459).
 *  `status` is AWS's `RequestStatus` verbatim (`PENDING`, `CASE_OPENED`, …); the
 *  caller maps it, so a value AWS adds later is seen rather than defaulted. */
export interface AwsQuotaIncreaseRequest {
  requestId: string;
  status: string;
  desiredValue: number | null;
}

/** The management calls add-shard and the pool's growth make. */
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
  /** File a raise of `quotaCode` (default `L-1216C47A`) to `desired` — MOTIR-9459. */
  requestVcpuQuotaIncrease(
    credentials: AwsSessionCredentials,
    regionId: string,
    desired: number,
    quotaCode?: string,
  ): Promise<AwsQuotaIncreaseRequest>;
  /** Read one filed raise. */
  getQuotaRequest(
    credentials: AwsSessionCredentials,
    regionId: string,
    requestId: string,
  ): Promise<AwsQuotaIncreaseRequest>;
  /** The account's still-open raise of `quotaCode`, if AWS has one — what a
   *  re-filing finds when the first filing was accepted but never stored. */
  findOpenQuotaRequest(
    credentials: AwsSessionCredentials,
    regionId: string,
    quotaCode?: string,
  ): Promise<AwsQuotaIncreaseRequest | null>;
  /** The runner's IAM ROLE and inline policy, trusting the management role
   *  (MOTIR-9460); answers what it created. */
  ensureRunnerRole(
    credentials: AwsSessionCredentials,
    policyDocument: AwsPolicyDocument,
  ): Promise<{ created: string[] }>;
  /** A runner session in the member account, from the management role. */
  assumeRunnerRole(accountId: string): Promise<AwsSessionCredentials>;
  /** The runner's IAM user and inline policy; answers what it created. */
  ensureRunnerIamUser(
    credentials: AwsSessionCredentials,
    policyDocument: AwsPolicyDocument,
  ): Promise<{ created: string[] }>;
  /** Put the account under `organizationalUnitId`; a no-op when it is there. */
  moveAccountToOrganizationalUnit(
    accountId: string,
    organizationalUnitId: string,
  ): Promise<{ moved: boolean }>;
  /** Make the account's stack instance exist with exactly these overrides, and
   *  wait for it to be CURRENT. Answers what it sent, `none` on a resumed run. */
  ensureStackInstance(
    input: AwsStackInstanceTarget & {
      organizationalUnitId: string;
      parameterOverrides: Readonly<Record<string, string>>;
    },
  ): Promise<{ action: 'created' | 'updated' | 'none' }>;
  /** The instance's stack outputs, read in the member account. */
  readStackInstanceOutputs(target: AwsStackInstanceTarget): Promise<Record<string, string>>;
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

/** The two `RequestStatus` values a request is still open in. */
const OPEN_QUOTA_REQUEST_STATUSES = ['PENDING', 'CASE_OPENED'] as const;

interface RequestedQuotaShape {
  Id?: string;
  Status?: string;
  DesiredValue?: number;
}

function quotaRequestOf(quota: RequestedQuotaShape): AwsQuotaIncreaseRequest {
  return {
    requestId: required(quota.Id, 'RequestedQuota.Id'),
    status: required(quota.Status, 'RequestedQuota.Status'),
    desiredValue: typeof quota.DesiredValue === 'number' ? quota.DesiredValue : null,
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
    const { accessKeyId, secretAccessKey } = management;
    // No management key: an STS client with no `credentials`, so the SDK's
    // default chain supplies them.
    const sts =
      accessKeyId && secretAccessKey
        ? client('sts', { accessKeyId, secretAccessKey })
        : factory('sts', { region: GLOBAL_REGION });
    const response = await call<Parameters<typeof sessionOf>[0]>(
      'sts',
      sts,
      new AssumeRoleCommand({
        RoleArn: management.roleArn,
        RoleSessionName: SESSION_NAME,
        DurationSeconds: SESSION_SECONDS,
      }),
    );
    managementSession = sessionOf(response);
    return managementSession;
  }

  /** Assume `roleName` in a member account from the management session,
   *  retrying `AccessDenied` while a just-created role propagates. */
  async function assumeInMember(
    accountId: string,
    roleName: string,
    sessionName: string,
  ): Promise<AwsSessionCredentials> {
    const sts = client('sts', await managementRole());
    const command = new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
      RoleSessionName: sessionName,
      DurationSeconds: roleName === AWS_RUNNER_IAM_ROLE ? RUNNER_SESSION_SECONDS : SESSION_SECONDS,
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

  // The StackSet-operator session, assumed from the management session when
  // `stackSetAdmin` names a role, renewed like the management session.
  let stackSetSession: AwsSessionCredentials | null = null;
  async function stackSets(region: string): Promise<AwsSdkClient> {
    const roleArn = options.stackSetAdmin?.roleArn;
    if (!roleArn) return factory('cloudformation', { region });
    const expiresAt = stackSetSession?.expiration?.getTime() ?? Infinity;
    if (!stackSetSession || expiresAt - now() <= 60_000) {
      stackSetSession = sessionOf(
        await call<Parameters<typeof sessionOf>[0]>(
          'sts',
          client('sts', await managementRole()),
          new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: SESSION_NAME,
            DurationSeconds: SESSION_SECONDS,
          }),
        ),
      );
    }
    return client('cloudformation', stackSetSession, region);
  }

  /** The account's stack instance, or null when the StackSet holds none. */
  async function describeStackInstance(
    cfn: AwsSdkClient,
    target: AwsStackInstanceTarget,
  ): Promise<AwsStackInstanceState | null> {
    try {
      const { StackInstance: instance } = await call<{ StackInstance?: StackInstance }>(
        'cloudformation',
        cfn,
        new DescribeStackInstanceCommand({
          StackSetName: target.stackSetName,
          StackInstanceAccount: target.accountId,
          StackInstanceRegion: target.region,
          CallAs: 'DELEGATED_ADMIN',
        }),
      );
      if (!instance) return null;
      return {
        status: instance.Status ?? '',
        detailedStatus: instance.StackInstanceStatus?.DetailedStatus ?? null,
        statusReason: instance.StatusReason ?? null,
        stackId: instance.StackId ?? null,
        parameterOverrides: parameterOverridesOf(instance.ParameterOverrides),
      };
    } catch (err) {
      if (
        err instanceof AwsManagementApiError &&
        err.awsCode === 'StackInstanceNotFoundException'
      ) {
        return null;
      }
      throw err;
    }
  }

  /** File a create or update, or null when a racing call got there first. */
  async function fileStackSetOperation(
    cfn: AwsSdkClient,
    command: CreateStackInstancesCommand | UpdateStackInstancesCommand,
  ): Promise<string | null> {
    try {
      const { OperationId } = await call<{ OperationId?: string }>('cloudformation', cfn, command);
      return required(OperationId, 'OperationId');
    } catch (err) {
      if (!(err instanceof AwsManagementApiError) || !STACK_SET_RACE_CODES.includes(err.awsCode)) {
        throw err;
      }
      // Our own operation id, filed by an earlier run: attach to it.
      return err.awsCode === 'OperationIdAlreadyExistsException'
        ? String(command.input.OperationId)
        : null;
    }
  }

  function stackInstanceDeadline(target: AwsStackInstanceTarget, state: string): Error {
    return new Error(
      `The ${target.stackSetName} stack instance in ${target.accountId} (${target.region}) was ` +
        `still ${state} after ${AWS_STACK_INSTANCE_TIMEOUT_MS / 60_000} minutes; ` +
        'run the command again to keep waiting',
    );
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
      return assumeInMember(accountId, AWS_MEMBER_ROLE_NAME, SESSION_NAME);
    },

    async assumeRunnerRole(accountId) {
      return assumeInMember(accountId, AWS_RUNNER_IAM_ROLE, RUNNER_SESSION_NAME);
    },

    async ensureRunnerRole(credentials, policyDocument) {
      const iam = client('iam', credentials);
      const created: string[] = [];
      try {
        await call('iam', iam, new GetRoleCommand({ RoleName: AWS_RUNNER_IAM_ROLE }));
      } catch (err) {
        if (!iamAbsent(err)) throw err;
        await call(
          'iam',
          iam,
          new CreateRoleCommand({
            RoleName: AWS_RUNNER_IAM_ROLE,
            AssumeRolePolicyDocument: JSON.stringify(awsRunnerTrustPolicy(management.roleArn)),
            MaxSessionDuration: RUNNER_SESSION_SECONDS,
            Tags: [{ Key: 'motir-role', Value: 'fleet-runner' }],
          }),
        );
        created.push(`iam-role:${AWS_RUNNER_IAM_ROLE}`);
      }
      const wanted = JSON.stringify(policyDocument);
      let current: string | null = null;
      try {
        const answer = await call<{ PolicyDocument?: string }>(
          'iam',
          iam,
          new GetRolePolicyCommand({
            RoleName: AWS_RUNNER_IAM_ROLE,
            PolicyName: AWS_RUNNER_IAM_POLICY,
          }),
        );
        current = answer.PolicyDocument ? decodeURIComponent(answer.PolicyDocument) : null;
      } catch (err) {
        if (!iamAbsent(err)) throw err;
      }
      if (current === null || !samePolicy(current, wanted)) {
        await call(
          'iam',
          iam,
          new PutRolePolicyCommand({
            RoleName: AWS_RUNNER_IAM_ROLE,
            PolicyName: AWS_RUNNER_IAM_POLICY,
            PolicyDocument: wanted,
          }),
        );
        created.push(`iam-role-policy:${AWS_RUNNER_IAM_POLICY}`);
      }
      return { created };
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

    async requestVcpuQuotaIncrease(credentials, regionId, desired, quotaCode) {
      const quotas = client('service-quotas', credentials, regionId);
      const answer = await call<{ RequestedQuota?: RequestedQuotaShape }>(
        'service-quotas',
        quotas,
        new RequestServiceQuotaIncreaseCommand({
          ServiceCode: 'ec2',
          QuotaCode: quotaCode ?? AWS_EC2_VCPU_QUOTA_CODE,
          DesiredValue: desired,
        }),
      );
      return quotaRequestOf(required(answer.RequestedQuota, 'RequestedQuota'));
    },

    async getQuotaRequest(credentials, regionId, requestId) {
      const quotas = client('service-quotas', credentials, regionId);
      const answer = await call<{ RequestedQuota?: RequestedQuotaShape }>(
        'service-quotas',
        quotas,
        new GetRequestedServiceQuotaChangeCommand({ RequestId: requestId }),
      );
      return quotaRequestOf(required(answer.RequestedQuota, 'RequestedQuota'));
    },

    async findOpenQuotaRequest(credentials, regionId, quotaCode) {
      const quotas = client('service-quotas', credentials, regionId);
      for (const status of OPEN_QUOTA_REQUEST_STATUSES) {
        const answer = await call<{ RequestedQuotas?: RequestedQuotaShape[] }>(
          'service-quotas',
          quotas,
          new ListRequestedServiceQuotaChangeHistoryByQuotaCommand({
            ServiceCode: 'ec2',
            QuotaCode: quotaCode ?? AWS_EC2_VCPU_QUOTA_CODE,
            Status: status,
          }),
        );
        const open = answer.RequestedQuotas?.[0];
        if (open) return quotaRequestOf(open);
      }
      return null;
    },

    async ensureRunnerIamUser(credentials, policyDocument) {
      const iam = client('iam', credentials);
      const created: string[] = [];
      const absent = iamAbsent;

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

    async moveAccountToOrganizationalUnit(accountId, organizationalUnitId) {
      const orgs = await organizations();
      const { Parents } = await call<{ Parents?: { Id?: string }[] }>(
        'organizations',
        orgs,
        new ListParentsCommand({ ChildId: accountId }),
      );
      const parentId = required(Parents?.[0]?.Id, 'Parents.Id');
      if (parentId === organizationalUnitId) return { moved: false };
      await call(
        'organizations',
        orgs,
        new MoveAccountCommand({
          AccountId: accountId,
          SourceParentId: parentId,
          DestinationParentId: organizationalUnitId,
        }),
      );
      return { moved: true };
    },

    async ensureStackInstance({ organizationalUnitId, parameterOverrides, ...target }) {
      const deadline = now() + AWS_STACK_INSTANCE_TIMEOUT_MS;
      const cfn = await stackSets(target.region);
      const common = {
        StackSetName: target.stackSetName,
        Regions: [target.region],
        ParameterOverrides: parameterOverridesFor(parameterOverrides),
        CallAs: 'DELEGATED_ADMIN' as const,
      };

      // Reach an instance with the wanted overrides, or an operation making one.
      // Every state is read from AWS, so a re-run picks up where a run stopped.
      let action: 'created' | 'updated' | 'none' = 'none';
      let operationId: string | null = null;
      for (;;) {
        const instance = await describeStackInstance(cfn, target);
        if (instance && sameParameterOverrides(instance.parameterOverrides, parameterOverrides)) {
          break;
        }
        const create = instance === null;
        const id = awsStackSetOperationId(create ? 'create' : 'update', target, parameterOverrides);
        operationId = await fileStackSetOperation(
          cfn,
          create
            ? new CreateStackInstancesCommand({
                ...common,
                DeploymentTargets: {
                  OrganizationalUnitIds: [organizationalUnitId],
                  Accounts: [target.accountId],
                  AccountFilterType: 'INTERSECTION',
                },
                OperationId: id,
              })
            : new UpdateStackInstancesCommand({
                ...common,
                DeploymentTargets: {
                  OrganizationalUnitIds: [organizationalUnitId],
                  Accounts: [target.accountId],
                  AccountFilterType: 'INTERSECTION',
                },
                OperationId: id,
              }),
        );
        if (operationId) {
          action = create ? 'created' : 'updated';
          break;
        }
        // Another operation got there first: wait it out, then read again.
        if (now() >= deadline) throw stackInstanceDeadline(target, instance?.status ?? 'absent');
        await sleep(STACK_INSTANCE_POLL_MS);
      }

      // Our operation, to its end: until it finishes the instance may still read
      // CURRENT with the old overrides.
      while (operationId) {
        const { StackSetOperation: operation } = await call<{
          StackSetOperation?: { Status?: string; StatusReason?: string };
        }>(
          'cloudformation',
          cfn,
          new DescribeStackSetOperationCommand({
            StackSetName: target.stackSetName,
            OperationId: operationId,
            CallAs: 'DELEGATED_ADMIN',
          }),
        );
        const status = operation?.Status ?? '';
        if (status === 'SUCCEEDED') break;
        if (!(AWS_STACK_SET_OPERATION_RUNNING as readonly string[]).includes(status)) {
          throw new AwsStackInstanceFailedError(
            target,
            `operation ${status || 'unknown'}`,
            operation?.StatusReason ?? null,
          );
        }
        if (now() >= deadline) throw stackInstanceDeadline(target, `operation ${status}`);
        await sleep(STACK_INSTANCE_POLL_MS);
      }

      for (;;) {
        const instance = await describeStackInstance(cfn, target);
        if (instance && stackInstanceOutcome(target, instance) === 'current') return { action };
        if (now() >= deadline) throw stackInstanceDeadline(target, instance?.status ?? 'absent');
        await sleep(STACK_INSTANCE_POLL_MS);
      }
    },

    async readStackInstanceOutputs(target) {
      const instance = await describeStackInstance(await stackSets(target.region), target);
      if (!instance) throw new AwsStackOutputsMissingError(target, 'stack instance');
      if (!instance.stackId) throw new AwsStackOutputsMissingError(target, 'stack id');
      const member = await assumeInMember(target.accountId, AWS_MEMBER_ROLE_NAME, SESSION_NAME);
      let stacks: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[] | undefined;
      try {
        ({ Stacks: stacks } = await call<{ Stacks?: typeof stacks }>(
          'cloudformation',
          client('cloudformation', member, target.region),
          new DescribeStacksCommand({ StackName: instance.stackId }),
        ));
      } catch (err) {
        // A stack the instance names but the account no longer holds.
        if (err instanceof AwsManagementApiError && err.awsCode === 'ValidationError') {
          throw new AwsStackOutputsMissingError(target, 'stack');
        }
        throw err;
      }
      const stack = stacks?.[0];
      if (!stack) throw new AwsStackOutputsMissingError(target, 'stack');
      const outputs: Record<string, string> = {};
      for (const { OutputKey: key, OutputValue: value } of stack.Outputs ?? []) {
        if (key && value !== undefined) outputs[key] = value;
      }
      if (Object.keys(outputs).length === 0)
        throw new AwsStackOutputsMissingError(target, 'outputs');
      return outputs;
    },
  };
}

function iamAbsent(err: unknown): boolean {
  return (
    err instanceof AwsManagementApiError &&
    (err.awsCode === 'NoSuchEntity' || err.awsCode === 'NoSuchEntityException')
  );
}

/** Who may assume the runner role: the management role add-shard and the
 *  orchestrator run as, and nothing else (MOTIR-9460). */
export function awsRunnerTrustPolicy(trustedRoleArn: string): AwsPolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: trustedRoleArn },
        Action: 'sts:AssumeRole',
      },
    ],
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
 *
 * AN INDEXER-POOL ACCOUNT (`reapUntagged`, MOTIR-9450) may also terminate an
 * instance that does NOT carry the shard tag: the attribution pass lists every
 * instance in such an account and must be able to end an untagged one, the leak
 * it exists to find. The account is Motir's own and holds nothing but index VMs,
 * which is what makes that safe; a CI-runner account keeps the tag-scoped
 * terminate only.
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html
 */
export function awsRunnerPolicyDocument(input: {
  shardTag: string;
  regionId: string;
  reapUntagged?: boolean;
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
        // An index VM tags its network interface too (MOTIR-9450).
        Resource: [arn('instance/*'), arn('volume/*'), arn('network-interface/*')],
        Condition: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
      },
      {
        // An index VM's pull failure is read from its console (MOTIR-9446).
        Sid: 'ConsoleOfOwn',
        Effect: 'Allow',
        Action: 'ec2:GetConsoleOutput',
        Resource: arn('instance/*'),
        Condition: {
          StringEquals: { [`aws:ResourceTag/${AWS_SHARD_TAG_KEY}`]: input.shardTag },
        },
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
      ...(input.reapUntagged
        ? [
            {
              Sid: 'TerminateAnyInAccount',
              Effect: 'Allow',
              Action: 'ec2:TerminateInstances',
              Resource: arn('instance/*'),
            },
          ]
        : []),
    ],
  };
}

/**
 * What an AGENT-HOSTER key may do (Story MOTIR-9361 · MOTIR-9479): the runner's
 * calls, plus what a persistent instance needs beyond a one-job VM — stop and
 * start (hibernate, wake), read and rewrite its user-data (the config document,
 * legal only while stopped), re-stamp its tags after launch, list and delete its
 * home disk, and open the host agent's port on its own group (MOTIR-9470). Every action that takes a resource-level condition is held to
 * the account's own `motir-shard` tag; `DescribeVolumes` (like every Describe)
 * supports none, so it is `*`.
 * https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonec2.html
 */
export function awsAgentHosterPolicyDocument(input: {
  shardTag: string;
  regionId: string;
  /** The runner statements' untagged terminate — a Host org's own account (MOTIR-9584). */
  reapUntagged?: boolean;
}): AwsPolicyDocument {
  const runner = awsRunnerPolicyDocument(input);
  const arn = (resource: string) => `arn:aws:ec2:${input.regionId}:*:${resource}`;
  const own = { StringEquals: { [`aws:ResourceTag/${AWS_SHARD_TAG_KEY}`]: input.shardTag } };
  return {
    Version: '2012-10-17',
    Statement: [
      ...runner.Statement,
      {
        Sid: 'DescribeVolumes',
        Effect: 'Allow',
        Action: 'ec2:DescribeVolumes',
        Resource: '*',
      },
      {
        Sid: 'HibernateWakeAndConfigureOwn',
        Effect: 'Allow',
        Action: [
          'ec2:StopInstances',
          'ec2:StartInstances',
          'ec2:DescribeInstanceAttribute',
          'ec2:ModifyInstanceAttribute',
        ],
        Resource: arn('instance/*'),
        Condition: own,
      },
      {
        Sid: 'RestampOwn',
        Effect: 'Allow',
        Action: 'ec2:CreateTags',
        Resource: arn('instance/*'),
        Condition: own,
      },
      {
        // MOTIR-9470: the host agent's one inbound rule (TCP 8443, mutual TLS).
        Sid: 'OpenHostAgentPortOnOwnGroup',
        Effect: 'Allow',
        Action: 'ec2:AuthorizeSecurityGroupIngress',
        Resource: arn('security-group/*'),
        Condition: own,
      },
      {
        Sid: 'DeleteOwnDisk',
        Effect: 'Allow',
        Action: 'ec2:DeleteVolume',
        Resource: arn('volume/*'),
        Condition: own,
      },
    ],
  };
}
