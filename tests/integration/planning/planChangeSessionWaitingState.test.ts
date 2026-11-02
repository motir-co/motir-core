import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext, withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import {
  sessionWaitingState,
  type PlanSessionFailureRecord,
} from '@/lib/planChange/sessionWaitingState';
import type { PlanSessionEndReason } from '@/generated/prisma/client';
import { createTestUser } from '../../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A PLANNING SESSION'S WAITING STATE, against a REAL Postgres (Story MOTIR-7905 ·
// MOTIR-7908). A mock proves none of what is claimed here: the CHECK constraints are
// the database's, the conditional writes are one `UPDATE … WHERE` racing another
// transaction's row lock, and the owner-scoped read is a row-level-security policy.
//
// `@/lib/db` is the NON-BYPASS runtime role, so every call under test runs inside a
// workspace (or system) context exactly as production does; fixtures and direct
// assertions go through the admin client.

const DB_TEST_TIMEOUT_MS = 60_000;
const HOUR = 60 * 60 * 1000;
const ALL_NINE = [
  'failedAt',
  'failedJobId',
  'failureReason',
  'failureDetail',
  'failureStopPhase',
  'failureStopRef',
  'failureStopTitle',
  'awaitingPersonSince',
  'awaitingPersonCause',
] as const;

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const wctx = (userId = fx.ownerId) => ({
  userId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
});

async function openSession(
  over: Partial<{
    createdById: string;
    origin: 'conversation' | 'guide';
    lastActivityAt: Date;
    projectId: string;
    targetKeys: string[];
  }> = {},
): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: over.projectId ?? fx.projectId,
      createdById: over.createdById ?? fx.ownerId,
      scopeKey: `scope-${Math.random().toString(36).slice(2)}`,
      targetKeys: over.targetKeys ?? [],
      origin: over.origin ?? 'conversation',
      ...(over.lastActivityAt ? { lastActivityAt: over.lastActivityAt } : {}),
    },
  });
  return session.id;
}

const FAILURE: PlanSessionFailureRecord = {
  failedAt: new Date('2026-10-09T10:00:00.000Z'),
  failedJobId: 'job_failed_1',
  failureReason: 'rate_limited',
  failureDetail: 'the gateway said slow down',
  failureStopPhase: 'author',
  failureStopRef: 'planItem:pi_3',
  failureStopTitle: 'Task three',
};

const rowOf = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
const nineOf = async (id: string) => {
  const r = await rowOf(id);
  return Object.fromEntries(ALL_NINE.map((k) => [k, r[k]]));
};
const markFailed = (id: string, record = FAILURE) =>
  withWorkspaceContext(wctx(), (tx) => planChangeSessionRepository.markFailed(id, record, tx));
const markAwaiting = (id: string, cause: 'question' | 'reply' = 'question') =>
  withWorkspaceContext(wctx(), (tx) =>
    planChangeSessionRepository.markAwaitingPerson(id, { cause, since: new Date() }, tx),
  );
const endIt = (id: string, reason: PlanSessionEndReason = 'idle') =>
  withWorkspaceContext(wctx(), (tx) =>
    planSessionEndService.endSessionWithin(tx, id, fx.workspaceId, reason, {
      endedById: null,
      actor: fx.ctx,
    }),
  );

// ════════════════════════════════════════════════════════════════════════════
// THE MIGRATION AND ITS CHECKS
// ════════════════════════════════════════════════════════════════════════════

describe('the migration', () => {
  it('leaves every existing session unmarked: open or ended, exactly as its endedAt says', async () => {
    const open = await openSession();
    const ended = await openSession();
    await adminDb.planChangeSession.update({
      where: { id: ended },
      data: { endedAt: new Date(), endReason: 'idle' },
    });

    expect(sessionWaitingState(await rowOf(open))).toBe('open');
    expect(sessionWaitingState(await rowOf(ended))).toBe('ended');
    expect(await nineOf(open)).toEqual(Object.fromEntries(ALL_NINE.map((k) => [k, null])));
  });
});

describe('the CHECK constraints refuse a raw write the invariants forbid', () => {
  async function refused(id: string, set: string): Promise<string> {
    const err = await adminDb
      .$executeRawUnsafe(`UPDATE "plan_change_session" SET ${set} WHERE "id" = $1`, id)
      .then(() => null)
      .catch((e: unknown) => e as Error);
    return String(err?.message ?? 'NOT REFUSED');
  }

  it('⚠️ an ENDED session with a failure on record (one_wait)', async () => {
    const id = await openSession();
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'idle' },
    });

    expect(
      await refused(
        id,
        `"failed_at" = now(), "failed_job_id" = 'j', "failure_reason" = 'internal'`,
      ),
    ).toContain('plan_change_session_one_wait');
  });

  it('⚠️ both waits at once (one_wait)', async () => {
    const id = await openSession();

    expect(
      await refused(
        id,
        `"failed_at" = now(), "failed_job_id" = 'j', "failure_reason" = 'internal', ` +
          `"awaiting_person_since" = now(), "awaiting_person_cause" = 'reply'`,
      ),
    ).toContain('plan_change_session_one_wait');
  });

  it('a failure without its reason (failure_whole)', async () => {
    const id = await openSession();

    expect(await refused(id, `"failed_at" = now(), "failed_job_id" = 'j'`)).toContain(
      'plan_change_session_failure_whole',
    );
  });

  it('a job without its failure (failure_whole)', async () => {
    const id = await openSession();

    expect(await refused(id, `"failed_job_id" = 'j'`)).toContain(
      'plan_change_session_failure_whole',
    );
  });

  it('a failure with NO job is accepted — a silent job-less plan (MOTIR-8132)', async () => {
    const id = await openSession();

    expect(await refused(id, `"failed_at" = now(), "failure_reason" = 'internal'`)).toBe(
      'NOT REFUSED',
    );
  });

  it('a wait without its cause (awaiting_whole)', async () => {
    const id = await openSession();

    expect(await refused(id, `"awaiting_person_since" = now()`)).toContain(
      'plan_change_session_awaiting_whole',
    );
  });

  it('a cause without its time (awaiting_whole)', async () => {
    const id = await openSession();

    expect(await refused(id, `"awaiting_person_cause" = 'reply'`)).toContain(
      'plan_change_session_awaiting_whole',
    );
  });

  it('COUNTERFACTUAL — a whole failure on an OPEN session is accepted', async () => {
    const id = await openSession();

    expect(
      await refused(
        id,
        `"failed_at" = now(), "failed_job_id" = 'j', "failure_reason" = 'internal'`,
      ),
    ).toBe('NOT REFUSED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE WRITES
// ════════════════════════════════════════════════════════════════════════════

describe('the conditional writes', () => {
  it('markFailed on an open session writes the whole record and returns true', async () => {
    const id = await openSession();

    expect(await markFailed(id)).toBe(true);

    expect(await rowOf(id)).toMatchObject(FAILURE);
    expect(sessionWaitingState(await rowOf(id))).toBe('failed');
  });

  it('markFailed clears an awaiting record in the SAME statement', async () => {
    const id = await openSession();
    await markAwaiting(id);

    expect(await markFailed(id)).toBe(true);

    expect(await rowOf(id)).toMatchObject({
      awaitingPersonSince: null,
      awaitingPersonCause: null,
      failureReason: 'rate_limited',
    });
  });

  it('markFailed on an ENDED session returns false and writes nothing', async () => {
    const id = await openSession();
    await endIt(id);

    expect(await markFailed(id)).toBe(false);

    expect(await nineOf(id)).toEqual(Object.fromEntries(ALL_NINE.map((k) => [k, null])));
  });

  it('a second failure overwrites the first record', async () => {
    const id = await openSession();
    await markFailed(id);

    expect(
      await markFailed(id, {
        ...FAILURE,
        failedJobId: 'job_failed_2',
        failureReason: 'out_of_credits',
        failureStopPhase: 'lay',
      }),
    ).toBe(true);

    expect(await rowOf(id)).toMatchObject({
      failedJobId: 'job_failed_2',
      failureReason: 'out_of_credits',
      failureStopPhase: 'lay',
    });
  });

  it('markFailed caps an over-long detail and stores a failure with no stop point', async () => {
    const id = await openSession();

    await markFailed(id, {
      failedAt: FAILURE.failedAt,
      failedJobId: 'job_x',
      failureReason: 'internal',
      failureDetail: 'x'.repeat(900),
    });

    const row = await rowOf(id);
    expect(row.failureDetail).toHaveLength(300);
    expect(row.failureStopPhase).toBeNull();
    expect(row.failureStopRef).toBeNull();
  });

  it('markFailed stores the halted walk’s not-planned-yet lines in order, and clearFailure empties them (MOTIR-10209)', async () => {
    const id = await openSession();
    const lines = [
      '"D" is not planned yet: plan "B" first, then plan "D".',
      'Not written yet: "T" waits on "S", and planning stopped before it was written — continuing this plan writes it.',
    ];

    await markFailed(id, { ...FAILURE, failureNotPlannedYet: lines });

    expect((await rowOf(id)).failureNotPlannedYet).toEqual(lines);
    expect(toPlanChangeSessionDto(await rowOf(id), []).failure?.notPlannedYet).toEqual(lines);

    await withWorkspaceContext(wctx(), (tx) => planChangeSessionRepository.clearFailure(id, tx));
    expect((await rowOf(id)).failureNotPlannedYet).toEqual([]);
  });

  it('a failure recorded without lines stores none (MOTIR-10209)', async () => {
    const id = await openSession();
    await markFailed(id);
    expect((await rowOf(id)).failureNotPlannedYet).toEqual([]);
  });

  it('markAwaitingPerson marks an open session and returns true', async () => {
    const id = await openSession();

    expect(await markAwaiting(id, 'reply')).toBe(true);

    expect(await rowOf(id)).toMatchObject({ awaitingPersonCause: 'reply' });
    expect(sessionWaitingState(await rowOf(id))).toBe('awaiting_person');
  });

  it('⚠️ markAwaitingPerson is a NO-OP returning false on a failed-waiting session', async () => {
    const id = await openSession();
    await markFailed(id);

    expect(await markAwaiting(id)).toBe(false);

    const row = await rowOf(id);
    expect(row.awaitingPersonSince).toBeNull();
    expect(row.failureReason).toBe('rate_limited');
  });

  it('markAwaitingPerson on an ENDED session returns false and writes nothing', async () => {
    const id = await openSession();
    await endIt(id);

    expect(await markAwaiting(id)).toBe(false);

    expect((await rowOf(id)).awaitingPersonSince).toBeNull();
  });

  it('clearFailure nulls only the failure columns', async () => {
    const id = await openSession();
    await markFailed(id);

    await withWorkspaceContext(wctx(), (tx) => planChangeSessionRepository.clearFailure(id, tx));

    const row = await rowOf(id);
    expect(row).toMatchObject({
      failedAt: null,
      failedJobId: null,
      failureReason: null,
      failureDetail: null,
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
    });
    expect(sessionWaitingState(row)).toBe('open');
  });

  it('clearAwaitingPerson nulls only the two awaiting columns', async () => {
    const id = await openSession();
    await markAwaiting(id);

    await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.clearAwaitingPerson(id, tx),
    );

    expect(await rowOf(id)).toMatchObject({ awaitingPersonSince: null, awaitingPersonCause: null });
  });

  it('findWaitingState reads the end, the failure and the wait', async () => {
    const id = await openSession();
    await markFailed(id);

    const state = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.findWaitingState(id, fx.workspaceId, tx),
    );

    expect(state).toMatchObject({ id, endedAt: null, failedJobId: 'job_failed_1' });
    expect(state?.failureReason).toBe('rate_limited');
    expect(state?.awaitingPersonSince).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AN END CLEARS BOTH WAITS
// ════════════════════════════════════════════════════════════════════════════

describe('ending a session clears either wait in the one end write', () => {
  const REASONS: PlanSessionEndReason[] = ['failed', 'idle', 'restarted', 'declined', 'approved'];

  it.each(REASONS)(
    'a failed-waiting session ended %s leaves all nine columns null',
    async (reason) => {
      const id = await openSession();
      await markFailed(id);

      const out = await endIt(id, reason);

      expect(out.ended).toBe(true);
      expect(await nineOf(id)).toEqual(Object.fromEntries(ALL_NINE.map((k) => [k, null])));
      expect(sessionWaitingState(await rowOf(id))).toBe('ended');
    },
  );

  it.each(REASONS)(
    'an awaiting-person session ended %s leaves all nine columns null',
    async (reason) => {
      const id = await openSession();
      await markAwaiting(id);

      await endIt(id, reason);

      expect(await nineOf(id)).toEqual(Object.fromEntries(ALL_NINE.map((k) => [k, null])));
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// REAL CONCURRENCY — a mark racing an end can never leave an ended session marked
// ════════════════════════════════════════════════════════════════════════════

describe('a mark racing the end', () => {
  const ITERATIONS = 24;

  async function race(mark: (id: string) => Promise<boolean>): Promise<{
    markedFirst: number;
    endedFirst: number;
  }> {
    let markedFirst = 0;
    let endedFirst = 0;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const id = await openSession();
      const [ended, marked] = await Promise.allSettled([endIt(id), mark(id)]);
      // No iteration surfaces a CHECK violation (or anything else) to the caller.
      expect(ended.status, `end #${i}`).toBe('fulfilled');
      expect(marked.status, `mark #${i}`).toBe('fulfilled');
      const row = await rowOf(id);
      const state = sessionWaitingState(row);
      // Legal: ended with all nine null — or open and marked. NEVER ended and marked.
      if (state === 'ended') {
        expect(await nineOf(id), `ended #${i}`).toEqual(
          Object.fromEntries(ALL_NINE.map((k) => [k, null])),
        );
        endedFirst += 1;
      } else {
        expect(['failed', 'awaiting_person']).toContain(state);
        markedFirst += 1;
      }
    }
    return { markedFirst, endedFirst };
  }

  it('⚠️ endSessionWithin against markFailed', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const out = await race((id) => markFailed(id));

    expect(out.markedFirst + out.endedFirst).toBe(ITERATIONS);
  });

  it(
    '⚠️ endSessionWithin against markAwaitingPerson',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const out = await race((id) => markAwaiting(id));

      expect(out.markedFirst + out.endedFirst).toBe(ITERATIONS);
    },
  );

  it(
    'two marks racing each other leave exactly one legal state',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      for (let i = 0; i < 12; i += 1) {
        const id = await openSession();

        const [f, a] = await Promise.allSettled([markFailed(id), markAwaiting(id)]);

        expect(f.status).toBe('fulfilled');
        expect(a.status).toBe('fulfilled');
        const row = await rowOf(id);
        // Never both. A failure always wins the race it is in: it clears the awaiting
        // columns itself, and the awaiting write declines on a failed row.
        expect(row.failedAt !== null && row.awaitingPersonSince !== null).toBe(false);
      }
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════
// THE READS
// ════════════════════════════════════════════════════════════════════════════

describe('listIdleOpen never discovers a waiting session as idle', () => {
  it('⚠️ of three past the lease — a failed one with NO plan, an awaiting one, an unmarked one — only the unmarked', async () => {
    const stale = new Date(Date.now() - 5 * HOUR);
    const failed = await openSession({ lastActivityAt: stale });
    const awaiting = await openSession({ lastActivityAt: stale });
    const unmarked = await openSession({ lastActivityAt: stale });
    await markFailed(failed);
    // The awaiting one REACHED PLANNING (a decided plan): since MOTIR-9299 a mark on a
    // session holding no plan does not protect it, so the wait this case pins is a planned one.
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: awaiting,
        status: 'declined',
      },
    });
    await markAwaiting(awaiting);

    const found = await withSystemContext((tx) =>
      planChangeSessionRepository.listIdleOpen(new Date(Date.now() - HOUR), 100, tx),
    );

    expect(found.map((s) => s.id)).toEqual([unmarked]);
  });
});

describe('listFailedOpenForOwner / countFailedOpenForOwner', () => {
  it('⚠️ returns the OWNER’s own failed-waiting conversations, newest failure first, with their latest plan', async () => {
    const other = await createTestUser();
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: other.id, workspaceRole: 'member' },
    });
    const older = await openSession({ targetKeys: ['MOTIR-1'] });
    const newer = await openSession({ targetKeys: ['MOTIR-2'] });
    const theirs = await openSession({ createdById: other.id });
    const ended = await openSession();
    const awaiting = await openSession();
    const guide = await openSession({ origin: 'guide' });
    const unmarked = await openSession();
    await markFailed(older, { ...FAILURE, failedAt: new Date('2026-10-09T09:00:00.000Z') });
    await markFailed(newer, { ...FAILURE, failedAt: new Date('2026-10-09T11:00:00.000Z') });
    await withWorkspaceContext(wctx(other.id), (tx) =>
      planChangeSessionRepository.markFailed(theirs, FAILURE, tx),
    );
    await markFailed(ended);
    await endIt(ended);
    await markAwaiting(awaiting);
    await markFailed(guide);
    // The newer session holds two plans: the list names the LATEST.
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: newer,
        status: 'generating',
        createdAt: new Date('2026-10-09T08:00:00.000Z'),
      },
    });
    const latest = await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        sessionId: newer,
        status: 'generating',
        createdAt: new Date('2026-10-09T10:30:00.000Z'),
      },
    });
    void unmarked;
    const args = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectIds: [fx.projectId] };

    const rows = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.listFailedOpenForOwner({ ...args, skip: 0, take: 50 }, tx),
    );
    const count = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.countFailedOpenForOwner(args, tx),
    );

    expect(rows.map((r) => r.id)).toEqual([newer, older]);
    expect(rows[0]).toMatchObject({
      projectId: fx.projectId,
      targetKeys: ['MOTIR-2'],
      failedJobId: 'job_failed_1',
      failureReason: 'rate_limited',
      failureStopPhase: 'author',
      failureStopRef: 'planItem:pi_3',
      failureStopTitle: 'Task three',
      latestPlanId: latest.id,
    });
    expect(rows[1]!.latestPlanId).toBeNull();
    // A count is the list’s length on the same fixture — and the second member’s failed
    // session is in the workspace, so a read that ignored the owner would count three.
    expect(count).toBe(rows.length);
    expect(count).toBe(2);
  });

  it('a project outside projectIds is left out, and pagination skips and takes', async () => {
    const a = await openSession();
    const b = await openSession();
    await markFailed(a, { ...FAILURE, failedAt: new Date('2026-10-09T09:00:00.000Z') });
    await markFailed(b, { ...FAILURE, failedAt: new Date('2026-10-09T10:00:00.000Z') });
    const args = { userId: fx.ownerId, workspaceId: fx.workspaceId };

    const none = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.listFailedOpenForOwner(
        { ...args, projectIds: ['some-other-project'], skip: 0, take: 10 },
        tx,
      ),
    );
    const second = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.listFailedOpenForOwner(
        { ...args, projectIds: [fx.projectId], skip: 1, take: 1 },
        tx,
      ),
    );

    expect(none).toEqual([]);
    expect(second.map((r) => r.id)).toEqual([a]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE DTO
// ════════════════════════════════════════════════════════════════════════════

describe('toPlanChangeSessionDto', () => {
  it('fills failure and awaitingPerson from the row, and never carries the job id or the detail', async () => {
    const failedId = await openSession();
    const awaitingId = await openSession();
    await markFailed(failedId);
    await markAwaiting(awaitingId, 'question');

    const failed = toPlanChangeSessionDto(await rowOf(failedId), []);
    const waiting = toPlanChangeSessionDto(await rowOf(awaitingId), []);

    expect(failed.failure).toEqual({
      failedAt: '2026-10-09T10:00:00.000Z',
      reason: 'rate_limited',
      stopPhase: 'author',
      stopRef: 'planItem:pi_3',
      stopTitle: 'Task three',
      notPlannedYet: [],
    });
    expect(failed.awaitingPerson).toBeNull();
    expect(waiting.awaitingPerson).toMatchObject({ cause: 'question' });
    expect(waiting.failure).toBeNull();
    // Server-side only.
    const wire = JSON.stringify(failed);
    expect(wire).not.toContain('job_failed_1');
    expect(wire).not.toContain('the gateway said slow down');
  });

  it('is null for both on an unmarked session', async () => {
    const dto = toPlanChangeSessionDto(await rowOf(await openSession()), []);

    expect(dto.failure).toBeNull();
    expect(dto.awaitingPerson).toBeNull();
  });
});
