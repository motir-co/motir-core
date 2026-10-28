import {
  AWS_TENANT_DEPLOY_ROLE,
  type AwsPolicyDocument,
  type AwsQuotaTarget,
} from '@motir/orchestrator';
import { orgSegment } from '@/lib/ciFleet/hostAccounts';
import {
  memberAccountEmail,
  memberEmailTemplateProblems,
} from '@/lib/fleetShards/awsMemberAccountPlan';

// AN ENTERPRISE TENANT'S AWS HOSTING ACCOUNT (Story MOTIR-9792 · MOTIR-9939). One
// account per organisation, in Motir's AWS Organization under the `Tenants` OU,
// where every AWS-target application of every project of that organisation runs.
// It is NOT a fleet account: it has its own record (`hosting_tenant_account`), no
// `fleet_shard` row, and nothing that places fleet jobs reads it.
//
// The name is derived from the organisation id ONLY — `tenant-<org>`, with the
// same `orgSegment` the Host account names use — so a pass interrupted after
// `CreateAccount` recomputes the same name, and with it the member email, and
// FINDS the account instead of creating a second. The email is derived on demand
// from the add-shard's template and never stored. Pure: no `db`, no
// `process.env` — the template is the caller's read.

/** Where a tenant account stands. A state is written only after the step it
 *  names has succeeded (the reconcile, `hostingTenantAccountService`). */
export type HostingTenantAccountState =
  | 'requested'
  | 'creating'
  | 'bootstrapping'
  | 'ready'
  | 'refused';

export const HOSTING_TENANT_ACCOUNT_STATES: readonly HostingTenantAccountState[] = [
  'requested',
  'creating',
  'bootstrapping',
  'ready',
  'refused',
];

/** The tenant accounts' region, beside the fleet pools (MOTIR-9701). The one
 *  place to change it. */
export const TENANT_ACCOUNT_REGION = 'us-east-1';

/** The organisational unit, directly under the Organization root, every tenant
 *  account sits in — apart from the pool and Host accounts, ready for handover. */
export const TENANT_OU_NAME = 'Tenants';

/** AWS's limit on an account name. */
export const AWS_ACCOUNT_NAME_MAX = 50;

export interface HostingTenantAccountPlan {
  /** `tenant-<org>` — what the account is created as, and found by on replay. */
  name: string;
  /** The member account's root email, from the add-shard's template; null when
   *  no usable template was passed. Never persisted. */
  memberEmail: string | null;
  region: string;
  ouName: string;
}

/** `tenant-<org>` — the tenant account's name. */
export function tenantAccountName(organizationId: string): string {
  return `tenant-${orgSegment(organizationId)}`;
}

/** What one organisation's tenant account is created as. `memberEmailTemplate` is
 *  the add-shard's `FLEET_AWS_MEMBER_EMAIL_TEMPLATE`, read by the caller. */
export function hostingTenantAccountPlan(
  organizationId: string,
  memberEmailTemplate?: string,
): HostingTenantAccountPlan {
  const name = tenantAccountName(organizationId);
  const usable =
    memberEmailTemplate !== undefined &&
    memberEmailTemplateProblems(memberEmailTemplate).length === 0;
  return {
    name,
    memberEmail: usable ? memberAccountEmail(memberEmailTemplate, name) : null,
    region: TENANT_ACCOUNT_REGION,
    ouName: TENANT_OU_NAME,
  };
}

/** The role a tenant's deploys run as in its account (MOTIR-9941), trusted only by
 *  Motir's management role. */
export const TENANT_DEPLOY_ROLE_NAME = AWS_TENANT_DEPLOY_ROLE;

/** The cost-allocation tag on a tenant account: `motir:organization=<id>`. */
export const TENANT_ORGANIZATION_TAG_KEY = 'motir:organization';

/** A quota raise the bootstrap files in a new tenant account. */
export interface TenantQuotaTarget extends AwsQuotaTarget {
  /** What the quota is, for outcomes and logs. */
  name: string;
}

/** The pre-launch quota targets of a tenant account (Story MOTIR-9792); the AWS
 *  adapter story may change them here. */
export const TENANT_QUOTA_TARGETS: readonly TenantQuotaTarget[] = [
  {
    name: 'fargate-on-demand-vcpu',
    serviceCode: 'fargate',
    quotaCode: 'L-3032A538',
    desiredValue: 64,
  },
  {
    name: 'lambda-concurrent-executions',
    serviceCode: 'lambda',
    quotaCode: 'L-B99A9384',
    desiredValue: 1000,
  },
];

/**
 * The deploy role's permissions: the services the AWS adapter deploys a tenant's
 * applications with, in the tenant region only. Broad on purpose until the
 * adapter (MOTIR-9794) narrows it; it never grants IAM user or key management,
 * Organizations, or billing.
 */
export function tenantDeployPolicyDocument(): AwsPolicyDocument {
  const inRegion = { StringEquals: { 'aws:RequestedRegion': TENANT_ACCOUNT_REGION } };
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DeployServices',
        Effect: 'Allow',
        Action: [
          'ecs:*',
          'ecr:*',
          'lambda:*',
          'logs:*',
          'elasticloadbalancing:*',
          'ec2:*',
          's3:*',
          'cloudformation:*',
          'ssm:GetParameter*',
          'secretsmanager:*',
          'acm:*',
          'application-autoscaling:*',
          'cloudwatch:*',
        ],
        Resource: '*',
        Condition: inRegion,
      },
      {
        Sid: 'ServiceRoles',
        Effect: 'Allow',
        Action: [
          'iam:GetRole',
          'iam:PassRole',
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:AttachRolePolicy',
          'iam:DetachRolePolicy',
          'iam:TagRole',
          'iam:CreateServiceLinkedRole',
        ],
        Resource: '*',
      },
      {
        Sid: 'NeverTheDeployRoleItself',
        Effect: 'Deny',
        Action: 'iam:*',
        Resource: `arn:aws:iam::*:role/${TENANT_DEPLOY_ROLE_NAME}`,
      },
    ],
  };
}

/** Is `value` one of the tenant account states? */
export function isHostingTenantAccountState(value: string): value is HostingTenantAccountState {
  return (HOSTING_TENANT_ACCOUNT_STATES as readonly string[]).includes(value);
}
