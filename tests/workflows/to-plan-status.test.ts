import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { parentStatusRollupService } from '@/lib/services/parentStatusRollupService';
import { plansService } from '@/lib/services/plansService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import {
  DEFAULT_STATUSES,
  DEFAULT_STATUS_KEYS,
  DEFAULT_TRANSITIONS,
} from '@/lib/workflows/defaultWorkflow';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { DefaultStatusProtectedError } from '@/lib/workflows/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `to_plan` STATUS (MOTIR-12174), story MOTIR-10139.
//
// A card planned against a decision that was later corrected is planned, not
// finished, and its description is out of date. It must leave the pickable set
// until it is re-planned, and it must not count as finished or started. The
// CATEGORY (`in_progress`) does the first two; the status ladder's pull-down to
// the `todo` rung does the third.
//
// Asserted through the real services — the claim doors, the transition funnel,
// the plan park / approve / decline and the parent rollup — never by reading the
// constant back, because the constant is the thing under test. Modelled on
// `approved-status.test.ts`, the same shape one status earlier.

const DB_TEST_TIMEOUT_MS = 30_000;

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20261124010000_add_to_plan_default_status/migration.sql',
);

/** The five edges, enumerated so the test STATES the graph. */
const EDGES_IN: ReadonlyArray<string> = ['todo', 'blocked'];
const EDGES_OUT: ReadonlyArray<string> = ['planning', 'todo', 'cancelled'];
/** The three a stale card must not take: started or closed without a re-plan. */
const ABSENT_OUT: ReadonlyArray<string> = ['blocked', 'in_progress', 'done'];

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function runBackfill(): Promise<void> {
  await adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

async function card(title: string, kind: 'task' | 'story' | 'epic' = 'task', parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

/** A fresh card moved to `to_plan` the way the mark moves one: from `todo`. */
async function stale(title: string) {
  const item = await card(title);
  await workItemsService.updateStatus(item.id, 'to_plan', fx.ctx);
  return item;
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function edgesTouching(projectId: string): Promise<string[]> {
  const rows = await adminDb.workflowTransition.findMany({
    where: { projectId },
    include: { fromStatus: true, toStatus: true },
  });
  return rows
    .filter((r) => r.fromStatus.key === 'to_plan' || r.toStatus.key === 'to_plan')
    .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
    .sort();
}

const EXPECTED_EDGES = [
  ...EDGES_IN.map((from) => `${from}→to_plan`),
  ...EDGES_OUT.map((to) => `to_plan→${to}`),
].sort();

describe('the seeded workflow carries the tenth status', () => {
  it(
    'has `to_plan` (To plan, in_progress, not initial) immediately after planning',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
      const toPlan = wf.statuses.find((s) => s.key === 'to_plan');
      expect(toPlan).toMatchObject({
        label: 'To plan',
        category: 'in_progress',
        isInitial: false,
      });

      const order = wf.statuses
        .slice()
        .sort((a, b) => (a.position < b.position ? -1 : 1))
        .map((s) => s.key);
      expect(order).toEqual(DEFAULT_STATUSES.map((s) => s.key));
      // Slot 6, the design's (`board--to-plan-status.mock.html` panel 1).
      expect(order.indexOf('to_plan')).toBe(5);
      expect(order.indexOf('to_plan')).toBe(order.indexOf('planning') + 1);
      // The eighth column's invariant survives: the insert is after it.
      expect(order.indexOf('implemented')).toBe(3);
    },
  );

  it('seeds a To plan board column mapped to it', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const column = await adminDb.boardColumn.findFirst({
      where: { projectId: fx.projectId, name: 'To plan' },
      include: { statusMappings: { include: { status: true } } },
    });
    expect(column?.statusMappings.map((m) => m.status.key)).toEqual(['to_plan']);
  });

  it('seeds exactly the five edges', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    expect(await edgesTouching(fx.projectId)).toEqual(EXPECTED_EDGES);
    expect(DEFAULT_TRANSITIONS).toHaveLength(48);
  });
});

describe('it is a PROTECTED default', () => {
  async function toPlanStatus() {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    return wf.statuses.find((s) => s.key === 'to_plan')!;
  }

  it('is in DEFAULT_STATUS_KEYS', () => {
    expect(DEFAULT_STATUS_KEYS.has('to_plan')).toBe(true);
    expect(DEFAULT_STATUS_KEYS.size).toBe(DEFAULT_STATUSES.length);
  });

  it(
    'refuses a rename, a recategorise, a reorder and a delete; allows a recolour',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const s = await toPlanStatus();
      const who = { userId: fx.ctx.userId, workspaceId: fx.workspaceId, statusId: s.id };
      for (const patch of [{ label: 'Stale' }, { category: 'todo' as const }, { position: 'a9' }]) {
        await expect(workflowsService.updateStatus({ ...who, ...patch })).rejects.toBeInstanceOf(
          DefaultStatusProtectedError,
        );
      }
      await expect(workflowsService.deleteStatus(who)).rejects.toBeInstanceOf(
        DefaultStatusProtectedError,
      );
      await expect(
        workflowsService.updateStatus({ ...who, color: '#7a4a1f' }),
      ).resolves.toMatchObject({ color: '#7a4a1f' });
      expect((await toPlanStatus()).label).toBe('To plan');
    },
  );
});

describe('a card at To plan is never claimed', () => {
  it(
    'claim_next_ready skips it, with no open blocker in the way',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const item = await stale('Stale, unblocked');
      const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
      await adminDb.workItem.update({ where: { id: item.id }, data: { sprintId: sprint.id } });
      await sprintsService.startSprint(sprint.id, {}, fx.ctx);

      expect(await workItemsService.claimNextReady(fx.projectId, sprint.id, fx.ctx)).toBeNull();
      expect(await statusOf(item.id)).toBe('to_plan');
    },
  );

  it('claim_work_item answers not_claimable', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const item = await stale('Stale, named');
    const claim = await workItemsService.claimWorkItem(fx.projectId, item.identifier, fx.ctx);
    expect(claim.outcome).toBe('not_claimable');
    expect(claim.claimed).toBe(false);
    expect(await statusOf(item.id)).toBe('to_plan');
  });
});

describe('the transitions, under the restricted policy', () => {
  it.each(EDGES_IN)('%s → to_plan', { timeout: DB_TEST_TIMEOUT_MS }, async (from) => {
    const item = await card(`into to_plan from ${from}`);
    if (from !== 'todo') await workItemsService.updateStatus(item.id, from, fx.ctx);
    await expect(workItemsService.updateStatus(item.id, 'to_plan', fx.ctx)).resolves.toMatchObject({
      status: 'to_plan',
    });
  });

  it.each(EDGES_OUT)('to_plan → %s by hand', { timeout: DB_TEST_TIMEOUT_MS }, async (to) => {
    const item = await stale(`out of to_plan to ${to}`);
    await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
      status: to,
    });
  });

  it.each(ABSENT_OUT)(
    'to_plan → %s is REFUSED — a stale card is not started or closed unplanned',
    { timeout: DB_TEST_TIMEOUT_MS },
    async (to) => {
      const item = await stale(`not to ${to}`);
      await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );
      expect(await statusOf(item.id)).toBe('to_plan');
    },
  );

  it('in_progress → to_plan is not an edge — the mark moves only unstarted work', async () => {
    const item = await card('started');
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await expect(workItemsService.updateStatus(item.id, 'to_plan', fx.ctx)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});

describe('a plan that names a To plan card', () => {
  async function plannedModify(workItemId: string): Promise<string> {
    const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-planned.' } }],
      fx.ctx,
    );
    return plan.id;
  }

  it(
    'PARKS it at planning, holding to_plan as its prior status',
    async () => {
      const item = await stale('parked');
      await plannedModify(item.id);
      expect(await statusOf(item.id)).toBe(PLANNING_STATUS_KEY);
      expect(
        await adminDb.planTargetLock.findUnique({ where: { workItemId: item.id } }),
      ).toMatchObject({ priorStatus: 'to_plan', statusHeld: true });
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'APPROVE rests it at todo',
    async () => {
      const item = await stale('approved');
      const planId = await plannedModify(item.id);
      await plansService.markPlanned(planId, fx.ctx);
      await plansService.approvePlan(planId, fx.ctx);
      expect(await statusOf(item.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'APPROVE rests it at blocked when a live blocked_by is open',
    async () => {
      const item = await stale('approved, gated');
      const blocker = await card('open blocker');
      await workItemsService.linkWorkItems(
        { fromId: item.id, toId: blocker.id, kind: 'is_blocked_by' },
        fx.ctx,
      );
      const planId = await plannedModify(item.id);
      await plansService.markPlanned(planId, fx.ctx);
      await plansService.approvePlan(planId, fx.ctx);
      expect(await statusOf(item.id)).toBe('blocked');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'DECLINE restores it to to_plan',
    async () => {
      const item = await stale('declined');
      const planId = await plannedModify(item.id);
      await plansService.markPlanned(planId, fx.ctx);
      await plansService.declinePlan(planId, fx.ctx);
      expect(await statusOf(item.id)).toBe('to_plan');
      expect(
        await adminDb.planTargetLock.findUnique({ where: { workItemId: item.id } }),
      ).toBeNull();
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('To plan ranks at the todo rung — planned, not started', () => {
  it(
    'a story whose children are all at to_plan derives to To Do, not In Progress',
    async () => {
      const story = await card('Story', 'story');
      const a = await card('A', 'task', story.id);
      const b = await card('B', 'task', story.id);
      // The story was started; its children were then marked stale.
      await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'in_progress' } });
      await new Promise((r) => setTimeout(r, 5));
      await adminDb.workItem.updateMany({
        where: { id: { in: [a.id, b.id] } },
        data: { status: 'to_plan' },
      });

      await parentStatusRollupService.recomputeParent(story.id, fx.workspaceId);

      expect(await statusOf(story.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it(
    'an epic over a story at to_plan is NOT moved to In Progress',
    async () => {
      const epic = await card('Epic', 'epic');
      const story = await card('Story', 'story', epic.id);
      await adminDb.workItem.update({ where: { id: story.id }, data: { status: 'to_plan' } });

      const out = await parentStatusRollupService.recomputeParent(epic.id, fx.workspaceId);

      // The derivation RAN and found the epic already where it belongs — not a
      // switched-off rollup that would leave it at todo for the wrong reason.
      expect(out).toMatchObject({ outcome: 'already_there', toStatus: 'todo' });
      expect(await statusOf(epic.id)).toBe('todo');
    },
    DB_TEST_TIMEOUT_MS,
  );
});

describe('the backfill onto a project that predates the status', () => {
  /** A project seeded with the previous nine statuses: deleting the status
   *  cascades its edges and its column mapping away. */
  async function strip(projectId = fx.projectId): Promise<void> {
    await adminDb.$executeRawUnsafe(
      `DELETE FROM board_column WHERE project_id = $1 AND name = 'To plan'`,
      projectId,
    );
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'to_plan'`,
      projectId,
    );
  }

  async function shape() {
    const [statuses, edges, columns] = await Promise.all([
      adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'to_plan' } }),
      adminDb.workflowTransition.count({ where: { projectId: fx.projectId } }),
      adminDb.boardColumn.count({ where: { projectId: fx.projectId, name: 'To plan' } }),
    ]);
    return { statuses, edges, columns };
  }

  it(
    'adds the status between planning and in_review, the five edges and a column',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await strip();
      const before = await shape();
      expect(before).toMatchObject({ statuses: 0, columns: 0 });

      await runBackfill();

      const after = await shape();
      expect(after.statuses).toBe(1);
      expect(after.edges).toBe(before.edges + 5);
      expect(after.columns).toBe(1);
      expect(await edgesTouching(fx.projectId)).toEqual(EXPECTED_EDGES);

      const row = await adminDb.workflowStatus.findFirstOrThrow({
        where: { projectId: fx.projectId, key: 'to_plan' },
      });
      expect(row).toMatchObject({ label: 'To plan', category: 'in_progress', isInitial: false });
      const ordered = await adminDb.workflowStatus.findMany({
        where: { projectId: fx.projectId },
        orderBy: { position: 'asc' },
      });
      expect(ordered.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
    },
  );

  it(
    'places it right on a project BACKFILLED by the earlier migrations',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      // The live shape: implemented=a2F planning=a2V in_review=a3 approved=a3F.
      await strip();
      const keys: Record<string, string> = {
        todo: 'a0',
        blocked: 'a1',
        in_progress: 'a2',
        implemented: 'a2F',
        planning: 'a2V',
        in_review: 'a3',
        approved: 'a3F',
        done: 'a4',
        cancelled: 'a5',
      };
      for (const [key, position] of Object.entries(keys)) {
        await adminDb.workflowStatus.updateMany({
          where: { projectId: fx.projectId, key },
          data: { position },
        });
      }

      await runBackfill();

      const ordered = await adminDb.workflowStatus.findMany({
        where: { projectId: fx.projectId },
        orderBy: { position: 'asc' },
      });
      expect(ordered.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
      expect(ordered.find((s) => s.key === 'to_plan')?.position).toBe('a2VV');
    },
  );

  it('is IDEMPOTENT — running it twice adds nothing', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    await strip();
    await runBackfill();
    const once = await shape();
    await runBackfill();
    expect(await shape()).toEqual(once);
    expect(
      await adminDb.boardColumnStatus.count({
        where: { projectId: fx.projectId, status: { key: 'to_plan' } },
      }),
    ).toBe(1);
  });

  it(
    'leaves a CUSTOM workflow (no planning status) alone',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await strip();
      await adminDb.$executeRawUnsafe(
        `DELETE FROM board_column WHERE project_id = $1 AND name = 'Planning'`,
        fx.projectId,
      );
      await adminDb.$executeRawUnsafe(
        `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'planning'`,
        fx.projectId,
      );

      await expect(runBackfill()).resolves.not.toThrow();

      expect(await shape()).toMatchObject({ statuses: 0, columns: 0 });
    },
  );

  it(
    'gives a board whose columns an admin MERGED no column',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      await strip();
      // Merge Blocked into To Do: one column now maps two statuses.
      const todoColumn = await adminDb.boardColumn.findFirstOrThrow({
        where: { projectId: fx.projectId, name: 'To Do' },
      });
      const blockedColumn = await adminDb.boardColumn.findFirstOrThrow({
        where: { projectId: fx.projectId, name: 'Blocked' },
      });
      await adminDb.boardColumnStatus.updateMany({
        where: { columnId: blockedColumn.id },
        data: { columnId: todoColumn.id },
      });
      await adminDb.boardColumn.delete({ where: { id: blockedColumn.id } });

      await runBackfill();

      const after = await shape();
      expect(after.statuses).toBe(1);
      expect(after.columns).toBe(0);
    },
  );

  it('MOVES NO CARD', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const a = await card('Left at todo');
    const b = await card('Left in progress');
    await workItemsService.updateStatus(b.id, 'in_progress', fx.ctx);
    await strip();
    await runBackfill();
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(['todo', 'in_progress']);
  });
});
