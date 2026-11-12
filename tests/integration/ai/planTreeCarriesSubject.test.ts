import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { mcpSkeletonRowSchema, presentMcpSkeletonRow } from '@/lib/mcp/payloads/workItems';
import { makeWorkItemFixture, createTestLink, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-10162 · Subtask MOTIR-11053 — every read of the plan-tree family
// carries a card's stored SUBJECT, so a planner can recognise a COMMITTED card
// (an approved init card) the way it recognises a proposed one.
//
// ⚠️ The two subtree projections are raw `$queryRaw` CTEs: the compiler cannot see
// whether their SQL selects the column, so this suite is the proof that the row
// type and the SQL moved together — on the breadth read, the bounded subtree,
// the blocking closure and the MCP `skeleton` row (the hand-written fourth).

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** An epic holding an init card (subject `init`) and a plain card, and a task
 *  outside it blocked by both. */
async function seed(fx: WorkItemFixture) {
  const epic = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
    fx.ctx,
  );
  const init = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Create acme-infra', parentId: epic.id },
    fx.ctx,
  );
  const plain = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Plain', parentId: epic.id },
    fx.ctx,
  );
  const waiter = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Waiter' },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: init.id }, data: { subject: 'init' } });
  for (const blocker of [init, plain]) {
    await createTestLink({
      workspaceId: fx.ctx.workspaceId,
      fromId: waiter.id,
      toId: blocker.id,
      kind: 'is_blocked_by',
      createdById: fx.ctx.userId,
    });
  }
  return { epic, init, plain, waiter };
}

function subjectsByKey(rows: Array<{ key: string; subject: string | null }>) {
  return new Map(rows.map((r) => [r.key, r.subject]));
}

describe('the plan-tree read family carries the subject', () => {
  it('readPlanTree, the bounded subtree and the blocking closure agree on both cards', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, init, plain, waiter } = await seed(fx);

    const tree = subjectsByKey((await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx)).items);
    const subtree = subjectsByKey(
      (await aiBoundaryService.getSubtree(fx.projectId, epic.identifier, 2, fx.ctx)).nodes,
    );
    const closure = subjectsByKey(
      (await aiBoundaryService.walkBlocking(fx.projectId, waiter.identifier, fx.ctx)).nodes,
    );

    for (const read of [tree, subtree, closure]) {
      expect(read.get(init.identifier)).toBe('init');
      expect(read.get(plain.identifier)).toBeNull();
    }
  });

  it('the bounded subtree projection returns the column, never undefined', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, init } = await seed(fx);

    const { nodes } = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 2);
    for (const node of nodes) expect(node.subject).not.toBeUndefined();
    expect(nodes.find((n) => n.id === init.id)!.subject).toBe('init');
  });

  it('the summary list read and the subtree DTO both report the stored subject', async () => {
    const fx = await makeWorkItemFixture();
    const { epic, init, plain } = await seed(fx);

    const list = await workItemsService.listWorkItems(fx.projectId, {}, fx.ctx);
    expect(list.find((i) => i.id === init.id)!.subject).toBe('init');
    expect(list.find((i) => i.id === plain.id)!.subject).toBeNull();
    const { nodes } = await workItemsService.getBoundedSubtree(epic.id, fx.ctx, 1);
    expect(nodes.find((n) => n.id === plain.id)!.subject).toBeNull();
  });

  it('the MCP skeleton row passes the subject through, over the rows the read returned', async () => {
    const fx = await makeWorkItemFixture();
    const { init, plain } = await seed(fx);

    const rows = (await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx)).items.map(
      presentMcpSkeletonRow,
    );
    for (const row of rows) expect(mcpSkeletonRowSchema.parse(row)).toEqual(row);
    const bySubject = subjectsByKey(rows);
    expect(bySubject.get(init.identifier)).toBe('init');
    expect(bySubject.get(plain.identifier)).toBeNull();
  });
});
