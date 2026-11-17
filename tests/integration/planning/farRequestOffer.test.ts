import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE, type PlanChangeScope } from '@/lib/planChange/scope';
import { PlanSessionEndedError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE KEPT TOO-FAR REQUESTS, OFFERED ONCE THE WAITING PLAN IS DECIDED (Story MOTIR-11515 ·
// MOTIR-11521), against a REAL Postgres. Each request the planner kept while the plan
// waited is offered after Approve, and after Decline, ONE AT A TIME in the order it was
// asked; confirming one opens a NEW conversation from its requirement, declining one drops
// it, and each door offers the next. Only the motir-ai boundary client is stubbed.

let jobSeq = 0;
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-${++jobSeq}` }));
const jobs = new Map<string, unknown>();

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  streamJob: vi.fn(),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { planOfferService } = await import('@/lib/services/planOfferService');
const { farRequestOfferService } = await import('@/lib/services/farRequestOfferService');

const DB_TEST_TIMEOUT_MS = 120_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
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

/** A conversation on `scope` whose first turn proposed a plan that is now `planned`. */
async function conversationWithPlannedPlan(scope: PlanChangeScope) {
  const s = await planChangeSessionsService.startWithFirstTurn(me(), scope, 'Fix the export');
  const first = await planChangeSessionsService.submit(me(), { sessionId: s.id });
  await plansService.addProposals(
    first.planId,
    [{ op: 'add', proposedFields: { title: 'CSV writer', kind: 'task' } }],
    fx.ctx,
  );
  await plansService.markPlanned(first.planId, fx.ctx);
  return { sessionId: s.id, planId: first.planId };
}

async function anchoredScope() {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Export' },
    fx.ctx,
  );
  return buildScope([card.identifier]);
}

/** One too-far turn, settled: answered and kept. Returns the person's turn id. */
async function keepFarRequest(sessionId: string, body: string, requirement: string) {
  const out = await aiAskService.submitTurn(body, me(), { sessionId });
  const jobId = (out as { jobId: string }).jobId;
  jobs.set(jobId, {
    jobId,
    status: 'succeeded',
    result: {
      ask: {
        intent: 'ask',
        answer: 'That is better planned on its own.',
        citations: [],
        farRequest: { requirement },
        waitingPlan: { readable: true },
      },
    },
    error: null,
  });
  await aiAskService.settle(jobId, me(), { sessionId });
  return (
    await adminDb.planChangeTurn.findFirstOrThrow({ where: { sessionId, jobId, role: 'user' } })
  ).id;
}

/** A decided-plan conversation that keeps the two requests, in order. */
async function conversationKeepingTwo(scope?: PlanChangeScope) {
  const c = await conversationWithPlannedPlan(scope ?? (await anchoredScope()));
  const first = await keepFarRequest(c.sessionId, 'also a PDF report', 'Add a PDF report.');
  const second = await keepFarRequest(c.sessionId, 'and Slack', 'Add a Slack integration.');
  submitJobMock.mockClear();
  return { ...c, first, second };
}

/** The PLANNING jobs submitted — an approve submits other background jobs too. */
const planSubmits = () => submitJobMock.mock.calls.filter((c) => c[0] === 'plan');

const thread = (sessionId: string) => planChangeSessionsService.getById(me(), sessionId);
const offerTurns = async (sessionId: string) =>
  (await thread(sessionId)).turns.filter((t) => t.role === 'assistant' && t.offer?.afterDecision);
const consumedAt = async (turnId: string) =>
  (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } })).farRequestConsumedAt;

describe('after the waiting plan is decided', () => {
  for (const decision of ['approve', 'decline'] as const) {
    it(
      `after ${decision}, the earlier kept request is offered first, alone`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const { sessionId, planId } = await conversationKeepingTwo();
        // No offer exists while the plan waits.
        expect(await offerTurns(sessionId)).toEqual([]);
        expect((await thread(sessionId)).turns.some((t) => t.offer)).toBe(false);

        const decided =
          decision === 'approve'
            ? await plansService.approvePlan(planId, fx.ctx)
            : await plansService.declinePlan(planId, fx.ctx);

        expect(decided.status).toBe(decision === 'approve' ? 'approved' : 'declined');
        const session = await thread(sessionId);
        expect(session.endedAt).not.toBeNull();
        const offers = await offerTurns(sessionId);
        expect(offers).toHaveLength(1);
        expect(offers[0]!.offer).toMatchObject({
          kind: 'plan',
          requestMd: 'Add a PDF report.',
          targetKey: null,
          state: 'undecided',
          afterDecision: { position: 1, total: 2 },
        });
        expect(offers[0]!.offer).not.toHaveProperty('requirement');
        expect(planSubmits()).toEqual([]);
      },
    );
  }

  it(
    'confirming opens a NEW conversation from the requirement, consumes it, and offers the next',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId, first, second } = await conversationKeepingTwo();
      await plansService.approvePlan(planId, fx.ctx);
      const [offer] = await offerTurns(sessionId);

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId: sessionId,
        offerTurnId: offer!.id,
      });

      expect(started.sessionId).not.toBe(sessionId);
      const successor = await thread(started.sessionId);
      expect(successor.endedAt).toBeNull();
      expect(successor.turns.find((t) => t.role === 'user')?.body).toBe('Add a PDF report.');
      expect(planSubmits()).toHaveLength(1);
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: started.planId } });
      expect(plan).toMatchObject({ sessionId: started.sessionId, status: 'generating' });
      // The decided conversation stays ended; the offer reads confirmed; the request is
      // consumed and the next one offered.
      const after = await thread(sessionId);
      expect(after.endedAt).not.toBeNull();
      const offers = await offerTurns(sessionId);
      expect(offers).toHaveLength(2);
      expect(offers[0]!.offer).toMatchObject({
        state: 'confirmed',
        confirmedSessionId: started.sessionId,
      });
      expect(offers[1]!.offer).toMatchObject({
        requestMd: 'Add a Slack integration.',
        state: 'undecided',
        afterDecision: { position: 2, total: 2 },
      });
      expect(await consumedAt(first)).toBeInstanceOf(Date);
      expect(await consumedAt(second)).toBeNull();

      // A second confirm answers the same start and writes nothing more.
      submitJobMock.mockClear();
      const again = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId: sessionId,
        offerTurnId: offer!.id,
      });
      expect(again).toMatchObject({ sessionId: started.sessionId, jobId: started.jobId });
      expect(planSubmits()).toEqual([]);
      expect(await offerTurns(sessionId)).toHaveLength(2);
    },
  );

  it(
    'declining drops it, consumes it, offers the next, and the last one ends the queue',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId, first, second } = await conversationKeepingTwo();
      await plansService.declinePlan(planId, fx.ctx);
      const [offer1] = await offerTurns(sessionId);

      await planOfferService.declinePlanOffer(offer1!.id, me(), { sessionId });

      let offers = await offerTurns(sessionId);
      expect(offers).toHaveLength(2);
      expect(offers[0]!.offer?.state).toBe('declined');
      expect(offers[1]!.offer).toMatchObject({
        state: 'undecided',
        requestMd: 'Add a Slack integration.',
      });
      expect(await consumedAt(first)).toBeInstanceOf(Date);

      // A replayed decline writes no second offer and no second consume.
      const firstConsumed = await consumedAt(first);
      await planOfferService.declinePlanOffer(offer1!.id, me(), { sessionId });
      expect(await offerTurns(sessionId)).toHaveLength(2);
      expect(await consumedAt(first)).toEqual(firstConsumed);

      await planOfferService.declinePlanOffer(offers[1]!.id, me(), { sessionId });
      offers = await offerTurns(sessionId);
      expect(offers).toHaveLength(2);
      expect(offers[1]!.offer?.state).toBe('declined');
      expect(await consumedAt(second)).toBeInstanceOf(Date);
      expect(await planChangeSessionsService.listKeptFarRequests(me(), { sessionId })).toEqual([]);
      expect(planSubmits()).toEqual([]);
    },
  );

  it(
    'a replayed decision hook writes no second offer',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationKeepingTwo();
      await plansService.approvePlan(planId, fx.ctx);
      const actor = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };

      expect(await farRequestOfferService.offerNext(actor, sessionId)).toBe(false);
      expect(await offerTurns(sessionId)).toHaveLength(1);
    },
  );

  it(
    'a start that throws leaves the offer pending and the request kept, and a retry starts it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId, first } = await conversationKeepingTwo();
      await plansService.approvePlan(planId, fx.ctx);
      const [offer] = await offerTurns(sessionId);
      submitJobMock.mockRejectedValueOnce(new Error('motir-ai is down'));

      await expect(
        planOfferStartService.confirmPlanOffer(me(), {
          conversationId: sessionId,
          offerTurnId: offer!.id,
        }),
      ).rejects.toThrow('motir-ai is down');

      expect((await offerTurns(sessionId))[0]!.offer?.state).toBe('undecided');
      expect(await consumedAt(first)).toBeNull();
      expect(await offerTurns(sessionId)).toHaveLength(1);

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId: sessionId,
        offerTurnId: offer!.id,
      });
      // The retry lands on the conversation the first attempt opened, with ONE request turn.
      const successor = await thread(started.sessionId);
      expect(successor.turns.filter((t) => t.role === 'user')).toHaveLength(1);
      expect(await consumedAt(first)).toBeInstanceOf(Date);
    },
  );

  it(
    'Approve and Decline still succeed when writing the offer throws',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const offerNext = vi
        .spyOn(farRequestOfferService, 'offerNext')
        .mockRejectedValue(new Error('offer write failed'));
      try {
        const a = await conversationKeepingTwo();
        const approved = await plansService.approvePlan(a.planId, fx.ctx);
        expect(approved.status).toBe('approved');
        expect((await adminDb.plan.findUniqueOrThrow({ where: { id: a.planId } })).status).toBe(
          'approved',
        );

        const d = await conversationKeepingTwo(PROJECT_SCOPE);
        const declined = await plansService.declinePlan(d.planId, fx.ctx);
        expect(declined.status).toBe('declined');
        expect(offerNext).toHaveBeenCalled();
        expect(await offerTurns(a.sessionId)).toEqual([]);
        expect(await offerTurns(d.sessionId)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('offering the kept far requests'),
          expect.any(Error),
        );
      } finally {
        offerNext.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it(
    'offerNext writes nothing on an unknown or still-open conversation, and its after-commit form swallows a failure',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const actor = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };
      expect(await farRequestOfferService.offerNext(actor, 'no-such-conversation')).toBe(false);

      const { sessionId } = await conversationKeepingTwo();
      // The plan still waits: the conversation has not ended, so nothing is offered.
      expect(await farRequestOfferService.offerNext(actor, sessionId)).toBe(false);
      expect(await offerTurns(sessionId)).toEqual([]);

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const offerNext = vi
        .spyOn(farRequestOfferService, 'offerNext')
        .mockRejectedValueOnce(new Error('offer write failed'));
      try {
        await expect(
          farRequestOfferService.offerNextAfterCommit(actor, sessionId, 'confirm'),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('after %s on conversation %s failed'),
          'confirm',
          sessionId,
          expect.any(Error),
        );
      } finally {
        offerNext.mockRestore();
        warn.mockRestore();
      }

      // An offer written for no kept request consumes and releases nothing.
      const scope = { sessionId, workspaceId: fx.workspaceId };
      await adminDb.$transaction(async (tx) => {
        expect(await farRequestOfferService.consumeForOffer({ kind: 'plan' }, scope, tx)).toBe(
          false,
        );
        await farRequestOfferService.releaseForOffer(null, scope, tx);
      });
    },
  );

  it(
    'a conversation with no kept request gains no offer turn',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationWithPlannedPlan(await anchoredScope());
      await plansService.approvePlan(planId, fx.ctx);
      expect(await offerTurns(sessionId)).toEqual([]);
    },
  );

  it(
    'deciding a plan that is not its conversation’s latest writes no offer',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationKeepingTwo();
      // A newer plan on the same conversation: the decided one is no longer its latest.
      await adminDb.plan.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          sessionId,
          status: 'generating',
          createdById: fx.ownerId,
        },
      });

      await plansService.declinePlan(planId, fx.ctx);

      expect((await thread(sessionId)).endedAt).toBeNull();
      expect(await offerTurns(sessionId)).toEqual([]);
    },
  );

  it(
    'a far-request offer on a conversation ended any other way, and a shipped offer on a decided one, still refuse',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationKeepingTwo();
      await plansService.approvePlan(planId, fx.ctx);
      const [offer] = await offerTurns(sessionId);

      // The same offer on a conversation that ended `idle` refuses.
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { endReason: 'idle' },
      });
      await expect(
        planOfferStartService.confirmPlanOffer(me(), {
          conversationId: sessionId,
          offerTurnId: offer!.id,
        }),
      ).rejects.toBeInstanceOf(PlanSessionEndedError);

      // A shipped offer (no kept request behind it) on a decided conversation refuses.
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { endReason: 'approved' },
      });
      const stored = (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: offer!.id } }))
        .answerOffer as Record<string, unknown>;
      const { farRequestTurnId: _id, ...shipped } = stored;
      await adminDb.planChangeTurn.update({
        where: { id: offer!.id },
        data: { answerOffer: shipped as never },
      });
      await expect(
        planOfferStartService.confirmPlanOffer(me(), {
          conversationId: sessionId,
          offerTurnId: offer!.id,
        }),
      ).rejects.toBeInstanceOf(PlanSessionEndedError);
      expect(planSubmits()).toEqual([]);
    },
  );
});

describe('through the decision door the Approve and Decline buttons use', () => {
  for (const decision of ['approve', 'decline'] as const) {
    it(
      `${decision} with the reader's stamp offers the earliest kept request`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
        const { planDecisionService } = await import('@/lib/services/planDecisionService');
        const { sessionId, planId } = await conversationKeepingTwo();
        const { stamp } = await approvalGatesService.getForPlan({ planId }, fx.ctx);

        const input = { planId, stamp: stamp!, source: 'ui' as const };
        const decided =
          decision === 'approve'
            ? await planDecisionService.approve(input, fx.ctx)
            : await planDecisionService.decline(input, fx.ctx);

        expect(decided.status).toBe(decision === 'approve' ? 'approved' : 'declined');
        const offers = await offerTurns(sessionId);
        expect(offers.map((t) => t.offer?.requestMd)).toEqual(['Add a PDF report.']);
      },
    );
  }
});
