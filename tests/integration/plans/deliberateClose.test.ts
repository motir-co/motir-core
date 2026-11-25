import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { InvalidProposalError, PlanWalkIncompleteError } from '@/lib/plans/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Story MOTIR-12203 · MOTIR-12207 — A WALK THAT ENDED ON PURPOSE CLOSES `planned`, AND
// ITS LAID-ONLY CARDS LAND `to_plan` ON APPROVE, against a REAL Postgres.
//
// A walk the project's Planning cadence stopped (`walkEndedBy: 'cadence'`) or the
// person's Stop ended (`'person_stop'`) is not a failure: the close
//   * stamps `leftLaid` on every `add` without `authorFinished` and stores
//     `walkEndedBy` on the plan,
//   * closes `planned` with its gate, records no failure on the session and leaves
//     no plan_step behind,
//   * and approve creates each `leftLaid` card at `to_plan` (never the derived
//     `blocked`) with its blocked_by edges, leaving a listed-but-unwritten committed
//     card exactly as it stands.
// Without `walkEndedBy` nothing changes: `tests/integration/plans/stoppedWalk.test.ts`
// pins that path, unchanged.
//
// motir-ai is stubbed at its client boundary (`submitJob`); everything else ships.

let jobSeq = 0;
const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: (...args: unknown[]) => submitJobMock(...args),
}));

const { plansService } = await import('@/lib/services/plansService');
const { planDecisionService } = await import('@/lib/services/planDecisionService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { runAddPlanItems, runHoldPlanRevision } = await import('@/lib/mcp/tools/authorPlan');

const T = { timeout: 120_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.restoreAllMocks();
  await truncateAuthTables();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

const planRow = (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });
const itemRow = (id: string) => adminDb.planItem.findUniqueOrThrow({ where: { id } });
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const awaitingGate = async (planId: string) =>
  (
    await adminDb.approvalGate.findMany({ where: { kind: 'plan_approval', subjectId: planId } })
  ).find((g) => g.state === 'awaiting') ?? null;
const leftLaidOf = async (id: string) =>
  ((await itemRow(id)).proposedFields as { leftLaid?: unknown }).leftLaid;
const actor = { source: 'mcp' as const, harness: 'Claude Code', model: null };

/** Appends `adds` under a live lay step (an add may name an earlier one as its
 *  blocker by index), stamps the first `written` as authored, and ends the lay. */
async function walk(
  planId: string,
  adds: { title: string; blockedBy?: number[] }[],
  written: number,
): Promise<string[]> {
  await plansService.recordPlanStep(
    planId,
    { sessionKey: 'lay', kind: 'lay', targetRef: null },
    fx.ctx,
  );
  const ids: string[] = [];
  for (const add of adds) {
    const appended = await plansService.addProposals(
      planId,
      [
        {
          op: 'add' as const,
          proposedFields: { title: add.title, kind: 'task' },
          ...(add.blockedBy
            ? { blockedByRefs: add.blockedBy.map((i) => `planItem:${ids[i]!}`) }
            : {}),
        },
      ],
      fx.ctx,
    );
    ids.push((appended.appendedItemIds as string[])[0]!);
  }
  for (const id of ids.slice(0, written)) {
    await plansService.deepenProposal(planId, id, { authorFinished: true }, fx.ctx);
  }
  await plansService.endPlanStep(planId, 'lay', fx.ctx);
  return ids;
}

async function barePlan(title = 'A plan') {
  return (await plansService.createPlan(fx.projectId, { title }, fx.ctx)).id;
}

/** A conversation's first attempt: a card held at Planning and its `generating` plan. */
async function attempt() {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: `Card ${Math.random()}` },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'in_progress' } });
  const session = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.identifier]),
    'plan this story',
  );
  const first = await planChangeSessionsService.submit(me(), { sessionId: session.id });
  return { card, sessionId: session.id, planId: first.planId };
}

async function approve(planId: string) {
  const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);
  return planDecisionService.approve({ planId, stamp: read.stamp, source: 'ui' }, fx.ctx);
}

/** The created work item for a materialized `add`. */
async function createdFor(planItemId: string) {
  const item = await itemRow(planItemId);
  return adminDb.workItem.findUniqueOrThrow({ where: { id: item.workItemId! } });
}

describe('a cadence close (MOTIR-12207)', () => {
  it(
    '⚠️ closes `planned` with its gate, stamps exactly the not-authored adds, owes no listed committed card',
    T,
    async () => {
      const a = await attempt();
      const listed = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Listed, never re-authored' },
        fx.ctx,
      );
      await plansService.correctPlanBrief(
        a.planId,
        { plannerRecord: { walkListed: [listed.id] } },
        fx.ctx,
      );
      const [authored, laidA, laidB] = await walk(
        a.planId,
        [{ title: 'Authored' }, { title: 'Laid A', blockedBy: [0] }, { title: 'Laid B' }],
        1,
      );
      // A live author step left behind by the stopped walk.
      await plansService.recordPlanStep(
        a.planId,
        { sessionKey: 'author-b', kind: 'author', targetRef: `planItem:${laidB!}` },
        fx.ctx,
      );

      const closed = await plansService.markPlanned(a.planId, fx.ctx, {
        walkEndedBy: 'cadence',
        walkIncomplete: true,
      });

      expect(closed.status).toBe('planned');
      expect(closed.walkEndedBy).toBe('cadence');
      const row = await planRow(a.planId);
      expect(row.status).toBe('planned');
      expect(row.plannedAt).not.toBeNull();
      expect(row.walkEndedBy).toBe('cadence');
      expect(await awaitingGate(a.planId)).not.toBeNull();
      expect(await adminDb.planStep.count({ where: { planId: a.planId } })).toBe(0);
      const session = await sessionRow(a.sessionId);
      expect(session.failedAt).toBeNull();
      expect(session.failureReason).toBeNull();
      const revision = await adminDb.planRevision.findFirstOrThrow({
        where: { planId: a.planId, changeKind: 'planned' },
      });
      expect(revision.diff).toMatchObject({ walkEndedBy: 'cadence', leftLaidCount: 2 });
      expect(
        await adminDb.planRevision.count({ where: { planId: a.planId, changeKind: 'stopped' } }),
      ).toBe(0);

      expect(await leftLaidOf(authored!)).toBeUndefined();
      expect(await leftLaidOf(laidA!)).toBe(true);
      expect(await leftLaidOf(laidB!)).toBe(true);
      // `get_plan` (the plan read) carries both.
      const read = await plansService.getPlan(a.planId, fx.ctx);
      expect(read.walkEndedBy).toBe('cadence');
      expect(
        read.items.filter((i) => (i.proposedFields as { leftLaid?: unknown }).leftLaid === true),
      ).toHaveLength(2);
      // The approvability read accepts it, naming the two it left laid.
      const verdict = await plansService.readWalkCompleteness(row, fx.ctx);
      expect(verdict).toMatchObject({ walked: true, complete: true, unwritten: [] });
      expect(verdict.leftLaid.map((c) => c.title)).toEqual(['Laid A', 'Laid B']);
    },
  );

  it(
    '⚠️ approve creates laid cards at `to_plan` with their edges, authored ones as before, and leaves the listed card alone',
    T,
    async () => {
      const a = await attempt();
      const listed = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Listed, never re-authored' },
        fx.ctx,
      );
      const listedBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: listed.id } });
      await plansService.correctPlanBrief(
        a.planId,
        { plannerRecord: { walkListed: [listed.id] } },
        fx.ctx,
      );
      const [authored, waits, laid, laidWaiting] = await walk(
        a.planId,
        [
          { title: 'Authored' },
          { title: 'Authored, waits on the first', blockedBy: [0] },
          { title: 'Laid' },
          { title: 'Laid, waits on the first', blockedBy: [0] },
        ],
        2,
      );
      await plansService.markPlanned(a.planId, fx.ctx, { walkEndedBy: 'cadence' });

      await approve(a.planId);

      expect((await planRow(a.planId)).status).toBe('approved');
      expect((await createdFor(authored!)).status).toBe('todo');
      expect((await createdFor(waits!)).status).toBe('blocked');
      const laidCard = await createdFor(laid!);
      const laidWaitingCard = await createdFor(laidWaiting!);
      expect(laidCard.status).toBe('to_plan');
      expect(laidWaitingCard.status).toBe('to_plan');
      const edge = await adminDb.workItemLink.findFirst({
        where: {
          fromId: laidWaitingCard.id,
          toId: (await createdFor(authored!)).id,
          kind: 'is_blocked_by',
        },
      });
      expect(edge).not.toBeNull();
      // The created revision records the birth status once.
      const created = await adminDb.workItemRevision.findFirstOrThrow({
        where: { workItemId: laidCard.id, changeKind: 'created' },
      });
      expect(JSON.stringify(created.diff)).toContain('to_plan');
      // The listed committed card is untouched.
      const listedAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: listed.id } });
      expect(listedAfter.status).toBe(listedBefore.status);
      expect(listedAfter.descriptionMd).toBe(listedBefore.descriptionMd);

      // Neither claim door hands out a `to_plan` card.
      const claim = await workItemsService.claimWorkItem(fx.projectId, laidCard.identifier, fx.ctx);
      expect(claim.outcome).toBe('not_claimable');
      await adminDb.workItem.updateMany({
        where: { projectId: fx.projectId, status: { notIn: ['to_plan'] } },
        data: { status: 'done' },
      });
      expect(await workItemsService.claimNextReady(fx.projectId, null, fx.ctx)).toBeNull();
    },
  );

  it(
    'a restricted workflow with no initial → to_plan transition falls back to today’s status',
    T,
    async () => {
      const planId = await barePlan();
      const [authored, laid] = await walk(
        planId,
        [{ title: 'Authored' }, { title: 'Laid, waits', blockedBy: [0] }],
        1,
      );
      await plansService.markPlanned(planId, fx.ctx, { walkEndedBy: 'cadence' });
      const statuses = await adminDb.workflowStatus.findMany({
        where: { projectId: fx.projectId, key: { in: ['todo', 'to_plan'] } },
      });
      const todo = statuses.find((s) => s.key === 'todo')!;
      const toPlan = statuses.find((s) => s.key === 'to_plan')!;
      await adminDb.project.update({
        where: { id: fx.projectId },
        data: { workflowPolicyMode: 'restricted' },
      });
      await adminDb.workflowTransition.deleteMany({
        where: { projectId: fx.projectId, fromStatusId: todo.id, toStatusId: toPlan.id },
      });

      await approve(planId);

      expect((await createdFor(authored!)).status).toBe('todo');
      // Falls into the blocked derivation like any card.
      expect((await createdFor(laid!)).status).toBe('blocked');
    },
  );

  it('a project with no `to_plan` status falls back to the initial status', T, async () => {
    const planId = await barePlan();
    const [, laid] = await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);
    await plansService.markPlanned(planId, fx.ctx, { walkEndedBy: 'cadence' });
    await adminDb.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'to_plan' },
      data: { key: 'to_plan_retired' },
    });

    await approve(planId);

    expect((await createdFor(laid!)).status).toBe('todo');
  });
});

describe('a person’s Stop (MOTIR-12207)', () => {
  it(
    'closes `planned` and approvable; a card restored to its boundary lands `to_plan`',
    T,
    async () => {
      const planId = await barePlan();
      const [restored, laid] = await walk(planId, [{ title: 'Restored' }, { title: 'Laid' }], 1);
      // The planner discards the in-flight session: authorFinished cleared.
      await plansService.deepenProposal(planId, restored!, { authorFinished: null }, fx.ctx);

      const closed = await plansService.markPlanned(planId, fx.ctx, {
        walkEndedBy: 'person_stop',
      });

      expect(closed.status).toBe('planned');
      expect((await planRow(planId)).walkEndedBy).toBe('person_stop');
      await approve(planId);
      expect((await createdFor(restored!)).status).toBe('to_plan');
      expect((await createdFor(laid!)).status).toBe('to_plan');
    },
  );
});

describe('stamps are rewritten by every close (MOTIR-12207)', () => {
  it(
    '⚠️ a later close without `walkEndedBy` clears every stamp and closes `stopped`',
    T,
    async () => {
      const planId = await barePlan();
      const [, laid] = await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);
      await plansService.markPlanned(planId, fx.ctx, { walkEndedBy: 'cadence' });
      expect(await leftLaidOf(laid!)).toBe(true);

      await plansService.acquireRevisionLease(planId, fx.ctx, actor);
      const again = await plansService.closeRevision(planId, fx.ctx, actor);

      expect(again.status).toBe('stopped');
      expect(await leftLaidOf(laid!)).toBeUndefined();
      expect((await planRow(planId)).walkEndedBy).toBeNull();
      await expect(approve(planId)).rejects.toBeInstanceOf(PlanWalkIncompleteError);
    },
  );

  it('a revision ended on purpose re-stamps and closes `planned`', T, async () => {
    const planId = await barePlan();
    const [, laid] = await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);
    await plansService.markPlanned(planId, fx.ctx);
    expect((await planRow(planId)).status).toBe('stopped');

    await plansService.acquireRevisionLease(planId, fx.ctx, actor);
    const closed = await plansService.closeRevision(planId, fx.ctx, actor, {
      walkEndedBy: 'person_stop',
    });

    expect(closed.status).toBe('planned');
    expect(await leftLaidOf(laid!)).toBe(true);
    expect(await awaitingGate(planId)).not.toBeNull();
  });

  it('a card authored after it was stamped is no longer laid', T, async () => {
    const planId = await barePlan();
    const [, laid] = await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);
    await plansService.markPlanned(planId, fx.ctx, { walkEndedBy: 'cadence' });
    // A later pass writes it, under a revision hold, and closes on purpose again.
    await plansService.acquireRevisionLease(planId, fx.ctx, actor);
    await plansService.deepenProposal(planId, laid!, { authorFinished: true }, fx.ctx);
    await plansService.closeRevision(planId, fx.ctx, actor, { walkEndedBy: 'cadence' });

    expect(await leftLaidOf(laid!)).toBeUndefined();
    await approve(planId);
    expect((await createdFor(laid!)).status).toBe('todo');
  });
});

describe('a deliberate close of an empty plan, and the doors (MOTIR-12207)', () => {
  it(
    'discards a plan holding nothing, and the MCP result says nothing was finished',
    T,
    async () => {
      const planId = await barePlan();
      const result = await runAddPlanItems(
        { planId, proposals: [], final: true, walkEndedBy: 'cadence' },
        fx.ctx,
      );

      const row = await planRow(planId);
      expect(row.status).toBe('declined');
      expect(row.decisionReason).toBe('discarded');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('DISCARDED because nothing was finished');
    },
  );

  it(
    '`hold_plan_revision end` with `walkEndedBy` over a plan with nothing says the same',
    T,
    async () => {
      const planId = await barePlan();
      const [only] = await walk(planId, [{ title: 'Only' }], 0);
      await plansService.markPlanned(planId, fx.ctx);
      await plansService.acquireRevisionLease(planId, fx.ctx, actor);
      await plansService.withdrawProposal(planId, only!, fx.ctx);

      const result = await runHoldPlanRevision(
        { planId, action: 'end', walkEndedBy: 'person_stop' },
        fx.ctx,
      );

      expect((await planRow(planId)).status).toBe('declined');
      expect((result.content[0] as { text: string }).text).toContain(
        'discarded because nothing was finished',
      );
    },
  );

  it(
    '`add_plan_items final` names the laid count; `walkEndedBy` without `final` is refused',
    T,
    async () => {
      const planId = await barePlan();
      await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);

      await expect(
        runAddPlanItems({ planId, proposals: [], walkEndedBy: 'cadence' }, fx.ctx),
      ).rejects.toBeInstanceOf(InvalidProposalError);
      const result = await runAddPlanItems(
        { planId, proposals: [], final: true, walkEndedBy: 'cadence' },
        fx.ctx,
      );
      expect((result.content[0] as { text: string }).text).toContain('1 card(s) left laid');
    },
  );

  it(
    '`hold_plan_revision` refuses `walkEndedBy` with any action but `end`, and reports the laid count',
    T,
    async () => {
      const planId = await barePlan();
      await walk(planId, [{ title: 'Authored' }, { title: 'Laid' }], 1);
      await plansService.markPlanned(planId, fx.ctx);

      await expect(
        runHoldPlanRevision({ planId, action: 'start', walkEndedBy: 'cadence' }, fx.ctx),
      ).rejects.toBeInstanceOf(InvalidProposalError);
      await runHoldPlanRevision({ planId, action: 'start' }, fx.ctx);
      const ended = await runHoldPlanRevision(
        { planId, action: 'end', walkEndedBy: 'cadence' },
        fx.ctx,
      );
      expect((ended.content[0] as { text: string }).text).toContain('1 card(s) left laid');
    },
  );

  it('no append may set `leftLaid`', T, async () => {
    const planId = await barePlan();
    await expect(
      plansService.addProposals(
        planId,
        [{ op: 'add', proposedFields: { title: 'Sneaky', kind: 'task', leftLaid: true } }],
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });
});
