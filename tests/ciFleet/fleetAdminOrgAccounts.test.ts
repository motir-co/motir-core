import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { fleetShardService } from '@/lib/services/fleetShardService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { runFleetAdmin } from '@/scripts/fleet/fleetAdmin';
import type { FleetAdminPoolDeps } from '@/scripts/fleet/fleetAdminPoolCommands';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// `fleet-admin org-accounts` (Story MOTIR-9365 · MOTIR-9588) against real
// Postgres: one line per own account row with its owner, kind, state, requested
// and granted vCPU — the merged account's two rows alike — and `pool-status`
// showing none of them, nor their raises, under a shared pool.

const NOW = new Date('2026-10-26T12:00:00Z');
const CREDENTIAL_REF = 'FLEET_SHARD_HOST_SECRET_REF';
const MEMBER_EMAIL = 'host-member-account@example.com';

const deps = (): FleetAdminPoolDeps => ({
  status: { onPool: async () => true, now: () => NOW, readUsage: async () => [] },
});

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runFleetAdmin(
    argv,
    { out: (l) => void out.push(l), err: (l) => void err.push(l) },
    deps(),
  );
  return { code, out, err: err.join('\n') };
}

async function seedOrg(): Promise<string> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `org-accounts-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  return workspace.organizationId;
}

async function ownAccount(
  organizationId: string,
  name: string,
  kinds: FleetWorkloadKind[],
  times: { quotaRequestedAt?: Date; grantedAt?: Date; liveAt?: Date } = {},
): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const rows: FleetShard[] = [];
  for (const fleetKind of kinds) {
    rows.push(
      await adminDb.fleetShard.create({
        data: {
          name: kinds.length > 1 ? `${name}-${fleetKind}` : name,
          fleetKind,
          provider: 'aws',
          role: 'org_owned',
          ownerOrganizationId: organizationId,
          state: times.liveAt ? 'active' : 'provisioning',
          githubOrg: 'motir-projects',
          githubInstallationId: '556677',
          awsAccountId,
          awsRegion: 'us-east-1',
          credentialRef: CREDENTIAL_REF,
          ...times,
        },
      }),
    );
  }
  return rows;
}

async function raise(
  row: FleetShard,
  desiredValue: number,
  outcome: { status: 'pending' | 'approved' | 'denied'; granted?: number },
  createdAt = NOW,
) {
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: row.id,
      fleetKind: row.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue,
      awsRequestId: `req-${randomToken(6)}`,
      status: outcome.status,
      grantedValue: outcome.granted ?? null,
      closedAt: outcome.status === 'pending' ? null : NOW,
      createdAt,
    },
  });
}

/** The three accounts the reconcile creates for one Host org (four rows). */
async function hostAccounts(organizationId: string, prefix = 'host') {
  const [ci] = await ownAccount(organizationId, `${prefix}-ci`, ['ci_runner'], {
    quotaRequestedAt: NOW,
    grantedAt: NOW,
    liveAt: NOW,
  });
  await raise(ci!, 200, { status: 'approved', granted: 200 });
  const [agents] = await ownAccount(organizationId, `${prefix}-agents`, ['hosted_agent'], {
    quotaRequestedAt: NOW,
  });
  await raise(agents!, 32, { status: 'denied' });
  const merged = await ownAccount(
    organizationId,
    `${prefix}-merged`,
    ['code_graph_index', 'agent_instance'],
    { quotaRequestedAt: NOW, grantedAt: NOW },
  );
  await raise(merged[0]!, 120, { status: 'approved', granted: 96 });
  return { ci: ci!, agents: agents!, merged };
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('fleet-admin org-accounts', () => {
  it('prints one line per own account row with owner, kind, state, requested and granted', async () => {
    const org = await seedOrg();
    await hostAccounts(org);
    const result = await run('org-accounts');
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(4);
    expect(result.out).toContain(
      `${org}  ci_runner  host-ci  live  requested 200  granted 200  (approved)`,
    );
    // A denied raise: its ask, no granted figure, still quota requested.
    expect(result.out).toContain(
      `${org}  hosted_agent  host-agents  quota_requested  requested 32  granted -  (denied)`,
    );
    // The merged account: two lines, the same state and figures.
    expect(result.out).toContain(
      `${org}  code_graph_index  host-merged-code_graph_index  granted  requested 120  granted 96  (approved)`,
    );
    expect(result.out).toContain(
      `${org}  agent_instance  host-merged-agent_instance  granted  requested 120  granted 96  (approved)`,
    );
  });

  it('prints the latest raise asked and the largest value granted', async () => {
    const org = await seedOrg();
    const [row] = await ownAccount(org, 'host-ci', ['ci_runner'], {
      quotaRequestedAt: NOW,
      grantedAt: NOW,
      liveAt: NOW,
    });
    await raise(row!, 200, { status: 'approved', granted: 200 }, new Date(NOW.getTime() - 60_000));
    await raise(row!, 400, { status: 'pending' });
    expect((await run('org-accounts')).out).toEqual([
      `${org}  ci_runner  host-ci  live  requested 400  granted 200  (pending)`,
    ]);
  });

  it('--org and --kind narrow the listing; the merged figures hold under --kind', async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    await hostAccounts(org);
    await hostAccounts(other, 'other');

    const byOrg = await run('org-accounts', '--org', org);
    expect(byOrg.out).toHaveLength(4);
    expect(byOrg.out.every((line) => line.startsWith(org))).toBe(true);

    const byKind = await run('org-accounts', '--org', org, '--kind', 'agent_instance');
    expect(byKind.out).toEqual([
      `${org}  agent_instance  host-merged-agent_instance  granted  requested 120  granted 96  (approved)`,
    ]);
  });

  it('prints none for an empty listing and refuses an unknown kind', async () => {
    const empty = await run('org-accounts', '--org', await seedOrg());
    expect(empty).toMatchObject({ code: 0, out: ['none'] });

    const bad = await run('org-accounts', '--kind', 'not_a_kind');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('not_a_kind');
  });

  it('prints no credential reference or member-account email', async () => {
    const org = await seedOrg();
    await hostAccounts(org);
    const text = (await run('org-accounts')).out.join('\n');
    expect(text).not.toContain(CREDENTIAL_REF);
    expect(text).not.toContain(MEMBER_EMAIL);
    expect(text).not.toContain('@');
  });
});

describe('fleet-admin pool-status with own accounts', () => {
  it('shows only the shared account, no own row as a spare, and none of its raises', async () => {
    const org = await seedOrg();
    const shared = await fleetShardService.createShard({
      name: 'shared-ci',
      fleetKind: 'ci_runner',
      provider: 'aws',
      role: 'primary',
      state: 'active',
      githubOrg: 'motir-fleet-use1-1',
      githubInstallationId: '9001',
      awsAccountId: '111111111111',
      awsRegion: 'us-east-1',
      credentialRef: 'FLEET_SHARD_TEST',
      limits: { vcpuQuota: 100 },
      limitsSource: { vcpuQuota: 'provider_read' },
    });
    const sharedRow = await adminDb.fleetShard.findUniqueOrThrow({ where: { id: shared.id } });
    await raise(sharedRow, 300, { status: 'approved', granted: 300 });
    const [own] = await ownAccount(org, 'host-ci', ['ci_runner'], { quotaRequestedAt: NOW });
    await raise(own!, 200, { status: 'pending' });

    const result = await run('pool-status', '--kind', 'ci_runner');
    expect(result.code).toBe(0);
    const text = result.out.join('\n');
    expect(text).toContain('shared-ci');
    expect(text).not.toContain('host-ci');
    expect(text).toContain('desired 300');
    expect(text).not.toContain('desired 200');
    // An own account's open raise is not a spare raising.
    expect(result.out[0]).toBe('ci_runner: aws  growth idle');
  });
});
