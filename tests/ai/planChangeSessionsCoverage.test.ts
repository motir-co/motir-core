import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeScope } from '@/lib/planChange/scope';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { addressOf, openTestSession } from '../helpers/planSession';
import { truncateAuthTables } from '../helpers/db';
import { parseAuthoredBug } from '@/lib/ai/authoredBug';
import { BUG_REF, bugDraft } from '../fixtures/logBugOfferFixtures';

// The story-level COVERAGE GATE's residual for the conversation's persistence
// layer (MOTIR-1732). MOTIR-1728 shipped its own comprehensive suite
// (`planChangeSessionsService.test.ts` — open/resume, ordered appends, the row
// lock under real concurrency, tenant isolation, accumulation across submits);
// this file deliberately does NOT restate any of it. It closes only the branches
// that suite cannot reach from the outside, which is exactly what took the two
// files under the per-file gate (≥90% branch/fn/line):
//
//   * the repository reads on their DEFAULT client — every service path passes a
//     `tx`, so the `tx ?? dbRead` arm shipped unexecuted;
//   * the two ERROR-CLASSIFICATION forks: a non-P2002 failure must propagate
//     UNTRANSLATED (only a genuine unique violation becomes a typed conflict),
//     and the create-race recovery must re-read the winner — the shipped
//     "concurrent open" case is served by the pre-read, so the catch never ran;
//   * the mapper's null-bearing fields on a thread that HAS submitted.
//
// Real Postgres, per the motir-core convention; only the motir-ai boundary
// client is mocked (the service imports it transitively through
// `aiPlanEditsService`).

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-augment-1' })),
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

// The session each case works on (MOTIR-6028). Every write names its session by
// id now that the scope-keyed wrappers are gone; `openCurrent` opens (or resumes)
// it the way the public `open` doors do and remembers its address.
let current: { sessionId: string } = { sessionId: '' };
async function openCurrent(pctx: ProjectContext, scope?: PlanChangeScope) {
  const session = await openTestSession(pctx, scope);
  current = addressOf(session);
  return session;
}
const { PlanChangeTurnConflictError, PlanChangeSessionNotFoundError, PlanChangeTurnNotFoundError } =
  await import('@/lib/planChange/errors');

let fx: WorkItemFixture;

function ctx(f: WorkItemFixture): ProjectContext {
  return {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

beforeEach(async () => {
  current = { sessionId: '' };
  await truncateAuthTables();
  vi.restoreAllMocks();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planChange repositories — the DEFAULT (no-transaction) client', () => {
  it('reads a session by project and by id without a surrounding transaction', async () => {
    const opened = await openCurrent(ctx(fx));

    // Every service path hands the repository a `tx`; these are the `tx ?? dbRead`
    // arms — the shape any future read-only caller (a route, a report) would use.
    const byProject = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(
        current.sessionId,
        fx.projectId,
        fx.workspaceId,
        tx,
      ),
    );
    expect(byProject?.id).toBe(opened.id);

    const byId = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findById(opened.id, fx.workspaceId, tx),
    );
    expect(byId?.projectId).toBe(fx.projectId);
  });

  it('scopes both default-client reads to the workspace — a foreign tenant sees nothing', async () => {
    // MOTIR-1728's suite proves this for the by-project read; the two reads a
    // caller reaches a thread by its OWN id with — `findById` and the turn list —
    // carry the same scope and are asserted here.
    const c = ctx(fx);
    const opened = await openCurrent(c);
    await planChangeSessionsService.appendTurn('a turn', c, current);
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeSessionRepository.findById(opened.id, other.workspaceId, tx),
      ),
    ).toBeNull();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeTurnRepository.listBySessionId(opened.id, other.workspaceId, tx),
      ),
    ).toEqual([]);
    // Same ids, the OWNING scope — proof the nulls above are the scope biting,
    // not a bad id.
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeSessionRepository.findById(opened.id, fx.workspaceId, tx),
      ),
    ).not.toBeNull();
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeTurnRepository.listBySessionId(opened.id, fx.workspaceId, tx),
      ),
    ).toHaveLength(1);
  });

  it('reports a MISSING session from the row lock instead of throwing', async () => {
    // `lockById` is the append's first step. On a thread deleted between the
    // caller's read and the transaction it must return null so the service can
    // raise its typed not-found — not blow up with a raw index error.
    const locked = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => planChangeSessionRepository.lockById('cl000000000000000000000', tx),
    );
    expect(locked).toBeNull();
  });

  it('reads the thread in seq order on the default client', async () => {
    const c = ctx(fx);
    await openCurrent(c);
    await planChangeSessionsService.appendTurn('first', c, current);
    await planChangeSessionsService.appendTurn('second', c, current);

    const session = (await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(
        current.sessionId,
        fx.projectId,
        fx.workspaceId,
        tx,
      ),
    ))!;
    const turns = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeTurnRepository.listBySessionId(session.id, fx.workspaceId, tx),
    );
    expect(turns.map((t) => t.body)).toEqual(['first', 'second']);
    expect(turns.map((t) => t.seq)).toEqual([0, 1]);
  });
});

describe('planChangeSessionsService — error classification is not a catch-all', () => {
  it('propagates a NON-unique write failure untranslated', async () => {
    // The P2002 fork must be a fork, not a funnel: a connection drop, a check
    // constraint, a serialization failure must NOT be reported to the user as
    // "someone else claimed your turn". Only a genuine unique violation is a
    // turn conflict.
    const c = ctx(fx);
    await openCurrent(c);

    const boom = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2034',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeTurnRepository, 'create').mockRejectedValue(boom);

    const err = await planChangeSessionsService
      .appendTurn('a turn', c, current)
      .catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(PlanChangeTurnConflictError);
  });

  it('raises the typed not-found when the thread VANISHES before the lock', async () => {
    // The TOCTOU arm the row lock exists for: `requireSession` read the thread,
    // then it was deleted (a project reset, a cascade) before the append's
    // transaction took the lock. `lockById` returns null and the append must
    // raise the domain error, not dereference a missing row.
    const c = ctx(fx);
    await openCurrent(c);
    vi.spyOn(planChangeSessionRepository, 'lockById').mockResolvedValueOnce(null);

    await expect(planChangeSessionsService.appendTurn('a turn', c, current)).rejects.toBeInstanceOf(
      PlanChangeSessionNotFoundError,
    );
  });

  it('raises the typed not-found when the locked re-read comes back empty', async () => {
    // The second half of the same window: the lock succeeded but the scoped
    // re-read (which is what `seq` is derived from) found nothing. Allocating
    // from an absent `turnCount` would be the lost-update bug the lock prevents.
    const c = ctx(fx);
    await openCurrent(c);
    vi.spyOn(planChangeSessionRepository, 'findById').mockResolvedValueOnce(null);

    await expect(planChangeSessionsService.appendTurn('a turn', c, current)).rejects.toBeInstanceOf(
      PlanChangeSessionNotFoundError,
    );
  });

  it('propagates a NON-unique failure from the OPEN path too', async () => {
    // The open path's catch forks on the same P2002 test; a different Prisma
    // error must escape rather than be mistaken for a lost create race.
    const c = ctx(fx);
    const boom = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1001',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeSessionRepository, 'create').mockRejectedValueOnce(boom);

    await expect(openCurrent(c)).rejects.toBe(boom);
  });

  it('serializes one member’s opens of a scope under the scope lock — the second finds the first’s row', async () => {
    // MOTIR-6021 replaced the dropped unique's P2002 "read the winner" branch with
    // `lockScopeForUser` + a re-read INSIDE the lock, so two concurrent opens by
    // one member queue rather than fork.
    const c = ctx(fx);
    const [a, b] = await Promise.all([openCurrent(c), openCurrent(c)]);

    expect(a.id).toBe(b.id);
    const rows = await adminDb.planChangeSession.findMany({ where: { projectId: c.projectId } });
    expect(rows).toHaveLength(1);
  });

  it('lets a create failure escape — no conflict is swallowed into a silent success', async () => {
    const c = ctx(fx);
    const conflict = new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeSessionRepository, 'create').mockRejectedValueOnce(conflict);

    await expect(openCurrent(c)).rejects.toBe(conflict);
  });
});

describe('planChangeMappers — no Prisma row crosses the boundary', () => {
  it('maps a SUBMITTED thread’s dates to ISO strings and keeps the tenant id off the wire', async () => {
    const c = ctx(fx);
    await openCurrent(c);
    await planChangeSessionsService.appendTurn('Split the billing epic', c, current);
    const { session } = await planChangeSessionsService.submit(c, current);

    // `lastSubmittedAt` is the only nullable Date on the session — the shipped
    // suite asserts the null arm (a never-submitted thread); this is the set arm.
    expect(session.lastSubmittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(session)).not.toContain('workspaceId');

    const marker = session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.jobId).toBe('job-augment-1');
    // A system marker has no author; a user turn does. Both arms, one thread.
    expect(marker.authorId).toBeNull();
    expect(session.turns[0]!.authorId).toBe(fx.ownerId);
    expect(session.turns[0]!.jobId).toBeNull();
    expect(Object.keys(marker)).not.toContain('workspaceId');
  });

  it('does not re-sort — the ORDER is the repository read’s contract', () => {
    // Stated as an assertion so a future "defensive sort" in the mapper is a
    // failing test rather than a silent second source of truth for ordering.
    const now = new Date('2026-07-27T10:00:00.000Z');
    const row = {
      id: 's1',
      workspaceId: 'w1',
      projectId: 'p1',
      createdById: 'u1',
      turnCount: 2,
      scopeKey: '',
      targetKeys: [],
      lastJobId: null,
      lastSubmittedAt: null,
      lastActivityAt: now,
      origin: 'conversation' as const,
      seedGateId: null,
      seedGuideTurnId: null,
      endedAt: null,
      endReason: null,
      endedById: null,
      copiedFromSessionId: null,
      guideBugsFiled: 0,
      autoResumeCount: 0,
      lastAutoResumedAt: null,
      providerResumedAt: null,
      // The waiting state (MOTIR-7908): an unmarked session carries none of it.
      failedAt: null,
      failedJobId: null,
      failureReason: null,
      failureDetail: null,
      failureStopPhase: null,
      failureStopRef: null,
      failureStopTitle: null,
      failureResumable: null,
      failureNotPlannedYet: [],
      awaitingPersonSince: null,
      awaitingPersonCause: null,
      createdAt: now,
      updatedAt: now,
    };
    const turn = (seq: number) => ({
      id: `t${seq}`,
      workspaceId: 'w1',
      sessionId: 's1',
      seq,
      role: 'user' as const,
      body: `turn ${seq}`,
      jobId: null,
      question: null,
      isAnswer: false,
      intent: null,
      intentCorrected: false,
      debugLandingClaimedAt: null,
      guideLandingClaimedAt: null,
      planStartClaimedAt: null,
      guideTurn: null,
      confirm: null,
      codeUnreadable: null,
      codeUnsearchable: null,
      anchorKey: null,
      debugLanding: null,
      citations: [],
      attachmentIds: [],
      runJobId: null,
      forwardOffer: null,
      answerOffer: null,
      forwardedEntryId: null,
      revisedLateJobId: null,
      authorId: 'u1',
      createdAt: now,
    });

    const dto = toPlanChangeSessionDto(row, [turn(1), turn(0)]);
    expect(dto.turns.map((t) => t.seq)).toEqual([1, 0]);
  });
});

describe('planChangeSessionsService — the landing claim (MOTIR-7049 · MOTIR-9323)', () => {
  // The landing's one-write guarantee rests on this compare-and-set, taken on the
  // `log_bug` offer's own answer turn. The landing suite drives the CLAIM; a RELEASE is
  // pinned here directly: a released claim can be taken again, a held one cannot.
  async function offerTurn() {
    await openCurrent(ctx(fx));
    await planChangeSessionsService.appendTurn('mentions vanish', ctx(fx), current, {
      intent: 'ask',
    });
    const answered = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-ask-1',
        body: 'Saving strips the mention.',
        citations: [],
        answerOffer: {
          kind: 'log_bug',
          requestMd: 'Saving drops the mention',
          targetKey: null,
          bug: {
            title: 'Saving drops the mention',
            acceptanceCriteria: ['A saved comment keeps its mention'],
            draft: parseAuthoredBug(bugDraft()),
            target: { kind: 'new', key: null, title: null },
            targetUpdatedAt: null,
            contextRefs: [BUG_REF],
          },
        },
      },
      ctx(fx),
      current,
    );
    return answered.turns.at(-1)!;
  }

  it('claims once, refuses a second claim, and can be claimed again only after a release', async () => {
    const turn = await offerTurn();

    expect(await planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current)).toBe(true);
    expect(await planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current)).toBe(
      false,
    );

    await planChangeSessionsService.releaseDebugLanding(turn.id, ctx(fx), current);
    const released = await adminDb.planChangeTurn.findUnique({ where: { id: turn.id } });
    expect(released?.debugLandingClaimedAt).toBeNull();

    expect(await planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current)).toBe(true);
  });

  it('never claims a turn that holds no log_bug offer', async () => {
    await openCurrent(ctx(fx));
    const appended = await planChangeSessionsService.appendTurn(
      'what is left in the sprint?',
      ctx(fx),
      current,
      { intent: 'ask' },
    );
    const turn = appended.turns.at(-1)!;

    await expect(
      planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
    const row = await adminDb.planChangeTurn.findUnique({ where: { id: turn.id } });
    expect(row?.debugLandingClaimedAt).toBeNull();
  });

  it('refuses an offer a newer answer replaced', async () => {
    const turn = await offerTurn();
    await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-2', body: 'Something else.', citations: [] },
      ctx(fx),
      current,
    );
    await expect(
      planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current),
    ).rejects.toMatchObject({ reason: 'offer_not_open' });
  });

  it('stamps the landing and the confirmation together, and refuses an unclaimed stamp', async () => {
    const turn = await offerTurn();
    const landing = {
      outcome: 'diagnose' as const,
      workItemKey: 'PROD-1',
      title: 'Saving drops the mention',
      createdInTriage: false,
    };
    await expect(
      planChangeSessionsService.recordDebugLanding(turn.id, landing, ctx(fx), current),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);

    await planChangeSessionsService.claimDebugLanding(turn.id, ctx(fx), current);
    const session = await planChangeSessionsService.recordDebugLanding(
      turn.id,
      landing,
      ctx(fx),
      current,
    );
    const stamped = session.turns.find((t) => t.id === turn.id)!;
    expect(stamped.debugLanding).toEqual(landing);
    expect(stamped.offer?.state).toBe('confirmed');
  });
});
