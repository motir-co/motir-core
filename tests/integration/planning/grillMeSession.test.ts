import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import type { ProjectContext } from '@/lib/projects';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addressOf, openTestSession } from '../../helpers/planSession';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';

// GRILL ME, STORED ON THE SESSION (Story MOTIR-11799 · Subtask MOTIR-11801). The switch
// lives on `plan_change_session`, is set through one `ai:plan`-gated door, is read back
// with the session, is stored at creation when the first message carries it, and rides
// EVERY `ask_project` and `sharpen_turn` job the session submits as `context.grillMe`.
//
// Real Postgres. Mocked: `getSession` / `getActiveProject` (no cookies in tests), the
// motir-ai HTTP boundary, and the plan review the mid-run snapshot reads.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const jobs = vi.hoisted(() => ({
  next: 0,
  submitted: [] as Array<{ kind: string; context: Record<string, unknown> }>,
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async (kind: string, _tenant: unknown, context: Record<string, unknown>) => {
    jobs.submitted.push({ kind, context });
    jobs.next += 1;
    return { jobId: `job-${jobs.next}` };
  }),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
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
vi.mock('@/lib/services/planReviewService', async () => {
  const { planReview } = await import('../../helpers/planReview');
  return {
    planReviewService: {
      getPlanReview: async (_id: string, _plan: string, c: { projectId: string }) =>
        planReview([], { id: 'plan-1', projectId: c.projectId, status: 'generating' }),
    },
  };
});

const { PUT: putGrillMe } = await import('@/app/api/ai/plan-change/session/grill-me/route');
const { POST: ask } = await import('@/app/api/ai/ask/route');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { aiAskService } = await import('@/lib/services/aiAskService');
const { aiSharpenService } = await import('@/lib/services/aiSharpenService');
const { PlanSessionEndedError, PlanSessionNotFoundError } = await import('@/lib/planChange/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

const BASE = 'http://localhost:3000';
const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;
let pctx: ProjectContext;

function actAs(userId: string): ProjectContext {
  session.current = { user: { id: userId, email: `${userId}@example.com`, name: 'Person' } };
  const c = {
    userId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  activeCtx.current = c;
  return c;
}

const put = (body: unknown) =>
  putGrillMe(
    new Request(`${BASE}/api/ai/plan-change/session/grill-me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const postAsk = (body: unknown) =>
  ask(
    new Request(`${BASE}/api/ai/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const row = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const jobsOf = (kind: string) => jobs.submitted.filter((j) => j.kind === kind);

async function memberWith(permissions: string[]): Promise<string> {
  const user = await createTestUser({ name: 'Member' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Role ${permissions.join(' ')}`,
    permissions,
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  return user.id;
}

/** The owner's conversation with one request on it. */
async function conversation(): Promise<string> {
  const thread = await openTestSession(pctx);
  await planChangeSessionsService.appendTurn('Add shared export presets', pctx, addressOf(thread));
  return thread.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  jobs.next = 0;
  jobs.submitted = [];
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc');
  fx = await makeWorkItemFixture();
  pctx = actAs(fx.ownerId);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the stored switch', () => {
  it('a new session starts off', async () => {
    const thread = await openTestSession(pctx);
    expect(thread.grillMe).toBe(false);
    expect((await row(thread.id)).grillMeChangedAt).toBeNull();
  });

  it('turning it on stores it, stamped, and every later read shows it on', async () => {
    const id = await conversation();
    const before = Date.now();

    const set = await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);

    expect(set.grillMe).toBe(true);
    const stored = await row(id);
    expect(stored.grillMe).toBe(true);
    expect(stored.grillMeChangedById).toBe(fx.ownerId);
    expect(stored.grillMeChangedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // A reload, another tab and a reopened conversation all read the session.
    expect((await planChangeSessionsService.getById(pctx, id)).grillMe).toBe(true);
    expect((await planChangeSessionsService.getByIdForReader(pctx, id)).grillMe).toBe(true);
  });

  it('turning it off stores off; setting the same value again keeps the first stamp', async () => {
    const id = await conversation();
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    const stamp = (await row(id)).grillMeChangedAt;

    const again = await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    expect(again.grillMe).toBe(true);
    expect((await row(id)).grillMeChangedAt).toEqual(stamp);

    const off = await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, false);
    expect(off.grillMe).toBe(false);
    expect((await row(id)).grillMe).toBe(false);
  });

  it('an ended session accepts no change', async () => {
    const id = await conversation();
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'restarted' },
    });
    await expect(
      planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true),
    ).rejects.toBeInstanceOf(PlanSessionEndedError);
    expect((await row(id)).grillMe).toBe(false);
  });

  it('a session of another project is not found', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await openTestSession({
      userId: other.ownerId,
      workspaceId: other.workspaceId,
      projectId: other.projectId,
      project: other.project,
    });
    await expect(
      planChangeSessionsService.setGrillMe(pctx, { sessionId: foreign.id }, true),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
  });

  it(
    'is refused for a member without ai:plan, and allowed for one with it',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const id = await conversation();
      const reader = actAs(await memberWith(['project:browse']));
      await expect(
        planChangeSessionsService.setGrillMe(reader, { sessionId: id }, true),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      expect((await row(id)).grillMe).toBe(false);

      const planner = actAs(await memberWith(['project:browse', 'ai:plan']));
      expect(
        (await planChangeSessionsService.setGrillMe(planner, { sessionId: id }, true)).grillMe,
      ).toBe(true);
    },
  );
});

describe('PUT /api/ai/plan-change/session/grill-me', () => {
  it('sets the switch and answers the session', async () => {
    const id = await conversation();
    const res = await put({ sessionId: id, on: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(((await res.json()) as PlanChangeSessionDto).grillMe).toBe(true);
    expect((await row(id)).grillMe).toBe(true);
  });

  it('refuses a reader without ai:plan with 403', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const id = await conversation();
    actAs(await memberWith(['project:browse']));
    const res = await put({ sessionId: id, on: true });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { permission: string }).permission).toBe('ai:plan');
    expect((await row(id)).grillMe).toBe(false);
  });

  it('answers an ended session with 409 PLAN_SESSION_ENDED', async () => {
    const id = await conversation();
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'restarted' },
    });
    const res = await put({ sessionId: id, on: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_ENDED');
  });

  it('answers an unknown session with 404', async () => {
    const res = await put({ sessionId: 'nope', on: true });
    expect(res.status).toBe(404);
  });

  it.each([
    ['a body that is not JSON', '{'],
    ['no sessionId', { on: true }],
    ['an `on` that is not a boolean', { sessionId: 'x', on: 'yes' }],
  ])('refuses %s with 400', async (_label, body) => {
    expect((await put(body)).status).toBe(400);
  });

  it('answers 404 with no active project', async () => {
    activeCtx.current = null;
    expect((await put({ sessionId: 'x', on: true })).status).toBe(404);
  });

  it('answers 401 with no session', async () => {
    session.current = null;
    expect((await put({ sessionId: 'x', on: true })).status).toBe(401);
  });
});

describe('a choice made before the session existed', () => {
  it('the first message stores it on the session it creates, and its job carries it', async () => {
    const res = await postAsk({ body: 'Add shared export presets', grillMe: true });
    expect(res.status).toBe(200);
    const { session: created } = (await res.json()) as { session: PlanChangeSessionDto };

    expect(created.grillMe).toBe(true);
    const stored = await row(created.id);
    expect(stored.grillMe).toBe(true);
    expect(stored.grillMeChangedById).toBe(fx.ownerId);
    expect(jobsOf('ask_project')[0]!.context['grillMe']).toBe(true);
  });

  it('a first message without it starts the session off, and its job says so', async () => {
    const res = await postAsk({ body: 'Add shared export presets' });
    const { session: created } = (await res.json()) as { session: PlanChangeSessionDto };
    expect((await row(created.id)).grillMe).toBe(false);
    expect(jobsOf('ask_project')[0]!.context['grillMe']).toBe(false);
  });

  it('a turn naming its session reads that session, never the body', async () => {
    const id = await conversation();
    await postAsk({ body: 'go on', sessionId: id, grillMe: true });
    expect((await row(id)).grillMe).toBe(false);
    expect(jobsOf('ask_project')[0]!.context['grillMe']).toBe(false);
  });

  it('a resumed session is switched on by the choice, never off', async () => {
    const id = await conversation();
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);

    await planChangeSessionsService.startWithFirstTurn(
      pctx,
      { scopeKey: '', targetKeys: [] },
      'hi',
    );
    expect((await row(id)).grillMe).toBe(true);
  });
});

describe('every ask_project job carries the current value', () => {
  it('a turn on the session, after the switch changes each way', async () => {
    const id = await conversation();
    await aiAskService.submitTurn('first', pctx, { sessionId: id });
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    await aiAskService.submitTurn('second', pctx, { sessionId: id });
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, false);
    await aiAskService.submitTurn('third', pctx, { sessionId: id });

    expect(jobsOf('ask_project').map((j) => j.context['grillMe'])).toEqual([false, true, false]);
  });

  it('a mid-run turn and a re-sent turn', async () => {
    const id = await conversation();
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    const first = (await aiAskService.submitTurn('go on', pctx, { sessionId: id })) as {
      turnId: string;
    };
    await aiAskService.resubmit(first.turnId, pctx, { sessionId: id });
    await adminDb.planChangeSession.update({
      where: { id },
      data: { lastJobId: 'job-run', lastSubmittedAt: new Date() },
    });
    await aiAskService.submitMidRunTurn('how far along?', pctx, {
      sessionId: id,
      runJobId: 'job-run',
      planId: 'plan-1',
    });

    expect(jobsOf('ask_project').map((j) => j.context['grillMe'])).toEqual([true, true, true]);
  });
});

describe('every sharpen_turn job carries the current value', () => {
  it('a grilling on the conversation, read at each submit', async () => {
    const id = await conversation();
    const opened = await aiSharpenService.open({ conversationId: id }, pctx);
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    await aiSharpenService.act(opened.session.id, 'stop', {}, pctx);

    expect(jobsOf('sharpen_turn').map((j) => j.context['grillMe'])).toEqual([false, true]);
    // Beside the turn, never inside it: `context.sharpen` keeps its own shape.
    expect(jobsOf('sharpen_turn')[0]!.context['sharpen']).not.toHaveProperty('grillMe');
  });

  it('a grilling on a plan reads the switch of the conversation that wrote it', async () => {
    const id = await conversation();
    await planChangeSessionsService.setGrillMe(pctx, { sessionId: id }, true);
    const { planId } = await planChangeSessionsService.submit(pctx, { sessionId: id });

    await aiSharpenService.open({ planId }, pctx);
    expect(jobsOf('sharpen_turn')[0]!.context['grillMe']).toBe(true);
  });
});
