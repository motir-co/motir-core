import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { buildScope } from '@/lib/planChange/scope';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleDefinitionFor,
} from '../../helpers/workspaceRoleFixtures';

// Story MOTIR-9221 · Subtask MOTIR-9318 — the SEAM: "Grill me" on a conversation
// before any plan exists, driven through the real services against the real
// Postgres. Only the motir-ai client is faked, by a recording spy that captures
// every submitted context; there is no fake clock — the lease cases backdate
// `lastActivityAt` and pass `now` to the real idle close.
//
// The claims that matter are NEGATIVE or cross a transaction: no plan row, no new
// target lock, no gate, no write-back, no carried key. Each is asserted on rows or
// on recorded calls, never on a return value alone.

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
const { planSharpeningService } = await import('@/lib/services/planSharpeningService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');
const { closeIdleSessions } = await import('@/lib/services/planSessionEndService');
const { planningSessionGateService } = await import('@/lib/services/planningSessionGateService');
const { MotirAiConfigError, MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { PermissionDeniedError, ProjectAccessDeniedError } = await import('@/lib/projects/errors');
const { PlanSessionEndedError } = await import('@/lib/planChange/errors');
const errors = await import('@/lib/sharpening/errors');

const MIN = 60 * 1000;

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  process.env['MOTIR_AI_URL'] = 'http://motir-ai.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  jobs.next = 0;
  jobs.submitted = [];
  jobs.results.clear();
  jobs.failNext = null;
  vi.restoreAllMocks();
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  pctx = ctxFor(fx.ownerId);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxFor(userId: string, f: WorkItemFixture = fx): ProjectContext {
  return { userId, workspaceId: f.workspaceId, projectId: f.projectId, project: f.project };
}

const REQUEST = 'Make exports better';
const ANSWER = 'Exports today are CSV only, from the issue list.';

const QUESTION = (id: string, text: string) => ({
  id,
  text,
  topic: 'workflow',
  because: null,
  quote: null,
  readings: [
    { id: 'a', label: 'The finance team', detail: 'They export monthly', recommended: true },
    { id: 'b', label: 'Everyone', detail: '', recommended: false },
  ],
});
const SETTLED = [
  {
    questionId: 'q1',
    question: 'Who exports?',
    answer: 'The finance team',
    topic: 'workflow',
    readingId: 'a',
    source: 'person',
  },
  {
    questionId: 'q2',
    question: 'What is wrong with exports?',
    answer: 'They lose column order',
    topic: 'non_happy',
    readingId: null,
    source: 'person',
  },
];
const ASSUMED = [
  {
    questionId: 'q3',
    question: 'Which formats?',
    recommendation: 'CSV only',
    why: 'Smallest first version',
    source: 'planner',
  },
];

// ── builders ─────────────────────────────────────────────────────────────────

/** A conversation written straight to the store: the person's turns and Motir AI's answers. */
async function conversation(
  turns: Array<['user' | 'assistant', string]> = [
    ['user', REQUEST],
    ['assistant', ANSWER],
  ],
  over: { createdById?: string; targetKeys?: string[]; endedAt?: Date; f?: WorkItemFixture } = {},
): Promise<string> {
  const f = over.f ?? fx;
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      createdById: over.createdById ?? f.ownerId,
      scopeKey: (over.targetKeys ?? []).join(','),
      targetKeys: over.targetKeys ?? [],
      ...(over.endedAt ? { endedAt: over.endedAt, endReason: 'idle' as const } : {}),
    },
  });
  let seq = 0;
  for (const [role, body] of turns) {
    await adminDb.planChangeTurn.create({
      data: { workspaceId: f.workspaceId, sessionId: session.id, seq: seq++, role, body },
    });
  }
  return session.id;
}

/** A conversation opened through the shipped door, so it plans like the rail's. */
async function shippedConversation(): Promise<string> {
  const thread = await openTestSession(pctx);
  await planChangeSessionsService.appendTurn(REQUEST, pctx, addressOf(thread));
  return thread.id;
}

/** Settle the job a door call answered with the given Sharpen turn. */
async function land(sessionId: string, jobId: string, turn: Record<string, unknown>, ctx = pctx) {
  jobs.results.set(jobId, { question: null, writeBack: null, ...turn });
  return aiSharpenService.settle(sessionId, jobId, ctx);
}

const question = (id: string, settled: unknown[] = []) => ({
  kind: 'question',
  question: QUESTION(id, `Question ${id}?`),
  settled,
  assumptions: [],
});

/** start → answer → answer, then the job ends it. Answers the session id. */
async function grillToEnd(conversationId: string, endKind: string): Promise<string> {
  const opened = await aiSharpenService.open({ conversationId }, pctx);
  const id = opened.session.id;
  await land(id, opened.jobId!, question('q1'));
  const a1 = await aiSharpenService.act(id, 'answer', { readingId: 'a' }, pctx);
  await land(id, a1.jobId!, question('q2', SETTLED.slice(0, 1)));
  const a2 = await aiSharpenService.act(id, 'answer', { readingId: 'b' }, pctx);
  await land(id, a2.jobId!, { kind: endKind, settled: SETTLED, assumptions: ASSUMED });
  return id;
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
  return ctxFor(user.id);
}

/** A member on a custom role holding `ai:plan` and NOT `work_item:edit`. */
async function plannerWithoutEdit(): Promise<ProjectContext> {
  const member = await colleague('member');
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'Planner, read-only cards',
    permissions: ['project:browse', 'ai:plan'],
  });
  await setProjectRoleDefinitionFor(member.userId, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return member;
}

/** Everything a conversation grilling must never create. */
async function planningFootprint() {
  return {
    plans: await adminDb.plan.count(),
    locks: await adminDb.planTargetLock.count(),
    planLocks: await adminDb.planTargetLock.count({ where: { planId: { not: null } } }),
    gates: await adminDb.approvalGate.count(),
    sessions: await adminDb.planChangeSession.findMany({
      select: { id: true, origin: true, awaitingPersonCause: true },
      orderBy: { id: 'asc' },
    }),
  };
}

const submissions = (kind = 'sharpen_turn') => jobs.submitted.filter((j) => j.kind === kind);
const planJob = () => jobs.submitted.find((j) => j.kind !== 'sharpen_turn')!;

/** motir-ai's CarriedAnswers wire shape for SETTLED / ASSUMED: no `source`. */
const CARRIED = {
  requests: [REQUEST],
  settled: SETTLED.map(({ source: _source, ...s }) => s),
  assumptions: ASSUMED.map(({ source: _source, ...a }) => a),
};

// ── the target ───────────────────────────────────────────────────────────────

describe('opening the conversation target', () => {
  it('records one sharpen_turn whose context carries the conversation block; the row links the conversation', async () => {
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'Exports' });
    const conversationId = await conversation(undefined, { targetKeys: [card.identifier] });

    const opened = await aiSharpenService.open({ conversationId }, pctx);

    expect(Object.keys(opened).sort()).toEqual(['jobId', 'outcome', 'session', 'turnId']);
    expect(opened.outcome).toBe('sharpening');
    expect(submissions()).toHaveLength(1);
    expect(submissions()[0]!.context['sharpen']).toMatchObject({
      scope: { kind: 'conversation', ref: conversationId },
      conversation: {
        requests: [REQUEST],
        readAnswer: ANSWER,
        card: { key: card.identifier, title: 'Exports' },
      },
    });
    const row = await adminDb.sharpenSession.findUniqueOrThrow({
      where: { id: opened.session.id },
    });
    expect(row).toMatchObject({
      scopeKind: 'conversation',
      planChangeSessionId: conversationId,
      planId: null,
    });
  });

  it('a second open resumes and records no job; two raced opens leave exactly one open row', async () => {
    const conversationId = await conversation();
    const first = await aiSharpenService.open({ conversationId }, pctx);
    const again = await aiSharpenService.open({ conversationId }, pctx);
    expect(again.outcome).toBe('resumed');
    expect(again.session.id).toBe(first.session.id);
    expect(submissions()).toHaveLength(1);

    const raced = await conversation();
    await Promise.all([
      aiSharpenService.open({ conversationId: raced }, pctx),
      aiSharpenService.open({ conversationId: raced }, pctx),
    ]);
    expect(
      await adminDb.sharpenSession.count({
        where: { planChangeSessionId: raced, status: 'open' },
      }),
    ).toBe(1);
  });
});

describe('the gates', () => {
  it('without ai:plan, or with Motir AI not configured, nothing is written or sent', async () => {
    const viewer = await colleague('viewer');
    const viewerConv = await conversation(undefined, { createdById: viewer.userId });
    await expect(
      aiSharpenService.open({ conversationId: viewerConv }, viewer),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    delete process.env['MOTIR_AI_URL'];
    const conversationId = await conversation();
    await expect(aiSharpenService.open({ conversationId }, pctx)).rejects.toBeInstanceOf(
      MotirAiConfigError,
    );

    expect(await adminDb.sharpenSession.count()).toBe(0);
    expect(jobs.submitted).toHaveLength(0);
  });

  it('a person with ai:plan and no work_item:edit is grilled', async () => {
    const planner = await plannerWithoutEdit();
    const conversationId = await conversation(undefined, { createdById: planner.userId });
    expect((await aiSharpenService.open({ conversationId }, planner)).outcome).toBe('sharpening');
  });

  it('another person’s, another project’s or an unknown conversation is not available; nothing is written', async () => {
    const member = await colleague('member');
    const theirs = await conversation(undefined, { createdById: member.userId });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await conversation(undefined, { f: other });
    for (const conversationId of [theirs, foreign, 'no-such-conversation']) {
      await expect(aiSharpenService.open({ conversationId }, pctx)).rejects.toBeInstanceOf(
        errors.SharpenTargetNotAvailableError,
      );
    }
    expect(await adminDb.sharpenSession.count()).toBe(0);
    expect(jobs.submitted).toHaveLength(0);
  });

  it('an ended conversation is closed for open and act, and stop is still accepted', async () => {
    const ended = await conversation(undefined, { endedAt: new Date() });
    await expect(aiSharpenService.open({ conversationId: ended }, pctx)).rejects.toBeInstanceOf(
      errors.SharpenTargetClosedError,
    );

    const conversationId = await conversation();
    const opened = await aiSharpenService.open({ conversationId }, pctx);
    await land(opened.session.id, opened.jobId!, question('q1'));
    await adminDb.planChangeSession.update({
      where: { id: conversationId },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    await expect(
      aiSharpenService.act(opened.session.id, 'answer', { readingId: 'a' }, pctx),
    ).rejects.toBeInstanceOf(errors.SharpenTargetClosedError);
    const stopped = await aiSharpenService.act(opened.session.id, 'stop', {}, pctx);
    expect(stopped.jobId).toBeTruthy();
  });
});

describe('ending a conversation grilling', () => {
  it.each(['nothing_to_ask', 'finished', 'stopped'])(
    'ends %s with its answers stored, writeBack null and no plan write-back call',
    async (kind) => {
      const writeBack = vi.spyOn(planSharpeningService, 'writeBack');
      const conversationId = await conversation();
      const id = await grillToEnd(conversationId, kind);
      const row = await adminDb.sharpenSession.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'ended', endReason: kind, writeBack: null });
      expect(row.settled).toEqual(SETTLED);
      expect(row.assumptions).toEqual(ASSUMED);
      expect(writeBack).not.toHaveBeenCalled();
    },
  );

  it('at no step does a plan, a lock, a gate or a Plans-page row appear; a seeded session lock is only refreshed', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Seeded' });
    const conversationId = await conversation(undefined, { targetKeys: [card.identifier] });
    await adminDb.planTargetLock.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        sessionId: conversationId,
        heldById: fx.ownerId,
        priorStatus: card.status,
        expiresAt: new Date(Date.now() + 5 * MIN),
      },
    });
    const before = await planningFootprint();
    const lockExpiry = async () =>
      (await adminDb.planTargetLock.findFirstOrThrow({ where: { sessionId: conversationId } }))
        .expiresAt;
    const expiryBefore = await lockExpiry();

    const opened = await aiSharpenService.open({ conversationId }, pctx);
    expect(await planningFootprint()).toEqual(before);
    await land(opened.session.id, opened.jobId!, question('q1'));
    expect(await planningFootprint()).toEqual(before);
    const stop = await aiSharpenService.act(opened.session.id, 'stop', {}, pctx);
    expect(await planningFootprint()).toEqual(before);
    await land(opened.session.id, stop.jobId!, { kind: 'stopped', settled: [], assumptions: [] });
    expect(await planningFootprint()).toEqual(before);

    expect((await lockExpiry()).getTime()).toBeGreaterThan(expiryBefore.getTime());
    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);
    expect(page.sessions.map((s) => s.id)).not.toContain(conversationId);
    await planningSessionGateService.raiseAwaitingReplies(new Date(Date.now() + 60 * MIN));
    expect(await adminDb.approvalGate.count()).toBe(0);
  });
});

describe('the lease', () => {
  it('an act 29 minutes after the last turn keeps the conversation open; one idle for 30 minutes ends', async () => {
    const live = await conversation();
    const opened = await aiSharpenService.open({ conversationId: live }, pctx);
    await land(opened.session.id, opened.jobId!, question('q1'));
    const backdate = (id: string, at: Date) =>
      adminDb.planChangeSession.update({ where: { id }, data: { lastActivityAt: at } });
    const activity = async (id: string) =>
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id } })).lastActivityAt;

    await backdate(live, new Date(Date.now() - 29 * MIN));
    const t0 = Date.now();
    const acted = await aiSharpenService.act(opened.session.id, 'answer', { readingId: 'a' }, pctx);
    const actedAt = await activity(live);
    expect(actedAt.getTime()).toBeGreaterThanOrEqual(t0);
    expect(actedAt.getTime()).toBeLessThanOrEqual(Date.now());

    const idle = await conversation();
    await backdate(idle, new Date(Date.now() - 31 * MIN));

    const swept = await closeIdleSessions(new Date());
    expect(swept.sessionIds).toEqual([idle]);
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: idle } })).endReason,
    ).toBe('idle');
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: live } })).endedAt,
    ).toBeNull();

    // Landing the planner turn refreshes it again.
    await backdate(live, new Date(Date.now() - 29 * MIN));
    await land(opened.session.id, acted.jobId!, question('q2', SETTLED.slice(0, 1)));
    expect((await activity(live)).getTime()).toBeGreaterThan(Date.now() - MIN);
    expect((await closeIdleSessions(new Date())).sessionIds).toEqual([]);
  });
});

describe('getSettledForConversation', () => {
  it('answers a stopped and a nothing-to-ask grilling, null with none, and refuses a person who cannot browse', async () => {
    const stopped = await conversation();
    await grillToEnd(stopped, 'stopped');
    expect(await aiSharpenService.getSettledForConversation(stopped, pctx)).toMatchObject({
      status: 'ended',
      endReason: 'stopped',
      settled: SETTLED,
      assumptions: ASSUMED,
    });

    const quiet = await conversation();
    const opened = await aiSharpenService.open({ conversationId: quiet }, pctx);
    await land(opened.session.id, opened.jobId!, {
      kind: 'nothing_to_ask',
      settled: [],
      assumptions: [],
    });
    expect(await aiSharpenService.getSettledForConversation(quiet, pctx)).toMatchObject({
      endReason: 'nothing_to_ask',
      settled: [],
      assumptions: [],
    });

    expect(await aiSharpenService.getSettledForConversation(await conversation(), pctx)).toBeNull();

    const outsider = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { userId: outsider.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
    });
    const err = await aiSharpenService
      .getSettledForConversation(stopped, ctxFor(outsider.id))
      .catch((e: unknown) => e);
    expect(
      err instanceof PermissionDeniedError ||
        err instanceof ProjectAccessDeniedError ||
        err instanceof errors.SharpenTargetNotAvailableError,
    ).toBe(true);
  });
});

// ── the hand-off at plan submit ──────────────────────────────────────────────

describe('plan submit carries the settled answers', () => {
  it('the planning job carries them beside the requirement; the run’s grilling gets them on run.carried', async () => {
    const conversationId = await shippedConversation();
    await grillToEnd(conversationId, 'stopped');
    const requirement = { outcome: 'Exports keep column order' };

    const { planId } = await planChangeSessionsService.submit(
      pctx,
      { sessionId: conversationId },
      requirement,
    );
    expect(planJob().context['requirement']).toEqual(requirement);
    expect(planJob().context['carriedAnswers']).toEqual(CARRIED);

    jobs.submitted = [];
    await aiSharpenService.open({ planId }, pctx);
    const run = (submissions()[0]!.context['sharpen'] as { run: Record<string, unknown> }).run;
    expect(run['carried']).toEqual(CARRIED);
  });

  it('no grilling, a grilling that settled nothing, or a targeted start: the key is absent and the rest unchanged', async () => {
    const contexts: Record<string, unknown>[] = [];
    const plain = await shippedConversation();
    await planChangeSessionsService.submit(pctx, { sessionId: plain });
    contexts.push(planJob().context);

    jobs.submitted = [];
    const empty = await shippedConversation();
    const opened = await aiSharpenService.open({ conversationId: empty }, pctx);
    await land(opened.session.id, opened.jobId!, {
      kind: 'nothing_to_ask',
      settled: [],
      assumptions: [],
    });
    await planChangeSessionsService.submit(pctx, { sessionId: empty });
    contexts.push(planJob().context);

    jobs.submitted = [];
    const card = await createTestWorkItem(fx, { kind: 'story', title: 'Targeted' });
    const targeted = await planChangeSessionsService.openForScope(
      pctx,
      buildScope([card.identifier]),
    );
    await planChangeSessionsService.appendTurn('Plan this', pctx, addressOf(targeted));
    await planChangeSessionsService.submit(pctx, addressOf(targeted));
    contexts.push(planJob().context);

    for (const c of contexts) expect('carriedAnswers' in c).toBe(false);
    // The two project-wide submits differ only in what no carry changes.
    const strip = (c: Record<string, unknown>) =>
      Object.keys(c)
        .filter((k) => k !== 'carriedAnswers')
        .sort();
    expect(strip(contexts[1]!)).toEqual(strip(contexts[0]!));
  });

  it('a revise route sends no carried answers; a guide or ended conversation is refused before any read', async () => {
    const conversationId = await shippedConversation();
    await grillToEnd(conversationId, 'finished');
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    await adminDb.plan.update({ where: { id: planId }, data: { status: 'planned' } });
    const before = jobs.submitted.length;
    const settled = vi.spyOn(aiSharpenService, 'getSettledForConversation');
    await planChangeSessionsService.appendTurn('Make it two presets', pctx, {
      sessionId: conversationId,
    });
    await planChangeSessionsService.submit(pctx, { sessionId: conversationId }).catch(() => null);
    expect(settled).not.toHaveBeenCalled();
    for (const j of jobs.submitted.slice(before)) expect('carriedAnswers' in j.context).toBe(false);

    const guide = await conversation();
    await adminDb.planChangeSession.update({ where: { id: guide }, data: { origin: 'guide' } });
    await expect(planChangeSessionsService.submit(pctx, { sessionId: guide })).rejects.toThrow();

    const ended = await shippedConversation();
    await adminDb.planChangeSession.update({
      where: { id: ended },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    await expect(
      planChangeSessionsService.submit(pctx, { sessionId: ended }),
    ).rejects.toBeInstanceOf(PlanSessionEndedError);
    expect(settled).not.toHaveBeenCalled();
  });

  it('a failed submit keeps the answers stored, and the retried Confirm carries them again', async () => {
    const conversationId = await shippedConversation();
    await grillToEnd(conversationId, 'finished');
    jobs.failNext = new MotirAiUnavailableError('down');
    await expect(
      planChangeSessionsService.submit(pctx, { sessionId: conversationId }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
    expect(
      (await aiSharpenService.getSettledForConversation(conversationId, pctx))?.settled,
    ).toEqual(SETTLED);

    await planChangeSessionsService.submit(pctx, { sessionId: conversationId });
    expect(planJob().context['carriedAnswers']).toEqual(CARRIED);
  });
});
