import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';

// GRILL ME'S HAND-OFF, END TO END IN CORE (Story MOTIR-11799 · Bug MOTIR-11798). With
// Grill me on, motir-ai's read writes NO requirement: its offer is DEFERRED and carries
// what it read. Core stores it as a `grill` offer — nothing to confirm, nothing in the
// left pane — opens the conversation grilling from it with the reads and the research,
// and turns it into the `plan` offer holding the requirement when the grilling ends.
// Real Postgres; only the motir-ai boundary client is stubbed.

const jobs = vi.hoisted(() => ({
  next: 0,
  submitted: [] as Array<{ kind: string; context: Record<string, unknown> }>,
  results: new Map<string, Record<string, unknown>>(),
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string, _tenant: unknown, context: Record<string, unknown>) => {
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
const { requirementPaneOf } = await import('@/lib/planning/requirementPane');
const { readAskOutcome } = await import('@/lib/planning/askResult');
type AskPlanOffer = import('@/lib/planning/askResult').AskPlanOffer;

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  jobs.next = 0;
  jobs.submitted = [];
  jobs.results.clear();
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

const REQUEST = 'Let people export the issue list.';
const READ_ANSWER = 'The issue list has no export today; the format is open.';
const RESEARCH = { version: 1, covered: [REQUEST], unchecked: null, decisions: [] };
const HANDOFF = { items: ['ACME-1'], code: ['src/export/list.ts'], research: RESEARCH };
const WRITTEN = {
  outcome: 'Members take the issue list elsewhere as a file.',
  behaviour: 'Export from the list page.\n- Who can export? — Any member',
  scopeEdge: '',
  constraints: '',
  acceptance: 'A file downloads.',
  assumptions: [],
};
const SETTLED = [
  {
    questionId: 'q1',
    question: 'Who can export?',
    answer: 'Any member',
    topic: 'workflow',
    readingId: 'a',
    source: 'person',
  },
];

/** The ask job's envelope with Grill me on, read the way the settle reads it. */
const DEFERRED_OUTCOME = readAskOutcome({
  ask: {
    intent: 'ask',
    answer: READ_ANSWER,
    citations: [],
    offer: {
      kind: 'plan',
      requestText: REQUEST,
      targetKey: null,
      immediate: false,
      deferred: true,
      handoff: HANDOFF,
    },
  },
})!;
const DEFERRED = { offer: DEFERRED_OUTCOME.offer as AskPlanOffer };

/** A conversation whose read, with Grill me on, landed its hand-off. */
async function handedConversation(): Promise<{ conversationId: string; offerTurnId: string }> {
  const thread = await openTestSession(pctx);
  await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
  const answerOffer = await planOfferService.land(DEFERRED.offer, pctx);
  const updated = await planChangeSessionsService.appendAnswerTurn(
    { jobId: 'ask-job-1', body: READ_ANSWER, citations: [], codeUnreadable: null, answerOffer },
    pctx,
    addressOf(thread),
  );
  return { conversationId: thread.id, offerTurnId: updated.turns.at(-1)!.id };
}

async function rawOffer(turnId: string): Promise<Record<string, unknown>> {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown>;
}

const sharpenContext = () =>
  jobs.submitted.find((j) => j.kind === 'sharpen_turn')!.context['sharpen'] as {
    conversation: Record<string, unknown>;
    research?: unknown;
  };

/** Open the grilling over the hand-off and land one ending turn carrying `extra`. */
async function endGrilling(conversationId: string, kind: string, extra: Record<string, unknown>) {
  const opened = await aiSharpenService.open({ conversationId }, pctx);
  jobs.results.set(opened.jobId!, {
    kind,
    question: null,
    settled: SETTLED,
    assumptions: [],
    writeBack: null,
    ...extra,
  });
  await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
}

describe('the read’s hand-off is stored as nothing to confirm', () => {
  it('lands as a `grill` offer: no requirement, its reads kept, no pane and no pending offer', async () => {
    const { conversationId, offerTurnId } = await handedConversation();
    expect(await rawOffer(offerTurnId)).toEqual({
      kind: 'grill',
      requestMd: REQUEST,
      targetKey: null,
      handoff: HANDOFF,
      declinedAt: null,
      declinedById: null,
      confirmedAt: null,
      confirmedById: null,
      confirmedSessionId: null,
    });
    const thread = await planChangeSessionsService.getById(pctx, conversationId);
    const turn = thread.turns.find((t) => t.id === offerTurnId)!;
    expect(turn.offer).toMatchObject({ kind: 'grill', handoff: HANDOFF });
    expect(turn.offer).not.toHaveProperty('requirement');
    // The left pane shows no requirement, and the next ask states no pending offer.
    expect(requirementPaneOf(thread.turns)).toBeNull();
    expect(planOfferService.statingPending(thread.turns)).toBeUndefined();
  });

  it('a target is resolved as a plan offer’s would be', async () => {
    const thread = await openTestSession(pctx);
    await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
    const landed = await planOfferService.land(
      { ...DEFERRED.offer, targetKey: fx.project.identifier + '-999' },
      pctx,
    );
    expect(landed).toMatchObject({ kind: 'grill', targetKey: null, handoff: HANDOFF });
  });
});

describe('the grilling opens from the hand-off', () => {
  it('sends the offer DEFERRED with its reads, and the read’s research as the session’s', async () => {
    const { conversationId, offerTurnId } = await handedConversation();
    await aiSharpenService.open({ conversationId }, pctx);
    const sharpen = sharpenContext();
    expect(sharpen.conversation['offer']).toEqual({
      turnId: offerTurnId,
      requestMd: REQUEST,
      deferred: true,
      handoff: { items: HANDOFF.items, code: HANDOFF.code },
    });
    expect(sharpen.conversation['readAnswer']).toBe(READ_ANSWER);
    expect(sharpen.research).toEqual(RESEARCH);
  });
});

describe('the grilling’s end writes the one plan offer', () => {
  it('the requirement it wrote turns the hand-off into the plan offer holding it', async () => {
    const { conversationId, offerTurnId } = await handedConversation();
    await endGrilling(conversationId, 'finished', {
      requirement: { offerTurnId, requirement: WRITTEN },
    });
    const stored = await rawOffer(offerTurnId);
    expect(stored).toMatchObject({ kind: 'plan', requestMd: REQUEST, requirement: WRITTEN });
    expect(stored).not.toHaveProperty('handoff');
    const thread = await planChangeSessionsService.getById(pctx, conversationId);
    // The left pane now shows it, and it is the live offer a Confirm acts on.
    expect(requirementPaneOf(thread.turns)).toEqual({
      turnId: offerTurnId,
      requestMd: REQUEST,
      requirement: WRITTEN,
    });
    expect(planOfferService.statingPending(thread.turns)).toMatchObject({ kind: 'plan' });
  });

  it.each(['stopped', 'nothing_to_ask'])(
    'an end (%s) that wrote none still leaves a plan offer, carrying no requirement',
    async (kind) => {
      const { conversationId, offerTurnId } = await handedConversation();
      await endGrilling(conversationId, kind, {});
      const stored = await rawOffer(offerTurnId);
      expect(stored['kind']).toBe('plan');
      expect(stored).not.toHaveProperty('handoff');
      expect(stored).not.toHaveProperty('requirement');
    },
  );

  it('a question turn leaves the hand-off as it is', async () => {
    const { conversationId, offerTurnId } = await handedConversation();
    await endGrilling(conversationId, 'question', {
      question: {
        id: 'q2',
        text: 'Which formats?',
        topic: 'alternative',
        because: null,
        quote: null,
        readings: [
          { id: 'a', label: 'CSV only', detail: '', recommended: true },
          { id: 'b', label: 'CSV and PDF', detail: '', recommended: false },
        ],
      },
    });
    expect((await rawOffer(offerTurnId))['kind']).toBe('grill');
  });

  it('releasing writes nothing over a plan offer or a decided hand-off', async () => {
    const { conversationId, offerTurnId } = await handedConversation();
    const release = () =>
      adminDb.$transaction((tx) =>
        planOfferService.releaseGrillHandoffWithin(pctx, { sessionId: conversationId }, tx),
      );
    await adminDb.planChangeTurn.update({
      where: { id: offerTurnId },
      data: {
        answerOffer: {
          ...(await rawOffer(offerTurnId)),
          declinedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
    });
    expect(await release()).toBe(false);
    expect((await rawOffer(offerTurnId))['kind']).toBe('grill');
  });
});
