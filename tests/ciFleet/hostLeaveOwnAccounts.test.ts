import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetShard } from '@/generated/prisma/client';
import type { FleetWorkloadKind } from '@motir/orchestrator';
import { db } from '@/lib/db';
import { capsForPlanKey, HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { wireFleetKindSwitch } from '@/lib/ciFleet/shardTargets';
import { fakePersistentOrchestratorForShard, resetShardFakes } from '@/lib/orchestrator';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetShardAdmissionService,
  OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND,
} from '@/lib/services/fleetShardAdmissionService';
import { fleetShardOrchestratorService } from '@/lib/services/fleetShardOrchestratorService';
import { planCapsService, type PlanCapsAnswer } from '@/lib/services/planCapsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt, randomToken } from '../helpers/random';

// AN ORG THAT LEAVES HOST (Story MOTIR-9365 · MOTIR-9590), against real Postgres
// with a controllable plan reader: from the moment the plan reads another plan,
// its new jobs of every kind take the shared set and never its own accounts;
// running work and agent instances keep their recorded account; nothing on the
// rows changes. An unreadable plan places the job on neither side.

const MOTIR_ORG = 'motir-projects';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const KINDS: FleetWorkloadKind[] = [
  'ci_runner',
  'hosted_agent',
  'code_graph_index',
  'agent_instance',
];

const HOST: PlanCapsAnswer = {
  kind: 'capped',
  planKey: HOST_PLAN_KEY,
  planName: 'Host',
  caps: capsForPlanKey(HOST_PLAN_KEY)!,
};
const MAX: PlanCapsAnswer = {
  kind: 'capped',
  planKey: 'max',
  planName: 'Max',
  caps: capsForPlanKey('max')!,
};

let plan: PlanCapsAnswer;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `host-leave-${suffix}@example.com`,
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
    identifier: `L${randomInt(100, 1000)}`,
  });
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

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

/** The org's three own AWS accounts as four live rows, each granted 200 vCPU. */
async function ownAccounts(owner: Fixture): Promise<Record<FleetWorkloadKind, FleetShard>> {
  const accounts: FleetWorkloadKind[][] = [
    ['ci_runner'],
    ['hosted_agent'],
    ['code_graph_index', 'agent_instance'],
  ];
  const rows = {} as Record<FleetWorkloadKind, FleetShard>;
  for (const kinds of accounts) {
    const awsAccountId = String(randomInt(100_000_000_000, 999_999_999_999));
    for (const fleetKind of kinds) {
      const slug = randomToken(6).toLowerCase();
      rows[fleetKind] = await adminDb.fleetShard.create({
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
          grantedAt: NOW,
          liveAt: NOW,
        },
      });
    }
    await adminDb.fleetQuotaRequest.create({
      data: {
        shardId: rows[kinds[0]!].id,
        fleetKind: kinds[0]!,
        quotaCode: 'L-1216C47A',
        desiredValue: 200,
        awsRequestId: `req-${randomToken(6)}`,
        status: 'approved',
        grantedValue: 200,
        closedAt: NOW,
      },
    });
  }
  return rows;
}

const choose = (fleetKind: FleetWorkloadKind, organizationId: string) =>
  withSystemContext((tx) =>
    fleetShardAdmissionService.chooseInTx({ fleetKind, organizationId }, NOW, tx),
  );

const ownedState = (organizationId: string) =>
  adminDb.fleetShard.findMany({
    where: { ownerOrganizationId: organizationId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      role: true,
      state: true,
      ownerOrganizationId: true,
      quotaRequestedAt: true,
      grantedAt: true,
      liveAt: true,
      vcpuQuota: true,
    },
  });

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.ciRunnerProvisioningIntent.deleteMany({});
  await adminDb.fleetInFlightSlot.deleteMany({});
  await adminDb.fleetQuotaRequest.deleteMany({});
  await adminDb.fleetShard.deleteMany({});
  resetShardFakes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  plan = HOST;
  vi.spyOn(planCapsService, 'capsFor').mockImplementation(async () => plan);
  for (const kind of KINDS) wireFleetKindSwitch(kind, async () => true);
});

afterEach(async () => {
  for (const kind of KINDS) wireFleetKindSwitch(kind, null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetShardFakes();
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

describe('while the plan reads Host', () => {
  it.each(KINDS)('a new %s job is placed on the own account', async (kind) => {
    const host = await seedTenant();
    const own = await ownAccounts(host);
    await shared(kind);
    expect(await choose(kind, host.organizationId)).toEqual({ shardId: own[kind].id });
  });
});

describe('once the plan reads another plan', () => {
  it.each(KINDS)('a new %s job takes the shared set, never an own row', async (kind) => {
    const host = await seedTenant();
    await ownAccounts(host);
    const pool = await shared(kind);
    plan = MAX;

    expect(await choose(kind, host.organizationId)).toEqual({ shardId: pool.id });
    const set = await withSystemContext((tx) =>
      fleetShardAdmissionService.selectionSetInTx(
        { fleetKind: kind, organizationId: host.organizationId },
        tx,
      ),
    );
    expect(set.every((shard) => shard.role !== 'org_owned')).toBe(true);
    expect(
      await fleetShardAdmissionService.capacityDetail({
        fleetKind: kind,
        organizationId: host.organizationId,
      }),
    ).not.toBe(OWN_ACCOUNT_CAPACITY_DETAIL_BY_KIND[kind]);
  });

  it('a Motir exempt org with an own row is never placed on it', async () => {
    const meta = await seedTenant();
    await adminDb.organization.update({
      where: { id: meta.organizationId },
      data: { isMeta: true },
    });
    await ownAccounts(meta);
    const pool = await shared('ci_runner');
    plan = { kind: 'exempt' };

    expect(await choose('ci_runner', meta.organizationId)).toEqual({ shardId: pool.id });
  });

  it('touches no row: role, owner, state, times and quota requests stay as they were', async () => {
    const host = await seedTenant();
    await ownAccounts(host);
    for (const kind of KINDS) await shared(kind);
    const before = await ownedState(host.organizationId);
    const requests = await adminDb.fleetQuotaRequest.count();
    plan = MAX;

    for (const kind of KINDS) await choose(kind, host.organizationId);

    expect(await ownedState(host.organizationId)).toEqual(before);
    expect(await adminDb.fleetQuotaRequest.count()).toBe(requests);
  });

  it('back on Host, the same accounts take its jobs again', async () => {
    const host = await seedTenant();
    const own = await ownAccounts(host);
    await shared('hosted_agent');
    plan = MAX;
    expect(await choose('hosted_agent', host.organizationId)).not.toEqual({
      shardId: own.hosted_agent.id,
    });
    plan = HOST;
    expect(await choose('hosted_agent', host.organizationId)).toEqual({
      shardId: own.hosted_agent.id,
    });
  });
});

describe('work already on an own account', () => {
  it('a running CI job keeps its account and still counts against it', async () => {
    const host = await seedTenant();
    const own = await ownAccounts(host);
    const intent = await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: host.workspaceId,
        organizationId: host.organizationId,
        projectId: host.projectId,
        installationId: '556677',
        runId: '9590',
        runAttempt: 1,
        jobId: '95900',
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: MOTIR_ORG,
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: NOW,
        status: 'running',
        fleetShardId: own.ci_runner.id,
      },
    });
    await shared('ci_runner');
    plan = MAX;
    await choose('ci_runner', host.organizationId);

    const after = await adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({
      where: { id: intent.id },
    });
    expect(after).toMatchObject({ status: 'running', fleetShardId: own.ci_runner.id });
    expect(
      await withSystemContext((tx) =>
        ciRunnerProvisioningIntentRepository.countInFlightForShardInTx(own.ci_runner.id, tx),
      ),
    ).toBe(1);
  });

  it("an agent instance's later steps resolve its recorded account, whatever the plan", async () => {
    const host = await seedTenant();
    const own = await ownAccounts(host);
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
    plan = MAX;
    const reads = vi.mocked(planCapsService.capsFor);
    reads.mockClear();

    expect(
      await fleetShardOrchestratorService.persistentOrchestratorFor({
        fleetShardId: own.agent_instance.id,
      }),
    ).toBe(fakePersistentOrchestratorForShard(own.agent_instance.id));
    expect(reads).not.toHaveBeenCalled();
  });
});

describe('an unreadable plan', () => {
  it.each(KINDS)('defers a %s job of an org with an own account: neither side', async (kind) => {
    const host = await seedTenant();
    await ownAccounts(host);
    await shared(kind);
    plan = { kind: 'plan_unknown', planKey: null };

    expect(await choose(kind, host.organizationId)).toEqual({
      deferred: 'shard_capacity',
      detail: expect.any(String),
    });
  });

  it('changes nothing for an org with no own account', async () => {
    const other = await seedTenant();
    const pool = await shared('ci_runner');
    plan = { kind: 'plan_unknown', planKey: null };
    expect(await choose('ci_runner', other.organizationId)).toEqual({ shardId: pool.id });
    expect(vi.mocked(planCapsService.capsFor)).not.toHaveBeenCalled();
  });
});
