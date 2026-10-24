import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';

// Story MOTIR-9221 · Subtask MOTIR-9315 — the conversation's settled answers CARRIED
// into the planning run: on the planning job's context at plan submit (Confirm and
// the typed yes both end in `planChangeSessionsService.submit`), and on the in-run
// grilling's `run` block. Real Postgres; only the motir-ai boundary client is stubbed.

const jobs = vi.hoisted(() => ({
  next: 0,
  submitted: [] as Array<{ kind: string; context: Record<string, unknown> }>,
  results: new Map<string, Record<string, unknown>>(),
  failNext: null as Error | null,
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string, _tenant: unknown, context: Record<string, unknown>) => {
    if (jobs.failNext) {
      const err = jobs.failNext;
      jobs.failNext = null;
      throw err;
    }
    jobs.submitted.push({ kind, context });
    jobs.next += 1;
    return { jobId: `job-${jobs.next}` };
  }),
  getJob: vi.fn(async (jobId: string) => {
    const sharpenTurn = jobs.results.get(jobId);
    return sharpenTurn
      ? { jobId, status: 'succeeded', result: { sharpenTurn }, error: null }
      : { jobId, status: 'running', result: null, error: null };
  }),
  streamJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { PlanSessionEndedError } = await import('@/lib/planChange/errors');

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  jobs.next = 0;
  jobs.submitted = [];
  jobs.results.clear();
  jobs.failNext = null;
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  pctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const REQUEST = 'Add shared export presets';
const QUESTION = {
  id: 'q2',
  text: 'Which formats?',
  topic: 'alternative',
  because: null,
  quote: null,
  readings: [
    { id: 'a', label: 'CSV only', detail: 'Smallest first version', recommended: true },
    { id: 'b', label: 'CSV and PDF', detail: '', recommended: false },
  ],
};
const SETTLED = [
  {
    questionId: 'q1',
    question: 'Who uses presets?',
    answer: 'The finance team',
    topic: 'workflow',
    readingId: 'a',
    source: 'person',
  },
];
const ASSUMED = [
  {
    questionId: 'q2',
    question: 'Which formats?',
    recommendation: 'CSV only',
    why: 'Smallest first version',
    source: 'planner',
  },
];
/** The wire shape motir-ai's `parseCarriedAnswers` reads: no `source`. */
const CARRIED = {
  requests: [REQUEST],
  settled: [
    {
      questionId: 'q1',
      question: 'Who uses presets?',
      answer: 'The finance team',
      topic: 'workflow',
      readingId: 'a',
    },
  ],
  assumptions: [
    {
      questionId: 'q2',
      question: 'Which formats?',
      recommendation: 'CSV only',
      why: 'Smallest first version',
    },
  ],
};

/** A conversation with one request. */
async function conversation(): Promise<string> {
  const thread = await openTestSession(pctx);
  await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
  return thread.id;
}

/** Grill the conversation, land one turn, and optionally end the grilling. */
async function grill(
  conversationId: string,
  turn: { kind: string; settled: unknown[]; assumptions: unknown[] },
): Promise<string> {
  const opened = await aiSharpenService.open({ conversationId }, pctx);
  jobs.results.set(opened.jobId!, {
    question: turn.kind === 'question' ? QUESTION : null,
    writeBack: null,
    ...turn,
  });
  await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
  return opened.session.id;
}

const planJob = () => jobs.submitted.find((j) => j.kind !== 'sharpen_turn')!;

describe('plan submit carries the conversation’s settled answers', () => {
  it.each(['finished', 'stopped', 'nothing_to_ask'])(
    'a grilling that ended %s rides the planning job as carriedAnswers, in the wire shape',
    async (kind) => {
      const conversationId = await conversation();
      await grill(conversationId, { kind, settled: SETTLED, assumptions: ASSUMED });
      await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
      expect(planJob().context['carriedAnswers']).toEqual(CARRIED);
    },
  );

  it('a grilling still open (Grill me switched off mid-way) carries what it settled so far', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'question', settled: SETTLED, assumptions: [] });
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    expect(planJob().context['carriedAnswers']).toEqual({ ...CARRIED, assumptions: [] });
  });

  it('beside a caller-supplied requirement, never merged into it', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: ASSUMED });
    const requirement = { outcome: 'Presets exist', behaviour: 'Save a preset' };
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId }, requirement);
    expect(planJob().context['requirement']).toEqual(requirement);
    expect(planJob().context['carriedAnswers']).toEqual(CARRIED);
  });

  it('a request written after the grilling is not among the carried requests', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: [] });
    await planChangeSessionsService.appendTurn('Also schedule it weekly', pctx, {
      sessionId: conversationId,
    });
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    expect((planJob().context['carriedAnswers'] as { requests: string[] }).requests).toEqual([
      REQUEST,
    ]);
  });

  it('no grilling, or one that settled nothing, sends the context it sends today: no key', async () => {
    const plain = await conversation();
    await planChangeSessionsService.submit(pctx, { sessionId: plain });
    expect('carriedAnswers' in planJob().context).toBe(false);

    jobs.submitted = [];
    const empty = await conversation();
    await grill(empty, { kind: 'nothing_to_ask', settled: [], assumptions: [] });
    await planChangeSessionsService.submit(pctx, { sessionId: empty });
    expect('carriedAnswers' in planJob().context).toBe(false);
  });

  it('a failed submit leaves the answers stored, so a retried Confirm carries them again', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: ASSUMED });
    jobs.failNext = new MotirAiUnavailableError('down');
    await expect(
      planChangeSessionsService.submit(pctx, { sessionId: conversationId }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    expect(planJob().context['carriedAnswers']).toEqual(CARRIED);
  });

  it('an ended conversation is still refused before anything is sent', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: [] });
    await adminDb.planChangeSession.update({
      where: { id: conversationId },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    const before = jobs.submitted.length;
    await expect(
      planChangeSessionsService.submit(pctx, { sessionId: conversationId }),
    ).rejects.toBeInstanceOf(PlanSessionEndedError);
    expect(jobs.submitted).toHaveLength(before);
  });

  it('a submit that revises the waiting plan sends no planning job, so carries nothing', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: [] });
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
    const before = jobs.submitted.length;
    await planChangeSessionsService.appendTurn('Make it two presets', pctx, {
      sessionId: conversationId,
    });
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId }).catch(() => null);
    for (const j of jobs.submitted.slice(before)) {
      expect('carriedAnswers' in j.context).toBe(false);
    }
  });
});

describe('the turns that start the offer a grilling held (MOTIR-9319)', () => {
  const OFFER_REQUEST = 'Plan shared export presets for the finance team.';

  /** The answer carrying a plan offer, written before the grilling opens. */
  async function offered(conversationId: string): Promise<string> {
    const { turnCount: seq } = await adminDb.planChangeSession.update({
      where: { id: conversationId },
      data: { turnCount: { increment: 1 } },
      select: { turnCount: true },
    });
    const turn = await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: conversationId,
        seq: seq - 1,
        role: 'assistant',
        body: 'I can plan export presets.',
        isAnswer: true,
        answerOffer: { kind: 'plan', requestMd: OFFER_REQUEST, targetKey: null },
      },
    });
    return turn.id;
  }

  /** A typed yes, the start's claim on the offer, and the request it appends. */
  async function startWithTypedYes(conversationId: string, offerTurnId: string) {
    await planChangeSessionsService.appendTurn('yes, plan it', pctx, {
      sessionId: conversationId,
    });
    const offer = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: offerTurnId } });
    await adminDb.planChangeTurn.update({
      where: { id: offerTurnId },
      data: {
        answerOffer: {
          ...(offer.answerOffer as object),
          confirmedAt: new Date().toISOString(),
          confirmedById: fx.ownerId,
        },
      },
    });
    await planChangeSessionsService.appendTurn(OFFER_REQUEST, pctx, {
      sessionId: conversationId,
    });
  }

  it('are among the carried requests, so the run they start does not grill that request again', async () => {
    const conversationId = await conversation();
    const offerTurnId = await offered(conversationId);
    await grill(conversationId, { kind: 'stopped', settled: SETTLED, assumptions: [] });
    await startWithTypedYes(conversationId, offerTurnId);
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    const requests = [REQUEST, 'yes, plan it', OFFER_REQUEST];
    expect((planJob().context['carriedAnswers'] as { requests: string[] }).requests).toEqual(
      requests,
    );
    jobs.submitted = [];
    await aiSharpenService.open({ planId }, pctx);
    const run = (jobs.submitted[0]!.context['sharpen'] as { run: Record<string, unknown> }).run;
    expect(run['requests']).toEqual(requests);
    expect((run['carried'] as { requests: string[] }).requests).toEqual(requests);
  });

  it('are not carried when the offer was answered after the grilling, not held by it', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: [] });
    const offerTurnId = await offered(conversationId);
    await startWithTypedYes(conversationId, offerTurnId);
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    expect((planJob().context['carriedAnswers'] as { requests: string[] }).requests).toEqual([
      REQUEST,
    ]);
  });
});

describe('the in-run grilling’s run block carries them', () => {
  it('a Sharpen session over the run’s plan gets run.carried', async () => {
    const conversationId = await conversation();
    await grill(conversationId, { kind: 'finished', settled: SETTLED, assumptions: ASSUMED });
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    jobs.submitted = [];
    await aiSharpenService.open({ planId }, pctx);
    const run = (jobs.submitted[0]!.context['sharpen'] as { run: Record<string, unknown> }).run;
    expect(run['carried']).toEqual(CARRIED);
    expect(run['requests']).toEqual([REQUEST]);
  });

  it('a conversation that settled nothing leaves the run block as it was: no carried key', async () => {
    const conversationId = await conversation();
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    jobs.submitted = [];
    await aiSharpenService.open({ planId }, pctx);
    const run = (jobs.submitted[0]!.context['sharpen'] as { run: Record<string, unknown> }).run;
    expect(run).toEqual({ planId, requests: [REQUEST], card: null });
  });
});
