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

/** Is `value` one of the tenant account states? */
export function isHostingTenantAccountState(value: string): value is HostingTenantAccountState {
  return (HOSTING_TENANT_ACCOUNT_STATES as readonly string[]).includes(value);
}
