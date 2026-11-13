import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { readPlanProgress } from '@/lib/plans/planProgress';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-7820 · Subtask MOTIR-7825 — the server half of the ONE progress
// derivation, against real Postgres: the batched snapshots for a page of plans,
// the flag read that carries no body, and the review route's `progress`.

// ── The seams OUTSIDE the path under test (the route's session) ─────────────
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const wsCtx = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => wsCtx.current,
}));
const { GET: planRoute } = await import('@/app/api/plans/[id]/route');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  wsCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const SIZED = {
  type: 'code',
  executor: 'coding_agent',
  storyPoints: 3,
  estimateMinutes: 30,
  difficulty: 'medium',
} as const;

/** A generating plan with one authored leaf, one unauthored leaf and a modify,
 *  plus a step naming the committed work item `committedId`. */
async function generatingPlan(fx: WorkItemFixture, committedId: string, title = 'Being written') {
  // The modify's own target — one per plan, since a modify HOLDS its target.
  const modified = await createTestWorkItem(fx, { title: `Modified by ${title}`, kind: 'task' });
  const plan = await plansService.createPlan(fx.projectId, { title }, fx.ctx);
  const appended = await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Authored', kind: 'task', descriptionMd: 'Body', ...SIZED },
      },
      { op: 'add', proposedFields: { title: 'Bare', kind: 'task' } },
      { op: 'modify', workItemId: modified.id, patch: { title: 'Renamed' } },
    ],
    fx.ctx,
  );
  await plansService.recordPlanStep(
    plan.id,
    { sessionKey: 'relay', kind: 'lay', targetRef: committedId },
    fx.ctx,
  );
  return { planId: plan.id, addIds: appended.items.filter((i) => i.op === 'add').map((i) => i.id) };
}

const planInputs = async (ids: string[]) =>
  (await adminDb.plan.findMany({ where: { id: { in: ids } } })).map((p) => ({
    id: p.id,
    status: p.status,
    createdAt: p.createdAt,
    lastActivityAt: p.lastActivityAt,
    sessionId: p.sessionId,
  }));

/** Every statement the pg driver sends, minus the transaction's own frames. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(pg.Client.prototype, 'query');
  try {
    await fn();
    return spy.mock.calls.filter(([q]) => {
      const text = typeof q === 'string' ? q : ((q as { text?: string })?.text ?? '');
      return !/^\s*(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/i.test(text);
    }).length;
  } finally {
    spy.mockRestore();
  }
}

/** Store `authorFinished` exactly as given — the driver's word, read back by the flag. */
async function storeAuthorFinished(itemId: string, value: unknown): Promise<void> {
  const row = await adminDb.planItem.findUniqueOrThrow({ where: { id: itemId } });
  await adminDb.planItem.update({
    where: { id: itemId },
    data: {
      proposedFields: { ...(row.proposedFields as Record<string, unknown>), authorFinished: value },
    } as never,
  });
}

describe('findProgressRowsByPlanIds — the stored written state, never bodies', () => {
  it('returns one row per ADD whose authorFinished is exactly `true`, and no body text', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed', kind: 'task' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Flags' }, fx.ctx);
    // A live session while the cards are appended, so core stamps none of them
    // by hand and each row carries only what this test stores.
    await plansService.recordPlanStep(
      plan.id,
      { sessionKey: 'walk', kind: 'lay', targetRef: null },
      fx.ctx,
    );
    const appended = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Stamped',
            kind: 'task',
            descriptionMd: 'Body',
            explanationMd: 'Why',
            ...SIZED,
          },
        },
        { op: 'add', proposedFields: { title: 'String', kind: 'story', descriptionMd: 'Body' } },
        { op: 'add', proposedFields: { title: 'Cleared', kind: 'task' } },
        { op: 'add', proposedFields: { title: 'Absent', kind: 'task', descriptionMd: 'Body' } },
        { op: 'modify', workItemId: committed.id, patch: { title: 'Not an add' } },
      ],
      fx.ctx,
    );
    const [stamped, asString, cleared] = appended.appendedItemIds;
    await storeAuthorFinished(stamped!, true);
    await storeAuthorFinished(asString!, 'true');
    await storeAuthorFinished(cleared!, null);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planItemRepository.findProgressRowsByPlanIds([plan.id], tx),
    );
    expect(rows).toHaveLength(4);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('Stamped')).toEqual({
      planId: plan.id,
      id: stamped,
      kind: 'task',
      title: 'Stamped',
      workItemId: null,
      parentRef: null,
      authorFinished: true,
    });
    // A stored STRING is not the flag — the SQL compares JSON, exactly as the
    // predicate compares `=== true`.
    expect(byTitle.get('String')).toMatchObject({ kind: 'story', authorFinished: false });
    expect(byTitle.get('Cleared')).toMatchObject({ authorFinished: false });
    expect(byTitle.get('Absent')).toMatchObject({ authorFinished: false });
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('descriptionMd');
      expect(Object.keys(row)).not.toContain('explanationMd');
      expect(JSON.stringify(row)).not.toContain('Body');
      expect(JSON.stringify(row)).not.toContain('Why');
    }
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planItemRepository.findProgressRowsByPlanIds([], tx),
      ),
    ).toEqual([]);
  });
});

describe('snapshotsForPlans — one entry per generating plan, batched', () => {
  it('maps three generating plans and skips the planned one', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed parent', kind: 'story' });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1)
      ids.push((await generatingPlan(fx, committed.id, `P${i}`)).planId);
    await plansService.markPlanned(ids[3]!, fx.ctx);

    const map = await planProgressService.snapshotsForPlans(await planInputs(ids), fx.ctx);
    expect([...map.keys()].sort()).toEqual(ids.slice(0, 3).sort());
    expect(map.has(ids[3]!)).toBe(false);
    for (const id of ids.slice(0, 3)) {
      const snap = map.get(id)!;
      // The modify is in neither number; the bare task is unauthored, and the
      // body written by hand with no session live is stamped (MOTIR-10490).
      expect(snap).toMatchObject({ authored: 1, proposed: 2 });
      expect(snap.steps).toEqual([
        expect.objectContaining({
          sessionKey: 'relay',
          phrase: 'layingChildrenOf',
          targetNodeId: committed.id,
          targetTitle: 'Committed parent',
        }),
      ]);
      expect(Date.parse(snap.observedAt)).not.toBeNaN();
    }
  });

  it('costs the same number of queries for 1 plan and for 10', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed', kind: 'story' });
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1)
      ids.push((await generatingPlan(fx, committed.id, `Q${i}`)).planId);
    const all = await planInputs(ids);

    const one = await countQueries(() =>
      planProgressService.snapshotsForPlans(all.slice(0, 1), fx.ctx),
    );
    const ten = await countQueries(() => planProgressService.snapshotsForPlans(all, fx.ctx));
    expect(one).toBeGreaterThan(0);
    expect(ten).toBe(one);
  });

  it('reads nothing for a page with no generating plan', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed', kind: 'story' });
    const { planId } = await generatingPlan(fx, committed.id);
    await plansService.markPlanned(planId, fx.ctx);
    const map = await planProgressService.snapshotsForPlans(await planInputs([planId]), fx.ctx);
    expect(map.size).toBe(0);
  });
});

describe('GET /api/plans/[id] carries progress', () => {
  it('returns progress while generating and progress: null once planned', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const committed = await createTestWorkItem(fx, { title: 'Committed parent', kind: 'story' });
    const { planId, addIds } = await generatingPlan(fx, committed.id);
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'writer', kind: 'author', targetRef: `planItem:${addIds[1]}` },
      fx.ctx,
    );
    await plansService.recordPlanStep(
      planId,
      { sessionKey: 'fresh', kind: 'author', targetRef: null },
      fx.ctx,
    );

    const read = async (): Promise<PlanReviewDto> => {
      const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
        params: Promise.resolve({ id: planId }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as PlanReviewDto;
    };

    const live = await read();
    expect(live.progress).toBeTruthy();
    const p = live.progress!;
    expect(p).toMatchObject({ authored: 1, proposed: 2, lastActivityAt: live.lastActivityAt });
    expect(p.startedAt).toBe(new Date(live.createdAt).toISOString());
    expect(typeof p.observedAt).toBe('string');
    expect(p.steps.map((s) => [s.sessionKey, s.phrase, s.targetTitle])).toEqual([
      ['relay', 'layingChildrenOf', 'Committed parent'],
      ['writer', 'authoring', 'Bare'],
      ['fresh', 'draftingNew', null],
    ]);
    // The authoring step names the add's node — its PlanReviewItemDto.nodeId.
    const bare = live.items.find((i) => i.planItemId === addIds[1]);
    expect(p.steps[1]!.targetNodeId).toBe(bare?.nodeId);

    // A withdrawn target drops out of the derivation (the raw steps keep it).
    await plansService.withdrawProposal(planId, addIds[1]!, fx.ctx);
    const after = await read();
    expect(after.progress!.steps.map((s) => s.sessionKey)).toEqual(['relay', 'fresh']);
    expect(after.inFlightSteps?.map((s) => s.sessionKey)).toContain('writer');

    await plansService.markPlanned(planId, fx.ctx);
    const closed = await read();
    expect(closed.progress).toBeNull();
  });

  it('carries a waiting session’s provider wait in its progress snapshot (MOTIR-9619)', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const committed = await createTestWorkItem(fx, { title: 'Committed parent', kind: 'story' });
    const { planId } = await generatingPlan(fx, committed.id);
    const retryAt = new Date(Date.now() + 6_000).toISOString();
    const stored = await plansService.reportPlanStep(
      planId,
      {
        sessionKey: 'relay',
        targetRef: null,
        providerRetry: { state: 'waiting', attempt: 2, maxAttempts: 3, retryAt },
      },
      fx.ctx,
    );
    expect(stored).toMatchObject({ kind: 'providerRetry', providerWait: { attempt: 2, retryAt } });

    const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
      params: Promise.resolve({ id: planId }),
    });
    expect(res.status).toBe(200);
    const live = (await res.json()) as PlanReviewDto;
    expect(live.progress!.steps.map((s) => [s.sessionKey, s.providerWait])).toEqual([
      ['relay', { attempt: 2, maxAttempts: 3, since: expect.any(String), retryAt }],
    ]);
  });
});

// Bug MOTIR-11184 — the quiet drop measures a step's LAST WRITE, not its start.
// The write rows are read in SQL for both doors; these pin what they carry.
describe('findWriteRowsByPlanIds — every proposal’s last write (MOTIR-11184)', () => {
  it('is the append for an unedited proposal and the latest `edited` row once deepened', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed parent', kind: 'story' });
    const { planId, addIds } = await generatingPlan(fx, committed.id);
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await adminDb.planItem.updateMany({ where: { planId }, data: { createdAt: longAgo } });
    await plansService.deepenProposal(planId, addIds[1]!, { descriptionMd: 'Now written' }, fx.ctx);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planItemRepository.findWriteRowsByPlanIds([planId], tx),
    );
    // Every op, not only the adds: an author step on a committed card writes a `modify`.
    expect(rows.map((r) => r.op).sort()).toEqual(['add', 'add', 'modify']);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(addIds[0]!)).toMatchObject({ planId, parentRef: null, workItemId: null });
    expect(byId.get(addIds[0]!)!.writtenAt.getTime()).toBe(longAgo.getTime());
    expect(byId.get(addIds[1]!)!.writtenAt.getTime()).toBeGreaterThan(
      longAgo.getTime() + 30 * 60_000,
    );
    const modify = rows.find((r) => r.op === 'modify')!;
    expect(modify.workItemId).not.toBeNull();
    expect(Object.keys(modify).sort()).toEqual(
      ['id', 'op', 'parentRef', 'planId', 'workItemId', 'writtenAt'].sort(),
    );
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planItemRepository.findWriteRowsByPlanIds([], tx),
      ),
    ).toEqual([]);
  });
});

describe('both doors keep a long lay step live while it writes children (MOTIR-11184)', () => {
  /** A generating plan whose lay step on `committedId` started 20 minutes ago and
   *  whose first child under it lands now. */
  async function longLay(fx: WorkItemFixture, committedId: string) {
    const { planId } = await generatingPlan(fx, committedId);
    const startedAt = new Date(Date.now() - 20 * 60_000);
    await adminDb.planStep.updateMany({ where: { planId }, data: { startedAt } });
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          parentRef: committedId,
          proposedFields: { title: 'First child', kind: 'task' },
        },
      ],
      fx.ctx,
    );
    return { planId, startedAt };
  }

  it('snapshotsForPlans: the step carries its child’s write and reads live past 15 min', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Large story', kind: 'story' });
    const { planId, startedAt } = await longLay(fx, committed.id);
    const snap = (
      await planProgressService.snapshotsForPlans(await planInputs([planId]), fx.ctx)
    ).get(planId)!;
    const [step] = snap.steps;
    expect(step!.startedAt).toBe(startedAt.toISOString());
    expect(Date.parse(step!.lastActivityAt)).toBeGreaterThan(startedAt.getTime() + 19 * 60_000);
    expect(readPlanProgress(snap, Date.now()).liveSteps.map((s) => s.sessionKey)).toEqual([
      'relay',
    ]);
  });

  it('GET /api/plans/[id]: the review snapshot reads the same writes', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const committed = await createTestWorkItem(fx, { title: 'Large story', kind: 'story' });
    const { planId, startedAt } = await longLay(fx, committed.id);
    const res = await planRoute(new Request(`http://localhost/api/plans/${planId}`), {
      params: Promise.resolve({ id: planId }),
    });
    const live = (await res.json()) as PlanReviewDto;
    const step = live.progress!.steps[0]!;
    expect(step.startedAt).toBe(startedAt.toISOString());
    expect(Date.parse(step.lastActivityAt)).toBeGreaterThan(startedAt.getTime() + 19 * 60_000);
    expect(readPlanProgress(live.progress!, Date.now()).liveSteps).toHaveLength(1);
  });

  it('GET /api/plans/[id]: a settle-only plan reads no writes and keeps the start', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
    wsCtx.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const plan = await plansService.createPlan(fx.projectId, { title: 'Settling' }, fx.ctx);
    await plansService.recordPlanStep(
      plan.id,
      { sessionKey: 'settler', kind: 'settle', targetRef: null },
      fx.ctx,
    );
    const res = await planRoute(new Request(`http://localhost/api/plans/${plan.id}`), {
      params: Promise.resolve({ id: plan.id }),
    });
    const live = (await res.json()) as PlanReviewDto;
    const [step] = live.progress!.steps;
    expect(step).toMatchObject({ phrase: 'settling' });
    expect(step!.lastActivityAt).toBe(step!.startedAt);
  });
});
