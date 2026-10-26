import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planProgressService } from '@/lib/services/planProgressService';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
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
    projectId: p.projectId,
    status: p.status,
    createdAt: p.createdAt,
    lastActivityAt: p.lastActivityAt,
    authorSource: p.authorSource,
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

describe('findProgressRowsByPlanIds — flags, never bodies', () => {
  it('returns one row per ADD with flags matching its proposedFields, and no body text', async () => {
    const fx = await makeWorkItemFixture();
    const committed = await createTestWorkItem(fx, { title: 'Committed', kind: 'task' });
    const plan = await plansService.createPlan(fx.projectId, { title: 'Flags' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: {
            title: 'Full',
            kind: 'task',
            descriptionMd: 'Body',
            explanationMd: 'Why',
            ...SIZED,
          },
        },
        {
          op: 'add',
          proposedFields: {
            title: 'Blank',
            kind: 'story',
            descriptionMd: '   \n  ',
            explanationMd: null,
            storyPoints: null,
          },
        },
        { op: 'modify', workItemId: committed.id, patch: { title: 'Not an add' } },
      ],
      fx.ctx,
    );

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planItemRepository.findProgressRowsByPlanIds([plan.id], tx),
    );
    expect(rows).toHaveLength(2);
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.get('Full')).toMatchObject({
      planId: plan.id,
      kind: 'task',
      workItemId: null,
      parentRef: null,
      hasDescription: true,
      hasExplanation: true,
      hasType: true,
      hasExecutor: true,
      hasStoryPoints: true,
      hasEstimate: true,
      hasDifficulty: true,
    });
    expect(byTitle.get('Blank')).toMatchObject({
      kind: 'story',
      hasDescription: false,
      hasExplanation: false,
      hasType: false,
      hasExecutor: false,
      hasStoryPoints: false,
      hasEstimate: false,
      hasDifficulty: false,
    });
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
      // The modify is in neither number; the bare task is unauthored. A plan with
      // no author source on a project with explanations OFF does not owe them.
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
