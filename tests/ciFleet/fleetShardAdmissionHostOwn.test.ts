import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent, FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { ciRunnerAdmissionService } from '@/lib/services/ciRunnerAdmissionService';
import {
  fleetShardAdmissionService,
  OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND,
  SHARD_CAPACITY_DETAIL,
} from '@/lib/services/fleetShardAdmissionService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';
import { grantPaidAiPlan } from '../helpers/paidAiPlan';

// A HOST ORGANISATION'S JOB IS PLACED PER FLEET KIND (Story MOTIR-9365 ·
// MOTIR-9586), against real Postgres: the Fly switch first; the shared floor
// until the org's own account of the kind is live; then that account and no
// other — waiting when it is full, paused or tried, never spilling to the shared
// pool or Fly. The own account's ceiling is its AWS account's granted vCPU ÷ 2,
// read across both rows of the merged account.

const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-10-25T12:00:00.000Z');
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `host-admission-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: `H${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

/** A shared AWS account of a kind, with room. */
async function shared(fleetKind: FleetWorkloadKind): Promise<FleetShard> {
  const slug = randomToken(6).toLowerCase();
  return adminDb.fleetShard.create({
    data: {
      name: `shared-${slug}`,
      fleetKind,
      provider: 'aws',
      role: 'primary',
      state: 'active',
      githubOrg: MOTIR_ORG,
      githubInstallationId: '556677',
      awsAccountId: String(randomInt(100_000_000_000, 999_999_999_999)),
      awsRegion: 'us-east-1',
      credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
      vcpuQuota: 640,
    },
  });
}

/**
 * One own AWS account of `owner`, as one row per kind, with a quota request
 * recorded against the FIRST row only (as the reconcile files the merged
 * account's one raise on its indexer row).
 */
async function own(
  owner: Fixture,
  kinds: FleetWorkloadKind[],
  options: { granted?: number | null; live?: boolean } = {},
): Promise<FleetShard[]> {
  const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
  const live = options.live ?? true;
  const rows: FleetShard[] = [];
  for (const fleetKind of kinds) {
    const slug = randomToken(6).toLowerCase();
    rows.push(
      await adminDb.fleetShard.create({
        data: {
          name: `host-${slug}-${fleetKind}`,
          fleetKind,
          provider: 'aws',
          role: 'org_owned',
          ownerOrganizationId: owner.organizationId,
          state: 'active',
          githubOrg: MOTIR_ORG,
          githubInstallationId: '556677',
          awsAccountId,
          awsRegion: 'us-east-1',
          credentialRef: `FLEET_SHARD_${slug.toUpperCase()}`,
          quotaRequestedAt: NOW,
          grantedAt: live ? NOW : null,
          liveAt: live ? NOW : null,
        },
      }),
    );
  }
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: rows[0]!.id,
      fleetKind: rows[0]!.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: 200,
      awsRequestId: `req-${randomToken(6)}`,
      status: options.granted === null ? 'pending' : 'approved',
      grantedValue: options.granted === undefined ? 32 : options.granted,
      closedAt: options.granted === null ? null : NOW,
    },
  });
  return rows;
}

async function grant(row: FleetShard, value: number) {
  await adminDb.fleetQuotaRequest.create({
    data: {
      shardId: row.id,
      fleetKind: row.fleetKind,
      quotaCode: 'L-1216C47A',
      desiredValue: value,
      awsRequestId: `req-${randomToken(6)}`,
      status: 'approved',
      grantedValue: value,
      closedAt: NOW,
    },
  });
}

let jobSeq = 0;
async function seedIntent(
  fx: Fixture,
  overrides: { status?: string; fleetShardId?: string | null } = {},
): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '9586',
      runAttempt: 1,
      jobId: String(95_860 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: NOW,
      status: overrides.status ?? 'pending',
      fleetShardId: overrides.fleetShardId ?? null,
    },
  });
}

const choose = (
  fleetKind: FleetWorkloadKind,
  organizationId: string,
  options: { exclude?: ReadonlySet<string> } = {},
) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind, organizationId }, NOW, tx, options),
  );

const onPool = () => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => true);
};

grantPaidAiPlan();

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_AI_URL', 'https://ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.stubEnv('MOTIR_FLEET_ORG_MAX_IN_FLIGHT', '100');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/v1/usage')) {
        return new Response(JSON.stringify({ balance: 1_000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }),
  );
});

afterEach(async () => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the switch is read first', () => {
  it('a kind on Fly answers no account, whatever the own account says', async () => {
    const host = await seedTenant();
    await own(host, ['ci_runner']);
    await shared('ci_runner');

    expect(await choose('ci_runner', host.organizationId)).toEqual({ shardId: null });
  });
});

describe('the shared floor', () => {
  it('with no live own account the job takes the shared account, and the own row is never in the set', async () => {
    onPool();
    const host = await seedTenant();
    const pending = await own(host, ['ci_runner'], { granted: null, live: false });
    const pool = await shared('ci_runner');

    expect(await choose('ci_runner', host.organizationId)).toEqual({ shardId: pool.id });
    const set = await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx(
        { fleetKind: 'ci_runner', organizationId: host.organizationId },
        tx,
      ),
    );
    expect(set.map((s) => s.id)).toEqual([pool.id]);
    expect(set.map((s) => s.id)).not.toContain(pending[0]!.id);
  });

  it('one live kind does not move the others', async () => {
    onPool();
    const host = await seedTenant();
    const [runner] = await own(host, ['hosted_agent']);
    await own(host, ['ci_runner'], { granted: null, live: false });
    const ciPool = await shared('ci_runner');
    await shared('hosted_agent');

    expect(await choose('hosted_agent', host.organizationId)).toEqual({ shardId: runner!.id });
    expect(await choose('ci_runner', host.organizationId)).toEqual({ shardId: ciPool.id });
  });
});

describe('a live own account', () => {
  it.each(KINDS)('is the only account a %s job of the org is placed on', async (kind) => {
    onPool();
    const host = await seedTenant();
    const [mine] = await own(host, [kind]);
    await shared(kind);

    expect(await choose(kind, host.organizationId)).toEqual({ shardId: mine!.id });
    const set = await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx(
        { fleetKind: kind, organizationId: host.organizationId },
        tx,
      ),
    );
    expect(set.map((s) => s.id)).toEqual([mine!.id]);
  });

  it('serves both kinds of the merged account, the hoster row reading the grant filed on the indexer row', async () => {
    onPool();
    const host = await seedTenant();
    const [index, hoster] = await own(host, ['code_graph_index', 'agent_instance'], {
      granted: 40,
    });

    expect(await choose('code_graph_index', host.organizationId)).toEqual({ shardId: index!.id });
    expect(await choose('agent_instance', host.organizationId)).toEqual({ shardId: hoster!.id });
    expect(hoster!.vcpuQuota).toBeNull();
    const ceiling = await withSystemContext((tx) =>
      fleetShardAdmissionService.ownCeilingInTx(hoster!, tx),
    );
    // The merged account's split (MOTIR-9589): 40 granted, 10 index spots kept.
    expect(ceiling).toBe(10);
  });

  it('is never chosen for another org, nor for a Motir exempt org', async () => {
    onPool();
    const host = await seedTenant();
    const other = await seedTenant();
    const motir = await seedTenant();
    await adminDb.organization.update({
      where: { id: motir.organizationId },
      data: { isMeta: true },
    });
    for (const kind of KINDS) {
      const [mine] = await own(host, [kind]);
      for (const outsider of [other, motir]) {
        const placement = await choose(kind, outsider.organizationId);
        expect(placement).not.toEqual({ shardId: mine!.id });
        expect('deferred' in placement && placement.own).toBeFalsy();
      }
    }
  });
});

describe('a full own account', () => {
  it('defers with the own-capacity words, never spilling to the shared pool or Fly', async () => {
    onPool();
    const host = await seedTenant();
    const [mine] = await own(host, ['ci_runner'], { granted: 2 });
    await shared('ci_runner');
    await seedIntent(host, { status: 'running', fleetShardId: mine!.id });

    expect(await choose('ci_runner', host.organizationId)).toEqual({
      deferred: 'shard_capacity',
      detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND.ci_runner,
      own: true,
    });
  });

  it('defers when paused or already tried, and the in-boot move finds nothing', async () => {
    onPool();
    const host = await seedTenant();
    const [mine] = await own(host, ['ci_runner']);
    await shared('ci_runner');

    expect(
      await choose('ci_runner', host.organizationId, { exclude: new Set([mine!.id]) }),
    ).toMatchObject({ deferred: 'shard_capacity', own: true });
    const reassigned: string[] = [];
    const next = await withSystemContext((tx) =>
      fleetShardAdmissionService.moveAfterRefusalInTx(
        { fleetKind: 'ci_runner', organizationId: host.organizationId },
        mine!.id,
        'capacity_refused',
        new Set([mine!.id]),
        NOW,
        tx,
        async (id) => {
          reassigned.push(id);
        },
      ),
    );
    expect(next).toBeNull();
    expect(reassigned).toEqual([]);
    // Paused now: a fresh choice still waits for it.
    expect(await choose('ci_runner', host.organizationId)).toMatchObject({
      deferred: 'shard_capacity',
      own: true,
    });
    expect(
      await fleetShardAdmissionService.capacityDetail({
        fleetKind: 'ci_runner',
        organizationId: host.organizationId,
      }),
    ).toBe(OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND.ci_runner);
  });

  it("CI admission tells the org it waits for its own account's capacity", async () => {
    onPool();
    const host = await seedTenant();
    const [mine] = await own(host, ['ci_runner'], { granted: 2 });
    await shared('ci_runner');
    await seedIntent(host, { status: 'running', fleetShardId: mine!.id });
    const intent = await seedIntent(host);

    const verdict = await ciRunnerAdmissionService.admit(intent);

    expect(verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'shard_capacity',
      detail: OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND.ci_runner,
    });
    expect(verdict).not.toMatchObject({ detail: SHARD_CAPACITY_DETAIL });
  });
});

describe('the own ceiling', () => {
  it('is granted vCPU ÷ 2 rounded down, follows a later grant, and is 0 with no grant', async () => {
    const host = await seedTenant();
    const [ci] = await own(host, ['ci_runner'], { granted: 33 });
    const ceilingOf = (row: FleetShard) =>
      withSystemContext((tx) => fleetShardAdmissionService.ownCeilingInTx(row, tx));

    expect(await ceilingOf(ci!)).toBe(16);
    await grant(ci!, 64);
    expect(await ceilingOf(ci!)).toBe(32);

    const [none] = await own(host, ['hosted_agent'], { granted: null, live: false });
    expect(await ceilingOf(none!)).toBe(0);
  });
});
