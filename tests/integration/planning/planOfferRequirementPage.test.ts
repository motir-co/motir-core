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
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';

// A CONFIRMED OFFER STARTS AT ONCE AND ITS PAGE IS SAVED AFTER (Story MOTIR-9430 ·
// MOTIR-9436; MOTIR-10091), on REAL Postgres. A confirmed offer that carries a composed
// requirement submits its run straight from the stored requirement, with the
// `requirementConfirmed` marker and NO carried answers, and requests ONE page-save job,
// keyed by the offer turn, after the claim commits. The job writes the page in
// Requirements Docs and records it on the offer; a job that fails every attempt leaves
// the run running and marks the offer `requirementPageFailed`.
//
// Mocked: the motir-ai boundary (`submitJob` captured) and the Grill me read. The job
// dispatcher is CAPTURED, and each captured event is handed to the job's own handler,
// the call a worker would make. The page writer runs for real against a provisioned
// Motir account; a failure is injected with a spy that calls through otherwise.

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
const { planOfferRequirementPage, REQUIREMENT_PAGE_MAX_ATTEMPTS } =
  await import('@/lib/jobs/definitions/planOfferRequirementPage');

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
let events: CapturedJobEvent[];
let restoreEvents: (() => void) | undefined;

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
  // A reset spy calls through to the real writer again (a test may have made it fail).
  writeSpy.mockReset();
  settledSpy.mockReset();
  settledSpy.mockResolvedValue(null);
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  restoreEvents?.();
  ({ events, restore: restoreEvents } = captureJobEvents());
  fx = await makeWorkItemFixture();
  await provisionMotir();
});

afterEach(async () => {
  restoreEvents?.();
  restoreEvents = undefined;
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
const pageAsks = () => events.filter((e) => e.name === 'plan-offer/requirement-page.requested');

/**
 * Hand every captured page request to the JOB'S OWN handler, as a worker would — the
 * engine's dedup included: one run per idempotency key, whatever was emitted.
 */
async function drainPageJobs(opts: { attempt?: number } = {}) {
  const pending = pageAsks();
  const seen = new Set<string>();
  const outcomes = [];
  for (const event of pending) {
    const key = (event.data as { idempotencyKey: string }).idempotencyKey;
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes.push(
      await new JobTestEngine({
        function: planOfferRequirementPage,
        events: [event],
        ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
      }).execute(),
    );
  }
  return outcomes;
}

/** The typed yes against the offer at `offerSeq`, settled. */
async function typedYes(conversationId: string, offerSeq: number) {
  const yes = await aiAskService.submitTurn('Yes, go ahead.', me(), { sessionId: conversationId });
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
  return aiAskService.settle(yes.jobId, me(), { sessionId: conversationId });
}

describe('a confirmed no-target offer with a requirement', () => {
  it(
    'starts the run from the stored requirement with the marker and no page, and asks for ONE page after the claim',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered();
      // What had been asked for at the moment the run was submitted.
      let asksAtSubmit = -1;
      submitJobMock.mockImplementation(async (kind: string) => {
        if (kind !== 'ask_project') asksAtSubmit = pageAsks().length;
        return { jobId: `job-${++jobSeq}` };
      });

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      // Nothing was written inside the confirm: the page is the job's.
      expect(writeSpy).not.toHaveBeenCalled();
      expect(await requirementPages()).toHaveLength(0);
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(planContext()).not.toHaveProperty('requirementPage');
      expect(planContext()).not.toHaveProperty('carriedAnswers');
      // The request was sent once the claim committed, before the run was submitted.
      expect(asksAtSubmit).toBe(1);
      expect(pageAsks().map((e) => e.data)).toEqual([
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          userId: fx.ownerId,
          conversationId,
          offerTurnId,
          idempotencyKey: offerTurnId,
        },
      ]);
      expect(await rawOffer(offerTurnId)).toMatchObject({ confirmedSessionId: started.sessionId });
      expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirementPage');
    },
  );

  it(
    'the job writes one page in Requirements Docs, records it on the offer, and the thread serves it',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

      const [outcome] = await drainPageJobs();

      expect(outcome!.error).toBeUndefined();
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
      const folder = await adminDb.folder.findUniqueOrThrow({ where: { id: pages[0]!.folderId! } });
      expect(folder.name).toBe('Requirements Docs');
      const recorded = { pageId: pages[0]!.id, title: pages[0]!.title };
      expect(outcome!.result).toEqual({ saved: true, pageId: recorded.pageId });
      expect(await rawOffer(offerTurnId)).toMatchObject({ requirementPage: recorded });
      const thread = await planChangeSessionsService.getById(me(), conversationId);
      const offer = thread.turns.find((t) => t.id === offerTurnId)!.offer!;
      expect(offer.requirementPage).toEqual(recorded);
      expect(offer.requirementPageFailed).toBeUndefined();
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('confirmed');
    },
  );

  it(
    'two concurrent confirms start one run, ask once, and the job writes one page',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();

      const [a, b] = await Promise.all([
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ]);
      await drainPageJobs();

      expect(b.sessionId).toBe(a.sessionId);
      expect(b.jobId).toBe(a.jobId);
      expect(planCalls()).toHaveLength(1);
      expect(pageAsks()).toHaveLength(1);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(await requirementPages()).toHaveLength(1);
    },
  );

  it('Confirm and then a typed agreement start one run and save one page', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered();
    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

    const settled = await typedYes(conversationId, offerSeq);
    await drainPageJobs();

    expect(settled.outcome).toBe('answered');
    expect(planCalls()).toHaveLength(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await requirementPages()).toHaveLength(1);
  });

  it('a job run again after its page was recorded writes nothing more', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
    await drainPageJobs();
    const before = await rawOffer(offerTurnId);

    const [again] = await drainPageJobs();

    expect(again!.error).toBeUndefined();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await requirementPages()).toHaveLength(1);
    expect(await rawOffer(offerTurnId)).toEqual(before);
  });

  it(
    'on a conversation holding an undecided plan, the restart carries the same requirement and marker',
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
      await drainPageJobs();

      expect(started.sessionId).not.toBe(conversationId);
      expect(planCalls()).toHaveLength(2);
      expect(planContext(1)['requirement']).toEqual(REQUIREMENT);
      expect(planContext(1)['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(planContext(1)).not.toHaveProperty('carriedAnswers');
      expect(await requirementPages()).toHaveLength(1);
    },
  );

  it(
    'a start that throws releases the claim, and the retry starts once with one page asked for',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      submitJobMock.mockImplementationOnce(async () => {
        throw new Error('motir-ai is down');
      });
      await expect(
        planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId }),
      ).rejects.toThrow('motir-ai is down');
      expect(await rawOffer(offerTurnId)).toMatchObject({ confirmedAt: null });

      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
      await drainPageJobs();

      expect(planCalls()).toHaveLength(2);
      expect(planContext(1)['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      // Each claim asked; the engine's key collapses them into one run and one page.
      expect(
        new Set(pageAsks().map((e) => (e.data as { idempotencyKey: string }).idempotencyKey)),
      ).toEqual(new Set([offerTurnId]));
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(await requirementPages()).toHaveLength(1);
    },
  );
});

describe('a page that cannot be saved', () => {
  it(
    'starts exactly one run anyway, and motir-ai is told the requirement is confirmed',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockRejectedValue(new Error('folder refused'));

      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });
      const [outcome] = await drainPageJobs();

      expect(outcome!.error?.message).toBe('folder refused');
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(await rawOffer(offerTurnId)).toMatchObject({ confirmedSessionId: started.sessionId });
      // Not the final attempt: the offer is not marked yet, the engine retries.
      expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirementPageFailed');
    },
  );

  it(
    'a job that fails every attempt leaves the run running and marks the offer for the rail',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockRejectedValue(new Error('folder refused'));
      const started = await planOfferStartService.confirmPlanOffer(me(), {
        conversationId,
        offerTurnId,
      });

      for (let attempt = 0; attempt < REQUIREMENT_PAGE_MAX_ATTEMPTS; attempt += 1) {
        const [outcome] = await drainPageJobs({ attempt });
        expect(outcome!.error?.message).toBe('folder refused');
      }

      expect(writeSpy).toHaveBeenCalledTimes(REQUIREMENT_PAGE_MAX_ATTEMPTS);
      expect(await requirementPages()).toHaveLength(0);
      expect(planCalls()).toHaveLength(1);
      const stored = await rawOffer(offerTurnId);
      expect(stored).toMatchObject({
        confirmedSessionId: started.sessionId,
        requirementPageFailed: true,
      });
      expect(stored).not.toHaveProperty('requirementPage');
      const thread = await planChangeSessionsService.getById(me(), conversationId);
      expect(thread.turns.find((t) => t.id === offerTurnId)!.offer!.requirementPageFailed).toBe(
        true,
      );
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('confirmed');
      // The run it started is the conversation's, untouched by the failed save.
      expect(thread.lastJobId).toBe(started.jobId);
    },
  );

  it(
    'an unprovisioned Motir account is the same failure, and the run still starts',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockImplementationOnce(async () => {
        const { SystemPrincipalNotProvisionedError } = await import('@/lib/ai/serviceAuth');
        throw new SystemPrincipalNotProvisionedError();
      });
      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
      const [outcome] = await drainPageJobs({ attempt: REQUIREMENT_PAGE_MAX_ATTEMPTS - 1 });
      expect(outcome!.error).toBeDefined();
      expect(planCalls()).toHaveLength(1);
      expect(await rawOffer(offerTurnId)).toMatchObject({ requirementPageFailed: true });
    },
  );

  it(
    'a typed agreement whose page cannot be saved starts the run, and the offer reads confirmed, not superseded',
    T,
    async () => {
      const { conversationId, offerTurnId, offerSeq } = await offered();
      writeSpy.mockRejectedValue(new Error('folder refused'));

      const settled = await typedYes(conversationId, offerSeq);
      for (let attempt = 0; attempt < REQUIREMENT_PAGE_MAX_ATTEMPTS; attempt += 1) {
        await drainPageJobs({ attempt });
      }

      expect(settled.outcome).toBe('redirected');
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      const thread = await planChangeSessionsService.getById(me(), conversationId);
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('confirmed');
      expect(await rawOffer(offerTurnId)).toMatchObject({ requirementPageFailed: true });
    },
  );

  it('a page recorded before the final failure is kept: the failure marks nothing', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
    await drainPageJobs();
    const { requirementPageSaveService } =
      await import('@/lib/services/requirementPageSaveService');
    const data = pageAsks()[0]!.data as Parameters<
      typeof requirementPageSaveService.recordFailure
    >[0];

    await requirementPageSaveService.recordFailure(data);
    await requirementPageSaveService.record(data, { pageId: 'other', title: 'Other' });

    const stored = await rawOffer(offerTurnId);
    expect(stored).not.toHaveProperty('requirementPageFailed');
    expect((stored!['requirementPage'] as { pageId: string }).pageId).not.toBe('other');
  });
});

describe('offers the page does not touch', () => {
  it(
    'a no-target offer with no requirement starts as before: no page asked for, carried answers kept',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered({ requirement: undefined });

      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

      expect(pageAsks()).toHaveLength(0);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(planContext()).not.toHaveProperty('requirement');
      expect(planContext()).not.toHaveProperty('requirementConfirmed');
      expect(planContext()['carriedAnswers']).toBeDefined();
      const stored = await rawOffer(offerTurnId);
      expect(stored).not.toHaveProperty('requirementPage');
      expect(stored).not.toHaveProperty('requirementPageFailed');
    },
  );

  it('a targeted offer with no requirement asks for no page and sends no marker', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
      fx.ctx,
    );
    const { conversationId, offerTurnId } = await offered({
      targetKey: target.identifier,
      requirement: undefined,
    });

    await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });

    expect(pageAsks()).toHaveLength(0);
    expect(planContext()).not.toHaveProperty('requirement');
    expect(planContext()).not.toHaveProperty('requirementConfirmed');
  });

  it('a job for an offer with no requirement writes nothing', T, async () => {
    const { conversationId, offerTurnId } = await offered({ requirement: undefined });
    const outcome = await new JobTestEngine({
      function: planOfferRequirementPage,
      events: [
        {
          name: 'plan-offer/requirement-page.requested',
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            userId: fx.ownerId,
            conversationId,
            offerTurnId,
            idempotencyKey: offerTurnId,
          },
        },
      ],
    }).execute();
    expect(outcome.result).toEqual({ saved: false });
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('a job for an offer turn that no longer reads writes nothing', T, async () => {
    const { conversationId } = await offered();
    const outcome = await new JobTestEngine({
      function: planOfferRequirementPage,
      events: [
        {
          name: 'plan-offer/requirement-page.requested',
          data: {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            userId: fx.ownerId,
            conversationId,
            offerTurnId: 'no-such-turn',
            idempotencyKey: 'no-such-turn',
          },
        },
      ],
    }).execute();
    expect(outcome.result).toEqual({ saved: false });
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// MOTIR-9878: the requirement is the planner's decision on a targeted offer too. Its
// target is a reference, not the WHAT, so a targeted offer carrying a requirement is
// stored, submitted with its marker and saved as one page after the start, exactly as a
// no-target one is.
describe('a confirmed targeted offer with a requirement', () => {
  it(
    'stores it, sends requirement + marker on the target’s run, and saves one page',
    T,
    async () => {
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
      await drainPageJobs();

      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(planContext()).not.toHaveProperty('carriedAnswers');
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const pages = await requirementPages();
      expect(pages).toHaveLength(1);
      expect(await rawOffer(offerTurnId)).toMatchObject({
        requirementPage: { pageId: pages[0]!.id, title: pages[0]!.title },
      });
    },
  );
});

describe('other entrances to submit', () => {
  it('a plain submit still sends carried answers and no marker', T, async () => {
    settledSpy.mockResolvedValue(SETTLED);
    const { conversationId } = await offered();

    await planChangeSessionsService.submit(me(), { sessionId: conversationId });

    expect(planContext()['carriedAnswers']).toBeDefined();
    expect(planContext()).not.toHaveProperty('requirementConfirmed');
    expect(pageAsks()).toHaveLength(0);
  });
});
