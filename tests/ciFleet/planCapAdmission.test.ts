import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import {
  fleetCeilingService,
  planCapDetail,
  PLAN_FIGURE_BY_WORKLOAD,
  type FleetSlotVerdict,
} from '@/lib/services/fleetCeilingService';
import { planCapsService, type PlanCapsAnswer } from '@/lib/services/planCapsService';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { capsForPlanKey } from '@/lib/billing/planCaps';
import { ciFleetAdmissionLockRepository } from '@/lib/repositories/ciFleetAdmissionLockRepository';
import { FLEET_WORKLOAD_KINDS, type FleetWorkloadKind } from '@/lib/ciFleet/workloads';
import { MOTIR_RUNNER_LABEL } from '@/lib/ciFleet/config';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';

// HOSTED-AGENT RUNS HELD TO THE PLAN'S PARALLEL-RUN FIGURE (Story MOTIR-9363 ·
// MOTIR-9373; decision MOTIR-9357) against real Postgres and the real `fleet`
// admission lock. The ONE seam stubbed is the plan read itself —
// `planCapsService.capsFor`, per organisation — whose own behaviour (the cache,
// the exemptions, fail-closed) `tests/services/planCapsService.test.ts` proves.
// An org with no stubbed answer falls through to the REAL read, which is how the
// exempt cases below are answered.

const NOW = new Date('2026-10-23T12:00:00.000Z');
const TTL_SECONDS = 3_600;

interface Fixture {
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function seedTenant(flags: { isMeta?: boolean; internalBilling?: boolean } = {}) {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `plan-cap-${suffix}@example.com`,
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
    identifier: `P${randomInt(100, 1000)}`,
  });
  if (flags.isMeta || flags.internalBilling) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: flags.isMeta ?? false, internalBilling: flags.internalBilling ?? false },
    });
  }
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    projectId: project.id,
  } satisfies Fixture;
}

const answers = new Map<string, PlanCapsAnswer>();

/** The org's plan, as `capsFor` will answer it — the catalog's real row. */
function onPlan(fx: Fixture, planKey: string, planName: string): void {
  const caps = capsForPlanKey(planKey);
  if (!caps) throw new Error(`no caps row for ${planKey}`);
  answers.set(fx.organizationId, { kind: 'capped', planKey, planName, caps });
}

let refSeq = 0;

async function reserve(
  workload: FleetWorkloadKind,
  fx: Fixture,
  ref = `run-${(refSeq += 1)}`,
): Promise<{ ref: string; verdict: FleetSlotVerdict }> {
  const verdict = await fleetCeilingService.reserve(
    {
      workload,
      ref,
      organizationId: fx.organizationId,
      workspaceId: fx.workspaceId,
      ttlSeconds: TTL_SECONDS,
    },
    NOW,
  );
  return { ref, verdict };
}

let jobSeq = 0;

async function seedRunningCi(fx: Fixture, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    jobSeq += 1;
    await adminDb.ciRunnerProvisioningIntent.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.organizationId,
        projectId: fx.projectId,
        installationId: '556677',
        runId: '9001',
        runAttempt: 1,
        jobId: String(70_000 + jobSeq),
        jobName: 'build',
        workflowName: 'CI',
        repoOwner: 'acme',
        repoName: 'acme-web',
        requestedLabels: [MOTIR_RUNNER_LABEL],
        queuedAt: NOW,
        status: 'running',
      },
    });
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.fleetInFlightSlot.deleteMany({});
  answers.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '');
  vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(true);
  const real = planCapsService.capsFor.bind(planCapsService);
  vi.spyOn(planCapsService, 'capsFor').mockImplementation(
    async (organizationId) => answers.get(organizationId) ?? real(organizationId),
  );
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await adminDb.fleetInFlightSlot.deleteMany({});
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a hosted-agent run is held to its plan’s parallel-run figure', () => {
  it.each([
    ['standard', 'Standard', 1],
    ['pro', 'Pro', 3],
    ['max', 'Max', 5],
    ['max_x2', 'Max ×2', 5],
  ])('a %s org reserves %#… exactly its figure, then plan_cap', async (key, name, figure) => {
    const fx = await seedTenant();
    onPlan(fx, key, name);
    for (let i = 0; i < figure; i += 1) {
      expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
        outcome: 'reserved',
        pool: figure,
      });
    }
    const { verdict } = await reserve('hosted_agent', fx);
    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_cap' });
    expect(await adminDb.fleetInFlightSlot.count({ where: { workload: 'hosted_agent' } })).toBe(
      figure,
    );
  });

  it('names the plan and the figure, never the retired pool', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'standard', 'Standard');
    await reserve('hosted_agent', fx);

    const { verdict } = await reserve('hosted_agent', fx);

    const detail = (verdict as { detail: string }).detail;
    expect(detail).toBe(
      'a Standard organization runs 1 agent run at once, and 1 is already running',
    );
    expect(detail).not.toContain('500');
    expect(detail).not.toContain('MOTIR_FLEET_ORG_MAX_IN_FLIGHT');
  });

  it('a released slot lets the next run through', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'standard', 'Standard');
    const { ref } = await reserve('hosted_agent', fx);
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });

    await fleetCeilingService.release('hosted_agent', ref);

    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ outcome: 'reserved' });
  });

  // The decision reads the hosted-agent count, never the cross-workload total.
  it('a CI burst and agent instances far above the figure do not stop the first agent run', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'standard', 'Standard');
    await seedRunningCi(fx, 40);
    for (let i = 0; i < 6; i += 1) await reserve('agent_instance', fx);

    const { verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({
      outcome: 'reserved',
      pool: 1,
      census: { byWorkload: { ci_runner: 40, hosted_agent: 0 } },
    });
  });

  // MUTATION-CHECK: delete the `lockScope` call in `reserve` and this goes red.
  it('two concurrent runs for one Standard org reserve exactly one', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'standard', 'Standard');

    const verdicts = await Promise.all([
      reserve('hosted_agent', fx).then((r) => r.verdict),
      reserve('hosted_agent', fx).then((r) => r.verdict),
    ]);

    expect(verdicts.filter((v) => v.outcome === 'reserved')).toHaveLength(1);
    expect(
      verdicts.filter((v) => v.outcome === 'deferred' && v.reason === 'plan_cap'),
    ).toHaveLength(1);
    expect(await adminDb.fleetInFlightSlot.count({ where: { workload: 'hosted_agent' } })).toBe(1);
  });

  it('takes the fleet admission lock for every hosted reservation', async () => {
    const lock = vi.spyOn(ciFleetAdmissionLockRepository, 'lockScope');
    const fx = await seedTenant();
    onPlan(fx, 'pro', 'Pro');
    await reserve('hosted_agent', fx);
    expect(lock).toHaveBeenCalled();
  });
});

describe('an unreadable plan defers, and never defaults', () => {
  it('defers plan_unknown naming a key with no caps row', async () => {
    const fx = await seedTenant();
    answers.set(fx.organizationId, { kind: 'plan_unknown', planKey: 'legacy_tier' });

    const { verdict } = await reserve('hosted_agent', fx);

    expect(verdict).toMatchObject({ outcome: 'deferred', reason: 'plan_unknown' });
    expect((verdict as { detail: string }).detail).toContain('legacy_tier');
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });

  it('defers plan_unknown when the plan could not be read at all', async () => {
    const fx = await seedTenant();
    answers.set(fx.organizationId, { kind: 'plan_unknown', planKey: null });

    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'plan_unknown',
    });
    expect(await adminDb.fleetInFlightSlot.count()).toBe(0);
  });
});

describe('Motir’s own organisations are held by no plan figure', () => {
  it.each([{ isMeta: true }, { internalBilling: true }])(
    'an org with %o reserves past Max’s 5, from the REAL plan read',
    async (flags) => {
      const fx = await seedTenant(flags);
      for (let i = 0; i < 7; i += 1) {
        expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
          outcome: 'reserved',
          pool: null,
        });
      }
    },
  );

  it('the kill switch still stops them', async () => {
    const fx = await seedTenant({ isMeta: true });
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({
      outcome: 'deferred',
      reason: 'fleet_ceiling',
    });
  });
});

describe('the retired pool no longer reaches a hosted run', () => {
  it('fleetPoolCap=0 (the CI override) changes no hosted verdict', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'pro', 'Pro');
    await adminDb.organization.update({
      where: { id: fx.organizationId },
      data: { fleetPoolCap: 0 },
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ outcome: 'reserved' });
    }
    expect((await reserve('hosted_agent', fx)).verdict).toMatchObject({ reason: 'plan_cap' });
  });
});

describe('an agent instance is still decided by its guard alone', () => {
  it('reads no plan figure and lets the guard decide', async () => {
    const fx = await seedTenant();
    onPlan(fx, 'standard', 'Standard');
    const capsFor = vi.mocked(planCapsService.capsFor);
    capsFor.mockClear();

    const admitted = await fleetCeilingService.reserve(
      {
        workload: 'agent_instance',
        ref: 'inst-1',
        organizationId: fx.organizationId,
        guard: async () => null,
      },
      NOW,
    );
    const refused = await fleetCeilingService.reserve(
      {
        workload: 'agent_instance',
        ref: 'inst-2',
        organizationId: fx.organizationId,
        guard: async () => 'the org runs its 5 agents',
      },
      NOW,
    );

    expect(admitted).toMatchObject({ outcome: 'reserved', pool: null });
    expect(refused).toMatchObject({
      outcome: 'deferred',
      reason: 'workload_cap',
      detail: 'the org runs its 5 agents',
    });
    expect(capsFor).not.toHaveBeenCalled();
  });
});

describe('PLAN_FIGURE_BY_WORKLOAD and the deferral words', () => {
  it('has an entry for every fleet workload', () => {
    for (const kind of FLEET_WORKLOAD_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(PLAN_FIGURE_BY_WORKLOAD, kind), kind).toBe(true);
    }
    expect(PLAN_FIGURE_BY_WORKLOAD.hosted_agent).toBe('agentRunsInParallel');
    expect(PLAN_FIGURE_BY_WORKLOAD.ci_runner).toBe('ciBurstCap');
  });

  it('counts in the workload’s own noun, singular and plural', () => {
    expect(planCapDetail('Pro', 3, 'hosted_agent', 3)).toBe(
      'a Pro organization runs 3 agent runs at once, and 3 are already running',
    );
    expect(planCapDetail('Max', 25, 'ci_runner', 25)).toBe(
      'a Max organization runs 25 CI jobs at once, and 25 are already running',
    );
  });
});
