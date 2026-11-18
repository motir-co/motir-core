import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { PlanWalkIncompleteError } from '@/lib/plans/errors';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Bug MOTIR-11701 — A WALK STOPPED BEFORE EVERY CARD WAS WRITTEN CLOSES `stopped`,
// NEVER `planned`, against a REAL Postgres.
//
// Production: plan cmwlyn36904nk01adfoofe26z's walk was stopped with two committed
// cards (MOTIR-11678, MOTIR-11685) listed for re-authoring and never re-authored. It
// closed `planned`, raised its gate, and could be approved — committing cards whose
// bodies the walk had never written. Now:
//
//   * the close reads the plan's authoring state under the plan lock; owed a card (or
//     told by the producer its walk ended early) it closes `stopped`, raises no gate,
//     and records a resumable `stopped` failure on the plan's session;
//   * approve is refused by name (`PLAN_WALK_INCOMPLETE`) and commits nothing;
//   * Resume continues the SAME plan, and a close that now finds every card written
//     goes to `planned` with its gate;
//   * a plan nobody walked (written by hand over the MCP) closes as it always did.
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
const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');
const { planGateService } = await import('@/lib/services/planGateService');
const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');

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
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const gatesOf = (planId: string) =>
  adminDb.approvalGate.findMany({ where: { kind: 'plan_approval', subjectId: planId } });
const awaitingGate = async (planId: string) =>
  (await gatesOf(planId)).find((g) => g.state === 'awaiting') ?? null;

/** Appends `titles` as `add`s under a live lay step, stamps the first `written` of them
 *  as finished by their author, and ends the lay — the shape a walk leaves. */
async function walk(planId: string, titles: string[], written: number) {
  await plansService.recordPlanStep(
    planId,
    { sessionKey: 'lay', kind: 'lay', targetRef: null },
    fx.ctx,
  );
  const appended = await plansService.addProposals(
    planId,
    titles.map((title) => ({ op: 'add' as const, proposedFields: { title, kind: 'task' } })),
    fx.ctx,
  );
  const ids = appended.appendedItemIds as string[];
  for (const id of ids.slice(0, written)) {
    await plansService.deepenProposal(planId, id, { authorFinished: true }, fx.ctx);
  }
  await plansService.endPlanStep(planId, 'lay', fx.ctx);
  return ids;
}

/** An author session that opened on `targetRef` and ended. */
async function authorSessionEnded(planId: string, targetRef: string) {
  const key = `author-${targetRef}`;
  await plansService.recordPlanStep(planId, { sessionKey: key, kind: 'author', targetRef }, fx.ctx);
  await plansService.endPlanStep(planId, key, fx.ctx);
}

/** A plan with no conversation, in `generating`. */
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
  return { card, sessionId: session.id, planId: first.planId, jobId: first.jobId };
}

describe('the close (Bug MOTIR-11701)', () => {
  it('⚠️ a walk owed a card closes `stopped`: no gate, a `stopped` revision', T, async () => {
    const planId = await barePlan();
    await walk(planId, ['Written', 'Never written'], 1);

    const closed = await plansService.markPlanned(planId, fx.ctx, { summary: 'the briefing' });

    expect(closed.status).toBe('stopped');
    const row = await planRow(planId);
    expect(row.status).toBe('stopped');
    expect(row.plannedAt).toBeNull();
    expect(row.summary).toBe('the briefing');
    expect(await gatesOf(planId)).toHaveLength(0);
    const revision = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, changeKind: 'stopped' },
    });
    expect(revision.diff).toMatchObject({ itemCount: 2, unwrittenCount: 1 });
  });

  it('the producer’s word closes it `stopped` even when every card reads written', T, async () => {
    const planId = await barePlan();
    await walk(planId, ['One', 'Two'], 2);

    await plansService.markPlanned(planId, fx.ctx, { walkIncomplete: true });

    expect((await planRow(planId)).status).toBe('stopped');
    const revision = await adminDb.planRevision.findFirstOrThrow({
      where: { planId, changeKind: 'stopped' },
    });
    expect(revision.diff).toMatchObject({ unwrittenCount: 0, reportedIncomplete: true });
  });

  it(
    'a walk that wrote every card closes `planned` with its gate — the counterfactual',
    T,
    async () => {
      const planId = await barePlan();
      await walk(planId, ['One', 'Two'], 2);

      await plansService.markPlanned(planId, fx.ctx);

      expect((await planRow(planId)).status).toBe('planned');
      expect(await awaitingGate(planId)).not.toBeNull();
    },
  );

  it('a plan nobody walked (written by hand) closes `planned` as it always did', T, async () => {
    const planId = await barePlan();
    await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Hand-written', kind: 'task' } }],
      fx.ctx,
    );

    await plansService.markPlanned(planId, fx.ctx);

    expect((await planRow(planId)).status).toBe('planned');
    expect(await awaitingGate(planId)).not.toBeNull();
  });
});

describe('approve and decline of an unfinished walk (Bug MOTIR-11701)', () => {
  it('⚠️ approve of a `stopped` plan is refused by name and commits nothing', T, async () => {
    const planId = await barePlan();
    await walk(planId, ['Written', 'Never written'], 1);
    await plansService.markPlanned(planId, fx.ctx);
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const refusal = await planDecisionService
      .approve({ planId, stamp: null, source: 'ui' }, fx.ctx)
      .catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(PlanWalkIncompleteError);
    expect(refusal).toMatchObject({
      code: 'PLAN_WALK_INCOMPLETE',
      actual: 'stopped',
      unwritten: [expect.objectContaining({ title: 'Never written', key: null })],
    });
    expect((await planRow(planId)).status).toBe('stopped');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });

  it('a LEGACY `planned` plan owed a card is refused at the claim, under the lock', T, async () => {
    // Closed complete (gate raised), then a card's written stamp taken away underneath
    // it — the row a close that predates this rule left behind.
    const planId = await barePlan();
    const [first] = await walk(planId, ['One', 'Two'], 2);
    await plansService.markPlanned(planId, fx.ctx);
    const item = await adminDb.planItem.findUniqueOrThrow({ where: { id: first! } });
    const fields = { ...(item.proposedFields as Record<string, string | number | boolean>) };
    delete fields.authorFinished;
    await adminDb.planItem.update({ where: { id: first! }, data: { proposedFields: fields } });
    const read = await approvalGatesService.getForPlan({ planId }, fx.ctx);

    await expect(
      planDecisionService.approve({ planId, stamp: read.stamp, source: 'ui' }, fx.ctx),
    ).rejects.toBeInstanceOf(PlanWalkIncompleteError);
    expect((await planRow(planId)).status).toBe('planned');
    // …and the gate predicate asks nobody about it.
    const assessed = await withWorkspaceServiceContext(fx.workspaceId, async (tx) =>
      planGateService.assess(await adminDb.plan.findUniqueOrThrow({ where: { id: planId } }), tx),
    );
    expect(assessed).toBe('walk_incomplete');
  });

  it('decline of a `stopped` plan is the plain discard — nobody was asked', T, async () => {
    const planId = await barePlan();
    await walk(planId, ['Written', 'Never written'], 1);
    await plansService.markPlanned(planId, fx.ctx);

    const declined = await planDecisionService.decline(
      { planId, stamp: null, source: 'ui' },
      fx.ctx,
    );

    expect(declined.status).toBe('declined');
    expect((await planRow(planId)).decisionReason).toBe('discarded');
  });
});

describe('the session and Resume (Bug MOTIR-11701)', () => {
  it(
    '⚠️ a stopped close records a resumable `stopped` failure naming what is owed',
    T,
    async () => {
      const a = await attempt();
      await walk(a.planId, ['Written', 'Never written'], 1);

      await plansService.markPlanned(a.planId, fx.ctx);

      const session = await sessionRow(a.sessionId);
      expect(session.failureReason).toBe('stopped');
      expect(session.failureResumable).toBe(true);
      expect(session.failedJobId).toBe(a.jobId);
      expect(session.failureStopPhase).toBe('author');
      expect(session.failureStopTitle).toBe('Never written');
      expect(session.failureNotPlannedYet).toEqual(['Never written']);
      // The cards stay held: the plan is undecided.
      expect(
        await adminDb.planTargetLock.count({
          where: { OR: [{ sessionId: a.sessionId }, { planId: a.planId }] },
        }),
      ).toBeGreaterThan(0);
    },
  );

  it(
    'a walk that RETURNED with a question closes `stopped` and records no failure',
    T,
    async () => {
      const a = await attempt();
      await walk(a.planId, ['Written', 'Never written'], 1);

      await plansService.markPlanned(a.planId, fx.ctx, {
        walkIncomplete: true,
        walkReturned: true,
      });

      expect((await planRow(a.planId)).status).toBe('stopped');
      expect((await sessionRow(a.sessionId)).failedAt).toBeNull();
    },
  );

  it(
    '⚠️ REPLAY of cmwlyn36904nk01adfoofe26z: the owed cards are exactly MOTIR-11678 and ' +
      'MOTIR-11685, Resume continues the same plan, and writing them closes it `planned`',
    T,
    async () => {
      const a = await attempt();
      // Three `add`s, all written; three committed cards the lay listed for re-authoring,
      // one of which its author session finished. The two left are the production pair.
      const committed = [];
      for (const title of [
        'Already re-authored',
        'Stands for MOTIR-11678',
        'Stands for MOTIR-11685',
      ]) {
        committed.push(
          await workItemsService.createWorkItem(
            { projectId: fx.projectId, kind: 'task', title },
            fx.ctx,
          ),
        );
      }
      const [done, owedA, owedB] = committed as [
        (typeof committed)[number],
        (typeof committed)[number],
        (typeof committed)[number],
      ];
      await plansService.correctPlanBrief(
        a.planId,
        { plannerRecord: { walkListed: committed.map((c) => c.id) } },
        fx.ctx,
      );
      await walk(a.planId, ['Add one', 'Add two', 'Add three'], 3);
      await authorSessionEnded(a.planId, done.id);

      await plansService.markPlanned(a.planId, fx.ctx);

      expect((await planRow(a.planId)).status).toBe('stopped');
      const refusal = (await planDecisionService
        .approve({ planId: a.planId, stamp: null, source: 'ui' }, fx.ctx)
        .catch((e: unknown) => e)) as PlanWalkIncompleteError;
      expect(refusal).toBeInstanceOf(PlanWalkIncompleteError);
      expect(refusal.unwritten.map((u) => u.key)).toEqual([owedA.identifier, owedB.identifier]);
      expect((await sessionRow(a.sessionId)).failureNotPlannedYet).toEqual([
        `${owedA.identifier} Stands for MOTIR-11678`,
        `${owedB.identifier} Stands for MOTIR-11685`,
      ]);

      // Resume: the SAME plan, its walk continued — motir-ai is told it is a stopped walk.
      submitJobMock.mockClear();
      const resumed = await planSessionResumeService.resume(me(), a.sessionId);
      expect(resumed.planId).toBe(a.planId);
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(submitJobMock.mock.calls[0])).toContain(
        JSON.stringify({ planId: a.planId, fromJobId: a.jobId, stoppedWalk: true }),
      );
      const reopened = await planRow(a.planId);
      expect(reopened.status).toBe('generating');
      expect(reopened.sourceJobId).toBe(resumed.jobId);

      // The resumed walk writes the two owed cards, and only those, then closes.
      await authorSessionEnded(a.planId, owedA.id);
      await authorSessionEnded(a.planId, owedB.id);
      await plansService.markPlanned(a.planId, fx.ctx);

      expect((await planRow(a.planId)).status).toBe('planned');
      expect(await awaitingGate(a.planId)).not.toBeNull();
      const session = await sessionRow(a.sessionId);
      expect(session.failedAt).toBeNull();
      expect(session.failureReason).toBeNull();
    },
  );
});

describe('an MCP walk resumes a stopped plan under the revision hold (Bug MOTIR-11701)', () => {
  const actor = { source: 'mcp' as const, harness: 'Claude Code', model: null };

  it('⚠️ `start` re-opens it; `end` closes it `planned` once nothing is owed', T, async () => {
    const planId = await barePlan();
    const [, owed] = await walk(planId, ['Written', 'Never written'], 1);
    await plansService.markPlanned(planId, fx.ctx);
    expect((await planRow(planId)).status).toBe('stopped');

    await plansService.acquireRevisionLease(planId, fx.ctx, actor);
    expect((await planRow(planId)).status).toBe('generating');
    await plansService.deepenProposal(planId, owed!, { authorFinished: true }, fx.ctx);
    const closed = await plansService.closeRevision(planId, fx.ctx, actor);

    expect(closed.status).toBe('planned');
    expect((await planRow(planId)).status).toBe('planned');
    expect(await awaitingGate(planId)).not.toBeNull();
  });

  it(
    '`end` with `walkIncomplete` closes it `stopped` again, and a lapsed hold gives it back `stopped`',
    T,
    async () => {
      const planId = await barePlan();
      await walk(planId, ['Written', 'Never written'], 1);
      await plansService.markPlanned(planId, fx.ctx);

      await plansService.acquireRevisionLease(planId, fx.ctx, actor);
      const again = await plansService.closeRevision(planId, fx.ctx, actor, {
        walkIncomplete: true,
      });
      expect(again.status).toBe('stopped');
      expect(await gatesOf(planId)).toHaveLength(0);

      // Re-opened and abandoned: the release gives it back to what it was re-opened from.
      await plansService.acquireRevisionLease(planId, fx.ctx, actor);
      await plansService.releaseRevisionLease(planId, fx.ctx, actor);
      expect((await planRow(planId)).status).toBe('stopped');
      expect(await gatesOf(planId)).toHaveLength(0);
    },
  );
});
