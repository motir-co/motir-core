import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { defineJob } from '@/lib/jobs/defineJob';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
import { debouncedRunAt, resolveDebounceKey } from '@/lib/jobs/engine/debounce';
import { parseEventExpression, resolveEventExpression } from '@/lib/jobs/engine/eventExpression';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import { pageEmbeddingRequested } from '@/lib/jobs/definitions/pageEmbedding';
import { productionConfigRedeploy } from '@/lib/jobs/definitions/productionConfigRedeploy';
import { releaseDeploymentStatus } from '@/lib/jobs/definitions/releaseDeploymentStatus';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { CodeGraphRefreshData } from '@/lib/jobs/types';

// THE ENGINE'S DEBOUNCE (Story MOTIR-3417 · Subtask MOTIR-3483).
//
// `defineJob`'s `debounce` was declared by `system.code-graph-refresh`, forwarded
// to Inngest, and dropped before `registerEngineJob` — so moving the refresh to
// the engine without this would take a job whose whole point is "five pushes in a
// minute build ONE graph" and quietly make it build five, each booting its own
// metered container. Every one of those runs SUCCEEDS, so the only signal is the
// invoice; that is why the coalescing is a cutover blocker rather than a polish.
//
// Against REAL Postgres, because the guarantee is a row lock plus a PARTIAL
// UNIQUE INDEX and a mock can have neither.

// ⚠️ ONE TRIGGER PER PROBE, NOT ONE SHARED (MOTIR-3418). These three used to
// subscribe to a single real event and be selected between by the per-job cutover
// switch: a dispatch enqueued only the routed one, so `enqueued` named exactly the
// job under test. With one lane a dispatch enqueues EVERY subscriber, so a shared
// trigger returns all three plus the real consumers of that event, and every
// assertion of the form `expect(result.enqueued).toEqual([THE_ONE])` fails on the
// siblings. The isolation the switch used to provide is now the trigger's job.
const DEBOUNCED_TRIGGER = 'test/debounce-composed.pushed';
const PLAIN_TRIGGER = 'test/debounce-none.pushed';
const CAPPED_TRIGGER = 'test/debounce-capped.pushed';
/** The composed-key probe's trigger — what most tests in this file drive. */
const TRIGGER = DEBOUNCED_TRIGGER;

// Three test jobs, each on its own event, registered at module scope exactly as a
// real definition module is: a composed key like the refresh job's, one with no
// debounce at all, and one whose deferral cap is short enough to bind.
const DEBOUNCED_ID = 'test.debounce-composed';
const PLAIN_ID = 'test.debounce-none';
const CAPPED_ID = 'test.debounce-capped';

const PERIOD_MS = 120_000;
const TIMEOUT_MS = 900_000;

defineJob(
  {
    id: DEBOUNCED_ID as never,
    trigger: DEBOUNCED_TRIGGER as never,
    debounce: {
      // The same SHAPE `codeGraphRefresh` declares — two literals joining three
      // payload fields — because that expression is the reason the resolver had
      // to be widened at all.
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
    },
  },
  () => ({ ok: true }),
);
defineJob({ id: PLAIN_ID as never, trigger: PLAIN_TRIGGER as never }, () => ({ ok: true }));
defineJob(
  {
    id: CAPPED_ID as never,
    trigger: CAPPED_TRIGGER as never,
    debounce: { key: 'event.data.repoName', period: '2m', timeout: '15m' },
  },
  () => ({ ok: true }),
);

/** A push payload. `head` is the field a test uses to prove WHICH event survived. */
function push(over: Partial<Record<string, string>> = {}): Record<string, unknown> {
  return {
    workspaceId: null,
    installationId: 'inst_1',
    repoOwner: 'moooon-B-V',
    repoName: 'motir-core',
    head: 'sha-1',
    ...over,
  };
}

const rowsFor = (jobId: string) =>
  adminDb.jobQueueRun.findMany({ where: { jobId }, orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a same-key burst coalesces into ONE pending run carrying the LATEST event', () => {
  it('holds one row, repointed at the last event, due `period` after the last arrival', async () => {
    const before = Date.now();
    const results = [];
    for (const head of ['sha-1', 'sha-2', 'sha-3', 'sha-4']) {
      results.push(await dispatchEventToEngine(TRIGGER, push({ head })));
    }
    const after = Date.now();

    // The FIRST opened the window; the other three moved it.
    expect(results[0]!.enqueued).toEqual([DEBOUNCED_ID]);
    expect(results[0]!.coalesced).toEqual([]);
    for (const later of results.slice(1)) {
      expect(later.enqueued).toEqual([]);
      expect(later.coalesced).toEqual([DEBOUNCED_ID]);
      expect(later.failed).toEqual([]);
    }

    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // ⚠️ THE LATEST EVENT, not the first — the property the whole mechanism is
    // for. A refresh indexes the repo at its default branch, so the coalesced run
    // must be the one the LAST push triggered.
    expect(row.eventId).toBe(results.at(-1)!.eventId);
    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: row.eventId! } });
    expect((event.data as { head?: string }).head).toBe('sha-4');

    // Four events were written; one run points at one of them.
    expect(await adminDb.jobEvent.count()).toBe(4);

    // Due one whole period after the LAST arrival, not after the first.
    expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before + PERIOD_MS);
    expect(row.runAt.getTime()).toBeLessThanOrEqual(after + PERIOD_MS + 5_000);

    // And the window's origin never moves — it is what the deferral cap is
    // measured from.
    expect(row.debounceFirstSeenAt).not.toBeNull();
    expect(row.debounceFirstSeenAt!.getTime()).toBeLessThanOrEqual(after);
    expect(row.debounceKey).toBe('inst_1/moooon-B-V/motir-core');
  });

  it('keeps two DIFFERENT keys as two runs — the debounce does not merge tenants', async () => {
    await dispatchEventToEngine(TRIGGER, push({ repoName: 'motir-core' }));
    await dispatchEventToEngine(TRIGGER, push({ repoName: 'motir-ai' }));
    await dispatchEventToEngine(TRIGGER, push({ repoName: 'motir-core', head: 'sha-2' }));

    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.debounceKey).sort()).toEqual([
      'inst_1/moooon-B-V/motir-ai',
      'inst_1/moooon-B-V/motir-core',
    ]);
  });

  it('leaves a job declaring NO debounce completely unaffected', async () => {
    await dispatchEventToEngine(PLAIN_TRIGGER, push());
    await dispatchEventToEngine(PLAIN_TRIGGER, push());
    await dispatchEventToEngine(PLAIN_TRIGGER, push());

    // Three events, three runs, all due now — exactly as before this card.
    const rows = await rowsFor(PLAIN_ID);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.debounceKey === null)).toBe(true);
    expect(rows.every((r) => r.debounceFirstSeenAt === null)).toBe(true);
  });

  it('does NOT coalesce an event whose payload cannot supply the key', async () => {
    // A field the expression names is absent. Inngest MERGES in this case
    // (MOTIR-2994, measured) — every such event into one bucket, N−1 lost. The
    // engine does the opposite: no key means this event gets its own row.
    const partial = push();
    delete partial['repoOwner'];

    await dispatchEventToEngine(TRIGGER, partial);
    await dispatchEventToEngine(TRIGGER, partial);

    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.debounceKey === null)).toBe(true);
    // And they are due NOW, not in two minutes — an un-keyed event is not a
    // debounced one.
    expect(rows.every((r) => r.runAt.getTime() <= Date.now() + 1_000)).toBe(true);
  });
});

describe('the CONCURRENT first arrival — the race the partial index exists for', () => {
  it('yields one row and never a throw, with the loser coalescing rather than dropping', async () => {
    // Genuinely concurrent against a warm pool. `SELECT … FOR UPDATE` cannot
    // help here: there is no row yet, so both reads see the empty set and both
    // insert. This is the case a serial test cannot see, and the reason the
    // constraint exists at all.
    const results = await Promise.all([
      dispatchEventToEngine(TRIGGER, push({ head: 'sha-a' })),
      dispatchEventToEngine(TRIGGER, push({ head: 'sha-b' })),
    ]);

    const failed = results.flatMap((r) => r.failed);
    expect(failed, 'a P2002 escaped as a failure').toEqual([]);

    // Exactly one insert and one coalesce, whichever way round.
    expect(results.flatMap((r) => r.enqueued)).toEqual([DEBOUNCED_ID]);
    expect(results.flatMap((r) => r.coalesced)).toEqual([DEBOUNCED_ID]);

    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(1);

    // ⚠️ AND THE LOSER'S EVENT WAS NOT DROPPED. Reading the P2002 as
    // "already enqueued", the way the dedup path correctly does, would have
    // discarded a push here — which is the difference between the two mechanisms
    // and the reason the retry is a coalesce.
    const coalescer = results.find((r) => r.coalesced.length > 0)!;
    expect(rows[0]!.eventId).toBe(coalescer.eventId);
  });
});

describe('the CLAIM closes the window', () => {
  it('a same-key event arriving mid-run enqueues a NEW run rather than being folded in', async () => {
    await dispatchEventToEngine(TRIGGER, push({ head: 'sha-1' }));
    const [pending] = await rowsFor(DEBOUNCED_ID);
    expect(pending!.debounceKey).not.toBeNull();

    // Make it due, then claim it through the real claim — the point is that the
    // claim itself clears the key, not that a test can null a column.
    await adminDb.jobQueueRun.update({
      where: { id: pending!.id },
      data: { runAt: new Date(Date.now() - 1_000) },
    });
    const claimed = await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('worker-under-test', 5, 60_000, tx),
    );
    expect(claimed.map((r) => r.id)).toEqual([pending!.id]);

    const afterClaim = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: pending!.id } });
    expect(afterClaim.state).toBe('running');
    expect(afterClaim.debounceKey).toBeNull();
    expect(afterClaim.debounceFirstSeenAt).toBeNull();

    // A push during the index must not vanish into work that has already started.
    const later = await dispatchEventToEngine(TRIGGER, push({ head: 'sha-2' }));
    expect(later.enqueued).toEqual([DEBOUNCED_ID]);
    expect(later.coalesced).toEqual([]);

    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'pending')).toHaveLength(1);
  });

  it('and a RETRY of the claimed run does not collide with the row that push enqueued', async () => {
    // The hazard the clear-at-claim rule closes, driven end to end. Without it
    // the running row still carries the key, `rescheduleAt` puts it back to
    // `pending`, and the partial unique index rejects it — a unique violation on
    // the RETRY path, where the run then sticks `running` and is reclaimed
    // forever.

    await dispatchEventToEngine(TRIGGER, push({ head: 'sha-1' }));
    const [first] = await rowsFor(DEBOUNCED_ID);
    await adminDb.jobQueueRun.update({
      where: { id: first!.id },
      data: { runAt: new Date(Date.now() - 1_000) },
    });
    await withSystemContext((tx) =>
      jobQueueRepository.claimDueRuns('worker-under-test', 5, 60_000, tx),
    );
    await dispatchEventToEngine(TRIGGER, push({ head: 'sha-2' }));

    await expect(
      withSystemContext((tx) =>
        jobQueueRepository.rescheduleAt(first!.id, new Date(Date.now() + 1_000), tx, {
          lastError: { message: 'transient' },
        }),
      ),
    ).resolves.toMatchObject({ state: 'pending' });

    const pending = (await rowsFor(DEBOUNCED_ID)).filter((r) => r.state === 'pending');
    expect(pending).toHaveLength(2);
  });
});

describe('the deferral cap — the one place the engine is STRICTER than Inngest', () => {
  it('never pushes `run_at` past `first_seen + timeout`', async () => {
    // A burst that has ALREADY outlived its window, expressed as state rather
    // than as elapsed time: the row's window opened twenty minutes ago, and its
    // cap is fifteen. Driving it with real sleeps would need a sixteen-minute
    // test and would make the assertion a race.
    await dispatchEventToEngine(CAPPED_TRIGGER, push());
    const [row] = await rowsFor(CAPPED_ID);
    const firstSeen = new Date(Date.now() - 20 * 60_000);
    await adminDb.jobQueueRun.update({
      where: { id: row!.id },
      data: { debounceFirstSeenAt: firstSeen },
    });

    await dispatchEventToEngine(CAPPED_TRIGGER, push({ head: 'sha-2' }));

    const after = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: row!.id } });
    // Pinned to the cap — NOT `now + period`, which is what an uncapped
    // implementation would have written.
    expect(after.runAt.getTime()).toBe(firstSeen.getTime() + TIMEOUT_MS);
    expect(after.runAt.getTime()).toBeLessThan(Date.now());
    // And the origin still has not moved.
    expect(after.debounceFirstSeenAt!.getTime()).toBe(firstSeen.getTime());
    // The event was still carried across, so the run that finally executes is the
    // latest one — a cap firing must not also cost a push.
    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: after.eventId! } });
    expect((event.data as { head?: string }).head).toBe('sha-2');
  });

  it('takes the quiet period while the cap is still far away', () => {
    // The arithmetic on its own, so the two arms are visible without a database.
    const first = new Date('2026-08-26T10:00:00.000Z');
    const soon = new Date('2026-08-26T10:01:00.000Z');
    const late = new Date('2026-08-26T10:14:00.000Z');
    const opt = { key: 'event.data.repoName', period: '2m', timeout: '15m' };

    expect(debouncedRunAt(opt, soon, first).toISOString()).toBe('2026-08-26T10:03:00.000Z');
    // `late + 2m` would be 10:16, past the 10:15 cap.
    expect(debouncedRunAt(opt, late, first).toISOString()).toBe('2026-08-26T10:15:00.000Z');
    // The FIRST arrival has nothing to cap against.
    expect(debouncedRunAt(opt, first, null).toISOString()).toBe('2026-08-26T10:02:00.000Z');
  });
});

describe('an IMMEDIATE arrival — due now, and still coalesced (MOTIR-5360)', () => {
  it('opens a window that is ALREADY due, still carrying the key', async () => {
    const before = Date.now();
    const result = await dispatchEventToEngine(TRIGGER, push(), { immediate: true });
    const after = Date.now();

    expect(result.enqueued).toEqual([DEBOUNCED_ID]);
    const [row, ...rest] = await rowsFor(DEBOUNCED_ID);
    expect(rest).toHaveLength(0);
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(after);
    // The key is what keeps it a debounced row rather than a skipped debounce.
    expect(row!.debounceKey).toBe('inst_1/moooon-B-V/motir-core');
  });

  it('pulls a PENDING run forward instead of queueing a second one', async () => {
    await dispatchEventToEngine(TRIGGER, push({ head: 'sha-1' }));
    const before = Date.now();
    const result = await dispatchEventToEngine(TRIGGER, push({ head: 'sha-2' }), {
      immediate: true,
    });
    const after = Date.now();

    expect(result.coalesced).toEqual([DEBOUNCED_ID]);
    const rows = await rowsFor(DEBOUNCED_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(rows[0]!.runAt.getTime()).toBeLessThanOrEqual(after);
    expect(rows[0]!.eventId).toBe(result.eventId);
  });

  it('is never un-dued by an ordinary arrival before the claim — but still carries its event', async () => {
    await dispatchEventToEngine(TRIGGER, push({ head: 'sha-1' }), { immediate: true });
    const [due] = await rowsFor(DEBOUNCED_ID);

    const later = await dispatchEventToEngine(TRIGGER, push({ head: 'sha-2' }));

    expect(later.coalesced).toEqual([DEBOUNCED_ID]);
    const after = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: due!.id } });
    expect(after.runAt.getTime()).toBe(due!.runAt.getTime());
    expect(after.eventId).toBe(later.eventId);
  });

  it('changes nothing for a job that declares no debounce', async () => {
    const before = Date.now();
    const result = await dispatchEventToEngine(PLAIN_TRIGGER, push(), { immediate: true });
    expect(result.enqueued).toEqual([PLAIN_ID]);
    const [row] = await rowsFor(PLAIN_ID);
    expect(row!.debounceKey).toBeNull();
    expect(row!.runAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('the arithmetic: immediate is `now`, and a run already due stays where it is', () => {
    const first = new Date('2026-09-13T10:00:00.000Z');
    const now = new Date('2026-09-13T10:01:00.000Z');
    const opt = { key: 'event.data.repoName', period: '2m', timeout: '15m' };

    expect(debouncedRunAt(opt, now, null, { immediate: true }).toISOString()).toBe(
      '2026-09-13T10:01:00.000Z',
    );
    expect(debouncedRunAt(opt, now, first, { immediate: true }).toISOString()).toBe(
      '2026-09-13T10:01:00.000Z',
    );
    // A pending run already due at 10:00:30 is not pushed to 10:03.
    const dueAt = new Date('2026-09-13T10:00:30.000Z');
    expect(debouncedRunAt(opt, now, first, { pendingRunAt: dueAt }).toISOString()).toBe(
      '2026-09-13T10:00:30.000Z',
    );
    // A pending run NOT yet due moves exactly as before.
    const notYet = new Date('2026-09-13T10:02:00.000Z');
    expect(debouncedRunAt(opt, now, first, { pendingRunAt: notYet }).toISOString()).toBe(
      '2026-09-13T10:03:00.000Z',
    );
  });
});

describe('the resolver is ONE resolver, widened — and TOTAL', () => {
  it("resolves codeGraphRefresh's declared expression against a real payload", () => {
    // The AC's own comparison: the engine must produce for this expression the
    // three fields joined by the two literals, in order — read off the SHIPPED
    // declaration rather than a copy of it. (That declaration used to be read out
    // of the vendor function object's `opts`; `defineJob` returns it directly.)
    const declared = codeGraphRefresh.debounce!;

    const data: CodeGraphRefreshData = {
      installationId: 'inst_9',
      workspaceId: 'ws_1',
      repoOwner: 'moooon-B-V',
      repoName: 'motir-core',
      defaultBranch: 'main',
    };

    expect(
      resolveEventExpression(
        parseEventExpression('system.code-graph-refresh', 'debounce.key', declared.key),
        data,
      ),
    ).toBe('inst_9/moooon-B-V/motir-core');
  });

  it('THROWS at registration on an expression it cannot evaluate', () => {
    // The silent arm this forbids is worse than the idempotency one: Inngest
    // MERGES an unresolvable key rather than skipping the debounce, so N
    // unrelated repos would index as one.
    expect(() =>
      defineJob(
        {
          id: 'test.debounce-bad-key' as never,
          trigger: TRIGGER as never,
          debounce: { key: 'event.data.repo.name', period: '2m' },
        },
        () => ({ ok: true }),
      ),
    ).toThrow(/cannot evaluate/);
  });

  it('THROWS at registration on a duration it cannot parse', () => {
    // A `period` that fails to parse would otherwise surface at DISPATCH — i.e.
    // on a request path, as an event that failed to enqueue.
    expect(() =>
      defineJob(
        {
          id: 'test.debounce-bad-period' as never,
          trigger: TRIGGER as never,
          debounce: { key: 'event.data.repoName', period: 'two minutes' },
        },
        () => ({ ok: true }),
      ),
    ).toThrow(/debounce\.period/);
  });

  it('THROWS at registration when the cap is shorter than the period', () => {
    // Not merely odd: the cap would fire before the first quiet period could
    // elapse, so the job would read as debounced and never coalesce.
    expect(() =>
      defineJob(
        {
          id: 'test.debounce-inverted' as never,
          trigger: TRIGGER as never,
          debounce: { key: 'event.data.repoName', period: '15m', timeout: '2m' },
        },
        () => ({ ok: true }),
      ),
    ).toThrow(/would fire before the first quiet period/);
  });

  it('names the job and the supported form, so the failure is actionable', () => {
    const boom = () => parseEventExpression('some.job', 'debounce.key', 'event.ts');
    expect(boom).toThrow(/some\.job/);
    expect(boom).toThrow(/event\.data\.<field>/);
    expect(boom).toThrow(/MERGES/);
  });

  it('accepts literals and fields in any order, and tolerates whitespace', () => {
    expect(
      parseEventExpression('j', 'debounce.key', "  'v1:' + event.data.a+'/'+event.data.b  "),
    ).toEqual([
      { kind: 'literal', value: 'v1:' },
      { kind: 'field', field: 'a' },
      { kind: 'literal', value: '/' },
      { kind: 'field', field: 'b' },
    ]);
  });

  it('resolves null when ANY field term is missing or not a string', () => {
    const terms = parseEventExpression('j', 'debounce.key', "event.data.a + '/' + event.data.b");
    expect(resolveEventExpression(terms, { a: 'x', b: 'y' })).toBe('x/y');
    expect(resolveEventExpression(terms, { a: 'x' })).toBeNull();
    expect(resolveEventExpression(terms, { a: 'x', b: 7 })).toBeNull();
    expect(resolveEventExpression(terms, { a: 'x', b: '' })).toBeNull();
  });

  it('returns null for a job that declares no debounce at all', () => {
    expect(resolveDebounceKey(undefined, { repoName: 'x' }, 'j')).toBeNull();
  });
});

describe("codeGraphRefresh's declared debounce is untouched", () => {
  it('still carries the same debounce config, read off the registered definition', () => {
    // MOTIR-3413's boundary is that no job's observable behaviour changes. This
    // assertion is the byte-for-byte statement of that for the one job in the
    // tree carrying a `debounce`, and MOTIR-3418 did not touch it — only where it
    // is READ from. It used to come off the vendor function object's `opts`,
    // which was what the SDK KEPT after construction rather than what we passed
    // in; there is no construction now, so the declaration and the registration
    // are the same object.
    expect(codeGraphRefresh.debounce).toEqual({
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    });
  });

  it('declares a debounce the engine can actually evaluate', () => {
    // The one job in the tree with a `debounce` — if the engine could not parse
    // it, registration would already have thrown at import.
    expect(
      parseEventExpression(
        'system.code-graph-refresh',
        'debounce.key',
        codeGraphRefresh.debounce!.key,
      ),
    ).toHaveLength(5);
  });
});

describe('pageEmbeddingRequested — a typing burst on one page is ONE run (MOTIR-9571)', () => {
  // The collaborative editor saves as a member types, and every save emits. This
  // drives the REAL definition's trigger through the real dispatcher.
  const PAGE_TRIGGER = 'page/embedding.requested';

  /** A real workspace — the event row carries it as a foreign key. */
  async function workspace(): Promise<string> {
    const owner = await usersService.createUser({
      email: 'debounce-pages@example.com',
      password: 'hunter2hunter2',
      name: 'Debounce',
    });
    const ws = await workspacesService.createWorkspace({ name: 'Pages', ownerUserId: owner.id });
    return ws.workspace.id;
  }

  it('coalesces a same-page burst into one row keyed on the page, due 30 s after the last', async () => {
    const workspaceId = await workspace();
    const before = Date.now();
    for (let i = 0; i < 5; i++) {
      await dispatchEventToEngine(PAGE_TRIGGER, { workspaceId, pageId: 'page_1' });
    }
    const after = Date.now();

    const rows = await rowsFor(pageEmbeddingRequested.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debounceKey).toBe('page_1');
    expect(rows[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(rows[0]!.runAt.getTime()).toBeLessThanOrEqual(after + 30_000 + 5_000);
  });

  it('keeps two pages as two runs', async () => {
    const workspaceId = await workspace();
    await dispatchEventToEngine(PAGE_TRIGGER, { workspaceId, pageId: 'page_1' });
    await dispatchEventToEngine(PAGE_TRIGGER, { workspaceId, pageId: 'page_2' });
    await dispatchEventToEngine(PAGE_TRIGGER, { workspaceId, pageId: 'page_1' });

    const rows = await rowsFor(pageEmbeddingRequested.id);
    expect(rows.map((r) => r.debounceKey).sort()).toEqual(['page_1', 'page_2']);
  });
});

describe('productionConfigRedeploy — a burst of saves to one repository is ONE run (MOTIR-10032)', () => {
  // Every save to a repository's environment configuration emits
  // `environment.config.changed`. The redeploy job folds one repository's
  // production burst into one run, and keeps the environment in the key so a
  // preview save never becomes the "latest event" of a production burst.
  const CONFIG_TRIGGER = 'environment.config.changed';

  async function workspace(): Promise<string> {
    const owner = await usersService.createUser({
      email: 'debounce-config@example.com',
      password: 'hunter2hunter2',
      name: 'Debounce',
    });
    const ws = await workspacesService.createWorkspace({ name: 'Config', ownerUserId: owner.id });
    return ws.workspace.id;
  }

  const change = (
    workspaceId: string,
    projectRepositoryId: string,
    environment: 'production' | 'preview',
  ) => ({
    workspaceId,
    projectRepositoryId,
    environment,
    name: 'GREETING',
    action: 'replaced' as const,
    actorId: 'user_1',
  });

  it('coalesces a same-repository production burst into one row, due 30 s after the last', async () => {
    const workspaceId = await workspace();
    const before = Date.now();
    for (let i = 0; i < 5; i++) {
      await dispatchEventToEngine(CONFIG_TRIGGER, change(workspaceId, 'repo_1', 'production'));
    }
    const after = Date.now();

    const rows = await rowsFor(productionConfigRedeploy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debounceKey).toBe('repo_1/production');
    expect(rows[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    expect(rows[0]!.runAt.getTime()).toBeLessThanOrEqual(after + 30_000 + 5_000);
  });

  it('keeps two repositories, and a repository’s two environments, as separate runs', async () => {
    const workspaceId = await workspace();
    await dispatchEventToEngine(CONFIG_TRIGGER, change(workspaceId, 'repo_1', 'production'));
    await dispatchEventToEngine(CONFIG_TRIGGER, change(workspaceId, 'repo_1', 'preview'));
    await dispatchEventToEngine(CONFIG_TRIGGER, change(workspaceId, 'repo_2', 'production'));

    const rows = await rowsFor(productionConfigRedeploy.id);
    expect(rows.map((r) => r.debounceKey).sort()).toEqual([
      'repo_1/preview',
      'repo_1/production',
      'repo_2/production',
    ]);
  });
});

describe('releaseDeploymentStatus — a release’s burst of state changes is ONE run (MOTIR-10033)', () => {
  // A release's creation and its first move commit together, and each emits
  // `hosted-release.status`. The status job folds one release's burst into one
  // run; the run reads the release as it stands and posts what it is owed.
  const STATUS_EVENT = 'hosted-release.status';

  async function workspace(): Promise<string> {
    const owner = await usersService.createUser({
      email: 'debounce-release-status@example.com',
      password: 'hunter2hunter2',
      name: 'Debounce',
    });
    const ws = await workspacesService.createWorkspace({ name: 'Releases', ownerUserId: owner.id });
    return ws.workspace.id;
  }

  it('coalesces a same-release burst into one row, due 2 s after the last', async () => {
    const workspaceId = await workspace();
    const before = Date.now();
    for (let i = 0; i < 3; i++) {
      await dispatchEventToEngine(STATUS_EVENT, { workspaceId, releaseId: 'rel_1' });
    }
    const after = Date.now();

    const rows = await rowsFor(releaseDeploymentStatus.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.debounceKey).toBe('rel_1');
    expect(rows[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before + 2_000);
    expect(rows[0]!.runAt.getTime()).toBeLessThanOrEqual(after + 2_000 + 5_000);
  });

  it('keeps two releases as separate runs', async () => {
    const workspaceId = await workspace();
    await dispatchEventToEngine(STATUS_EVENT, { workspaceId, releaseId: 'rel_1' });
    await dispatchEventToEngine(STATUS_EVENT, { workspaceId, releaseId: 'rel_2' });

    const rows = await rowsFor(releaseDeploymentStatus.id);
    expect(rows.map((r) => r.debounceKey).sort()).toEqual(['rel_1', 'rel_2']);
  });
});
