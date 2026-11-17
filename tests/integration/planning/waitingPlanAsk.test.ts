import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE, buildScope, type PlanChangeScope } from '@/lib/planChange/scope';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A TURN ON A CONVERSATION WHOSE PROPOSED PLAN WAITS (Bug MOTIR-11488), against a REAL
// Postgres. Every message sent after a proposal goes to `ask_project` with the waiting
// plan, on an anchored thread and on the project thread alike, and the PLANNER's answer
// decides: a question is answered and the plan is untouched; a change lands the reply
// naming it and starts ONE revision of that plan from the planner's restatement — never
// from the accumulated turns. Only the motir-ai boundary client is stubbed.

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
  submitJobMock.mockClear();
  return { sessionId: s.id, planId: first.planId };
}

async function anchoredConversation() {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Export' },
    fx.ctx,
  );
  return conversationWithPlannedPlan(buildScope([card.identifier]));
}

/** Script the ask job's result for the settle to read. */
function answers(jobId: string, ask: Record<string, unknown>) {
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
}

const markers = (sessionId: string) =>
  adminDb.planChangeTurn.findMany({
    where: { sessionId, role: 'system' },
    orderBy: { seq: 'asc' },
  });
const revisionStarts = (planId: string) =>
  adminDb.planRevision.count({ where: { planId, changeKind: 'revision_started' } });
const planStatus = async (planId: string) =>
  (await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status;

/** Submit a follow-up turn and return the ask job's id; asserts it IS an ask. */
async function send(sessionId: string, body: string) {
  const out = await aiAskService.submitTurn(body, me(), { sessionId });
  expect('jobId' in out && !('outcome' in out)).toBe(true);
  return (out as { jobId: string }).jobId;
}

describe('an ANCHORED conversation whose plan waits', () => {
  it(
    'sends the follow-up to ask_project with the waiting plan, writing no marker and starting no revision',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      const markersBefore = (await markers(sessionId)).length;

      await send(sessionId, 'why does the plan add a new card?');

      expect(submitJobMock).toHaveBeenCalledTimes(1);
      const [kind, , context] = submitJobMock.mock.calls[0]!;
      expect(kind).toBe('ask_project');
      expect(context).toMatchObject({
        prompt: 'why does the plan add a new card?',
        waitingPlan: { planId, readable: true, planStatus: 'planned' },
      });
      const proposals = (context as { waitingPlan: { proposals: Array<{ title: string }> } })
        .waitingPlan.proposals;
      expect(proposals.map((p) => p.title)).toEqual(['CSV writer']);
      expect(context).not.toHaveProperty('run');
      expect((await markers(sessionId)).length).toBe(markersBefore);
      expect(await revisionStarts(planId)).toBe(0);
    },
  );

  it(
    'a QUESTION settles answered: the reply lands, the plan stays planned and untouched',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      const markersBefore = (await markers(sessionId)).length;
      const jobId = await send(sessionId, 'why does the plan add a new card?');
      answers(jobId, { intent: 'ask', answer: 'Because the old card is done.', citations: [] });
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled.outcome).toBe('answered');
      const turns = (settled as { session: { turns: Array<{ role: string; body: string }> } })
        .session.turns;
      expect(turns.at(-1)).toMatchObject({
        role: 'assistant',
        body: 'Because the old card is done.',
      });
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await planStatus(planId)).toBe('planned');
      expect(await revisionStarts(planId)).toBe(0);
      expect((await markers(sessionId)).length).toBe(markersBefore);
    },
  );

  it(
    "a CHANGE settles redirected: the reply lands, then ONE revision of that plan from the planner's restatement",
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      const jobId = await send(sessionId, 'drop the csv thing');
      answers(jobId, {
        intent: 'plan_change',
        answer: "I'm revising the plan to drop the CSV writer.",
        citations: [],
        revision: { requirement: 'Remove the proposed CSV writer task.' },
        waitingPlan: { readable: true },
      });
      submitJobMock.mockClear();
      const plansBefore = await adminDb.plan.count({ where: { sessionId } });

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled).toMatchObject({ outcome: 'redirected', planId });
      // ONE revise submit, on the waiting plan, carrying the restatement and NOT the
      // accumulated turns.
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      const [kind, , context] = submitJobMock.mock.calls[0]!;
      expect(kind).toBe('plan');
      expect(context).toMatchObject({ planId });
      const prompt = (context as { prompt: string }).prompt;
      expect(prompt).toContain('Remove the proposed CSV writer task.');
      expect(prompt).not.toContain('Plan change requested across');
      expect(prompt).not.toContain('drop the csv thing');
      expect(await adminDb.plan.count({ where: { sessionId } })).toBe(plansBefore);
      expect(await revisionStarts(planId)).toBe(1);
      // The reply precedes the marker, and the marker is the restatement.
      const turns = (await planChangeSessionsService.getById(me(), sessionId)).turns;
      const reply = turns.findIndex(
        (t) => t.role === 'assistant' && t.body === "I'm revising the plan to drop the CSV writer.",
      );
      const marker = turns.findIndex(
        (t) => t.role === 'system' && t.body === 'Remove the proposed CSV writer task.',
      );
      expect(reply).toBeGreaterThanOrEqual(0);
      expect(marker).toBeGreaterThan(reply);
      expect(turns.find((t) => t.jobId === jobId && t.role === 'user')?.intent).toBe('plan_change');

      // A replayed settle starts nothing a second time.
      submitJobMock.mockClear();
      const again = await aiAskService.settle(jobId, me(), { sessionId });
      expect(again.outcome).toBe('answered');
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await revisionStarts(planId)).toBe(1);
    },
  );

  it(
    'a change for a plan DECIDED since the turn was read lands the reply and starts nothing',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      const jobId = await send(sessionId, 'drop the csv thing');
      answers(jobId, {
        intent: 'plan_change',
        answer: 'Revising.',
        citations: [],
        revision: { requirement: 'Remove it.' },
      });
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'declined' } });
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled.outcome).toBe('answered');
      expect(submitJobMock).not.toHaveBeenCalled();
    },
  );

  it(
    'a revision with no reply is not honoured, and never becomes the accumulated rewrite',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      const jobId = await send(sessionId, 'drop the csv thing');
      answers(jobId, {
        intent: 'plan_change',
        answer: null,
        citations: [],
        revision: { requirement: 'Remove it.' },
      });
      submitJobMock.mockClear();

      const settled = await aiAskService.settle(jobId, me(), { sessionId });

      expect(settled.outcome).toBe('silent');
      expect(submitJobMock).not.toHaveBeenCalled();
      expect(await revisionStarts(planId)).toBe(0);
    },
  );

  it(
    'with NO waiting plan (decided) the anchored turn is the shipped ask, with no plan stated',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await anchoredConversation();
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });
      const out = await aiAskService.submitTurn('now plan the PDF report', me(), { sessionId });

      expect(out).toMatchObject({ jobId: expect.any(String) });
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      const [kind, , context] = submitJobMock.mock.calls[0]!;
      expect(kind).toBe('ask_project');
      expect(context).not.toHaveProperty('waitingPlan');
    },
  );
});

describe('the PROJECT thread whose plan waits', () => {
  it(
    'asks with the waiting plan too, and a re-run of the turn carries it again',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationWithPlannedPlan(PROJECT_SCOPE);

      const jobId = await send(sessionId, 'what does the plan add?');

      const [kind, , context] = submitJobMock.mock.calls[0]!;
      expect(kind).toBe('ask_project');
      expect(context).toMatchObject({ waitingPlan: { planId, readable: true } });

      const turn = (await planChangeSessionsService.getById(me(), sessionId)).turns.find(
        (t) => t.jobId === jobId,
      )!;
      submitJobMock.mockClear();
      await aiAskService.resubmit(turn.id, me(), { sessionId });
      expect(submitJobMock.mock.calls[0]![2]).toMatchObject({ waitingPlan: { planId } });
    },
  );

  it(
    'states no waiting plan once the plan is decided',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const { sessionId, planId } = await conversationWithPlannedPlan(PROJECT_SCOPE);
      await adminDb.plan.update({ where: { id: planId }, data: { status: 'approved' } });

      await send(sessionId, 'what does the plan add?');

      expect(submitJobMock.mock.calls[0]![2]).not.toHaveProperty('waitingPlan');
    },
  );
});
