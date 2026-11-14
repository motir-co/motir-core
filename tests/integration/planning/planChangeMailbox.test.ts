import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MailboxContext } from '@/lib/services/planChangeMailboxService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067) — the pipe between a user
// still typing and a planning job that has already read its envelope.
//
// Driven through the REAL service against a real Postgres. The one mock is the
// motir-ai boundary (`getJob`), which the convention allows and which this card
// needs precisely because the thing under test is what happens when the job is
// NOT running any more.
//
// The five properties the card asks for, and why each needs a database:
//
//   1. ORDER IS PRESERVED, asserted on the READ DOOR'S OUTPUT and not on
//      insertion timestamps. The case that breaks a timestamp sort is two rows
//      written inside the same millisecond, which is reachable and is forced
//      here by writing them with an IDENTICAL `created_at`.
//   2. DELIVERY IS IDEMPOTENT on a stable key — a retried submit resolves to the
//      row it already wrote.
//   3. TURNS AND THE STOP ARRIVE IN ONE ANSWER. Two round trips could observe
//      them in either order, and one of those orders is wrong.
//   4. CONSUMPTION IS RECORDED — asserted by running TWO boundaries against one
//      delivery, which is the only way to see it.
//   5. AN EMPTY MAILBOX ANSWERS UNAMBIGUOUSLY — `{ turns: [], stopped: false }`,
//      never an error the run would have to read as "could not tell".
//
// Plus the CROSS-REPO FIXTURE at the bottom, which is the one no unit on either
// side can replace.

const jobStatus = { current: 'running' as string };

vi.mock('@/lib/ai/motirAiClient', () => ({
  getJob: async (jobId: string) => ({
    jobId,
    status: jobStatus.current,
    result: null,
    error: null,
  }),
}));

const { planChangeMailboxService } = await import('@/lib/services/planChangeMailboxService');
const { PlanChangeJobNotRunningError, PlanChangeMailboxJobMismatchError } =
  await import('@/lib/planChange/errors');

const JOB = 'job-run-1';

let fx: WorkItemFixture;
let pctx: MailboxContext;
let sessionId: string;

/** The thread, already submitted — `last_job_id` is what binds the mailbox. */
async function seedThreadOnJob(jobId: string = JOB): Promise<string> {
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      lastJobId: jobId,
      lastSubmittedAt: new Date(),
    },
  });
  return row.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  jobStatus.current = 'running';
  fx = await makeWorkItemFixture();
  pctx = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId };
  sessionId = await seedThreadOnJob();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the INGEST — a turn attached to a RUNNING job', () => {
  it('accepts a turn and answers with the mailbox as it now stands', async () => {
    const delivery = await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'Keep the mailbox card, drop the narration one.', idempotencyKey: 'k1' },
      pctx,
    );

    expect(delivery.turns).toHaveLength(1);
    expect(delivery.turns[0]!.text).toBe('Keep the mailbox card, drop the narration one.');
    expect(delivery.turns[0]!.disposition).toBe('fold');
    expect(delivery.turns[0]!.target).toBeNull();
    expect(delivery.stopped).toBe(false);
    // The answer is the mailbox, not an acknowledgement — which is what lets the
    // composer show "queued" without a second read.
    expect(delivery.turns[0]!.id).toEqual(expect.any(String));
  });

  it('REFUSES a turn addressed to a job that has already finished, naming the status', async () => {
    // The alternative is worse than an error: a mailbox nobody will ever check
    // accepts the turn, hands the user a delivered-looking message, and then
    // changes nothing for ever.
    for (const status of ['succeeded', 'failed', 'canceled']) {
      jobStatus.current = status;
      await expect(
        planChangeMailboxService.attachTurn(
          { jobId: JOB, body: 'too late', idempotencyKey: `late-${status}` },
          pctx,
        ),
      ).rejects.toThrow(PlanChangeJobNotRunningError);
    }
    // Nothing landed for any of the three.
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
  });

  it('accepts a turn on a job that is still QUEUED — every boundary is ahead of it', async () => {
    jobStatus.current = 'queued';
    const delivery = await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'before it even starts', idempotencyKey: 'q1' },
      pctx,
    );
    expect(delivery.turns).toHaveLength(1);
  });

  it('REFUSES a job this thread is not on — a 404-shaped mismatch, not a silent write', async () => {
    // `job_id` is an opaque token, so without this a caller could write an entry
    // under their OWN session addressed at a run that is not theirs: invisible to
    // them, read by nobody, and a row that exists.
    await expect(
      planChangeMailboxService.attachTurn(
        { jobId: 'somebody-elses-job', body: 'hello', idempotencyKey: 'x' },
        pctx,
      ),
    ).rejects.toThrow(PlanChangeMailboxJobMismatchError);
    expect(await adminDb.planChangeMailboxEntry.count()).toBe(0);
  });

  it('refuses a blank turn without reaching motir-ai', async () => {
    await expect(
      planChangeMailboxService.attachTurn(
        { jobId: JOB, body: '   \n  ', idempotencyKey: 'blank' },
        pctx,
      ),
    ).rejects.toThrow(/cannot be empty/);
  });

  it('carries a `restart` and its re-anchor target, and drops a target on a `fold`', async () => {
    await planChangeMailboxService.attachTurn(
      {
        jobId: JOB,
        body: 'start over on the billing epic instead',
        idempotencyKey: 'r1',
        disposition: 'restart',
        restartTarget: 'MOTIR-99',
      },
      pctx,
    );
    // A target on a FOLD is meaningless — the run is not re-anchoring — so it is
    // not stored, rather than stored and ignored by the consumer.
    const delivery = await planChangeMailboxService.attachTurn(
      {
        jobId: JOB,
        body: 'and keep the reporting story',
        idempotencyKey: 'r2',
        disposition: 'fold',
        restartTarget: 'MOTIR-77',
      },
      pctx,
    );

    expect(delivery.turns.map((t) => [t.disposition, t.target])).toEqual([
      ['restart', 'MOTIR-99'],
      ['fold', null],
    ]);
  });
});

describe('ORDER — asserted on the read door’s output, never on a timestamp', () => {
  it('reads two turns back in the order they were typed', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'first', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'second', idempotencyKey: 'b' },
      pctx,
    );

    const delivery = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect(delivery.turns.map((t) => t.text)).toEqual(['first', 'second']);
  });

  it('⚠️ HOLDS WHEN BOTH ROWS CARRY THE SAME `created_at` — the case a timestamp sort loses', async () => {
    // Two rows written inside the same millisecond is reachable, and it is the
    // whole reason `seq` exists. Forced here rather than raced for, so the test
    // is deterministic AND actually exercises the tie.
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'typed first', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'typed second', idempotencyKey: 'b' },
      pctx,
    );
    const sameInstant = new Date('2026-09-03T05:00:00.000Z');
    await adminDb.planChangeMailboxEntry.updateMany({
      where: { sessionId },
      data: { createdAt: sameInstant },
    });

    const delivery = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect(delivery.turns.map((t) => t.text)).toEqual(['typed first', 'typed second']);
    // Both carry the identical `receivedAt`, so the ARRAY is the only thing
    // saying which came first — which is exactly what the consumer's tie-break
    // reads (`readDelivery` sorts on `receivedAt` and breaks ties on index).
    expect(new Set(delivery.turns.map((t) => t.receivedAt)).size).toBe(1);
  });

  it('allocates `seq` per JOB, so a second run starts an empty mailbox at 0', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'run one', idempotencyKey: 'a' },
      pctx,
    );
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: 'job-run-2' },
    });
    await planChangeMailboxService.attachTurn(
      { jobId: 'job-run-2', body: 'run two', idempotencyKey: 'a' },
      pctx,
    );

    const rows = await adminDb.planChangeMailboxEntry.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => [r.jobId, r.seq])).toEqual([
      [JOB, 0],
      ['job-run-2', 0],
    ]);
    // …and the same idempotency key is free to repeat across runs, because the
    // unique is scoped to (session, job, key). Two runs are two mailboxes.
    expect(rows.map((r) => r.idempotencyKey)).toEqual(['a', 'a']);
  });
});

describe('IDEMPOTENCY — a retried submit does not double-deliver', () => {
  it('resolves a replay to the row it already wrote', async () => {
    const first = await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'say it once', idempotencyKey: 'stable-key' },
      pctx,
    );
    const replay = await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'say it once', idempotencyKey: 'stable-key' },
      pctx,
    );

    expect(replay.turns).toHaveLength(1);
    expect(replay.turns[0]!.id).toBe(first.turns[0]!.id);
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(1);
  });

  it('a replay carrying DIFFERENT text still resolves to the original — the key is the identity', async () => {
    // A retry is the same request, so the first body is what was meant. Letting
    // the second text win would make a retry a silent EDIT.
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'the original sentence', idempotencyKey: 'k' },
      pctx,
    );
    const replay = await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'a different sentence', idempotencyKey: 'k' },
      pctx,
    );
    expect(replay.turns.map((t) => t.text)).toEqual(['the original sentence']);
  });

  it('two CONCURRENT replays of one key still write exactly one row', async () => {
    // The reason the idempotency read happens INSIDE the session's row lock:
    // checked outside it, both would see "not there yet" and both insert, and
    // only the unique index would stop them — turning a correct retry into a 409.
    const results = await Promise.allSettled([
      planChangeMailboxService.attachTurn(
        { jobId: JOB, body: 'raced', idempotencyKey: 'same' },
        pctx,
      ),
      planChangeMailboxService.attachTurn(
        { jobId: JOB, body: 'raced', idempotencyKey: 'same' },
        pctx,
      ),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(1);
  });
});

describe('ONE PIPE — the turns and the stop arrive in ONE answer', () => {
  it('returns pending turns AND the stop flag together', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'one more thing', idempotencyKey: 't' },
      pctx,
    );
    await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);

    const delivery = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect(delivery.turns.map((t) => t.text)).toEqual(['one more thing']);
    expect(delivery.stopped).toBe(true);
  });

  it('the stop and a turn typed before it share ONE sequence, so neither overtakes', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'typed before the stop', idempotencyKey: 't' },
      pctx,
    );
    await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);

    const rows = await adminDb.planChangeMailboxEntry.findMany({
      where: { sessionId, jobId: JOB },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => [r.kind, r.seq])).toEqual([
      ['turn', 0],
      ['stop', 1],
    ]);
  });

  it('a `stop` carries no body and no disposition — it is a KIND, not a turn', async () => {
    await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);
    const row = await adminDb.planChangeMailboxEntry.findFirstOrThrow({ where: { sessionId } });
    expect(row.kind).toBe('stop');
    expect(row.body).toBeNull();
    expect(row.disposition).toBeNull();
    // …and it never appears in `turns`, which the consumer folds into a session.
    const delivery = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect(delivery.turns).toEqual([]);
    expect(delivery.stopped).toBe(true);
  });

  it('stopping an ALREADY-STOPPED run is a clean no-op', async () => {
    // The control is reachable in states where the click is redundant, so it has
    // to be safe there.
    await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);
    const again = await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);
    expect(again.stopped).toBe(true);
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(1);
  });

  it('stopping a run that has ALREADY FINISHED is a no-op too, not a refusal', async () => {
    // Deliberately unlike the turn door: the run may settle between render and
    // click, and an error the user cannot act on is worse than an entry nobody
    // reads.
    jobStatus.current = 'succeeded';
    const delivery = await planChangeMailboxService.raiseStop(JOB, 'stop-late', pctx);
    expect(delivery.stopped).toBe(true);
  });
});

/** The plan `JOB` writes into, with its live steps (MOTIR-11266). */
async function seedPlanRunning(
  kinds: ReadonlyArray<'lay' | 'author' | 'check' | 'repair'>,
  status: 'generating' | 'planned' = 'generating',
): Promise<string> {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      sourceJobId: JOB,
      createdById: fx.ownerId,
    },
  });
  for (const [i, kind] of kinds.entries()) {
    await adminDb.planStep.create({
      data: { planId: plan.id, sessionKey: `s${i}`, kind, startedAt: new Date() },
    });
  }
  return plan.id;
}

describe('SKIP THE FINAL CHECK — its own kind on the same pipe (MOTIR-11266)', () => {
  it('writes ONE `skip_final_check` entry while the check runs, and every read says it', async () => {
    await seedPlanRunning(['check', 'check']);
    const answer = await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    expect(answer.outcome).toBe('skipped');
    expect(answer.mailbox.skipFinalCheck).toBe(true);
    expect(answer.mailbox.stopped).toBe(false);

    const row = await adminDb.planChangeMailboxEntry.findFirstOrThrow({ where: { sessionId } });
    expect(row.kind).toBe('skip_final_check');
    expect(row.body).toBeNull();
    expect(row.disposition).toBeNull();
    // Derived from existence, as the stop is: consumed, it is still read.
    const first = await planChangeMailboxService.readForBoundary(JOB, pctx);
    const second = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect([first.skipFinalCheck, second.skipFinalCheck]).toEqual([true, true]);
    expect(first.turns).toEqual([]);
  });

  it('shares the job’s ONE sequence with the turns typed before it', async () => {
    await seedPlanRunning(['check']);
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'typed before the skip', idempotencyKey: 't' },
      pctx,
    );
    await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    const rows = await adminDb.planChangeMailboxEntry.findMany({
      where: { sessionId, jobId: JOB },
      orderBy: { seq: 'asc' },
    });
    expect(rows.map((r) => [r.kind, r.seq])).toEqual([
      ['turn', 0],
      ['skip_final_check', 1],
    ]);
  });

  it('a repeated key answers `skipped` again and writes nothing new, even once the check ended', async () => {
    const planId = await seedPlanRunning(['check']);
    await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    await adminDb.planStep.deleteMany({ where: { planId } });
    const again = await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    expect(again.outcome).toBe('skipped');
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(1);
  });

  it.each([
    ['before the check starts', ['lay', 'author'] as const, 'generating' as const],
    ['once its fix has begun', ['check', 'repair'] as const, 'generating' as const],
    ['once the plan is proposed', ['check'] as const, 'planned' as const],
  ])('%s answers `not_running` and writes nothing', async (_n, kinds, status) => {
    await seedPlanRunning(kinds, status);
    const answer = await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-late', pctx);
    expect(answer.outcome).toBe('not_running');
    expect(answer.mailbox.skipFinalCheck).toBe(false);
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
  });

  it('a job with no plan answers `not_running` and writes nothing', async () => {
    const answer = await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    expect(answer.outcome).toBe('not_running');
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId } })).toBe(0);
  });

  it('REFUSES a job this thread is not on, as the stop does', async () => {
    await expect(
      planChangeMailboxService.raiseSkipFinalCheck('job-elsewhere', 'skip-1', pctx),
    ).rejects.toBeInstanceOf(PlanChangeMailboxJobMismatchError);
  });

  it('the PEEK read (MOTIR-11267) answers the skip and leaves every turn unconsumed', async () => {
    await seedPlanRunning(['check']);
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'typed during the check', idempotencyKey: 't' },
      pctx,
    );
    await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    const peeked = await planChangeMailboxService.peekForBoundary(JOB, pctx);
    expect(peeked.skipFinalCheck).toBe(true);
    expect(peeked.turns.map((t) => t.text)).toEqual(['typed during the check']);
    // Still there for the pass that folds it.
    const read = await planChangeMailboxService.readForBoundary(JOB, pctx);
    expect(read.turns.map((t) => t.text)).toEqual(['typed during the check']);
  });

  it('the PEEK read of a job with no thread is empty', async () => {
    expect(await planChangeMailboxService.peekForBoundary('job-none', pctx)).toEqual({
      turns: [],
      stopped: false,
      skipFinalCheck: false,
    });
  });

  it('a skip never reads as a stop', async () => {
    await seedPlanRunning(['check']);
    await planChangeMailboxService.raiseSkipFinalCheck(JOB, 'skip-1', pctx);
    const delivery = await planChangeMailboxService.peekForJob(JOB, pctx);
    expect(delivery).toEqual({ turns: [], stopped: false, skipFinalCheck: true });
  });
});

describe('CONSUMPTION — a turn read at one boundary is not read at the next', () => {
  it('two boundaries against ONE delivery: the first gets it, the second is empty', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'read me once', idempotencyKey: 'a' },
      pctx,
    );

    const first = await planChangeMailboxService.readForBoundary(JOB, pctx);
    const second = await planChangeMailboxService.readForBoundary(JOB, pctx);

    expect(first.turns.map((t) => t.text)).toEqual(['read me once']);
    expect(second.turns).toEqual([]);
  });

  it('records the consumption durably, so a job RETRY does not re-fold the sentence', async () => {
    // The consumer de-duplicates in process (`consumedTurnIds`), which a retried
    // job loses. This is the half that survives one.
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'folded already', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.readForBoundary(JOB, pctx);

    const row = await adminDb.planChangeMailboxEntry.findFirstOrThrow({ where: { sessionId } });
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  it('⚠️ THE STOP IS NOT CONSUMED — every later boundary still reads it', async () => {
    // Derived from EXISTENCE, not from being unconsumed. A run that has been
    // ended stays ended, and a consumed stop would silently un-stop the next
    // check — which is the one branch the consumer reads FIRST.
    await planChangeMailboxService.raiseStop(JOB, 'stop-1', pctx);

    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).stopped).toBe(true);
    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).stopped).toBe(true);
    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).stopped).toBe(true);
  });

  it('a turn that arrives AFTER a boundary is read at the NEXT one', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'early', idempotencyKey: 'a' },
      pctx,
    );
    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).turns.map((t) => t.text)) //
      .toEqual(['early']);

    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'late', idempotencyKey: 'b' },
      pctx,
    );
    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).turns.map((t) => t.text)) //
      .toEqual(['late']);
  });

  it('PEEK does NOT consume — the composer can show its own queue without claiming it', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'still waiting', idempotencyKey: 'a' },
      pctx,
    );

    expect((await planChangeMailboxService.peek(JOB, sessionId, pctx)).turns).toHaveLength(1);
    expect((await planChangeMailboxService.peek(JOB, sessionId, pctx)).turns).toHaveLength(1);
    // …and the boundary still gets it.
    expect((await planChangeMailboxService.readForBoundary(JOB, pctx)).turns).toHaveLength(1);
  });
});

describe('AN EMPTY MAILBOX answers cheaply and unambiguously', () => {
  it('a running job with nothing waiting reads `{ turns: [], stopped: false, skipFinalCheck: false }`', async () => {
    expect(await planChangeMailboxService.readForBoundary(JOB, pctx)).toEqual({
      turns: [],
      stopped: false,
      skipFinalCheck: false,
    });
  });

  it('a job with NO THREAD reads empty rather than failing — a run whose thread vanished must finish', async () => {
    await adminDb.planChangeSession.delete({ where: { id: sessionId } });
    expect(await planChangeMailboxService.readForBoundary(JOB, pctx)).toEqual({
      turns: [],
      stopped: false,
      skipFinalCheck: false,
    });
  });

  it('a job the thread has MOVED ON from reads empty, not the new run’s mailbox', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'for run one', idempotencyKey: 'a' },
      pctx,
    );
    await adminDb.planChangeSession.update({
      where: { id: sessionId },
      data: { lastJobId: 'job-run-2' },
    });

    expect(await planChangeMailboxService.readForBoundary(JOB, pctx)).toEqual({
      turns: [],
      stopped: false,
      skipFinalCheck: false,
    });
  });
});

// ── The CROSS-REPO FIXTURE ──────────────────────────────────────────────────
//
// ⚠️ THIS IS THE ONE ASSERTION NO UNIT ON EITHER SIDE CAN REPLACE, and it is not
// a round trip through our own types — a round trip is true of any object.
//
// `readDelivery` below is `motir-ai` `src/llm/mailbox.ts` at `origin/main`
// (MOTIR-4060, merged), held here VERBATIM. It is the consumer half of the
// contract and it landed FIRST, deliberately, so merge order is free. Its parse
// is TOTAL and never throws: a field this side renames is not an error over
// there, it is an entry silently DROPPED. That is the right behaviour for a
// producer that has not shipped — and exactly the wrong thing to find out at a
// planning run.
//
// So a drift on EITHER side fails here instead.

type MailboxDisposition = 'fold' | 'restart';
interface MailboxTurn {
  id: string;
  text: string;
  receivedAt: string;
  disposition?: MailboxDisposition;
  target?: string | null;
}
interface MailboxDelivery {
  turns: readonly MailboxTurn[];
  stopped: boolean;
}
const EMPTY_DELIVERY: MailboxDelivery = { turns: [], stopped: false };

/** VERBATIM from `motir-ai` `src/llm/mailbox.ts` — do not "improve" it here. */
function readDelivery(raw: unknown): MailboxDelivery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_DELIVERY;
  const bag = raw as Record<string, unknown>;
  const stopped = bag['stopped'] === true;
  const rawTurns = Array.isArray(bag['turns']) ? (bag['turns'] as unknown[]) : [];
  const turns: MailboxTurn[] = [];
  for (const entry of rawTurns) {
    if (typeof entry !== 'object' || entry === null) continue;
    const t = entry as Record<string, unknown>;
    if (typeof t['id'] !== 'string' || (t['id'] as string).length === 0) continue;
    if (typeof t['text'] !== 'string' || (t['text'] as string).trim().length === 0) continue;
    turns.push({
      id: t['id'] as string,
      text: t['text'] as string,
      receivedAt: typeof t['receivedAt'] === 'string' ? (t['receivedAt'] as string) : '',
      disposition: t['disposition'] === 'restart' ? 'restart' : 'fold',
      ...(typeof t['target'] === 'string' || t['target'] === null
        ? { target: t['target'] as string | null }
        : {}),
    });
  }
  const ordered = turns
    .map((turn, index) => ({ turn, index }))
    .sort((a2, b2) =>
      a2.turn.receivedAt === b2.turn.receivedAt
        ? a2.index - b2.index
        : a2.turn.receivedAt < b2.turn.receivedAt
          ? -1
          : 1,
    )
    .map(({ turn }) => turn);
  return { turns: ordered, stopped };
}

describe('the TWO-REPO CONTRACT — motir-ai reads what motir-core sends', () => {
  it('every turn survives the consumer’s parse, with its disposition and target', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'fold this in', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.attachTurn(
      {
        jobId: JOB,
        body: 'now start over on billing',
        idempotencyKey: 'b',
        disposition: 'restart',
        restartTarget: 'MOTIR-42',
      },
      pctx,
    );

    const wire = JSON.parse(
      JSON.stringify(await planChangeMailboxService.readForBoundary(JOB, pctx)),
    );
    const parsed = readDelivery(wire);

    // NOT a round trip: this is the OTHER repo's reading, and a dropped entry is
    // how a renamed field would show up.
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns.map((t) => t.text)).toEqual(['fold this in', 'now start over on billing']);
    expect(parsed.turns.map((t) => t.disposition)).toEqual(['fold', 'restart']);
    expect(parsed.turns[1]!.target).toBe('MOTIR-42');
    expect(parsed.stopped).toBe(false);
  });

  it('the consumer’s TIE-BREAK reads our array order when two turns share an instant', async () => {
    // The producer's claim about order travels in the ARRAY. This is the
    // assertion that makes that true across the boundary rather than only
    // inside our own service.
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'one', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'two', idempotencyKey: 'b' },
      pctx,
    );
    await adminDb.planChangeMailboxEntry.updateMany({
      where: { sessionId },
      data: { createdAt: new Date('2026-09-03T05:00:00.000Z') },
    });

    const wire = JSON.parse(
      JSON.stringify(await planChangeMailboxService.readForBoundary(JOB, pctx)),
    );
    expect(readDelivery(wire).turns.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('the STOP branch the consumer reads FIRST is set by our answer', async () => {
    await planChangeMailboxService.attachTurn(
      { jobId: JOB, body: 'said', idempotencyKey: 'a' },
      pctx,
    );
    await planChangeMailboxService.raiseStop(JOB, 'stop', pctx);

    const wire = JSON.parse(
      JSON.stringify(await planChangeMailboxService.readForBoundary(JOB, pctx)),
    );
    const parsed = readDelivery(wire);
    // A delivery carrying both is a user who said something and then ended the
    // run; the consumer takes the stop branch, and both facts have to be present
    // for it to be able to.
    expect(parsed.stopped).toBe(true);
    expect(parsed.turns).toHaveLength(1);
  });

  it('an EMPTY answer parses to the consumer’s own EMPTY_DELIVERY, not to a dropped read', async () => {
    const wire = JSON.parse(
      JSON.stringify(await planChangeMailboxService.readForBoundary(JOB, pctx)),
    );
    expect(readDelivery(wire)).toEqual(EMPTY_DELIVERY);
  });
});
