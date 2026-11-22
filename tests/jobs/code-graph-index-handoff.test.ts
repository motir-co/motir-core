import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as motirAiClient from '@/lib/ai/motirAiClient';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  INDEX_SIZE_REFUSED_PAUSE_REASON,
} from '@/lib/ciFleet/indexAllowance';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { codeGraphIndex } from '@/lib/jobs/definitions/codeGraphIndex';
import { codeGraphRefresh } from '@/lib/jobs/definitions/codeGraphRefresh';
import type { EngineJobDefinition, JobContext } from '@/lib/jobs/defineJob';
import { isJobRunDefer } from '@/lib/jobs/engine/defer';
import {
  INDEX_HANDOFF_DEADLINE_MS,
  IndexHandoffFailedError,
  settledOutcome,
} from '@/lib/jobs/indexHandoffSteps';
import { jobServices } from '@/lib/jobs/services';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphIndexAdmissionService } from '@/lib/services/codeGraphIndexAdmissionService';
import { codeGraphIndexCatchUpService } from '@/lib/services/codeGraphIndexCatchUpService';
import { codeGraphIndexDispatchService } from '@/lib/services/codeGraphIndexDispatchService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { firstAuditTriggerService } from '@/lib/services/firstAuditTriggerService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  failedAt,
  HANDOFF_HEAD,
  HANDOFF_OLDER,
  handoffWorld,
  publishedAt,
  runningAt,
  SOURCE_URL_SENTINEL,
  presignedUrlFor,
  statusAnswer,
  stubIndexHandoff,
} from '../helpers/indexHandoff';
import { indexEventFor, refreshEventFor, seedIndexWorkspace } from '../helpers/indexFleet';
import { JobTestEngine } from '../helpers/jobs';

// THE INDEX HANDOFF (MOTIR-11883 · story MOTIR-11022).
//
// Both shipped jobs, `system.code-graph-index` and `system.code-graph-refresh`, over
// a REAL Postgres, with motir-ai and GitHub stubbed at the HTTP boundary
// (`tests/helpers/indexHandoff.ts`). The container path is pinned by the suites that
// drive `tests/helpers/fleetIndexJobs.ts`; this one pins what replaced it.

const REPO_OWNER = 'moooon';
const REPO_NAME = 'motir-core';
const REPO_REF = `${REPO_OWNER}/${REPO_NAME}`;

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
      consoleLines.push(
        args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(' '),
      );
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const repoRow = () =>
  adminDb.githubRepo.findFirstOrThrow({
    where: { owner: REPO_OWNER, name: REPO_NAME },
    select: { indexPausedReason: true, indexedHeadSha: true, indexingRunId: true },
  });

const ledgerRows = (functionId: string) =>
  adminDb.jobRun.findMany({ where: { functionId }, orderBy: { startedAt: 'asc' } });

/** Run one job to completion through the harness (deferrals re-enter, as the engine does). */
async function runJob(def: EngineJobDefinition, slug: string) {
  const seeded = await seedIndexWorkspace(slug, 1);
  const eventFor = def.id === 'system.code-graph-index' ? indexEventFor : refreshEventFor;
  const engine = new JobTestEngine({ function: def });
  const outcome = await engine.execute({
    events: [eventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId })],
  });
  // A thrown step (a deferral, a refusal) rejects its call; only the settled ones are memos.
  const settled = await Promise.allSettled(
    outcome.ctx.step.run.mock.results.map((r: { value: unknown }) => r.value),
  );
  const memos = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  // Each step id once, in the order it was first reached: a deferred run re-enters from the top.
  const stepIds = [...new Set(outcome.ctx.step.run.mock.calls.map((c: unknown[]) => String(c[0])))];
  return { ...seeded, ...outcome, memos, stepIds };
}

/**
 * A run driven ONE PASS AT A TIME over one memo, so a case can count what each pass
 * did and move the clock between passes. The memo is the engine's `job_step`.
 */
async function passDriver(def: EngineJobDefinition, slug: string) {
  const seeded = await seedIndexWorkspace(slug, 1);
  const eventFor = def.id === 'system.code-graph-index' ? indexEventFor : refreshEventFor;
  const memo = new Map<string, unknown>();
  const ctx = {
    event: {
      ...eventFor({ installationId: seeded.installationId, workspaceId: seeded.workspaceId }),
    },
    step: {
      run: async (id: string, fn: () => unknown) => {
        if (memo.has(id)) return memo.get(id);
        const value = JSON.parse(JSON.stringify(await fn())) as unknown;
        memo.set(id, value);
        return value;
      },
      sleep: async () => undefined,
    },
    runId: `run-${slug}`,
    attempt: 0,
  } as unknown as JobContext;
  const pass = async (): Promise<
    { kind: 'deferred' } | { kind: 'done'; result: unknown } | { kind: 'threw'; error: Error }
  > => {
    try {
      return { kind: 'done', result: await def.handler(ctx, jobServices) };
    } catch (err) {
      if (isJobRunDefer(err)) return { kind: 'deferred' };
      return { kind: 'threw', error: err as Error };
    }
  };
  return { ...seeded, memo, pass };
}

const leaksUrl = (value: unknown): boolean =>
  JSON.stringify(value ?? null).includes(SOURCE_URL_SENTINEL);

// ── the first index ──────────────────────────────────────────────────────────

describe('system.code-graph-index hands a first_index off and settles on the published head', () => {
  it('resolves, claims, reads the live head, hands off at it, polls until published, then audits', async () => {
    handoffWorld.statuses = [runningAt(HANDOFF_HEAD), publishedAt(HANDOFF_HEAD)];
    const deriveFirstAudit = vi.spyOn(firstAuditTriggerService, 'deriveFirstAudit');

    const run = await runJob(codeGraphIndex, 'handoff-first');

    expect(run.error).toBeUndefined();
    expect(run.result).toEqual({
      indexed: true,
      repoRef: REPO_REF,
      projectsIndexed: 1,
      indexedBy: 'motir-codegraph',
    });
    expect(handoffWorld.headReads).toEqual(['main']);
    // ⚠️ THE URL IS MINTED AT THE COMMIT, NEVER AT THE BRANCH NAME.
    expect(handoffWorld.tarballRefs).toEqual([HANDOFF_HEAD]);
    expect(handoffWorld.handoffs).toEqual([
      {
        coreOrganizationId: expect.any(String),
        coreWorkspaceId: run.workspaceId,
        coreProjectId: run.projectIds[0],
        repoRef: REPO_REF,
        kind: 'first_index',
        commitSha: HANDOFF_HEAD,
        ref: 'main',
        sourceUrl: presignedUrlFor(HANDOFF_HEAD),
      },
    ]);
    expect(handoffWorld.statusReads).toHaveLength(2);
    expect(handoffWorld.statusReads[0]).toEqual({
      coreOrganizationId: handoffWorld.handoffs[0]!['coreOrganizationId'],
      repoRef: REPO_REF,
    });
    expect(run.stepIds).toEqual([
      'job-run:start',
      'resolve-target-v2',
      'index-allowance',
      'index-ai-plan',
      'index-handoff-v1',
      'cancel-offboarding',
      'derive-first-audit',
      'job-run:succeeded',
    ]);
    expect(deriveFirstAudit).toHaveBeenCalledWith({
      workspaceId: run.workspaceId,
      repoRef: REPO_REF,
    });

    // The head is stamped, the claim released, and the ledger reads the repository indexed.
    const row = await repoRow();
    expect(row.indexedHeadSha).toBe(HANDOFF_HEAD);
    expect(row.indexingRunId).toBeNull();
    const [ledger] = await ledgerRows('system.code-graph-index');
    expect(ledger!.status).toBe('succeeded');
    expect(ledger!.output).toMatchObject({ repoRef: REPO_REF, indexedBy: 'motir-codegraph' });
    const indexed = await withSystemContext((tx) =>
      jobRunRepository.listSucceededCodeGraphIndexRepoRefs(run.workspaceId, tx),
    );
    expect(indexed).toContain(REPO_REF);
  });

  it('never reaches the container path: no admission, no credential mint, no dispatch', async () => {
    const admit = vi.spyOn(codeGraphIndexAdmissionService, 'admit');
    const advance = vi.spyOn(codeGraphIndexDispatchService, 'advanceIndexContainer');
    const boot = vi.spyOn(codeGraphIndexDispatchService, 'bootIndexContainer');
    const mint = vi.spyOn(motirAiClient, 'mintCodeGraphRunCredential');

    const index = await runJob(codeGraphIndex, 'handoff-nofleet-a');
    const refresh = await runJob(codeGraphRefresh, 'handoff-nofleet-b');

    expect(index.error).toBeUndefined();
    expect(refresh.error).toBeUndefined();
    for (const spy of [admit, advance, boot, mint]) expect(spy).not.toHaveBeenCalled();
    expect(handoffWorld.aiPaths).not.toContain('/v1/code-graph/run-credential');
  });

  it('no job definition calls runIndexFleetSteps any more', () => {
    const dir = join(process.cwd(), 'lib/jobs/definitions');
    const callers = readdirSync(dir).filter((f) =>
      /runIndexFleetSteps\s*\(/.test(readFileSync(join(dir, f), 'utf8')),
    );
    expect(callers).toEqual([]);
  });
});

// ── the refresh ──────────────────────────────────────────────────────────────

describe('system.code-graph-refresh hands off as a refresh, whatever enqueued it', () => {
  // Every trigger — the GitHub and GitLab push webhooks, the stale-session refresh
  // and the catch-up sweep — enqueues the SAME `CodeGraphRefreshData` payload under
  // the same event, so each reaches this one body unchanged.
  it.each(['github-push', 'gitlab-push', 'stale-session', 'catch-up'])(
    'the %s payload hands off with kind refresh',
    async (trigger) => {
      const run = await runJob(codeGraphRefresh, `handoff-refresh-${trigger}`);
      expect(run.error).toBeUndefined();
      expect(run.result).toMatchObject({ indexed: true, indexedBy: 'motir-codegraph' });
      expect(handoffWorld.handoffs.map((h) => h['kind'])).toEqual(['refresh']);
      expect(run.stepIds).not.toContain('derive-first-audit');
    },
  );

  it('keeps its event, retry policy and debounce', () => {
    expect(codeGraphRefresh.id).toBe('system.code-graph-refresh');
    expect(codeGraphRefresh.trigger).toBe('system.code-graph-refresh');
    expect(codeGraphRefresh.retryPolicy).toBe('idempotent');
    expect(codeGraphRefresh.debounce).toEqual({
      key: "event.data.installationId + '/' + event.data.repoOwner + '/' + event.data.repoName",
      period: '2m',
      timeout: '15m',
    });
  });

  it('the two jobs share one step shape, except the first-audit step', async () => {
    const index = await runJob(codeGraphIndex, 'handoff-parity-a');
    const refresh = await runJob(codeGraphRefresh, 'handoff-parity-b');
    expect(index.stepIds.filter((id) => id !== 'derive-first-audit')).toEqual(refresh.stepIds);
  });
});

// ── the source URL is a bearer secret ─────────────────────────────────────────

describe('the source URL reaches motir-ai and nowhere else', () => {
  it('appears in no memo, no ledger output and no console line of a published run', async () => {
    handoffWorld.statuses = [runningAt(HANDOFF_HEAD), publishedAt(HANDOFF_HEAD)];
    const run = await runJob(codeGraphIndex, 'handoff-secret-ok');

    expect(handoffWorld.handoffs[0]!['sourceUrl']).toContain(SOURCE_URL_SENTINEL);
    expect(run.memos.filter(leaksUrl)).toEqual([]);
    const ledger = await ledgerRows('system.code-graph-index');
    expect(ledger.filter((row) => leaksUrl(row))).toEqual([]);
    expect(consoleLines.filter((l) => l.includes(SOURCE_URL_SENTINEL))).toEqual([]);
  });

  it('appears in no error message, memo or console line of a refused handoff', async () => {
    handoffWorld.handoff = 'refused';
    const run = await runJob(codeGraphIndex, 'handoff-secret-refused');

    expect(run.error).toBeDefined();
    expect(handoffWorld.handoffs[0]!['sourceUrl']).toContain(SOURCE_URL_SENTINEL);
    expect(`${run.error!.message} ${String(run.error!.stack)}`).not.toContain(SOURCE_URL_SENTINEL);
    expect(run.memos.filter(leaksUrl)).toEqual([]);
    const ledger = await ledgerRows('system.code-graph-index');
    expect(ledger.filter((row) => leaksUrl(row))).toEqual([]);
    expect(ledger.some((row) => row.status === 'succeeded')).toBe(false);
    expect(consoleLines.filter((l) => l.includes(SOURCE_URL_SENTINEL))).toEqual([]);
  });
});

// ── the two policy gates ──────────────────────────────────────────────────────

describe('the allowance and the AI plan pause before anything is claimed or sent', () => {
  it('an allowance stop pauses with its reason, sends nothing, and a later run lifts it and hands off', async () => {
    handoffWorld.allowanceOutcome = 'hard_stop_allowance_exhausted';
    const stopped = await runJob(codeGraphIndex, 'handoff-allowance');

    expect(stopped.result).toEqual({
      indexed: false,
      reason: 'paused_index_allowance_exhausted',
    });
    expect((await repoRow()).indexPausedReason).toBe('paused_index_allowance_exhausted');
    expect(handoffWorld.handoffs).toEqual([]);
    expect(handoffWorld.tarballRefs).toEqual([]);
    const [row] = await ledgerRows('system.code-graph-index');
    expect(row!.status).toBe('succeeded');
    expect(row!.output).not.toHaveProperty('repoRef');

    // The catch-up sweep's resume: the allowance clears, the run lifts and hands off.
    handoffWorld.allowanceOutcome = 'ok';
    const engine = new JobTestEngine({ function: codeGraphIndex });
    const resumed = await engine.execute({
      events: [
        indexEventFor({
          installationId: stopped.installationId,
          workspaceId: stopped.workspaceId,
          eventId: 'evt-handoff-allowance-resume',
        }),
      ],
    });
    expect(resumed.result).toMatchObject({ indexed: true });
    expect((await repoRow()).indexPausedReason).toBeNull();
    expect(handoffWorld.handoffs).toHaveLength(1);
  });

  it('no paid AI plan pauses with AI_PLAN_INDEX_PAUSE_REASON and sends nothing', async () => {
    vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);
    const run = await runJob(codeGraphIndex, 'handoff-noplan');

    expect(run.result).toEqual({ indexed: false, reason: AI_PLAN_INDEX_PAUSE_REASON });
    expect((await repoRow()).indexPausedReason).toBe(AI_PLAN_INDEX_PAUSE_REASON);
    expect(handoffWorld.handoffs).toEqual([]);
    const [row] = await ledgerRows('system.code-graph-index');
    expect(row!.output).not.toHaveProperty('repoRef');
  });

  it('an unknown plan answer defers, unrecorded, and the next pass asks again', async () => {
    const ask = vi
      .spyOn(aiPlanGateService, 'hasPaidAiPlan')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValue(true);
    const driver = await passDriver(codeGraphIndex, 'handoff-planunknown');

    expect(await driver.pass()).toEqual({ kind: 'deferred' });
    expect(driver.memo.has('index-ai-plan')).toBe(false);
    expect((await repoRow()).indexPausedReason).toBeNull();
    expect(handoffWorld.handoffs).toEqual([]);

    expect(await driver.pass()).toMatchObject({ kind: 'done', result: { indexed: true } });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('a host the resolver cannot serve ends provider_cannot_index before any gate', async () => {
    vi.spyOn(codeGraphIndexService, 'resolveIndexTarget').mockResolvedValue({
      indexed: false,
      reason: 'provider_cannot_index',
    });
    const run = await runJob(codeGraphIndex, 'handoff-provider');

    expect(run.result).toEqual({ indexed: false, reason: 'provider_cannot_index' });
    expect(run.stepIds).toEqual(['job-run:start', 'resolve-target-v2', 'job-run:succeeded']);
    expect(handoffWorld.aiPaths).toEqual([]);
  });
});

// ── settling on what the service reports ──────────────────────────────────────

describe('the run settles on the HANDED commit', () => {
  it('a size refusal pauses with the service reason and message, and the sweep leaves it', async () => {
    const message = 'The commit is too large to index: 120001 regular files (limit 100000).';
    handoffWorld.statuses = [failedAt(HANDOFF_HEAD, 'repository_too_large', message)];
    const run = await runJob(codeGraphIndex, 'handoff-size');

    expect(run.result).toEqual({
      indexed: false,
      reason: INDEX_SIZE_REFUSED_PAUSE_REASON,
      detail: message,
    });
    expect((await repoRow()).indexPausedReason).toBe(INDEX_SIZE_REFUSED_PAUSE_REASON);
    const [row] = await ledgerRows('system.code-graph-index');
    expect(row!.status).toBe('succeeded');
    expect(row!.output).not.toHaveProperty('repoRef');

    const enqueueIndex = vi.fn(async () => undefined);
    const enqueueRefresh = vi.fn(async () => undefined);
    const sweep = await codeGraphIndexCatchUpService.catchUp({
      deps: {
        check: async () => null,
        enqueueIndex,
        enqueueRefresh,
        poolHasRoom: async () => true,
      },
    });
    expect(sweep.outcomes.filter((o) => o.repoRef === REPO_REF)).toEqual([]);
    expect(enqueueIndex).not.toHaveBeenCalled();
    expect(enqueueRefresh).not.toHaveBeenCalled();
  });

  it('any other failure of the handed commit throws and leaves no succeeded row', async () => {
    handoffWorld.statuses = [
      failedAt(HANDOFF_HEAD, 'fetch_failed', 'The source could not be fetched.'),
    ];
    const run = await runJob(codeGraphIndex, 'handoff-failed');

    expect(run.error).toBeInstanceOf(IndexHandoffFailedError);
    expect(run.error!.message).toContain('fetch_failed');
    expect(run.error!.message).toContain('The source could not be fetched.');
    const rows = await ledgerRows('system.code-graph-index');
    expect(rows.some((r) => r.status === 'succeeded')).toBe(false);
  });

  it('a failure of an OLDER commit is history, not this run’s outcome', () => {
    expect(
      settledOutcome(failedAt(HANDOFF_OLDER, 'repository_too_large', 'old') as never, HANDOFF_HEAD),
    ).toEqual({ kind: 'pending' });
    expect(
      settledOutcome(
        statusAnswer({
          inProgressJob: (runningAt(HANDOFF_HEAD) as { inProgressJob: unknown }).inProgressJob,
          lastFailure: (failedAt(HANDOFF_HEAD, 'fetch_failed', 'x') as { lastFailure: unknown })
            .lastFailure,
        }) as never,
        HANDOFF_HEAD,
      ),
    ).toEqual({ kind: 'pending' });
  });

  it('nothing published within the deadline throws timed_out', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-22T10:00:00.000Z') });
    handoffWorld.statuses = [runningAt(HANDOFF_HEAD)];
    const driver = await passDriver(codeGraphIndex, 'handoff-deadline');

    expect(await driver.pass()).toEqual({ kind: 'deferred' });
    vi.setSystemTime(new Date(Date.now() + INDEX_HANDOFF_DEADLINE_MS - 1));
    expect(await driver.pass()).toEqual({ kind: 'deferred' });
    vi.setSystemTime(new Date(Date.now() + 1));
    const last = await driver.pass();
    expect(last.kind).toBe('threw');
    const error = (last as { error: Error }).error;
    expect(error).toBeInstanceOf(IndexHandoffFailedError);
    expect((error as IndexHandoffFailedError).reason).toBe('timed_out');
  });
});

// ── what each pass costs ──────────────────────────────────────────────────────

describe('a deferred pass never hands off twice', () => {
  it('three deferring passes make ONE handoff and three status reads', async () => {
    handoffWorld.statuses = [runningAt(HANDOFF_HEAD)];
    const driver = await passDriver(codeGraphIndex, 'handoff-passes');

    for (let i = 0; i < 3; i += 1) expect(await driver.pass()).toEqual({ kind: 'deferred' });

    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.statusReads).toHaveLength(3);
    expect(handoffWorld.headReads).toHaveLength(1);
    expect(driver.memo.get('index-handoff-v1')).toEqual({
      jobId: handoffWorld.jobIds[0],
      commitSha: HANDOFF_HEAD,
      handedAt: expect.any(String),
    });
  });

  it('a registration still in progress defers unrecorded, and the next pass mints and hands off again', async () => {
    handoffWorld.handoff = 'rate_limited';
    const driver = await passDriver(codeGraphRefresh, 'handoff-busy');

    expect(await driver.pass()).toEqual({ kind: 'deferred' });
    expect(driver.memo.has('index-handoff-v1')).toBe(false);
    expect(handoffWorld.statusReads).toEqual([]);

    handoffWorld.handoff = 'accepted';
    expect(await driver.pass()).toMatchObject({ kind: 'done', result: { indexed: true } });
    expect(handoffWorld.handoffs).toHaveLength(2);
    expect(handoffWorld.tarballRefs).toEqual([HANDOFF_HEAD, HANDOFF_HEAD]);
  });

  it('a head the host cannot resolve throws before anything is handed off', async () => {
    const provider = (await import('@/lib/git/providers/github')).githubProvider;
    vi.spyOn(provider, 'resolveRef').mockResolvedValue({ outcome: 'ref_not_found', ref: 'main' });
    const run = await runJob(codeGraphIndex, 'handoff-nohead');

    expect(run.error?.message).toContain('could not read the head');
    expect(handoffWorld.handoffs).toEqual([]);
    expect(handoffWorld.tarballRefs).toEqual([]);
  });
});
