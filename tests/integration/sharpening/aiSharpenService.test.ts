import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// Task MOTIR-1101 · Subtask MOTIR-8181 — the Sharpen session door's service on a
// real Postgres. Only the motir-ai boundary client is stubbed (`submitJob`,
// `getJob`); every gate, write and read goes through the real path.

const jobs = vi.hoisted(() => ({
  next: 0,
  submitted: [] as Array<{ kind: string; context: Record<string, unknown> }>,
  results: new Map<string, { status: string; result?: Record<string, unknown> | null }>(),
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
    const r = jobs.results.get(jobId) ?? { status: 'running' };
    return { jobId, status: r.status, result: r.result ?? null, error: null };
  }),
  streamJob: vi.fn(),
}));

const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { plansService } = await import('@/lib/services/plansService');
const { MotirAiOutOfCreditsError } = await import('@/lib/ai/errors');
const errors = await import('@/lib/sharpening/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

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
  pctx = ctxFor(fx, fx.ownerId);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxFor(f: WorkItemFixture, userId: string): ProjectContext {
  return { userId, workspaceId: f.workspaceId, projectId: f.projectId, project: f.project };
}

async function plannedPlan(f: WorkItemFixture = fx): Promise<string> {
  const plan = await plansService.createPlan(
    f.projectId,
    { title: 'Sharpen', authorSource: 'native', authorHarness: 'Motir' },
    f.ctx,
  );
  await plansService.addProposals(
    plan.id,
    [{ op: 'add', proposedFields: { title: 'A card', kind: 'task', difficulty: 'low' } }],
    f.ctx,
  );
  await plansService.markPlanned(plan.id, f.ctx);
  return plan.id;
}

async function colleague(role: 'member' | 'viewer'): Promise<ProjectContext> {
  const user = await createTestUser();
  await adminDb.workspaceMembership.create({
    data: { userId: user.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role,
  });
  return ctxFor(fx, user.id);
}

const QUESTION = {
  id: 'q1',
  text: 'Who exports invoices?',
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [
    { id: 'a', label: 'Only admins', detail: 'Finance is admin-only', recommended: true },
    { id: 'b', label: 'Any member', detail: '', recommended: false },
  ],
};
const SETTLED = [
  {
    questionId: 'q1',
    question: 'Who exports invoices?',
    answer: 'Only admins',
    topic: 'workflow',
    readingId: 'a',
    source: 'person',
  },
];

function succeed(jobId: string, sharpenTurn: Record<string, unknown>): void {
  jobs.results.set(jobId, { status: 'succeeded', result: { sharpenTurn } });
}

function questionTurn(question = QUESTION, settled: unknown[] = []) {
  return { kind: 'question', question, settled, assumptions: [], writeBack: null };
}

/** Open a plan session and settle its first job into a pending question. */
async function openWithQuestion(ctx = pctx) {
  const planId = await plannedPlan();
  const opened = await aiSharpenService.open({ planId }, ctx);
  succeed(opened.jobId!, questionTurn());
  await aiSharpenService.settle(opened.session.id, opened.jobId!, ctx);
  return { planId, sessionId: opened.session.id };
}

async function sessionCount(): Promise<number> {
  return adminDb.sharpenSession.count();
}

describe('open', () => {
  it('stores one session and one start turn, submits one sharpen_turn job and binds it', async () => {
    const planId = await plannedPlan();
    const opened = await aiSharpenService.open({ planId }, pctx);

    expect(opened.outcome).toBe('sharpening');
    expect(jobs.submitted).toHaveLength(1);
    expect(jobs.submitted[0]!.kind).toBe('sharpen_turn');
    expect(jobs.submitted[0]!.context.sharpen).toMatchObject({
      scope: { kind: 'plan', ref: planId },
      action: 'start',
      turns: [],
      settled: [],
      assumptions: [],
      pendingQuestion: null,
    });
    expect(opened.session.scope).toEqual({ kind: 'plan', planId });
    expect(opened.session.turns).toHaveLength(1);
    expect(opened.session.turns[0]).toMatchObject({ role: 'person', action: 'start' });
    expect(opened.session.turns[0]!.jobId).toBe(opened.jobId);
    expect(opened.session.inFlight).toEqual({ turnId: opened.turnId, jobId: opened.jobId });
  });

  it('resumes the same person’s open session without sending; another person gets their own', async () => {
    const planId = await plannedPlan();
    const first = await aiSharpenService.open({ planId }, pctx);
    const again = await aiSharpenService.open({ planId }, pctx);
    expect(again).toMatchObject({ outcome: 'resumed', jobId: null, turnId: null });
    expect(again.session.id).toBe(first.session.id);
    expect(jobs.submitted).toHaveLength(1);

    const other = await aiSharpenService.open({ planId }, await colleague('member'));
    expect(other.outcome).toBe('sharpening');
    expect(other.session.id).not.toBe(first.session.id);
  });

  it('leaves exactly one open session when one person opens twice at once', async () => {
    const planId = await plannedPlan();
    const [a, b] = await Promise.all([
      aiSharpenService.open({ planId }, pctx),
      aiSharpenService.open({ planId }, pctx),
    ]);
    expect(a.session.id).toBe(b.session.id);
    expect(await sessionCount()).toBe(1);
  });

  it.each(['approved', 'declined'] as const)(
    'refuses a %s plan, writing nothing and submitting nothing',
    async (status) => {
      const planId = await plannedPlan();
      await adminDb.plan.update({ where: { id: planId }, data: { status } });
      await expect(aiSharpenService.open({ planId }, pctx)).rejects.toBeInstanceOf(
        errors.SharpenTargetClosedError,
      );
      expect(await sessionCount()).toBe(0);
      expect(jobs.submitted).toHaveLength(0);
    },
  );

  // Task MOTIR-1101 · Subtask MOTIR-8445 — the conversation phase's own run plan
  // is `generating` with no `add` proposals yet, and "Grill me" sharpens it.
  it('opens on a generating plan with no proposals — the conversation phase’s own plan', async () => {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Being planned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe(
      'generating',
    );
    const opened = await aiSharpenService.open({ planId: plan.id }, pctx);

    expect(opened.outcome).toBe('sharpening');
    expect(await sessionCount()).toBe(1);
    expect(opened.session.turns).toHaveLength(1);
    expect(opened.session.turns[0]).toMatchObject({ role: 'person', action: 'start' });
    expect(jobs.submitted).toHaveLength(1);
    expect(jobs.submitted[0]!.kind).toBe('sharpen_turn');
    expect(jobs.submitted[0]!.context.sharpen).toMatchObject({
      scope: { kind: 'plan', ref: plan.id },
    });
  });

  it('keeps a generating plan’s session open mid-conversation: resume, answer and stop', async () => {
    const { planId, sessionId } = await openWithQuestion();
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'generating' } });

    expect((await aiSharpenService.getOpenFor({ planId }, pctx))?.id).toBe(sessionId);
    const acted = await aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx);
    expect(acted.jobId).toBeTruthy();
    expect(jobs.submitted).toHaveLength(2);

    succeed(acted.jobId!, questionTurn({ ...QUESTION, id: 'q2' }, SETTLED));
    await aiSharpenService.settle(sessionId, acted.jobId!, pctx);
    await expect(aiSharpenService.act(sessionId, 'stop', {}, pctx)).resolves.toBeTruthy();
  });

  it('admits a status, not a person — a viewer is still refused on a generating plan', async () => {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Being planned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    await expect(
      aiSharpenService.open({ planId: plan.id }, await colleague('viewer')),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(await sessionCount()).toBe(0);
    expect(jobs.submitted).toHaveLength(0);
  });

  it('accepts a stale plan', async () => {
    const planId = await plannedPlan();
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'stale' } });
    expect((await aiSharpenService.open({ planId }, pctx)).outcome).toBe('sharpening');
  });

  it('answers 404-shaped for another project’s plan', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreignPlan = await plannedPlan(other);
    await expect(aiSharpenService.open({ planId: foreignPlan }, pctx)).rejects.toBeInstanceOf(
      errors.SharpenTargetNotAvailableError,
    );
  });
});

describe('act and settle', () => {
  it('settles a question, then an answer carries the STORED settled set and the reading', async () => {
    const { sessionId } = await openWithQuestion();
    const read = await aiSharpenService.get(sessionId, pctx);
    expect(read.pendingQuestion).toEqual(QUESTION);
    expect(read.inFlight).toBeNull();
    expect(read.turns.map((t) => t.role)).toEqual(['person', 'planner']);

    const acted = await aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx);
    const ctx = jobs.submitted.at(-1)!.context.sharpen as Record<string, unknown>;
    expect(ctx).toMatchObject({
      action: 'answer',
      readingId: 'a',
      settled: [],
      assumptions: [],
      pendingQuestion: QUESTION,
    });
    expect((ctx.turns as unknown[]).length).toBe(2);
    expect(acted.session.turns.at(-1)).toMatchObject({ body: 'Only admins', readingId: 'a' });

    // A second act while that job has no planner turn: refused, nothing sent.
    const before = jobs.submitted.length;
    await expect(aiSharpenService.act(sessionId, 'skip', {}, pctx)).rejects.toBeInstanceOf(
      errors.SharpenTurnInFlightError,
    );
    expect(jobs.submitted).toHaveLength(before);
  });

  it('is replay-safe: settling the same job twice stores one planner turn', async () => {
    const { sessionId } = await openWithQuestion();
    const again = await aiSharpenService.settle(sessionId, 'job-1', pctx);
    expect(again.outcome).toBe('settled');
    expect(again.session.turns.filter((t) => t.role === 'planner')).toHaveLength(1);
  });

  it.each(['nothing_to_ask', 'finished', 'stopped'] as const)(
    'ends the session on %s with its write-back outcome',
    async (kind) => {
      const { sessionId } = await openWithQuestion();
      const acted = await aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx);
      succeed(acted.jobId!, {
        kind,
        question: null,
        settled: SETTLED,
        assumptions: [],
        writeBack: { ok: false, error: 'refused' },
      });
      const settled = await aiSharpenService.settle(sessionId, acted.jobId!, pctx);
      expect(settled.outcome).toBe('settled');
      expect(settled.session).toMatchObject({
        status: 'ended',
        endReason: kind,
        pendingQuestion: null,
        settled: SETTLED,
        writeBack: { ok: false, error: 'refused' },
      });
      await expect(aiSharpenService.act(sessionId, 'stop', {}, pctx)).rejects.toBeInstanceOf(
        errors.SharpenSessionEndedError,
      );
    },
  );

  it('answers pending for a running job and writes nothing', async () => {
    const planId = await plannedPlan();
    const opened = await aiSharpenService.open({ planId }, pctx);
    const r = await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    expect(r.outcome).toBe('pending');
    expect(r.session.turns).toHaveLength(1);
    // A job that is not this session's is pending too.
    expect((await aiSharpenService.settle(opened.session.id, 'job-x', pctx)).outcome).toBe(
      'pending',
    );
  });

  it.each([
    ['a failed job', { status: 'failed' }],
    [
      'an unavailable result',
      {
        status: 'succeeded',
        result: {
          sharpenTurn: {
            kind: 'unavailable',
            question: null,
            settled: [],
            assumptions: [],
            writeBack: null,
          },
        },
      },
    ],
    ['an unparseable result', { status: 'succeeded', result: { sharpenTurn: { kind: 'guess' } } }],
  ])('treats %s as a failed turn and keeps the stored state', async (_label, job) => {
    const { sessionId } = await openWithQuestion();
    const acted = await aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx);
    const before = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: sessionId } });
    jobs.results.set(acted.jobId!, job);

    const r = await aiSharpenService.settle(sessionId, acted.jobId!, pctx);
    expect(r.outcome).toBe('failed');
    expect(r.session.status).toBe('open');
    expect(r.session.turns.at(-1)).toMatchObject({ role: 'planner', failed: true });
    const after = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(JSON.stringify(after.settled)).toBe(JSON.stringify(before.settled));
    expect(JSON.stringify(after.assumptions)).toBe(JSON.stringify(before.assumptions));

    // The failed person turn can be re-run: one new job, bound to the same turn.
    const sent = jobs.submitted.length;
    const re = await aiSharpenService.resubmit(sessionId, acted.turnId!, pctx);
    expect(jobs.submitted).toHaveLength(sent + 1);
    expect(re.jobId).not.toBe(acted.jobId);
    expect(re.turnId).toBe(acted.turnId);
  });

  it('accepts Stop while an answer is in flight; the late answer does not change the ended state', async () => {
    const { sessionId } = await openWithQuestion();
    const answer = await aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx);
    const stop = await aiSharpenService.act(sessionId, 'stop', {}, pctx);
    expect((jobs.submitted.at(-1)!.context.sharpen as Record<string, unknown>).settled).toEqual([]);

    succeed(stop.jobId!, {
      kind: 'stopped',
      question: null,
      settled: [],
      assumptions: [],
      writeBack: null,
    });
    await aiSharpenService.settle(sessionId, stop.jobId!, pctx);

    succeed(answer.jobId!, questionTurn({ ...QUESTION, id: 'q2' }, SETTLED));
    const late = await aiSharpenService.settle(sessionId, answer.jobId!, pctx);
    expect(late.session).toMatchObject({
      status: 'ended',
      endReason: 'stopped',
      settled: [],
      assumptions: [],
    });
    expect(late.session.turns.filter((t) => t.role === 'planner')).toHaveLength(3);
  });

  it('refuses an answer whose reading is not on the question, empty own words, and an action with nothing pending', async () => {
    const planId = await plannedPlan();
    const opened = await aiSharpenService.open({ planId }, pctx);
    succeed(opened.jobId!, questionTurn());
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    const id = opened.session.id;
    await expect(
      aiSharpenService.act(id, 'answer', { readingId: 'z' }, pctx),
    ).rejects.toBeInstanceOf(errors.SharpenActionInvalidError);
    await expect(
      aiSharpenService.act(id, 'own_words', { text: '  ' }, pctx),
    ).rejects.toBeInstanceOf(errors.SharpenActionInvalidError);

    await adminDb.$executeRaw`UPDATE sharpen_session SET pending_question = NULL WHERE id = ${id}`;
    await expect(aiSharpenService.act(id, 'skip', {}, pctx)).rejects.toBeInstanceOf(
      errors.SharpenActionInvalidError,
    );
  });
});

describe('resubmit after a failed submit', () => {
  it('leaves the turn with no job, then submits exactly one job for it, once', async () => {
    const { sessionId } = await openWithQuestion();
    jobs.failNext = new MotirAiOutOfCreditsError('org is out of credits');
    await expect(
      aiSharpenService.act(sessionId, 'answer', { readingId: 'a' }, pctx),
    ).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);

    const session = await aiSharpenService.get(sessionId, pctx);
    const turn = session.turns.at(-1)!;
    expect(turn).toMatchObject({ role: 'person', action: 'answer', jobId: null });

    const sent = jobs.submitted.length;
    const first = await aiSharpenService.resubmit(sessionId, turn.id, pctx);
    expect(jobs.submitted).toHaveLength(sent + 1);
    const second = await aiSharpenService.resubmit(sessionId, turn.id, pctx);
    expect(jobs.submitted).toHaveLength(sent + 1);
    expect(second.jobId).toBe(first.jobId);
  });
});

describe('reads', () => {
  it('get answers 404-shaped for another person’s session; getOpenFor answers the open one or null', async () => {
    const planId = await plannedPlan();
    expect(await aiSharpenService.getOpenFor({ planId }, pctx)).toBeNull();
    const opened = await aiSharpenService.open({ planId }, pctx);
    expect((await aiSharpenService.getOpenFor({ planId }, pctx))?.id).toBe(opened.session.id);

    const other = await colleague('member');
    await expect(aiSharpenService.get(opened.session.id, other)).rejects.toBeInstanceOf(
      errors.SharpenSessionNotFoundError,
    );
  });
});

// Subtask MOTIR-8450 — the `run` hole: what the run is planning and which card.
describe('the run hole', () => {
  async function runPlan(targetKeys: string[], turns: Array<['user' | 'assistant', string]>) {
    const plan = await plansService.createPlan(
      fx.projectId,
      { title: 'Being planned', authorSource: 'native', authorHarness: 'Motir' },
      fx.ctx,
    );
    const session = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        scopeKey: targetKeys.join(','),
        targetKeys,
      },
    });
    let seq = 0;
    for (const [role, body] of turns) {
      seq += 1;
      await adminDb.planChangeTurn.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, seq, role, body },
      });
    }
    await adminDb.plan.update({ where: { id: plan.id }, data: { sessionId: session.id } });
    return plan.id;
  }

  const sharpenOf = (i = 0) => jobs.submitted[i]!.context.sharpen as Record<string, unknown>;

  it('carries the plan, the person’s requests, the anchor card and the settled requirement', async () => {
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'Shared export presets' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Other' });
    const keys = [card.identifier, other.identifier].sort();
    const anchor = keys[0] === card.identifier ? card : other;
    const planId = await runPlan(keys, [
      ['user', 'Plan shared export presets'],
      ['assistant', 'Which team?'],
      ['user', 'The finance team, and keep CSV order.'],
    ]);
    await adminDb.plan.update({
      where: { id: planId },
      data: {
        sharpenedRequirement: {
          behaviour: '- Who? — Finance.',
          plannerAssumptions: [{ question: 'Q', recommendation: 'R' }],
          settledAt: '2026-10-13T00:00:00.000Z',
        },
      },
    });

    await aiSharpenService.open({ planId }, pctx);
    expect(sharpenOf().run).toEqual({
      planId,
      requests: ['Plan shared export presets', 'The finance team, and keep CSV order.'],
      card: { key: anchor.identifier, title: anchor.title },
      requirement: { behaviour: '- Who? — Finance.' },
    });
  });

  it('sends card: null on a project-wide run, and no requirement key when none is settled', async () => {
    const planId = await runPlan([], [['user', 'Plan the quarter']]);
    await aiSharpenService.open({ planId }, pctx);
    const run = sharpenOf().run as Record<string, unknown>;
    expect(run).toEqual({ planId, requests: ['Plan the quarter'], card: null });
    expect('requirement' in run).toBe(false);
  });

  it('is ABSENT for a plan with no conversation and a conversation with no request', async () => {
    const plain = await plannedPlan();
    await aiSharpenService.open({ planId: plain }, pctx);
    expect('run' in sharpenOf(0)).toBe(false);

    const silent = await runPlan([], []);
    await aiSharpenService.open({ planId: silent }, pctx);
    expect('run' in sharpenOf(1)).toBe(false);
  });

  it('rides every turn from stored state; extra body keys cannot reach it', async () => {
    const planId = await runPlan([], [['user', 'Plan the quarter']]);
    const opened = await aiSharpenService.open({ planId }, pctx);
    succeed(opened.jobId!, questionTurn());
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);

    await aiSharpenService.act(
      opened.session.id,
      'answer',
      { readingId: 'a', run: { planId: 'injected' } } as unknown as { readingId: string },
      pctx,
    );
    expect(sharpenOf(1).run).toEqual(sharpenOf(0).run);
  });
});

// Story MOTIR-9221 · Subtask MOTIR-9314 — "Grill me" on the CONVERSATION, before any
// plan exists. The session targets the plan-change conversation; nothing it does
// creates a plan, takes a lock or writes a card.
describe('a conversation target', () => {
  async function conversation(
    turns: Array<['user' | 'assistant', string]>,
    over: { targetKeys?: string[]; createdById?: string; endedAt?: Date; origin?: 'mcp' } = {},
  ) {
    const session = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: over.createdById ?? fx.ownerId,
        scopeKey: (over.targetKeys ?? []).join(','),
        targetKeys: over.targetKeys ?? [],
        lastActivityAt: new Date('2026-01-01T00:00:00.000Z'),
        ...(over.origin ? { origin: over.origin } : {}),
        ...(over.endedAt ? { endedAt: over.endedAt, endReason: 'idle' as const } : {}),
      },
    });
    let seq = 0;
    for (const [role, body] of turns) {
      await adminDb.planChangeTurn.create({
        data: { workspaceId: fx.workspaceId, sessionId: session.id, seq: seq++, role, body },
      });
    }
    return session.id;
  }

  const sharpenOf = (i = 0) => jobs.submitted[i]!.context.sharpen as Record<string, unknown>;

  async function counts() {
    return {
      plans: await adminDb.plan.count(),
      locks: await adminDb.planTargetLock.count(),
      revisions: await adminDb.workItemRevision.count({ where: { changeKind: 'updated' } }),
    };
  }

  it('opens one session and one start turn, grounded in the conversation, and makes no plan or lock', async () => {
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'Shared export presets' });
    const conversationId = await conversation(
      [
        ['user', 'Add shared export presets'],
        ['assistant', 'Presets would sit beside the export button.'],
        ['user', 'For the finance team.'],
      ],
      { targetKeys: [card.identifier] },
    );
    const before = await counts();

    const opened = await aiSharpenService.open({ conversationId }, pctx);
    expect(opened.outcome).toBe('sharpening');
    expect(opened.session.scope).toEqual({ kind: 'conversation', conversationId });
    expect(opened.session.turns).toHaveLength(1);
    expect(jobs.submitted).toHaveLength(1);
    expect(sharpenOf()).toMatchObject({
      scope: { kind: 'conversation', ref: conversationId },
      conversation: {
        requests: ['Add shared export presets', 'For the finance team.'],
        readAnswer: 'Presets would sit beside the export button.',
        card: { key: card.identifier, title: card.title },
      },
    });
    expect('run' in sharpenOf()).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it('sends readAnswer: null and card: null before Motir AI has answered, project-wide', async () => {
    const conversationId = await conversation([['user', 'Plan the quarter']]);
    await aiSharpenService.open({ conversationId }, pctx);
    expect(sharpenOf().conversation).toEqual({
      requests: ['Plan the quarter'],
      readAnswer: null,
      card: null,
    });
  });

  it('resumes the open session without sending, and two opens at once leave one session', async () => {
    const conversationId = await conversation([['user', 'Plan the quarter']]);
    const [a, b] = await Promise.all([
      aiSharpenService.open({ conversationId }, pctx),
      aiSharpenService.open({ conversationId }, pctx),
    ]);
    expect(a.session.id).toBe(b.session.id);
    expect(await sessionCount()).toBe(1);
    const again = await aiSharpenService.open({ conversationId }, pctx);
    expect(again.outcome).toBe('resumed');
    expect(again.jobId).toBeNull();
    expect(jobs.submitted).toHaveLength(1);
  });

  it('refuses a conversation with no request, writing nothing and sending nothing', async () => {
    const conversationId = await conversation([]);
    await expect(aiSharpenService.open({ conversationId }, pctx)).rejects.toBeInstanceOf(
      errors.SharpenActionInvalidError,
    );
    expect(await sessionCount()).toBe(0);
    expect(jobs.submitted).toHaveLength(0);
  });

  it('answers 404-shaped for another person’s, another project’s or a non-conversation session', async () => {
    const member = await colleague('member');
    const theirs = await conversation([['user', 'Mine']], { createdById: member.userId });
    const mcp = await conversation([['user', 'Over MCP']], { origin: 'mcp' });
    for (const conversationId of [theirs, mcp, 'nope']) {
      await expect(aiSharpenService.open({ conversationId }, pctx)).rejects.toBeInstanceOf(
        errors.SharpenTargetNotAvailableError,
      );
    }
    expect(await sessionCount()).toBe(0);
  });

  it('gates on ai:plan: a viewer is refused, a member (no plan to view) is admitted', async () => {
    const viewer = await colleague('viewer');
    const viewerConv = await conversation([['user', 'Read only']], { createdById: viewer.userId });
    await expect(
      aiSharpenService.open({ conversationId: viewerConv }, viewer),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const member = await colleague('member');
    const memberConv = await conversation([['user', 'Plan it']], { createdById: member.userId });
    expect((await aiSharpenService.open({ conversationId: memberConv }, member)).outcome).toBe(
      'sharpening',
    );
  });

  it('refuses to open on an ended conversation, but a session on one that ended still stops', async () => {
    const ended = await conversation([['user', 'Too late']], { endedAt: new Date() });
    await expect(aiSharpenService.open({ conversationId: ended }, pctx)).rejects.toBeInstanceOf(
      errors.SharpenTargetClosedError,
    );

    const conversationId = await conversation([['user', 'Plan the quarter']]);
    const opened = await aiSharpenService.open({ conversationId }, pctx);
    succeed(opened.jobId!, questionTurn());
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    await adminDb.planChangeSession.update({
      where: { id: conversationId },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    await expect(
      aiSharpenService.act(opened.session.id, 'answer', { readingId: 'a' }, pctx),
    ).rejects.toBeInstanceOf(errors.SharpenTargetClosedError);
    await expect(aiSharpenService.act(opened.session.id, 'stop', {}, pctx)).resolves.toBeTruthy();
  });

  it('each turn keeps the conversation alive; an ended one is left as it ended', async () => {
    const conversationId = await conversation([['user', 'Plan the quarter']]);
    const activity = async () =>
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: conversationId } }))
        .lastActivityAt;
    const stale = await activity();
    const opened = await aiSharpenService.open({ conversationId }, pctx);
    expect((await activity()).getTime()).toBeGreaterThan(stale.getTime());

    const endedAt = new Date('2026-02-01T00:00:00.000Z');
    await adminDb.planChangeSession.update({
      where: { id: conversationId },
      data: { endedAt, endReason: 'idle', lastActivityAt: endedAt },
    });
    succeed(opened.jobId!, questionTurn());
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    expect((await activity()).toISOString()).toBe(endedAt.toISOString());
  });

  it('ends with writeBack null even when the job reports one, and the card is untouched', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Export' });
    const conversationId = await conversation([['user', 'Export invoices']], {
      targetKeys: [card.identifier],
    });
    const before = await counts();
    const opened = await aiSharpenService.open({ conversationId }, pctx);
    succeed(opened.jobId!, {
      kind: 'finished',
      question: null,
      settled: SETTLED,
      assumptions: [],
      writeBack: { ok: true },
    });
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    const read = await aiSharpenService.get(opened.session.id, pctx);
    expect(read.status).toBe('ended');
    expect(read.writeBack).toBeNull();
    expect(await counts()).toEqual(before);
    expect(
      (await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } })).descriptionMd,
    ).toBe(card.descriptionMd);
  });

  it('getSettledForConversation: null before a grilling, then the latest session’s answers', async () => {
    const conversationId = await conversation([['user', 'Export invoices']]);
    expect(await aiSharpenService.getSettledForConversation(conversationId, pctx)).toBeNull();

    const opened = await aiSharpenService.open({ conversationId }, pctx);
    succeed(opened.jobId!, questionTurn(QUESTION, SETTLED));
    await aiSharpenService.settle(opened.session.id, opened.jobId!, pctx);
    expect(await aiSharpenService.getSettledForConversation(conversationId, pctx)).toEqual({
      sessionId: opened.session.id,
      status: 'open',
      endReason: null,
      settled: SETTLED,
      assumptions: [],
      requests: ['Export invoices'],
    });

    const stopped = await aiSharpenService.act(opened.session.id, 'stop', {}, pctx);
    succeed(stopped.jobId!, {
      kind: 'stopped',
      question: null,
      settled: SETTLED,
      assumptions: [],
      writeBack: null,
    });
    await aiSharpenService.settle(opened.session.id, stopped.jobId!, pctx);
    expect(await aiSharpenService.getSettledForConversation(conversationId, pctx)).toMatchObject({
      status: 'ended',
      endReason: 'stopped',
      settled: SETTLED,
    });
  });
});
