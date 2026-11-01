import { describe, expect, it } from 'vitest';
import { orgSegment } from '@/lib/ciFleet/hostAccounts';
import {
  AWS_ACCOUNT_NAME_MAX,
  HOSTING_TENANT_ACCOUNT_STATES,
  hostingTenantAccountPlan,
  isHostingTenantAccountState,
  TENANT_ACCOUNT_REGION,
  TENANT_OU_NAME,
  tenantAccountName,
} from '@/lib/ciFleet/hostingTenantAccounts';
import { memberAccountEmail } from '@/lib/fleetShards/awsMemberAccountPlan';

// THE TENANT ACCOUNT PLAN (Story MOTIR-9792 · MOTIR-9939) — pure: the name and
// member email a tenant account is created as, derived from the organisation id
// alone, so an interrupted `CreateAccount` is found again on replay.

const ORG = 'cmvrg78ck016ehlnfutnhz63h'; // a 25-character cuid
const TEMPLATE = 'aws+{name}@motir.co';

describe('hostingTenantAccountPlan', () => {
  it('names the account tenant-<orgSegment>, the segment the Host names use', () => {
    expect(hostingTenantAccountPlan(ORG).name).toBe(`tenant-${orgSegment(ORG)}`);
    expect(tenantAccountName('Org_ABC--1')).toBe('tenant-org-abc-1');
  });

  it('stays within the AWS account-name limit for a 25-character id', () => {
    expect(ORG).toHaveLength(25);
    expect(hostingTenantAccountPlan(ORG).name.length).toBeLessThanOrEqual(AWS_ACCOUNT_NAME_MAX);
    expect(hostingTenantAccountPlan(ORG).name).toHaveLength(32);
  });

  it('derives the member email the way the add-shard does, on every call', () => {
    const first = hostingTenantAccountPlan(ORG, TEMPLATE);
    const second = hostingTenantAccountPlan(ORG, TEMPLATE);
    expect(first.memberEmail).toBe(memberAccountEmail(TEMPLATE, first.name));
    expect(second).toEqual(first);
  });

  it('answers no email when the template is missing or unusable', () => {
    expect(hostingTenantAccountPlan(ORG).memberEmail).toBeNull();
    expect(hostingTenantAccountPlan(ORG, 'aws@motir.co').memberEmail).toBeNull();
    expect(hostingTenantAccountPlan(ORG, '').memberEmail).toBeNull();
  });

  it('carries the region and the OU name', () => {
    expect(hostingTenantAccountPlan(ORG)).toMatchObject({
      region: TENANT_ACCOUNT_REGION,
      ouName: TENANT_OU_NAME,
    });
    expect(TENANT_ACCOUNT_REGION).toBe('us-east-1');
    expect(TENANT_OU_NAME).toBe('Tenants');
  });

  it('knows the five states and nothing else', () => {
    expect(HOSTING_TENANT_ACCOUNT_STATES).toEqual([
      'requested',
      'creating',
      'bootstrapping',
      'ready',
      'refused',
    ]);
    expect(isHostingTenantAccountState('ready')).toBe(true);
    expect(isHostingTenantAccountState('active')).toBe(false);
  });
});
