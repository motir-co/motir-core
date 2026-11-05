import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { toWorkloadDto } from '@/lib/mappers/reportsMappers';
import { pickReportSprints } from '@/lib/reports/sprintPicker';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { SprintDto } from '@/lib/dto/sprints';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { Prisma } from '@/generated/prisma/client';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// cannot supply) — the single allowed mock. The service-level cases pass `ctx`
// explicitly; the transport cases drive it through `wsCtx.current`.
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

// Story MOTIR-8919 · the story gate, cases 1–7. The ASSEMBLED seams no single
// feature card's suite reaches: the two new reads (windowed Workload, ranged
// Velocity) across two workspaces and, in one workspace, two projects. Real
// Postgres. Every fixture is built so an UNSCOPED read would return a different
// number — the other tenant's and the other project's items carry points and
// counts — because a single-tenant seed gets the same answer from a leaking
// query and a correct one. Feature-level cases stay in
// `workload.test.ts` / `velocity.test.ts` and are not repeated here.

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);
const WINDOW = { daysBack: 30 };

beforeEach(async () => {
  wsCtx.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedItem(
  fx: Pick<WorkItemFixture, 'workspaceId' | 'projectId' | 'ownerId' | 'ctx'> &
    Partial<WorkItemFixture>,
  o: {
    assigneeId: string | null;
    reporterId: string;
    points: number;
    status?: string;
    createdDaysAgo?: number;
  },
): Promise<{ id: string }> {
  const item = await createTestWorkItem(fx as WorkItemFixture, { kind: 'task', title: 'w' });
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

async function addDoneRevision(
  workItemId: string,
  changedById: string,
  changedAt: Date,
): Promise<void> {
  await adminDb.workItemRevision.create({
    data: {
      workItemId,
      changedById,
      changeKind: 'updated',
      changedAt,
      diff: { status: { from: 'todo', to: 'done' } } as Prisma.InputJsonValue,
    },
  });
}

async function windowed(fx: WorkItemFixture, projectId = fx.projectId) {
  const result = await reportsService.getWorkload(
    { projectId },
    { measure: 'story_points', window: WINDOW },
    fx.ctx,
  );
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('unreachable');
  return result.data;
}

/** Two workspaces, A (with a second project) and B; each carries its own people
 * and work. B's and project 2's numbers differ from A project 1's on purpose. */
async function seedTenants() {
  const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
  const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
  const a2 = await createTestProject({
    workspaceId: a.workspaceId,
    actorUserId: a.ownerId,
    identifier: 'AAB',
  });
  const aBo = await createTestUser({ name: 'Bo' });
  const aRae = await createTestUser({ name: 'Rae' });
  const bCy = await createTestUser({ name: 'Cy' });
  const bDee = await createTestUser({ name: 'Dee' });

  // A · project 1 — Bo 5 assigned; Rae 3 unassigned-reported; one item resolved 40 days ago (outside the window), one resolved 5 days ago
  // (inside it, so still counted); one still-open item older than the window.
  await seedItem(a, { assigneeId: aBo.id, reporterId: a.ownerId, points: 5 });
  await seedItem(a, { assigneeId: null, reporterId: aRae.id, points: 3 });
  const longGone = await seedItem(a, {
    assigneeId: aBo.id,
    reporterId: a.ownerId,
    points: 13,
    status: 'done',
    createdDaysAgo: 90,
  });
  await addDoneRevision(longGone.id, a.ownerId, daysAgo(40));
  const justDone = await seedItem(a, {
    assigneeId: aBo.id,
    reporterId: a.ownerId,
    points: 8,
    status: 'done',
    createdDaysAgo: 90,
  });
  await addDoneRevision(justDone.id, a.ownerId, daysAgo(5));
  await seedItem(a, { assigneeId: aBo.id, reporterId: a.ownerId, points: 1, createdDaysAgo: 90 });

  // A · project 2 — same workspace, different project: must never reach project 1.
  const a2fx = { ...a, projectId: a2.id } as WorkItemFixture;
  await seedItem(a2fx, { assigneeId: aBo.id, reporterId: a.ownerId, points: 21 });
  await seedItem(a2fx, { assigneeId: null, reporterId: aRae.id, points: 34 });

  // B — its own people and a lot of work.
  await seedItem(b, { assigneeId: bCy.id, reporterId: b.ownerId, points: 55 });
  await seedItem(b, { assigneeId: null, reporterId: bDee.id, points: 89 });
  return { a, b, a2, aBo, aRae, bCy, bDee };
}

describe('story gate A1–A3 — the windowed Workload read keeps its scope', () => {
  it('A1: returns only workspace A’s people and totals — and the same from B’s side', async () => {
    const { a, b, aBo, aRae, bCy, bDee } = await seedTenants();

    const fromA = await windowed(a);
    // Bo: 5 + 8 (done inside the window) + 1 (open since before it) = 14 / 3 items.
    // The 13-point item resolved 40 days ago is outside the window.
    expect(fromA.assignees.map((p) => [p.name, p.points, p.count])).toEqual([
      ['Bo', 14, 3],
      ['Rae', 3, 1],
    ]);
    expect(fromA.assignees.map((p) => p.assigneeId)).toEqual([aBo.id, aRae.id]);
    expect(fromA.totalPoints).toBe(17);
    expect(fromA.totalCount).toBe(4);
    const ids = fromA.assignees.map((p) => p.assigneeId);
    expect(ids).not.toContain(bCy.id);
    expect(ids).not.toContain(bDee.id);

    const fromB = await windowed(b);
    expect(fromB.assignees.map((p) => [p.name, p.points, p.count])).toEqual([
      ['Dee', 89, 1],
      ['Cy', 55, 1],
    ]);
    expect(fromB.totalPoints).toBe(144);
    expect(fromB.assignees.map((p) => p.assigneeId)).not.toContain(aBo.id);
    expect(fromB.assignees.map((p) => p.assigneeId)).not.toContain(aRae.id);
  });

  it('A2: project 1’s read carries none of project 2’s items (the projectId predicate)', async () => {
    const { a, a2 } = await seedTenants();
    const one = await windowed(a);
    const two = await windowed(a, a2.id);
    expect(one.totalPoints).toBe(17);
    expect(two.totalPoints).toBe(55); // 21 + 34
    expect(two.assignees.map((p) => [p.name, p.points])).toEqual([
      ['Rae', 34],
      ['Bo', 21],
    ]);
    // Rae's bar differs between the projects: 3 here, 34 there.
    expect(one.assignees.find((p) => p.name === 'Rae')?.points).toBe(3);
  });

  it('A3: a reporter who belongs to the other workspace shows only on the side that holds the work', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const shared = await createTestUser({ name: 'Shared' });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: b.workspaceId, userId: shared.id, workspaceRole: 'member' },
    });
    await seedItem(a, { assigneeId: null, reporterId: shared.id, points: 8 });
    await seedItem(b, { assigneeId: shared.id, reporterId: b.ownerId, points: 1 });

    const fromA = await windowed(a);
    expect(fromA.assignees).toHaveLength(1);
    expect(fromA.assignees[0]).toMatchObject({
      assigneeId: shared.id,
      points: 8,
      assignedPoints: 0,
      unassignedPoints: 8,
      unassignedCount: 1,
    });
    const fromB = await windowed(b);
    expect(fromB.assignees).toHaveLength(1);
    expect(fromB.assignees[0]).toMatchObject({
      assigneeId: shared.id,
      points: 1,
      assignedPoints: 1,
      unassignedPoints: 0,
    });
  });
});

describe('story gate A4 — the dashboard gadget’s snapshot is unchanged', () => {
  it('equals the untouched repository aggregate, with window null and unassigned* zero', async () => {
    const { a } = await seedTenants();
    const result = await reportsService.getWorkload(
      { projectId: a.projectId },
      { measure: 'story_points' },
      a.ctx,
    );
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('unreachable');

    const rows = await withWorkspaceServiceContext(a.workspaceId, (tx) =>
      workItemRepository.aggregateWorkloadByAssignee(a.projectId, a.workspaceId, undefined, tx),
    );
    const direct = toWorkloadDto('story_points', rows);
    expect(result.data.assignees.map((p) => [p.assigneeId, p.name, p.points, p.count])).toEqual(
      direct.assignees.map((p) => [p.assigneeId, p.name, p.points, p.count]),
    );
    expect(result.data.window ?? null).toBeNull();
    for (const p of result.data.assignees) {
      expect(p.unassignedPoints).toBe(0);
      expect(p.unassignedCount).toBe(0);
    }
  });
});

/** A completed sprint with the given completion time, in the fixture's project. */
async function completed(
  fx: { workspaceId: string; projectId: string },
  name: string,
  sequence: number,
  completedAt: Date,
): Promise<string> {
  const sprint = await adminDb.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name,
      state: 'complete',
      completedAt,
      sequence,
      committedPoints: 10,
      committedIssueCount: 1,
    },
  });
  return sprint.id;
}

const at = (n: number): Date => new Date(Date.UTC(2026, 0, n, 12));

describe('story gate A5–A6 — the Velocity range keeps its scope and its order', () => {
  it('A5: an end sprint from another workspace or another project falls back to the default range', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const a2 = await createTestProject({
      workspaceId: a.workspaceId,
      actorUserId: a.ownerId,
      identifier: 'AAB',
    });
    const names: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      await completed(a, `S${i}`, i, at(i));
      names.push(`S${i}`);
    }
    const theirs = await completed(b, 'B-only', 1, at(20));
    const sibling = await completed(
      { workspaceId: a.workspaceId, projectId: a2.id },
      'A2-only',
      1,
      at(21),
    );
    const expected = names.slice(3); // the 7 latest: S4…S10

    for (const endSprintId of [theirs, sibling]) {
      const dto = await reportsService.getVelocity(
        { projectId: a.projectId, endSprintId, lastN: 3 },
        a.ctx,
      );
      // The foreign end sprint is ignored, so lastN 3 is the three LATEST of A.
      expect(dto.sprints.map((s) => s.name)).toEqual(['S8', 'S9', 'S10']);
    }
    const dto = await reportsService.getVelocity(
      { projectId: a.projectId, endSprintId: theirs },
      a.ctx,
    );
    expect(dto.sprints.map((s) => s.name)).toEqual(expected);
    expect(dto.sprints.map((s) => s.name)).not.toContain('B-only');
    expect(dto.sprints.map((s) => s.name)).not.toContain('A2-only');
  });

  it('A6: S6 / 3 is [S4, S5, S6], and equal completion times order by sequence like the picker', async () => {
    const fx = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const ids: Record<string, string> = {};
    for (let i = 1; i <= 8; i += 1) ids[`S${i}`] = await completed(fx, `S${i}`, i, at(i));
    // T1 and T2 complete at the very same instant; the sequence breaks the tie.
    ids.T1 = await completed(fx, 'T1', 9, at(15));
    ids.T2 = await completed(fx, 'T2', 10, at(15));

    const ranged = await reportsService.getVelocity(
      { projectId: fx.projectId, lastN: 3, endSprintId: ids.S6 },
      fx.ctx,
    );
    expect(ranged.sprints.map((s) => s.name)).toEqual(['S4', 'S5', 'S6']);

    const all = await reportsService.getVelocity({ projectId: fx.projectId, lastN: 10 }, fx.ctx);
    const velocityOrder = all.sprints.map((s) => s.name);
    expect(velocityOrder.slice(-2)).toEqual(['T1', 'T2']);

    const rows = await adminDb.sprint.findMany({
      where: { projectId: fx.projectId },
      orderBy: { sequence: 'asc' },
    });
    const dtos = rows.map(
      (r) => ({ id: r.id, name: r.name, state: r.state, sequence: r.sequence }) as SprintDto,
    );
    // The picker lists completed sprints newest first; reversed it is velocity's order.
    const pickerOrder = pickReportSprints(dtos)
      .pickerSprints.map((s) => s.name)
      .reverse();
    expect(pickerOrder).toEqual(velocityOrder);
  });
});

describe('story gate A7 — the HTTP reads keep their scope', () => {
  it('refuses a project from another workspace exactly as the snapshot request does, windowed or not', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    await seedItem(b, { assigneeId: b.ownerId, reporterId: b.ownerId, points: 9 });
    wsCtx.current = a.ctx;
    const { GET } = await import('@/app/api/reports/workload/route');
    const call = async (qs: string) => {
      const res = await GET(new Request(`http://localhost:3000/api/reports/workload?${qs}`));
      return { status: res.status, body: await res.json() };
    };

    const snapshot = await call(`projectId=${b.projectId}&measure=story_points`);
    const ranged = await call(
      `projectId=${b.projectId}&measure=story_points&period=week&daysBack=30`,
    );
    expect(ranged.status).toBe(snapshot.status);
    expect(ranged.body.state).toBe(snapshot.body.state);
    expect(JSON.stringify(ranged.body)).not.toContain(b.ownerId);
    expect(snapshot.body.data).toBeUndefined();
    expect(ranged.body.data).toBeUndefined();
  });

  it('GET /api/reports/workload ignores a stray ?period= — any value, the same bars (MOTIR-10346)', async () => {
    const fx = await makeWorkItemFixture();
    await seedItem(fx, { assigneeId: fx.ownerId, reporterId: fx.ownerId, points: 5 });
    wsCtx.current = fx.ctx;
    const { GET } = await import('@/app/api/reports/workload/route');
    const call = async (qs: string) => {
      const res = await GET(
        new Request(
          `http://localhost:3000/api/reports/workload?projectId=${fx.projectId}&measure=story_points&${qs}`,
        ),
      );
      return { status: res.status, body: await res.json() };
    };

    const plain = await call('daysBack=180');
    expect(plain.status).toBe(200);
    expect(plain.body.data.window.daysBack).toBe(180);
    expect(plain.body.data.window).not.toHaveProperty('period');
    // An old shared link: a period that used to cap the window at 120 days, and
    // one that was never a period at all. Neither is a 422; both read the same.
    for (const qs of ['period=day&daysBack=180', 'period=bogus&daysBack=180']) {
      const res = await call(qs);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ...plain.body.data,
        window: { ...plain.body.data.window, windowEnd: res.body.data.window.windowEnd },
      });
    }
    // `?period=` alone still asks for the window, as it did before (30 days).
    const periodOnly = await call('period=week');
    expect(periodOnly.status).toBe(200);
    expect(periodOnly.body.data.window.daysBack).toBe(30);
    // No window parameter at all is the open-now snapshot the gadget reads.
    expect((await call('')).body.data.window).toBeNull();
  });

  it('GET /api/projects/<key>/velocity?lastN=3 keeps its shape', async () => {
    const fx = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    for (let i = 1; i <= 5; i += 1) await completed(fx, `S${i}`, i, at(i));
    wsCtx.current = fx.ctx;
    const { GET } = await import('@/app/api/projects/[key]/velocity/route');
    const res = await GET(
      new Request(`http://localhost:3000/api/projects/${fx.projectIdentifier}/velocity?lastN=3`),
      { params: Promise.resolve({ key: fx.projectIdentifier }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['averageCompleted', 'sprints', 'statistic']);
    expect(body.sprints.map((s: { name: string }) => s.name)).toEqual(['S3', 'S4', 'S5']);
  });
});
