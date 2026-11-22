import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { codeGraphIndexService } from '@/lib/services/codeGraphIndexService';
import { jobRunRepository } from '@/lib/repositories/jobRunRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { spyOnJobDispatch, dispatchedEvents } from '../helpers/jobs';

// MOTIR-1961 — the OPERATOR recovery sweep for repos that never got a first code
// graph, against a real Postgres (the motir-core convention). The only mock is
// `inngest.send`, spied so an enqueue never leaves the test.
//
// The bug this covers: a repo connected BEFORE the initial-index feature shipped
// was never "newly added" at any moment when the enqueue existed, so no bind, no
// reconcile and no refresh ever gave it a graph — the state "the repo row exists
// and no index exists" was inescapable. The gate now asks whether the repo has a
// graph; this sweep is the path for a workspace that will not see a
// repo-selection change soon.

const PASSWORD = 'hunter2hunter2';

interface Seeded {
  workspaceId: string;
}

let sendSpy: ReturnType<typeof vi.spyOn>;

async function makeWorkspace(email: string): Promise<Seeded> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { workspaceId: workspace.id };
}

/** Mirror an installation + its repos exactly as the grant path does — WITHOUT
 *  enqueueing anything (`persistInstallation` is the write half only), which is
 *  precisely the pre-MOTIR-1500 state the defect left behind. */
async function connectRepos(
  workspaceId: string,
  installationId: string,
  repos: { repoId: string; name: string; defaultBranch?: string }[],
): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: { installationId, accountLogin: 'moooon', accountType: 'Organization' },
    repos: repos.map((r) => ({
      providerRepoId: r.repoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch ?? 'main',
      archived: false,
    })),
  });
}

/** The ledger row that MEANS "this repo has a code graph": since MOTIR-11885 a
 *  succeeded run the HANDOFF wrote (`output.indexedBy: 'motir-codegraph'`). */
async function seedSucceededIndex(workspaceId: string, repoRef: string): Promise<void> {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${workspaceId}-${repoRef}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      output: { indexed: true, repoRef, projectsIndexed: 1, indexedBy: 'motir-codegraph' },
    },
  });
}

/** An OLD-FLEET success: `output.repoRef` and no `indexedBy`. */
async function seedOldFleetIndex(workspaceId: string, repoRef: string): Promise<void> {
  await adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-old-${workspaceId}-${repoRef}`,
      lane: 'engine',
      attempt: 0,
      status: 'succeeded',
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

/** Every `system.code-graph-index` event the spy saw, as `owner/name`. */
function enqueuedRepoRefs(): string[] {
  return dispatchedEvents(sendSpy)
    .filter((e) => e.name === 'system.code-graph-index')
    .map((e) => e.data as { repoOwner: string; repoName: string })
    .map((d) => `${d.repoOwner}/${d.repoName}`);
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  sendSpy = spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('codeGraphIndexService.sweepReposMissingFirstIndex (MOTIR-1961)', () => {
  it('enqueues a first index for a connected repo that has no code graph', async () => {
    const { workspaceId } = await makeWorkspace('sweep-basic@example.com');
    await connectRepos(workspaceId, 'inst-1', [
      { repoId: '111', name: 'motir-core', defaultBranch: 'trunk' },
    ]);

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ dryRun: false, scanned: 1, alreadyIndexed: 0, enqueued: 1 });
    expect(report.missing).toEqual([
      {
        workspaceId,
        installationId: 'inst-1',
        repoRef: 'moooon/motir-core',
        defaultBranch: 'trunk',
      },
    ]);
    // The payload is the SAME shape the webhook produces — the enqueue runs
    // through one chokepoint, so the job cannot tell the two producers apart.
    const indexCalls = dispatchedEvents(sendSpy).filter(
      (e) => e.name === 'system.code-graph-index',
    );
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]!.data).toEqual({
      installationId: 'inst-1',
      workspaceId,
      repoOwner: 'moooon',
      repoName: 'motir-core',
      defaultBranch: 'trunk',
    });
  });

  it('leaves an already-indexed repo alone and sweeps only the rest', async () => {
    const { workspaceId } = await makeWorkspace('sweep-partial@example.com');
    await connectRepos(workspaceId, 'inst-1', [
      { repoId: '111', name: 'motir-core' },
      { repoId: '222', name: 'motir-ai' },
      { repoId: '333', name: 'motir-meta' },
    ]);
    await seedSucceededIndex(workspaceId, 'moooon/motir-ai');

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 3, alreadyIndexed: 1, enqueued: 2 });
    expect(enqueuedRepoRefs().sort()).toEqual(['moooon/motir-core', 'moooon/motir-meta']);
  });

  it('a dry run REPORTS the missing repos and enqueues nothing', async () => {
    const { workspaceId } = await makeWorkspace('sweep-dry@example.com');
    await connectRepos(workspaceId, 'inst-1', [
      { repoId: '111', name: 'motir-core' },
      { repoId: '222', name: 'motir-ai' },
    ]);

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex({ dryRun: true });

    expect(report).toMatchObject({ dryRun: true, scanned: 2, alreadyIndexed: 0, enqueued: 0 });
    expect(report.missing.map((r) => r.repoRef).sort()).toEqual([
      'moooon/motir-ai',
      'moooon/motir-core',
    ]);
    expect(enqueuedRepoRefs()).toEqual([]);
  });

  it('is IDEMPOTENT: once the index succeeds, a re-run enqueues nothing', async () => {
    const { workspaceId } = await makeWorkspace('sweep-idempotent@example.com');
    await connectRepos(workspaceId, 'inst-1', [{ repoId: '111', name: 'motir-core' }]);

    const first = await codeGraphIndexService.sweepReposMissingFirstIndex();
    expect(first.enqueued).toBe(1);

    // The enqueued job runs and succeeds — the ledger now says the repo has a graph.
    await seedSucceededIndex(workspaceId, 'moooon/motir-core');
    sendSpy.mockClear();

    const second = await codeGraphIndexService.sweepReposMissingFirstIndex();
    expect(second).toMatchObject({ scanned: 1, alreadyIndexed: 1, enqueued: 0 });
    expect(second.missing).toEqual([]);
    expect(enqueuedRepoRefs()).toEqual([]);
  });

  it('sweeps EVERY tenant by default — the defect is not one workspace’s', async () => {
    const a = await makeWorkspace('sweep-tenant-a@example.com');
    const b = await makeWorkspace('sweep-tenant-b@example.com');
    await connectRepos(a.workspaceId, 'inst-a', [{ repoId: '111', name: 'alpha' }]);
    await connectRepos(b.workspaceId, 'inst-b', [{ repoId: '222', name: 'beta' }]);

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report.scanned).toBe(2);
    expect(report.missing.map((r) => r.workspaceId).sort()).toEqual(
      [a.workspaceId, b.workspaceId].sort(),
    );
    expect(enqueuedRepoRefs().sort()).toEqual(['moooon/alpha', 'moooon/beta']);
  });

  it('`workspaceId` scopes the sweep to ONE tenant and leaves the other untouched', async () => {
    const a = await makeWorkspace('sweep-scope-a@example.com');
    const b = await makeWorkspace('sweep-scope-b@example.com');
    await connectRepos(a.workspaceId, 'inst-a', [{ repoId: '111', name: 'alpha' }]);
    await connectRepos(b.workspaceId, 'inst-b', [{ repoId: '222', name: 'beta' }]);

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex({
      workspaceId: a.workspaceId,
    });

    expect(report).toMatchObject({ scanned: 1, enqueued: 1 });
    expect(enqueuedRepoRefs()).toEqual(['moooon/alpha']);
  });

  it('another tenant’s index of the SAME repoRef does not count as this tenant’s graph', async () => {
    // The graph is per (workspace, repo). If the ledger read leaked across
    // tenants, a workspace could be marked indexed by someone else's run and
    // never get a graph of its own.
    const a = await makeWorkspace('sweep-isolation-a@example.com');
    const b = await makeWorkspace('sweep-isolation-b@example.com');
    await connectRepos(a.workspaceId, 'inst-a', [{ repoId: '111', name: 'shared-name' }]);
    await connectRepos(b.workspaceId, 'inst-b', [{ repoId: '222', name: 'shared-name' }]);
    await seedSucceededIndex(a.workspaceId, 'moooon/shared-name');

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 2, alreadyIndexed: 1, enqueued: 1 });
    expect(report.missing).toEqual([
      {
        workspaceId: b.workspaceId,
        installationId: 'inst-b',
        repoRef: 'moooon/shared-name',
        defaultBranch: 'main',
      },
    ]);
  });

  it('reports a clean sweep when every connected repo already has a graph', async () => {
    const { workspaceId } = await makeWorkspace('sweep-clean@example.com');
    await connectRepos(workspaceId, 'inst-1', [{ repoId: '111', name: 'motir-core' }]);
    await seedSucceededIndex(workspaceId, 'moooon/motir-core');

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 1, alreadyIndexed: 1, enqueued: 0 });
    expect(report.missing).toEqual([]);
  });

  it('a workspace with no connected repos sweeps to an empty report', async () => {
    await makeWorkspace('sweep-empty@example.com');

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 0, alreadyIndexed: 0, enqueued: 0, missing: [] });
    expect(enqueuedRepoRefs()).toEqual([]);
  });

  it('a FAILED index run does not count as a graph — the repo is swept again', async () => {
    const { workspaceId } = await makeWorkspace('sweep-failed@example.com');
    await connectRepos(workspaceId, 'inst-1', [{ repoId: '111', name: 'motir-core' }]);
    await adminDb.jobRun.create({
      data: {
        workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: 'evt-failed',
        lane: 'engine',
        attempt: 4,
        status: 'failed',
        output: { indexed: true, repoRef: 'moooon/motir-core', projectsIndexed: 1 },
      },
    });

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 1, alreadyIndexed: 0, enqueued: 1 });
    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-core']);
  });

  it('a queue blip on one repo never blocks the others (best-effort per repo)', async () => {
    const { workspaceId } = await makeWorkspace('sweep-blip@example.com');
    await connectRepos(workspaceId, 'inst-1', [
      { repoId: '111', name: 'motir-ai' },
      { repoId: '222', name: 'motir-core' },
    ]);
    sendSpy.mockRejectedValueOnce(new Error('queue down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    // Both were attempted; the swallowed failure was logged (PROD-443's rule).
    expect(report.missing).toHaveLength(2);
    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('an old-fleet success no longer counts as a graph (MOTIR-11885)', () => {
  it('the sweep lists a repo whose only succeeded row is old-fleet, and not one with a handoff row', async () => {
    const { workspaceId } = await makeWorkspace('sweep-old-fleet@example.com');
    await connectRepos(workspaceId, 'inst-1', [
      { repoId: '111', name: 'motir-core' },
      { repoId: '222', name: 'motir-ai' },
    ]);
    await seedOldFleetIndex(workspaceId, 'moooon/motir-core');
    await seedOldFleetIndex(workspaceId, 'moooon/motir-ai');
    await seedSucceededIndex(workspaceId, 'moooon/motir-ai');

    const report = await codeGraphIndexService.sweepReposMissingFirstIndex();

    expect(report).toMatchObject({ scanned: 2, alreadyIndexed: 1, enqueued: 1 });
    expect(report.missing.map((r) => r.repoRef)).toEqual(['moooon/motir-core']);
    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-core']);
  });

  it('the reconcile gate enqueues an old-fleet-only repo and skips a handoff-indexed one', async () => {
    const { workspaceId } = await makeWorkspace('gate-old-fleet@example.com');
    await seedOldFleetIndex(workspaceId, 'moooon/motir-core');
    await seedSucceededIndex(workspaceId, 'moooon/motir-ai');

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: 'inst-1',
      workspaceId,
      repos: [
        {
          providerRepoId: '111',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
        {
          providerRepoId: '222',
          owner: 'moooon',
          name: 'motir-ai',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-core']);
  });

  it('the broad ledger read every other reader uses still counts the old-fleet row', async () => {
    const { workspaceId } = await makeWorkspace('broad-old-fleet@example.com');
    await seedOldFleetIndex(workspaceId, 'moooon/motir-core');
    await expect(
      withSystemContext((tx) =>
        jobRunRepository.listSucceededCodeGraphIndexRepoRefs(workspaceId, tx),
      ),
    ).resolves.toEqual(['moooon/motir-core']);
  });
});

describe('jobRunRepository.listHandoffIndexedCodeGraphRepoRefs (MOTIR-11885)', () => {
  const row = (
    workspaceId: string,
    over: { functionId?: string; status?: 'succeeded' | 'failed' | 'running'; output?: object },
  ) =>
    adminDb.jobRun.create({
      data: {
        workspaceId,
        functionId: over.functionId ?? 'system.code-graph-index',
        eventName: over.functionId ?? 'system.code-graph-index',
        eventId: `evt-${Math.random()}`,
        lane: 'engine',
        attempt: 0,
        status: over.status ?? 'succeeded',
        output: (over.output ?? {
          indexed: true,
          repoRef: 'moooon/handoff',
          indexedBy: 'motir-codegraph',
        }) as object,
      },
    });

  it('answers only succeeded handoff rows of this workspace’s first-index job, each ref once', async () => {
    const { workspaceId } = await makeWorkspace('read-handoff@example.com');
    const other = await makeWorkspace('read-handoff-other@example.com');
    await row(workspaceId, {});
    await row(workspaceId, {}); // the same ref twice
    await row(workspaceId, { output: { indexed: true, repoRef: 'moooon/old' } });
    await row(workspaceId, {
      status: 'failed',
      output: { repoRef: 'moooon/failed', indexedBy: 'motir-codegraph' },
    });
    await row(workspaceId, {
      status: 'running',
      output: { repoRef: 'moooon/running', indexedBy: 'motir-codegraph' },
    });
    await row(workspaceId, {
      functionId: 'system.code-graph-refresh',
      output: { repoRef: 'moooon/refresh', indexedBy: 'motir-codegraph' },
    });
    await row(workspaceId, { output: { indexed: false, indexedBy: 'motir-codegraph' } });
    await row(workspaceId, { output: { repoRef: 'moooon/other-writer', indexedBy: 'fleet' } });
    await row(other.workspaceId, {
      output: { repoRef: 'moooon/theirs', indexedBy: 'motir-codegraph' },
    });

    await expect(
      withSystemContext((tx) =>
        jobRunRepository.listHandoffIndexedCodeGraphRepoRefs(workspaceId, tx),
      ),
    ).resolves.toEqual(['moooon/handoff']);
  });
});

describe('codeGraphIndexService.enqueueFirstIndexForRepos (MOTIR-1961)', () => {
  it('reads the ledger and enqueues only the repos without a graph', async () => {
    const { workspaceId } = await makeWorkspace('gate-basic@example.com');
    await seedSucceededIndex(workspaceId, 'moooon/motir-ai');

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: 'inst-1',
      workspaceId,
      repos: [
        {
          providerRepoId: '111',
          owner: 'moooon',
          name: 'motir-core',
          defaultBranch: 'main',
          archived: false,
        },
        {
          providerRepoId: '222',
          owner: 'moooon',
          name: 'motir-ai',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-core']);
  });

  it('a ledger read failure degrades to "nothing is indexed" — the grant never fails', async () => {
    // The gate runs POST-COMMIT on a grant that already landed (PROD-443): it may
    // not throw. Losing the ledger means enqueueing everything, which the
    // idempotent job converges on — the safe direction to fail in.
    const { workspaceId } = await makeWorkspace('gate-ledger-down@example.com');
    vi.spyOn(jobRunRepository, 'listHandoffIndexedCodeGraphRepoRefs').mockRejectedValue(
      new Error('ledger unreadable'),
    );
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      codeGraphIndexService.enqueueFirstIndexForRepos({
        installationId: 'inst-1',
        workspaceId,
        repos: [
          {
            providerRepoId: '111',
            owner: 'moooon',
            name: 'motir-core',
            defaultBranch: 'main',
            archived: false,
          },
        ],
      }),
    ).resolves.toBeUndefined();

    expect(enqueuedRepoRefs()).toEqual(['moooon/motir-core']);
    expect(logged).toHaveBeenCalledOnce();
  });

  it('an empty repo set touches neither the ledger nor the queue', async () => {
    const { workspaceId } = await makeWorkspace('gate-empty@example.com');

    await codeGraphIndexService.enqueueFirstIndexForRepos({
      installationId: 'inst-1',
      workspaceId,
      repos: [],
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
