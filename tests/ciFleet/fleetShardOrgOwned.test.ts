import { type Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { FleetShardInvalidError, FleetShardTakenError } from '@/lib/ciFleet/errors';
import { FLEET_SHARD_ROLES, toFleetShardDTO } from '@/lib/mappers/fleetShardMappers';
import { fleetShardRepository } from '@/lib/repositories/fleetShardRepository';
import { fleetGithubOrgAssignmentService } from '@/lib/services/fleetGithubOrgAssignmentService';
import { fleetPoolGrowthService } from '@/lib/services/fleetPoolGrowthService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { fleetShardHeadroomService } from '@/lib/services/fleetShardHeadroomService';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// AN ORG-OWNED ACCOUNT (Story MOTIR-9365 · MOTIR-9581), against real Postgres: a
// Host organisation's own account is a third role on the fleet account record.
// The database holds owner-iff-`org_owned` and AWS uniqueness per (account, kind);
// the service refuses both first with a typed error; and every shared reader —
// admission's selection set, the spare, the headroom reading, the 70% growth job
// and the tenant GitHub-org assignment — stays blind to it.

const NOW = new Date('2026-10-25T12:00:00.000Z');
const MOTIR_ORG = 'motir-projects';

let seq = 0;

async function seedOrganization(): Promise<string> {
  return (await seedTenant()).organizationId;
}

async function seedTenant(): Promise<{
  organizationId: string;
  workspaceId: string;
  userId: string;
}> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `org-owned-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  return { organizationId: workspace.organizationId, workspaceId: workspace.id, userId: user.id };
}

function row(
  overrides: Partial<Prisma.FleetShardUncheckedCreateInput> = {},
): Prisma.FleetShardUncheckedCreateInput {
  seq += 1;
  return {
    name: `owned-test-${seq}`,
    fleetKind: 'ci_runner',
    provider: 'aws',
    role: 'primary',
    state: 'active',
    githubOrg: MOTIR_ORG,
    githubInstallationId: '4242',
    awsAccountId: `33334444${String(seq).padStart(4, '0')}`,
    awsRegion: 'us-east-1',
    credentialRef: `FLEET_SHARD_OWNED_TEST_${seq}`,
    vcpuQuota: 64,
    ...overrides,
  };
}

const insert = (overrides: Partial<Prisma.FleetShardUncheckedCreateInput> = {}) =>
  adminDb.fleetShard.create({ data: row(overrides) });

const owned = (
  organizationId: string,
  overrides: Partial<Prisma.FleetShardUncheckedCreateInput> = {},
) => insert({ role: 'org_owned', ownerOrganizationId: organizationId, ...overrides });

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the database holds the owner and the AWS uniqueness', () => {
  it('stores an org_owned account that names its organisation', async () => {
    const org = await seedOrganization();
    await expect(owned(org)).resolves.toMatchObject({
      role: 'org_owned',
      ownerOrganizationId: org,
      quotaRequestedAt: null,
      grantedAt: null,
      liveAt: null,
    });
  });

  it('refuses an org_owned row with no owner', async () => {
    await expect(insert({ role: 'org_owned' })).rejects.toThrow(
      /fleet_shard_owner_iff_org_owned_check/,
    );
  });

  it.each(['primary', 'spare'] as const)('refuses an owner on a %s row', async (role) => {
    const org = await seedOrganization();
    await expect(insert({ role, ownerOrganizationId: org })).rejects.toThrow(
      /fleet_shard_owner_iff_org_owned_check/,
    );
  });

  it('refuses two rows of one AWS account and one kind', async () => {
    await insert({ awsAccountId: '999900001111' });
    await expect(insert({ awsAccountId: '999900001111' })).rejects.toThrow(/Unique/);
  });

  it('accepts one AWS account as two rows of two kinds — the merged indexer + hoster account', async () => {
    const org = await seedOrganization();
    await owned(org, { awsAccountId: '999900002222', fleetKind: 'code_graph_index' });
    await expect(
      owned(org, { awsAccountId: '999900002222', fleetKind: 'agent_instance' }),
    ).resolves.toMatchObject({ fleetKind: 'agent_instance' });
  });

  it('keeps the organisation while it owns an account', async () => {
    const org = await seedOrganization();
    await owned(org);
    await expect(adminDb.organization.delete({ where: { id: org } })).rejects.toThrow();
  });
});

describe('createShard refuses with a typed error first', () => {
  const base = {
    fleetKind: 'ci_runner',
    provider: 'aws' as const,
    githubOrg: MOTIR_ORG,
    githubInstallationId: '4242',
    awsRegion: 'us-east-1',
    credentialRef: 'FLEET_SHARD_OWNED_SERVICE',
  };

  it('creates an org_owned account with its owner', async () => {
    const org = await seedOrganization();
    const dto = await fleetShardService.createShard({
      ...base,
      name: 'host-ci-1',
      awsAccountId: '555500001111',
      role: 'org_owned',
      ownerOrganizationId: org,
    });
    expect(dto).toMatchObject({ role: 'org_owned', ownerOrganizationId: org });
  });

  it('refuses an org_owned account without an owner', async () => {
    const err = await fleetShardService
      .createShard({ ...base, name: 'host-ci-2', awsAccountId: '555500002222', role: 'org_owned' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetShardInvalidError);
    expect(err).toMatchObject({ field: 'owner' });
  });

  it.each(['primary', 'spare'] as const)('refuses an owner on a %s account', async (role) => {
    const org = await seedOrganization();
    const err = await fleetShardService
      .createShard({
        ...base,
        name: `host-ci-${role}`,
        awsAccountId: '555500003333',
        role,
        ownerOrganizationId: org,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FleetShardInvalidError);
    expect(err).toMatchObject({ field: 'owner' });
  });

  it('answers a duplicate (AWS account, fleet kind) as FleetShardTakenError', async () => {
    await fleetShardService.createShard({
      ...base,
      name: 'host-ci-a',
      awsAccountId: '555500004444',
    });
    await expect(
      fleetShardService.createShard({ ...base, name: 'host-ci-b', awsAccountId: '555500004444' }),
    ).rejects.toBeInstanceOf(FleetShardTakenError);
  });
});

describe('every shared reader stays blind to an org-owned account', () => {
  it('listActiveForKindInTx, the selection set and the spare list return no org-owned row', async () => {
    const org = await seedOrganization();
    const exemptOrg = await seedOrganization();
    await adminDb.organization.update({ where: { id: exemptOrg }, data: { isMeta: true } });
    const primary = await insert();
    await owned(org, { vcpuQuota: 200 });

    const shared = await withSystemContext((tx) =>
      fleetShardRepository.listActiveForKindInTx('ci_runner', ['primary'], tx),
    );
    const sharedAndSpare = await withSystemContext((tx) =>
      fleetShardRepository.listActiveForKindInTx('ci_runner', ['primary', 'spare'], tx),
    );
    expect(shared.map((s) => s.id)).toEqual([primary.id]);
    expect(sharedAndSpare.map((s) => s.id)).toEqual([primary.id]);

    for (const organizationId of [org, exemptOrg]) {
      const set = await withSystemContext((tx) =>
        fleetShardAdmissionService.selectionSetInTx({ fleetKind: 'ci_runner', organizationId }, tx),
      );
      expect(set.map((s) => s.id)).toEqual([primary.id]);
    }

    expect(
      await withSystemContext((tx) => fleetShardRepository.listSparesForKind('ci_runner', tx)),
    ).toEqual([]);
  });

  it('the headroom reading never counts an org-owned account, at any usage', async () => {
    const tenant = await seedTenant();
    const org = tenant.organizationId;
    const primary = await insert({ vcpuQuota: 100 });
    const own = await owned(org, { vcpuQuota: 2 });
    // The own account is full past its quota.
    const workspace = { id: tenant.workspaceId };
    const project = await projectsService.createProject({
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      name: 'Host',
      identifier: `H${randomInt(100, 1000)}`,
    });
    for (let i = 0; i < 3; i += 1) {
      await adminDb.ciRunnerProvisioningIntent.create({
        data: {
          workspaceId: workspace.id,
          organizationId: org,
          projectId: project.id,
          installationId: '4242',
          runId: '7001',
          runAttempt: 1,
          jobId: String(70_000 + i),
          jobName: 'build',
          workflowName: 'CI',
          repoOwner: MOTIR_ORG,
          repoName: 'host-web',
          requestedLabels: ['motir'],
          queuedAt: NOW,
          bootedAt: NOW,
          status: 'running',
          fleetShardId: own.id,
        },
      });
    }

    const readings = await fleetShardHeadroomService.readAccountHeadroom(NOW);

    expect(readings.map((r) => r.shardId)).toEqual([primary.id]);
  });

  it('the growth pass neither triggers on nor promotes an org-owned account', async () => {
    const org = await seedOrganization();
    const primary = await insert({ vcpuQuota: 100 });
    const own = await owned(org, { vcpuQuota: 100 });

    const result = await fleetPoolGrowthService.growKind(
      'ci_runner',
      {
        liveQuotas: [
          { shardId: primary.id, granted: 100 },
          { shardId: own.id, granted: 100 },
        ] as never,
        usage: [
          { shardId: primary.id, usedVcpu: 10 },
          { shardId: own.id, usedVcpu: 100 },
        ],
      },
      { onPool: async () => true, now: () => NOW },
    );

    expect(result).toMatchObject({ result: 'below_threshold' });
    expect(await adminDb.fleetGrowthEvent.count()).toBe(0);
    expect(await adminDb.fleetShard.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({
      role: 'org_owned',
    });
  });

  it('the tenant GitHub-org assignment never chooses an org-owned account, which listByGithubOrg still finds', async () => {
    const hostOrg = await seedOrganization();
    const tenant = await seedOrganization();
    const own = await owned(hostOrg, { githubOrg: 'host-own-org' });

    const locked = await withSystemContext((tx) =>
      fleetShardRepository.lockActiveWithGithubOrgInTx(tx),
    );
    expect(locked).toEqual([]);

    const outcome = await fleetGithubOrgAssignmentService.ensureHostedGithubOrg(tenant, NOW);
    expect(outcome).toEqual({ outcome: 'no_github_org' });

    const naming = await withSystemContext((tx) =>
      fleetShardRepository.listByGithubOrgInTx('host-own-org', tx),
    );
    expect(naming.map((s) => s.id)).toEqual([own.id]);
  });
});

describe('the repository reads an org’s own accounts and writes their times', () => {
  it('lists one org’s accounts, every org-owned account, and filters by kind', async () => {
    const a = await seedOrganization();
    const b = await seedOrganization();
    await insert();
    const a1 = await owned(a);
    const a2 = await owned(a, { fleetKind: 'hosted_agent' });
    const b1 = await owned(b);

    const ofA = await withSystemContext((tx) => fleetShardRepository.listOrgOwnedInTx(a, tx));
    expect(ofA.map((s) => s.id)).toEqual([a1.id, a2.id]);
    const ids = (filter: { organizationId?: string; fleetKind?: string }) =>
      withSystemContext(async (tx) =>
        (await fleetShardRepository.listOrgOwned(filter, tx)).map((s) => s.id),
      );
    expect(await ids({})).toEqual([a1.id, a2.id, b1.id]);
    expect(await ids({ fleetKind: 'ci_runner' })).toEqual([a1.id, b1.id]);
    expect(await ids({ organizationId: b })).toEqual([b1.id]);
    // `listByRole(null)` still answers every role.
    const roles = await withSystemContext(async (tx) =>
      (await fleetShardRepository.listByRole(null, {}, tx)).map((s) => s.role).sort(),
    );
    expect(roles).toEqual(['org_owned', 'org_owned', 'org_owned', 'primary']);
  });

  it('writes only the times given', async () => {
    const org = await seedOrganization();
    const own = await owned(org);
    const at = new Date('2026-10-25T13:00:00.000Z');

    const after = await withSystemContext((tx) =>
      fleetShardRepository.setStateTimestampsInTx(own.id, { quotaRequestedAt: at }, tx),
    );

    expect(after).toMatchObject({ quotaRequestedAt: at, grantedAt: null, liveAt: null });
  });
});

describe('the DTO', () => {
  it('carries the owner and the three times, and no credential value', async () => {
    const org = await seedOrganization();
    vi.stubEnv('FLEET_SHARD_OWNED_DTO', 'secret-value-never-shown');
    const own = await owned(org, {
      credentialRef: 'FLEET_SHARD_OWNED_DTO',
      quotaRequestedAt: new Date('2026-10-25T13:00:00.000Z'),
      grantedAt: new Date('2026-10-25T14:00:00.000Z'),
    });

    const dto = toFleetShardDTO(own);

    expect(dto).toMatchObject({
      role: 'org_owned',
      ownerOrganizationId: org,
      quotaRequestedAt: '2026-10-25T13:00:00.000Z',
      grantedAt: '2026-10-25T14:00:00.000Z',
      liveAt: null,
      credentialRef: 'FLEET_SHARD_OWNED_DTO',
    });
    expect(JSON.stringify(dto)).not.toContain('secret-value-never-shown');
    expect(FLEET_SHARD_ROLES).toContain('org_owned');
    vi.unstubAllEnvs();
  });
});
