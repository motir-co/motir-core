import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { agentInstanceLifecycleService as lifecycle } from '@/lib/services/agentInstanceLifecycleService';
import { _resetPlanCapsCache, planCapsService } from '@/lib/services/planCapsService';
import { AgentInstanceStartRefusedError } from '@/lib/agentInstances/errors';
import { mapAgentInstanceError } from '@/lib/agentInstances/errorResponse';
import { refusalKey } from '@/app/(authed)/my-agents/_components/agentRefusal';
import { adminDb } from '../helpers/adminDb';
import { fleet, fx, otherMember, setUpHarness, slots, stub, tearDownHarness } from './_harness';

// AGENTS HELD TO THE PLAN'S FIGURES (Story MOTIR-9363 · MOTIR-9374) — create and
// wake judged against the org's `agentsPerUser` (at create) and
// `agentsRunningPerOrg` (at create and wake, under the fleet admission lock), over
// real Postgres and the fake persistent fleet. The plan is the REAL read: the
// harness's motir-ai stub answers the subscription with the plan tier named here,
// and `planCapsService` turns its key into the real figures.
//
// ⚠️ THE ABSENCES ARE THE ASSERTIONS for every refusal: no slot left held and no
// machine provisioned.

const TIERS = {
  standard: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 3_000 },
  pro: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 },
  legacy: { key: 'legacy_tier', name: 'Legacy', monthlyCreditAllotment: 0 },
  pool2400k: { key: 'pool_2400k', name: 'Pool 2,400,000', monthlyCreditAllotment: 2_400_000 },
};

function onPlan(tier: (typeof TIERS)[keyof typeof TIERS] | null): void {
  stub.planTier = tier;
  _resetPlanCapsCache();
}

const create = (name: string, ctx = fx.ctx) =>
  lifecycle.create(fx.projectIdentifier, { name, profileId: 'claude' }, ctx);

let seeded = 0;
/** `count` agents already running in the org, owned by someone else. */
async function seedRunning(count: number): Promise<void> {
  const owner = await otherMember();
  for (let i = 0; i < count; i++) {
    seeded += 1;
    await adminDb.agentInstance.create({
      data: {
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        projectId: fx.projectId,
        ownerId: owner.userId,
        name: `seeded-${seeded}`,
        profileId: 'claude',
        imageTag: 't',
        imageDigest: 'sha256:x',
        region: 'iad',
        state: 'running',
      },
    });
  }
}

/** Another member of the workspace, as a service context. */
async function memberCtx() {
  const other = await otherMember();
  return { ...fx.ctx, userId: other.userId };
}

async function expectNothingTaken(slotsBefore: number, provisionedBefore: number) {
  expect(await slots()).toHaveLength(slotsBefore);
  expect(fleet.persistentSpecs).toHaveLength(provisionedBefore);
}

beforeEach(setUpHarness);
afterEach(tearDownHarness);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('per person, at create — the plan’s agentsPerUser', () => {
  it('Standard (1): the first create succeeds and the second is refused, naming the plan and 1 agent', async () => {
    onPlan(TIERS.standard);
    expect((await create('one')).state).toBe('running');
    const provisioned = fleet.persistentSpecs.length;

    const refused = await create('two').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AgentInstanceStartRefusedError);
    expect(refused).toMatchObject({ reason: 'user_cap', limit: 1, planName: 'Standard' });
    const message = (refused as Error).message;
    expect(message).toContain('Standard');
    expect(message).toContain('1 agent');
    await expectNothingTaken(1, provisioned);
  });

  it('Pro (5): the fifth create succeeds and the sixth is refused with limit 5', async () => {
    onPlan(TIERS.pro);
    for (let i = 1; i <= 5; i++) expect((await create(`a-${i}`)).state).toBe('running');
    await expect(create('a-6')).rejects.toMatchObject({
      reason: 'user_cap',
      limit: 5,
      planName: 'Pro',
      message: expect.stringContaining('Pro plan allows 5 agents per person'),
    });
    expect(await slots()).toHaveLength(5);
  });

  it('a larger pool plan (10, MOTIR-9653): the tenth create succeeds and the eleventh is refused, naming the plan', async () => {
    onPlan(TIERS.pool2400k);
    for (let i = 1; i <= 10; i++) expect((await create(`p-${i}`)).state).toBe('running');
    await expect(create('p-11')).rejects.toMatchObject({
      reason: 'user_cap',
      limit: 10,
      planName: 'Pool 2,400,000',
      message: expect.stringContaining('Pool 2,400,000'),
    });
    expect(await slots()).toHaveLength(10);
  });
});

describe('running per org, at create and wake — the plan’s agentsRunningPerOrg, under the lock', () => {
  it('Standard (5): with 5 running, a wake and a create are each refused, naming the plan and 5, and leave no slot', async () => {
    onPlan(TIERS.standard);
    const mine = await create('mine');
    await lifecycle.hibernate(fx.projectIdentifier, mine.id, fx.ctx);
    await seedRunning(5);
    const provisioned = fleet.persistentSpecs.length;

    const words = expect.stringContaining('Standard plan runs 5 agents at once, and 5 are running');
    await expect(lifecycle.wake(fx.projectIdentifier, mine.id, fx.ctx)).rejects.toMatchObject({
      reason: 'org_running_cap',
      limit: 5,
      planName: 'Standard',
      message: words,
    });
    await expect(create('theirs', await memberCtx())).rejects.toMatchObject({
      reason: 'org_running_cap',
      limit: 5,
      planName: 'Standard',
      message: words,
    });
    await expectNothingTaken(0, provisioned);
  });

  it('two concurrent wakes one below the figure: exactly one is admitted', async () => {
    onPlan(TIERS.pro); // 30 running
    const a = await create('a');
    const b = await create('b');
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    await lifecycle.hibernate(fx.projectIdentifier, b.id, fx.ctx);
    await seedRunning(29);

    const results = await Promise.allSettled([
      lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx),
      lifecycle.wake(fx.projectIdentifier, b.id, fx.ctx),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'org_running_cap',
      limit: 30,
    });
    expect(await slots()).toHaveLength(1);
  });

  it('MOTIR_INSTANCE_MAX_RUNNING no longer sets any limit', async () => {
    vi.stubEnv('MOTIR_INSTANCE_MAX_RUNNING', '1');
    expect((await create('one')).state).toBe('running');
    expect((await create('two')).state).toBe('running');
  });

  it('the kill switch still refuses a capped org’s wake as fleet_busy', async () => {
    onPlan(TIERS.pro);
    const a = await create('a');
    await lifecycle.hibernate(fx.projectIdentifier, a.id, fx.ctx);
    vi.stubEnv('MOTIR_FLEET_MAX_IN_FLIGHT', '0');
    await expect(lifecycle.wake(fx.projectIdentifier, a.id, fx.ctx)).rejects.toMatchObject({
      reason: 'fleet_busy',
    });
  });
});

describe('a plan with no figures is refused — never a default', () => {
  it.each([
    ['the plan cannot be read (no tier)', null],
    ['the key has no row', TIERS.legacy],
  ] as const)(
    '%s: create and wake refuse plan_unknown before any slot or machine',
    async (_, tier) => {
      const mine = await create('mine');
      await lifecycle.hibernate(fx.projectIdentifier, mine.id, fx.ctx);
      const provisioned = fleet.persistentSpecs.length;
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      onPlan(tier);

      const words = expect.stringContaining('could not read the agent limits');
      await expect(create('two')).rejects.toMatchObject({ reason: 'plan_unknown', message: words });
      await expect(lifecycle.wake(fx.projectIdentifier, mine.id, fx.ctx)).rejects.toMatchObject({
        reason: 'plan_unknown',
        message: words,
      });
      await expectNothingTaken(0, provisioned);
      expect(
        logged.mock.calls.some(
          (call) =>
            String(call[0]).includes('no agent figures') &&
            (call[1] as { planKey: string | null }).planKey === (tier?.key ?? null),
        ),
      ).toBe(true);
    },
  );

  it('answers 503 like ai_plan_unknown, with the words, and My agents renders its own words', async () => {
    const res = mapAgentInstanceError(
      new AgentInstanceStartRefusedError('plan_unknown', 'the words'),
    )!;
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reason: 'plan_unknown', error: 'the words' });
    expect(refusalKey({ reason: 'plan_unknown' })).toBe('aiPlanUnknown');
    expect(refusalKey({ reason: 'plan_unknown' })).not.toBe('generic');
  });
});

describe('exempt and the gates before the plan', () => {
  it('an exempt org creates past 10 per person and runs past 50', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });
    await seedRunning(50);
    for (let i = 0; i < 11; i++) expect((await create(`e-${i}`)).state).toBe('running');
  });

  it('no paid plan refuses ai_plan_required, and an unreadable gate ai_plan_unknown — before the plan-caps read', async () => {
    const caps = vi.spyOn(planCapsService, 'capsFor');
    stub.plan = null;
    await expect(create('one')).rejects.toMatchObject({ reason: 'ai_plan_required' });
    _resetPlanCapsCache();
    stub.plan = 'unanswerable';
    await expect(create('one')).rejects.toMatchObject({ reason: 'ai_plan_unknown' });
    expect(caps).not.toHaveBeenCalled();
  });

  it('a capped org out of credits is still refused credits', async () => {
    onPlan(TIERS.pro);
    stub.mayRun = false;
    await expect(create('one')).rejects.toMatchObject({ reason: 'credits' });
  });
});
