import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFilesResult } from '@/lib/git';
import { githubProvider } from '@/lib/git/providers/github';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import type { JobContext } from '@/lib/jobs/defineJob';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import { pushComparisonFor, settledOutcome } from '@/lib/jobs/indexHandoffSteps';
import { jobServices } from '@/lib/jobs/services';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { refreshEventFor, seedIndexWorkspace } from '../helpers/indexFleet';
import {
  HANDOFF_HEAD,
  HANDOFF_OLDER,
  handoffWorld,
  publishedAt,
  runningAt,
  SOURCE_URL_SENTINEL,
  statusAnswer,
  stubIndexHandoff,
} from '../helpers/indexHandoff';
import { JobTestEngine } from '../helpers/jobs';

// A PUSH IS HANDED OFF AS A PUSH (MOTIR-11884 · story MOTIR-11022).
//
// A `system.code-graph-refresh` run whose payload says `refreshCause: 'push'`
// compares the head motir-core last STAMPED with the live head and, when it can
// vouch for the comparison, hands motir-ai `kind: push` with the host's changed
// paths. Every other case is a `refresh`. The rule itself is pure and tested as a
// table first; then the real job, over a real Postgres, with motir-ai and GitHub
// stubbed at the HTTP boundary and the provider's `listChangedFiles` doubled.

const REPO = { owner: 'moooon', name: 'motir-core' };

const ok = (
  files: { path: string; previousPath?: string }[],
  truncated = false,
): ChangedFilesResult =>
  ({
    outcome: 'ok',
    base: HANDOFF_OLDER,
    head: HANDOFF_HEAD,
    files: files.map((f) => ({ ...f, status: f.previousPath ? 'renamed' : 'modified' })),
    truncated,
    baseSha: HANDOFF_OLDER,
    headSha: HANDOFF_HEAD,
  }) as ChangedFilesResult;

const failure = (outcome: string): ChangedFilesResult =>
  ({ outcome, base: HANDOFF_OLDER, head: HANDOFF_HEAD, detail: 'x' }) as ChangedFilesResult;

/** Every console line written while a case ran. */
const consoleLines: string[] = [];

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  stubIndexHandoff();
  consoleLines.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the rule, as a table ─────────────────────────────────────────────────────

describe('pushComparisonFor — push only when the comparison can be vouched for', () => {
  it('an ok, untruncated listing is a push naming every path and each rename’s old path, once', () => {
    expect(
      pushComparisonFor(
        HANDOFF_OLDER,
        HANDOFF_HEAD,
        ok([
          { path: 'src/added.ts' },
          { path: 'src/modified.ts' },
          { path: 'src/removed.ts' },
          { path: 'src/new-name.ts', previousPath: 'src/old-name.ts' },
          { path: 'src/swap.ts', previousPath: 'src/modified.ts' },
        ]),
      ),
    ).toEqual({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: [
        'src/added.ts',
        'src/modified.ts',
        'src/removed.ts',
        'src/new-name.ts',
        'src/old-name.ts',
        'src/swap.ts',
      ],
    });
  });

  it('an empty listing is a valid push with an empty list', () => {
    expect(pushComparisonFor(HANDOFF_OLDER, HANDOFF_HEAD, ok([]))).toEqual({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: [],
    });
  });

  it.each([
    ['no_stamped_head', null, HANDOFF_HEAD, ok([])],
    ['head_unchanged', HANDOFF_HEAD, HANDOFF_HEAD, ok([])],
    ['sha_not_hex', 'abc123', HANDOFF_HEAD, ok([])],
    ['sha_not_hex', HANDOFF_OLDER.toUpperCase(), HANDOFF_HEAD, ok([])],
    ['sha_not_hex', HANDOFF_OLDER, 'main', ok([])],
    ['no_such_ref', HANDOFF_OLDER, HANDOFF_HEAD, failure('no_such_ref')],
    ['not_connected', HANDOFF_OLDER, HANDOFF_HEAD, failure('not_connected')],
    ['revoked', HANDOFF_OLDER, HANDOFF_HEAD, failure('revoked')],
    ['too_large', HANDOFF_OLDER, HANDOFF_HEAD, failure('too_large')],
    ['host_error', HANDOFF_OLDER, HANDOFF_HEAD, failure('host_error')],
    ['truncated', HANDOFF_OLDER, HANDOFF_HEAD, ok([{ path: 'a' }], true)],
    ['comparison_threw', HANDOFF_OLDER, HANDOFF_HEAD, { threw: true as const }],
    ['comparison_threw', HANDOFF_OLDER, HANDOFF_HEAD, null],
  ])('falls back to a refresh: %s', (fallback, stamped, head, listing) => {
    expect(pushComparisonFor(stamped, head, listing)).toEqual({ kind: 'refresh', fallback });
  });
});

// ── through the real job ─────────────────────────────────────────────────────

async function seedStamped(slug: string, stampedHead: string | null) {
  const seeded = await seedIndexWorkspace(slug, 1);
  await adminDb.githubRepo.updateMany({
    where: { owner: REPO.owner, name: REPO.name },
    data: { indexedHeadSha: stampedHead },
  });
  return seeded;
}

function pushEvent(seeded: { installationId: string; workspaceId: string }, refreshCause = true) {
  const event = refreshEventFor(seeded);
  return {
    ...event,
    data: { ...event.data, ...(refreshCause ? { refreshCause: 'push' as const } : {}) },
  };
}

async function runPush(slug: string, stampedHead: string | null, refreshCause = true) {
  const seeded = await seedStamped(slug, stampedHead);
  return new JobTestEngine({ function: codeGraphRefresh }).execute({
    events: [pushEvent(seeded, refreshCause)],
  });
}

const stampedHead = async () =>
  (
    await adminDb.githubRepo.findFirstOrThrow({
      where: { owner: REPO.owner, name: REPO.name },
      select: { indexedHeadSha: true },
    })
  ).indexedHeadSha;

describe('a push-caused refresh hands off kind: push', () => {
  it('names the head, the stamped head and the changed paths, then settles on the published head', async () => {
    const listing = vi
      .spyOn(githubProvider, 'listChangedFiles')
      .mockResolvedValue(ok([{ path: 'a.ts' }, { path: 'b.ts', previousPath: 'old-b.ts' }]));

    const run = await runPush('push-ok', HANDOFF_OLDER);

    expect(run.error).toBeUndefined();
    expect(listing).toHaveBeenCalledWith(
      expect.any(String),
      REPO.owner,
      REPO.name,
      HANDOFF_OLDER,
      HANDOFF_HEAD,
    );
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'push',
      commitSha: HANDOFF_HEAD,
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: ['a.ts', 'b.ts', 'old-b.ts'],
    });
    expect(run.result).toMatchObject({ indexed: true, indexedBy: 'motir-codegraph' });
    expect(await stampedHead()).toBe(HANDOFF_HEAD);
  });

  it('an empty comparison is sent as an empty array', async () => {
    vi.spyOn(githubProvider, 'listChangedFiles').mockResolvedValue(ok([]));
    await runPush('push-empty', HANDOFF_OLDER);
    expect(handoffWorld.handoffs[0]).toMatchObject({ kind: 'push', changedPaths: [] });
  });
});

describe('a push-caused refresh falls back to kind: refresh, logged without the URL', () => {
  const refreshOnly = () => {
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]!['kind']).toBe('refresh');
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('previousCommitSha');
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('changedPaths');
    expect(consoleLines.filter((l) => l.includes(SOURCE_URL_SENTINEL))).toEqual([]);
  };
  const loggedReason = (reason: string) =>
    expect(
      consoleLines.filter((l) => l.includes('moooon/motir-core') && l.includes(`(${reason})`)),
    ).toHaveLength(1);

  it('no stamped head: never asks the host', async () => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    await runPush('push-nostamp', null);
    refreshOnly();
    loggedReason('no_stamped_head');
    expect(listing).not.toHaveBeenCalled();
  });

  it('a stamped head equal to the head', async () => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    await runPush('push-same', HANDOFF_HEAD);
    refreshOnly();
    loggedReason('head_unchanged');
    expect(listing).not.toHaveBeenCalled();
  });

  it('a stamped head that is not 40 lowercase hex', async () => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    await runPush('push-nothex', 'deadbeef');
    refreshOnly();
    loggedReason('sha_not_hex');
    expect(listing).not.toHaveBeenCalled();
  });

  it.each(['no_such_ref', 'not_connected', 'revoked', 'too_large', 'host_error'])(
    'a %s comparison',
    async (outcome) => {
      vi.spyOn(githubProvider, 'listChangedFiles').mockResolvedValue(failure(outcome));
      await runPush(`push-${outcome}`, HANDOFF_OLDER);
      refreshOnly();
      loggedReason(outcome);
    },
  );

  it('a truncated comparison', async () => {
    vi.spyOn(githubProvider, 'listChangedFiles').mockResolvedValue(ok([{ path: 'a' }], true));
    await runPush('push-truncated', HANDOFF_OLDER);
    refreshOnly();
    loggedReason('truncated');
  });

  it('a comparison that throws despite its contract', async () => {
    vi.spyOn(githubProvider, 'listChangedFiles').mockRejectedValue(new Error('boom'));
    const run = await runPush('push-threw', HANDOFF_OLDER);
    expect(run.error).toBeUndefined();
    refreshOnly();
    loggedReason('comparison_threw');
  });

  it('a refresh with no refreshCause never compares at all', async () => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    const run = await runPush('push-nocause', HANDOFF_OLDER, false);
    refreshOnly();
    expect(listing).not.toHaveBeenCalled();
    expect(run.ctx.step.run.mock.calls.map((c: unknown[]) => c[0])).not.toContain(
      'index-push-diff-v1',
    );
  });
});

// ── the comparison is memoized ───────────────────────────────────────────────

describe('the comparison runs in its own memoized step', () => {
  it('deferring passes and a re-handed 429 ask the host ONCE for the pair', async () => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles').mockResolvedValue(ok([]));
    const seeded = await seedStamped('push-memo', HANDOFF_OLDER);
    handoffWorld.handoff = 'rate_limited';
    handoffWorld.statuses = [runningAt(HANDOFF_HEAD)];

    const memo = new Map<string, unknown>();
    const ctx = {
      event: pushEvent(seeded),
      step: {
        run: async (id: string, fn: () => unknown) => {
          if (memo.has(id)) return memo.get(id);
          const value = JSON.parse(JSON.stringify(await fn())) as unknown;
          memo.set(id, value);
          return value;
        },
        sleep: async () => undefined,
      },
      runId: 'run-push-memo',
      attempt: 0,
    } as unknown as JobContext;
    const pass = async () => {
      try {
        await codeGraphRefresh.handler(ctx, jobServices);
        return 'done';
      } catch (err) {
        if (isJobRunDefer(err)) return 'deferred';
        throw err;
      }
    };

    expect(await pass()).toBe('deferred'); // the 429
    handoffWorld.handoff = 'accepted';
    expect(await pass()).toBe('deferred'); // handed, still running
    expect(await pass()).toBe('deferred');

    expect(listing).toHaveBeenCalledTimes(1);
    expect(handoffWorld.handoffs).toHaveLength(2);
    expect(handoffWorld.handoffs.every((h) => h['kind'] === 'push')).toBe(true);
  });
});

// ── superseded or overtaken ──────────────────────────────────────────────────

describe('two pushes handed back to back settle on the newer published head', () => {
  const SECOND = 'f00d'.padEnd(40, '3');

  it('both succeed, neither throws or waits out the deadline, and the stamp is the second commit', async () => {
    vi.spyOn(githubProvider, 'listChangedFiles').mockResolvedValue(ok([]));
    const seeded = await seedStamped('push-superseded', HANDOFF_OLDER);
    const engine = new JobTestEngine({ function: codeGraphRefresh });
    const later = () => new Date(Date.now() + 60_000).toISOString();

    // The first push is handed at HEAD; the service publishes the SECOND push's
    // commit instead, after the handoff, with nothing in progress.
    handoffWorld.statuses = [publishedAt(SECOND, later())];
    const first = await engine.execute({ events: [pushEvent(seeded)] });
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({
      indexed: true,
      indexedBy: 'motir-codegraph',
      supersededBy: SECOND,
    });
    expect(await stampedHead()).toBe(SECOND);

    // The second push is handed at SECOND and reads it published.
    handoffWorld.head = SECOND;
    handoffWorld.statuses = [publishedAt(SECOND, later())];
    const second = await engine.execute({
      events: [pushEvent(seeded)],
    });
    expect(second.error).toBeUndefined();
    expect(second.result).not.toHaveProperty('supersededBy');
    expect(await stampedHead()).toBe(SECOND);
    expect(handoffWorld.handoffs.map((h) => h['commitSha'])).toEqual([HANDOFF_HEAD, SECOND]);
  });

  it('a newer indexed commit while a job is still in progress keeps the run waiting', () => {
    const handed = { commitSha: HANDOFF_HEAD, handedAt: '2026-11-22T10:00:00.000Z' };
    const newer = {
      commit: SECOND,
      publishedAt: '2026-11-22T10:05:00.000Z',
    };
    expect(
      settledOutcome(
        statusAnswer({
          indexedCommit: newer,
          inProgressJob: (runningAt(SECOND) as { inProgressJob: unknown }).inProgressJob,
        }) as never,
        handed,
      ),
    ).toEqual({ kind: 'pending' });
    // Published BEFORE the handoff is the old graph, not an overtaking one.
    expect(
      settledOutcome(
        statusAnswer({
          indexedCommit: { ...newer, publishedAt: '2026-11-22T09:00:00.000Z' },
        }) as never,
        handed,
      ),
    ).toEqual({ kind: 'pending' });
    expect(settledOutcome(statusAnswer({ indexedCommit: newer }) as never, handed)).toEqual({
      kind: 'superseded',
      publishedCommit: SECOND,
    });
  });
});
