import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TWO EDGES OUT OF `todo` A DELIVERING PULL REQUEST NEEDS (Bug MOTIR-12202).
//
// A card a pull request delivers while it still reads To Do used to stay there: the
// link-time sync's `→ implemented`, the CI-green latch's `→ in_review` and the merge's
// `→ done` were all undeclared hops, refused silently (MOTIR-12189). The default
// workflow now declares `todo → implemented` and `todo → in_review`; new projects get
// them from `DEFAULT_TRANSITIONS`, existing ones from
// `20261125000000_add_todo_delivery_default_edges`, which adds EACH edge to every
// project that has both its endpoints and does not already declare it.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20261125000000_add_todo_delivery_default_edges/migration.sql',
);

/** Enumerated here so the test states the graph rather than reading it back from the
 *  thing under test. */
const TODO_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['todo', 'implemented'],
  ['todo', 'in_review'],
];
const ALL = TODO_EDGES.map(([from, to]) => `${from}→${to}`).sort();

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The backfill, run the way `migrate deploy` runs it; answers the rows it inserted. */
async function runBackfill(): Promise<number> {
  return adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

/** Every edge OUT of a project's `todo` into one of the two targets, as `from→to`, one
 *  entry per ROW (so a duplicate shows twice). Keyed on the source status's key, so a
 *  renamed target still shows up under its new key. */
async function todoDeliveryEdges(projectId: string): Promise<string[]> {
  const rows = await adminDb.workflowTransition.findMany({
    where: { projectId, fromStatus: { key: 'todo' } },
    include: { fromStatus: true, toStatus: true },
  });
  return rows
    .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
    .filter((edge) => !['todo→in_progress', 'todo→blocked', 'todo→cancelled'].includes(edge))
    .filter((edge) => !['todo→planning', 'todo→to_plan'].includes(edge))
    .sort();
}

async function strip(
  projectId: string,
  edges: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  for (const [from, to] of edges) {
    await adminDb.workflowTransition.deleteMany({
      where: { projectId, fromStatus: { key: from }, toStatus: { key: to } },
    });
  }
}

describe('the seed', () => {
  it('a new project carries both edges from the constant', async () => {
    const fx = await makeWorkItemFixture();
    expect(await todoDeliveryEdges(fx.projectId)).toEqual(ALL);
    for (const [from, to] of TODO_EDGES) {
      expect(DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to)).toBe(true);
    }
  });

  it('and still no `todo → done` and no `blocked → in_review`', () => {
    const edge = (from: string, to: string) =>
      DEFAULT_TRANSITIONS.some(([f, t]) => f === from && t === to);
    // The merge completes a delivered card through Implemented or In Review, which it
    // has left To Do for by then; a person's block is never lifted by a pull request.
    expect(edge('todo', 'done')).toBe(false);
    expect(edge('blocked', 'in_review')).toBe(false);
  });
});

describe('the backfill onto projects that predate the edges', () => {
  let standard: WorkItemFixture;
  let renamed: WorkItemFixture;
  let partial: WorkItemFixture;

  beforeEach(async () => {
    standard = await makeWorkItemFixture({ name: 'Standard', identifier: 'STD' });
    renamed = await makeWorkItemFixture({ name: 'Renamed', identifier: 'REN' });
    partial = await makeWorkItemFixture({ name: 'Partial', identifier: 'PAR' });

    // A default workflow from before MOTIR-12202: neither edge.
    await strip(standard.projectId, TODO_EDGES);
    // A CUSTOM workflow: `in_review` renamed, so the key join cannot find that target —
    // the edge into `implemented` is independent of it and still lands.
    await strip(renamed.projectId, TODO_EDGES);
    await adminDb.workflowStatus.updateMany({
      where: { projectId: renamed.projectId, key: 'in_review' },
      data: { key: 'review' },
    });
    // A project that already holds ONE of the two.
    await strip(partial.projectId, TODO_EDGES.slice(1));
  });

  it('adds both to a default project, only the reachable one to a renamed one, and only the missing one to a partial one', async () => {
    expect(await todoDeliveryEdges(standard.projectId)).toEqual([]);
    expect(await todoDeliveryEdges(renamed.projectId)).toEqual([]);
    expect(await todoDeliveryEdges(partial.projectId)).toEqual(['todo→implemented']);

    expect(await runBackfill()).toBe(2 + 1 + 1);

    expect(await todoDeliveryEdges(standard.projectId)).toEqual(ALL);
    expect(await todoDeliveryEdges(renamed.projectId)).toEqual(['todo→implemented']);
    // No duplicate of the edge it already had: one row per edge.
    expect(await todoDeliveryEdges(partial.projectId)).toEqual(ALL);
  });

  it('is IDEMPOTENT — a second run inserts zero rows', async () => {
    await runBackfill();
    const once = await Promise.all(
      [standard, renamed, partial].map((fx) => todoDeliveryEdges(fx.projectId)),
    );

    expect(await runBackfill()).toBe(0);

    expect(
      await Promise.all([standard, renamed, partial].map((fx) => todoDeliveryEdges(fx.projectId))),
    ).toEqual(once);
  });

  it('a backfilled project allows both moves out of To Do, and still refuses To Do → Done', async () => {
    const before = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'refused before the backfill' },
      standard.ctx,
    );
    await expect(
      workItemsService.updateStatus(before.id, 'implemented', standard.ctx),
    ).rejects.toBeInstanceOf(IllegalTransitionError);

    await runBackfill();

    const implemented = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'delivered while To Do' },
      standard.ctx,
    );
    await expect(
      workItemsService.updateStatus(implemented.id, 'implemented', standard.ctx),
    ).resolves.toMatchObject({ status: 'implemented' });

    const reviewed = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'green while To Do' },
      standard.ctx,
    );
    await expect(
      workItemsService.updateStatus(reviewed.id, 'in_review', standard.ctx),
    ).resolves.toMatchObject({ status: 'in_review' });

    const closed = await workItemsService.createWorkItem(
      { projectId: standard.projectId, kind: 'task', title: 'never a shortcut to Done' },
      standard.ctx,
    );
    await expect(
      workItemsService.updateStatus(closed.id, 'done', standard.ctx),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });
});
