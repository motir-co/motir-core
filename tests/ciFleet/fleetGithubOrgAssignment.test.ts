import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard, FleetShardState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  TENANT_TARGET,
  tenantsPerShard,
  GITHUB_SECONDARY_LIMITS,
} from '@/lib/ciFleet/shardTargets';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  fleetGithubOrgAssignmentService,
  orgTargetForGithubOrg,
} from '@/lib/services/fleetGithubOrgAssignmentService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// WHICH MOTIR-OWNED GITHUB ORG A TENANT IS HOSTED IN (Story MOTIR-8953 ·
// MOTIR-8966), against real Postgres: the choice by GitHub headroom, the tie
// order, one org named by several rows, inactive rows, a kept assignment, the
// count across every tenant, and two real races. `fleet-per-org-pool.md`
// AMENDMENT 1.

const PASSWORD = 'hunter2hunter2';
const T0 = new Date('2026-07-01T00:00:00.000Z');

/** Registrations per 5 min that carry exactly `tenants` target tenants. */
function registrationsFor(tenants: number): number {
  return tenants * TENANT_TARGET.startsPer5Min;
}

/** A GitHub org's tenant capacity with only its registrations recorded. */
function capacityOf(registrationsPer5Min: number): number {
  return tenantsPerShard({
    registrationsPer5Min,
    secondaryLimits: Object.values(GITHUB_SECONDARY_LIMITS),
  }).tenants;
}

async function seedOrganization(): Promise<string> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `hosted-org-${suffix}-${randomToken(4)}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  return workspace.organizationId;
}

async function account(
  githubOrg: string,
  registrationsPer5Min: number,
  overrides: Partial<{
    fleetKind: string;
    state: FleetShardState;
    createdAt: Date;
    installationId: string;
  }> = {},
): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `acct-${slug}`,
      fleetKind: overrides.fleetKind ?? 'ci_runner',
      provider: 'fly',
      state: overrides.state ?? 'active',
      githubOrg,
      githubInstallationId: overrides.installationId ?? `inst-${githubOrg}`,
      flyOrg: 'motir',
      flyApp: `motir-ci-${slug}`,
      flyRegion: 'iad',
      credentialRef: 'FLEET_SHARD_TEST_TOKEN',
      machineLimit: 10,
      githubRegistrationsPer5Min: registrationsPer5Min,
      createdAt: overrides.createdAt ?? T0,
    },
  });
}

/** Mark `count` other organisations as already hosted in `githubOrg`. */
async function assignOthers(githubOrg: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const id = await seedOrganization();
    await adminDb.organization.update({
      where: { id },
      data: { hostedGithubOrg: githubOrg, hostedGithubOrgAssignedAt: T0 },
    });
  }
}

async function hostedOf(organizationId: string): Promise<string | null> {
  const org = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
  return org.hostedGithubOrg;
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.stubEnv('GITHUB_FALLBACK_ORG', 'motir-projects');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the choice', () => {
  it('with no active account naming a GitHub org, assigns nothing', async () => {
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toEqual({ outcome: 'no_github_org' });
    expect(await hostedOf(organizationId)).toBeNull();
  });

  it('assigns the org with the most headroom (5 vs 12), with that org’s installation', async () => {
    expect(capacityOf(registrationsFor(5))).toBe(5);
    expect(capacityOf(registrationsFor(12))).toBe(12);
    await account('motir-host-a', registrationsFor(5));
    await account('motir-host-b', registrationsFor(12), { installationId: '9912' });
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toEqual({
      outcome: 'assigned',
      githubOrg: 'motir-host-b',
      target: { org: 'motir-host-b', installationId: '9912', role: 'provisioning' },
    });
    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(row.hostedGithubOrg).toBe('motir-host-b');
    expect(row.hostedGithubOrgAssignedAt).not.toBeNull();
  });

  it('a tie goes to the org whose row was created first, before the login order', async () => {
    await account('motir-host-a', registrationsFor(4), {
      createdAt: new Date(T0.getTime() + 60_000),
    });
    await account('motir-host-z', registrationsFor(4), { createdAt: T0 });
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'assigned', githubOrg: 'motir-host-z' });
  });

  it('rows of several fleet kinds naming one org count as ONE org, its headroom once', async () => {
    // Counted per row, A would read 10 and beat B's 6.
    await account('motir-host-a', registrationsFor(5), { fleetKind: 'ci_runner' });
    await account('Motir-Host-A', registrationsFor(5), { fleetKind: 'hosted_agent' });
    await account('motir-host-b', registrationsFor(6));
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'assigned', githubOrg: 'motir-host-b' });
  });

  it('an org named only by provisioning or disabled rows is never assigned', async () => {
    await account('motir-host-new', registrationsFor(40), { state: 'provisioning' });
    await account('motir-host-old', registrationsFor(40), { state: 'disabled' });
    await account('motir-host-a', registrationsFor(1));
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'assigned', githubOrg: 'motir-host-a' });
  });

  it('every org full: assigns the best one anyway and warns, never blocks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await account('motir-host-a', registrationsFor(1));
    await assignOthers('motir-host-a', 1);
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'assigned', githubOrg: 'motir-host-a' });
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      githubOrg: 'motir-host-a',
      headroom: 0,
    });
    warn.mockRestore();
  });

  it('an assigned organisation KEEPS its org when another now has more headroom', async () => {
    await account('motir-host-a', registrationsFor(3));
    const organizationId = await seedOrganization();
    await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);
    await account('motir-host-b', registrationsFor(40));

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'already_assigned', githubOrg: 'motir-host-a' });
    expect(await hostedOf(organizationId)).toBe('motir-host-a');
  });
});

describe('the count spans every tenant', () => {
  it('counts organisations assigned in OTHER workspaces', async () => {
    // A carries 5 with 4 assigned elsewhere (headroom 1); B carries 2 with none
    // (headroom 2). A count that saw only this tenant would pick A.
    await account('motir-host-a', registrationsFor(5));
    await account('motir-host-b', registrationsFor(2));
    await assignOthers('Motir-Host-A', 4);
    const organizationId = await seedOrganization();

    const result = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId);

    expect(result).toMatchObject({ outcome: 'assigned', githubOrg: 'motir-host-b' });
  });
});

describe('concurrency, real database', () => {
  it('two organisations at once against headroom 1 and 0 split, and the counts add up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // B's row is the older, so at 0 vs 0 the tie goes to B.
    await account('motir-host-a', registrationsFor(1));
    await account('motir-host-b', registrationsFor(1), {
      createdAt: new Date(T0.getTime() - 60_000),
    });
    await assignOthers('motir-host-b', 1);
    const first = await seedOrganization();
    const second = await seedOrganization();

    const results = await Promise.all([
      fleetGithubOrgAssignmentService.ensureHostedGithubOrg(first),
      fleetGithubOrgAssignmentService.ensureHostedGithubOrg(second),
    ]);

    expect(results.map((r) => r.outcome)).toEqual(['assigned', 'assigned']);
    const hosted = [await hostedOf(first), await hostedOf(second)];
    expect(hosted.filter((org) => org === 'motir-host-a')).toHaveLength(1);
    expect(hosted.filter((org) => org === 'motir-host-b')).toHaveLength(1);
    const onA = await adminDb.organization.count({ where: { hostedGithubOrg: 'motir-host-a' } });
    const onB = await adminDb.organization.count({ where: { hostedGithubOrg: 'motir-host-b' } });
    expect(onA + onB).toBe(3);
  });

  it('two establishes of one organisation at once assign it exactly once', async () => {
    await account('motir-host-a', registrationsFor(3));
    await account('motir-host-b', registrationsFor(3), { createdAt: new Date(T0.getTime() + 1) });
    const organizationId = await seedOrganization();

    const results = await Promise.all([
      fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId),
      fleetGithubOrgAssignmentService.ensureHostedGithubOrg(organizationId),
    ]);

    expect(results.map((r) => r.outcome).sort()).toEqual(['already_assigned', 'assigned']);
    expect(new Set(results.map((r) => ('githubOrg' in r ? r.githubOrg : null)))).toEqual(
      new Set(['motir-host-a']),
    );
    expect(await adminDb.organization.count({ where: { hostedGithubOrg: { not: null } } })).toBe(1);
  });
});

describe('orgTargetForGithubOrg', () => {
  it('is built from the rows naming the org, case-insensitive, an active row first', async () => {
    const disabled = await account('motir-host-a', 10, {
      state: 'disabled',
      createdAt: T0,
      installationId: '1',
    });
    const active = await account('Motir-Host-A', 10, {
      createdAt: new Date(T0.getTime() + 1),
      installationId: '2',
    });

    expect(orgTargetForGithubOrg('MOTIR-HOST-A', [disabled, active])).toEqual({
      org: 'Motir-Host-A',
      installationId: '2',
      role: 'provisioning',
    });
    expect(orgTargetForGithubOrg('motir-host-b', [disabled, active])).toBeNull();
  });
});
