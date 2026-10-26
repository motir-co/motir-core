import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CiRunnerProvisioningIntent } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  ciRunnerAdmissionService,
  CREDITS_INSUFFICIENT_DETAIL,
} from '@/lib/services/ciRunnerAdmissionService';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { fleetShardAdmissionService } from '@/lib/services/fleetShardAdmissionService';
import { ciRunnerProvisioningIntentRepository } from '@/lib/repositories/ciRunnerProvisioningIntentRepository';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';
import { stubPaidAiPlan } from '../helpers/paidAiPlan';

// WHY A PENDING CI JOB WAITS (Story MOTIR-9368 · MOTIR-9666) — every deferral
// `admit` returns is recorded on the still-pending intent as `waiting_reason`,
// with `waiting_since` the instant that reason was first given; the claim clears
// both, and a boot whose every account refused puts the job back waiting for a
// full pool. Real Postgres and the real fleet admission lock; the plan is
// stubbed at `planCapsService.capsFor` with its real row, and a full pool by
// stubbing the account choice, as `ciBurstCap.test.ts` stubs credits.

const MOTIR_ORG = 'motir-projects';
const T1 = new Date('2026-07-15T12:00:00.000Z');
const T2 = new Date('2026-07-15T12:05:00.000Z');

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(ciBurstCap?: number): Promise<Fixture> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `waiting-reason-${suffix}@example.com`,
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
    identifier: `W${randomInt(100, 1000)}`,
  });
  if (ciBurstCap !== undefined) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { fleetPoolCap: ciBurstCap },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  };
}

let jobSeq = 0;
async function seedIntent(fx: Fixture, status = 'pending'): Promise<CiRunnerProvisioningIntent> {
  jobSeq += 1;
  return adminDb.ciRunnerProvisioningIntent.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.organizationId,
      projectId: fx.projectId,
      installationId: '556677',
      runId: '7001',
      runAttempt: 1,
      jobId: String(90_000 + jobSeq),
      jobName: 'build',
      workflowName: 'CI',
      repoOwner: MOTIR_ORG,
      repoName: 'acme-web',
      requestedLabels: [MOTIR_RUNNER_LABEL],
      queuedAt: T1,
      status,
    },
  });
}

const read = (id: string) =>
  adminDb.ciRunnerProvisioningIntent.findUniqueOrThrow({ where: { id } });

/** The intent as the next sweep pass reads it. */
const admitAgain = async (id: string) => ciRunnerAdmissionService.admit(await read(id));

function fullPool(): void {
  vi.spyOn(fleetShardAdmissionService, 'chooseInTx').mockResolvedValue({
    deferred: 'shard_capacity',
    detail: 'every CI account is full',
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T1);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  stubPaidAiPlan('pro');
  vi.spyOn(ciRunnerAdmissionService, 'creditDeferral').mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the reason a pending intent waits', () => {
  it('reads plan_cap, then shard_capacity on the next pass with waiting_since moved', async () => {
    const fx = await seedTenant(1);
    await seedIntent(fx, 'running');
    const intent = await seedIntent(fx);

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
    });
    expect(await read(intent.id)).toMatchObject({
      status: 'pending',
      waitingReason: 'plan_cap',
      waitingSince: T1,
    });

    // The org's cap is raised, and now every account of the kind is full.
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 5 },
    });
    fullPool();
    vi.setSystemTime(T2);
    expect(await admitAgain(intent.id)).toMatchObject({
      outcome: 'deferred',
      reason: 'shard_capacity',
    });
    expect(await read(intent.id)).toMatchObject({
      status: 'pending',
      waitingReason: 'shard_capacity',
      waitingSince: T2,
    });
  });

  it('writes nothing for a second deferral with the same reason', async () => {
    const fx = await seedTenant(1);
    await seedIntent(fx, 'running');
    const intent = await seedIntent(fx);
    await ciRunnerAdmissionService.admit(intent);

    vi.setSystemTime(T2);
    expect(await admitAgain(intent.id)).toMatchObject({ reason: 'plan_cap' });
    expect(await read(intent.id)).toMatchObject({ waitingReason: 'plan_cap', waitingSince: T1 });
  });

  it.each([
    [
      'plan_unknown',
      () => vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue('unknown'),
    ],
    [
      'ai_plan_required',
      () => vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false),
    ],
    ['fleet_ceiling', () => vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0')],
  ] as const)('a pre-lock %s deferral leaves its reason', async (reason, arrange) => {
    const fx = await seedTenant();
    arrange();
    const intent = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason,
    });
    expect(await read(intent.id)).toMatchObject({
      status: 'pending',
      waitingReason: reason,
      waitingSince: T1,
    });
  });

  it('a credit deferral that released its claim leaves credits_insufficient', async () => {
    const fx = await seedTenant();
    vi.spyOn(ciRunnerAdmissionService, 'creditDeferral').mockResolvedValue({
      outcome: 'deferred',
      reason: 'credits_insufficient',
      detail: CREDITS_INSUFFICIENT_DETAIL,
    });
    const intent = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      reason: 'credits_insufficient',
    });
    expect(await read(intent.id)).toMatchObject({
      status: 'pending',
      waitingReason: 'credits_insufficient',
      waitingSince: T1,
    });
  });
});

describe('the claim clears it', () => {
  it('an admitted intent carries no waiting reason', async () => {
    const fx = await seedTenant(1);
    const blocker = await seedIntent(fx, 'running');
    const intent = await seedIntent(fx);
    await ciRunnerAdmissionService.admit(intent);
    expect(await read(intent.id)).toMatchObject({ waitingReason: 'plan_cap' });

    await adminDb.ciRunnerProvisioningIntent.update({
      where: { id: blocker.id },
      data: { status: 'succeeded' },
    });
    vi.setSystemTime(T2);
    expect(await admitAgain(intent.id)).toMatchObject({ outcome: 'admitted' });
    expect(await read(intent.id)).toMatchObject({
      status: 'provisioning',
      waitingReason: null,
      waitingSince: null,
    });
  });

  it('a boot whose every account refused puts it back waiting for a full pool', async () => {
    const fx = await seedTenant();
    const intent = await seedIntent(fx);
    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({ outcome: 'admitted' });

    vi.setSystemTime(T2);
    await ciRunnerAdmissionService.releaseClaimForShardCapacity(intent.id, T2);
    expect(await read(intent.id)).toMatchObject({
      status: 'pending',
      waitingReason: 'shard_capacity',
      waitingSince: T2,
      shardCapacityDeferredAt: T2,
    });
  });
});

describe('a failed write never changes the verdict', () => {
  it('returns the decided plan_cap and logs the failure', async () => {
    const fx = await seedTenant(1);
    await seedIntent(fx, 'running');
    const intent = await seedIntent(fx);
    vi.spyOn(ciRunnerProvisioningIntentRepository, 'recordWaitingReasonInTx').mockRejectedValue(
      new Error('the write failed'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await ciRunnerAdmissionService.admit(intent)).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_cap',
    });
    expect(logged).toHaveBeenCalledWith(
      '[ciRunnerAdmissionService] could not record why an intent waits',
      expect.objectContaining({ intentId: intent.id, reason: 'plan_cap' }),
    );
    expect(await read(intent.id)).toMatchObject({ status: 'pending', waitingReason: null });
  });
});
