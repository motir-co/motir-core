import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { mintJobToken } from '@/lib/ai/jobToken';
import { GET as getItemGET } from '@/app/api/internal/ai/get-item/route';
import { GET as getSubtreeGET } from '@/app/api/internal/ai/get-subtree/route';
import type { GetItemResponse, SubtreeResponse } from '@/lib/dto/ai';
import type { PlanItemPatch } from '@/lib/dto/plans';
import type { WorkItemDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// CONTRACT TEST (bug MOTIR-11340) — a PLANNING read of a committed card answers
// the card as the JOB'S OWN plan leaves it, through the REAL `get-item` and
// `get-subtree` routes against real Postgres.
//
// The defect: the hosted final check read MOTIR-11009 with `get_item` while its
// plan carried a `modify` rewriting it, got the STORED body, and judged (and
// repaired) the plan against the text the plan was replacing. The route took no
// job at all. Now `?jobId=` finds the job's plan by `sourceJobId`, exactly as
// `plan-proposals` does, and answers the patched card marked as PROPOSED — while
// a read with no jobId, a job with no plan, another job's plan, a decided plan
// and a card the plan does not touch all answer the committed card unchanged.

const SERVICE_SECRET = 'core-callback-secret-test';
const JOB = 'job_overlay_walk';

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fx = Awaited<ReturnType<typeof makeFixture>>;

function get(fx: Fx, path: string, query: Record<string, string>): Request {
  const url = new URL(`http://core/api/internal/ai/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, {
    headers: {
      authorization: `Bearer ${SERVICE_SECRET}`,
      'x-motir-job-token': mintJobToken({
        userId: fx.ctx.userId,
        workspaceId: fx.ctx.workspaceId,
        projectId: fx.projectId,
      }),
    },
  });
}

async function readItem(fx: Fx, query: Record<string, string>): Promise<GetItemResponse> {
  const res = await getItemGET(get(fx, 'get-item', query));
  expect(res.status).toBe(200);
  return (await res.json()) as GetItemResponse;
}

async function readSubtree(fx: Fx, query: Record<string, string>): Promise<SubtreeResponse> {
  const res = await getSubtreeGET(get(fx, 'get-subtree', query));
  expect(res.status).toBe(200);
  return (await res.json()) as SubtreeResponse;
}

const OLD_BODY = 'reads the shared setting as the maximum, not as one default for all five';
const NEW_BODY =
  'its radius is read from TRAVERSAL_DEPTH_DEFAULT and clamped to TRAVERSAL_DEPTH_MAX';

/** An epic with three stories: the traversal story (rewritten by the plan), a
 *  sibling the plan only re-wires and marks, and one the plan removes. */
async function seed(fx: Fx): Promise<{
  epic: WorkItemDto;
  traversal: WorkItemDto;
  rewired: WorkItemDto;
  removed: WorkItemDto;
  untouched: WorkItemDto;
}> {
  const create = (kind: 'epic' | 'story', title: string, parentId?: string, body?: string) =>
    workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind,
        title,
        ...(parentId ? { parentId } : {}),
        ...(body ? { descriptionMd: body } : {}),
      },
      fx.ctx,
    );
  const epic = await create('epic', 'Code graph reads');
  const traversal = await create('story', 'Traversal reads', epic.id, OLD_BODY);
  const rewired = await create('story', 'Depth setting', epic.id, 'The shared depth setting.');
  const removed = await create('story', 'Old fan-out', epic.id, 'Gone.');
  const untouched = await create('story', 'Grep reads', epic.id, 'Unchanged.');
  return { epic, traversal, rewired, removed, untouched };
}

async function seedPlan(
  fx: Fx,
  items: Array<{ op: 'modify' | 'remove'; workItemId: string; patch?: PlanItemPatch }>,
  opts: { sourceJobId?: string; status?: 'generating' | 'planned' | 'approved' | 'declined' } = {},
): Promise<{ planId: string; itemIds: string[] }> {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status: opts.status ?? 'generating',
      sourceJobId: opts.sourceJobId ?? JOB,
    },
  });
  const itemIds: string[] = [];
  for (const it of items) {
    const row = await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: it.op,
        workItemId: it.workItemId,
        ...(it.patch ? { patch: it.patch as object } : {}),
        blockedByRefs: [],
      },
    });
    itemIds.push(row.id);
  }
  return { planId: plan.id, itemIds };
}

describe('get-item ?jobId= answers a committed card as the job’s plan leaves it (MOTIR-11340)', () => {
  it('a card the plan modifies comes back patched, marked proposed, with the committed text beside it', async () => {
    const fx = await makeFixture();
    const { traversal } = await seed(fx);
    const { planId, itemIds } = await seedPlan(fx, [
      {
        op: 'modify',
        workItemId: traversal.id,
        patch: { title: 'Traversal reads use the shared default', descriptionMd: NEW_BODY },
      },
    ]);

    const body = await readItem(fx, { key: traversal.identifier, jobId: JOB });

    expect(body.item.descriptionMd).toBe(NEW_BODY);
    expect(body.item.title).toBe('Traversal reads use the shared default');
    expect(body.item.identifier).toBe(traversal.identifier);
    expect(body.planProposal).toMatchObject({
      planId,
      planStatus: 'generating',
      planItemId: itemIds[0],
      op: 'modify',
      approved: false,
      committed: { title: 'Traversal reads', descriptionMd: OLD_BODY },
    });
    expect(body.planProposal?.patch).toMatchObject({ descriptionMd: NEW_BODY });
    // The anchor the patch was written against stays the committed revision.
    expect(body.planProposal).toHaveProperty('committedRevision');
    // A body-only modify draws no projected edges or parent.
    expect(body.planProposal).not.toHaveProperty('projectedBlockedBy');
    expect(body.planProposal).not.toHaveProperty('projectedParent');
    // The replaced phrase is nowhere in what the planner is handed as the card.
    expect(JSON.stringify(body.item)).not.toContain('the maximum');
  });

  it('without jobId, or for a card the plan does not modify, the committed card is unchanged', async () => {
    const fx = await makeFixture();
    const { traversal, untouched } = await seed(fx);
    await seedPlan(fx, [
      { op: 'modify', workItemId: traversal.id, patch: { descriptionMd: NEW_BODY } },
    ]);

    const plain = await readItem(fx, { key: traversal.identifier });
    expect(plain.item.descriptionMd).toBe(OLD_BODY);
    expect(plain).not.toHaveProperty('planProposal');

    const other = await readItem(fx, { key: untouched.identifier, jobId: JOB });
    expect(other.item.descriptionMd).toBe('Unchanged.');
    expect(other).not.toHaveProperty('planProposal');
  });

  it('a job with no plan, another job’s plan, and a decided plan all leave the card committed', async () => {
    const fx = await makeFixture();
    const { traversal } = await seed(fx);
    await seedPlan(
      fx,
      [{ op: 'modify', workItemId: traversal.id, patch: { descriptionMd: NEW_BODY } }],
      {
        sourceJobId: 'job_someone_else',
      },
    );

    for (const jobId of ['job_with_no_plan', JOB]) {
      const body = await readItem(fx, { key: traversal.identifier, jobId });
      expect(body.item.descriptionMd).toBe(OLD_BODY);
      expect(body).not.toHaveProperty('planProposal');
    }

    for (const status of ['approved', 'declined'] as const) {
      const jobId = `job_${status}`;
      await seedPlan(
        fx,
        [{ op: 'modify', workItemId: traversal.id, patch: { descriptionMd: NEW_BODY } }],
        { sourceJobId: jobId, status },
      );
      const body = await readItem(fx, { key: traversal.identifier, jobId });
      expect(body.item.descriptionMd).toBe(OLD_BODY);
      expect(body).not.toHaveProperty('planProposal');
    }
  });

  it('a modify that sets only edges and a mark keeps the committed body and shows the proposed edges and mark', async () => {
    const fx = await makeFixture();
    const { traversal, rewired, untouched } = await seed(fx);
    await seedPlan(fx, [
      {
        op: 'modify',
        workItemId: rewired.id,
        patch: {
          blockedByAdd: [traversal.id, untouched.id],
          obsolescence: 'outdated',
          obsolescenceNoteMd: 'The default moved into the traversal story.',
        },
      },
    ]);

    const body = await readItem(fx, { key: rewired.identifier, jobId: JOB });
    expect(body.item.descriptionMd).toBe('The shared depth setting.');
    expect(body.item.title).toBe('Depth setting');
    expect(body.item.obsolescence).toBe('outdated');
    expect(body.item.obsolescenceNoteMd).toBe('The default moved into the traversal story.');
    expect(body.planProposal?.committed).toEqual({ obsolescence: null, obsolescenceNoteMd: null });
    expect([...(body.planProposal?.projectedBlockedBy ?? [])].sort()).toEqual(
      [traversal.identifier, untouched.identifier].sort(),
    );
  });

  it('a modify that re-parents names the projected parent, and a stray null title keeps the stored title', async () => {
    const fx = await makeFixture();
    const { traversal } = await seed(fx);
    await seedPlan(fx, [
      {
        op: 'modify',
        workItemId: traversal.id,
        patch: { parentRef: null, title: null as unknown as string, explanationMd: null },
      },
    ]);

    const body = await readItem(fx, { key: traversal.identifier, jobId: JOB });
    expect(body.item.title).toBe('Traversal reads');
    expect(body.item.explanationMd).toBeNull();
    expect(body.planProposal?.projectedParent).toBeNull();
    expect(body.planProposal?.committed).toEqual({ explanationMd: null });
  });

  it('a card the plan removes stays committed and says the plan removes it', async () => {
    const fx = await makeFixture();
    const { removed } = await seed(fx);
    const { itemIds } = await seedPlan(fx, [{ op: 'remove', workItemId: removed.id }]);

    const body = await readItem(fx, { key: removed.identifier, jobId: JOB });
    expect(body.item.descriptionMd).toBe('Gone.');
    expect(body.planProposal).toMatchObject({
      op: 'remove',
      planItemId: itemIds[0],
      approved: false,
      patch: null,
      committed: {},
    });
  });
});

describe('the overlay over a plan that also ADDS cards (MOTIR-11340)', () => {
  it('a re-parent under, and an edge to, a proposed card name its temp-ref; a patchless modify changes nothing', async () => {
    const fx = await makeFixture();
    const { epic, traversal, rewired, untouched } = await seed(fx);
    const plan = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        sourceJobId: JOB,
      },
    });
    const added = await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: 'add',
        parentRef: epic.id,
        proposedFields: { title: 'Depth default', kind: 'story' },
        blockedByRefs: [],
      },
    });
    const tempRef = `planItem:${added.id}`;
    for (const [workItemId, patch] of [
      [traversal.id, { parentRef: tempRef, kind: 'task', blockedByAdd: [tempRef] }],
      [untouched.id, null],
      [rewired.id, { obsolescence: null }],
    ] as const) {
      await adminDb.planItem.create({
        data: {
          workspaceId: fx.workspaceId,
          planId: plan.id,
          op: 'modify',
          workItemId,
          ...(patch ? { patch: patch as object } : {}),
          blockedByRefs: [],
        },
      });
    }

    const moved = await readItem(fx, { key: traversal.identifier, jobId: JOB });
    expect(moved.planProposal?.planStatus).toBe('planned');
    expect(moved.planProposal?.projectedParent).toBe(tempRef);
    expect(moved.planProposal?.projectedBlockedBy).toEqual([tempRef]);
    expect(moved.item.kind).toBe('task');

    const patchless = await readItem(fx, { key: untouched.identifier, jobId: JOB });
    expect(patchless.item.descriptionMd).toBe('Unchanged.');
    expect(patchless.planProposal).toMatchObject({ op: 'modify', patch: null, committed: {} });

    const rows = await readSubtree(fx, { rootKey: epic.identifier, depth: '1', jobId: JOB });
    const byKey = new Map(rows.nodes.map((n) => [n.key, n]));
    expect(byKey.get(untouched.identifier)).toMatchObject({
      title: 'Grep reads',
      planProposal: { op: 'modify' },
    });
    expect(byKey.get(rewired.identifier)).toMatchObject({
      obsolescence: null,
      planProposal: { op: 'modify' },
    });
  });
});

describe('get-subtree ?jobId= marks the rows the job’s plan targets (MOTIR-11340)', () => {
  it('patches the targeted rows, marks them proposed, and leaves every other row as stored', async () => {
    const fx = await makeFixture();
    const { epic, traversal, rewired, removed, untouched } = await seed(fx);
    const { itemIds } = await seedPlan(fx, [
      {
        op: 'modify',
        workItemId: traversal.id,
        patch: { title: 'Traversal reads use the shared default', kind: 'task' },
      },
      { op: 'modify', workItemId: rewired.id, patch: { obsolescence: 'deprecated' } },
      { op: 'remove', workItemId: removed.id },
    ]);

    const plain = await readSubtree(fx, { rootKey: epic.identifier, depth: '1' });
    for (const node of plain.nodes) expect(node).not.toHaveProperty('planProposal');

    const body = await readSubtree(fx, { rootKey: epic.identifier, depth: '1', jobId: JOB });
    const byKey = new Map(body.nodes.map((n) => [n.key, n]));
    expect(byKey.get(traversal.identifier)).toMatchObject({
      title: 'Traversal reads use the shared default',
      kind: 'task',
      planProposal: {
        planItemId: itemIds[0],
        op: 'modify',
        approved: false,
        committedTitle: 'Traversal reads',
      },
    });
    expect(byKey.get(rewired.identifier)).toMatchObject({
      title: 'Depth setting',
      obsolescence: 'deprecated',
      planProposal: { op: 'modify', approved: false },
    });
    expect(byKey.get(rewired.identifier)?.planProposal).not.toHaveProperty('committedTitle');
    expect(byKey.get(removed.identifier)).toMatchObject({
      title: 'Old fan-out',
      planProposal: { op: 'remove', planItemId: itemIds[2] },
    });
    expect(byKey.get(untouched.identifier)).not.toHaveProperty('planProposal');
    expect(byKey.get(epic.identifier)).not.toHaveProperty('planProposal');
  });

  it('a job with no plan leaves every row as stored', async () => {
    const fx = await makeFixture();
    const { epic } = await seed(fx);
    const body = await readSubtree(fx, { rootKey: epic.identifier, jobId: 'job_with_no_plan' });
    for (const node of body.nodes) expect(node).not.toHaveProperty('planProposal');
  });
});
