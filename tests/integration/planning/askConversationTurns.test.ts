import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { SharpenConversationSettledDto } from '@/lib/dto/sharpen';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { planReview } from '../../helpers/planReview';

// THE ASK JOB CARRIES THE CONVERSATION (MOTIR-9442; consumer motir-ai MOTIR-9435).
// Every `ask_project` submit from a conversation sends its earlier turns, and a turn
// with no run in flight also sends the Grill me answers settled so far, so the
// answering session can compose and re-compose a plan offer's requirement.
//
// Real Postgres for the session and its thread. Mocked: the motir-ai boundary, the
// run snapshot's input, and the Grill me read (its own suites cover how answers are
// settled; what this file pins is that the submit reads it and forwards the shape).

const RUN_JOB = 'job-run-1';

const submitJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: vi.fn(),
  streamJob: vi.fn(),
}));
vi.mock('@/lib/services/planReviewService', () => ({
  planReviewService: {
    getPlanReview: async (_id: string, _plan: string, ctx: { projectId: string }) =>
      planReview([], { id: 'plan-1', projectId: ctx.projectId, status: 'generating' }),
  },
}));

const { aiAskService, conversationTurnsOf, ASK_CONVERSATION_TURNS_MAX } =
  await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { aiSharpenService } = await import('@/lib/services/aiSharpenService');

let fx: WorkItemFixture;
let ctx: ProjectContext;
let sessionId: string;
let jobSeq = 0;

const SETTLED: SharpenConversationSettledDto = {
  requests: ['plan reports'],
  settled: [
    {
      questionId: 'q1',
      question: 'Who exports?',
      answer: 'Managers only',
      topic: 'workflow',
      readingId: null,
    },
  ],
  assumptions: [],
} as unknown as SharpenConversationSettledDto;

const settledMock = vi.spyOn(aiSharpenService, 'getSettledForConversation');

const contextOf = (n: number) => submitJobMock.mock.calls[n]![2] as Record<string, unknown>;

async function say(role: 'user' | 'assistant', body: string) {
  const seq = await adminDb.planChangeTurn.count({ where: { sessionId } });
  await adminDb.planChangeTurn.create({
    data: { sessionId, workspaceId: fx.workspaceId, seq, role, body },
  });
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { turnCount: seq + 1 },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-ask-${++jobSeq}` }));
  settledMock.mockReset();
  settledMock.mockResolvedValue(null);
  fx = await makeWorkItemFixture();
  ctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: 'project',
    },
  });
  sessionId = row.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('conversationTurnsOf', () => {
  it('maps user to person and assistant to motir, dropping system and blank turns', () => {
    expect(
      conversationTurnsOf([
        { role: 'user', body: ' plan reports ' },
        { role: 'system', body: 'a note' },
        { role: 'assistant', body: '' },
        { role: 'assistant', body: 'Here is the offer.' },
      ]),
    ).toEqual([
      { role: 'person', text: 'plan reports' },
      { role: 'motir', text: 'Here is the offer.' },
    ]);
  });

  it('keeps the last 20', () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({ role: 'user' as const, body: `t${i}` }));
    const kept = conversationTurnsOf(turns);
    expect(kept).toHaveLength(ASK_CONVERSATION_TURNS_MAX);
    expect(kept[0]!.text).toBe('t5');
  });
});

describe('submitTurn', () => {
  it('sends the earlier turns oldest first, not the turn being answered', async () => {
    await say('user', 'plan reports');
    await say('assistant', 'I can plan that.');

    await aiAskService.submitTurn('leave out the export part', ctx, { sessionId });

    expect(contextOf(0)).toMatchObject({
      prompt: 'leave out the export part',
      conversationTurns: [
        { role: 'person', text: 'plan reports' },
        { role: 'motir', text: 'I can plan that.' },
      ],
    });
  });

  it('a first turn carries no conversationTurns and no carriedAnswers key', async () => {
    await aiAskService.submitTurn('plan reports', ctx);

    expect(contextOf(0)).not.toHaveProperty('conversationTurns');
    expect(contextOf(0)).not.toHaveProperty('carriedAnswers');
  });

  it('sends only the last 20 of a longer conversation', async () => {
    for (let i = 0; i < 25; i += 1) await say(i % 2 ? 'assistant' : 'user', `turn ${i}`);

    await aiAskService.submitTurn('next', ctx, { sessionId });

    const turns = contextOf(0)['conversationTurns'] as Array<{ text: string }>;
    expect(turns).toHaveLength(20);
    expect(turns[0]!.text).toBe('turn 5');
    expect(turns.at(-1)!.text).toBe('turn 24');
  });

  it('sends the Grill me answers read at submit time, in the CarriedAnswers shape', async () => {
    await say('user', 'plan reports');
    settledMock.mockResolvedValue(SETTLED);

    await aiAskService.submitTurn('go on', ctx, { sessionId });

    expect(settledMock).toHaveBeenCalledWith(sessionId, expect.anything());
    expect(contextOf(0)['carriedAnswers']).toEqual({
      requests: ['plan reports'],
      settled: [
        {
          questionId: 'q1',
          question: 'Who exports?',
          answer: 'Managers only',
          topic: 'workflow',
          readingId: null,
        },
      ],
      assumptions: [],
    });
  });

  it('sends no carriedAnswers when nothing was settled', async () => {
    await say('user', 'plan reports');
    settledMock.mockResolvedValue({
      requests: ['plan reports'],
      settled: [],
      assumptions: [],
    } as never);

    await aiAskService.submitTurn('go on', ctx, { sessionId });

    expect(contextOf(0)).not.toHaveProperty('carriedAnswers');
  });
});

describe('submitMidRunTurn', () => {
  it('sends the earlier turns and never carriedAnswers', async () => {
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: RUN_JOB, lastSubmittedAt: new Date() },
    });
    await say('user', 'plan reports');
    settledMock.mockResolvedValue(SETTLED);

    await aiAskService.submitMidRunTurn('how far along?', ctx, {
      sessionId,
      runJobId: RUN_JOB,
      planId: 'plan-1',
    });

    expect(contextOf(0)['conversationTurns']).toEqual([{ role: 'person', text: 'plan reports' }]);
    expect(contextOf(0)).not.toHaveProperty('carriedAnswers');
    expect(settledMock).not.toHaveBeenCalled();
  });
});

describe('resubmit', () => {
  it('sends the turns before the re-sent turn and the same carried set as the first submit', async () => {
    await say('user', 'plan reports');
    await say('assistant', 'I can plan that.');
    settledMock.mockResolvedValue(SETTLED);
    const first = (await aiAskService.submitTurn('go on', ctx, { sessionId })) as {
      turnId: string;
    };
    await say('assistant', 'Sure.');

    await aiAskService.resubmit(first.turnId, ctx, { sessionId });

    expect(contextOf(1)['conversationTurns']).toEqual(contextOf(0)['conversationTurns']);
    expect(contextOf(1)['carriedAnswers']).toEqual(contextOf(0)['carriedAnswers']);
    expect(contextOf(1)['carriedAnswers']).toBeDefined();
    const turns = await planChangeSessionsService.getById(ctx, sessionId);
    expect(turns.turns.map((t) => t.body)).toContain('go on');
  });
});
