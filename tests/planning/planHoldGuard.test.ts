import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// THE PLAN HOLD (Story MOTIR-6017 · Subtask MOTIR-6265;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 21) — against a REAL Postgres,
// through the shipped services and doors. Only the session and active-project
// resolvers are stubbed, as every route/action suite here does.
//
// What it pins:
//   · the funnel refuses every non-system move OUT of `planning` while an
//     undecided plan holds the card, with the full `PLAN_TARGET_HELD` payload;
//   · a system write, and every one of the plan's own exits, still moves it;
//   · a SESSION-held park and an expired `generating` lease stay movable;
//   · a `stale` plan still holds, and its lock no longer expires;
//   · a hand move racing a decline ends in exactly one of the two legal outcomes;
//   · the board, the status action and MCP answer with the same code and payload
//     (the v1 door is `tests/api/v1/work-item-transitions-plan-hold.test.ts`);
//   · the parent rollup records `plan_held` rather than failing its job.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { PlanTargetHeldError } from '@/lib/workItems/errors';
import { runTransitionStatus } from '@/lib/mcp/tools/transitionStatus';
import { changeStatusAction } from '@/app/(authed)/items/[key]/edit/actions';
import { POST as movePOST } from '@/app/api/board/move/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: fx.owner.email, name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(title = 'The card'): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title, descriptionMd: 'The old body.' },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function lockFor(workItemId: string) {
  return adminDb.planTargetLock.findUnique({ where: { workItemId } });
}

/** An MCP-authored plan with one `modify` naming the card — still `generating`.
 *  The append PARKS the card at `planning` under a plan-held lock. */
async function generatingModify(workItemId: string): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Re-plan' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [{ op: 'modify', workItemId, patch: { descriptionMd: 'Re-scoped.' } }],
    fx.ctx,
  );
  return plan.id;
}

async function plannedModify(workItemId: string): Promise<string> {
  const planId = await generatingModify(workItemId);
  await plansService.markPlanned(planId, fx.ctx);
  return planId;
}

async function expectHeldRefusal(
  card: { id: string; identifier: string },
  planId: string,
  planStatus: 'generating' | 'planned' | 'stale',
  to: string,
) {
  const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
  const err = await workItemsService.updateStatus(card.id, to, fx.ctx).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(PlanTargetHeldError);
  expect((err as PlanTargetHeldError).code).toBe('PLAN_TARGET_HELD');
  expect((err as PlanTargetHeldError).payload).toEqual({
    kind: 'plan',
    itemKey: card.identifier,
    workItemId: card.id,
    planId,
    planStatus,
    sessionId: plan.sessionId,
    anchorKey: expect.toSatisfy((v: unknown) => v === null || typeof v === 'string'),
  });
  expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
}

describe('the funnel refuses a hand move out of Planning while an undecided plan holds the card', () => {
  it(
    'refuses EVERY target on a `generating` plan, with the full payload',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await generatingModify(card.id);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);

      // The only edges out of `planning` in the default workflow.
      for (const to of ['todo', 'in_progress', 'blocked', 'cancelled']) {
        await expectHeldRefusal(card, planId, 'generating', to);
      }
    },
  );

  it('refuses on a `planned` plan', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await expectHeldRefusal(card, planId, 'planned', 'in_progress');
  });

  it(
    'refuses on a `stale` plan — stale is UNDECIDED (§1)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
      await expectHeldRefusal(card, planId, 'stale', 'todo');
    },
  );

  it(
    'names the session’s first anchor key when the session has targets',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      expect(plan.sessionId).not.toBeNull();
      await adminDb.planChangeSession.update({
        where: { id: plan.sessionId! },
        data: { targetKeys: [card.identifier, 'OTHER-1'] },
      });

      const err = (await workItemsService
        .updateStatus(card.id, 'todo', fx.ctx)
        .catch((e: unknown) => e)) as PlanTargetHeldError;
      expect(err.anchorKey).toBe(card.identifier);
      expect(err.sessionId).toBe(plan.sessionId);
    },
  );

  it(
    'a SYSTEM write moves the held card — the plan’s own exits are system writes',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await plannedModify(card.id);
      await withWorkspaceContext(fx.ctx, (tx) =>
        workItemsService.applyStatusTransition(card.id, 'todo', fx.ctx, tx, { system: true }),
      );
      expect(await statusOf(card.id)).toBe('todo');
    },
  );

  it(
    'a move INTO Planning is untouched — only leaving is held',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, PLANNING_STATUS_KEY, fx.ctx);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('what is NOT held (§1’s exclusions)', () => {
  it(
    'a card hand-parked with no plan stays movable by hand',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await workItemsService.updateStatus(card.id, PLANNING_STATUS_KEY, fx.ctx);
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );

  it(
    'a SESSION-held lock holds while its session is OPEN, and frees once it ends (AMENDMENT 23 §5)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      // Re-shape the lock as a session lease on the same card: planId null.
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { planId: null, sessionId: plan.sessionId },
      });

      const session = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: plan.sessionId! },
      });
      const err = await workItemsService
        .updateStatus(card.id, 'in_progress', fx.ctx)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PlanTargetHeldError);
      expect((err as PlanTargetHeldError).payload).toMatchObject({
        kind: 'session',
        itemKey: card.identifier,
        workItemId: card.id,
        planId: null,
        planStatus: null,
        sessionId: plan.sessionId,
        holderId: session.createdById,
        heldByViewer: session.createdById === fx.ctx.userId,
      });
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toMatchObject({
        kind: 'session',
        sessionId: plan.sessionId,
      });

      // An EXPIRED lease on an open session still holds (§5: no override).
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toMatchObject({
        kind: 'session',
      });

      // The session ENDS: the lock no longer holds, the card moves by hand.
      await adminDb.planChangeSession.update({
        where: { id: plan.sessionId! },
        data: { endedAt: new Date(), endReason: 'idle' },
      });
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toBeNull();
      await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
      expect(await statusOf(card.id)).toBe('in_progress');
    },
  );

  it(
    'an EXPIRED lease on a `generating` plan does not hold',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await generatingModify(card.id);
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      await workItemsService.updateStatus(card.id, 'todo', fx.ctx);
      expect(await statusOf(card.id)).toBe('todo');
    },
  );
});

describe('every exit of the plan still moves the card (§3)', () => {
  it('approve rests it', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await plansService.approvePlan(planId, fx.ctx);
    expect(await statusOf(card.id)).not.toBe(PLANNING_STATUS_KEY);
    expect(await lockFor(card.id)).toBeNull();
  });

  it('decline restores the prior status', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    await plansService.declinePlan(planId, fx.ctx);
    expect(await statusOf(card.id)).toBe('todo');
    expect(await lockFor(card.id)).toBeNull();
  });

  it(
    'a withdraw that empties the plan, then its close',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await generatingModify(card.id);
      await plansService.withdrawProposal(
        planId,
        (await adminDb.planItem.findFirstOrThrow({ where: { planId } })).id,
        fx.ctx,
      );
      await plansService.markPlanned(planId, fx.ctx);
      expect(await statusOf(card.id)).toBe('todo');
      expect(await lockFor(card.id)).toBeNull();
    },
  );

  it(
    'a discarded close (decline of a generating plan)',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await generatingModify(card.id);
      await plansService.declinePlan(planId, fx.ctx);
      expect(await statusOf(card.id)).toBe('todo');
      expect(await lockFor(card.id)).toBeNull();
    },
  );

  it(
    'the abandoned-plan sweep releases an expired `generating` lock',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await generatingModify(card.id);
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const out = await planTargetLockService.releaseExpired();
      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'restored' }]);
      expect(await statusOf(card.id)).toBe('todo');
    },
  );
});

describe('§4 — a `stale` plan’s lock never expires', () => {
  it(
    'leaves an expired `stale` lock in place and reports it as awaiting review',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'plan_awaiting_review' }]);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await lockFor(card.id)).not.toBeNull();
    },
  );
});

// Bug MOTIR-9006 — a plan BEING APPROVED holds its cards until the approval commits, and
// its lock outlives the window exactly as a `planned` one's does.
describe('an `approving` plan holds its cards', () => {
  it(
    'leaves an expired `approving` lock in place and reports it as awaiting review',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({
        where: { id: planId },
        data: { status: 'approving', approvingAt: new Date() },
      });
      await adminDb.planTargetLock.update({
        where: { workItemId: card.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const out = await planTargetLockService.releaseExpired();

      expect(out.entries).toEqual([{ workItemId: card.id, outcome: 'plan_awaiting_review' }]);
      expect(await lockFor(card.id)).not.toBeNull();
    },
  );

  it(
    'MCP `transition_status` says the plan is being approved',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({
        where: { id: planId },
        data: { status: 'approving', approvingAt: new Date() },
      });

      const res = await runTransitionStatus(
        { key: card.identifier, status: 'In Progress' },
        fx.ctx,
      );

      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(`Plan ${planId} is being approved`);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('readPlanHold — the up-front read', () => {
  it('returns the DTO for a held card', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const card = await seedCard();
    const planId = await plannedModify(card.id);
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toEqual({
      kind: 'plan',
      itemKey: card.identifier,
      workItemId: card.id,
      planId,
      planStatus: 'planned',
      sessionId: plan.sessionId,
      anchorKey: expect.toSatisfy((v: unknown) => v === null || typeof v === 'string'),
    });
  });

  it(
    'returns null for a card that is not held — no lock, and a decided plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const free = await seedCard('Free');
      expect(await planTargetLockService.readPlanHold(free.id, fx.ctx)).toBeNull();

      const card = await seedCard();
      const planId = await plannedModify(card.id);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
      expect(await planTargetLockService.readPlanHold(card.id, fx.ctx)).toBeNull();
    },
  );
});

describe('the quick-view read carries the plan hold (MOTIR-6267)', () => {
  const peek = (identifier: string) =>
    workItemsService.getQuickView(fx.project.id, identifier, fx.project.accessMode, fx.ctx, 'en');

  it(
    'a held card’s peek carries the same PlanHoldDTO the up-front read returns; a free one carries null',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      await plannedModify(card.id);
      const expected = await planTargetLockService.readPlanHold(card.id, fx.ctx);
      expect(expected).not.toBeNull();
      expect((await peek(card.identifier)).planHold).toEqual(expected);

      const free = await seedCard('Free');
      expect((await peek(free.identifier)).planHold).toBeNull();
    },
  );
});

describe('the race with the plan’s own release', () => {
  it(
    'a hand move and a decline on one held card end in exactly one legal outcome',
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < 5; round++) {
        const card = await seedCard(`Race ${round}`);
        const planId = await plannedModify(card.id);

        const [move, decline] = await Promise.allSettled([
          workItemsService.updateStatus(card.id, 'in_progress', fx.ctx),
          plansService.declinePlan(planId, fx.ctx),
        ]);

        expect(decline.status, `round ${round}`).toBe('fulfilled');
        // Whichever order the row lock gave, the lock row is gone.
        expect(await lockFor(card.id)).toBeNull();
        if (move.status === 'rejected') {
          // The hand move ran first: refused, and the decline restored the card.
          expect(move.reason).toBeInstanceOf(PlanTargetHeldError);
          expect(await statusOf(card.id)).toBe('todo');
        } else {
          // The release ran first: the card was restored, then moved as an
          // ordinary move.
          expect(await statusOf(card.id)).toBe('in_progress');
        }
      }
    },
  );
});

describe('the doors — one code, one payload', () => {
  async function boardColumns() {
    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const board = await adminDb.board.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Board',
        type: 'kanban',
        position: 'a0',
      },
    });
    const columns: Record<string, string> = {};
    for (const [n, status] of statuses.entries()) {
      const column = await adminDb.boardColumn.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          boardId: board.id,
          name: status.label,
          position: `c${n.toString(36)}`,
        },
      });
      await adminDb.boardColumnStatus.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          boardId: board.id,
          columnId: column.id,
          statusId: status.id,
        },
      });
      columns[status.key] = column.id;
    }
    return { boardId: board.id, columns };
  }

  it(
    'POST /api/board/move answers 409 `PLAN_TARGET_HELD` with `plan`',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);
      const { boardId, columns } = await boardColumns();

      const res = await movePOST(
        new Request('http://localhost:3000/api/board/move', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ boardId, workItemId: card.id, toColumnId: columns.in_progress }),
        }),
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; error: string; plan: unknown };
      expect(body.code).toBe('PLAN_TARGET_HELD');
      expect(body.plan).toMatchObject({ itemKey: card.identifier, planId, planStatus: 'planned' });
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it(
    'changeStatusAction returns `code` and `plan` on the status field',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);

      const result = await changeStatusAction({ id: card.id, toStatusKey: 'in_progress' });

      expect(result).toMatchObject({
        ok: false,
        field: 'status',
        code: 'PLAN_TARGET_HELD',
        plan: { itemKey: card.identifier, planId, planStatus: 'planned' },
      });
      expect(result.ok === false && result.error.length).toBeGreaterThan(0);
    },
  );

  it(
    'MCP `transition_status` answers a tool error naming the plan',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const planId = await plannedModify(card.id);

      const res = await runTransitionStatus(
        { key: card.identifier, status: 'In Progress' },
        fx.ctx,
      );

      expect(res.isError).toBe(true);
      const text = JSON.stringify(res.content);
      expect(text).toContain('PLAN_TARGET_HELD');
      expect(text).toContain(planId);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});
