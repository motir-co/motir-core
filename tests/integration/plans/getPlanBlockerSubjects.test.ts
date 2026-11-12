import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { presentMcpPlan, presentMcpPlanAppend } from '@/lib/mcp/payloads/workLoop';
import type { PlanWithItemsDto } from '@/lib/dto/plans';
import { makeWorkItemFixture, createTestProject, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11053 — `get_plan` says what each blocked-by
// ref a proposal draws IS: the committed blocker's stored `subject`, keyed by the
// ref exactly as the item carries it. Real Postgres, real services, the real tool.

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

async function card(fx: WorkItemFixture, title: string, subject: string | null = null) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  if (subject !== null) {
    await adminDb.workItem.update({ where: { id: item.id }, data: { subject } });
  }
  return item;
}

/** A plan whose `add` waits on an init card and a plain card plus a temp ref, and
 *  whose `modify` adds an edge to the init card. */
async function seededPlan(fx: WorkItemFixture) {
  const init = await card(fx, 'Create acme-infra', 'init');
  const plain = await card(fx, 'Plain');
  const target = await card(fx, 'Existing');
  const plan = await plansService.createPlan(fx.projectId, { title: 'Later plan' }, fx.ctx);
  const first = await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'Prerequisite', kind: 'task' } }],
    fx.ctx,
  );
  const tempRef = `planItem:${first.items[0]!.id}`;
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Waiter', kind: 'task' },
        blockedByRefs: [init.id, plain.id, tempRef],
      },
      { op: 'add', proposedFields: { title: 'Temp only', kind: 'task' }, blockedByRefs: [tempRef] },
      { op: 'modify', workItemId: target.id, patch: { blockedByAdd: [init.id] } },
    ],
    fx.ctx,
  );
  return { plan: await plansService.getPlan(plan.id, fx.ctx), init, plain, tempRef };
}

function itemTitled(plan: PlanWithItemsDto, title: string) {
  return plan.items.find((i) => i.proposedFields?.title === title)!;
}

describe('planReviewService.resolveProposalBlockerSubjects', () => {
  it('maps every real ref on blockedByRefs and blockedByAdd to its subject, null for none', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, init, plain, tempRef } = await seededPlan(fx);

    const map = await planReviewService.resolveProposalBlockerSubjects(plan, fx.ctx);

    expect(Object.fromEntries(map)).toEqual({ [init.id]: 'init', [plain.id]: null });
    expect(map.has(tempRef)).toBe(false);
  });

  it('produces no entry for another project, another workspace or an unknown id', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const { plan, init, plain } = await seededPlan(fx);
    const sibling = await createTestProject({
      workspaceId: fx.ctx.workspaceId,
      actorUserId: fx.ctx.userId,
      identifier: 'SIBL',
      name: 'Sibling',
    });
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: sibling.id, kind: 'task', title: 'Other project' },
      fx.ctx,
    );
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Other workspace' },
      other.ctx,
    );
    await adminDb.workItem.updateMany({
      where: { id: { in: [elsewhere.id, foreign.id] } },
      data: { subject: 'init' },
    });
    const widened: PlanWithItemsDto = {
      ...plan,
      items: [
        ...plan.items,
        {
          ...plan.items[0]!,
          id: 'pi_synthetic',
          blockedByRefs: [elsewhere.id, foreign.id, 'no-such-id'],
        },
      ],
    };

    const map = await planReviewService.resolveProposalBlockerSubjects(widened, fx.ctx);

    expect(Object.fromEntries(map)).toEqual({ [init.id]: 'init', [plain.id]: null });
    for (const id of [elsewhere.id, foreign.id, 'no-such-id']) expect(map.has(id)).toBe(false);
  });

  it('makes ONE batched read for the plan, and none when no ref is real', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seededPlan(fx);
    const spy = vi.spyOn(workItemRepository, 'findByIdsInWorkspace');

    await planReviewService.resolveProposalBlockerSubjects(plan, fx.ctx);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    const tempOnly = { ...plan, items: [itemTitled(plan, 'Temp only')] };
    expect(await planReviewService.resolveProposalBlockerSubjects(tempOnly, fx.ctx)).toEqual(
      new Map(),
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('get_plan carries blockerSubjects', () => {
  it('maps each item’s own refs, an empty object for an item drawing only temp refs', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, init, plain } = await seededPlan(fx);

    const result = await runGetPlan({ planId: plan.id }, fx.ctx);
    const items = (result.structuredContent as { items: Array<Record<string, unknown>> }).items;
    const byId = new Map(items.map((i) => [i['id'] as string, i]));

    expect(byId.get(itemTitled(plan, 'Waiter').id)!['blockerSubjects']).toEqual({
      [init.id]: 'init',
      [plain.id]: null,
    });
    expect(byId.get(itemTitled(plan, 'Temp only').id)!['blockerSubjects']).toEqual({});
    expect(byId.get(itemTitled(plan, 'Prerequisite').id)!['blockerSubjects']).toEqual({});
    const modify = plan.items.find((i) => i.op === 'modify')!;
    expect(byId.get(modify.id)!['blockerSubjects']).toEqual({ [init.id]: 'init' });
  });

  it('is otherwise byte-identical to the payload without it', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seededPlan(fx);

    const result = await runGetPlan({ planId: plan.id }, fx.ctx);
    const content = result.structuredContent as { items: Array<Record<string, unknown>> };
    const stripped = content.items.map(({ blockerSubjects: _drop, ...rest }) => rest);
    const folders = await planReviewService.resolveProposalFolders(plan, fx.ctx);
    const without = presentMcpPlan(plan, folders);

    expect(stripped).toEqual(JSON.parse(JSON.stringify(without.items)));
    expect((content as unknown as { itemCount: number }).itemCount).toBe(without.itemCount);
  });

  it('degrades to NO key — never an empty map — when the resolution fails', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seededPlan(fx);
    vi.spyOn(planReviewService, 'resolveProposalBlockerSubjects').mockRejectedValueOnce(
      new Error('read failed'),
    );

    const result = await runGetPlan({ planId: plan.id }, fx.ctx);
    const items = (result.structuredContent as { items: Array<Record<string, unknown>> }).items;
    for (const item of items) expect(item).not.toHaveProperty('blockerSubjects');
  });

  it('the append door passes no map, so its items carry no blockerSubjects', async () => {
    const fx = await makeWorkItemFixture();
    const { plan } = await seededPlan(fx);

    const append = presentMcpPlanAppend(plan, []);
    for (const item of append.items as Array<Record<string, unknown>>) {
      expect(item).not.toHaveProperty('blockerSubjects');
    }
  });
});
