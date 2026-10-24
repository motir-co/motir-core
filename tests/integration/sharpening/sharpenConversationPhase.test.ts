import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import type { JobStreamEvent } from '@/lib/ai/types';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { PlanReviewDto } from '@/lib/dto/planReview';
import type { SharpenSessionDto } from '@/lib/dto/sharpen';
import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';
import { planRunPhase } from '@/lib/planning/planRunPhase';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Task MOTIR-1101 · Subtask MOTIR-8448 — the "Grill me" control's session over
// the run's OWN plan, the phase gate's three states, and the settled answers
// landing on the plan — never on the card being planned (Story MOTIR-9221 ·
// MOTIR-9314).
//
// Real Postgres and the shipped route handlers. motir-ai is faked at the CLIENT
// boundary only (`submitJob` / `getJob`, and `streamJob` for the relay the run's
// frames travel through); every other export of the client stays real. At a
// session's end the fake plays motir-ai's handler and issues the REAL
// `PUT /api/internal/ai/plan-sharpening` with a job token minted the way that
// route's own test mints one. The two context resolvers the test env cannot
// supply without cookies (`getSession`, `getActiveProject`) are the stubs every
// conversation-door suite uses.
//
// THE PHASE STATES. A route test renders nothing, so the phase is asserted on the
// INPUT `planRunPhase` reads — rebuilt from the same reads the overlay makes: the
// run's submit response (a live viewer), or the plan-change session read, the
// plan read and the replay of the run's job frames through the shipped relay (a
// reopened viewer). The hand-off is the run's `target_settled` frame relayed by
// that route; the re-entry is the person's next turn in the SAME plan-change
// session, which revises the same plan under a new job. No run or session row is
// ever written by hand.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

type JobRead = { status: string; result?: Record<string, unknown> | null };

const ai = vi.hoisted(() => ({
  next: 0,
  submitted: [] as Array<{ kind: string; jobId: string; context: Record<string, unknown> }>,
  /** What `getJob` answers — a value, or a function the fake runs once (motir-ai's handler). */
  results: new Map<
    string,
    { status: string; result?: Record<string, unknown> | null } | (() => Promise<JobRead>)
  >(),
  /** The frames `streamJob` replays for a job, from its first. */
  frames: new Map<string, Array<{ event: string; data: unknown }>>(),
}));

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  submitJob: vi.fn(async (kind: string, _tenant: unknown, context: Record<string, unknown>) => {
    ai.next += 1;
    const jobId = `${kind}-${ai.next}`;
    ai.submitted.push({ kind, jobId, context });
    return { jobId };
  }),
  getJob: vi.fn(async (jobId: string) => {
    const entry = ai.results.get(jobId);
    if (typeof entry === 'function') {
      const read = await entry();
      ai.results.set(jobId, read);
      return { jobId, status: read.status, result: read.result ?? null, error: null };
    }
    return {
      jobId,
      status: entry?.status ?? 'running',
      result: entry?.result ?? null,
      error: null,
    };
  }),
  streamJob: vi.fn(async function* (jobId: string): AsyncGenerator<JobStreamEvent> {
    for (const frame of ai.frames.get(jobId) ?? []) yield frame as JobStreamEvent;
  }),
}));

const sharpenRoute = await import('@/app/api/ai/sharpen/route');
const { GET: getSharpenSession } = await import('@/app/api/ai/sharpen/[sessionId]/route');
const { POST: settleRoute } = await import('@/app/api/ai/sharpen/settle/route');
const { POST: planFromItem } = await import('@/app/api/work-items/[id]/ai/plan/route');
const planChangeSessionRoute = await import('@/app/api/ai/plan-change/session/route');
const { POST: submitPlanChange } = await import('@/app/api/ai/plan-change/session/submit/route');
const { GET: relay } = await import('@/app/api/ai/augment/[jobId]/stream/route');
const { POST: appendProposals } = await import('@/app/api/internal/ai/plan-proposals/route');
const { PUT: writeBackRoute } = await import('@/app/api/internal/ai/plan-sharpening/route');
const { plansService } = await import('@/lib/services/plansService');
const { planReviewService } = await import('@/lib/services/planReviewService');
const { workItemsService } = await import('@/lib/services/workItemsService');

const BASE = 'http://localhost:3000';
const CALLBACK_SECRET = 'core-callback-secret-test';

const json = (method: string, path: string, body: unknown, headers?: Headers): Request =>
  new Request(`${BASE}${path}`, {
    method,
    headers: headers ?? new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });

let fx: WorkItemFixture;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  process.env['CORE_CALLBACK_SECRET'] = CALLBACK_SECRET;
  ai.next = 0;
  ai.submitted = [];
  ai.results.clear();
  ai.frames.clear();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  signIn(fx, fx.ownerId);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function signIn(f: WorkItemFixture, userId: string): void {
  session.current = { user: { id: userId, email: `${userId}@example.com`, name: 'Person' } };
  activeCtx.current = {
    userId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

// ── the run (the shipped conversation path) ──────────────────────────────────

interface Run {
  planId: string;
  jobId: string;
  /** The plan-change session — the conversation the run belongs to. */
  conversationId: string;
  /** The card the run is anchored on, or null for a project-wide run. */
  anchorId: string | null;
}

/** A planning run anchored on `anchor` — the card being planned. */
async function startAnchoredRun(anchor: { id: string }): Promise<Run> {
  const res = await planFromItem(
    json('POST', `/api/work-items/${anchor.id}/ai/plan`, { prompt: 'Plan shared export presets' }),
    { params: Promise.resolve({ id: anchor.id }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jobId: string; planId: string; sessionId: string };
  return {
    planId: body.planId,
    jobId: body.jobId,
    conversationId: body.sessionId,
    anchorId: anchor.id,
  };
}

/** A project-wide planning run — no anchor card. */
async function startProjectRun(): Promise<Run> {
  const opened = await planChangeSessionRoute.POST(
    json('POST', '/api/ai/plan-change/session', { body: 'Plan the quarter' }),
  );
  expect(opened.status).toBe(200);
  const conversationId = ((await opened.json()) as PlanChangeSessionDto).id;
  const res = await submitPlanChange(
    json('POST', '/api/ai/plan-change/session/submit', { sessionId: conversationId }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jobId: string; planId: string };
  return { planId: body.planId, jobId: body.jobId, conversationId, anchorId: null };
}

/** The frame names the shipped relay forwards for `jobId`, replayed from its first. */
async function relayedEvents(jobId: string): Promise<string[]> {
  const res = await relay(new Request(`${BASE}/api/ai/augment/${jobId}/stream`), {
    params: Promise.resolve({ jobId }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  return [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]!);
}

async function conversation(id: string): Promise<PlanChangeSessionDto> {
  const res = await planChangeSessionRoute.GET(
    new Request(`${BASE}/api/ai/plan-change/session?id=${encodeURIComponent(id)}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PlanChangeSessionDto;
}

type PhaseInput = Pick<
  PlanChangeConversationState,
  'phase' | 'planId' | 'jobId' | 'settledJobId' | 'liveReview' | 'session'
>;

/** The state a REOPENED viewer rebuilds: the session read, the plan read, and the
 *  replay of the session's latest job — settled only once `target_settled` arrived. */
async function reopenedState(run: Run): Promise<PhaseInput> {
  const read = await conversation(run.conversationId);
  const liveReview: PlanReviewDto = await planReviewService.getPlanReview(run.planId, fx.ctx);
  const job = read.lastJobId;
  const settled = job !== null && (await relayedEvents(job)).includes('target_settled');
  return {
    phase: 'idle',
    planId: run.planId,
    jobId: null,
    settledJobId: settled ? job : null,
    liveReview,
    session: read,
  };
}

/** The state the LIVE viewer holds: the submit's `{ planId, jobId }`, settled by the
 *  frames it streamed. */
async function liveState(planId: string, jobId: string): Promise<PhaseInput> {
  const settled = (await relayedEvents(jobId)).includes('target_settled');
  return {
    phase: 'streaming',
    planId,
    jobId,
    settledJobId: settled ? jobId : null,
    liveReview: null,
    session: null,
  };
}

// ── the door ─────────────────────────────────────────────────────────────────

const QUESTION = (id: string, text: string) => ({
  id,
  text,
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [
    { id: 'a', label: `${id} reading A`, detail: '', recommended: true },
    { id: 'b', label: `${id} reading B`, detail: '', recommended: false },
  ],
});
const SETTLED = [
  {
    questionId: 'q1',
    question: 'Who exports presets?',
    answer: 'Only admins',
    topic: 'workflow',
    readingId: 'a',
    source: 'person',
  },
  {
    questionId: 'q2',
    question: 'What if a preset is empty?',
    answer: 'The export says so',
    topic: 'non_happy',
    readingId: 'b',
    source: 'person',
  },
];
const ASSUMPTIONS = [
  {
    questionId: 'q3',
    question: 'Which date format?',
    recommendation: 'ISO 8601',
    why: '',
    source: 'planner',
  },
];
/** What motir-ai's handler composes from the settled set and sends core. */
const REQUIREMENT = {
  behaviour: '- Who exports presets? — Only admins',
  acceptance: '- What if a preset is empty? — The export says so',
};
const PLANNER = [{ question: 'Which date format?', recommendation: 'ISO 8601' }];

function questionTurn(q: ReturnType<typeof QUESTION>, settled: unknown[] = []) {
  return {
    status: 'succeeded',
    result: {
      sharpenTurn: { kind: 'question', question: q, settled, assumptions: [], writeBack: null },
    },
  };
}

async function door(body: unknown): Promise<Response> {
  return sharpenRoute.POST(json('POST', '/api/ai/sharpen', body));
}

async function openSharpen(planId: string) {
  const res = await door({ planId });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    outcome: string;
    jobId: string;
    turnId: string;
    session: SharpenSessionDto;
  };
}

async function settle(sessionId: string, jobId: string) {
  const res = await settleRoute(json('POST', '/api/ai/sharpen/settle', { sessionId, jobId }));
  expect(res.status).toBe(200);
  return (await res.json()) as { outcome: string; session: SharpenSessionDto };
}

async function act(sessionId: string, body: Record<string, unknown>) {
  const res = await door({ sessionId, ...body });
  expect(res.status).toBe(200);
  return (await res.json()) as { jobId: string; session: SharpenSessionDto };
}

async function openFor(planId: string): Promise<SharpenSessionDto | null> {
  const res = await sharpenRoute.GET(new Request(`${BASE}/api/ai/sharpen?planId=${planId}`));
  expect(res.status).toBe(200);
  return (await res.json()) as SharpenSessionDto | null;
}

async function readById(sessionId: string): Promise<SharpenSessionDto> {
  const res = await getSharpenSession(new Request(`${BASE}/api/ai/sharpen/${sessionId}`), {
    params: Promise.resolve({ sessionId }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as SharpenSessionDto;
}

/** The grilling state the phase must not touch, serialized for a byte-equal check. */
const grillState = (s: SharpenSessionDto | null) =>
  JSON.stringify({
    id: s?.id,
    status: s?.status,
    pendingQuestion: s?.pendingQuestion,
    settled: s?.settled,
    assumptions: s?.assumptions,
    turns: s?.turns.map((t) => [t.id, t.role, t.action, t.jobId]),
  });

/** Open a session over the run's plan and settle its first job into a question. */
async function grillWithQuestion(planId: string) {
  const opened = await openSharpen(planId);
  ai.results.set(opened.jobId, questionTurn(QUESTION('q1', 'Who exports presets?')));
  const settled = await settle(opened.session.id, opened.jobId);
  expect(settled.outcome).toBe('settled');
  return { sessionId: opened.session.id, firstJobId: opened.jobId };
}

/**
 * Answer the pending question, then STOP: the stop job is the session's end, and
 * the fake plays motir-ai's handler — it issues the REAL write-back for the plan
 * scope and reports its outcome on the turn.
 */
async function answerThenStop(sessionId: string, planId: string) {
  const answered = await act(sessionId, { action: 'answer', readingId: 'a' });
  ai.results.set(
    answered.jobId,
    questionTurn(QUESTION('q2', 'What if a preset is empty?'), SETTLED.slice(0, 1)),
  );
  await settle(sessionId, answered.jobId);

  const stopped = await act(sessionId, { action: 'stop' });
  const writeBacks: Array<{ status: number; body: Record<string, unknown> }> = [];
  ai.results.set(stopped.jobId, async () => {
    const res = await putWriteBack(stopped.jobId, planId);
    const body = (await res.json()) as Record<string, unknown>;
    writeBacks.push({ status: res.status, body });
    return {
      status: 'succeeded',
      result: {
        sharpenTurn: {
          kind: 'stopped',
          question: null,
          settled: SETTLED,
          assumptions: ASSUMPTIONS,
          writeBack: res.status === 200 ? { ok: true } : { ok: false, error: String(body['code']) },
        },
      },
    };
  });
  return { stopJobId: stopped.jobId, writeBacks };
}

/** The internal write-back, exactly as `planSharpeningRoute.test.ts` calls it. */
function putWriteBack(jobId: string, planId: string): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('authorization', `Bearer ${CALLBACK_SECRET}`);
  headers.set(
    'x-motir-job-token',
    mintJobToken({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId }),
  );
  return writeBackRoute(
    json(
      'PUT',
      '/api/internal/ai/plan-sharpening',
      { jobId, scope: { planId }, requirement: REQUIREMENT, plannerAssumptions: PLANNER },
      headers,
    ),
  );
}

/** motir-ai's run ending: its final append through the real internal route. */
async function runFinishes(jobId: string): Promise<void> {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('authorization', `Bearer ${CALLBACK_SECRET}`);
  headers.set(
    'x-motir-job-token',
    mintJobToken({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId }),
  );
  const res = await appendProposals(
    json(
      'POST',
      '/api/internal/ai/plan-proposals',
      {
        jobId,
        proposals: [
          {
            op: 'add',
            proposedFields: { title: 'Export presets', kind: 'task', difficulty: 'low' },
          },
        ],
        final: true,
      },
      headers,
    ),
  );
  expect(res.status).toBe(200);
  ai.results.set(jobId, { status: 'succeeded', result: {} });
}

const sharpenSubmits = () => ai.submitted.filter((s) => s.kind === 'sharpen_turn');

async function cardBody(id: string): Promise<string> {
  return (await workItemsService.getWorkItem(id, fx.ctx)).descriptionMd ?? '';
}

async function anchorCard(body = 'Hand-written body.\n') {
  const row = await createTestWorkItem(fx, { kind: 'story', title: 'Shared export presets' });
  await adminDb.workItem.update({ where: { id: row.id }, data: { descriptionMd: body } });
  return row;
}

// ── the lane premise ─────────────────────────────────────────────────────────

describe('the lane premise', () => {
  it('the client-boundary stub covers the plan-change conversation’s own job: one generating plan, bound to the session, relayed', async () => {
    const card = await anchorCard();
    ai.frames.set('plan-1', [{ event: 'search', data: { seq: 1 } }]);
    const run = await startAnchoredRun(card);
    expect(run.jobId).toBe('plan-1');
    const read = await conversation(run.conversationId);
    expect(read.lastJobId).toBe(run.jobId);
    expect(read.targetKeys[0]).toBe(card.identifier);
    expect((await planReviewService.getPlanReview(run.planId, fx.ctx)).status).toBe('generating');
    expect(await relayedEvents(run.jobId)).toEqual(['search']);
  });
});

// ── a session over the run's own plan, and the widened gate ──────────────────

describe('a session over the run’s own plan', () => {
  it('opens on the conversation-phase run’s generating plan: one session, one start turn, one sharpen_turn job scoped to it', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);
    expect((await liveState(run.planId, run.jobId)).settledJobId).toBeNull();
    expect(planRunPhase(await liveState(run.planId, run.jobId))).toBe('conversation');

    const opened = await openSharpen(run.planId);
    expect(opened.outcome).toBe('sharpening');
    expect(opened.session.scope).toEqual({ kind: 'plan', planId: run.planId });
    expect(opened.session.turns).toHaveLength(1);
    expect(opened.session.turns[0]).toMatchObject({ role: 'person', action: 'start' });
    expect(opened.session.turns[0]!.jobId).toBe(opened.jobId);
    expect(opened.session.inFlight).toEqual({ turnId: opened.turnId, jobId: opened.jobId });
    expect(sharpenSubmits()).toHaveLength(1);
    expect(sharpenSubmits()[0]!.jobId).toBe(opened.jobId);
    expect(sharpenSubmits()[0]!.context['sharpen']).toMatchObject({
      scope: { kind: 'plan', ref: run.planId },
      action: 'start',
    });
    expect((await openFor(run.planId))?.id).toBe(opened.session.id);
  });

  it('widens by exactly one target: another project’s plan 404, a viewer 403, a decided plan 409 — nothing stored, nothing submitted', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);

    // Another project's generating plan.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await plansService.createPlan(
      other.projectId,
      { title: 'Theirs', authorSource: 'native', authorHarness: 'Motir' },
      other.ctx,
    );
    const foreignRes = await door({ planId: foreign.id });
    expect(foreignRes.status).toBe(404);

    // A person who can browse the project but not edit it.
    const viewer = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    await addToProjectAs({
      key: fx.projectIdentifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });
    signIn(fx, viewer.id);
    expect((await door({ planId: run.planId })).status).toBe(403);
    expect(await openFor(run.planId)).toBeNull();
    signIn(fx, fx.ownerId);

    // A decided plan, each way.
    for (const status of ['approved', 'declined'] as const) {
      const decided = await plansService.createPlan(
        fx.projectId,
        { title: status, authorSource: 'native', authorHarness: 'Motir' },
        fx.ctx,
      );
      await adminDb.plan.update({ where: { id: decided.id }, data: { status } });
      const res = await door({ planId: decided.id });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('SHARPEN_TARGET_CLOSED');
      expect(await openFor(decided.id)).toBeNull();
    }

    expect(await openFor(run.planId)).toBeNull();
    expect(await adminDb.sharpenSession.count()).toBe(0);
    expect(await adminDb.sharpenTurn.count()).toBe(0);
    expect(sharpenSubmits()).toHaveLength(0);

    // …and the one admitted target, the run's own plan, by the person who may edit it.
    expect((await openSharpen(run.planId)).outcome).toBe('sharpening');
    expect(await adminDb.sharpenSession.count()).toBe(1);
  });

  it('is phase-blind: a run that has already handed off is not refused at the door', async () => {
    const card = await anchorCard();
    ai.frames.set('plan-1', [
      { event: 'search', data: { seq: 1 } },
      { event: 'target_settled', data: { seq: 2 } },
    ]);
    const run = await startAnchoredRun(card);
    expect(planRunPhase(await reopenedState(run))).toBe('planning');
    expect((await openSharpen(run.planId)).outcome).toBe('sharpening');
  });
});

// ── the phase gate's three states ────────────────────────────────────────────

describe('the phase gate’s three states', () => {
  it('conversation → hand-off → re-entry: the same open session, byte-equal, and no job from any transition', async () => {
    const card = await anchorCard();
    ai.frames.set('plan-1', [{ event: 'search', data: { seq: 1 } }]);
    const run = await startAnchoredRun(card);

    // CONVERSATION — the run's job is unsettled.
    expect(planRunPhase(await reopenedState(run))).toBe('conversation');
    expect(planRunPhase(await liveState(run.planId, run.jobId))).toBe('conversation');
    const { sessionId } = await grillWithQuestion(run.planId);
    const atConversation = await openFor(run.planId);
    expect(atConversation?.id).toBe(sessionId);
    expect(atConversation?.status).toBe('open');
    expect(atConversation?.pendingQuestion).toMatchObject({ id: 'q1' });
    expect(atConversation?.inFlight).toBeNull();
    const submitsBefore = sharpenSubmits().length;

    // THE HAND-OFF — the run's `target_settled` frame, through the shipped relay.
    ai.frames.set(run.jobId, [
      { event: 'search', data: { seq: 1 } },
      { event: 'target_settled', data: { seq: 2 } },
    ]);
    const handedOff = await reopenedState(run);
    expect(handedOff.settledJobId).toBe(run.jobId);
    expect(planRunPhase(handedOff)).toBe('planning');
    expect(planRunPhase(await liveState(run.planId, run.jobId))).toBe('planning');
    const atPlanning = await openFor(run.planId);
    expect(atPlanning?.status).toBe('open');
    expect(grillState(atPlanning)).toBe(grillState(atConversation));
    expect(sharpenSubmits()).toHaveLength(submitsBefore);

    // RE-ENTRY — the run's pass ends, and the person's next turn in the SAME
    // conversation revises the same plan under a new, unsettled job.
    await runFinishes(run.jobId);
    const next = await planFromItem(
      json('POST', `/api/work-items/${card.id}/ai/plan`, {
        prompt: 'And let a preset be shared with a team',
        sessionId: run.conversationId,
      }),
      { params: Promise.resolve({ id: card.id }) },
    );
    expect(next.status).toBe(200);
    const revised = (await next.json()) as { jobId: string; planId: string; sessionId: string };
    expect(revised.sessionId).toBe(run.conversationId);
    expect(revised.planId).toBe(run.planId);
    expect(revised.jobId).not.toBe(run.jobId);
    const reentered = await reopenedState(run);
    expect(reentered.session?.lastJobId).toBe(revised.jobId);
    expect(planRunPhase(reentered)).toBe('conversation');
    expect(planRunPhase(await liveState(revised.planId, revised.jobId))).toBe('conversation');

    const atReentry = await openFor(run.planId);
    expect(atReentry?.id).toBe(sessionId);
    expect(grillState(atReentry)).toBe(grillState(atPlanning));
    expect(sharpenSubmits()).toHaveLength(submitsBefore);
  });

  it('a read never advances the session, at any of the three states', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);
    const { sessionId } = await grillWithQuestion(run.planId);
    const baseline = grillState(await readById(sessionId));
    const sent = sharpenSubmits().length;

    const readTwice = async () => {
      for (let i = 0; i < 2; i++) {
        expect(grillState(await openFor(run.planId))).toBe(baseline);
        expect(grillState(await readById(sessionId))).toBe(baseline);
      }
      expect(sharpenSubmits()).toHaveLength(sent);
    };

    expect(planRunPhase(await reopenedState(run))).toBe('conversation');
    await readTwice();
    ai.frames.set(run.jobId, [{ event: 'target_settled', data: { seq: 1 } }]);
    expect(planRunPhase(await reopenedState(run))).toBe('planning');
    await readTwice();
    await runFinishes(run.jobId);
    const next = await planFromItem(
      json('POST', `/api/work-items/${card.id}/ai/plan`, {
        prompt: 'One more thing',
        sessionId: run.conversationId,
      }),
      { params: Promise.resolve({ id: card.id }) },
    );
    expect(next.status).toBe(200);
    expect(planRunPhase(await reopenedState(run))).toBe('conversation');
    await readTwice();
  });
});

// ── the settled answers landing ──────────────────────────────────────────────

describe('the settled answers landing', () => {
  it('a project-wide run lands on the plan alone; the plan stays generating', async () => {
    const bystander = await anchorCard();
    const run = await startProjectRun();
    expect(run.anchorId).toBeNull();
    const { sessionId } = await grillWithQuestion(run.planId);
    const { stopJobId, writeBacks } = await answerThenStop(sessionId, run.planId);

    const ended = await settle(sessionId, stopJobId);
    expect(ended.outcome).toBe('settled');
    expect(writeBacks.map((w) => w.status)).toEqual([200]);
    expect(ended.session).toMatchObject({
      status: 'ended',
      endReason: 'stopped',
      settled: SETTLED,
      assumptions: ASSUMPTIONS,
      writeBack: { ok: true },
    });

    const plan = await plansService.getPlan(run.planId, fx.ctx);
    expect(plan.status).toBe('generating');
    expect(plan.sharpenedRequirement).toEqual({
      ...REQUIREMENT,
      plannerAssumptions: PLANNER,
      settledAt: expect.any(String),
    });
    expect(await cardBody(bystander.id)).toBe('Hand-written body.\n');
  });

  it('an anchored run lands on the plan alone; the card being planned is untouched, and a repeat is byte-identical (MOTIR-9314)', async () => {
    const card = await anchorCard();
    const cardBefore = await cardBody(card.id);
    const run = await startAnchoredRun(card);
    const { sessionId } = await grillWithQuestion(run.planId);
    expect((await readById(sessionId)).scope).toEqual({ kind: 'plan', planId: run.planId });
    const { stopJobId } = await answerThenStop(sessionId, run.planId);
    const ended = await settle(sessionId, stopJobId);
    expect(ended.session.writeBack).toEqual({ ok: true });

    const plan = await plansService.getPlan(run.planId, fx.ctx);
    expect(plan.status).toBe('generating');
    expect(plan.sharpenedRequirement).toMatchObject({
      ...REQUIREMENT,
      plannerAssumptions: PLANNER,
    });
    expect(await cardBody(card.id)).toBe(cardBefore);

    // motir-ai repeating the identical write.
    expect((await putWriteBack(stopJobId, run.planId)).status).toBe(200);
    expect(await cardBody(card.id)).toBe(cardBefore);
  });

  it('a decided plan refuses the landing: the session still ends with its answers, writeBack ok:false names the refusal, plan and card untouched', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);
    const { sessionId } = await grillWithQuestion(run.planId);
    const { stopJobId } = await answerThenStop(sessionId, run.planId);

    // The plan leaves its legal window between the last answer and the end.
    await adminDb.plan.update({ where: { id: run.planId }, data: { status: 'declined' } });
    const planBefore = JSON.stringify(await plansService.getPlan(run.planId, fx.ctx));
    const cardBefore = await cardBody(card.id);

    const ended = await settle(sessionId, stopJobId);
    expect(ended.session).toMatchObject({
      status: 'ended',
      endReason: 'stopped',
      settled: SETTLED,
      assumptions: ASSUMPTIONS,
      writeBack: { ok: false, error: 'SHARPENING_PLAN_CLOSED' },
    });
    expect((await readById(sessionId)).settled).toEqual(SETTLED);
    expect(JSON.stringify(await plansService.getPlan(run.planId, fx.ctx))).toBe(planBefore);
    expect(await cardBody(card.id)).toBe(cardBefore);
  });

  it('a finished card no longer refuses the landing: the plan takes the answers, the card is untouched (MOTIR-9314)', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);
    const { sessionId } = await grillWithQuestion(run.planId);
    const { stopJobId } = await answerThenStop(sessionId, run.planId);

    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
    const cardBefore = await cardBody(card.id);

    const ended = await settle(sessionId, stopJobId);
    expect(ended.session).toMatchObject({
      status: 'ended',
      settled: SETTLED,
      assumptions: ASSUMPTIONS,
      writeBack: { ok: true },
    });
    expect(await cardBody(card.id)).toBe(cardBefore);
    const plan = await plansService.getPlan(run.planId, fx.ctx);
    expect(plan.sharpenedRequirement).toMatchObject({
      ...REQUIREMENT,
      plannerAssumptions: PLANNER,
    });
  });

  it('settle is replay-safe and pending is silent', async () => {
    const card = await anchorCard();
    const run = await startAnchoredRun(card);
    const opened = await openSharpen(run.planId);

    // Still running: pending, nothing written.
    const pending = await settle(opened.session.id, opened.jobId);
    expect(pending.outcome).toBe('pending');
    expect(grillState(pending.session)).toBe(grillState(opened.session));
    expect(pending.session.turns).toHaveLength(1);

    ai.results.set(opened.jobId, questionTurn(QUESTION('q1', 'Who exports presets?')));
    await settle(opened.session.id, opened.jobId);
    const { stopJobId, writeBacks } = await answerThenStop(opened.session.id, run.planId);
    const ended = await settle(opened.session.id, stopJobId);
    const plan = JSON.stringify(await plansService.getPlan(run.planId, fx.ctx));
    const body = await cardBody(card.id);

    const replay = await settle(opened.session.id, stopJobId);
    expect(replay.outcome).toBe('settled');
    expect(JSON.stringify(replay.session)).toBe(JSON.stringify(ended.session));
    expect(JSON.stringify(await plansService.getPlan(run.planId, fx.ctx))).toBe(plan);
    expect(await cardBody(card.id)).toBe(body);
    expect(writeBacks).toHaveLength(1);
  });
});
