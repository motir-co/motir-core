import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { orgPlanFiguresService } from '@/lib/services/orgPlanFiguresService';
import { planCapsService } from '@/lib/services/planCapsService';
import { fleetCeilingService } from '@/lib/services/fleetCeilingService';
import { organizationRepository } from '@/lib/repositories/organizationRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomInt } from '../helpers/random';
import { stubPaidAiPlan } from '../helpers/paidAiPlan';

// ONE PLAN-FIGURES READ (Story MOTIR-9368 · MOTIR-9659) — `figuresFor` answers
// every shape the platform fleet monitor showed from its private `readPlan`, read
// through the same two lookups the admissions read. Real Postgres for the staff
// CI override; the plan is stubbed at `planCapsService.capsFor` with its REAL row
// (`tests/helpers/paidAiPlan.ts`), as the CI burst-cap suite does.

async function seedOrg(fleetPoolCap?: number): Promise<string> {
  const suffix = randomInt(1_000_000);
  const user = await usersService.createUser({
    email: `plan-figures-${suffix}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${suffix}`,
    ownerUserId: user.id,
  });
  if (fleetPoolCap !== undefined) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { fleetPoolCap },
    });
  }
  return workspace.organizationId;
}

const exempt = () => vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({ kind: 'exempt' });

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a paid org on a plan with a caps row', () => {
  it('reads capped, with the agent figures from capsFor and CI from resolveCiBurstCap', async () => {
    stubPaidAiPlan('pro');
    const orgId = await seedOrg();
    const caps = await planCapsService.capsFor(orgId);
    const ci = await fleetCeilingService.resolveCiBurstCap(orgId);
    if (caps.kind !== 'capped' || ci.kind !== 'capped') throw new Error('expected capped');

    expect(await orgPlanFiguresService.figuresFor(orgId)).toEqual({
      kind: 'capped',
      planKey: caps.planKey,
      planName: caps.planName,
      agentRunsInParallel: caps.caps.agentRunsInParallel,
      agentsPerUser: caps.caps.agentsPerUser,
      agentsPerOrg: caps.caps.agentsPerOrg,
      ciBurstCap: ci.figure,
      ciBurstSource: 'plan',
    });
  });

  it('reads the staff override as its CI figure, with source override', async () => {
    stubPaidAiPlan('pro');
    const orgId = await seedOrg(3);
    expect(await orgPlanFiguresService.figuresFor(orgId)).toMatchObject({
      kind: 'capped',
      ciBurstCap: 3,
      ciBurstSource: 'override',
    });
  });

  it('an override read that fails reads ciBurstCap null, source unreadable', async () => {
    stubPaidAiPlan('pro');
    const orgId = await seedOrg();
    vi.spyOn(organizationRepository, 'findFleetPoolCapInTx').mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await orgPlanFiguresService.figuresFor(orgId)).toMatchObject({
      kind: 'capped',
      planKey: 'pro',
      ciBurstCap: null,
      ciBurstSource: 'unreadable',
    });
  });
});

describe("Motir's own orgs", () => {
  it('an exempt org with a staff override carries it', async () => {
    exempt();
    const orgId = await seedOrg(7);
    expect(await orgPlanFiguresService.figuresFor(orgId)).toEqual({
      kind: 'exempt',
      ciBurstOverride: 7,
    });
  });

  it('an exempt org with no override reads null', async () => {
    exempt();
    const orgId = await seedOrg();
    expect(await orgPlanFiguresService.figuresFor(orgId)).toEqual({
      kind: 'exempt',
      ciBurstOverride: null,
    });
  });
});

describe('a plan nobody could read', () => {
  it('carries the key when the plan had one', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
      kind: 'plan_unknown',
      planKey: 'retired_plan',
    });
    const orgId = await seedOrg();
    expect(await orgPlanFiguresService.figuresFor(orgId)).toEqual({
      kind: 'plan_unknown',
      planKey: 'retired_plan',
    });
  });

  it('carries null when it had none', async () => {
    vi.spyOn(planCapsService, 'capsFor').mockResolvedValue({
      kind: 'plan_unknown',
      planKey: null,
    });
    const orgId = await seedOrg();
    expect(await orgPlanFiguresService.figuresFor(orgId)).toEqual({
      kind: 'plan_unknown',
      planKey: null,
    });
  });

  it.each([
    ['capsFor', () => vi.spyOn(planCapsService, 'capsFor')],
    ['resolveCiBurstCap', () => vi.spyOn(fleetCeilingService, 'resolveCiBurstCap')],
  ] as const)('a throw from %s reads plan_unknown with no key, logged', async (_, spy) => {
    stubPaidAiPlan('pro');
    const orgId = await seedOrg();
    spy().mockRejectedValue(new Error('lookup failed'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(orgPlanFiguresService.figuresFor(orgId)).resolves.toEqual({
      kind: 'plan_unknown',
      planKey: null,
    });
    expect(logged).toHaveBeenCalledWith(
      "[orgPlanFiguresService] could not read the organization's plan",
      expect.objectContaining({ organizationId: orgId, detail: 'lookup failed' }),
    );
  });
});
