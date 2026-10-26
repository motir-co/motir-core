// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { db } from '@/lib/db';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import { renderWithIntl } from '../../helpers/renderWithIntl';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  accepted,
  cleared,
  gate,
  hostedStep,
  openWalk,
  rateLimitedJob,
  resetGate,
  resumeAsOwner,
  reviewRead,
  sessionRead,
  waiting,
  type Routes,
  type Walk,
} from './providerLimitStoryGate.fixture';

// THE PROVIDER-LIMIT STORY GATE — section C, the host (Story MOTIR-9540 · Subtask MOTIR-9624).
//
// Sections A and B (`providerLimitStoryGate.test.ts`) prove the server half. This file renders
// the REAL `PlanWorkspaceHost` and the REAL `PlanChangeRail` from what those same doors answer —
// the plan snapshot `GET /api/plans/[id]` serves and the session DTO `GET
// /api/ai/plan-change/session` serves, read here from a real database, never hand-built — so the
// gate proves the server's shapes and the components agree: the retrying banner while a wait is
// stored, gone when it clears, and the stopped wording on the failed walk (failure winning over a
// wait still on the row) with exactly one Resume, gone once Resume has run.
//
// Mocked, beyond the request boundary the shared driver mocks: `next/navigation` (no router in
// a DOM render), the browser's `fetch` for the host's own side reads, and
// `usePlanChangeConversation`, which is replaced by the server's DTOs so the host renders exactly
// what the overlay's hook would hold after its reads.

// The request boundary, answered from the fixture's `gate` at CALL time (see its header).
const pl = vi.hoisted(() => ({
  gate: () =>
    (
      globalThis as unknown as {
        __providerLimitGate: typeof import('./providerLimitStoryGate.fixture').gate;
      }
    ).__providerLimitGate,
}));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  getSession: async () => (pl.gate().user ? { user: pl.gate().user } : null),
}));
vi.mock('@/lib/workspaces', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    pl.gate().user && pl.gate().workspaceId
      ? { userId: pl.gate().user!.id, workspaceId: pl.gate().workspaceId! }
      : null,
}));
vi.mock('@/lib/projects', async (orig) => ({
  ...(await orig<typeof import('@/lib/projects')>()),
  getActiveProject: async () => pl.gate().project,
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => pl.gate().submitJob(...args),
  getJob: async (jobId: string) => {
    const job = pl.gate().jobs.get(jobId);
    if (!job) throw new Error(`no stubbed job ${jobId}`);
    return job;
  },
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

vi.mock('next/navigation', () => ({
  usePathname: () => '/workbench',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/navigation/shallowUrl', () => ({ shallowPush: vi.fn(), shallowReplace: vi.fn() }));

const hook = vi.hoisted(() => ({
  state: null as unknown as PlanChangeConversationState,
  resume: vi.fn(),
}));
vi.mock('@/lib/hooks/usePlanChangeConversation', () => ({
  usePlanChangeConversation: () => ({
    state: hook.state,
    send: vi.fn(),
    retry: vi.fn(),
    correctTurn: vi.fn(),
    approve: vi.fn(),
    discard: vi.fn(),
    dismissError: vi.fn(),
    stop: vi.fn(),
    startCopied: vi.fn(),
    requestRestart: vi.fn(),
    answerRestartConfirm: vi.fn(),
    confirmPlanOffer: vi.fn(),
    declinePlanOffer: vi.fn(),
    planAgain: vi.fn(),
    resume: hook.resume,
    answerRunPause: vi.fn(),
    showEarlierNarration: vi.fn(),
  }),
}));

const { POST: stepPOST } = await import('@/app/api/internal/ai/plan-step/route');
const { GET: planGET } = await import('@/app/api/plans/[id]/route');
const { GET: sessionGET } = await import('@/app/api/ai/plan-change/session/route');
const { POST: resumePOST } = await import('@/app/api/ai/plan-change/session/resume/route');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionEndService } = await import('@/lib/services/planSessionEndService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { PlanningWorkspaceHost } = await import('@/components/planning/PlanningWorkspaceHost');
const { parsePlanningLaunch } = await import('@/lib/planning/launcher');

const routes: Routes = { stepPOST, planGET, sessionGET, resumePOST };
const T = { timeout: 120_000 };
const tl = en.planningWorkspace.providerLimit;
const zl = zh.planningWorkspace.providerLimit;
const NEW_KEYS_EN = Object.values(tl);

beforeEach(async () => {
  // The rendered host's own side reads (History, the grill opt-in…) have no server here; they
  // answer an empty 404 instead of dialling localhost. No assertion reads them.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
  resetGate();
  hook.resume.mockReset();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const walkServices = {
  startWithFirstTurn: planChangeSessionsService.startWithFirstTurn.bind(planChangeSessionsService),
  createCard: (fx: Walk['fx']) =>
    workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The export story' },
      fx.ctx,
    ),
};

async function walkHoldingAStep(): Promise<Walk> {
  const walk = await openWalk(walkServices);
  await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', step: 'author' }));
  return walk;
}

const reportWait = (walk: Walk) =>
  accepted(
    hostedStep(routes, walk, {
      sessionKey: 'author-1',
      ...waiting(1, 3, new Date(Date.now() + 5_000)),
    }),
  );

/** What the overlay's hook holds after its two reads: the session row and the live plan. */
function stateFrom(
  session: PlanChangeSessionDto,
  review: PlanReviewDto,
): PlanChangeConversationState {
  return {
    phase: 'streaming',
    session,
    progress: null,
    review: null,
    liveReview: review,
    liveVersion: 1,
    liveFailing: false,
    discardedReview: null,
    decided: null,
    jobId: session.lastJobId,
    planId: review.id,
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
  } as unknown as PlanChangeConversationState;
}

async function readOverlay(walk: Walk): Promise<PlanChangeConversationState> {
  const review = await reviewRead(routes, walk);
  const session = await sessionRead(routes, walk);
  return stateFrom(session, review);
}

function host(locale: 'en' | 'zh' = 'en') {
  return (
    <PlanningWorkspaceHost
      projectKey={'PLG'}
      projectName="Acme"
      launch={parsePlanningLaunch({ mode: 'replan', from: 'project' })}
      anchorId={null}
      onClose={vi.fn()}
      key={locale}
    />
  );
}

const renderHost = (locale: 'en' | 'zh' = 'en') =>
  renderWithIntl(host(locale), { locale, messages: locale === 'zh' ? zh : en });

const settleFailed = (walk: Walk) =>
  planSessionEndService.settleFailedJob(
    walk.jobId,
    { userId: walk.fx.ownerId, workspaceId: walk.fx.workspaceId, projectId: walk.fx.projectId },
    { status: 'failed' },
  );

/** A walk whose every retry was refused: the failure recorded, the wait still on the step row. */
async function exhausted(): Promise<Walk> {
  const walk = await walkHoldingAStep();
  await reportWait(walk);
  gate.jobs.set(walk.jobId, rateLimitedJob(walk.planId));
  expect(await settleFailed(walk)).toMatchObject({ settled: 'recorded' });
  return walk;
}

describe('C. the host and rail, rendered from the server’s answers', () => {
  it(
    'C1 — a mid-retry open: the retrying banner on first paint, role=status, and no stopped wording',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      await reportWait(walk);
      hook.state = await readOverlay(walk);
      expect(hook.state.liveReview?.progress?.steps[0]?.providerWait).not.toBeNull();

      renderHost();

      const banner = screen.getByTestId('provider-limit-retrying');
      expect(banner.getAttribute('role')).toBe('status');
      expect(banner.textContent).toBe(`${tl.retryingTitle}${tl.retryingBody}`);
      expect(screen.queryByTestId('provider-limit-because')).toBeNull();
      expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
    },
  );

  it('C2 — the next snapshot carries no wait: the banner is gone', T, async () => {
    const walk = await walkHoldingAStep();
    await reportWait(walk);
    hook.state = await readOverlay(walk);
    const { rerender } = renderHost();
    expect(screen.getByTestId('provider-limit-retrying')).toBeTruthy();

    await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', ...cleared }));
    hook.state = await readOverlay(walk);
    expect(hook.state.liveReview?.progress?.steps[0]?.providerWait).toBeNull();
    // The plan is still being written: the poll keeps a live step.
    expect(hook.state.liveReview?.progress?.steps).toHaveLength(1);
    rerender(host());

    expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
    expect(screen.queryByRole('status', { name: tl.retryingTitle })).toBeNull();
  });

  it(
    'C3 — exhausted while a wait is still on the row: only the stopped wording, on the failed walk with ONE Resume',
    T,
    async () => {
      const walk = await exhausted();
      hook.state = await readOverlay(walk);
      expect(hook.state.session?.failure?.reason).toBe('rate_limited');
      expect(hook.state.liveReview?.progress?.steps[0]?.providerWait).not.toBeNull();

      renderHost();

      expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
      const face = screen.getByTestId('planning-failed-waiting');
      expect(within(face).getByTestId('provider-limit-because').textContent).toBe(tl.walkBecause);
      expect(within(face).getByTestId('provider-limit-kept').textContent).toBe(tl.walkKept);
      expect(screen.getAllByTestId('planning-resume')).toHaveLength(1);
    },
  );

  it(
    'C4 — Resume pressed, and the session no longer failed: the stopped wording is gone, never a second Resume',
    T,
    async () => {
      const walk = await exhausted();
      hook.state = await readOverlay(walk);
      const { rerender } = renderHost();

      hook.resume.mockImplementation(async () => {
        const res = await resumeAsOwner(routes, walk);
        expect(res.status).toBe(200);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('planning-resume'));
      });
      expect(hook.resume).toHaveBeenCalledTimes(1);
      // The resume call does not wait on the hook; settle the server's answer before re-reading.
      await vi.waitFor(async () => {
        const row = await adminDb.planChangeSession.findUniqueOrThrow({
          where: { id: walk.sessionId },
        });
        expect(row.failedAt).toBeNull();
      });

      hook.state = await readOverlay(walk);
      expect(hook.state.session?.failure ?? null).toBeNull();
      rerender(host());

      expect(screen.queryByTestId('planning-failed-waiting')).toBeNull();
      expect(screen.queryByTestId('provider-limit-because')).toBeNull();
      expect(screen.queryAllByTestId('planning-resume')).toHaveLength(0);
    },
  );

  it(
    'C5 — zh: the banner and the stopped wording read the zh strings, no English from the new keys',
    T,
    async () => {
      const waitingWalk = await walkHoldingAStep();
      await reportWait(waitingWalk);
      hook.state = await readOverlay(waitingWalk);
      renderHost('zh');
      const banner = screen.getByTestId('provider-limit-retrying');
      expect(banner.textContent).toBe(`${zl.retryingTitle}${zl.retryingBody}`);
      for (const text of NEW_KEYS_EN) expect(document.body.textContent).not.toContain(text);
      cleanup();

      await adminDb.$executeRawUnsafe(
        'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
      );
      await truncateAuthTables();
      const stopped = await exhausted();
      hook.state = await readOverlay(stopped);
      renderHost('zh');
      const face = screen.getByTestId('planning-failed-waiting');
      expect(within(face).getByTestId('provider-limit-because').textContent).toBe(zl.walkBecause);
      expect(within(face).getByTestId('provider-limit-kept').textContent).toBe(zl.walkKept);
      for (const text of NEW_KEYS_EN) expect(document.body.textContent).not.toContain(text);
      expect(screen.getAllByTestId('planning-resume')).toHaveLength(1);
    },
  );

  it(
    'C6 — a session failed `internal`, with no wait: the shipped face, no provider-limit element',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      gate.jobs.set(walk.jobId, {
        ...rateLimitedJob(walk.planId),
        error: { code: 'internal', message: 'Something broke.' },
        walkStop: { ...rateLimitedJob(walk.planId).walkStop, reasonCode: 'internal' },
      });
      await settleFailed(walk);
      hook.state = await readOverlay(walk);
      expect(hook.state.session?.failure?.reason).toBe('internal');

      renderHost();

      const face = screen.getByTestId('planning-failed-waiting');
      expect(screen.queryByTestId('provider-limit-retrying')).toBeNull();
      expect(within(face).queryByTestId('provider-limit-because')).toBeNull();
      expect(within(face).getByText(en.planningWorkspace.waiting.kept)).toBeTruthy();
      expect(screen.getAllByTestId('planning-resume')).toHaveLength(1);
    },
  );
});
