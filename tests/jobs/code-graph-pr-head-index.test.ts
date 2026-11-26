import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangedFilesResult } from '@/lib/git';
import { githubProvider } from '@/lib/git/providers/github';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  codeGraphPrHeadIndex,
  prHeadComparisonFor,
} from '@/lib/jobs/definitions/codeGraphPrHeadIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import type { JobContext } from '@/lib/jobs/defineJob';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import * as indexRepoRow from '@/lib/jobs/indexRepoRow';
import { jobServices } from '@/lib/jobs/services';
import type { CodeGraphPrHeadIndexData } from '@/lib/jobs/types';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { refreshEventFor, seedIndexWorkspace } from '../helpers/indexFleet';
import {
  HANDOFF_HEAD,
  HANDOFF_OLDER,
  handoffWorld,
  livePullRequest,
  publishedAt,
  SOURCE_URL_SENTINEL,
  stubIndexHandoff,
} from '../helpers/indexHandoff';
import { JobTestEngine } from '../helpers/jobs';

// A PULL REQUEST'S HEAD IS HANDED OFF FOR INDEXING (MOTIR-12257 · story MOTIR-12250).
//
// `system.code-graph-pr-head-index` reads the pull request LIVE, compares the
// repository's stamped head with the live head in BOTH directions, and hands motir-ai
// a branch head (`isDefaultBranch: false`) — then stops: it reads no status and writes
// none of the repository row's index state. The rule is pure and tested as a table
// first; then the real job over a real Postgres, motir-ai and GitHub stubbed at the
// HTTP boundary and the provider's `listChangedFiles` doubled per direction.

const REPO = { owner: 'moooon', name: 'motir-core' };
/** The default branch's newer commit: `main` moved after the branch left it. */
const NEWER = 'f00d'.padEnd(40, '3');

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
  handoffWorld.pullRequest = livePullRequest();
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

describe('prHeadComparisonFor — a push only when both listings can be vouched for', () => {
  it('the union of both directions, paths and renames’ old paths, once each', () => {
    expect(
      prHeadComparisonFor(
        HANDOFF_OLDER,
        HANDOFF_HEAD,
        ok([{ path: 'src/a.ts' }, { path: 'src/new.ts', previousPath: 'src/old.ts' }]),
        ok([{ path: 'src/a.ts' }, { path: 'src/b.ts', previousPath: 'src/old.ts' }]),
      ),
    ).toEqual({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: ['src/a.ts', 'src/new.ts', 'src/old.ts', 'src/b.ts'],
    });
  });

  it('a file only the default branch changed after the branch left it is named (F)', () => {
    // `listChangedFiles(indexed, head)` is three-dot: the branch's own changes only.
    // F changed on `main` and the branch never touched it, so only the reverse
    // listing names it — and a delta without it would show `main`'s F as the branch's.
    const comparison = prHeadComparisonFor(
      HANDOFF_OLDER,
      HANDOFF_HEAD,
      ok([{ path: 'branch-only.ts' }]),
      ok([{ path: 'F.ts' }]),
    );
    expect(comparison).toEqual({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: ['branch-only.ts', 'F.ts'],
    });
  });

  it('two empty listings are a valid push with an empty list', () => {
    expect(prHeadComparisonFor(HANDOFF_OLDER, HANDOFF_HEAD, ok([]), ok([]))).toEqual({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: [],
    });
  });

  const clean = ok([]);
  it.each([
    ['no_stamped_head', null, HANDOFF_HEAD, clean, clean],
    ['head_unchanged', HANDOFF_HEAD, HANDOFF_HEAD, clean, clean],
    ['sha_not_hex', 'abc123', HANDOFF_HEAD, clean, clean],
    ['sha_not_hex', HANDOFF_OLDER.toUpperCase(), HANDOFF_HEAD, clean, clean],
    ['sha_not_hex', HANDOFF_OLDER, 'feature-x', clean, clean],
    ['no_such_ref', HANDOFF_OLDER, HANDOFF_HEAD, failure('no_such_ref'), clean],
    ['not_connected', HANDOFF_OLDER, HANDOFF_HEAD, clean, failure('not_connected')],
    ['revoked', HANDOFF_OLDER, HANDOFF_HEAD, failure('revoked'), clean],
    ['too_large', HANDOFF_OLDER, HANDOFF_HEAD, clean, failure('too_large')],
    ['host_error', HANDOFF_OLDER, HANDOFF_HEAD, failure('host_error'), failure('revoked')],
    ['truncated', HANDOFF_OLDER, HANDOFF_HEAD, ok([{ path: 'a' }], true), clean],
    ['truncated', HANDOFF_OLDER, HANDOFF_HEAD, clean, ok([{ path: 'a' }], true)],
    ['comparison_threw', HANDOFF_OLDER, HANDOFF_HEAD, { threw: true as const }, clean],
    ['comparison_threw', HANDOFF_OLDER, HANDOFF_HEAD, clean, { threw: true as const }],
    ['comparison_threw', HANDOFF_OLDER, HANDOFF_HEAD, null, null],
  ])('falls back to a first index: %s', (fallback, stamped, head, forward, backward) => {
    expect(prHeadComparisonFor(stamped, head, forward, backward)).toEqual({
      kind: 'first_index',
      fallback,
    });
  });
});

// ── through the real job ─────────────────────────────────────────────────────

/** The row columns a pull-request run must never write. */
const ROW_STATE = {
  indexedHeadSha: true,
  indexedAt: true,
  indexingRunId: true,
  indexPausedReason: true,
  indexPausedAt: true,
  indexRefusedAt: true,
  indexRefusedSizeBytes: true,
  indexRefusedCapBytes: true,
} as const;

const rowState = () =>
  adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO.owner, name: REPO.name },
    select: ROW_STATE,
  });

async function seed(slug: string, row: Record<string, unknown> = {}) {
  const seeded = await seedIndexWorkspace(slug, 1);
  await adminDb.githubRepo.updateMany({
    where: { owner: REPO.owner, name: REPO.name },
    data: { indexedHeadSha: HANDOFF_OLDER, ...row },
  });
  return seeded;
}

function prHeadEvent(
  seeded: { installationId: string; workspaceId: string },
  data: Partial<CodeGraphPrHeadIndexData> = {},
) {
  return {
    name: 'system.code-graph-pr-head-index' as const,
    id: `evt-pr-head-${seeded.installationId}`,
    data: {
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repoOwner: REPO.owner,
      repoName: REPO.name,
      defaultBranch: 'main',
      pullRequestNumber: 7,
      headRef: 'feature-x',
      baseRef: 'main',
      ...data,
    } satisfies CodeGraphPrHeadIndexData,
  };
}

async function runPrHead(slug: string, row: Record<string, unknown> = {}) {
  const seeded = await seed(slug, row);
  const before = await rowState();
  const run = await new JobTestEngine({ function: codeGraphPrHeadIndex }).execute({
    events: [prHeadEvent(seeded)],
  });
  return { run, seeded, before };
}

/** Each direction's listing, by `base...head`. */
function listings(byPair: Record<string, ChangedFilesResult | Error>) {
  return vi
    .spyOn(githubProvider, 'listChangedFiles')
    .mockImplementation(async (_inst, _owner, _name, base, head) => {
      const answer = byPair[`${base}...${head}`];
      if (!answer) throw new Error(`unexpected listing ${base}...${head}`);
      if (answer instanceof Error) throw answer;
      return answer;
    });
}

/** No memo, output or log line carries the source URL. */
async function expectNoSourceUrl(run: {
  result?: unknown;
  ctx: { step: { run: { mock: { results: { value: unknown }[] } } } };
}) {
  expect(JSON.stringify(run.result ?? null)).not.toContain(SOURCE_URL_SENTINEL);
  for (const memo of run.ctx.step.run.mock.results) {
    // Each step's memo is the resolved value of its (async) body.
    expect(JSON.stringify((await memo.value) ?? null)).not.toContain(SOURCE_URL_SENTINEL);
  }
  expect(consoleLines.filter((l) => l.includes(SOURCE_URL_SENTINEL))).toEqual([]);
}

describe('an open same-repository pull request hands off its live head', () => {
  it('a push over the stamped head with the two-direction union, and nothing else written', async () => {
    const listing = listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: ok([{ path: 'branch.ts' }]),
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: ok([{ path: 'F.ts' }]),
    });
    const claim = vi.spyOn(indexRepoRow, 'claimIndexingRepo');
    const settle = vi.spyOn(indexRepoRow, 'settleIndexingRepo');
    const lift = vi.spyOn(indexRepoRow, 'liftIndexingPause');
    const pause = vi.spyOn(indexRepoRow, 'pauseIndexingRepo');

    const { run, before } = await runPrHead('prh-push');

    expect(run.error).toBeUndefined();
    expect(listing).toHaveBeenCalledTimes(2);
    expect(handoffWorld.pullRequestReads).toEqual([7]);
    expect(handoffWorld.tarballRefs).toEqual([HANDOFF_HEAD]);
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      repoRef: 'moooon/motir-core',
      kind: 'push',
      isDefaultBranch: false,
      ref: 'feature-x',
      commitSha: HANDOFF_HEAD,
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: ['branch.ts', 'F.ts'],
    });
    expect(String(handoffWorld.handoffs[0]!['sourceUrl'])).toContain(SOURCE_URL_SENTINEL);
    expect(run.result).toEqual({
      handed: true,
      repoRef: 'moooon/motir-core',
      pullRequestNumber: 7,
      commitSha: HANDOFF_HEAD,
      kind: 'push',
    });
    // It ends at the accepted handoff: no status read, no row write.
    expect(handoffWorld.statusReads).toEqual([]);
    expect(await rowState()).toEqual(before);
    for (const spy of [claim, settle, lift, pause]) expect(spy).not.toHaveBeenCalled();

    const stepIds = run.ctx.step.run.mock.calls.map((c: unknown[]) => c[0]);
    expect(stepIds).toEqual(
      expect.arrayContaining([
        'resolve-target-v1',
        'pr-gates-v1',
        'pr-head-v1',
        'pr-head-diff-v1',
        'pr-handoff-v1',
      ]),
    );
    const handoffMemo: unknown =
      await run.ctx.step.run.mock.results[stepIds.indexOf('pr-handoff-v1')]!.value;
    expect(Object.keys(handoffMemo as object).sort()).toEqual(['commitSha', 'handedAt', 'jobId']);
    await expectNoSourceUrl(run);
  });

  it('a stacked pull request (base another branch) is a push over the same stamped head', async () => {
    listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: ok([{ path: 'a.ts' }]),
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: ok([]),
    });
    const seeded = await seed('prh-stacked');
    const run = await new JobTestEngine({ function: codeGraphPrHeadIndex }).execute({
      events: [prHeadEvent(seeded, { baseRef: 'feature-base' })],
    });
    expect(run.error).toBeUndefined();
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'push',
      previousCommitSha: HANDOFF_OLDER,
      isDefaultBranch: false,
    });
  });

  it('an older synchronize hands off the host’s CURRENT head, never an older one', async () => {
    const CURRENT = 'abcd'.padEnd(40, '9');
    handoffWorld.pullRequest = livePullRequest({ headSha: CURRENT });
    listings({
      [`${HANDOFF_OLDER}...${CURRENT}`]: ok([]),
      [`${CURRENT}...${HANDOFF_OLDER}`]: ok([]),
    });
    const { run } = await runPrHead('prh-current');
    expect(run.result).toMatchObject({ handed: true, commitSha: CURRENT });
    expect(handoffWorld.handoffs.map((h) => h['commitSha'])).toEqual([CURRENT]);
    expect(handoffWorld.tarballRefs).toEqual([CURRENT]);
  });

  it('after a pull-request run, the next default-branch push still compares with the old stamp', async () => {
    const listing = listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: ok([{ path: 'branch.ts' }]),
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: ok([]),
    });
    const { seeded } = await runPrHead('prh-then-push');
    listing.mockClear();
    listing.mockResolvedValue(ok([{ path: 'main.ts' }]));
    handoffWorld.head = NEWER;
    handoffWorld.statuses = [publishedAt(NEWER, new Date(Date.now() + 60_000).toISOString())];
    const event = refreshEventFor(seeded);
    const push = await new JobTestEngine({ function: codeGraphRefresh }).execute({
      events: [{ ...event, data: { ...event.data, refreshCause: 'push' as const } }],
    });
    expect(push.error).toBeUndefined();
    expect(listing).toHaveBeenCalledWith(
      expect.any(String),
      REPO.owner,
      REPO.name,
      HANDOFF_OLDER,
      NEWER,
    );
    const defaultBranchBody = handoffWorld.handoffs[1]!;
    expect(defaultBranchBody).toMatchObject({ kind: 'push', ref: 'main', commitSha: NEWER });
    // A default-branch handoff's body carries no `isDefaultBranch`, as before.
    expect(defaultBranchBody).not.toHaveProperty('isDefaultBranch');
  });
});

describe('a first index, still isDefaultBranch: false, logged once without the URL', () => {
  const firstIndexOnly = (reason: string) => {
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'first_index',
      isDefaultBranch: false,
      ref: 'feature-x',
      commitSha: HANDOFF_HEAD,
    });
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('previousCommitSha');
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('changedPaths');
    expect(
      consoleLines.filter((l) => l.includes('moooon/motir-core#7') && l.includes(`(${reason})`)),
    ).toHaveLength(1);
  };

  it.each([
    ['no_stamped_head', null],
    ['head_unchanged', HANDOFF_HEAD],
    ['sha_not_hex', 'deadbeef'],
  ])('%s: never asks the host for a listing', async (reason, stamped) => {
    const listing = vi.spyOn(githubProvider, 'listChangedFiles');
    const { run } = await runPrHead(`prh-${reason}`, { indexedHeadSha: stamped });
    expect(run.result).toMatchObject({ handed: true, kind: 'first_index' });
    firstIndexOnly(reason);
    expect(listing).not.toHaveBeenCalled();
    await expectNoSourceUrl(run);
  });

  it.each([
    ['revoked', failure('revoked'), ok([])],
    ['truncated', ok([]), ok([{ path: 'a' }], true)],
    ['comparison_threw', ok([]), new Error('boom')],
  ])('a %s listing', async (reason, forward, backward) => {
    listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: forward,
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: backward,
    });
    const { run } = await runPrHead(`prh-${reason}`);
    expect(run.error).toBeUndefined();
    firstIndexOnly(reason);
  });

  it('a row read that throws is a first index too', async () => {
    const seeded = await seed('prh-row-threw');
    const real = githubRepoRepository.findConnectedByOrganizationAndName.bind(githubRepoRepository);
    let calls = 0;
    vi.spyOn(githubRepoRepository, 'findConnectedByOrganizationAndName').mockImplementation(
      async (...args) => {
        calls += 1;
        // The gates read the row first; the comparison's read is the second.
        if (calls === 2) throw new Error('db gone');
        return real(...args);
      },
    );
    const run = await new JobTestEngine({ function: codeGraphPrHeadIndex }).execute({
      events: [prHeadEvent(seeded)],
    });
    expect(run.error).toBeUndefined();
    firstIndexOnly('comparison_threw');
  });
});

describe('hands off nothing', () => {
  const nothingHanded = () => {
    expect(handoffWorld.handoffs).toEqual([]);
    expect(handoffWorld.tarballRefs).toEqual([]);
  };

  it.each([
    ['not_open', livePullRequest({ state: 'closed' })],
    ['fork_head', livePullRequest({ headRepoId: 999 })],
    ['fork_head', livePullRequest({ headRepoId: null })],
    ['gone', { status: 404 }],
  ])('the live read says %s', async (reason, answer) => {
    handoffWorld.pullRequest = answer;
    const { run } = await runPrHead(`prh-live-${reason}-${String(Math.random()).slice(2, 6)}`);
    expect(run.error).toBeUndefined();
    expect(run.result).toEqual({ handed: false, reason });
    nothingHanded();
  });

  it('a live read with no usable head throws for the retry, handing nothing', async () => {
    handoffWorld.pullRequest = livePullRequest({ headSha: 'not-a-sha' });
    const { run } = await runPrHead('prh-live-bad');
    expect(run.error?.message).toContain('no readable head ref or sha');
    nothingHanded();
  });

  it('an allowance stop ends with its reason and leaves the row as it was', async () => {
    handoffWorld.allowanceOutcome = 'hard_stop_allowance_exhausted';
    const { run, before } = await runPrHead('prh-allowance');
    expect(run.result).toEqual({ handed: false, reason: 'paused_index_allowance_exhausted' });
    expect(await rowState()).toEqual(before);
    expect(handoffWorld.pullRequestReads).toEqual([]);
    nothingHanded();
  });

  it('no paid AI plan ends with its reason and leaves the row as it was', async () => {
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    const { run, before } = await runPrHead('prh-plan');
    expect(run.result).toEqual({ handed: false, reason: 'paused_index_ai_plan_required' });
    expect(await rowState()).toEqual(before);
    nothingHanded();
  });

  it.each([
    ['indexRefusedAt set', { indexRefusedAt: new Date('2026-11-20T00:00:00Z') }],
    ['the size pause', { indexPausedReason: 'paused_index_repository_too_large' }],
  ])('a size refusal (%s) ends refused_for_size and leaves the row as it was', async (_l, row) => {
    const { run, before } = await runPrHead(`prh-size-${Object.keys(row)[0]}`, row);
    expect(run.result).toEqual({ handed: false, reason: 'refused_for_size' });
    expect(await rowState()).toEqual(before);
    nothingHanded();
  });

  it('a target no-op verdict ends the run with it', async () => {
    const seeded = await seedIndexWorkspace('prh-noproj', 0);
    const run = await new JobTestEngine({ function: codeGraphPrHeadIndex }).execute({
      events: [prHeadEvent(seeded)],
    });
    expect(run.result).toEqual({ handed: false, reason: 'no_projects' });
    nothingHanded();
  });
});

describe('the deferring arms re-ask inside their steps', () => {
  function manualCtx(event: ReturnType<typeof prHeadEvent>) {
    const memo = new Map<string, unknown>();
    const ctx = {
      event,
      step: {
        run: async (id: string, fn: () => unknown) => {
          if (memo.has(id)) return memo.get(id);
          const value = JSON.parse(JSON.stringify(await fn())) as unknown;
          memo.set(id, value);
          return value;
        },
        sleep: async () => undefined,
      },
      runId: 'run-pr-head-manual',
      attempt: 0,
    } as unknown as JobContext;
    return async () => {
      try {
        return await codeGraphPrHeadIndex.handler(ctx, jobServices);
      } catch (err) {
        if (isJobRunDefer(err)) return 'deferred';
        throw err;
      }
    };
  }

  it('a 429 defers, then the next pass hands off once with the same comparison', async () => {
    const listing = listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: ok([]),
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: ok([]),
    });
    const seeded = await seed('prh-429');
    handoffWorld.handoff = 'rate_limited';
    const pass = manualCtx(prHeadEvent(seeded));
    expect(await pass()).toBe('deferred');
    handoffWorld.handoff = 'accepted';
    expect(await pass()).toMatchObject({ handed: true, kind: 'push' });
    expect(listing).toHaveBeenCalledTimes(2);
    expect(handoffWorld.pullRequestReads).toEqual([7]);
    expect(handoffWorld.handoffs).toHaveLength(2);
    expect(handoffWorld.jobIds).toHaveLength(1);
  });

  it('an unknown AI plan defers and is asked again on the next pass', async () => {
    listings({
      [`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]: ok([]),
      [`${HANDOFF_HEAD}...${HANDOFF_OLDER}`]: ok([]),
    });
    const plan = vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValueOnce('unknown');
    const seeded = await seed('prh-plan-unknown');
    const pass = manualCtx(prHeadEvent(seeded));
    expect(await pass()).toBe('deferred');
    plan.mockResolvedValue(true);
    expect(await pass()).toMatchObject({ handed: true });
    expect(plan).toHaveBeenCalledTimes(2);
  });
});
