import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { PermissionDeniedError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { planSharpeningService } from '@/lib/services/planSharpeningService';
import { plansService } from '@/lib/services/plansService';
import { SHARPENED_BLOCK_START } from '@/lib/sharpening/managedBlock';
import { SharpeningInputInvalidError, SharpeningPlanClosedError } from '@/lib/sharpening/errors';
import type { SharpeningWriteBackInput } from '@/lib/dto/plans';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Task MOTIR-1101 · Subtask MOTIR-8175 — the Sharpen write-back service's two
// plan scope and its refusals, on a real Postgres. The work-item scope and the
// anchor leg are retired (Story MOTIR-9221 · MOTIR-9314).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const REQUIREMENT = {
  behaviour: '- What happens on export? — A CSV downloads.',
  acceptance: '- What if there are no invoices? — An empty-state message shows.',
};
const PLANNER = [{ question: 'Which date format?', recommendation: 'ISO 8601' }];

async function planWithAdd(
  fx: WorkItemFixture,
  { planned }: { planned: boolean },
): Promise<{ planId: string; itemId: string }> {
  const plan = await plansService.createPlan(
    fx.projectId,
    { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: {
          title: 'Export invoices',
          kind: 'task',
          difficulty: 'low',
          descriptionMd: 'Hand-written body.\n',
        },
      },
    ],
    fx.ctx,
  );
  if (planned) await plansService.markPlanned(plan.id, fx.ctx);
  return { planId: plan.id, itemId: appended.items[0]!.id };
}

async function bodyOfProposal(itemId: string): Promise<string> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  return ((row.proposedFields as Record<string, unknown>).descriptionMd as string) ?? '';
}

async function storedRequirement(planId: string): Promise<unknown> {
  return (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).sharpenedRequirement;
}

function planInput(planId: string, itemId?: string): SharpeningWriteBackInput {
  return {
    jobId: 'job-1',
    scope: { planId },
    requirement: REQUIREMENT,
    plannerAssumptions: PLANNER,
    ...(itemId
      ? {
          perItem: [
            {
              planItemId: itemId,
              acceptance: ['A CSV downloads'],
              assumptions: ['Invoices are already paginated'],
            },
          ],
        }
      : {}),
  };
}

describe('plan scope', () => {
  it.each([
    ['generating', false],
    ['planned', true],
  ])(
    'on a %s plan stores the requirement and writes each perItem body',
    async (_label, planned) => {
      const fx = await makeWorkItemFixture();
      const { planId, itemId } = await planWithAdd(fx, { planned });

      const result = await planSharpeningService.writeBack(planInput(planId, itemId), fx.ctx);
      expect(result.scope).toEqual({ planId });

      const plan = await plansService.getPlan(planId, fx.ctx);
      expect(plan.sharpenedRequirement).toEqual({
        ...REQUIREMENT,
        plannerAssumptions: PLANNER,
        settledAt: result.settledAt,
      });

      const body = await bodyOfProposal(itemId);
      expect(body.startsWith('Hand-written body.\n')).toBe(true);
      expect(count(body, SHARPENED_BLOCK_START)).toBe(2);
      expect(body).toMatch(/## Acceptance criteria\n\n<!-- motir:sharpened:start -->\n- A CSV/);
      expect(body).toMatch(/## Assumptions\n\n<!-- motir:sharpened:start -->\n- Invoices/);

      // The edit is on the plan's trail, under the person.
      const trail = await adminDb.planRevision.findMany({
        where: { planId, planItemId: itemId, changeKind: 'edited' },
      });
      expect(trail).toHaveLength(1);
      expect(trail[0]!.changedById).toBe(fx.ctx.userId);
      expect(trail[0]!.actorSource).toBeNull();
    },
  );

  it('is idempotent, and a superset replaces the block instead of adding one', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: true });

    await planSharpeningService.writeBack(planInput(planId, itemId), fx.ctx);
    const once = await bodyOfProposal(itemId);
    const firstStored = (await storedRequirement(planId)) as Record<string, unknown>;
    await planSharpeningService.writeBack(planInput(planId, itemId), fx.ctx);
    expect(await bodyOfProposal(itemId)).toBe(once);
    const { settledAt: _a, ...firstRest } = firstStored;
    const { settledAt: _b, ...secondRest } = (await storedRequirement(planId)) as Record<
      string,
      unknown
    >;
    void _a;
    void _b;
    expect(secondRest).toEqual(firstRest);

    const superset = planInput(planId, itemId);
    superset.perItem![0]!.acceptance.push('The file names the month');
    await planSharpeningService.writeBack(superset, fx.ctx);
    const after = await bodyOfProposal(itemId);
    expect(count(after, SHARPENED_BLOCK_START)).toBe(2);
    expect(after).toContain('- A CSV downloads\n- The file names the month');
  });

  it('writes to a stale plan, which the Sharpen door opens on', async () => {
    const fx = await makeWorkItemFixture();
    const { planId, itemId } = await planWithAdd(fx, { planned: true });
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
    await planSharpeningService.writeBack(planInput(planId, itemId), fx.ctx);
    expect(await storedRequirement(planId)).toMatchObject(REQUIREMENT);
  });

  it.each(['approved', 'declined'] as const)(
    'refuses a %s plan and writes nothing',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const { planId, itemId } = await planWithAdd(fx, { planned: true });
      await adminDb.plan.update({ where: { id: planId }, data: { status } });

      await expect(
        planSharpeningService.writeBack(planInput(planId, itemId), fx.ctx),
      ).rejects.toBeInstanceOf(SharpeningPlanClosedError);
      expect(await storedRequirement(planId)).toBeNull();
      expect(await bodyOfProposal(itemId)).toBe('Hand-written body.\n');
    },
  );

  it('refuses a perItem naming a modify proposal, and writes no part of the call', async () => {
    const fx = await makeWorkItemFixture();
    const target = await createTestWorkItem(fx, { kind: 'task', title: 'Existing' });
    const { planId, itemId } = await planWithAdd(fx, { planned: false });
    const modify = await plansService.addProposals(
      planId,
      [{ op: 'modify', workItemId: target.id, patch: { title: 'Renamed' } }],
      fx.ctx,
    );
    const modifyId = modify.items.find((i) => i.op === 'modify')!.id;

    const input = planInput(planId, itemId);
    input.perItem!.push({ planItemId: modifyId, acceptance: ['x'], assumptions: [] });
    await expect(planSharpeningService.writeBack(input, fx.ctx)).rejects.toBeInstanceOf(
      SharpeningInputInvalidError,
    );
    expect(await storedRequirement(planId)).toBeNull();
    expect(await bodyOfProposal(itemId)).toBe('Hand-written body.\n');
  });

  it("refuses a perItem naming another plan's proposal", async () => {
    const fx = await makeWorkItemFixture();
    const { planId } = await planWithAdd(fx, { planned: true });
    const other = await planWithAdd(fx, { planned: true });

    await expect(
      planSharpeningService.writeBack(planInput(planId, other.itemId), fx.ctx),
    ).rejects.toBeInstanceOf(SharpeningInputInvalidError);
    expect(await storedRequirement(planId)).toBeNull();
    expect(await bodyOfProposal(other.itemId)).toBe('Hand-written body.\n');
  });
});

describe('no work item is edited (Story MOTIR-9221 · MOTIR-9314)', () => {
  async function anchoredPlan(fx: WorkItemFixture, targetKeys: string[]): Promise<string> {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const session = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        scopeKey: targetKeys.join(','),
        targetKeys,
      },
    });
    await adminDb.plan.update({ where: { id: plan.id }, data: { sessionId: session.id } });
    return plan.id;
  }

  async function card(fx: WorkItemFixture) {
    const row = await createTestWorkItem(fx, { kind: 'task', title: 'Export invoices' });
    await adminDb.workItem.update({
      where: { id: row.id },
      data: { descriptionMd: 'Hand-written body.\n' },
    });
    return row;
  }

  async function bodyOf(id: string): Promise<string> {
    return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).descriptionMd ?? '';
  }

  it('a plan whose run targets a card lands on the plan alone: the card and its history are untouched', async () => {
    const fx = await makeWorkItemFixture();
    const anchor = await card(fx);
    const planId = await anchoredPlan(fx, [anchor.identifier]);

    const result = await planSharpeningService.writeBack(planInput(planId), fx.ctx);
    expect(result.scope).toEqual({ planId });
    expect(await storedRequirement(planId)).toMatchObject({
      ...REQUIREMENT,
      settledAt: result.settledAt,
    });
    expect(await bodyOf(anchor.id)).toBe('Hand-written body.\n');
    expect(await adminDb.workItemRevision.count({ where: { changeKind: 'updated' } })).toBe(0);
  });

  it('a finished target card no longer refuses the write-back', async () => {
    const fx = await makeWorkItemFixture();
    const anchor = await card(fx);
    await adminDb.workItem.update({ where: { id: anchor.id }, data: { status: 'done' } });
    const planId = await anchoredPlan(fx, [anchor.identifier]);
    await planSharpeningService.writeBack(planInput(planId), fx.ctx);
    expect(await storedRequirement(planId)).toMatchObject(REQUIREMENT);
    expect(await bodyOf(anchor.id)).toBe('Hand-written body.\n');
  });

  it('refuses a viewer, who may not view the plan,, and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await anchoredPlan(fx, []);
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    const err = await planSharpeningService
      .writeBack(planInput(planId), { userId: viewer.id, workspaceId: fx.workspaceId })
      .catch((e: unknown) => e);
    expect(err instanceof PermissionDeniedError || err instanceof ProjectAccessDeniedError).toBe(
      true,
    );
    expect(await storedRequirement(planId)).toBeNull();
  });

  it('no Sharpen code path writes a work item', () => {
    const files = [
      'lib/services/planSharpeningService.ts',
      'lib/services/aiSharpenService.ts',
      'app/api/internal/ai/plan-sharpening/route.ts',
      'app/api/ai/sharpen/route.ts',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/workItemsService\s*\.\s*updateWorkItem/);
      expect(src, f).not.toMatch(/workItemRepository\s*\.\s*update/);
    }
  });
});
