import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE, type PlanChangeScope } from '@/lib/planChange/scope';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE STORY GATE FOR A REQUEST TOO FAR FROM A WAITING PLAN (Story MOTIR-11515 ·
// MOTIR-11526), against a REAL Postgres, with ONLY the motir-ai boundary client stubbed.
//
// The siblings each pin their own half: MOTIR-11518 reads `farRequest` and keeps it on
// the person's turn (`waitingPlanAsk.test.ts`), MOTIR-11521 offers the kept requests after
// the decision (`farRequestOffer.test.ts`). This file drives the WHOLE chain as one seam —
// an `ask_project` result → `readAskOutcome` → the real `aiAskService.settle` → the kept
// rows → a real decision through `planDecisionService` (the one production entrance, with
// the review read's stamp) → the offers → confirm / decline through the shipped offer
// doors → the new planning session — and checks that each half resolves ONE record: the
// turn the settle kept is the turn that is offered, and the offer confirmed is the session
// the datastore holds.
//
// Case → story criterion:
//   kept-on-settle, replay ............ a too-far request is answered, kept, starts nothing
//   revision unchanged ................ a change to the waiting plan still revises it
//   two in order ...................... kept requests keep the order they were asked in
//   malformed farRequest (×6) ......... the read is fail-closed
//   approve / decline offers .......... offered once the plan is decided, either way
//   accept / decline an offer ......... accepting starts a new plan, declining drops it
//   offer write fails ................. Approve and Decline are never held up
//   live run wins ..................... a turn during a run is not a waiting-plan turn
//   no offer slot while waiting ....... nothing is offered before the decision
//   two workspaces .................... kept requests never cross conversations or tenants
//
// The offers are written ONE AT A TIME (the shipped lifecycle reads every earlier offer
// `superseded` once a later assistant turn exists), so "one offer per kept request, in
// order" is checked by resolving each offer and reading the next.

let jobSeq = 0;
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `gate-job-${++jobSeq}` }));
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
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { planDecisionService } = await import('@/lib/services/planDecisionService');

const DB_TEST_TIMEOUT_MS = 120_000;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `gate-job-${++jobSeq}` }));
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctxOf = (f: WorkItemFixture): ProjectContext => ({
  userId: f.ownerId,
  workspaceId: f.workspaceId,
  projectId: f.projectId,
  project: f.project,
});
const me = () => ctxOf(fx);

/** A conversation on `scope` whose first turn proposed a plan that is now `planned`. */
async function plannedConversation(scope: PlanChangeScope, f: WorkItemFixture = fx) {
  const s = await planChangeSessionsService.startWithFirstTurn(ctxOf(f), scope, 'Fix the export');
  const first = await planChangeSessionsService.submit(ctxOf(f), { sessionId: s.id });
  await plansService.addProposals(
    first.planId,
    [{ op: 'add', proposedFields: { title: 'CSV writer', kind: 'task' } }],
    f.ctx,
  );
  await plansService.markPlanned(first.planId, f.ctx);
  submitJobMock.mockClear();
  return { sessionId: s.id, planId: first.planId, runJobId: first.jobId };
}

async function anchoredScope(f: WorkItemFixture = fx) {
  const card = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title: 'Export' },
    f.ctx,
  );
  return buildScope([card.identifier]);
}

/** Script the ask job's result for the settle to read. */
const answers = (jobId: string, ask: unknown) =>
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });

const tooFar = (requirement: unknown, extra: Record<string, unknown> = {}) => ({
  intent: 'ask',
  answer: 'That is better planned on its own.',
  citations: [],
  farRequest: { requirement },
  waitingPlan: { readable: true },
  ...extra,
});

/** Send a follow-up through the real submit; returns the ask job's id. */
async function send(sessionId: string, body: string, f: WorkItemFixture = fx) {
  const out = await aiAskService.submitTurn(body, ctxOf(f), { sessionId });
  expect('jobId' in out && !('outcome' in out)).toBe(true);
  return (out as { jobId: string }).jobId;
}

/** Send, script a too-far result and settle it; returns the person's turn id. */
async function keep(sessionId: string, body: string, requirement: string, f = fx) {
  const jobId = await send(sessionId, body, f);
  answers(jobId, tooFar(requirement));
  const settled = await aiAskService.settle(jobId, ctxOf(f), { sessionId });
  expect(settled.outcome).toBe('answered');
  return (await userTurnOf(sessionId, jobId)).id;
}

const userTurnOf = (sessionId: string, jobId: string) =>
  adminDb.planChangeTurn.findFirstOrThrow({ where: { sessionId, jobId, role: 'user' } });
const kept = (sessionId: string, f = fx) =>
  planChangeSessionsService.listKeptFarRequests(ctxOf(f), { sessionId });
const planSubmits = () => submitJobMock.mock.calls.filter((c) => c[0] === 'plan');
const revisionStarts = (planId: string) =>
  adminDb.planRevision.count({ where: { planId, changeKind: 'revision_started' } });
const planStatus = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;
const offerTurns = async (sessionId: string, f = fx) =>
  (await planChangeSessionsService.getById(ctxOf(f), sessionId)).turns.filter(
    (t) => t.role === 'assistant' && t.offer,
  );
const consumedAt = async (turnId: string) =>
  (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } })).farRequestConsumedAt;

/** Decide through the one production entrance, with the stamp the review read returns. */
async function decide(decision: 'approve' | 'decline', planId: string, f = fx) {
  const { stamp } = await approvalGatesService.getForPlan({ planId }, f.ctx);
  const input = { planId, stamp: stamp!, source: 'ui' as const };
  return decision === 'approve'
    ? planDecisionService.approve(input, f.ctx)
    : planDecisionService.decline(input, f.ctx);
}

describe('a too-far request while the plan waits', () => {
  it(
    'settles as ONE reply and ONE kept request on its source message; nothing starts; a replay keeps no second',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await plannedConversation(await anchoredScope());
      const jobId = await send(sessionId, 'also build a PDF report');
      answers(jobId, tooFar('Add a PDF report.'));
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled.outcome).toBe('answered');
      const turns = (await planChangeSessionsService.getById(me(), sessionId)).turns;
      expect(turns.at(-1)).toMatchObject({
        role: 'assistant',
        body: 'That is better planned on its own.',
      });
      const source = await userTurnOf(sessionId, jobId);
      expect(await kept(sessionId)).toEqual([
        { turnId: source.id, seq: source.seq, requirement: 'Add a PDF report.' },
      ]);
      expect(planSubmits()).toEqual([]);
      expect(await revisionStarts(planId)).toBe(0);
      expect(await planStatus(planId)).toBe('planned');
      // The waiting-plan turn carries no plan-offer slot: nothing is offered before the
      // decision.
      expect(await offerTurns(sessionId)).toEqual([]);

      await aiAskService.settle(jobId, me(), { sessionId });
      expect(await kept(sessionId)).toHaveLength(1);
      expect(
        await adminDb.planChangeTurn.count({ where: { sessionId, jobId, role: 'assistant' } }),
      ).toBe(1);
    },
  );

  it(
    'a REVISION result still revises the waiting plan, and keeps nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await plannedConversation(await anchoredScope());
      const jobId = await send(sessionId, 'drop the csv thing');
      answers(jobId, {
        intent: 'plan_change',
        answer: "I'm revising the plan to drop the CSV writer.",
        citations: [],
        revision: { requirement: 'Remove the proposed CSV writer task.' },
        waitingPlan: { readable: true },
      });
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled).toMatchObject({ outcome: 'redirected', planId });
      expect(planSubmits()).toHaveLength(1);
      expect(planSubmits()[0]![2]).toMatchObject({ planId });
      expect((planSubmits()[0]![2] as { prompt: string }).prompt).toContain(
        'Remove the proposed CSV writer task.',
      );
      expect(await revisionStarts(planId)).toBe(1);
      expect(await kept(sessionId)).toEqual([]);
    },
  );

  it(
    'two too-far requests on the project thread are kept in the order asked, each on its own message',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await plannedConversation(PROJECT_SCOPE);
      const a = await keep(sessionId, 'also a PDF report', 'Requirement A.');
      const b = await keep(sessionId, 'and Slack', 'Requirement B.');

      const rows = await kept(sessionId);
      expect(rows.map((r) => [r.turnId, r.requirement])).toEqual([
        [a, 'Requirement A.'],
        [b, 'Requirement B.'],
      ]);
      expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
      expect(await planStatus(planId)).toBe('planned');
    },
  );

  const malformed: Array<[string, Record<string, unknown>, 'answered' | 'silent']> = [
    ['not a record', { ...tooFar('x'), farRequest: 'Add a PDF report.' }, 'answered'],
    ['a blank requirement', tooFar('   '), 'answered'],
    ['a non-string requirement', tooFar(42), 'answered'],
    ['no readable answer', { ...tooFar('Add a PDF report.'), answer: null }, 'silent'],
    [
      'beside a revision on an ask',
      { ...tooFar('Add a PDF report.'), revision: { requirement: 'Remove it.' } },
      'answered',
    ],
    [
      'beside a revision on a plan change',
      {
        ...tooFar('Add a PDF report.'),
        intent: 'plan_change',
        revision: { requirement: 'Remove it.' },
      },
      'answered',
    ],
  ];
  for (const [label, ask, outcome] of malformed) {
    it(
      `a farRequest that is ${label} keeps nothing and starts no revision`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const { sessionId, planId } = await plannedConversation(await anchoredScope());
        const jobId = await send(sessionId, 'also build a PDF report');
        answers(jobId, ask);
        submitJobMock.mockClear();

        const settled = await aiAskService.settle(jobId, me(), { sessionId });

        expect(settled.outcome).toBe(outcome);
        expect(await kept(sessionId)).toEqual([]);
        expect(planSubmits()).toEqual([]);
        expect(await revisionStarts(planId)).toBe(0);
        expect(await planStatus(planId)).toBe('planned');
      },
    );
  }

  it(
    'a turn sent while a plan is still being written takes the live-run path and keeps nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const scope = await anchoredScope();
      const s = await planChangeSessionsService.startWithFirstTurn(me(), scope, 'Fix the export');
      const run = await planChangeSessionsService.submit(me(), { sessionId: s.id });
      expect(await planStatus(run.planId)).toBe('generating');
      submitJobMock.mockClear();

      const out = await aiAskService.submitMidRunTurn('also build a PDF report', me(), {
        sessionId: s.id,
        runJobId: run.jobId,
        planId: run.planId,
      });
      const jobId = (out as { jobId: string }).jobId;
      const [kind, , context] = submitJobMock.mock.calls[0]!;
      expect(kind).toBe('ask_project');
      expect(context).toHaveProperty('run');
      expect(context).not.toHaveProperty('waitingPlan');

      answers(jobId, tooFar('Add a PDF report.'));
      await aiAskService.settle(jobId, me(), { sessionId: s.id });
      expect(await kept(s.id)).toEqual([]);
    },
  );
});

describe('once the waiting plan is decided', () => {
  for (const decision of ['approve', 'decline'] as const) {
    it(
      `after ${decision} through the decision door, each kept request is offered once, in order, carrying its requirement`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const { sessionId, planId } = await plannedConversation(await anchoredScope());
        const a = await keep(sessionId, 'also a PDF report', 'Requirement A.');
        const b = await keep(sessionId, 'and Slack', 'Requirement B.');
        expect(await offerTurns(sessionId)).toEqual([]);

        const decided = await decide(decision, planId);

        expect(decided.status).toBe(decision === 'approve' ? 'approved' : 'declined');
        expect(await planStatus(planId)).toBe(decided.status);
        let offers = await offerTurns(sessionId);
        expect(offers.map((t) => t.offer?.requestMd)).toEqual(['Requirement A.']);
        expect(offers[0]!.offer).toMatchObject({ kind: 'plan', targetKey: null });

        // Resolving A offers B, and resolving B offers nothing more.
        await planOfferService.declinePlanOffer(offers[0]!.id, me(), { sessionId });
        offers = await offerTurns(sessionId);
        expect(offers.map((t) => t.offer?.requestMd)).toEqual(['Requirement A.', 'Requirement B.']);
        await planOfferService.declinePlanOffer(offers[1]!.id, me(), { sessionId });
        expect(await offerTurns(sessionId)).toHaveLength(2);
        expect(await consumedAt(a)).toBeInstanceOf(Date);
        expect(await consumedAt(b)).toBeInstanceOf(Date);
      },
    );
  }

  it(
    'accepting A starts ONE ordinary planning run from its text; a second accept starts nothing; declining B submits nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await plannedConversation(await anchoredScope());
      const a = await keep(sessionId, 'also a PDF report', 'Requirement A.');
      const b = await keep(sessionId, 'and Slack', 'Requirement B.');
      await decide('approve', planId);
      const [offerA] = await offerTurns(sessionId);
      submitJobMock.mockClear();

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId: sessionId,
        offerTurnId: offerA!.id,
      });

      expect(planSubmits()).toHaveLength(1);
      expect((planSubmits()[0]![2] as { prompt: string }).prompt).toContain('Requirement A.');
      const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: started.planId } });
      expect(plan).toMatchObject({ sessionId: started.sessionId, status: 'generating' });
      const successor = await planChangeSessionsService.getById(me(), started.sessionId);
      expect(successor.turns.find((t) => t.role === 'user')?.body).toBe('Requirement A.');
      expect(await consumedAt(a)).toBeInstanceOf(Date);

      submitJobMock.mockClear();
      const again = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId: sessionId,
        offerTurnId: offerA!.id,
      });
      expect(again).toMatchObject({ sessionId: started.sessionId, jobId: started.jobId });
      expect(planSubmits()).toEqual([]);

      const offers = await offerTurns(sessionId);
      expect(offers.map((t) => t.offer?.requestMd)).toEqual(['Requirement A.', 'Requirement B.']);
      await planOfferService.declinePlanOffer(offers[1]!.id, me(), { sessionId });
      expect(planSubmits()).toEqual([]);
      expect(await consumedAt(b)).toBeInstanceOf(Date);
      // Neither is offered again.
      expect(await offerTurns(sessionId)).toHaveLength(2);
      expect(await kept(sessionId)).toEqual([]);
    },
  );

  for (const decision of ['approve', 'decline'] as const) {
    it(
      `${decision} still succeeds and stays decided when making the offers fails`,
      { timeout: DB_TEST_TIMEOUT_MS },
      async () => {
        const { sessionId, planId } = await plannedConversation(await anchoredScope());
        await keep(sessionId, 'also a PDF report', 'Requirement A.');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The fault is injected at the offer-making step only.
        const offerNext = vi
          .spyOn(farRequestOfferService, 'offerNext')
          .mockRejectedValue(new Error('offer write failed'));
        try {
          const decided = await decide(decision, planId);
          const status = decision === 'approve' ? 'approved' : 'declined';
          expect(decided.status).toBe(status);
          expect(offerNext).toHaveBeenCalled();
          expect(await planStatus(planId)).toBe(status);
          expect(await offerTurns(sessionId)).toEqual([]);
        } finally {
          offerNext.mockRestore();
          warn.mockRestore();
        }
      },
    );
  }

  it(
    "one conversation's decision never offers or consumes another conversation's or workspace's requests",
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const other = await makeWorkItemFixture();
      const mine = await plannedConversation(await anchoredScope());
      const sibling = await plannedConversation(PROJECT_SCOPE);
      const theirs = await plannedConversation(await anchoredScope(other), other);
      const myTurn = await keep(mine.sessionId, 'also a PDF report', 'Mine.');
      const siblingTurn = await keep(sibling.sessionId, 'and Slack', 'Sibling.');
      const theirTurn = await keep(theirs.sessionId, 'and Jira', 'Theirs.', other);

      await decide('approve', mine.planId);

      expect((await offerTurns(mine.sessionId)).map((t) => t.offer?.requestMd)).toEqual(['Mine.']);
      expect(await offerTurns(sibling.sessionId)).toEqual([]);
      expect(await offerTurns(theirs.sessionId, other)).toEqual([]);
      expect(await planStatus(sibling.planId)).toBe('planned');
      expect(await planStatus(theirs.planId)).toBe('planned');
      expect(await consumedAt(siblingTurn)).toBeNull();
      expect(await consumedAt(theirTurn)).toBeNull();
      expect((await kept(theirs.sessionId, other)).map((r) => r.turnId)).toEqual([theirTurn]);
      expect((await kept(sibling.sessionId)).map((r) => r.turnId)).toEqual([siblingTurn]);
      expect((await kept(mine.sessionId)).map((r) => r.turnId)).toEqual([myTurn]);
    },
  );
});
