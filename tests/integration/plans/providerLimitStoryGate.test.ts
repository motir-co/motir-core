import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  PLAN_PROVIDER_WAIT_GRACE_MS,
  readPlanProgress,
  type PlanProgressSnapshot,
} from '@/lib/plans/planProgress';
import type { PlanStepProviderWaitDto } from '@/lib/dto/plans';
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
  toResumeEntries,
  waiting,
  type Routes,
  type Walk,
} from './providerLimitStoryGate.fixture';

// THE PROVIDER-LIMIT STORY GATE, motir-core's half — sections A and B (Story MOTIR-9540 ·
// Subtask MOTIR-9624).
//
// Each sibling proved its own layer: the step report stores and exposes a provider-retry wait
// (MOTIR-9619), the overlay draws the banner from a reading and the stopped wording from a
// failure (MOTIR-9622). What neither can see is the ASSEMBLED path, and the seams are where
// this story can ship a defect that every card's own suite passes:
//
//   A. a wait reported through the hosted door is stored, comes back on the overlay's one poll
//      (`GET /api/plans/[id]`) and in the reading derived from it, and clears — by `cleared`, by
//      the session's next step and by its end, but not by narration — and a dead job's wait
//      drops out of the reading after the grace;
//   B. the session's failed end with reason `rate_limited`, through the relays' settle, lands in
//      To resume as that reason and no other, the owner's Resume continues the SAME session and
//      plan and clears it, and a second refusal records it again.
//
// Section C (`providerLimitStoryGate.host.test.tsx`) renders the real host and rail from what
// these same doors answer. The shared driver, and what is mocked, is the fixture's header.

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

const { POST: stepPOST } = await import('@/app/api/internal/ai/plan-step/route');
const { GET: planGET } = await import('@/app/api/plans/[id]/route');
const { GET: sessionGET } = await import('@/app/api/ai/plan-change/session/route');
const { POST: resumePOST } = await import('@/app/api/ai/plan-change/session/resume/route');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionEndService } = await import('@/lib/services/planSessionEndService');
const { homeService } = await import('@/lib/services/homeService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const routes: Routes = { stepPOST, planGET, sessionGET, resumePOST };
const T = { timeout: 120_000 };

beforeEach(async () => {
  resetGate();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "plan_step", "plan_revision", "plan_item", "plan", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
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

/** The session's hosted walk, holding an `author` step on its session key. */
async function walkHoldingAStep(): Promise<Walk> {
  const walk = await openWalk(walkServices);
  await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', step: 'author' }));
  return walk;
}

const readAtObserved = (s: PlanProgressSnapshot) => readPlanProgress(s, Date.parse(s.observedAt));

async function progressOf(walk: Walk): Promise<PlanProgressSnapshot> {
  const review = await reviewRead(routes, walk);
  expect(review.progress, 'a generating plan carries progress').toBeTruthy();
  return review.progress!;
}

/** Push the plan's activity into the past, so a report that stamps it visibly moves it. */
async function backdateActivity(walk: Walk, byMs = 60_000): Promise<Date> {
  const at = new Date(Date.now() - byMs);
  await adminDb.plan.update({ where: { id: walk.planId }, data: { lastActivityAt: at } });
  return at;
}

const settleFailed = (walk: Walk, jobId: string) =>
  planSessionEndService.settleFailedJob(
    jobId,
    { userId: walk.fx.ownerId, workspaceId: walk.fx.workspaceId, projectId: walk.fx.projectId },
    { status: 'failed' },
  );

// ─────────────────────────────────────────────────────────────────────────────
describe('A. the stored wait, through the hosted door and the overlay’s poll', () => {
  it(
    'A1 — a waiting report is stored on the step and comes back on the poll and in the reading, the step itself untouched',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      const before = (await progressOf(walk)).steps;
      expect(before).toHaveLength(1);
      expect(before[0]!.providerWait).toBeNull();

      const retryAt = new Date(Date.now() + 5_000);
      const answer = (await accepted(
        hostedStep(routes, walk, { sessionKey: 'author-1', ...waiting(1, 2, retryAt) }),
      )) as { planId: string; providerWait: PlanStepProviderWaitDto | null };
      expect(answer.planId).toBe(walk.planId);

      const snapshot = await progressOf(walk);
      expect(snapshot.steps).toHaveLength(1);
      const step = snapshot.steps[0]!;
      expect(step.providerWait).toMatchObject({ attempt: 1, maxAttempts: 2 });
      expect(Date.parse(step.providerWait!.retryAt)).toBe(retryAt.getTime());
      expect(Number.isNaN(Date.parse(step.providerWait!.since))).toBe(false);
      expect(answer.providerWait).toEqual(step.providerWait);
      // The step is the walk's, not the wait's: kind, target and start are as they were.
      expect(step.kind).toBe(before[0]!.kind);
      expect(step.targetRef).toBe(before[0]!.targetRef);
      expect(step.startedAt).toBe(before[0]!.startedAt);

      expect(readAtObserved(snapshot).providerWait).toEqual(step.providerWait);
    },
  );

  it(
    'A2 — a cleared report nulls the wait on the step and the reading, and both reports move the plan’s activity',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      const t0 = await backdateActivity(walk);
      await accepted(
        hostedStep(routes, walk, {
          sessionKey: 'author-1',
          ...waiting(1, 2, new Date(Date.now() + 5_000)),
        }),
      );
      const waited = await progressOf(walk);
      expect(Date.parse(waited.lastActivityAt)).toBeGreaterThan(t0.getTime());
      expect(waited.steps[0]!.providerWait).not.toBeNull();

      const t1 = await backdateActivity(walk);
      await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', ...cleared }));
      const after = await progressOf(walk);
      expect(after.steps[0]!.providerWait).toBeNull();
      expect(readAtObserved(after).providerWait).toBeNull();
      expect(Date.parse(after.lastActivityAt)).toBeGreaterThan(t1.getTime());
    },
  );

  it('A3a — the session’s next step nulls a stored wait', T, async () => {
    const walk = await walkHoldingAStep();
    await accepted(
      hostedStep(routes, walk, {
        sessionKey: 'author-1',
        ...waiting(1, 2, new Date(Date.now() + 5_000)),
      }),
    );
    await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', step: 'author' }));
    const snapshot = await progressOf(walk);
    expect(snapshot.steps).toHaveLength(1);
    expect(snapshot.steps[0]!.providerWait).toBeNull();
    expect(readAtObserved(snapshot).providerWait).toBeNull();
  });

  it('A3b — the session’s end deletes its row: no step and no wait remain', T, async () => {
    const walk = await walkHoldingAStep();
    await accepted(
      hostedStep(routes, walk, {
        sessionKey: 'author-1',
        ...waiting(1, 2, new Date(Date.now() + 5_000)),
      }),
    );
    await accepted(hostedStep(routes, walk, { sessionKey: 'author-1', step: 'end' }));
    const snapshot = await progressOf(walk);
    expect(snapshot.steps).toHaveLength(0);
    expect(readAtObserved(snapshot).providerWait).toBeNull();
  });

  it('A3c — narration leaves a stored wait as it was', T, async () => {
    const walk = await walkHoldingAStep();
    await accepted(
      hostedStep(routes, walk, {
        sessionKey: 'author-1',
        ...waiting(2, 3, new Date(Date.now() + 5_000)),
      }),
    );
    const waited = (await progressOf(walk)).steps[0]!.providerWait;
    await accepted(
      hostedStep(routes, walk, {
        sessionKey: 'author-1',
        narration: ['Reading the export story and its two subtasks.'],
      }),
    );
    const snapshot = await progressOf(walk);
    expect(snapshot.steps[0]!.providerWait).toEqual(waited);
    expect(readAtObserved(snapshot).providerWait).toEqual(waited);
  });

  it(
    'A4 — a job that died mid-wait without clearing: past the grace, the reading carries no wait',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      const retryAt = new Date(Date.now() + 5_000);
      await accepted(
        hostedStep(routes, walk, { sessionKey: 'author-1', ...waiting(1, 2, retryAt) }),
      );
      const snapshot = await progressOf(walk);
      expect(snapshot.steps[0]!.providerWait).not.toBeNull();

      const pastGrace = retryAt.getTime() + PLAN_PROVIDER_WAIT_GRACE_MS + 1_000;
      const reading = readPlanProgress(snapshot, pastGrace);
      // Not the stall rule doing it: the plan is still inside its quiet window.
      expect(reading.state).not.toBe('stalled');
      expect(reading.providerWait).toBeNull();
      // …and just inside the grace it still waits.
      expect(
        readPlanProgress(snapshot, retryAt.getTime() + PLAN_PROVIDER_WAIT_GRACE_MS - 1_000)
          .providerWait,
      ).not.toBeNull();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B. exhausted: rate_limited in To resume, and Resume', () => {
  it(
    'B1 — the failed end records rate_limited, and To resume lists the session with that reason and no other',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      gate.jobs.set(walk.jobId, rateLimitedJob(walk.planId));

      const settled = await settleFailed(walk, walk.jobId);
      expect(settled).toMatchObject({ settled: 'recorded', sessionId: walk.sessionId });

      const entries = await toResumeEntries(homeService.listToResume, walk);
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({ sessionId: walk.sessionId, planId: walk.planId });
      expect(entry.failure?.reason).toBe('rate_limited');
      for (const other of ['internal', 'job_failed', 'stalled'] as const) {
        expect(entry.failure?.reason).not.toBe(other);
      }
      // Resumable: the session row carries no `failureResumable: false`.
      const row = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: walk.sessionId },
      });
      expect(row.failureReason).toBe('rate_limited');
      expect(row.failureResumable).not.toBe(false);
    },
  );

  it(
    'B2 — the owner’s Resume continues the SAME session and plan, clears the failure and leaves To resume; a second refusal records it again',
    T,
    async () => {
      const walk = await walkHoldingAStep();
      gate.jobs.set(walk.jobId, rateLimitedJob(walk.planId));
      await settleFailed(walk, walk.jobId);
      const plansBefore = await adminDb.plan.count({ where: { sessionId: walk.sessionId } });

      const res = await resumeAsOwner(routes, walk);
      const body = (await res.json()) as {
        jobId: string;
        planId: string;
        session: { id: string };
      };
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(gate.submitJob).toHaveBeenCalledTimes(1);
      expect(body.planId).toBe(walk.planId);
      expect(body.session.id).toBe(walk.sessionId);
      expect(await adminDb.plan.count({ where: { sessionId: walk.sessionId } })).toBe(plansBefore);

      const row = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: walk.sessionId },
      });
      expect(row.failedAt).toBeNull();
      expect(row.failureReason).toBeNull();
      expect(row.lastJobId).toBe(body.jobId);
      expect(await toResumeEntries(homeService.listToResume, walk)).toHaveLength(0);

      // THE SECOND REFUSAL: the resumed job's retries are refused too — recorded exactly as any
      // second failure is.
      gate.jobs.set(body.jobId, rateLimitedJob(walk.planId));
      expect(await settleFailed(walk, body.jobId)).toMatchObject({ settled: 'recorded' });
      const again = await adminDb.planChangeSession.findUniqueOrThrow({
        where: { id: walk.sessionId },
      });
      expect(again.failureReason).toBe('rate_limited');
      expect(again.failedJobId).toBe(body.jobId);
      const listed = await toResumeEntries(homeService.listToResume, walk);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ sessionId: walk.sessionId, planId: walk.planId });
      expect(listed[0]!.failure?.reason).toBe('rate_limited');
    },
  );
});
