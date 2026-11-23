import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeOrchestrator } from '@motir/orchestrator';
import type { JobQueueRun } from '@/generated/prisma/client';
import { resolvePlanningCodeContext } from '@/lib/ai/codeContext';
import {
  AI_PLAN_INDEX_PAUSE_REASON,
  INDEX_SIZE_REFUSED_PAUSE_REASON,
} from '@/lib/ciFleet/indexAllowance';
import { deriveCodeGraphIndexState, hasBuiltGraph } from '@/lib/codeGraph/indexState';
import { db } from '@/lib/db';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { JobWorker } from '@/lib/jobs/engine/worker';
import '@/lib/jobs/registry';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { aiPlanGateService } from '@/lib/services/aiPlanGateService';
import { codeGraphIndexCatchUpService } from '@/lib/services/codeGraphIndexCatchUpService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { withSystemContext } from '@/lib/workspaces/context';
import { run as runFirstIndexPass } from '@/scripts/first-index-pass';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  failedAt,
  HANDOFF_HEAD,
  HANDOFF_OLDER,
  handoffWorld,
  presignedUrlFor,
  publishedAt,
  SOURCE_URL_SENTINEL,
  stubIndexHandoff,
  HANDOFF_AI_PATHS,
} from '../helpers/indexHandoff';
import { seedIndexWorkspace, type SeededIndexWorkspace } from '../helpers/indexFleet';

// THE MOTIR-CORE STORY GATE (MOTIR-11887 · story MOTIR-11022).
//
// The three motir-core cards of the story — the index and refresh jobs hand off to
// motir-ai (MOTIR-11883), a push is handed off as a push with no debounce
// (MOTIR-11884), and the first-index pass with its narrowed gate (MOTIR-11885) —
// each shipped tests for their own change. This suite asserts the seams BETWEEN
// them, driven from the REAL triggers (the reconcile gate, both push webhooks, the
// stale-session refresh, the catch-up sweep and the pass command) through the REAL
// job engine — events written to `job_event` / `job_queue_run` by the dispatcher,
// claimed by a `JobWorker`, executed through `executeWithLedger` — against real
// Postgres. motir-ai and GitHub are stubbed ONLY at the HTTP boundary
// (`tests/helpers/indexHandoff.ts`), which records every request.
//
// And across every case, the story's three guards:
//   - NO FLEET: no container is provisioned and no run credential is asked for;
//   - THE URL AT THE COMMIT: every handoff's source URL is the one GitHub's 302
//     named for the HANDED commit, and no tarball is ever asked at a branch;
//   - THE URL NEVER STORED OR LOGGED: no console line, `job_run`, `job_step` or
//     repository row carries the sentinel planted in every minted URL.

const CODE_GRAPH_JOBS = ['system.code-graph-index', 'system.code-graph-refresh'];
const SECOND_HEAD = 'f00d'.padEnd(40, '3');

/** Every console line written while a case ran. */
const consoleLines: string[] = [];

let seq = 0;
const slug = (name: string) => `gate-${name}-${(seq += 1)}`;

// ── the engine, driven to its end ─────────────────────────────────────────────

const worker = () =>
  new JobWorker({
    workerId: `story-gate-${seq}`,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    execute: async (run: JobQueueRun) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await executeWithLedger(run, event?.data ?? {});
    },
    onTerminalFailure: async (run, error) => {
      const event = run.eventId
        ? await adminDb.jobEvent.findUnique({ where: { id: run.eventId } })
        : null;
      await recordEngineTerminalFailure(run, error, event?.data ?? {});
    },
  });

/**
 * Run every queued code-graph run to a terminal state. Each pass makes the
 * code-graph runs due NOW (a deferred status poll, a retry's backoff) and parks
 * anything else a run enqueued, so the claim reaches only the jobs under test.
 * Never sleeps: a deferral is a row with a later `runAt`, and moving it is the
 * engine's own "the time has come".
 */
async function drain(): Promise<void> {
  const w = worker();
  for (let pass = 0; pass < 60; pass += 1) {
    const live = await adminDb.jobQueueRun.count({
      where: { jobId: { in: CODE_GRAPH_JOBS }, state: { in: ['pending', 'running'] } },
    });
    if (live === 0) return;
    await adminDb.jobQueueRun.updateMany({
      where: { jobId: { in: CODE_GRAPH_JOBS }, state: 'pending' },
      data: { runAt: new Date(Date.now() - 1_000) },
    });
    await adminDb.jobQueueRun.updateMany({
      where: { jobId: { notIn: CODE_GRAPH_JOBS }, state: 'pending' },
      data: { runAt: new Date(Date.now() + 86_400_000) },
    });
    await w.tick();
    await w.settled();
  }
  throw new Error('drain: the code-graph runs did not settle in 60 passes');
}

/** The code-graph queue rows, oldest first. */
const queueRows = () =>
  adminDb.jobQueueRun.findMany({
    where: { jobId: { in: CODE_GRAPH_JOBS } },
    orderBy: { createdAt: 'asc' },
  });

const ledger = (functionId?: string) =>
  adminDb.jobRun.findMany({
    where: { functionId: functionId ?? { in: CODE_GRAPH_JOBS } },
    orderBy: { startedAt: 'asc' },
  });

const repoRow = (name = 'motir-core') =>
  adminDb.githubRepo.findFirstOrThrow({ where: { owner: 'moooon', name } });

// ── the world ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  _resetInstallationTokenCache();
  fakeOrchestrator.reset();
  stubIndexHandoff();
  consoleLines.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' '));
    });
  }
});

afterEach(async () => {
  // ── THE GUARDS, after EVERY case ──────────────────────────────────────────
  // No fleet: nothing indexes into the old graph after this story.
  expect(fakeOrchestrator.provisioned, 'no container is provisioned').toEqual([]);
  expect(fakeOrchestrator.specs, 'no container spec is built').toEqual([]);
  expect(
    handoffWorld.aiPaths.filter((p) => !HANDOFF_AI_PATHS.includes(p)),
    'no run credential is minted: motir-ai is asked only the handoff world’s paths',
  ).toEqual([]);
  // The URL at the commit: every handoff names the URL GitHub minted for ITS commit.
  for (const handoff of handoffWorld.handoffs) {
    expect(handoff['commitSha']).toMatch(/^[0-9a-f]{40}$/);
    expect(handoff['sourceUrl']).toBe(presignedUrlFor(String(handoff['commitSha'])));
  }
  const handed = new Set(handoffWorld.handoffs.map((h) => String(h['commitSha'])));
  for (const ref of handoffWorld.tarballRefs) {
    expect(handed.has(ref), `a tarball was asked at ${ref}, not at a handed commit`).toBe(true);
  }
  // The URL never stored or logged.
  expect(consoleLines.filter((line) => line.includes(SOURCE_URL_SENTINEL))).toEqual([]);
  const stored = [
    ...(await adminDb.jobRun.findMany()),
    ...(await adminDb.jobStep.findMany()),
    ...(await adminDb.githubRepo.findMany()),
  ];
  expect(stored.filter((row) => safeJson(row).includes(SOURCE_URL_SENTINEL))).toEqual([]);

  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The single connected repository's mirror row, as the webhook and readers see it. */
async function stamp(
  data: Partial<{
    indexedAt: Date | null;
    indexedHeadSha: string | null;
    defaultBranchHeadSha: string | null;
    indexPausedReason: string | null;
    archived: boolean;
  }>,
  name = 'motir-core',
) {
  await adminDb.githubRepo.updateMany({ where: { owner: 'moooon', name }, data });
}

/** A succeeded index row written by the handoff, as MOTIR-11883 writes one. */
async function handedOffRow(workspaceId: string, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-seed-${repoRef}-${seq}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      output: { indexed: true, repoRef, projectsIndexed: 1, indexedBy: 'motir-codegraph' },
    },
  });
}

/** An OLD-FLEET succeeded row: `output.repoRef`, no `indexedBy`. */
async function oldFleetRow(workspaceId: string, repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-old-${repoRef}-${seq}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/** The GitHub `push` delivery a default-branch commit produces. */
async function githubPush(seeded: SeededIndexWorkspace, after: string) {
  const repo = await repoRow();
  return githubWebhookService.handleEvent('push', {
    ref: 'refs/heads/main',
    after,
    repository: { id: Number(repo.repoId) },
    installation: { id: seeded.installationId },
  });
}

/** A repository with a graph published at `HANDOFF_OLDER`, so a push refreshes it. */
async function seedIndexedAtOlder(name: string): Promise<SeededIndexWorkspace> {
  const seeded = await seedIndexWorkspace(slug(name), 1);
  await handedOffRow(seeded.workspaceId, 'moooon/motir-core');
  await stamp({ indexedAt: new Date('2026-11-01T00:00:00Z'), indexedHeadSha: HANDOFF_OLDER });
  return seeded;
}

/** What the ledger's existing readers say about one repository. */
async function readersSay(workspaceId: string, repoRef: string) {
  const [wizard, refs] = await withSystemContext(async (tx) => [
    await jobRunRepository.findSucceededCodeGraphIndex(workspaceId, repoRef, tx),
    await jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
  ]);
  const row = await repoRow(repoRef.split('/')[1]);
  return {
    // The migrate wizard's readiness signal.
    wizardReady: wizard !== null,
    // get_project_state, the code-context and the wizard's per-repo exit read.
    ledgerIndexed: (refs as string[]).includes(repoRef),
    // The project's index state, derived from the repository row.
    indexState: deriveCodeGraphIndexState({
      hasSucceededIndex: hasBuiltGraph(row),
      defaultBranchHeadSha: row.defaultBranchHeadSha,
      indexedHeadSha: row.indexedHeadSha,
      hasRunningIndex: false,
    }),
  };
}

// ── the first index ──────────────────────────────────────────────────────────

describe('a first index from the bind / reconcile gate', () => {
  it('hands off first_index at the head, succeeds, stamps the head, asks the first audit, and every reader reads it indexed', async () => {
    const seeded = await seedIndexWorkspace(slug('first'), 1);

    // The gate `bindInstallationForWorkspace` and the webhook's reconcile both call.
    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repos: [
        {
          providerRepoId: (await repoRow()).repoId,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await drain();

    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'first_index',
      commitSha: HANDOFF_HEAD,
      repoRef: 'moooon/motir-core',
      sourceUrl: presignedUrlFor(HANDOFF_HEAD),
    });
    const [row] = await ledger('system.code-graph-index');
    expect(row!.status).toBe('succeeded');
    expect(row!.output).toMatchObject({
      indexed: true,
      repoRef: 'moooon/motir-core',
      indexedBy: 'motir-codegraph',
    });
    expect((await repoRow()).indexedHeadSha).toBe(HANDOFF_HEAD);
    expect(handoffWorld.aiPaths, 'the first audit is asked').toContain('/v1/code-audit');
    await expect(readersSay(seeded.workspaceId, 'moooon/motir-core')).resolves.toEqual({
      wizardReady: true,
      ledgerIndexed: true,
      indexState: 'indexed',
    });
  });
});

// ── pushes ───────────────────────────────────────────────────────────────────

describe('a default-branch push', () => {
  it('GitHub: due at once, handed off as kind push with the stamped head and the changed paths', async () => {
    const seeded = await seedIndexedAtOlder('push');
    handoffWorld.compare = {
      files: [
        { filename: 'src/a.ts', status: 'modified' },
        { filename: 'src/new.ts', status: 'renamed', previous_filename: 'src/old.ts' },
      ],
    };

    const before = Date.now();
    expect(await githubPush(seeded, HANDOFF_HEAD)).toEqual({
      event: 'push',
      outcome: 'refresh_enqueued',
    });
    const [queued] = await queueRows();
    expect(queued!.debounceKey).toBeNull();
    expect(queued!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(queued!.runAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    await drain();

    expect(handoffWorld.compareReads).toEqual([`${HANDOFF_OLDER}...${HANDOFF_HEAD}`]);
    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({
      kind: 'push',
      commitSha: HANDOFF_HEAD,
      previousCommitSha: HANDOFF_OLDER,
      changedPaths: ['src/a.ts', 'src/new.ts', 'src/old.ts'],
    });
    const [row] = await ledger('system.code-graph-refresh');
    expect(row!.status).toBe('succeeded');
    expect((await repoRow()).indexedHeadSha).toBe(HANDOFF_HEAD);
  });

  it('GitLab: the push enqueues the refresh as a push, and the host’s verdict is still provider_cannot_index', async () => {
    const seeded = await seedIndexWorkspace(slug('gitlab'), 1);
    vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', 'a'.repeat(64));
    await withSystemContext(async (tx) => {
      const ws = await tx.workspace.findUniqueOrThrow({ where: { id: seeded.workspaceId } });
      const connection = await githubInstallationRepository.upsertGitlabConnection(
        {
          installationId: `gitlab-ws-${ws.id}`,
          workspaceId: ws.id,
          organizationId: ws.organizationId,
          accountLogin: 'octocat',
          accountType: 'User',
          accessTokenEncrypted: encryptToken('good-token'),
          refreshTokenEncrypted: encryptToken('r'),
          tokenExpiresAt: new Date(Date.now() + 3_600_000),
        },
        tx,
      );
      await githubRepoRepository.upsert(
        {
          installationId: connection.id,
          workspaceId: ws.id,
          organizationId: ws.organizationId,
          repoId: '42',
          owner: 'octocat',
          name: 'acme',
          defaultBranch: 'main',
          archived: false,
          provider: 'gitlab',
        },
        tx,
      );
    });

    const res = await gitlabWebhookService.handleEvent('Push Hook', {
      object_kind: 'push',
      ref: 'refs/heads/main',
      after: HANDOFF_HEAD,
      project: { id: 42 },
    });
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    const [queued] = await queueRows();
    expect(queued!.debounceKey).toBeNull();
    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: queued!.eventId! } });
    expect(event.data).toMatchObject({ repoName: 'acme', refreshCause: 'push' });
    await drain();

    // GitLab cannot mint a self-authorising archive URL, so the run ends at the
    // capability gate, before any gate or handoff — the verdict the story keeps.
    const [row] = await ledger('system.code-graph-refresh');
    expect(row!.output).toEqual({ indexed: false, reason: 'provider_cannot_index' });
    expect(handoffWorld.handoffs).toEqual([]);
    expect(handoffWorld.aiPaths).toEqual([]);
  });

  it.each([
    ['no stamped head', { stamped: null, compare: null }],
    [
      'a truncated comparison',
      {
        stamped: HANDOFF_OLDER,
        compare: {
          files: Array.from({ length: 300 }, (_, i) => ({
            filename: `f${i}.ts`,
            status: 'modified' as const,
          })),
        },
      },
    ],
    ['an unavailable comparison', { stamped: HANDOFF_OLDER, compare: { status: 502 } }],
  ])('%s: handed off as kind refresh with no previous head or paths', async (_label, c) => {
    const seeded = await seedIndexWorkspace(slug('fallback'), 1);
    await handedOffRow(seeded.workspaceId, 'moooon/motir-core');
    await stamp({ indexedAt: new Date('2026-11-01T00:00:00Z'), indexedHeadSha: c.stamped });
    handoffWorld.compare = c.compare;

    expect(await githubPush(seeded, HANDOFF_HEAD)).toMatchObject({ outcome: 'refresh_enqueued' });
    await drain();

    expect(handoffWorld.handoffs).toHaveLength(1);
    expect(handoffWorld.handoffs[0]).toMatchObject({ kind: 'refresh', commitSha: HANDOFF_HEAD });
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('previousCommitSha');
    expect(handoffWorld.handoffs[0]).not.toHaveProperty('changedPaths');
    expect(handoffWorld.compareReads).toHaveLength(c.compare === null ? 0 : 1);
    expect((await ledger('system.code-graph-refresh'))[0]!.status).toBe('succeeded');
  });

  it('two pushes inside two minutes are two runs and two handoffs — nothing coalesces', async () => {
    const seeded = await seedIndexedAtOlder('twice');
    handoffWorld.compare = { files: [{ filename: 'a.ts', status: 'modified' }] };

    await githubPush(seeded, HANDOFF_HEAD);
    await githubPush(seeded, HANDOFF_HEAD);
    const queued = await queueRows();
    expect(queued).toHaveLength(2);
    expect(queued.every((r) => r.debounceKey === null)).toBe(true);
    await drain();

    expect(handoffWorld.handoffs).toHaveLength(2);
    const runs = await ledger('system.code-graph-refresh');
    expect(runs.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });
});

// ── the other refresh triggers ───────────────────────────────────────────────

describe('the stale-session refresh and the catch-up sweep reach the same handoff', () => {
  it('a planning session on a stale graph hands off a refresh', async () => {
    const seeded = await seedIndexWorkspace(slug('session'), 1);
    await handedOffRow(seeded.workspaceId, 'moooon/motir-core');
    await stamp({
      indexedAt: new Date('2026-11-01T00:00:00Z'),
      indexedHeadSha: HANDOFF_OLDER,
      defaultBranchHeadSha: HANDOFF_HEAD,
    });

    await resolvePlanningCodeContext({
      userId: seeded.ownerUserId,
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectIds[0]!,
    });
    const [queued] = await queueRows();
    expect(queued!.jobId).toBe('system.code-graph-refresh');
    await drain();

    expect(handoffWorld.handoffs).toEqual([
      expect.objectContaining({ kind: 'refresh', commitSha: HANDOFF_HEAD }),
    ]);
    expect(handoffWorld.compareReads).toEqual([]);
  });

  it('catch-up: a paused graph that fell behind hands off a refresh, a never-indexed one a first index', async () => {
    const seeded = await seedIndexWorkspace(slug('catchup'), 1, [
      { owner: 'moooon', name: 'motir-core' },
      { owner: 'moooon', name: 'never' },
    ]);
    await stamp({
      indexedAt: new Date('2026-11-01T00:00:00Z'),
      indexedHeadSha: HANDOFF_OLDER,
      defaultBranchHeadSha: HANDOFF_HEAD,
      indexPausedReason: 'paused_index_allowance_exhausted',
    });
    await stamp({ indexPausedReason: 'paused_index_allowance_exhausted' }, 'never');

    await codeGraphIndexCatchUpService.catchUp();
    expect((await queueRows()).map((r) => r.jobId).sort()).toEqual([
      'system.code-graph-index',
      'system.code-graph-refresh',
    ]);
    await drain();

    const byRepo = Object.fromEntries(
      handoffWorld.handoffs.map((h) => [String(h['repoRef']), h['kind']]),
    );
    expect(byRepo).toEqual({ 'moooon/motir-core': 'refresh', 'moooon/never': 'first_index' });
    expect(seeded.repoRefs).toHaveLength(2);
  });
});

// ── what the service reports ─────────────────────────────────────────────────

describe('the run settles on what the service reports for the handed commit', () => {
  const enqueueFirst = async (seeded: SeededIndexWorkspace) =>
    codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repos: [
        {
          providerRepoId: (await repoRow()).repoId,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

  it('a size refusal pauses with the service reason; no repoRef is written; the readers do not read it indexed', async () => {
    const seeded = await seedIndexWorkspace(slug('size'), 1);
    handoffWorld.statuses = [
      failedAt(HANDOFF_HEAD, 'repository_too_large', 'The commit is too large to index.'),
    ];

    await enqueueFirst(seeded);
    await drain();

    expect((await repoRow()).indexPausedReason).toBe(INDEX_SIZE_REFUSED_PAUSE_REASON);
    const [row] = await ledger('system.code-graph-index');
    expect(row!.status).toBe('succeeded');
    expect(row!.output).not.toHaveProperty('repoRef');
    await expect(readersSay(seeded.workspaceId, 'moooon/motir-core')).resolves.toEqual({
      wizardReady: false,
      ledgerIndexed: false,
      indexState: 'never',
    });
  });

  it('any other failure of the handed commit fails the job and leaves no succeeded row', async () => {
    const seeded = await seedIndexWorkspace(slug('failed'), 1);
    handoffWorld.statuses = [
      failedAt(HANDOFF_HEAD, 'fetch_failed', 'The source could not be fetched.'),
    ];

    await enqueueFirst(seeded);
    await drain();

    const runs = await ledger('system.code-graph-index');
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.some((r) => r.status === 'succeeded')).toBe(false);
    expect((await queueRows())[0]!.state).toBe('failed');
    // Handed once: the retries read the memo, they do not hand the commit off again.
    expect(handoffWorld.handoffs).toHaveLength(1);
  });
});

// ── the two policy stops ─────────────────────────────────────────────────────

describe('the allowance and the AI plan stop the run before anything is sent', () => {
  it('an allowance hard stop pauses, sends nothing; lifted, the catch-up sweep hands it off and indexes it', async () => {
    const seeded = await seedIndexWorkspace(slug('allowance'), 1);
    handoffWorld.allowanceOutcome = 'hard_stop_allowance_exhausted';

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repos: [
        {
          providerRepoId: (await repoRow()).repoId,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await drain();
    expect((await repoRow()).indexPausedReason).toBe('paused_index_allowance_exhausted');
    expect(handoffWorld.handoffs).toEqual([]);
    expect(handoffWorld.tarballRefs).toEqual([]);

    handoffWorld.allowanceOutcome = 'ok';
    await codeGraphIndexCatchUpService.catchUp();
    await drain();

    expect(handoffWorld.handoffs).toEqual([
      expect.objectContaining({ kind: 'first_index', commitSha: HANDOFF_HEAD }),
    ]);
    expect((await repoRow()).indexPausedReason).toBeNull();
    const runs = await ledger('system.code-graph-index');
    expect(runs.at(-1)!.output).toMatchObject({ indexed: true, indexedBy: 'motir-codegraph' });
  });

  it('no paid AI plan pauses with AI_PLAN_INDEX_PAUSE_REASON and sends nothing; with a plan, catch-up indexes it', async () => {
    const seeded = await seedIndexWorkspace(slug('noplan'), 1);
    const plan = vi.spyOn(aiPlanGateService, 'hasPaidAiPlan').mockResolvedValue(false);

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: seeded.installationId,
      workspaceId: seeded.workspaceId,
      repos: [
        {
          providerRepoId: (await repoRow()).repoId,
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });
    await drain();
    expect((await repoRow()).indexPausedReason).toBe(AI_PLAN_INDEX_PAUSE_REASON);
    expect(handoffWorld.handoffs).toEqual([]);

    plan.mockResolvedValue(true);
    await codeGraphIndexCatchUpService.catchUp();
    await drain();

    expect(handoffWorld.handoffs).toEqual([
      expect.objectContaining({ kind: 'first_index', commitSha: HANDOFF_HEAD }),
    ]);
    expect((await repoRow()).indexPausedReason).toBeNull();
  });
});

// ── the pass and the gate ────────────────────────────────────────────────────

describe('the first-index pass, and the gate after it', () => {
  it('enqueues every live repository despite old-fleet rows, skips the archived one, and the gate then counts only handoff rows', async () => {
    const seeded = await seedIndexWorkspace(slug('pass'), 1, [
      { owner: 'moooon', name: 'motir-core' },
      { owner: 'moooon', name: 'motir-ai' },
      { owner: 'moooon', name: 'shelved' },
    ]);
    await stamp({ archived: true }, 'shelved');
    for (const ref of seeded.repoRefs) await oldFleetRow(seeded.workspaceId, ref);

    // Before the pass, the old-fleet rows count for nothing at the gate.
    const before = await codeGraphIndexService.sweepReposMissingFirstIndex({
      workspaceId: seeded.workspaceId,
      dryRun: true,
    });
    expect(before.alreadyIndexed).toBe(0);

    const lines: string[] = [];
    expect(
      await runFirstIndexPass([`--workspace=${seeded.workspaceId}`], {
        out: { log: (line) => void lines.push(line) },
      }),
    ).toBe(0);
    expect(lines).toContain(
      `[first-index-pass]   skipped moooon/shelved (workspace ${seeded.workspaceId}): archived`,
    );
    await drain();

    expect(handoffWorld.handoffs.map((h) => h['repoRef']).sort()).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
    expect(handoffWorld.handoffs.every((h) => h['kind'] === 'first_index')).toBe(true);

    // After it, the two handed-off repositories are indexed at the gate; the archived
    // one, with only its old-fleet row, is not.
    const gate = await withSystemContext((tx) =>
      jobRunRepository.listHandoffIndexedCodeGraphRepoRefs(seeded.workspaceId, tx),
    );
    expect(gate.sort()).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
    const after = await codeGraphIndexService.sweepReposMissingFirstIndex({
      workspaceId: seeded.workspaceId,
      dryRun: true,
    });
    expect(after.missing.map((r) => r.repoRef)).toEqual(['moooon/shelved']);
  });
});

// ── one more seam: a status that overtakes the handed commit ─────────────────

describe('a newer publish overtaking the handed commit', () => {
  it('settles the run on the published head instead of waiting it out', async () => {
    const seeded = await seedIndexedAtOlder('overtaken');
    handoffWorld.compare = { files: [] };
    handoffWorld.statuses = [publishedAt(SECOND_HEAD, new Date(Date.now() + 60_000).toISOString())];

    await githubPush(seeded, HANDOFF_HEAD);
    await drain();

    const [row] = await ledger('system.code-graph-refresh');
    expect(row!.status).toBe('succeeded');
    expect(row!.output).toMatchObject({ supersededBy: SECOND_HEAD });
    expect((await repoRow()).indexedHeadSha).toBe(SECOND_HEAD);
  });
});
