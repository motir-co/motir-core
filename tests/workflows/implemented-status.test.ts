import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE `implemented` STATUS (MOTIR-3003).
//
// Today an agent's process exits 0 and the card jumps straight to In Review — a
// status that claims a human should look at it — while nothing has been
// compiled, linted or tested. `implemented` is the state between "the agent
// stopped" and "a human should look at this"; the move out of it is a fact about
// CI (MOTIR-3006), and the move into it is what a finished run reports
// (MOTIR-3004 / MOTIR-3005).
//
// ⚠️ THE TEST THAT MATTERS is "a card at `implemented` is ABSENT from the ready
// set" — the reason the status sits in the **in_progress** category rather than
// anywhere else. A run takes the TO DO category, so a card whose pull request is
// already open leaves the pickable set STRUCTURALLY, with nothing special-casing
// it. Asserting the category alone would only restate the setup; only the
// absence fails if the pickable rule is wrong somewhere else. This is the same
// claim `planning-status.test.ts` makes for MOTIR-2425, one rung further along
// the loop.

const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260819090000_add_implemented_default_status/migration.sql',
);

/** The seven edges `DEFAULT_TRANSITIONS` gains — enumerated here so the test
 *  states the graph rather than deriving it from the thing under test. */
const EDGES_IN: ReadonlyArray<string> = ['in_progress', 'blocked'];
const EDGES_OUT: ReadonlyArray<string> = [
  'in_review',
  'in_progress',
  'blocked',
  'cancelled',
  'done',
];

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every statement of the backfill migration, run the way `migrate deploy` runs it. */
async function runBackfill(): Promise<void> {
  await adminDb.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
}

async function readySetKeys(): Promise<string[]> {
  const page = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
  return page.items.map((row) => row.key);
}

describe('a card whose pull request is open leaves the pickable set', () => {
  it('is ABSENT from the ready set once it is at `implemented`', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Built, waiting on checks' },
      fx.ctx,
    );

    // It starts ready — otherwise the absence below proves nothing.
    expect(await readySetKeys()).toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', fx.ctx);

    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('comes BACK to the ready set when a red build sends it to `in_progress`', async () => {
    // The exit matters as much as the entrance. A status with a vague way out
    // accumulates cards nobody owns — and rework is the common exit here, since
    // a failing build leaves the card exactly where it was.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Reopened after a red build' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', fx.ctx);
    expect(await readySetKeys()).not.toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    // `in_progress` is not pickable either (same category) — the point is that
    // the card is workable again, which the legal transition above establishes.
    expect(await readySetKeys()).not.toContain(item.identifier);
    await workItemsService.updateStatus(item.id, 'todo', fx.ctx);
    expect(await readySetKeys()).toContain(item.identifier);
  });
});

describe('the status a fresh project is seeded with', () => {
  it('exists, in the in_progress category, between in_progress and in_review', async () => {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    const implemented = wf.statuses.find((s) => s.key === 'implemented');

    expect(implemented).toBeDefined();
    expect(implemented!.category).toBe('in_progress');
    expect(implemented!.isInitial).toBe(false);
    expect(wf.statuses.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('sorts at SLOT 4 — after In Progress and BEFORE Planning', async () => {
    // Not a preference: the board is a row of 288px columns beside a 240px rail,
    // so slot 4 is the last column a laptop shows in full and slot 5 is
    // off-screen at every laptop width measured
    // (`design/boards/implemented-column.mock.html`, panel 1). The path every
    // card walks takes the visible slot. Asserting the whole order rather than a
    // position string, because the position is an opaque fractional index.
    //
    // ⚠️ MOTIR-5139 added `approved` at slot 7 and this assertion's CLAIM is
    // unchanged by it: the insert is AFTER `implemented`, so slot 4 is still
    // slot 4 and the invariant this test pins still holds. Only the enumeration
    // grew. The fold was RE-MEASURED at nine columns rather than assumed —
    // `design/boards/approved-column.mock.html`, panel 1 — and the count of
    // fully-visible columns is unchanged at every viewport.
    //
    // MOTIR-12174 added `to_plan` at slot 6, again AFTER `implemented`
    // (`design/boards/board--to-plan-status.mock.html`, panel 1).
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).toEqual([
      'todo',
      'blocked',
      'in_progress',
      'implemented',
      'planning',
      'to_plan',
      'in_review',
      'approved',
      'done',
      'cancelled',
    ]);
    // The invariant itself, stated as an index so a later insert cannot quietly
    // move it while the list above is mechanically extended.
    expect(wf.statuses.findIndex((s) => s.key === 'implemented')).toBe(3);
  });

  it('has a board column of its own — a status with nowhere to put its cards is not shipped', async () => {
    const column = await adminDb.boardColumn.findFirst({
      where: { projectId: fx.projectId, name: 'Implemented' },
      include: { statusMappings: { include: { status: true } } },
    });
    expect(column).not.toBeNull();
    expect(column!.statusMappings.map((m) => m.status.key)).toEqual(['implemented']);
  });

  it('`in_review` and `planning` are untouched — same categories, same behaviour', async () => {
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.find((s) => s.key === 'in_review')?.category).toBe('in_progress');
    expect(wf.statuses.find((s) => s.key === 'planning')?.category).toBe('in_progress');
    expect(wf.statuses.find((s) => s.key === 'blocked')?.category).toBe('todo');
  });
});

describe('the transitions in and out are legal without an admin editing anything', () => {
  it.each(EDGES_IN)('%s → implemented', async (from) => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `into implemented from ${from}` },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, from, fx.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'implemented', fx.ctx),
    ).resolves.toMatchObject({ status: 'implemented' });
  });

  it.each(EDGES_OUT)('implemented → %s', async (to) => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `out of implemented to ${to}` },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', fx.ctx);
    await expect(workItemsService.updateStatus(item.id, to, fx.ctx)).resolves.toMatchObject({
      status: to,
    });
  });

  it('todo → implemented IS legal now — a pull request can deliver a card nobody moved (MOTIR-12202)', async () => {
    // Enumerated, not generated: this edge was refused until a user story justified
    // it. One pull request often delivers more than one card, and a card linked to an
    // open, ready pull request while it still read To Do stayed there through the
    // merge (MOTIR-12189). `tests/workflows/todo-delivery-edges.test.ts` owns the edge.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'delivered while To Do' },
      fx.ctx,
    );
    await expect(
      workItemsService.updateStatus(item.id, 'implemented', fx.ctx),
    ).resolves.toMatchObject({ status: 'implemented' });
  });

  it('but NOT planning → implemented — a card being re-planned has nothing approved to build', async () => {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'being re-planned' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'planning', fx.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'implemented', fx.ctx),
    ).rejects.toBeInstanceOf(IllegalTransitionError);
  });

  it('and in_review → implemented IS legal now — a merge queue can eject an in-review card (MOTIR-5630)', async () => {
    // This asserted the OPPOSITE until MOTIR-5630 ("the promotion runs one way").
    // The promotion still does; what changed is that a merge queue can reject an
    // `auto` project's card after CI promoted it, and `implemented` is the status
    // that describes committed code whose build has not passed
    // (`approval-gates.md` §4 THIRD AMENDMENT, decision 7). The edge is declared so
    // a person can make the same move by hand.
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'already in review' },
      fx.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'in_review', fx.ctx);
    await expect(
      workItemsService.updateStatus(item.id, 'implemented', fx.ctx),
    ).resolves.toMatchObject({ status: 'implemented' });
  });
});

describe('the backfill onto a project that predates the status', () => {
  /**
   * Strip `implemented` from the fixture's project, reproducing a project seeded
   * BEFORE this change. Deleting the status cascades its transitions and its
   * board-column mapping away, which is exactly the pre-migration shape.
   */
  async function stripImplemented(): Promise<void> {
    await adminDb.$executeRawUnsafe(
      `DELETE FROM board_column WHERE project_id = $1 AND name = 'Implemented'`,
      fx.projectId,
    );
    await adminDb.$executeRawUnsafe(
      `DELETE FROM workflow_status WHERE project_id = $1 AND key = 'implemented'`,
      fx.projectId,
    );
  }

  async function shape(): Promise<{ statuses: number; edges: number; columns: number }> {
    const [statuses, edges, columns] = await Promise.all([
      adminDb.workflowStatus.count({ where: { projectId: fx.projectId, key: 'implemented' } }),
      adminDb.workflowTransition.count({ where: { projectId: fx.projectId } }),
      adminDb.boardColumn.count({ where: { projectId: fx.projectId, name: 'Implemented' } }),
    ]);
    return { statuses, edges, columns };
  }

  it('adds the status, its seven edges and a board column', async () => {
    await stripImplemented();
    const before = await shape();
    expect(before.statuses).toBe(0);
    expect(before.columns).toBe(0);

    await runBackfill();

    const after = await shape();
    expect(after.statuses).toBe(1);
    expect(after.edges).toBe(before.edges + EDGES_IN.length + EDGES_OUT.length);
    expect(after.columns).toBe(1);

    const implemented = await adminDb.workflowStatus.findFirst({
      where: { projectId: fx.projectId, key: 'implemented' },
    });
    expect(implemented?.category).toBe('in_progress');
    expect(implemented?.isInitial).toBe(false);
    // It sorts where the seed puts it — the position is opaque, the ORDER is the
    // claim, and the claim is slot 4 (before Planning).
    const ordered = await adminDb.workflowStatus.findMany({
      where: { projectId: fx.projectId },
      orderBy: { position: 'asc' },
    });
    expect(ordered.map((s) => s.key)).toEqual(DEFAULT_STATUSES.map((s) => s.key));
  });

  it('wires exactly the seven edges, not six and not eight', async () => {
    await stripImplemented();
    await runBackfill();

    const rows = await adminDb.workflowTransition.findMany({
      where: { projectId: fx.projectId },
      include: { fromStatus: true, toStatus: true },
    });
    const touching = rows
      .filter((r) => r.fromStatus.key === 'implemented' || r.toStatus.key === 'implemented')
      .map((r) => `${r.fromStatus.key}→${r.toStatus.key}`)
      .sort();
    expect(touching).toEqual(
      [
        ...EDGES_IN.map((from) => `${from}→implemented`),
        ...EDGES_OUT.map((to) => `implemented→${to}`),
      ].sort(),
    );
  });

  it('is IDEMPOTENT — running it twice changes nothing', async () => {
    await stripImplemented();
    await runBackfill();
    const once = await shape();

    await runBackfill();

    expect(await shape()).toEqual(once);
    // …and the mapping did not double either, which a column-only check would
    // miss: two mappings for one status is a board that renders a card twice.
    const mappings = await adminDb.boardColumnStatus.count({
      where: { projectId: fx.projectId, status: { key: 'implemented' } },
    });
    expect(mappings).toBe(1);
  });

  it('a card at the BACKFILLED status is absent from the ready set too', async () => {
    // The property this card exists for, asserted on a project that got the
    // status from the migration rather than from the seed. The two paths must
    // produce the same thing, and a category typo in the SQL is exactly the kind
    // of divergence that would otherwise ship silently.
    await stripImplemented();
    await runBackfill();

    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'On a backfilled project' },
      fx.ctx,
    );
    expect(await readySetKeys()).toContain(item.identifier);

    await workItemsService.updateStatus(item.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', fx.ctx);

    expect(await readySetKeys()).not.toContain(item.identifier);
  });

  it('leaves a CUSTOM workflow alone — the key join is what scopes it', async () => {
    // A project that renamed `in_progress` no longer matches, and gets nothing.
    // Better than guessing where the status belongs in a workflow somebody
    // designed.
    await stripImplemented();
    await adminDb.$executeRawUnsafe(
      `UPDATE workflow_status SET key = 'doing' WHERE project_id = $1 AND key = 'in_progress'`,
      fx.projectId,
    );

    await runBackfill();

    expect(
      await adminDb.workflowStatus.count({
        where: { projectId: fx.projectId, key: 'implemented' },
      }),
    ).toBe(0);
  });

  it('MOVES NO CARD — it adds a state, it does not put anything in it', async () => {
    // The card's last acceptance criterion, and the one a data migration is most
    // able to break by accident.
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Left alone at todo' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Left alone in review' },
      fx.ctx,
    );
    await workItemsService.updateStatus(b.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(b.id, 'in_review', fx.ctx);

    await stripImplemented();
    await runBackfill();

    const rows = await adminDb.workItem.findMany({
      where: { id: { in: [a.id, b.id] } },
      orderBy: { key: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['todo', 'in_review']);
  });
});
