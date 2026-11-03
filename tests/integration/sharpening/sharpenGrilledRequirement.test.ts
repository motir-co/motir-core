import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';
import { BUG_REF, bugDraft } from '../../fixtures/logBugOfferFixtures';

// Bug MOTIR-10255 — the requirement a Grill me grilling WRITES for the plan offer it
// holds: every job names the offer (`conversation.offer`), and the end of a grilling
// that settled anything lands motir-ai's rewritten requirement ON the undecided offer,
// in the transaction that ends the session. A decided offer is never written. Real
// Postgres; only the motir-ai boundary client is stubbed. Real Postgres; only the motir-ai boundary client is stubbed.

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
const { planOfferService } = await import('@/lib/services/planOfferService');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');

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
const OFFER_REQUEST = 'Plan shared export presets for the finance team.';
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
const BEFORE = {
  outcome: 'Presets exist.',
  behaviour: 'Save a preset.',
  scopeEdge: '',
  constraints: '',
  acceptance: 'A preset can be applied.',
  assumptions: [],
};
const WRITTEN = {
  outcome: 'The finance team shares export presets.',
  behaviour: 'Save a preset; apply it.\n- Who uses presets? — The finance team',
  scopeEdge: 'No scheduling.',
  constraints: '',
  acceptance: 'A finance member applies a shared preset.',
  assumptions: [{ id: 'q2', text: 'Which formats? — CSV only' }],
};

/** A conversation with one request and an answer carrying a plan offer. */
async function offeredConversation(
  requirement: Record<string, unknown> | null = BEFORE,
): Promise<{ conversationId: string; offerTurnId: string }> {
  const thread = await openTestSession(pctx);
  await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
  const { turnCount: seq } = await adminDb.planChangeSession.update({
    where: { id: thread.id },
    data: { turnCount: { increment: 1 } },
    select: { turnCount: true },
  });
  const turn = await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: thread.id,
      seq: seq - 1,
      role: 'assistant',
      body: 'I can plan export presets.',
      isAnswer: true,
      answerOffer: {
        kind: 'plan',
        requestMd: OFFER_REQUEST,
        targetKey: null,
        ...(requirement ? { requirement } : {}),
      } as Prisma.InputJsonValue,
    },
  });
  return { conversationId: thread.id, offerTurnId: turn.id };
}

async function rawOffer(turnId: string): Promise<Record<string, unknown>> {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown>;
}

async function setOffer(turnId: string, patch: Record<string, unknown>): Promise<void> {
  await adminDb.planChangeTurn.update({
    where: { id: turnId },
    data: { answerOffer: { ...(await rawOffer(turnId)), ...patch } as Prisma.InputJsonValue },
  });
}

/** Open the grilling and land one turn carrying `extra`. */
async function grillOnce(
  conversationId: string,
  kind: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const opened = await aiSharpenService.open({ conversationId }, pctx);
  jobs.results.set(opened.jobId!, {
    kind,
    question:
      kind === 'question'
        ? {
            id: 'q2',
            text: 'Which formats?',
            topic: 'alternative',
            because: null,
            quote: null,
            readings: [{ id: 'a', label: 'CSV only', detail: '', recommended: true }],
          }
        : null,
    settled: SETTLED,
    assumptions: [],
    writeBack: null,
    ...extra,
  });
  await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
  return opened.session.id;
}

const sharpenContext = () =>
  jobs.submitted.find((j) => j.kind === 'sharpen_turn')!.context['sharpen'] as {
    conversation: Record<string, unknown>;
  };

describe('every conversation grilling job names the offer it holds', () => {
  it('an undecided plan offer rides as conversation.offer, with its requirement', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    await aiSharpenService.open({ conversationId }, pctx);
    expect(sharpenContext().conversation['offer']).toEqual({
      turnId: offerTurnId,
      requestMd: OFFER_REQUEST,
      requirement: BEFORE,
    });
  });

  it('an offer with no requirement rides without one', async () => {
    const { conversationId, offerTurnId } = await offeredConversation(null);
    await aiSharpenService.open({ conversationId }, pctx);
    expect(sharpenContext().conversation['offer']).toEqual({
      turnId: offerTurnId,
      requestMd: OFFER_REQUEST,
    });
  });

  it('a conversation with no offer sends offer: null', async () => {
    const thread = await openTestSession(pctx);
    await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
    await aiSharpenService.open({ conversationId: thread.id }, pctx);
    expect(sharpenContext().conversation['offer']).toBeNull();
  });

  it('a declined offer is not held: offer: null', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    await setOffer(offerTurnId, { declinedAt: new Date().toISOString() });
    await aiSharpenService.open({ conversationId }, pctx);
    expect(sharpenContext().conversation['offer']).toBeNull();
  });
});

describe('the grilling’s end stores the requirement on the offer', () => {
  it.each(['finished', 'stopped'])(
    'a grilling that ended %s replaces the offer’s requirement and keeps its other keys',
    async (kind) => {
      const { conversationId, offerTurnId } = await offeredConversation();
      const sessionId = await grillOnce(conversationId, kind, {
        requirement: { offerTurnId, requirement: WRITTEN },
      });
      expect(await rawOffer(offerTurnId)).toEqual({
        kind: 'plan',
        requestMd: OFFER_REQUEST,
        targetKey: null,
        requirement: WRITTEN,
      });
      const row = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.status).not.toBe('open');
    },
  );

  it('an offer with no requirement gets the written one', async () => {
    const { conversationId, offerTurnId } = await offeredConversation(null);
    await grillOnce(conversationId, 'finished', {
      requirement: { offerTurnId, requirement: WRITTEN },
    });
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(WRITTEN);
  });

  it('a question turn that carries a requirement does not write it: only an end does', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    await grillOnce(conversationId, 'question', {
      requirement: { offerTurnId, requirement: WRITTEN },
    });
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(BEFORE);
  });

  it('an end with no requirement leaves the offer as it was', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    await grillOnce(conversationId, 'finished', {});
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(BEFORE);
  });

  it('a malformed requirement fails the turn and writes nothing', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    const sessionId = await grillOnce(conversationId, 'finished', {
      requirement: { offerTurnId, requirement: { ...WRITTEN, outcome: '  ' } },
    });
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(BEFORE);
    const row = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.status).toBe('open');
  });

  it('an offer confirmed while the turn ran keeps the requirement it was confirmed on', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    const opened = await aiSharpenService.open({ conversationId }, pctx);
    await setOffer(offerTurnId, {
      confirmedAt: new Date().toISOString(),
      confirmedById: fx.ownerId,
    });
    jobs.results.set(opened.jobId!, {
      kind: 'finished',
      question: null,
      settled: SETTLED,
      assumptions: [],
      writeBack: null,
      requirement: { offerTurnId, requirement: WRITTEN },
    });
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(BEFORE);
  });
});

describe('storeGrilledRequirementWithin', () => {
  const store = (conversationId: string, offerTurnId: string) =>
    withWorkspaceContext({ workspaceId: fx.workspaceId, userId: fx.ownerId }, (tx) =>
      planOfferService.storeGrilledRequirementWithin(
        pctx,
        { sessionId: conversationId, offerTurnId },
        WRITTEN,
        tx,
      ),
    );

  it('writes an undecided offer and answers true', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    expect(await store(conversationId, offerTurnId)).toBe(true);
    expect((await rawOffer(offerTurnId))['requirement']).toEqual(WRITTEN);
  });

  it('answers false for a declined, a superseded or an unknown offer, writing nothing', async () => {
    const declined = await offeredConversation();
    await setOffer(declined.offerTurnId, { declinedAt: new Date().toISOString() });
    expect(await store(declined.conversationId, declined.offerTurnId)).toBe(false);
    expect((await rawOffer(declined.offerTurnId))['requirement']).toEqual(BEFORE);

    const superseded = await offeredConversation();
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: superseded.conversationId,
        seq: 99,
        role: 'assistant',
        body: 'A later answer.',
        isAnswer: true,
      },
    });
    expect(await store(superseded.conversationId, superseded.offerTurnId)).toBe(false);
    expect((await rawOffer(superseded.offerTurnId))['requirement']).toEqual(BEFORE);

    expect(await store(superseded.conversationId, 'no-such-turn')).toBe(false);
  });

  it('answers false for an offer that is not a plan offer', async () => {
    const { conversationId, offerTurnId } = await offeredConversation();
    await setOffer(offerTurnId, {
      kind: 'log_bug',
      requirement: undefined,
      bug: {
        title: 'Saving a comment drops the @mention',
        acceptanceCriteria: ['A saved comment keeps its @mention'],
        contextRefs: [BUG_REF],
        target: { kind: 'new', key: null, title: null },
        targetUpdatedAt: null,
        draft: bugDraft(),
      },
    });
    expect(await store(conversationId, offerTurnId)).toBe(false);
    expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirement');
  });
});
