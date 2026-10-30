// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { db } from '@/lib/db';
import { motirSystemUserId, SystemPrincipalNotProvisionedError } from '@/lib/ai/serviceAuth';
import { MotirAiOutOfCreditsError } from '@/lib/ai/errors';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { parsePlanningLaunch } from '@/lib/planning/launcher';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import type { SharpenConversationSettledDto } from '@/lib/dto/sharpen';
import { pendingPlanOfferOf, planOfferStateOf } from '@/lib/planChange/planOffer';
import { requirementPaneOf } from '@/lib/planning/requirementPane';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { createTestUser } from '../../fixtures/userFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import { renderWithIntl, enMessages } from '../../helpers/renderWithIntl';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { foldersService } from '@/lib/services/foldersService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { captureJobEvents, JobTestEngine, type CapturedJobEvent } from '../../helpers/jobs';

// THE COMPOSED REQUIREMENT AS ONE SEAM (Story MOTIR-9430 · MOTIR-9440), on REAL
// Postgres. One requirement travels from the ask envelope to the motir-ai job context
// through every real service and table between: `aiAskService.settle` →
// `planOfferService.land` → the turn row → `planOfferStartService.confirm` →
// `claimOffer` → `submitOn` → `planChangeSessionsService.submit` /
// `restartForPlanOffer` → `aiPlanEditsService` → the captured `submitJob`, and from the
// claim's commit, the page-save job → `requirementPageService.write` → the offer
// (MOTIR-10091). Each card's own suite proves its half; this one proves the halves agree
// on ONE record, byte for byte, and that the exactly-once start and the one page hold.
//
// Mocked: only the motir-ai boundary (`submitJob` captured, `getJob` from a map) and,
// for the one render case, the conversation HOOK and the two canvases the host mounts
// (the same stubs `tests/components/requirement-pane.test.tsx` uses). The job dispatcher
// is CAPTURED and `confirm` hands each captured page request to the job's own handler,
// as a worker would. The page writer, the folder, the claim and every row are real. A
// failed save is a spy on `requirementPageService.write`, and separately an
// unprovisioned Motir account, so both the spy and the real failure route are covered.
//
// ── THE STORY'S CRITERIA, WALKED ──────────────────────────────────────────────────
//   The requirement is stored, served and read back as the envelope sent it ..... § stored
//   Confirm saves ONE page in Requirements Docs, as the Motir account .......... § one page
//   The run gets the requirement + its marker and no carried answers ........... § one page
//   A double confirm / Confirm racing a typed yes writes one page, starts one .... § exactly once
//   Mid-planning, the successor gets the same requirement and marker ........... § restart and resume
//   A start that throws starts once on the retry, with one page ................ § restart and resume
//   A save that fails starts the run anyway, and the rail says so .............. § a save that fails
//   Declined or superseded offers write no page ................................ § offers with no page
//   An offer with no requirement, a targeted offer, "plan this" are unchanged ... § offers with no page
//   The folder is re-used, and a renamed one is not ............................. § the folder
//   A person without page:edit still confirms; members read the page ............ § permissions
//   The pane and the rail draw what this seam serves ............................ § what the person sees
//   The motir-ai half (composing, once-only fold, supplied run) ................. motir-ai MOTIR-9439
//   The browser walk and the acceptance video ................................... MOTIR-9441

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

// ── The render case's stubs: the host's router, workbench re-read, and its two
// canvases, which read their own level over the network. Everything the seam serves
// reaches the REAL host, rail and document. ─────────────────────────────────────────
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/workbench/workbenchReread', () => ({ useRequestWorkbenchReread: () => vi.fn() }));
vi.mock('@/lib/planning/planningAnchorClient', () => ({ fetchPlanningAnchor: vi.fn() }));
vi.mock('@/lib/hooks/useWorkItemTargetSearch', () => ({
  useWorkItemTargetSearch: () => ({ results: [], loading: false, tooShort: true }),
}));
vi.mock('@/components/planning/PlanReviewCanvas', () => ({
  PlanReviewCanvas: () => <div data-testid="review-canvas-stub" />,
}));
vi.mock('@/components/planning/PlanChangeCanvas', () => ({
  PlanChangeCanvas: () => <div data-testid="canvas-stub" />,
}));
const { conversation } = vi.hoisted(() => ({
  conversation: {
    state: null as unknown,
    send: vi.fn(),
    retry: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    requestRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    confirmPlanOffer: vi.fn(),
    declinePlanOffer: vi.fn(),
  },
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => conversation,
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { pagesService } = await import('@/lib/services/pagesService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferService } = await import('@/lib/services/planOfferService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { requirementPageService } = await import('@/lib/services/requirementPageService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { planOfferRequirementPage, REQUIREMENT_PAGE_MAX_ATTEMPTS } =
  await import('@/lib/jobs/definitions/planOfferRequirementPage');
const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');

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
let events: CapturedJobEvent[];
let restoreEvents: (() => void) | undefined;
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
  ran.clear();
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
});

afterEach(async () => {
  restoreEvents?.();
  restoreEvents = undefined;
  cleanup();
  conversation.state = null;
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

async function turn(ask: Record<string, unknown>, sessionId?: string, body = 'Export reports?') {
  const submitted = await aiAskService.submitTurn(body, me(), sessionId ? { sessionId } : {});
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

/** A conversation whose last answer carries a plan offer (no target unless given). */
async function offered(
  opts: {
    requirement?: unknown;
    targetKey?: string;
    sessionId?: string;
    requestText?: string;
    immediate?: boolean;
  } = {},
) {
  const requirement = 'requirement' in opts ? opts.requirement : REQUIREMENT;
  const { jobId, sessionId, settled } = await turn(
    answerWith({
      offer: {
        kind: 'plan',
        requestText: opts.requestText ?? REQUEST,
        ...(opts.targetKey ? { targetKey: opts.targetKey } : {}),
        immediate: opts.immediate ?? false,
        ...(requirement ? { requirement } : {}),
      },
    }),
    opts.sessionId,
  );
  const answer = lastAnswer(settled.session.turns);
  return { jobId, conversationId: sessionId, offerTurnId: answer.id, offerSeq: answer.seq };
}

async function rawOffer(turnId: string) {
  const row = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: turnId } });
  return row.answerOffer as Record<string, unknown> | null;
}

async function served(conversationId: string, offerTurnId: string) {
  const thread = await planChangeSessionsService.getById(me(), conversationId);
  return { thread, offer: thread.turns.find((t) => t.id === offerTurnId)!.offer! };
}

const pageAsks = () => events.filter((e) => e.name === 'plan-offer/requirement-page.requested');
const ran = new Set<string>();

/**
 * Run every page request captured since the last drain through the JOB'S OWN handler,
 * as a worker would — the engine's dedup included: a key already run is not run again.
 */
async function drainPageJobs(opts: { attempt?: number; rerun?: boolean } = {}) {
  const outcomes = [];
  for (const event of pageAsks()) {
    const key = (event.data as { idempotencyKey: string }).idempotencyKey;
    if (ran.has(key) && !opts.rerun) continue;
    ran.add(key);
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

/** Confirm, then let the worker run the page it asked for. */
async function confirm(conversationId: string, offerTurnId: string) {
  const started = await planOfferStartService.confirmPlanOffer(me(), {
    conversationId,
    offerTurnId,
  });
  await drainPageJobs();
  return started;
}

const planCalls = () => submitJobMock.mock.calls.filter((c) => c[0] !== 'ask_project');
const planContext = (n = 0) => planCalls()[n]![2] as Record<string, unknown>;

// The project's own seeded `Bugs` folder is not this story's concern.
const rootFolders = () =>
  adminDb.folder.findMany({
    where: { projectId: fx.projectId, parentFolderId: null, name: { not: 'Bugs' } },
    orderBy: { createdAt: 'asc' },
  });
const pages = () => adminDb.page.findMany({ where: { projectId: fx.projectId } });

describe('stored', () => {
  beforeEach(provisionMotir);

  it(
    'the envelope’s requirement is the turn row’s, the session DTO’s and the pending offer’s',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();

      expect((await rawOffer(offerTurnId))!['requirement']).toEqual(REQUIREMENT);
      const { thread, offer } = await served(conversationId, offerTurnId);
      expect(offer.requirement).toEqual(REQUIREMENT);
      expect(offer.state).toBe('undecided');
      expect(pendingPlanOfferOf(thread.turns)?.offer.requirement).toEqual(REQUIREMENT);
      // An offer alone plans and writes nothing.
      expect(planCalls()).toHaveLength(0);
      expect(await pages()).toHaveLength(0);
      expect(await rootFolders()).toHaveLength(0);
    },
  );
});

describe('one page, one run', () => {
  beforeEach(provisionMotir);

  it(
    'a confirm files ONE page in Requirements Docs as the Motir account and runs on that record',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();

      const started = await confirm(conversationId, offerTurnId);

      const folders = await rootFolders();
      expect(folders).toHaveLength(1);
      expect(folders[0]).toMatchObject({
        name: 'Requirements Docs',
        createdById: await motirSystemUserId(),
      });
      const filed = await pages();
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({
        folderId: folders[0]!.id,
        createdById: await motirSystemUserId(),
      });
      const read = await pagesService.getPageMarkdown(fx.ctx, {
        projectId: fx.projectId,
        pageId: filed[0]!.id,
      });
      for (const heading of [
        'Outcome',
        'Behaviour',
        'Scope edge',
        'Constraints',
        'Acceptance',
        'Assumptions',
      ]) {
        expect(read.markdown).toContain(`## ${heading}`);
      }
      expect(read.markdown).toContain(REQUIREMENT.outcome);
      expect(read.markdown).toContain(REQUIREMENT.acceptance);
      expect(read.markdown).toContain('Comma separated, UTF-8.');
      expect(read.markdown).toContain(
        `Composed by Motir AI in the conversation "${conversationId}"`,
      );

      const recorded = { pageId: filed[0]!.id, title: filed[0]!.title };
      expect(await rawOffer(offerTurnId)).toMatchObject({
        requirementPage: recorded,
        confirmedSessionId: started.sessionId,
        start: { jobId: started.jobId, planId: started.planId },
      });
      expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirementPageFailed');
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(planContext()).not.toHaveProperty('requirementPage');
      expect(planContext()).not.toHaveProperty('carriedAnswers');
    },
  );

  it('after a Grill me the answers are inside the requirement, never sent again', T, async () => {
    settledSpy.mockResolvedValue(SETTLED);
    const { conversationId, offerTurnId } = await offered();

    await confirm(conversationId, offerTurnId);

    expect(planContext()['requirement']).toEqual(REQUIREMENT);
    expect(planContext()).not.toHaveProperty('carriedAnswers');
  });
});

describe('exactly once', () => {
  beforeEach(provisionMotir);

  it('two concurrent confirms write one page, start one run, and agree on it', T, async () => {
    const { conversationId, offerTurnId } = await offered();

    const [a, b] = await Promise.all([
      confirm(conversationId, offerTurnId),
      confirm(conversationId, offerTurnId),
    ]);

    expect(b.sessionId).toBe(a.sessionId);
    expect(b.jobId).toBe(a.jobId);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await pages()).toHaveLength(1);
    expect(planCalls()).toHaveLength(1);
    expect(await adminDb.plan.count()).toBe(1);
  });

  it('a Confirm racing a typed yes writes one page and starts one run', T, async () => {
    const { conversationId, offerTurnId, offerSeq } = await offered();
    const yes = await aiAskService.submitTurn('Yes, go ahead.', me(), {
      sessionId: conversationId,
    });
    if (!('jobId' in yes) || !yes.jobId) throw new Error('not an ask');
    const yesJob = yes.jobId;
    jobs.set(yesJob, {
      jobId: yesJob,
      status: 'succeeded',
      result: {
        ask: answerWith({
          answer: 'Starting the plan.',
          offerReply: { seq: offerSeq, kind: 'plan', decision: 'agree' },
        }),
      },
      error: null,
    });

    const [pressed] = await Promise.all([
      confirm(conversationId, offerTurnId),
      aiAskService.settle(yesJob, me(), { sessionId: conversationId }),
    ]);
    await drainPageJobs();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(await pages()).toHaveLength(1);
    expect(planCalls()).toHaveLength(1);
    const plans = await adminDb.plan.findMany();
    expect(plans.map((p) => p.id)).toEqual([pressed.planId]);
    expect((await rawOffer(offerTurnId))!['confirmedSessionId']).toBe(pressed.sessionId);
  });
});

describe('restart and resume', () => {
  beforeEach(provisionMotir);

  it(
    'on a conversation holding an undecided plan, the successor runs on the same requirement and marker',
    T,
    async () => {
      settledSpy.mockResolvedValue(SETTLED);
      const { conversationId, offerTurnId } = await offered();
      await planChangeSessionsService.submit(me(), { sessionId: conversationId });
      expect(planCalls()).toHaveLength(1);

      const started = await confirm(conversationId, offerTurnId);

      expect(started.sessionId).not.toBe(conversationId);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const filed = await pages();
      expect(filed).toHaveLength(1);
      expect(planCalls()).toHaveLength(2);
      expect(planContext(1)['requirement']).toEqual(REQUIREMENT);
      expect(planContext(1)['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(planContext(1)).not.toHaveProperty('carriedAnswers');
      // The original conversation is ended once, as restarted.
      expect(await adminDb.planChangeSession.count({ where: { endReason: 'restarted' } })).toBe(1);
      expect(
        (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }))
          .endReason,
      ).toBe('restarted');
    },
  );

  it(
    'a restart whose successor submit throws resumes on the retry, with one page saved',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      await planChangeSessionsService.submit(me(), { sessionId: conversationId });
      submitJobMock.mockImplementationOnce(async () => {
        throw new MotirAiOutOfCreditsError('no credits left');
      });
      await expect(confirm(conversationId, offerTurnId)).rejects.toBeInstanceOf(
        MotirAiOutOfCreditsError,
      );
      // The claim committed and asked for the page before the submit threw.
      expect(pageAsks()).toHaveLength(1);
      expect(writeSpy).not.toHaveBeenCalled();

      const started = await confirm(conversationId, offerTurnId);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const filed = await pages();
      expect(filed).toHaveLength(1);
      expect(await adminDb.plan.count({ where: { sessionId: started.sessionId } })).toBe(1);
      expect((await rawOffer(offerTurnId))!['requirementPage']).toEqual({
        pageId: filed[0]!.id,
        title: filed[0]!.title,
      });
      const last = planContext(planCalls().length - 1);
      expect(last['requirement']).toEqual(REQUIREMENT);
      expect(last['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(last).not.toHaveProperty('carriedAnswers');
    },
  );

  it(
    'a plain start that is refused for credits records it as shipped; the next confirm saves one page',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      submitJobMock.mockImplementationOnce(async () => {
        throw new MotirAiOutOfCreditsError('no credits left');
      });
      await expect(confirm(conversationId, offerTurnId)).rejects.toBeInstanceOf(
        MotirAiOutOfCreditsError,
      );
      const { offer } = await served(conversationId, offerTurnId);
      expect(offer.cannotStart).toBe('out_of_credits');
      expect(offer.state).toBe('undecided');

      await confirm(conversationId, offerTurnId);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(await pages()).toHaveLength(1);
      expect(planContext(planCalls().length - 1)['requirementConfirmed']).toEqual({
        conversationId,
        offerTurnId,
      });
      expect(await adminDb.plan.count()).toBe(1);
    },
  );
});

describe('a save that fails', () => {
  beforeEach(provisionMotir);

  it(
    'starts the one run anyway; the final attempt marks the offer, which stays confirmed',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockRejectedValue(new Error('folder refused'));

      const started = await confirm(conversationId, offerTurnId);
      for (let attempt = 1; attempt < REQUIREMENT_PAGE_MAX_ATTEMPTS; attempt += 1) {
        const [outcome] = await drainPageJobs({ attempt, rerun: true });
        expect(outcome!.error?.message).toBe('folder refused');
      }

      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
      expect(await adminDb.plan.count()).toBe(1);
      expect(await pages()).toHaveLength(0);
      expect(await rawOffer(offerTurnId)).toMatchObject({
        confirmedSessionId: started.sessionId,
        requirementPageFailed: true,
      });
      const { thread, offer } = await served(conversationId, offerTurnId);
      expect(offer.requirementPageFailed).toBe(true);
      expect(offer.cannotStart).toBeNull();
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('confirmed');
    },
  );
});

describe('a recorded page that does not read as one', () => {
  beforeEach(provisionMotir);

  it('is ignored: the confirm writes a fresh page and records that one', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    const stored = (await rawOffer(offerTurnId))!;
    await adminDb.planChangeTurn.update({
      where: { id: offerTurnId },
      data: { answerOffer: { ...stored, requirementPage: { pageId: '', title: 'Stale' } } },
    });

    await confirm(conversationId, offerTurnId);

    const filed = await pages();
    expect(filed).toHaveLength(1);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect((await rawOffer(offerTurnId))!['requirementPage']).toEqual({
      pageId: filed[0]!.id,
      title: filed[0]!.title,
    });
    expect(planCalls()).toHaveLength(1);
  });
});

describe('an unprovisioned Motir account', () => {
  it(
    'is the same failure, before any folder or page is written, and the run starts; provisioning lets a retry save it',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();

      await confirm(conversationId, offerTurnId);
      const [failed] = await drainPageJobs({
        attempt: REQUIREMENT_PAGE_MAX_ATTEMPTS - 1,
        rerun: true,
      });

      expect(failed!.error).toBeInstanceOf(SystemPrincipalNotProvisionedError);
      expect(await rootFolders()).toHaveLength(0);
      expect(await pages()).toHaveLength(0);
      expect(planCalls()).toHaveLength(1);
      const { thread, offer } = await served(conversationId, offerTurnId);
      expect(offer.requirementPageFailed).toBe(true);
      expect(planOfferStateOf(thread.turns, offerTurnId)).toBe('confirmed');

      await provisionMotir();
      // A replayed dead letter runs the same job again.
      await drainPageJobs({ rerun: true });

      expect(await pages()).toHaveLength(1);
      expect(await rootFolders()).toHaveLength(1);
      expect(planCalls()).toHaveLength(1);
      const after = await rawOffer(offerTurnId);
      expect(after).toHaveProperty('requirementPage');
      expect(after).not.toHaveProperty('requirementPageFailed');
    },
  );
});

describe('offers with no page', () => {
  beforeEach(provisionMotir);

  it('a declined offer writes no folder and no page', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    await planOfferService.declinePlanOffer(offerTurnId, me(), { sessionId: conversationId });

    expect(writeSpy).not.toHaveBeenCalled();
    expect(await rootFolders()).toHaveLength(0);
    expect(await pages()).toHaveLength(0);
    expect(pendingPlanOfferOf((await served(conversationId, offerTurnId)).thread.turns)).toBeNull();
  });

  it(
    'a superseded offer writes none, and the newer requirement is the pending one',
    T,
    async () => {
      const older = await offered();
      const newer = { ...REQUIREMENT, outcome: 'Managers export a weekly report.' };
      const second = await offered({ requirement: newer, sessionId: older.conversationId });

      const thread = (await served(second.conversationId, second.offerTurnId)).thread;
      expect(pendingPlanOfferOf(thread.turns)?.turnId).toBe(second.offerTurnId);
      expect(pendingPlanOfferOf(thread.turns)?.offer.requirement).toEqual(newer);
      expect(planOfferStateOf(thread.turns, older.offerTurnId)).toBe('superseded');
      expect(await rootFolders()).toHaveLength(0);
      expect(await pages()).toHaveLength(0);
      expect(writeSpy).not.toHaveBeenCalled();
    },
  );

  it('an offer stored with no requirement starts as it always did', T, async () => {
    settledSpy.mockResolvedValue(SETTLED);
    const { conversationId, offerTurnId } = await offered({ requirement: undefined });
    expect(await rawOffer(offerTurnId)).not.toHaveProperty('requirement');

    await confirm(conversationId, offerTurnId);

    expect(writeSpy).not.toHaveBeenCalled();
    expect(await rootFolders()).toHaveLength(0);
    expect(await pages()).toHaveLength(0);
    expect(planCalls()).toHaveLength(1);
    expect(planContext()).not.toHaveProperty('requirement');
    expect(planContext()).not.toHaveProperty('requirementConfirmed');
    expect(pageAsks()).toHaveLength(0);
    const stored = await rawOffer(offerTurnId);
    expect(stored).not.toHaveProperty('requirementPage');
    expect(stored).not.toHaveProperty('requirementPageFailed');
  });

  it(
    '"plan this" never writes or sends a requirement, even when the envelope carried one',
    T,
    async () => {
      const target = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'CSV export' },
        fx.ctx,
      );
      // "Plan this" starts at settle: no pane, no Confirm, so nothing the person read.
      const planThis = await turn(
        answerWith({
          offer: {
            kind: 'plan',
            requestText: REQUEST,
            targetKey: target.identifier,
            immediate: true,
            requirement: REQUIREMENT,
          },
        }),
        undefined,
        'Plan this card.',
      );
      expect(planThis.settled.outcome).toBe('redirected');

      expect(writeSpy).not.toHaveBeenCalled();
      expect(await rootFolders()).toHaveLength(0);
      expect(await pages()).toHaveLength(0);
      expect(planCalls().length).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < planCalls().length; i++) {
        expect(planContext(i)).not.toHaveProperty('requirement');
        expect(planContext(i)).not.toHaveProperty('requirementConfirmed');
      }
      expect(pageAsks()).toHaveLength(0);
    },
  );
});

// MOTIR-9878: a targeted offer's requirement is the planner's too. It is stored on the
// offer, shown in the pane, sent as `context.requirement` with its confirmation marker on
// the target's run, and saved as ONE Requirements Docs page after the start.
describe('a targeted offer with a requirement', () => {
  beforeEach(provisionMotir);

  it('stores it, and Confirm sends requirement + marker and saves one page', T, async () => {
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Reports' },
      fx.ctx,
    );
    const { conversationId, offerTurnId } = await offered({ targetKey: target.identifier });
    expect(await rawOffer(offerTurnId)).toMatchObject({ requirement: REQUIREMENT });

    await confirm(conversationId, offerTurnId);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const saved = await pages();
    expect(saved).toHaveLength(1);
    expect(planCalls()).toHaveLength(1);
    expect(planContext()['requirement']).toEqual(REQUIREMENT);
    expect(planContext()['requirementConfirmed']).toEqual({ conversationId, offerTurnId });
    expect(await rawOffer(offerTurnId)).toMatchObject({
      requirementPage: { pageId: saved[0]!.id },
    });
  });
});

describe('the Confirm entrance', () => {
  beforeEach(provisionMotir);

  it(
    'confirmOffer on a no-target plan offer saves the page and starts the one run',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();

      const result = await planOfferStartService.confirmOffer(me(), {
        conversationId,
        offerTurnId,
      });
      await drainPageJobs();

      expect(result.kind).toBe('plan');
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(await pages()).toHaveLength(1);
      expect(planCalls()).toHaveLength(1);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
    },
  );

  it(
    'a conversation that is not the caller’s reads as a missing offer and writes nothing',
    T,
    async () => {
      const { offerTurnId } = await offered();

      await expect(
        planOfferStartService.confirmOffer(me(), { conversationId: 'no-such', offerTurnId }),
      ).rejects.toThrow();

      expect(writeSpy).not.toHaveBeenCalled();
      expect(await pages()).toHaveLength(0);
      expect(planCalls()).toHaveLength(0);
    },
  );
});

describe('the folder', () => {
  beforeEach(provisionMotir);

  it('a second offer in another conversation re-uses the one root folder', T, async () => {
    const first = await offered();
    await confirm(first.conversationId, first.offerTurnId);
    const second = await offered({ requestText: 'Plan the PDF export.' });
    await confirm(second.conversationId, second.offerTurnId);

    const folders = await rootFolders();
    expect(folders.map((f) => f.name)).toEqual(['Requirements Docs']);
    expect(await adminDb.page.count({ where: { folderId: folders[0]!.id } })).toBe(2);
  });

  it('a renamed folder is left alone and a new root-level one is made', T, async () => {
    const first = await offered();
    await confirm(first.conversationId, first.offerTurnId);
    const [folder] = await rootFolders();
    await foldersService.renameFolder(
      { projectId: fx.projectId, folderId: folder!.id, name: 'Specs' },
      fx.ctx,
    );
    const second = await offered({ requestText: 'Plan the PDF export.' });
    await confirm(second.conversationId, second.offerTurnId);

    const folders = await rootFolders();
    expect(folders.map((f) => f.name).sort()).toEqual(['Requirements Docs', 'Specs']);
    const renamed = folders.find((f) => f.name === 'Specs')!;
    expect(renamed.id).toBe(folder!.id);
    expect(await adminDb.page.count({ where: { folderId: renamed.id } })).toBe(1);
    const fresh = folders.find((f) => f.name === 'Requirements Docs')!;
    expect(await adminDb.page.count({ where: { folderId: fresh.id } })).toBe(1);
  });
});

describe('permissions', () => {
  beforeEach(provisionMotir);

  async function member(permissions: string[]): Promise<ProjectContext> {
    const u = await createTestUser({ name: `Member ${permissions.join(',')}` });
    await adminDb.workspaceMembership.create({
      data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await addToProjectAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: u.id,
      role: 'member',
    });
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: `Role ${u.id}`,
      permissions,
    });
    await setProjectRoleAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: u.id,
      role: role.id,
    });
    return {
      userId: u.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
  }

  it(
    'a person without page:edit confirms, the system account writes, and a browser reads it',
    T,
    async () => {
      const planner = await member(['project:browse', 'work_item:edit', 'ai:plan']);
      const reader = await member(['project:browse', 'page:view']);
      const submitted = await aiAskService.submitTurn('Export reports?', planner);
      if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
      jobs.set(submitted.jobId, {
        jobId: submitted.jobId,
        status: 'succeeded',
        result: {
          ask: answerWith({
            offer: {
              kind: 'plan',
              requestText: REQUEST,
              immediate: false,
              requirement: REQUIREMENT,
            },
          }),
        },
        error: null,
      });
      const settled = await aiAskService.settle(submitted.jobId, planner, {
        sessionId: submitted.session.id,
      });
      const offerTurnId = lastAnswer(settled.session.turns).id;

      await planOfferStartService.confirmPlanOffer(planner, {
        conversationId: submitted.session.id,
        offerTurnId,
      });
      // The job runs as the person who confirmed: their conversation, the system's page.
      await drainPageJobs();

      const filed = await pages();
      expect(filed).toHaveLength(1);
      expect(filed[0]!.createdById).toBe(await motirSystemUserId());
      expect(filed[0]!.createdById).not.toBe(planner.userId);
      const read = await pagesService.getPageMarkdown(reader, {
        projectId: fx.projectId,
        pageId: filed[0]!.id,
      });
      expect(read.markdown).toContain(REQUIREMENT.outcome);
      expect(planContext()['requirement']).toEqual(REQUIREMENT);
    },
  );
});

describe('what the person sees', () => {
  beforeEach(provisionMotir);

  const IDLE: Omit<PlanChangeConversationState, 'session'> = {
    phase: 'idle',
    progress: null,
    review: null,
    liveReview: null,
    liveVersion: 0,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: null,
    planId: null,
    approved: null,
    errorCode: null,
    outOfCredits: false,
    stopping: false,
    stopped: false,
    queued: [],
    earlier: null,
    reopened: null,
    readOnly: false,
    acts: [],
  };

  function renderHost(state: PlanChangeConversationState) {
    conversation.state = state;
    return renderWithIntl(
      <PlanningWorkspaceHost
        projectKey="ACME"
        projectName="Acme"
        launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
        anchorId={null}
        onClose={() => {}}
        initialTarget={null}
        canManage={false}
      />,
    );
  }

  const region = () =>
    screen.queryByRole('region', { name: enMessages.planningWorkspace.requirementPane.label });

  it(
    'the pending offer fills the pane with the document, and the rail keeps Confirm',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      const { thread } = await served(conversationId, offerTurnId);
      expect(requirementPaneOf(thread.turns)?.requirement).toEqual(REQUIREMENT);

      renderHost({ ...IDLE, session: thread });

      const pane = region()!;
      expect(pane).toBeTruthy();
      expect(pane.textContent).toContain(REQUIREMENT.outcome);
      expect(pane.textContent).toContain(REQUIREMENT.acceptance);
      expect(within(pane).getAllByTestId('requirement-assumption')).toHaveLength(1);
      expect(screen.getByTestId('plan-offer-confirm')).toBeTruthy();
    },
  );

  it('after a confirm the pane is gone and the rail links the saved page', T, async () => {
    const { conversationId, offerTurnId } = await offered();
    await confirm(conversationId, offerTurnId);
    const { thread } = await served(conversationId, offerTurnId);
    const [page] = await pages();

    renderHost({ ...IDLE, session: thread });

    expect(region()).toBeNull();
    const line = screen.getByTestId('plan-offer-requirement-page');
    expect(within(line).getByRole('link').getAttribute('href')).toBe(`/pages/${page!.id}`);
    expect(within(line).getByRole('link').textContent).toBe(page!.title);
    expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
  });

  it(
    'after a save that failed every attempt the rail says so, with no Confirm and no pane',
    T,
    async () => {
      const { conversationId, offerTurnId } = await offered();
      writeSpy.mockRejectedValue(new Error('folder refused'));
      await planOfferStartService.confirmPlanOffer(me(), { conversationId, offerTurnId });
      await drainPageJobs({ attempt: REQUIREMENT_PAGE_MAX_ATTEMPTS - 1 });
      const { thread } = await served(conversationId, offerTurnId);

      renderHost({ ...IDLE, session: thread });

      const line = screen.getByTestId('plan-offer-requirement-page-not-saved');
      expect(screen.getByTestId('plan-offer-confirmed').contains(line)).toBe(true);
      expect(screen.queryByTestId('plan-offer-requirement-page')).toBeNull();
      expect(screen.queryByTestId('plan-offer-confirm')).toBeNull();
      // The offer is confirmed, so the document has left the pane.
      expect(region()).toBeNull();
    },
  );
});
