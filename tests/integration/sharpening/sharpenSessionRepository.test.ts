import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Task MOTIR-1101 · Subtask MOTIR-8182 — the Sharpen session store, on the real
// Postgres path and as the APPLICATION role (`@/lib/db` connects as the
// non-bypass runtime role; fixtures write through `adminDb` / the services).
// What is pinned here is the raw-SQL half the schema cannot express: the scope
// CHECK, the one-open-session-per-person-per-target partial uniques, the
// one-planner-turn-per-job partial unique, and RLS on BOTH tables.

import { db } from '@/lib/db';
import { sqlStateOf } from '@/lib/prisma/sqlstate';
import { sharpenSessionRepository } from '@/lib/repositories/sharpenSessionRepository';
import { sharpenTurnRepository } from '@/lib/repositories/sharpenTurnRepository';
import { plansService } from '@/lib/services/plansService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function inWs<T>(fx: WorkItemFixture, fn: Parameters<typeof withWorkspaceContext<T>>[1]) {
  return withWorkspaceContext({ workspaceId: fx.workspaceId, userId: fx.ownerId }, fn);
}

async function sqlStateOfRejection(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return sqlStateOf(err);
  }
  return undefined;
}

async function planOf(fx: WorkItemFixture): Promise<string> {
  return (await plansService.createPlan(fx.projectId, { title: 'Sharpen me' }, fx.ctx)).id;
}

/** A plan-change conversation the person owns — a `conversation` scope's target. */
async function conversationOf(fx: WorkItemFixture): Promise<string> {
  return (
    await adminDb.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, createdById: fx.ownerId },
    })
  ).id;
}

function openConversationSession(fx: WorkItemFixture, planChangeSessionId: string) {
  return inWs(fx, (tx) =>
    sharpenSessionRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        scopeKind: 'conversation',
        planChangeSessionId,
      },
      tx,
    ),
  );
}

function openPlanSession(fx: WorkItemFixture, planId: string, userId = fx.ownerId) {
  return inWs(fx, (tx) =>
    sharpenSessionRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: userId,
        scopeKind: 'plan',
        planId,
      },
      tx,
    ),
  );
}

describe('the scope CHECK', () => {
  it('refuses a plan-scoped session with no plan id', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SCA' });
    const state = await sqlStateOfRejection(
      inWs(fx, (tx) =>
        sharpenSessionRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            createdById: fx.ownerId,
            scopeKind: 'plan',
          },
          tx,
        ),
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  it('refuses a session with BOTH a plan id and a conversation id', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SCB' });
    const planId = await planOf(fx);
    const conversationId = await conversationOf(fx);
    const state = await sqlStateOfRejection(
      inWs(fx, (tx) =>
        sharpenSessionRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            createdById: fx.ownerId,
            scopeKind: 'conversation',
            planId,
            planChangeSessionId: conversationId,
          },
          tx,
        ),
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  it('refuses a conversation scope that names only a plan', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SCC' });
    const planId = await planOf(fx);
    const state = await sqlStateOfRejection(
      inWs(fx, (tx) =>
        sharpenSessionRepository.create(
          {
            workspaceId: fx.workspaceId,
            projectId: fx.projectId,
            createdById: fx.ownerId,
            scopeKind: 'conversation',
            planId,
          },
          tx,
        ),
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });
});

describe('one OPEN session per person per target', () => {
  it('refuses a second open plan session for the same person, and allows one once the first ended', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'OPN' });
    const planId = await planOf(fx);
    const first = await openPlanSession(fx, planId);

    expect(await sqlStateOfRejection(openPlanSession(fx, planId))).toBe(UNIQUE_VIOLATION);

    await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(first.id, { status: 'ended', endReason: 'stopped' }, tx),
    );
    const second = await openPlanSession(fx, planId);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('open');
  });

  it('holds the same rule for a conversation target (MOTIR-9314)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'OPW' });
    const conversationId = await conversationOf(fx);
    const first = await openConversationSession(fx, conversationId);
    expect(await sqlStateOfRejection(openConversationSession(fx, conversationId))).toBe(
      UNIQUE_VIOLATION,
    );
    await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(
        first.id,
        { status: 'ended', endReason: 'finished' },
        tx,
      ),
    );
    await expect(openConversationSession(fx, conversationId)).resolves.toMatchObject({
      status: 'open',
      planChangeSessionId: conversationId,
    });
  });

  it('lets two different people each hold an open session on the same plan', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'TWO' });
    const planId = await planOf(fx);
    const other = await createTestUser({ name: 'Teammate' });
    await openPlanSession(fx, planId);
    await expect(openPlanSession(fx, planId, other.id)).resolves.toMatchObject({
      createdById: other.id,
    });
  });
});

describe('findOpenForUser', () => {
  it('returns the open session for that user and target, and null for another user', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FND' });
    const planId = await planOf(fx);
    const other = await createTestUser({ name: 'Teammate' });
    const session = await openPlanSession(fx, planId);

    const mine = await inWs(fx, (tx) =>
      sharpenSessionRepository.findOpenForUser({ planId }, fx.ownerId, fx.workspaceId, tx),
    );
    expect(mine?.id).toBe(session.id);

    const theirs = await inWs(fx, (tx) =>
      sharpenSessionRepository.findOpenForUser({ planId }, other.id, fx.workspaceId, tx),
    );
    expect(theirs).toBeNull();
  });

  it('does not return an ended session', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FNE' });
    const planId = await planOf(fx);
    const session = await openPlanSession(fx, planId);
    await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(
        session.id,
        { status: 'ended', endReason: 'nothing_to_ask' },
        tx,
      ),
    );
    const found = await inWs(fx, (tx) =>
      sharpenSessionRepository.findOpenForUser({ planId }, fx.ownerId, fx.workspaceId, tx),
    );
    expect(found).toBeNull();
  });
});

describe('a conversation target', () => {
  it('findLatestByConversation answers the newest session, ended or open, of that person only', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'LAT' });
    const conversationId = await conversationOf(fx);
    const first = await openConversationSession(fx, conversationId);
    await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(first.id, { status: 'ended', endReason: 'stopped' }, tx),
    );
    const latest = (userId: string) =>
      inWs(fx, (tx) =>
        sharpenSessionRepository.findLatestByConversation(
          conversationId,
          userId,
          fx.workspaceId,
          tx,
        ),
      );
    expect((await latest(fx.ownerId))?.id).toBe(first.id);
    const second = await openConversationSession(fx, conversationId);
    expect((await latest(fx.ownerId))?.id).toBe(second.id);
    const other = await createTestUser({ name: 'Teammate' });
    expect(await latest(other.id)).toBeNull();
  });

  it('a deleted conversation takes its grilling sessions with it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CAS' });
    const conversationId = await conversationOf(fx);
    const session = await openConversationSession(fx, conversationId);
    await adminDb.planChangeSession.delete({ where: { id: conversationId } });
    expect(await adminDb.sharpenSession.findUnique({ where: { id: session.id } })).toBeNull();
  });
});

describe('turns', () => {
  async function append(
    fx: WorkItemFixture,
    sessionId: string,
    turn: Parameters<typeof sharpenTurnRepository.appendTurn>[2],
  ) {
    return inWs(fx, async (tx) => {
      await sharpenSessionRepository.lockById(sessionId, tx);
      const seq = await sharpenTurnRepository.nextSeq(sessionId, tx);
      return sharpenTurnRepository.appendTurn(sessionId, seq, turn, tx);
    });
  }

  it('allocates gapless seq 0, 1, 2 under the session lock, and lists them in order', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'SEQ' });
    const session = await openPlanSession(fx, await planOf(fx));
    const base = { workspaceId: fx.workspaceId, authorId: fx.ownerId };
    await append(fx, session.id, { ...base, role: 'person', action: 'start', body: 'Start' });
    await append(fx, session.id, { ...base, role: 'planner', body: 'Q1', jobId: 'job-1' });
    await append(fx, session.id, {
      ...base,
      role: 'person',
      action: 'answer',
      body: 'PDF only',
      readingId: 'a',
    });

    const turns = await inWs(fx, (tx) => sharpenTurnRepository.listTurns(session.id, tx));
    expect(turns.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(turns.map((t) => t.body)).toEqual(['Start', 'Q1', 'PDF only']);
    expect(turns[2]).toMatchObject({ action: 'answer', readingId: 'a', role: 'person' });
  });

  it('refuses a second PLANNER turn for the same job, but not a person turn bound to it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'JOB' });
    const session = await openPlanSession(fx, await planOf(fx));
    const base = { workspaceId: fx.workspaceId };
    await append(fx, session.id, {
      ...base,
      role: 'person',
      action: 'start',
      body: 's',
      jobId: 'job-9',
    });
    await append(fx, session.id, {
      ...base,
      role: 'planner',
      body: 'Q1',
      jobId: 'job-9',
      record: { kind: 'question' },
    });
    const state = await sqlStateOfRejection(
      append(fx, session.id, { ...base, role: 'planner', body: 'Q1 again', jobId: 'job-9' }),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it('finds a turn by job and role, and binds a job to a person turn', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'BND' });
    const session = await openPlanSession(fx, await planOf(fx));
    const person = await append(fx, session.id, {
      workspaceId: fx.workspaceId,
      role: 'person',
      action: 'skip',
      body: 'Skip',
    });
    await inWs(fx, (tx) => sharpenTurnRepository.setTurnJob(person.id, 'job-42', tx));

    const found = await inWs(fx, (tx) =>
      sharpenTurnRepository.findTurnByJob(session.id, 'job-42', 'person', tx),
    );
    expect(found?.id).toBe(person.id);
    const noPlanner = await inWs(fx, (tx) =>
      sharpenTurnRepository.findTurnByJob(session.id, 'job-42', 'planner', tx),
    );
    expect(noPlanner).toBeNull();
  });
});

describe('row-level security', () => {
  it('hides workspace B sessions and turns from a workspace A context', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'RLA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'RLB' });
    const sessionB = await openPlanSession(b, await planOf(b));
    await inWs(b, async (tx) => {
      const seq = await sharpenTurnRepository.nextSeq(sessionB.id, tx);
      await sharpenTurnRepository.appendTurn(
        sessionB.id,
        seq,
        { workspaceId: b.workspaceId, role: 'person', action: 'start', body: 'secret' },
        tx,
      );
    });

    // Even asking with B's own project and workspace ids, a context bound to A
    // sees nothing — the policy, not the arguments, is what hides it.
    const viaA = await inWs(a, (tx) =>
      sharpenSessionRepository.findByIdInProject(sessionB.id, b.projectId, b.workspaceId, tx),
    );
    expect(viaA).toBeNull();
    const turnsViaA = await inWs(a, (tx) => sharpenTurnRepository.listTurns(sessionB.id, tx));
    expect(turnsViaA).toEqual([]);
    const lockViaA = await inWs(a, (tx) => sharpenSessionRepository.lockById(sessionB.id, tx));
    expect(lockViaA).toBeNull();

    // And B's own context does see them — so the empty answer above is RLS.
    const viaB = await inWs(b, (tx) =>
      sharpenSessionRepository.findByIdInProject(sessionB.id, b.projectId, b.workspaceId, tx),
    );
    expect(viaB?.id).toBe(sessionB.id);
    const turnsViaB = await inWs(b, (tx) => sharpenTurnRepository.listTurns(sessionB.id, tx));
    expect(turnsViaB).toHaveLength(1);
  });

  it('runs as the application role, not a superuser', async () => {
    const rows = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('refuses to write a turn into another workspace', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'RWA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'RWB' });
    const sessionB = await openPlanSession(b, await planOf(b));
    const err = await inWs(a, (tx) =>
      sharpenTurnRepository.appendTurn(
        sessionB.id,
        0,
        { workspaceId: b.workspaceId, role: 'person', action: 'start', body: 'x' },
        tx,
      ),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('updateState', () => {
  it('stores and clears the opaque JSON state', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'UPD' });
    const session = await openPlanSession(fx, await planOf(fx));
    expect(session.settled).toEqual([]);
    expect(session.assumptions).toEqual([]);
    expect(session.pendingQuestion).toBeNull();

    const question = { id: 'q1', text: 'Who exports?', readings: [] };
    const updated = await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(
        session.id,
        {
          pendingQuestion: question,
          settled: [{ questionId: 'q0', answer: 'x' }],
          writeBack: { ok: true },
        },
        tx,
      ),
    );
    expect(updated.pendingQuestion).toEqual(question);
    expect(updated.settled).toEqual([{ questionId: 'q0', answer: 'x' }]);
    expect(updated.writeBack).toEqual({ ok: true });

    const cleared = await inWs(fx, (tx) =>
      sharpenSessionRepository.updateState(session.id, { pendingQuestion: null }, tx),
    );
    expect(cleared.pendingQuestion).toBeNull();
    expect(cleared.settled).toEqual([{ questionId: 'q0', answer: 'x' }]);
  });
});
