import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { InvalidPlanSessionCursorError } from '@/lib/planChange/errors';
import { plansService } from '@/lib/services/plansService';
import { homeService } from '@/lib/services/homeService';
import { usersService } from '@/lib/services/usersService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { PLAN_SESSION_STATE_VALUES } from '@/lib/dto/planSessions';
import { createTestProject } from '../../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { addToProjectAs } from '../../helpers/workspaceRoleFixtures';

// MOTIR-6025 — the Plans page lists planning SESSIONS (`agent-authored-plans.md`
// AMENDMENT 17 §8). Real Postgres, the real service and repository; only the
// motir-ai boundary is mocked (a conversation's first turn submits nothing, but
// the service module graph imports the client).

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-list' })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
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

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planSessionsService } = await import('@/lib/services/planSessionsService');

let fx: WorkItemFixture;

function pctx(userId = fx.ownerId): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}

/** Pin a session's activity so the list's order is the test's, not the clock's. */
async function activeAt(sessionId: string, at: Date) {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: at },
  });
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

/**
 * A NEW, OPEN conversation in the project scope. A member's open session is
 * resumed at any age (AMENDMENT 23 §3), so a second first turn would land on the
 * first: each one after the first is written directly, with its one user turn.
 */
let aged = 0;
async function freshSession(body: string): Promise<string> {
  aged += 1;
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: PROJECT_SCOPE.scopeKey,
      targetKeys: [],
      turnCount: 1,
      lastActivityAt: minutesAgo(180 + aged),
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: fx.workspaceId,
      sessionId: s.id,
      seq: 0,
      role: 'user',
      body,
      authorId: fx.ownerId,
    },
  });
  return s.id;
}

/** A plan written straight onto a session, in the status the case needs. */
let planTick = 0;
async function holdPlan(
  sessionId: string,
  status: 'generating' | 'planned' | 'stale' | 'approved' | 'declined' = 'generating',
) {
  return adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      createdById: fx.ownerId,
      createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, ++planTick)),
    },
  });
}

/** A conversation that REACHED planning — the only kind the list shows (MOTIR-9300). */
async function plannedSession(body: string): Promise<string> {
  const id = await freshSession(body);
  await holdPlan(id);
  return id;
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('every session of the project is listed, newest activity first', () => {
  it('an MCP plan’s session, a backfilled one and a conversation once it holds a plan — each titled right', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      buildScope(['ACME-1']),
      '  Split invoicing out of billing  ',
    );
    await activeAt(convo.id, minutesAgo(1));

    const agent = await plansService.createPlan(
      fx.projectId,
      { title: 'Agent-authored plan', session: { origin: 'mcp' }, authorSource: 'mcp' },
      fx.ctx,
    );
    const agentSession = (await adminDb.plan.findUniqueOrThrow({ where: { id: agent.id } }))
      .sessionId!;
    await activeAt(agentSession, minutesAgo(2));

    const legacy = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        origin: 'legacy',
        lastActivityAt: minutesAgo(3),
      },
    });
    const legacyPlan = await plansService.createPlan(
      fx.projectId,
      { summary: 'An old plan named only in prose', session: { sessionId: legacy.id } },
      fx.ctx,
    );

    // The conversation has not reached planning yet, so it is not a row (MOTIR-9300).
    const before = await planSessionsService.listSessions(fx.projectId, fx.ctx);
    expect(before.sessions.map((s) => s.id)).toEqual([agentSession, legacy.id]);

    await holdPlan(convo.id);
    await activeAt(convo.id, minutesAgo(1));
    const page = await planSessionsService.listSessions(fx.projectId, fx.ctx);

    expect(page.nextCursor).toBeNull();
    expect(page.sessions.map((s) => s.id)).toEqual([convo.id, agentSession, legacy.id]);
    const [c, a, l] = page.sessions;
    expect(c).toMatchObject({
      origin: 'conversation',
      firstTurn: 'Split invoicing out of billing',
      targetKeys: ['ACME-1'],
      latestPlan: { status: 'generating' },
      planCount: 1,
      startedBy: { id: fx.ownerId },
    });
    expect(a).toMatchObject({
      origin: 'mcp',
      firstTurn: null,
      latestPlan: { id: agent.id, status: 'generating', title: 'Agent-authored plan' },
      planCount: 1,
    });
    // The backfilled session has no starter and no turn; its title falls back
    // to its plan's summary.
    expect(l).toMatchObject({
      origin: 'legacy',
      startedBy: null,
      latestPlan: { id: legacyPlan.id, title: 'An old plan named only in prose' },
    });
  });

  it('a row states its LATEST plan, and counts the earlier ones', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'go');
    const first = await plansService.createPlan(
      fx.projectId,
      { title: 'first', session: { sessionId: convo.id } },
      fx.ctx,
    );
    await adminDb.plan.update({
      where: { id: first.id },
      data: { status: 'declined', createdAt: minutesAgo(10) },
    });
    const second = await plansService.createPlan(
      fx.projectId,
      { title: 'second', session: { sessionId: convo.id } },
      fx.ctx,
    );

    const [row] = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;

    expect(row!.latestPlan).toMatchObject({ id: second.id, status: 'generating' });
    expect(row!.planCount).toBe(2);
  });

  it('an ENDED session carries its end, and a COPY names the one it continues (MOTIR-7642)', async () => {
    const source = await plannedSession('the old attempt');
    const endedAt = minutesAgo(30);
    await adminDb.planChangeSession.update({
      where: { id: source },
      data: { endedAt, endReason: 'failed' },
    });
    const copy = await plannedSession('the old attempt');
    await adminDb.planChangeSession.update({
      where: { id: copy },
      data: { copiedFromSessionId: source, lastActivityAt: minutesAgo(1) },
    });

    const rows = (await planSessionsService.listSessions(fx.projectId, fx.ctx)).sessions;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(source)).toMatchObject({
      state: 'closed',
      endedAt: endedAt.toISOString(),
      endReason: 'failed',
      endedBy: null,
      copiedFrom: null,
    });
    expect(byId.get(copy)).toMatchObject({
      endedAt: null,
      copiedFrom: { id: source, endedAt: endedAt.toISOString() },
    });
  });

  it('is ONE statement per page — no per-row plan or turn read', async () => {
    for (let i = 0; i < 4; i += 1) {
      const id = await freshSession(`t${i}`);
      await plansService.createPlan(fx.projectId, { session: { sessionId: id } }, fx.ctx);
    }

    const calls: string[] = [];
    const rows = await adminDb.$transaction(async (tx) => {
      const counted = new Proxy(tx, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          // `$queryRaw` delegates to `$queryRawInternal` through the receiver;
          // that is the same statement, not a second one.
          if (
            typeof prop === 'string' &&
            !prop.startsWith('_') &&
            prop !== 'then' &&
            !prop.endsWith('Internal')
          ) {
            calls.push(prop);
          }
          return value;
        },
      });
      return planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          limit: 10,
          after: null,
          state: null,
        },
        counted,
      );
    });

    expect(rows).toHaveLength(4);
    expect(calls).toEqual(['$queryRaw']);
  });
});

describe('the plan-state filter', () => {
  it('narrows the list, and the counts match a walk of every filter', async () => {
    const make = async (status: 'planned' | 'approved' | null, n: number) => {
      for (let i = 0; i < n; i += 1) {
        const id = await freshSession('x');
        if (status) {
          const plan = await plansService.createPlan(
            fx.projectId,
            { session: { sessionId: id } },
            fx.ctx,
          );
          await adminDb.plan.update({ where: { id: plan.id }, data: { status } });
        }
      }
    };
    await make(null, 3);
    await make('planned', 2);
    await make('approved', 1);

    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    // The three plan-less conversations are neither counted nor listed (MOTIR-9300).
    expect(counts).toEqual({
      none: 0,
      generating: 0,
      waiting: 0,
      planned: 2,
      approving: 0,
      stale: 0,
      approved: 1,
      declined: 0,
      closed: 0,
    });
    for (const planState of PLAN_SESSION_STATE_VALUES) {
      if (planState === 'none') continue;
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, { planState });
      expect({ planState, n: page.sessions.length }).toEqual({ planState, n: counts[planState] });
      for (const s of page.sessions) expect(s.latestPlan?.status).toBe(planState);
    }
    // `?planState=none` no longer names a segment: it reads as All.
    const all = await planSessionsService.listSessions(fx.projectId, fx.ctx);
    const none = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
      planState: 'none',
    });
    expect(none.sessions.map((s) => s.id)).toEqual(all.sessions.map((s) => s.id));
    expect(all.sessions).toHaveLength(3);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(all.sessions.length);
  });

  it('walks EVERY page of the list without one plan-less row, and the counts agree', async () => {
    for (let i = 0; i < 3; i += 1) await freshSession(`plan-less ${i}`);
    const held: string[] = [];
    for (let i = 0; i < 5; i += 1) held.push(await plannedSession(`planned ${i}`));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        cursor,
        limit: 2,
      });
      seen.push(...page.sessions.map((s) => s.id));
      for (const s of page.sessions) expect(s.latestPlan).not.toBeNull();
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(new Set(seen)).toEqual(new Set(held));
    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    expect(counts.none).toBe(0);
    expect(counts.generating).toBe(5);
    const mine = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx, {
      view: 'mine',
    });
    expect(mine).toEqual(counts);
    const minePage = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
      view: 'mine',
    });
    expect(new Set(minePage.sessions.map((s) => s.id))).toEqual(new Set(held));
  });

  it('the unfiltered repository door still reads a plan-less session as `none`', async () => {
    const id = await freshSession('x');
    const rows = await adminDb.$transaction((tx) =>
      planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          limit: 10,
          after: null,
          state: null,
        },
        tx,
      ),
    );
    expect(rows.map((r) => [r.id, r.state])).toEqual([[id, 'none']]);
  });
});

describe('a session whose attempt FAILED (Story MOTIR-7905 · MOTIR-7921 / MOTIR-7944)', () => {
  const FAILED = {
    failedAt: new Date('2026-09-23T00:00:00.000Z'),
    failedJobId: 'job-1',
    failureReason: 'rate_limited' as const,
    failureStopPhase: 'author' as const,
    failureStopRef: 'planItem:abc',
    failureStopTitle: 'Export',
  };
  let tick = 0;
  const mkPlan = (sessionId: string, status: 'generating' | 'planned' | 'stale' | 'declined') =>
    adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId,
        status,
        createdById: fx.ownerId,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, ++tick)),
      },
    });
  const rowOf = async (id: string) =>
    (await planSessionsService.listSessions(fx.projectId, fx.ctx, {})).sessions.find(
      (s) => s.id === id,
    )!;

  it('an open failed walk reads WAITING (not Writing), with its stop record on the row', async () => {
    const id = await freshSession('x');
    await adminDb.planChangeSession.update({ where: { id }, data: FAILED });
    await mkPlan(id, 'generating');
    const row = await rowOf(id);
    expect(row.state).toBe('waiting');
    expect(row.failure).toMatchObject({
      reason: 'rate_limited',
      stopPhase: 'author',
      stopTitle: 'Export',
    });
    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    expect(counts.waiting).toBe(1);
    expect(counts.generating).toBe(0);
    const filtered = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
      planState: 'waiting',
    });
    expect(filtered.sessions.map((s) => s.id)).toEqual([id]);
  });

  it('an open failed session with NO plan is not on the list or the counts — it is on To resume (MOTIR-9300)', async () => {
    const id = await freshSession('x');
    await adminDb.planChangeSession.update({ where: { id }, data: FAILED });
    expect((await rowOf(id)) ?? null).toBeNull();
    const counts = await planSessionsService.countSessionsByPlanState(fx.projectId, fx.ctx);
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    const resume = await homeService.listToResume({ ...fx.ctx, projectId: fx.projectId });
    expect(resume.planningSessions?.map((s) => s.sessionId)).toEqual([id]);
    // The landing door still finds it by id, so its own link keeps working.
    expect((await planSessionsService.getSessionRow(fx.projectId, id, fx.ctx))?.state).toBe(
      'waiting',
    );
  });

  it('a failure BESIDE a waiting plan reads the PLAN’s state — never Closed, not waiting — with the failure on the row', async () => {
    const id = await freshSession('x');
    await adminDb.planChangeSession.update({ where: { id }, data: FAILED });
    const waiting = await mkPlan(id, 'planned');
    const row = await rowOf(id);
    expect(row.state).toBe('planned');
    expect(row.latestPlan?.id).toBe(waiting.id);
    expect(row.failure?.reason).toBe('rate_limited');
    // …and a stale plan reads out of date.
    await adminDb.plan.update({ where: { id: waiting.id }, data: { status: 'stale' } });
    expect((await rowOf(id)).state).toBe('stale');
  });

  it('a session a failure ENDED before this story still holding a waiting plan reads that plan, and is known by it', async () => {
    const id = await freshSession('x');
    const waiting = await mkPlan(id, 'planned');
    await mkPlan(id, 'declined'); // the later, failed attempt — the LATEST plan
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'failed' },
    });
    const row = await rowOf(id);
    expect(row.state).toBe('planned');
    expect(row.latestPlan?.id).toBe(waiting.id);
    expect(row.failure ?? null).toBeNull();
  });

  it('a `restarted` end holding a waiting plan reads waiting for approval; an `idle` one stays Closed', async () => {
    const restarted = await freshSession('r');
    await mkPlan(restarted, 'planned');
    await adminDb.planChangeSession.update({
      where: { id: restarted },
      data: { endedAt: new Date(), endReason: 'restarted' },
    });
    const idle = await freshSession('i');
    await mkPlan(idle, 'planned');
    await adminDb.planChangeSession.update({
      where: { id: idle },
      data: { endedAt: new Date(), endReason: 'idle' },
    });
    expect((await rowOf(restarted)).state).toBe('planned');
    expect((await rowOf(idle)).state).toBe('closed');
  });

  it('an ended failure with NO waiting plan stays Closed', async () => {
    const id = await freshSession('x');
    await mkPlan(id, 'declined');
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'failed' },
    });
    expect((await rowOf(id)).state).toBe('closed');
  });
});

describe('paging', () => {
  it('neither skips nor repeats a row when sessions SHARE a lastActivityAt across a boundary', async () => {
    const same = minutesAgo(5);
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await plannedSession(`t${i}`);
      ids.push(id);
    }
    for (const id of ids) {
      await activeAt(id, same);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await planSessionsService.listSessions(fx.projectId, fx.ctx, {
        cursor,
        limit: 2,
      });
      seen.push(...page.sessions.map((s) => s.id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    // Ties break on id, descending.
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it('clamps an absurd limit, and refuses a cursor it did not mint', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'x');
    await holdPlan(convo.id);
    expect(
      (await planSessionsService.listSessions(fx.projectId, fx.ctx, { limit: 0 })).sessions,
    ).toHaveLength(1);
    expect(
      (await planSessionsService.listSessions(fx.projectId, fx.ctx, { limit: Number.NaN }))
        .sessions,
    ).toHaveLength(1);
    await expect(
      planSessionsService.listSessions(fx.projectId, fx.ctx, { cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidPlanSessionCursorError);
  });
});

describe('one row by id — the `?session=` landing', () => {
  it('returns the row, and null for an id from another project', async () => {
    const mine = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'mine');
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSW',
    });
    const theirs = await planChangeSessionsService.startWithFirstTurn(
      { ...pctx(), projectId: elsewhere.id, project: elsewhere },
      PROJECT_SCOPE,
      'theirs',
    );

    expect((await planSessionsService.getSessionRow(fx.projectId, mine.id, fx.ctx))?.id).toBe(
      mine.id,
    );
    expect(await planSessionsService.getSessionRow(fx.projectId, theirs.id, fx.ctx)).toBeNull();
  });

  it('`planOnly` returns no row for a plan-less session, and the row once it holds a plan (MOTIR-9300)', async () => {
    const convo = await planChangeSessionsService.startWithFirstTurn(pctx(), PROJECT_SCOPE, 'x');
    const only = { planOnly: true };
    expect(
      await planSessionsService.getSessionRow(fx.projectId, convo.id, fx.ctx, only),
    ).toBeNull();
    // The reader-scope door is not narrowed: the conversation still opens by id.
    expect((await planChangeSessionsService.getByIdForReader(pctx(), convo.id)).id).toBe(convo.id);
    expect(await planSessionsService.isSessionInReaderScope(fx.projectId, convo.id, fx.ctx)).toBe(
      true,
    );

    await holdPlan(convo.id, 'declined');
    expect(
      (await planSessionsService.getSessionRow(fx.projectId, convo.id, fx.ctx, only))?.state,
    ).toBe('declined');
    const generating = await plannedSession('y');
    expect(
      (await planSessionsService.getSessionRow(fx.projectId, generating, fx.ctx, only))?.state,
    ).toBe('generating');
  });
});

describe('browse is the permission', () => {
  it('a browse-only member sees every session, someone else’s included', async () => {
    const owners = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'owner’s',
    );
    await holdPlan(owners.id);
    const viewer = await usersService.createUser({
      email: 'viewer-6025@example.com',
      password: 'correct-horse-battery-staple-9',
      name: 'Viewer',
    });
    await adminDb.workspaceMembership.create({
      data: {
        userId: viewer.id,
        workspaceId: fx.workspaceId,
        workspaceRole: 'member',
      },
    });
    await addToProjectAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: viewer.id,
      role: 'viewer',
    });

    const page = await planSessionsService.listSessions(fx.projectId, {
      userId: viewer.id,
      workspaceId: fx.workspaceId,
    });
    expect(page.sessions.map((s) => s.firstTurn)).toEqual(['owner’s']);
  });
});

describe('the repository reads the overlay leans on (MOTIR-6024)', () => {
  it('the latest conversation of a scope with nothing excluded, and a starter-less session', async () => {
    const id = await plannedSession('only one');
    const orphan = await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, origin: 'legacy' },
    });

    const [latest, starter, none] = await adminDb.$transaction(async (tx) => [
      await planChangeSessionRepository.findLatestConversationInScope(
        fx.projectId,
        '',
        fx.workspaceId,
        null,
        tx,
      ),
      await planChangeSessionRepository.findStarter(id, fx.workspaceId, tx),
      await planChangeSessionRepository.findStarter(orphan.id, fx.workspaceId, tx),
    ]);

    expect(latest?.id).toBe(id);
    expect(starter?.id).toBe(fx.ownerId);
    expect(none).toBeNull();
  });
});
