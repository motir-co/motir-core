import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { SharpenConversationSettledDto } from '@/lib/dto/sharpen';
import { planOfferStateOf } from '@/lib/planChange/planOffer';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';

// CONFIRM SAVES THE REQUIREMENT PAGE (Story MOTIR-9430 · MOTIR-9436), on REAL Postgres.
// A confirmed no-target offer that carries a composed requirement writes it as a page
// in Requirements Docs exactly once, records the page on the offer before the run is
// submitted, and submits the run with `requirement` + `requirementPage` and NO carried
// answers. A save that fails starts nothing and leaves the offer pending.
//
// Mocked: the motir-ai boundary (`submitJob` captured) and the Grill me read. The page
// writer runs for real against a provisioned Motir account; a failure is injected with
// a spy that calls through otherwise.

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { requirementPageService } = await import('@/lib/services/requirementPageService');
const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanOfferRequirementNotSavedError } = await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };
const REQUEST = 'Plan the CSV export for reports.';
const REQUIREMENT = {
  outcome: 'Managers can export a report as CSV.',
  behaviour: 'The export button downloads the filtered rows.',
  scopeEdge: 'No scheduled exports.',
  constraints: '',
  acceptance: 'The file opens in a spreadsheet with the same rows.',
  assumptions: [{ id: 'r1', text: 'Comma separated, UTF-8.' }],
};
const SETTLED = {
  requests: [REQUEST],
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

const writeSpy = vi.spyOn(requirementPageService, 'write');
const settledSpy = vi.spyOn(aiSharpenService, 'getSettledForConversation');

let fx: WorkItemFixture;
let jobSeq = 0;

/** The Motir account, in a meta tenant it alone belongs to (no membership in `fx`). */
async function provisionMotir() {
  const metaOwner = await usersService.createUser({
    email: 'meta-owner@example.com',
    password: 'hunter2hunter2',
    name: 'meta',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: metaOwner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: metaOwner.id,
  });
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  writeSpy.mockClear();
  settledSpy.mockReset();
  settledSpy.mockResolvedValue(null);
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
  await provisionMotir();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function me(): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function turn(ask: Record<string, unknown>, sessionId?: string) {
  const submitted = await aiAskService.submitTurn(
    'Can we export reports?',
    me(),
    sessionId ? { sessionId } : {},
  );
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, me(), { sessionId: submitted.session.id });
  return { jobId, sessionId: submitted.session.id, settled };
}

const answerWith = (extra: Record<string, unknown> = {}) => ({
  intent: 'ask',
  answer: 'I can plan that.',
  citations: [],
  ...extra,
});

const lastAnswer = (turns: readonly PlanChangeTurnDto[]) =>
  turns.filter((t) => t.role === 'assistant').at(-1)!;

/** A conversation whose last answer carries a no-target plan offer. */
async function offered(
  opts: { requirement?: unknown; targetKey?: string; sessionId?: string; extra?: object } = {},
) {
  const requirement = 'requirement' in opts ? opts.requirement : REQUIREMENT;
  const { sessionId, settled } = await turn(
    answerWith({
      offer: {
        kind: 'plan',
        requestText: REQUEST,
        ...(opts.targetKey ? { targetKey: opts.targetKey } : {}),
        immediate: false,
        ...(requirement ? { requirement } : {}),
        ...opts.extra,
      },
    }),
    opts.sessionId,
  );
  const answer = lastAnswer(settled.session.turns);
  return { conversationId: sessionId, offerTurnId: answer.id, offerSeq: answer.seq };
}

async function rawOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown> | null;
}

const planCalls = () => submitJobMock.mock.calls.filter((c) => c[0] !== 'ask_project');
const planContext = (n = 0) => planCalls()[n]![2] as Record<string, unknown>;
const requirementPages = () =>
  adminDb.page.findMany({ where: { projectId: fx.projectId, title: { contains: 'CSV' } } });

describe('a confirmed no-target offer with a requirement', () => {
  it(
    'saves one page, records it on the offer before the run, and sends requirement + page, no carried answers',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered();
      // What the offer held at the moment the run was submitted.
      let heldAtSubmit: Record<string, unknown> | null = null;
      submitJobMock.mockImplementation(async (kind: string) => {
        if (kind !== 'ask_project') heldAtSubmit = await rawOffer(offerTurnId);
        return { jobId: `job-${++jobSeq}` };
      });

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0]![0]).toMatchObject({
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        requirement: REQUIREMENT,
        requestMd: REQUEST,
        conversationLabel: conversationId,
        locale: 'en',
      });
      const pages = await requirementPages();
      expect(pages).toHaveLength(1);
      const recorded = { pageId: pages[0]!.id, title: pages[0]!.title };
      expect(heldAtSubmit).toMatchObject({ requirementPage: recorded });
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
      expect(planContext()['requirementPage']).toEqual(recorded);
      expect(planContext()).not.toHaveProperty('carriedAnswers');
      expect(await rawOffer(offerTurnId)).toMatchObject({
        requirementPage: recorded,
        confirmedSessionId: started.sessionId,
      });
      expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirementSaveFailed');
    },
  );

  it('two concurrent confirms write one page and start one run', T, async () => {
    const { conversationId, offerTurnId } = await offered();

    const [a, b] = await Promise.all([
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
    ]);

    expect(b.sessionId).toBe(a.sessionId);
    expect(b.jobId).toBe(a.jobId);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await requirementPages()).toHaveLength(1);
    expect(planCalls()).toHaveLength(1);
  });

  it(
    'on a conversation holding an undecided plan, the restart carries the same requirement and page',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered();
      await planChangeSessionsService.submit(me(), { sessionId: conversationId });
      expect(planCalls()).toHaveLength(1);

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(started.sessionId).not.toBe(conversationId);
      expect(planCalls()).toHaveLength(2);
      const page = (await requirementPages())[0]!;
      expect(planContext(1)['requirement']).toEqual(REQUIREMENT);
      expect(planContext(1)['requirementPage']).toEqual({ pageId: page.id, title: page.title });
      expect(planContext(1)).not.toHaveProperty('carriedAnswers');
    },
  );

  it(
    'a restart whose start throws resumes on its successor and re-uses the recorded page',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      await planChangeSessionsService.submit(me(), { sessionId: conversationId });
      submitJobMock.mockImplementationOnce(async () => {
        throw new Error('motir-ai is down');
      });
      await expect(
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ).rejects.toThrow('motir-ai is down');
      expect(writeSpy).toHaveBeenCalledTimes(1);

      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(await requirementPages()).toHaveLength(1);
      const page = (await requirementPages())[0]!;
      expect(planContext(planCalls().length - 1)['requirementPage']).toEqual({
        pageId: page.id,
        title: page.title,
      });
    },
  );
});

describe('a save that fails', () => {
  it(
    'starts nothing, leaves the offer pending with requirementSaveFailed, and a retry succeeds',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockRejectedValueOnce(new Error('folder refused'));

      await expect(
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ).rejects.toBeInstanceOf(PlanOfferRequirementNotSavedError);

      expect(planCalls()).toHaveLength(0);
      expect(await requirementPages()).toHaveLength(0);
      expect(await rawOffer(offerTurnId)).toMatchObject({
        confirmedAt: null,
        requirementSaveFailed: true,
      });
      expect(await rawOffer(offerTurnId)).not.toHaveProperty('startRefusal');
      const thread = await planChangeSessionsService.getById(me(), conversationId);
      const offer = thread.turns.find((t) => t.id === offerTurnId)!.offer!;
      expect(offer.requirementSaveFailed).toBe(true);
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('undecided');

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      expect(writeSpy).toHaveBeenCalledTimes(2);
      expect(await requirementPages()).toHaveLength(1);
      expect(planCalls()).toHaveLength(1);
      const stored = await rawOffer(offerTurnId);
      expect(stored).toMatchObject({ confirmedSessionId: started.sessionId });
      expect(stored).toHaveProperty('requirementPage');
      expect(stored).not.toHaveProperty('requirementSaveFailed');
    },
  );

  it('an unprovisioned Motir account is the same failure', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    writeSpy.mockImplementationOnce(async () => {
      const { SystemPrincipalNotProvisionedError } = await import('@/lib/ai/serviceAuth');
      throw new SystemPrincipalNotProvisionedError();
    });
    await expect(
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
    ).rejects.toBeInstanceOf(PlanOfferRequirementNotSavedError);
    expect(planCalls()).toHaveLength(0);
  });

  it('a typed yes whose save fails still lands its answer and starts nothing', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered();
    writeSpy.mockRejectedValueOnce(new Error('folder refused'));
    const yes = await aiAskService.submitTurn('Yes, go ahead.', me(), {
      sessionId: conversationId,
    });
    if (!('jobId' in yes) || !yes.jobId) throw new Error('not an ask');
    jobs.set(yes.jobId, {
      jobId: yes.jobId,
      status: 'succeeded',
      result: {
        ask: answerWith({
          answer: 'Starting the plan.',
          offerReply: { seq: offerSeq, kind: 'plan', decision: 'agree' },
        }),
      },
      error: null,
    });

    const settled = await aiAskService.settle(yes.jobId, me(), { sessionId: conversationId });

    expect(settled.outcome).toBe('answered');
    expect(planCalls()).toHaveLength(0);
    expect(await rawOffer(offerTurnId)).toMatchObject({ requirementSaveFailed: true });
  });
});

describe('a start that throws after the page was written', () => {
  it('keeps the page: the next confirm writes none and the run carries that page', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    submitJobMock.mockImplementationOnce(async () => {
      throw new Error('motir-ai is down');
    });
    await expect(
      planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
    ).rejects.toThrow('motir-ai is down');
    expect(await rawOffer(offerTurnId)).toHaveProperty('requirementPage');

    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const pages = await requirementPages();
    expect(pages).toHaveLength(1);
    expect(planContext()['requirementPage']).toEqual({
      pageId: pages[0]!.id,
      title: pages[0]!.title,
    });
  });
});

describe('offers the page does not touch', () => {
  it(
    'a no-target offer with no requirement starts as before: no writer, carried answers kept',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered({ requirement: undefined });

      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

      expect(writeSpy).not.toHaveBeenCalled();
      expect(planContext()).not.toHaveProperty('requirement');
      expect(planContext()).not.toHaveProperty('requirementPage');
      expect(planContext()['carriedAnswers']).toBeDefined();
      const stored = await rawOffer(offerTurnId);
      expect(stored).not.toHaveProperty('requirementPage');
      expect(stored).not.toHaveProperty('requirementSaveFailed');
    },
  );

  it('a targeted offer with no requirement calls no writer and sends no page', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
      fx.ctx,
    );
    const { conversationId, offerTurnId } = await offered({
      targetKey: target.identifier,
      requirement: undefined,
    });

    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(planContext()).not.toHaveProperty('requirement');
    expect(planContext()).not.toHaveProperty('requirementPage');
  });
});

// MOTIR-9878: the requirement is the planner's decision on a targeted offer too. Its
// target is a reference, not the WHAT, so a targeted offer carrying a requirement is
// stored, saved as one page on Confirm and submitted exactly as a no-target one is.
describe('a confirmed targeted offer with a requirement', () => {
  it('stores it, saves one page, and sends requirement + page on the target’s run', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Reports' },
      fx.ctx,
    );
    const { conversationId, offerTurnId } = await offered({ targetKey: target.identifier });
    expect(await rawOffer(offerTurnId)).toMatchObject({
      targetKey: target.identifier,
      requirement: REQUIREMENT,
    });

    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]![0]).toMatchObject({ requirement: REQUIREMENT });
    const pages = await requirementPages();
    expect(pages).toHaveLength(1);
    const recorded = { pageId: pages[0]!.id, title: pages[0]!.title };
    expect(planCalls()).toHaveLength(1);
    expect(planContext()['requirement']).toEqual(REQUIREMENT);
    expect(planContext()['requirementPage']).toEqual(recorded);
    expect(planContext()).not.toHaveProperty('carriedAnswers');
    expect(await rawOffer(offerTurnId)).toMatchObject({ requirementPage: recorded });
  });
});

describe('other entrances to submit', () => {
  it('a plain submit still sends carried answers and no page', T, async () => {
    settledSpy.mockResolvedValue(SETTLED);
    const { conversationId } = await offered();

    await planChangeSessionsService.submit(me(), { sessionId: conversationId });

    expect(planContext()['carriedAnswers']).toBeDefined();
    expect(planContext()).not.toHaveProperty('requirementPage');
  });
});
