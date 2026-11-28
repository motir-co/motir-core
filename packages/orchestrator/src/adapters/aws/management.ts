import {
  AcceptPrimaryEmailUpdateCommand,
  AccountClient,
  GetPrimaryEmailCommand,
  GetPrimaryEmailUpdateStatusCommand,
  StartPrimaryEmailUpdateCommand,
} from '@aws-sdk/client-account';
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
  AttachRolePolicyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateRoleCommand,
  DeletePolicyCommand,
  DeletePolicyVersionCommand,
  DeleteRolePolicyCommand,
  DetachRolePolicyCommand,
  GetPolicyVersionCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListAttachedRolePoliciesCommand,
  ListPoliciesCommand,
  ListPolicyVersionsCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type AttachedPolicy,
  type Policy,
  type PolicyVersion,
} from '@aws-sdk/client-iam';
import {
  CreateAccountCommand,
  CreateOrganizationalUnitCommand,
  DescribeAccountCommand,
  DescribeCreateAccountStatusCommand,
  ListAccountsCommand,
  ListCreateAccountStatusCommand,
  ListDelegatedServicesForAccountCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  ListTagsForResourceCommand,
  MoveAccountCommand,
  OrganizationsClient,
  RemoveAccountFromOrganizationCommand,
  TagResourceCommand,
  type Account,
  type CreateAccountStatus,
  type DelegatedService,
  type OrganizationalUnit,
  type Root,
  type Tag,
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
  stackInstanceNeedsReapply,
  stackInstanceOutcome,
  type AwsStackInstanceState,
  type AwsStackInstanceTarget,
} from './stackSet';
import { awsManagementOverride } from './testOverrides';

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
// The credential chain (MOTIR-9271 · MOTIR-10302): the SDK's default credential
// chain assumes the management role (`AWS_ORG_ADMIN_ROLE_ARN`), which may call
// Organizations and assume `OrganizationAccountAccessRole` in a member account;
// that member role reads Service Quotas, manages IAM and builds the network.
//
// API references, read 2026-10-24:
//   Organizations — https://docs.aws.amazon.com/organizations/latest/APIReference/API_ListAccounts.html,
//     API_ListCreateAccountStatus.html, API_CreateAccount.html, API_DescribeCreateAccountStatus.html
//   STS — https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
//   Service Quotas — https://docs.aws.amazon.com/servicequotas/2019-06-24/apireference/API_GetServiceQuota.html,
//     API_GetAWSDefaultServiceQuota.html, API_RequestServiceQuotaIncrease.html,
//     API_GetRequestedServiceQuotaChange.html, API_ListRequestedServiceQuotaChangeHistoryByQuota.html
//     (MOTIR-9459: the fleet's own quota raises)
//   IAM — https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetRole.html, API_CreateRole.html,
//     API_GetRolePolicy.html, API_PutRolePolicy.html
//   IAM, managed policies (MOTIR-11878) — API_ListPolicies.html, API_CreatePolicy.html,
//     API_GetPolicyVersion.html, API_ListPolicyVersions.html, API_CreatePolicyVersion.html,
//     API_DeletePolicyVersion.html, API_DeletePolicy.html, API_ListAttachedRolePolicies.html,
//     API_AttachRolePolicy.html, API_DetachRolePolicy.html, API_ListRolePolicies.html,
//     API_DeleteRolePolicy.html; the size and count limits —
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
//   Organizations, the unit (MOTIR-9844) — API_ListParents.html, API_MoveAccount.html
//   CloudFormation StackSets (MOTIR-9844) — see `./stackSet.ts`
//   The handover (MOTIR-12130), read 2026-11-23 —
//     Account Management — https://docs.aws.amazon.com/accounts/latest/reference/API_StartPrimaryEmailUpdate.html,
//     API_AcceptPrimaryEmailUpdate.html, API_GetPrimaryEmail.html,
//     API_GetPrimaryEmailUpdateStatus.html, API_GetContactInformation.html
//     Organizations — API_RemoveAccountFromOrganization.html, API_DescribeAccount.html,
//     API_ListDelegatedServicesForAccount.html, and the standalone requirements in
//     https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_remove.html
//
// WHAT A STANDALONE ACCOUNT NEEDS, AND WHAT THE MANAGEMENT ACCOUNT CAN SEE OF IT
// (MOTIR-12130, from the user guide above): a support plan, verified contact
// information (the phone number), a current payment method, at least FOUR days
// since the account was CREATED in the Organization (an invited account has no
// wait), and not being a delegated administrator for any service. From the
// management account only two are readable with the grants the handover holds:
// the wait (`DescribeAccount`'s JoinedTimestamp and JoinedMethod) and the
// delegated-administrator registrations (`ListDelegatedServicesForAccount`). No
// API reads a member account's payment method or support plan; the Account API's
// GetContactInformation reads the phone's VerificationStatus but needs a grant
// the management role does not hold. So `readStandaloneReadiness` reports those
// three `unknown`, and `removeAccountFromOrganization` — whose refusal names
// AWS's reason (`ConstraintViolationException`, e.g.
// MEMBER_ACCOUNT_PAYMENT_INSTRUMENT_REQUIRED, ACCOUNT_CANNOT_LEAVE_WITHOUT_PHONE_VERIFICATION,
// WAIT_PERIOD_ACTIVE, CANNOT_REMOVE_DELEGATED_ADMINISTRATOR_FROM_ORG) — is the
// authoritative answer.
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

/** The runner's IAM ROLE in every pool account, and its inline policy: the
 *  definition's stack builds it, the management role assumes it (MOTIR-9460),
 *  and it is the only credential runners boot with (MOTIR-9847). */
export const AWS_RUNNER_IAM_ROLE = 'motir-fleet-runner';
export const AWS_RUNNER_IAM_POLICY = 'motir-fleet-runner-ec2';

/** The role an enterprise tenant's deploys run as, in its own account, trusted
 *  only by the management role (MOTIR-9941). Its grants are customer-managed
 *  policies under `AWS_TENANT_DEPLOY_POLICY_PATH` (MOTIR-11878); the inline
 *  policy it carried before, named like the role, is deleted on convergence. */
export const AWS_TENANT_DEPLOY_ROLE = 'motir-tenant-deploy';

/** The IAM path every managed policy of the tenant deploy role sits under. A
 *  policy under it that the role no longer wants is detached and deleted. */
export const AWS_TENANT_DEPLOY_POLICY_PATH = '/motir-tenant-deploy/';

/** IAM's limit on one customer-managed policy document, whitespace excluded. */
export const AWS_MANAGED_POLICY_MAX_CHARS = 6_144;

/** IAM's default limit on the managed policies attached to one role. */
export const AWS_ROLE_MANAGED_POLICIES_MAX = 10;

/** IAM keeps at most five versions of a managed policy. */
const POLICY_VERSIONS_MAX = 5;

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
/** A deploy session in a tenant account: an hour, long enough for one deploy. */
const TENANT_DEPLOY_SESSION_SECONDS = 3600;
const TENANT_DEPLOY_SESSION_NAME = 'motir-tenant-deploy';
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
  /** When the account joined the organization, when AWS says: what tells a
   *  new account's EC2 activation from a real refusal (MOTIR-10204). */
  readonly joinedAt?: Date;
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

/** A set of managed policies IAM would refuse — one over its size limit, too
 *  many for one role, or two of one name — named before any call is made. */
export class AwsManagedPolicySetInvalidError extends Error {
  readonly code = 'AWS_MANAGED_POLICY_SET_INVALID';
  constructor(readonly problems: readonly string[]) {
    super(`the managed policy set is not one IAM accepts: ${problems.join('; ')}`);
    this.name = 'AwsManagedPolicySetInvalidError';
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
  | 'cloudformation'
  | 'account';

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
    case 'account':
      return new AccountClient(config);
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
  /** A deploy session in a tenant account (MOTIR-10004): `motir-tenant-deploy`,
   *  assumed from the management session, the only principal it trusts. */
  assumeTenantDeployRole(accountId: string): Promise<AwsSessionCredentials>;
  /** Put the account under `organizationalUnitId`; a no-op when it is there. */
  moveAccountToOrganizationalUnit(
    accountId: string,
    organizationalUnitId: string,
  ): Promise<{ moved: boolean }>;
  /** Make the account's stack instance exist with exactly these overrides, and
   *  wait for it to be CURRENT. An instance an earlier operation left OUTDATED
   *  (failed, cancelled) is applied again (MOTIR-10204). Answers what it sent,
   *  `none` on a resumed run that found it CURRENT or in flight. */
  ensureStackInstance(
    input: AwsStackInstanceTarget & {
      organizationalUnitId: string;
      parameterOverrides: Readonly<Record<string, string>>;
    },
  ): Promise<{ action: 'created' | 'updated' | 'none' }>;
  /** The instance's stack outputs, read in the member account. */
  readStackInstanceOutputs(target: AwsStackInstanceTarget): Promise<Record<string, string>>;
  /** The organizational unit `name` directly under the Organization root,
   *  created only when absent (MOTIR-9940). */
  ensureOrganizationalUnit(name: string): Promise<AwsOrganizationalUnitResult>;
  /** The tenant deploy role, trusting only the management role (MOTIR-9941),
   *  with exactly `policies` attached as customer-managed policies
   *  (MOTIR-11878): each created, or given a new default version when its
   *  document differs; any missing one attached; any other policy under the
   *  role's path detached and deleted; and the legacy inline policy deleted.
   *  `created` when the role was made by this call, `policyChanged` when any of
   *  that wrote something. Refuses, before any call, a set IAM would refuse. */
  ensureTenantDeployRole(
    credentials: AwsSessionCredentials,
    policies: readonly AwsManagedPolicy[],
  ): Promise<{ created: boolean; policyChanged: boolean }>;
  /** `key=value` on the account in Organizations, written only when it differs. */
  ensureAccountTag(accountId: string, key: string, value: string): Promise<{ tagged: boolean }>;
  /** A quota at `target.desiredValue` or above: nothing filed when its APPLIED
   *  value already is, or when a raise of it is open (`pending`); else a raise is
   *  filed. A quota with no applied value is not at target, whatever the AWS
   *  default says (MOTIR-12011). */
  ensureQuotaRaise(
    credentials: AwsSessionCredentials,
    regionId: string,
    target: AwsQuotaTarget,
  ): Promise<{ filed: boolean; pending: boolean }>;
  /** A quota's APPLIED value in the account and its newest open raise, read only
   *  (MOTIR-12014). `applied` is null when AWS has no applied value for the
   *  account (`NoSuchResourceException`) — never the AWS default, which is not
   *  what the account runs at. Any other failure throws. */
  readQuotaStatus(
    credentials: AwsSessionCredentials,
    regionId: string,
    quota: AwsQuotaRef,
  ): Promise<AwsQuotaStatus>;
  /** Ask AWS to move the member account's primary email to `email`; AWS sends a
   *  one-time code to that address (MOTIR-12130). Answers AWS's status. The
   *  address goes only to AWS: it is in no log line and no error. */
  startPrimaryEmailUpdate(
    accountId: string,
    email: string,
  ): Promise<{ status: AwsPrimaryEmailUpdateStatus }>;
  /** Accept the update with the one-time code. A wrong or expired code is a
   *  typed refusal (`code_refused`, AWS's code only), never a throw. */
  acceptPrimaryEmailUpdate(
    accountId: string,
    email: string,
    code: string,
  ): Promise<AwsPrimaryEmailAcceptResult>;
  /** The account's primary email as AWS holds it now. */
  getPrimaryEmail(accountId: string): Promise<string>;
  /** The latest primary-email update's status, or null when none was started —
   *  how a resumed step sees an update already under way. */
  getPrimaryEmailUpdateStatus(accountId: string): Promise<AwsPrimaryEmailUpdateState | null>;
  /** Which of AWS's standalone requirements the management account can see as
   *  met (see the header): the wait and delegated administration are read, the
   *  rest are `unknown`. */
  readStandaloneReadiness(accountId: string): Promise<AwsStandaloneReadiness>;
  /** Remove the account from the Organization. A refusal for an unmet
   *  requirement answers `not_ready` with AWS's reason and never throws; an
   *  account already outside the Organization answers `removed`. */
  removeAccountFromOrganization(accountId: string): Promise<AwsAccountRemovalResult>;
}

/** AWS's status of a primary-email update. */
export type AwsPrimaryEmailUpdateStatus = 'PENDING' | 'ACCEPTED' | 'COMPLETED' | 'FAILED';

export const AWS_PRIMARY_EMAIL_UPDATE_STATUSES: readonly AwsPrimaryEmailUpdateStatus[] = [
  'PENDING',
  'ACCEPTED',
  'COMPLETED',
  'FAILED',
];

/** The latest primary-email update, as `getPrimaryEmailUpdateStatus` reads it. */
export interface AwsPrimaryEmailUpdateState {
  readonly status: AwsPrimaryEmailUpdateStatus;
  readonly updatedAt: Date | null;
}

/** What accepting the one-time code did. */
export type AwsPrimaryEmailAcceptResult =
  | { readonly outcome: 'accepted'; readonly status: AwsPrimaryEmailUpdateStatus }
  | { readonly outcome: 'code_refused'; readonly reason: string };

/** The Account API's answers to a wrong, expired or unmatched code: the
 *  update's input was refused, there is no update to accept, or it moved on. */
const PRIMARY_EMAIL_CODE_REFUSALS = [
  'ValidationException',
  'ResourceNotFoundException',
  'ConflictException',
];

/** One standalone requirement, as far as the management account can see it. */
export type AwsReadinessStatus = 'met' | 'not_met' | 'unknown';

/** AWS's wait before a CREATED account may leave its Organization. */
export const AWS_STANDALONE_WAIT_MS = 4 * 24 * 60 * 60_000;

export interface AwsStandaloneReadiness {
  /** False when the account is already outside the Organization. */
  readonly inOrganization: boolean;
  readonly waitPeriod: { readonly status: AwsReadinessStatus; readonly eligibleAt: Date | null };
  readonly delegatedAdministrator: {
    readonly status: AwsReadinessStatus;
    /** The service principals the account is a delegated administrator for. */
    readonly services: readonly string[];
  };
  /** Never readable from the management account (see the header). */
  readonly paymentMethod: 'unknown';
  readonly supportPlan: 'unknown';
  readonly contactInformation: 'unknown';
  /** `false` when a readable requirement is not met; `null` otherwise, because
   *  three are never readable and only the removal itself can say. */
  readonly ready: false | null;
}

/** What `removeAccountFromOrganization` did. */
export type AwsAccountRemovalResult =
  | { readonly outcome: 'removed' }
  | { readonly outcome: 'not_ready'; readonly missing: readonly string[] };

/** One Service Quotas quota, by service and code. */
export interface AwsQuotaRef {
  serviceCode: string;
  quotaCode: string;
}

/** An open (`PENDING` or `CASE_OPENED`) raise of a quota, with when it was filed. */
export interface AwsOpenQuotaRaise extends AwsQuotaIncreaseRequest {
  createdAt: Date | null;
}

/** What `readQuotaStatus` read. */
export interface AwsQuotaStatus {
  applied: number | null;
  openRaise: AwsOpenQuotaRaise | null;
}

/** One Service Quotas quota and the value wanted for it. */
export interface AwsQuotaTarget {
  serviceCode: string;
  quotaCode: string;
  desiredValue: number;
}

/** What `ensureOrganizationalUnit` found or made. */
export interface AwsOrganizationalUnitResult {
  ouId: string;
  created: boolean;
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
    ...(account.JoinedTimestamp ? { joinedAt: account.JoinedTimestamp } : {}),
  };
}

/** AWS's primary-email status, or the typed error for one it has not documented. */
function primaryEmailStatusOf(status: string | undefined): AwsPrimaryEmailUpdateStatus {
  const known = AWS_PRIMARY_EMAIL_UPDATE_STATUSES.find((s) => s === status);
  if (!known) throw new AwsManagementApiError('account', `UnknownStatus:${status ?? ''}`, null);
  return known;
}

/** The two `RequestStatus` values a request is still open in. */
const OPEN_QUOTA_REQUEST_STATUSES = ['PENDING', 'CASE_OPENED'] as const;

interface RequestedQuotaShape {
  Id?: string;
  Status?: string;
  DesiredValue?: number;
  Created?: Date;
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
  // An E2E lane's fake, when one is installed (MOTIR-12141) — see `testOverrides.ts`.
  const override = awsManagementOverride();
  if (override) return override(management);
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
    // An STS client with no `credentials`, so the SDK's default chain supplies
    // them (MOTIR-10302: there is no management key).
    const sts = factory('sts', { region: GLOBAL_REGION });
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
      DurationSeconds:
        roleName === AWS_RUNNER_IAM_ROLE
          ? RUNNER_SESSION_SECONDS
          : roleName === AWS_TENANT_DEPLOY_ROLE
            ? TENANT_DEPLOY_SESSION_SECONDS
            : SESSION_SECONDS,
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

  /** The Account Management API on the management session (MOTIR-12130): it
   *  acts on a member account by `AccountId`, under trusted access. */
  async function accountApi(): Promise<AwsSdkClient> {
    return client('account', await managementRole());
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
          // The account joined when its creation completed; a request AWS
          // answers without the time completed just now.
          joinedAt: status?.CompletedTimestamp ?? new Date(now()),
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
        lastOperationId: instance.LastOperationId ?? null,
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

  async function organizationRootId(orgs: AwsSdkClient): Promise<string> {
    const { Roots: roots } = await call<{ Roots?: Root[] }>(
      'organizations',
      orgs,
      new ListRootsCommand({}),
    );
    return required(roots?.[0]?.Id, 'Roots[0].Id');
  }

  async function findOrganizationalUnit(
    orgs: AwsSdkClient,
    parentId: string,
    name: string,
  ): Promise<string | null> {
    let nextToken: string | undefined;
    do {
      const page = await call<{ OrganizationalUnits?: OrganizationalUnit[]; NextToken?: string }>(
        'organizations',
        orgs,
        new ListOrganizationalUnitsForParentCommand({
          ParentId: parentId,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      const match = (page.OrganizationalUnits ?? []).find((ou) => ou.Name === name);
      if (match) return required(match.Id, 'OrganizationalUnit.Id');
      nextToken = page.NextToken ?? undefined;
    } while (nextToken);
    return null;
  }

  /** An IAM role trusting the management role, read before it is created;
   *  `created` when this call made it. */
  async function ensureRole(
    iam: AwsSdkClient,
    role: { roleName: string; maxSessionSeconds: number; tag: string },
  ): Promise<boolean> {
    try {
      await call('iam', iam, new GetRoleCommand({ RoleName: role.roleName }));
      return false;
    } catch (err) {
      if (!iamAbsent(err)) throw err;
    }
    try {
      await call(
        'iam',
        iam,
        new CreateRoleCommand({
          RoleName: role.roleName,
          AssumeRolePolicyDocument: JSON.stringify(awsRunnerTrustPolicy(management.roleArn)),
          MaxSessionDuration: role.maxSessionSeconds,
          Tags: [{ Key: 'motir-role', Value: role.tag }],
        }),
      );
      return true;
    } catch (createErr) {
      // A concurrent pass made it between the read and the create.
      if (!iamAlreadyExists(createErr)) throw createErr;
      return false;
    }
  }

  /** An IAM role trusting the management role, with one inline policy that
   *  converges on `policyDocument`. Each half reads before it writes. */
  async function ensureRoleWithPolicy(
    credentials: AwsSessionCredentials,
    role: {
      roleName: string;
      policyName: string;
      policyDocument: AwsPolicyDocument;
      maxSessionSeconds: number;
      tag: string;
    },
  ): Promise<{ roleCreated: boolean; policyPut: boolean }> {
    const iam = client('iam', credentials);
    const roleCreated = await ensureRole(iam, role);
    const wanted = JSON.stringify(role.policyDocument);
    let current: string | null = null;
    try {
      const answer = await call<{ PolicyDocument?: string }>(
        'iam',
        iam,
        new GetRolePolicyCommand({ RoleName: role.roleName, PolicyName: role.policyName }),
      );
      current = answer.PolicyDocument ? decodeURIComponent(answer.PolicyDocument) : null;
    } catch (err) {
      if (!iamAbsent(err)) throw err;
    }
    if (current !== null && samePolicy(current, wanted)) return { roleCreated, policyPut: false };
    await call(
      'iam',
      iam,
      new PutRolePolicyCommand({
        RoleName: role.roleName,
        PolicyName: role.policyName,
        PolicyDocument: wanted,
      }),
    );
    return { roleCreated, policyPut: true };
  }

  /** Every customer-managed policy under `path`, by name. */
  async function localPoliciesUnder(
    iam: AwsSdkClient,
    path: string,
  ): Promise<Map<string, { arn: string; defaultVersionId: string }>> {
    const found = new Map<string, { arn: string; defaultVersionId: string }>();
    let marker: string | undefined;
    do {
      const page = await call<{ Policies?: Policy[]; IsTruncated?: boolean; Marker?: string }>(
        'iam',
        iam,
        new ListPoliciesCommand({
          Scope: 'Local',
          PathPrefix: path,
          ...(marker ? { Marker: marker } : {}),
        }),
      );
      for (const policy of page.Policies ?? []) {
        found.set(required(policy.PolicyName, 'Policy.PolicyName'), {
          arn: required(policy.Arn, 'Policy.Arn'),
          defaultVersionId: required(policy.DefaultVersionId, 'Policy.DefaultVersionId'),
        });
      }
      marker = page.IsTruncated ? (page.Marker ?? undefined) : undefined;
    } while (marker);
    return found;
  }

  /** The ARNs of the managed policies under `path` attached to the role. */
  async function attachedUnder(
    iam: AwsSdkClient,
    roleName: string,
    path: string,
  ): Promise<Set<string>> {
    const attached = new Set<string>();
    let marker: string | undefined;
    do {
      const page = await call<{
        AttachedPolicies?: AttachedPolicy[];
        IsTruncated?: boolean;
        Marker?: string;
      }>(
        'iam',
        iam,
        new ListAttachedRolePoliciesCommand({
          RoleName: roleName,
          PathPrefix: path,
          ...(marker ? { Marker: marker } : {}),
        }),
      );
      for (const policy of page.AttachedPolicies ?? []) {
        attached.add(required(policy.PolicyArn, 'AttachedPolicy.PolicyArn'));
      }
      marker = page.IsTruncated ? (page.Marker ?? undefined) : undefined;
    } while (marker);
    return attached;
  }

  /** A managed policy's versions. IAM keeps at most five and lists them in
   *  one page at that size; the marker is followed regardless. */
  async function policyVersions(iam: AwsSdkClient, arn: string): Promise<PolicyVersion[]> {
    const versions: PolicyVersion[] = [];
    let marker: string | undefined;
    do {
      const page = await call<{
        Versions?: PolicyVersion[];
        IsTruncated?: boolean;
        Marker?: string;
      }>(
        'iam',
        iam,
        new ListPolicyVersionsCommand({ PolicyArn: arn, ...(marker ? { Marker: marker } : {}) }),
      );
      versions.push(...(page.Versions ?? []));
      marker = page.IsTruncated ? (page.Marker ?? undefined) : undefined;
    } while (marker);
    return versions;
  }

  /** Make `document` the policy's default version, when it is not already:
   *  the oldest non-default version is deleted first when IAM's five are
   *  taken. Answers whether it wrote. */
  async function convergePolicyVersion(
    iam: AwsSdkClient,
    found: { arn: string; defaultVersionId: string },
    document: string,
  ): Promise<boolean> {
    const answer = await call<{ PolicyVersion?: PolicyVersion }>(
      'iam',
      iam,
      new GetPolicyVersionCommand({ PolicyArn: found.arn, VersionId: found.defaultVersionId }),
    );
    const current = answer.PolicyVersion?.Document;
    if (current && samePolicy(decodeURIComponent(current), document)) return false;
    const versions = await policyVersions(iam, found.arn);
    if (versions.length >= POLICY_VERSIONS_MAX) {
      const oldest = versions
        .filter((v) => !v.IsDefaultVersion)
        .sort((a, b) => (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0))[0];
      if (oldest) {
        await call(
          'iam',
          iam,
          new DeletePolicyVersionCommand({
            PolicyArn: found.arn,
            VersionId: required(oldest.VersionId, 'PolicyVersion.VersionId'),
          }),
        );
      }
    }
    await call(
      'iam',
      iam,
      new CreatePolicyVersionCommand({
        PolicyArn: found.arn,
        PolicyDocument: document,
        SetAsDefault: true,
      }),
    );
    return true;
  }

  /** Delete a managed policy no role should hold any more: its non-default
   *  versions first, as IAM requires. */
  async function deleteManagedPolicy(iam: AwsSdkClient, arn: string): Promise<void> {
    for (const version of await policyVersions(iam, arn)) {
      if (version.IsDefaultVersion) continue;
      await call(
        'iam',
        iam,
        new DeletePolicyVersionCommand({
          PolicyArn: arn,
          VersionId: required(version.VersionId, 'PolicyVersion.VersionId'),
        }),
      );
    }
    try {
      await call('iam', iam, new DeletePolicyCommand({ PolicyArn: arn }));
    } catch (err) {
      // A concurrent pass deleted it first.
      if (!iamAbsent(err)) throw err;
    }
  }

  /**
   * An IAM role trusting the management role whose grants are exactly
   * `policies`, as customer-managed policies under `policyPath` (MOTIR-11878).
   * Every step reads before it writes, and the order leaves no gap in what the
   * role may do: each wanted policy is converged and attached BEFORE anything
   * is taken away — a stale policy under the path detached and deleted, then
   * the legacy inline policy deleted. A replay writes nothing.
   */
  async function ensureRoleWithManagedPolicies(
    credentials: AwsSessionCredentials,
    role: {
      roleName: string;
      policyPath: string;
      policies: readonly AwsManagedPolicy[];
      legacyInlinePolicyName: string;
      maxSessionSeconds: number;
      tag: string;
    },
  ): Promise<{ roleCreated: boolean; changed: boolean }> {
    const problems = managedPolicySetProblems(role.policies);
    if (problems.length > 0) throw new AwsManagedPolicySetInvalidError(problems);
    const iam = client('iam', credentials);
    const roleCreated = await ensureRole(iam, role);
    let changed = false;

    let existing = await localPoliciesUnder(iam, role.policyPath);
    const wantedArns = new Set<string>();
    for (const policy of role.policies) {
      const document = JSON.stringify(policy.document);
      let found = existing.get(policy.name);
      if (!found) {
        try {
          const created = await call<{ Policy?: Policy }>(
            'iam',
            iam,
            new CreatePolicyCommand({
              PolicyName: policy.name,
              Path: role.policyPath,
              PolicyDocument: document,
              Description: policy.description,
              Tags: [{ Key: 'motir-role', Value: role.tag }],
            }),
          );
          wantedArns.add(required(created.Policy?.Arn, 'Policy.Arn'));
          changed = true;
          continue;
        } catch (err) {
          // A concurrent pass created it between the list and the create:
          // converge the one it made.
          if (!iamAlreadyExists(err)) throw err;
          existing = await localPoliciesUnder(iam, role.policyPath);
          found = existing.get(policy.name);
          if (!found) throw err;
        }
      }
      wantedArns.add(found.arn);
      if (await convergePolicyVersion(iam, found, document)) changed = true;
    }

    const attached = await attachedUnder(iam, role.roleName, role.policyPath);
    for (const arn of wantedArns) {
      if (attached.has(arn)) continue;
      await call(
        'iam',
        iam,
        new AttachRolePolicyCommand({ RoleName: role.roleName, PolicyArn: arn }),
      );
      changed = true;
    }

    const wantedNames = new Set(role.policies.map((p) => p.name));
    for (const [name, stale] of existing) {
      if (wantedNames.has(name)) continue;
      if (attached.has(stale.arn)) {
        await call(
          'iam',
          iam,
          new DetachRolePolicyCommand({ RoleName: role.roleName, PolicyArn: stale.arn }),
        );
      }
      await deleteManagedPolicy(iam, stale.arn);
      changed = true;
    }

    const inline = await inlinePolicyNames(iam, role.roleName);
    if (inline.includes(role.legacyInlinePolicyName)) {
      try {
        await call(
          'iam',
          iam,
          new DeleteRolePolicyCommand({
            RoleName: role.roleName,
            PolicyName: role.legacyInlinePolicyName,
          }),
        );
        changed = true;
      } catch (err) {
        // A concurrent pass deleted it first.
        if (!iamAbsent(err)) throw err;
      }
    }
    return { roleCreated, changed };
  }

  /** The names of the role's inline policies. */
  async function inlinePolicyNames(iam: AwsSdkClient, roleName: string): Promise<string[]> {
    const names: string[] = [];
    let marker: string | undefined;
    do {
      const page = await call<{ PolicyNames?: string[]; IsTruncated?: boolean; Marker?: string }>(
        'iam',
        iam,
        new ListRolePoliciesCommand({ RoleName: roleName, ...(marker ? { Marker: marker } : {}) }),
      );
      names.push(...(page.PolicyNames ?? []));
      marker = page.IsTruncated ? (page.Marker ?? undefined) : undefined;
    } while (marker);
    return names;
  }

  /** A quota's APPLIED value in the account, or null when Service Quotas holds
   *  none for it (`NoSuchResourceException`): an account whose quota was never
   *  changed may have no applied value yet. */
  async function appliedQuotaValue(
    quotas: AwsSdkClient,
    serviceCode: string,
    quotaCode: string,
  ): Promise<number | null> {
    try {
      const answer = await call<{ Quota?: { Value?: number } }>(
        'service-quotas',
        quotas,
        new GetServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }),
      );
      return Math.floor(required(answer.Quota?.Value, 'Quota.Value'));
    } catch (err) {
      if (!(err instanceof AwsManagementApiError) || err.awsCode !== 'NoSuchResourceException') {
        throw err;
      }
      return null;
    }
  }

  /** A quota's applied value, the AWS default standing in when the account has
   *  none — the pool's vCPU reading (`readVcpuQuota`). Never the tenant raise's
   *  at-target test: the default is AWS's general value, not the account's
   *  (MOTIR-12011: Lambda's default is 1000 where a new account is held at 10). */
  async function appliedQuota(
    quotas: AwsSdkClient,
    serviceCode: string,
    quotaCode: string,
  ): Promise<number> {
    const applied = await appliedQuotaValue(quotas, serviceCode, quotaCode);
    if (applied !== null) return applied;
    const answer = await call<{ Quota?: { Value?: number } }>(
      'service-quotas',
      quotas,
      new GetAWSDefaultServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }),
    );
    return Math.floor(required(answer.Quota?.Value, 'Quota.Value'));
  }

  async function openQuotaRequest(
    quotas: AwsSdkClient,
    serviceCode: string,
    quotaCode: string,
  ): Promise<AwsQuotaIncreaseRequest | null> {
    for (const status of OPEN_QUOTA_REQUEST_STATUSES) {
      const answer = await call<{ RequestedQuotas?: RequestedQuotaShape[] }>(
        'service-quotas',
        quotas,
        new ListRequestedServiceQuotaChangeHistoryByQuotaCommand({
          ServiceCode: serviceCode,
          QuotaCode: quotaCode,
          Status: status,
        }),
      );
      const open = answer.RequestedQuotas?.[0];
      if (open) return quotaRequestOf(open);
    }
    return null;
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

    async startPrimaryEmailUpdate(accountId, email) {
      const { Status } = await call<{ Status?: string }>(
        'account',
        await accountApi(),
        new StartPrimaryEmailUpdateCommand({ AccountId: accountId, PrimaryEmail: email }),
      );
      return { status: primaryEmailStatusOf(Status) };
    },

    async acceptPrimaryEmailUpdate(accountId, email, code) {
      try {
        const { Status } = await call<{ Status?: string }>(
          'account',
          await accountApi(),
          new AcceptPrimaryEmailUpdateCommand({
            AccountId: accountId,
            PrimaryEmail: email,
            Otp: code,
          }),
        );
        return { outcome: 'accepted', status: primaryEmailStatusOf(Status) };
      } catch (err) {
        if (
          err instanceof AwsManagementApiError &&
          PRIMARY_EMAIL_CODE_REFUSALS.includes(err.awsCode)
        ) {
          return { outcome: 'code_refused', reason: err.awsCode };
        }
        throw err;
      }
    },

    async getPrimaryEmail(accountId) {
      const { PrimaryEmail } = await call<{ PrimaryEmail?: string }>(
        'account',
        await accountApi(),
        new GetPrimaryEmailCommand({ AccountId: accountId }),
      );
      return required(PrimaryEmail, 'PrimaryEmail');
    },

    async getPrimaryEmailUpdateStatus(accountId) {
      try {
        const { Status, UpdatedAt } = await call<{ Status?: string; UpdatedAt?: Date }>(
          'account',
          await accountApi(),
          new GetPrimaryEmailUpdateStatusCommand({ AccountId: accountId }),
        );
        return {
          status: primaryEmailStatusOf(Status),
          updatedAt: UpdatedAt instanceof Date ? UpdatedAt : null,
        };
      } catch (err) {
        if (err instanceof AwsManagementApiError && err.awsCode === 'ResourceNotFoundException') {
          return null;
        }
        throw err;
      }
    },

    async readStandaloneReadiness(accountId) {
      const orgs = await organizations();
      let account: Account | undefined;
      try {
        ({ Account: account } = await call<{ Account?: Account }>(
          'organizations',
          orgs,
          new DescribeAccountCommand({ AccountId: accountId }),
        ));
      } catch (err) {
        if (!(err instanceof AwsManagementApiError) || err.awsCode !== 'AccountNotFoundException') {
          throw err;
        }
      }
      if (!account) {
        return {
          inOrganization: false,
          waitPeriod: { status: 'unknown', eligibleAt: null },
          delegatedAdministrator: { status: 'unknown', services: [] },
          paymentMethod: 'unknown',
          supportPlan: 'unknown',
          contactInformation: 'unknown',
          ready: null,
        };
      }
      // An invited account has no wait; a created one waits four days from when
      // it joined (its creation). With no time from AWS the wait is unknown.
      let waitPeriod: AwsStandaloneReadiness['waitPeriod'];
      if (account.JoinedMethod === 'INVITED') {
        waitPeriod = { status: 'met', eligibleAt: null };
      } else if (account.JoinedTimestamp instanceof Date) {
        const eligibleAt = new Date(account.JoinedTimestamp.getTime() + AWS_STANDALONE_WAIT_MS);
        waitPeriod = { status: now() >= eligibleAt.getTime() ? 'met' : 'not_met', eligibleAt };
      } else {
        waitPeriod = { status: 'unknown', eligibleAt: null };
      }
      const services: string[] = [];
      try {
        let nextToken: string | undefined;
        do {
          const page = await call<{ DelegatedServices?: DelegatedService[]; NextToken?: string }>(
            'organizations',
            orgs,
            new ListDelegatedServicesForAccountCommand({
              AccountId: accountId,
              ...(nextToken ? { NextToken: nextToken } : {}),
            }),
          );
          for (const service of page.DelegatedServices ?? []) {
            if (service.ServicePrincipal) services.push(service.ServicePrincipal);
          }
          nextToken = page.NextToken ?? undefined;
        } while (nextToken);
      } catch (err) {
        // AWS's answer for an account registered as no service's delegate.
        if (
          !(err instanceof AwsManagementApiError) ||
          err.awsCode !== 'AccountNotRegisteredException'
        ) {
          throw err;
        }
      }
      const delegatedAdministrator = {
        status: (services.length > 0 ? 'not_met' : 'met') as AwsReadinessStatus,
        services,
      };
      const blocked =
        waitPeriod.status === 'not_met' || delegatedAdministrator.status === 'not_met';
      return {
        inOrganization: true,
        waitPeriod,
        delegatedAdministrator,
        paymentMethod: 'unknown',
        supportPlan: 'unknown',
        contactInformation: 'unknown',
        ready: blocked ? false : null,
      };
    },

    async removeAccountFromOrganization(accountId) {
      const orgs = await organizations();
      try {
        await orgs.send(new RemoveAccountFromOrganizationCommand({ AccountId: accountId }));
        return { outcome: 'removed' };
      } catch (err) {
        const code = errorCode(err);
        // The account is no longer the Organization's: a replayed removal.
        if (code === 'AccountNotFoundException') return { outcome: 'removed' };
        if (code === 'ConstraintViolationException') {
          const reason = (err as { Reason?: unknown }).Reason;
          return {
            outcome: 'not_ready',
            missing: [typeof reason === 'string' && reason ? reason : code],
          };
        }
        throw toApiError('organizations', err);
      }
    },

    async assumeMemberRole(accountId) {
      return assumeInMember(accountId, AWS_MEMBER_ROLE_NAME, SESSION_NAME);
    },

    async assumeRunnerRole(accountId) {
      return assumeInMember(accountId, AWS_RUNNER_IAM_ROLE, RUNNER_SESSION_NAME);
    },

    async assumeTenantDeployRole(accountId) {
      return assumeInMember(accountId, AWS_TENANT_DEPLOY_ROLE, TENANT_DEPLOY_SESSION_NAME);
    },

    async ensureRunnerRole(credentials, policyDocument) {
      const { roleCreated, policyPut } = await ensureRoleWithPolicy(credentials, {
        roleName: AWS_RUNNER_IAM_ROLE,
        policyName: AWS_RUNNER_IAM_POLICY,
        policyDocument,
        maxSessionSeconds: RUNNER_SESSION_SECONDS,
        tag: 'fleet-runner',
      });
      return {
        created: [
          ...(roleCreated ? [`iam-role:${AWS_RUNNER_IAM_ROLE}`] : []),
          ...(policyPut ? [`iam-role-policy:${AWS_RUNNER_IAM_POLICY}`] : []),
        ],
      };
    },

    async readVcpuQuota(credentials, regionId) {
      return appliedQuota(
        client('service-quotas', credentials, regionId),
        'ec2',
        AWS_EC2_VCPU_QUOTA_CODE,
      );
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
      return openQuotaRequest(
        client('service-quotas', credentials, regionId),
        'ec2',
        quotaCode ?? AWS_EC2_VCPU_QUOTA_CODE,
      );
    },

    async ensureOrganizationalUnit(name) {
      const orgs = await organizations();
      const rootId = await organizationRootId(orgs);
      const found = await findOrganizationalUnit(orgs, rootId, name);
      if (found) return { ouId: found, created: false };
      try {
        const { OrganizationalUnit: ou } = await call<{ OrganizationalUnit?: OrganizationalUnit }>(
          'organizations',
          orgs,
          new CreateOrganizationalUnitCommand({ ParentId: rootId, Name: name }),
        );
        return { ouId: required(ou?.Id, 'OrganizationalUnit.Id'), created: true };
      } catch (err) {
        // A concurrent pass created it between the list and the create: answer
        // that one, never a second OU.
        if (
          !(err instanceof AwsManagementApiError) ||
          err.awsCode !== 'DuplicateOrganizationalUnitException'
        ) {
          throw err;
        }
        const raced = await findOrganizationalUnit(orgs, rootId, name);
        if (!raced) throw err;
        return { ouId: raced, created: false };
      }
    },

    async ensureTenantDeployRole(credentials, policies) {
      const { roleCreated, changed } = await ensureRoleWithManagedPolicies(credentials, {
        roleName: AWS_TENANT_DEPLOY_ROLE,
        policyPath: AWS_TENANT_DEPLOY_POLICY_PATH,
        policies,
        legacyInlinePolicyName: AWS_TENANT_DEPLOY_ROLE,
        maxSessionSeconds: TENANT_DEPLOY_SESSION_SECONDS,
        tag: 'tenant-deploy',
      });
      return { created: roleCreated, policyChanged: changed };
    },

    async ensureAccountTag(accountId, key, value) {
      const orgs = await organizations();
      let nextToken: string | undefined;
      do {
        const page = await call<{ Tags?: Tag[]; NextToken?: string }>(
          'organizations',
          orgs,
          new ListTagsForResourceCommand({
            ResourceId: accountId,
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        );
        if ((page.Tags ?? []).some((t) => t.Key === key && t.Value === value)) {
          return { tagged: false };
        }
        nextToken = page.NextToken ?? undefined;
      } while (nextToken);
      await call(
        'organizations',
        orgs,
        new TagResourceCommand({ ResourceId: accountId, Tags: [{ Key: key, Value: value }] }),
      );
      return { tagged: true };
    },

    async ensureQuotaRaise(credentials, regionId, target) {
      const quotas = client('service-quotas', credentials, regionId);
      const { serviceCode, quotaCode, desiredValue } = target;
      // At target only on the account's OWN applied value. With none recorded the
      // AWS default is no evidence — a new account can be held far below it — so
      // the raise is filed (MOTIR-12011).
      const applied = await appliedQuotaValue(quotas, serviceCode, quotaCode);
      if (applied !== null && applied >= desiredValue) {
        return { filed: false, pending: false };
      }
      if (await openQuotaRequest(quotas, serviceCode, quotaCode)) {
        return { filed: false, pending: true };
      }
      try {
        await call(
          'service-quotas',
          quotas,
          new RequestServiceQuotaIncreaseCommand({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
            DesiredValue: desiredValue,
          }),
        );
      } catch (err) {
        // A raise filed between the read and the request: it is the open one.
        if (
          !(err instanceof AwsManagementApiError) ||
          err.awsCode !== 'ResourceAlreadyExistsException'
        ) {
          throw err;
        }
        return { filed: false, pending: true };
      }
      return { filed: true, pending: true };
    },

    async readQuotaStatus(credentials, regionId, quota) {
      const quotas = client('service-quotas', credentials, regionId);
      const { serviceCode, quotaCode } = quota;
      let applied: number | null = null;
      try {
        const answer = await call<{ Quota?: { Value?: number } }>(
          'service-quotas',
          quotas,
          new GetServiceQuotaCommand({ ServiceCode: serviceCode, QuotaCode: quotaCode }),
        );
        applied = Math.floor(required(answer.Quota?.Value, 'Quota.Value'));
      } catch (err) {
        if (!(err instanceof AwsManagementApiError) || err.awsCode !== 'NoSuchResourceException') {
          throw err;
        }
      }
      // The NEWEST open raise across both open statuses: a quota has at most one
      // in practice, and the newest is the one that says what happens next.
      let openRaise: AwsOpenQuotaRaise | null = null;
      for (const status of OPEN_QUOTA_REQUEST_STATUSES) {
        const answer = await call<{ RequestedQuotas?: RequestedQuotaShape[] }>(
          'service-quotas',
          quotas,
          new ListRequestedServiceQuotaChangeHistoryByQuotaCommand({
            ServiceCode: serviceCode,
            QuotaCode: quotaCode,
            Status: status,
          }),
        );
        for (const requested of answer.RequestedQuotas ?? []) {
          const createdAt = requested.Created instanceof Date ? requested.Created : null;
          const newer =
            openRaise === null ||
            (createdAt !== null &&
              (openRaise.createdAt === null || createdAt > openRaise.createdAt));
          if (newer) openRaise = { ...quotaRequestOf(requested), createdAt };
        }
      }
      return { applied, openRaise };
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

      // Reach a CURRENT instance with the wanted overrides, or an operation of
      // ours making one. Every state is read from AWS, so a re-run picks up where
      // a run stopped — including after a failure: an instance whose last
      // operation failed or was cancelled is OUTDATED, often with the wanted
      // overrides, and only a new update moves it (MOTIR-10204). That update's id
      // follows the failed operation, so it is never the spent one again. An
      // instance someone else's operation is still working on is waited on here,
      // and applied again if that operation leaves it failed.
      let action: 'created' | 'updated';
      let operationId: string;
      for (;;) {
        const instance = await describeStackInstance(cfn, target);
        const reapply = instance !== null && stackInstanceNeedsReapply(instance);
        if (
          instance &&
          !reapply &&
          sameParameterOverrides(instance.parameterOverrides, parameterOverrides)
        ) {
          // Throws on a state no update repairs (INOPERABLE, a suspended account).
          if (stackInstanceOutcome(target, instance) === 'current') return { action: 'none' };
          if (now() >= deadline) throw stackInstanceDeadline(target, instance.status);
          await sleep(STACK_INSTANCE_POLL_MS);
          continue;
        }
        const create = instance === null;
        const id = create
          ? awsStackSetOperationId('create', target, parameterOverrides)
          : awsStackSetOperationId(
              'update',
              target,
              parameterOverrides,
              // A failed instance AWS names no last operation for still needs an
              // id its failed operation did not have.
              instance.lastOperationId ?? (reapply ? `at-${now()}` : null),
            );
        const deploymentTargets = {
          OrganizationalUnitIds: [organizationalUnitId],
          Accounts: [target.accountId],
          AccountFilterType: 'INTERSECTION' as const,
        };
        const filed = await fileStackSetOperation(
          cfn,
          create
            ? new CreateStackInstancesCommand({
                ...common,
                DeploymentTargets: deploymentTargets,
                OperationId: id,
              })
            : new UpdateStackInstancesCommand({
                ...common,
                DeploymentTargets: deploymentTargets,
                OperationId: id,
              }),
        );
        if (filed) {
          operationId = filed;
          action = create ? 'created' : 'updated';
          break;
        }
        // Another operation got there first: wait it out, then read again.
        if (now() >= deadline) throw stackInstanceDeadline(target, instance?.status ?? 'absent');
        await sleep(STACK_INSTANCE_POLL_MS);
      }

      // Our operation, to its end: until it finishes the instance may still read
      // CURRENT with the old overrides. Its failure is the one that throws.
      for (;;) {
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

function iamAlreadyExists(err: unknown): boolean {
  return err instanceof AwsManagementApiError && err.awsCode === 'EntityAlreadyExists';
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

/** A customer-managed policy a role should carry (MOTIR-11878). */
export interface AwsManagedPolicy {
  /** The policy's name, unique in the account. */
  name: string;
  /** What it is for, stored on the policy at creation. */
  description: string;
  document: AwsPolicyDocument;
}

/** Why IAM would refuse `policies` as one role's managed set: a document over
 *  `AWS_MANAGED_POLICY_MAX_CHARS` (measured as sent, with no whitespace), more
 *  than `AWS_ROLE_MANAGED_POLICIES_MAX` policies, or a name used twice. Empty
 *  when it would accept them. */
export function managedPolicySetProblems(policies: readonly AwsManagedPolicy[]): string[] {
  const problems: string[] = [];
  if (policies.length > AWS_ROLE_MANAGED_POLICIES_MAX) {
    problems.push(
      `${policies.length} policies, over the ${AWS_ROLE_MANAGED_POLICIES_MAX} a role may hold`,
    );
  }
  const seen = new Set<string>();
  for (const policy of policies) {
    if (seen.has(policy.name)) problems.push(`${policy.name} is named twice`);
    seen.add(policy.name);
    const size = JSON.stringify(policy.document).length;
    if (size > AWS_MANAGED_POLICY_MAX_CHARS) {
      problems.push(`${policy.name} is ${size} characters, over ${AWS_MANAGED_POLICY_MAX_CHARS}`);
    }
  }
  return problems;
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
        // `DescribeImages` reads the pinned runner AMI's name, which carries the
        // commit it was built from, for the daily health check's freshness step
        // (MOTIR-10395). Like the others it takes no resource-level permission.
        Sid: 'Describe',
        Effect: 'Allow',
        Action: [
          'ec2:DescribeInstances',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeImages',
        ],
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
