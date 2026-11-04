import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { InvalidReportWindowError } from '@/lib/reports/errors';
import type { Prisma, WorkItem } from '@/generated/prisma/client';

const HIGH_AST: FilterAst = {
  combinator: 'and',
  conditions: [{ field: 'priority', operator: 'is_any_of', value: ['high'] }],
};

// Story 8.8 · Subtask 8.8.13 — reportsService.getWorkload. Real Postgres. A
// SNAPSHOT read (no revision trail): open (current status NOT in a
// done-category) non-archived work_item rows grouped by assignee, ranked by the
// measure, with the unassigned bucket last. The matrix asserts: the ranking +
// unassigned-last rule, the done-category + archive exclusions, the
// points-vs-count measure re-rank, and the empty scope.

async function setFields(
  id: string,
  data: { assigneeId?: string | null; storyPoints?: number | null; status?: string },
): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function expectOk(promise: ReturnType<typeof reportsService.getWorkload>) {
  const result = await promise;
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

describe('getWorkload — the ranked open-work matrix', () => {
  it('ranks assignees by open story points desc, unassigned last, excluding done + archived', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });

    const seed = async (
      title: string,
      assigneeId: string | null,
      points: number,
      status = 'todo',
    ): Promise<WorkItem> => {
      const item = await createTestWorkItem(fx, { kind: 'task', title });
      await setFields(item.id, { assigneeId, storyPoints: points, status });
      return item;
    };

    // Bo: 8 + 5 open = 13; Odie: 3 open; unassigned: 2 open.
    await seed('A', bo.id, 8);
    await seed('B', bo.id, 5);
    await seed('C', odie.id, 3);
    await seed('D', null, 2);
    // Excluded: a DONE item (done-category current status) and an ARCHIVED one.
    await seed('E', bo.id, 100, 'done');
    const archived = await seed('F', odie.id, 100);
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );

    expect(data.assignees.map((a) => [a.name, a.points, a.count])).toEqual([
      ['Bo', 13, 2],
      ['Odie', 3, 1],
      [null, 2, 1], // the unassigned bucket — always last, name null
    ]);
    expect(data.assignees.at(-1)!.assigneeId).toBeNull();
    expect(data.totalPoints).toBe(18);
    expect(data.totalCount).toBe(4);
    expect(data.measure).toBe('story_points');
  });

  it('re-ranks by issue COUNT when measure=issue_count, unassigned still last', async () => {
    const fx = await makeWorkItemFixture();
    const heavy = await createTestUser({ name: 'Heavy' }); // few big items
    const many = await createTestUser({ name: 'Many' }); // many small items

    const seed = async (assigneeId: string | null, points: number) => {
      const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
      await setFields(item.id, { assigneeId, storyPoints: points, status: 'todo' });
    };
    // Heavy: 1 item × 20 pts. Many: 3 items × 1 pt = 3 pts.
    await seed(heavy.id, 20);
    await seed(many.id, 1);
    await seed(many.id, 1);
    await seed(many.id, 1);

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'issue_count' }, fx.ctx),
    );
    // By COUNT, Many (3) outranks Heavy (1) — the opposite of the points order.
    expect(data.assignees.map((a) => [a.name, a.count])).toEqual([
      ['Many', 3],
      ['Heavy', 1],
    ]);
  });

  it('counts an unestimated open item as 0 points but still 1 to the count', async () => {
    const fx = await makeWorkItemFixture();
    const u = await createTestUser({ name: 'U' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
    await setFields(item.id, { assigneeId: u.id, storyPoints: null, status: 'todo' });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    expect(data.assignees).toEqual([
      {
        assigneeId: u.id,
        name: 'U',
        points: 0,
        count: 1,
        assignedPoints: 0,
        assignedCount: 1,
        unassignedPoints: 0,
        unassignedCount: 0,
      },
    ]);
  });

  it('returns an empty ranking + zero totals when there is no open work', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'done' });
    await setFields(item.id, { status: 'done', storyPoints: 5 });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    expect(data.assignees).toEqual([]);
    expect(data.totalPoints).toBe(0);
    expect(data.totalCount).toBe(0);
  });

  it('tie-breaks equal-measure assignees by name (the mapper localeCompare branch)', async () => {
    const fx = await makeWorkItemFixture();
    const zoe = await createTestUser({ name: 'Zoe' });
    const ana = await createTestUser({ name: 'Ana' });
    const seed = async (assigneeId: string) => {
      const item = await createTestWorkItem(fx, { kind: 'task', title: 'x' });
      await setFields(item.id, { assigneeId, storyPoints: 5, status: 'todo' });
    };
    await seed(zoe.id);
    await seed(ana.id);

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    // Equal points (5 each) → name-ascending: Ana before Zoe.
    expect(data.assignees.map((a) => a.name)).toEqual(['Ana', 'Zoe']);
  });

  it('narrows to a saved-filter scope through the compiled AST', async () => {
    const fx = await makeWorkItemFixture();
    const u = await createTestUser({ name: 'U' });
    const hi = await createTestWorkItem(fx, { kind: 'task', title: 'hi' });
    const lo = await createTestWorkItem(fx, { kind: 'task', title: 'lo' });
    await setFields(hi.id, { assigneeId: u.id, storyPoints: 8, status: 'todo' });
    await setFields(lo.id, { assigneeId: u.id, storyPoints: 3, status: 'todo' });
    await adminDb.workItem.update({ where: { id: hi.id }, data: { priority: 'high' } });
    await adminDb.workItem.update({ where: { id: lo.id }, data: { priority: 'low' } });

    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'High only', visibility: 'project', filterParam: encodeFilterParam(HIGH_AST) },
      fx.ctx,
    );

    const data = await expectOk(
      reportsService.getWorkload({ savedFilterId: filter.id }, { measure: 'story_points' }, fx.ctx),
    );
    // Only the high-priority item counts through the filter scope.
    expect(data.totalCount).toBe(1);
    expect(data.totalPoints).toBe(8);
  });

  it('returns the stale state for a missing saved filter (the non-ok scope branch)', async () => {
    const fx = await makeWorkItemFixture();
    const result = await reportsService.getWorkload(
      { savedFilterId: 'nonexistent' },
      { measure: 'story_points' },
      fx.ctx,
    );
    expect(result.state).toBe('stale');
  });
});

// ── Story MOTIR-8919 — the WINDOWED read ─────────────────────────────────────
// Work open at any point in the last `daysBack` days, one bar per person (the
// assignee, else the reporter as a separate "unassigned" segment). Keyed on the
// LAST move into a done category, so resolve → reopen → resolve still counts.

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const WINDOW = { daysBack: 30 };

async function addRevision(
  workItemId: string,
  changedById: string,
  changedAt: Date,
  diff: Prisma.InputJsonValue,
): Promise<void> {
  await adminDb.workItemRevision.create({
    data: { workItemId, changedById, changeKind: 'updated', changedAt, diff },
  });
}
const toDone = { status: { from: 'todo', to: 'done' } };
const reopen = { status: { from: 'done', to: 'todo' } };

describe('getWorkload — over a window', () => {
  async function seed(
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>,
    o: {
      assigneeId: string | null;
      reporterId: string;
      points: number;
      status?: string;
      createdDaysAgo?: number;
    },
  ): Promise<WorkItem> {
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'w' });
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        assigneeId: o.assigneeId,
        reporterId: o.reporterId,
        storyPoints: o.points,
        status: o.status ?? 'todo',
        createdAt: daysAgo(o.createdDaysAgo ?? 5),
      },
    });
    return item;
  }

  it('(a) puts an assigned open item on its assignee bar in assigned*', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    await seed(fx, { assigneeId: bo.id, reporterId: fx.ownerId, points: 5 });

    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.window?.daysBack).toBe(30);
    // No period on the window: the bars have no time buckets (MOTIR-10346).
    expect(data.window).not.toHaveProperty('period');
    expect(data.assignees).toEqual([
      {
        assigneeId: bo.id,
        name: 'Bo',
        points: 5,
        count: 1,
        assignedPoints: 5,
        assignedCount: 1,
        unassignedPoints: 0,
        unassignedCount: 0,
      },
    ]);
  });

  it("(b) puts an unassigned item on its reporter's bar, merged with their assigned work", async () => {
    const fx = await makeWorkItemFixture();
    const r = await createTestUser({ name: 'Rae' });
    await seed(fx, { assigneeId: r.id, reporterId: fx.ownerId, points: 3 });
    await seed(fx, { assigneeId: null, reporterId: r.id, points: 8 });

    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.assignees).toHaveLength(1);
    expect(data.assignees[0]).toMatchObject({
      assigneeId: r.id,
      points: 11,
      count: 2,
      assignedPoints: 3,
      assignedCount: 1,
      unassignedPoints: 8,
      unassignedCount: 1,
    });
    const a = data.assignees[0]!;
    expect(a.points).toBe(a.assignedPoints + a.unassignedPoints);
  });

  it('(c) the schema requires a reporter, so the repository never emits a person-less row here', async () => {
    // `work_item.reporterId` is NOT NULL: the neutral Unassigned bar is a
    // mapper-level shape (covered in tests/reports/workload-mapper.test.ts); a
    // real seed always resolves an unassigned item to its reporter.
    const fx = await makeWorkItemFixture();
    await seed(fx, { assigneeId: null, reporterId: fx.ownerId, points: 2 });
    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.assignees.every((x) => x.assigneeId !== null)).toBe(true);
    expect(data.assignees[0]).toMatchObject({ unassignedPoints: 2, assignedPoints: 0 });
  });

  it('(d) counts an item resolved inside the window; not one resolved before it and still done', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const inside = await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 4,
      status: 'done',
      createdDaysAgo: 40,
    });
    await addRevision(inside.id, fx.ownerId, daysAgo(10), toDone);
    const before = await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 100,
      status: 'done',
      createdDaysAgo: 80,
    });
    await addRevision(before.id, fx.ownerId, daysAgo(50), toDone);

    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.totalPoints).toBe(4);
    expect(data.totalCount).toBe(1);
  });

  it('(e) counts resolved-before, reopened, resolved-again inside the window (the LAST done-entry)', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const item = await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 6,
      status: 'done',
      createdDaysAgo: 90,
    });
    await addRevision(item.id, fx.ownerId, daysAgo(60), toDone);
    await addRevision(item.id, fx.ownerId, daysAgo(45), reopen);
    await addRevision(item.id, fx.ownerId, daysAgo(7), toDone);

    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.totalPoints).toBe(6);
    expect(data.totalCount).toBe(1);
  });

  it('(f) excludes an item created and resolved before the window starts; and one done with no done-entry', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const old = await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 9,
      status: 'done',
      createdDaysAgo: 70,
    });
    await addRevision(old.id, fx.ownerId, daysAgo(65), toDone);
    await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 9,
      status: 'done',
      createdDaysAgo: 3,
    }); // created straight into done: no recorded open time

    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.assignees).toEqual([]);
  });

  it('(g) an empty window returns the empty envelope, never NaN', async () => {
    const fx = await makeWorkItemFixture();
    const data = await expectOk(
      reportsService.getWorkload(
        { projectId: fx.projectId },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.assignees).toEqual([]);
    expect(data.totalPoints).toBe(0);
    expect(data.totalCount).toBe(0);
    expect(data.window).not.toBeNull();
  });

  it('(h) with no window it is exactly the snapshot: window null, all-assigned, unassigned 0', async () => {
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    await seed(fx, { assigneeId: bo.id, reporterId: fx.ownerId, points: 5 });
    await seed(fx, { assigneeId: null, reporterId: fx.ownerId, points: 2 });

    const data = await expectOk(
      reportsService.getWorkload({ projectId: fx.projectId }, { measure: 'story_points' }, fx.ctx),
    );
    expect(data.window).toBeNull();
    expect(data.assignees.map((a) => [a.name, a.points, a.count])).toEqual([
      ['Bo', 5, 1],
      [null, 2, 1],
    ]);
    expect(data.assignees.every((a) => a.unassignedPoints === 0 && a.unassignedCount === 0)).toBe(
      true,
    );
    expect(data.assignees[0]).toMatchObject({ assignedPoints: 5, assignedCount: 1 });
  });

  it('(i) a saved-filter scope narrows the windowed read', async () => {
    const fx = await makeWorkItemFixture();
    const u = await createTestUser({ name: 'U' });
    const hi = await seed(fx, { assigneeId: u.id, reporterId: fx.ownerId, points: 8 });
    const lo = await seed(fx, { assigneeId: u.id, reporterId: fx.ownerId, points: 3 });
    await adminDb.workItem.update({ where: { id: hi.id }, data: { priority: 'high' } });
    await adminDb.workItem.update({ where: { id: lo.id }, data: { priority: 'low' } });
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      { name: 'High only', visibility: 'project', filterParam: encodeFilterParam(HIGH_AST) },
      fx.ctx,
    );

    const data = await expectOk(
      reportsService.getWorkload(
        { savedFilterId: filter.id },
        { measure: 'story_points', window: WINDOW },
        fx.ctx,
      ),
    );
    expect(data.totalCount).toBe(1);
    expect(data.totalPoints).toBe(8);
  });

  it('rejects a window outside the allowed set with the typed 422, before scope resolution', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      reportsService.getWorkload(
        { savedFilterId: 'nonexistent' },
        { measure: 'story_points', window: { daysBack: 9999 } },
        fx.ctx,
      ),
    ).rejects.toThrow(InvalidReportWindowError);
  });

  it('(j) reaches past the daily bucket cap: 180 and 365 days back are windows, not a 422 (MOTIR-10346)', async () => {
    // Workload has no bucket axis, so the 120-day cap that bounds a DAILY axis
    // does not apply: an item resolved 150 days ago is out of a 120-day window
    // and inside a 180-day one.
    const fx = await makeWorkItemFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const old = await seed(fx, {
      assigneeId: bo.id,
      reporterId: fx.ownerId,
      points: 6,
      status: 'done',
      createdDaysAgo: 200,
    });
    await addRevision(old.id, fx.ownerId, daysAgo(150), toDone);
    const read = (daysBack: number) =>
      expectOk(
        reportsService.getWorkload(
          { projectId: fx.projectId },
          { measure: 'story_points', window: { daysBack } },
          fx.ctx,
        ),
      );

    expect((await read(120)).totalPoints).toBe(0);
    const half = await read(180);
    expect(half.totalPoints).toBe(6);
    expect(half.window?.daysBack).toBe(180);
    expect((await read(365)).totalPoints).toBe(6);
  });
});
