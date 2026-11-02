import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from './fixtures/workItemFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { resolveRefreshDisposition } from '@/lib/ai/codeContext';

// A TERMINALLY-FAILED REFRESH RAISES A SIGNAL A HUMAN SEES (Story MOTIR-1754 ·
// MOTIR-2105).
//
// ⚠️ THE FAILURE THIS ENDS. When a refresh dead-letters the code graph does not
// disappear — a stale one keeps answering, and the planner reads it confidently
// with no indication the snapshot is days behind. That is the code-blind failure
// this whole story exists to make explicit, arriving through the one path nobody
// watches: 35 dead-letters over 48 hours, unnoticed, and three days later the
// rate was unchanged.
//
// ⚠️ AND THE SIGNAL IS DRIVEN BY THE GRAPH'S FRESHNESS, NOT BY "A JOB FAILED"
// (the card's second criterion). The four-state verdict and the drift already
// catch every cause of staleness including the ones that never produce a failed
// run; what this card adds is the REASON, which is what tells a person whether
// waiting is the right thing to do.
//
// Real Postgres. Nothing is stubbed.

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  orgId = fx.workspace.organizationId;
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  installationRowId = installation.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A code-graph run in the ledger, in whatever state the case needs. */
async function seedRun(
  status: 'running' | 'succeeded' | 'failed' | 'abandoned',
  opts: { functionId?: string; repoRef?: string } = {},
): Promise<string> {
  const run = await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: opts.functionId ?? 'system.code-graph-refresh',
      eventName: 'code-graph/index.requested',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'inngest',
      attempt: 1,
      status,
      ...(opts.repoRef ? { output: { repoRef: opts.repoRef } } : {}),
    },
  });
  // A succeeded index also stamps the repository row — the fact every index state
  // reads (`hasBuiltGraph`, Bug MOTIR-10171).
  if (status === 'succeeded' && opts.repoRef && opts.functionId === 'system.code-graph-index') {
    const [owner, name] = opts.repoRef.split('/');
    await adminDb.githubRepo.updateMany({
      where: { owner, name, indexedAt: null },
      data: { indexedAt: new Date() },
    });
  }
  return run.id;
}

async function seedRepo(opts: { indexingRunId?: string | null } = {}) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: 'host-web',
      owner: 'moooon',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      indexingRunId: opts.indexingRunId ?? null,
    },
  });
}

async function linkIntoProject(githubRepoId: string) {
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'web' },
    fx.ctx,
  );
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId } });
}

const CTX = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

/** The repository's row as the Code page reads it. */
async function readRow() {
  const state = await resolveCodeContextState(fx.projectId, CTX());
  return state.repos[0];
}

describe('⚠️ a human can tell the graph is stale WITHOUT reading `job_run_dlq`', () => {
  it('a dead-lettered refresh reads as FAILING on the repository row', async () => {
    const run = await seedRun('failed');
    const repo = await seedRepo({ indexingRunId: run });
    await linkIntoProject(repo.id);
    await seedRun('succeeded', { functionId: 'system.code-graph-index', repoRef: 'moooon/web' });

    expect(await readRow()).toMatchObject({ indexState: 'stale', refreshFailing: true });
  });

  it('⚠️ an ABANDONED run counts too — "nothing came back" is also terminal', async () => {
    // The schema keeps `failed` and `abandoned` apart deliberately: only one has
    // a stack trace to show. For *is the refresh coming?* they are one answer,
    // and reading only `failed` would leave every reaped run silently stale —
    // which is the exact shape of the defect this card exists to end.
    const run = await seedRun('abandoned');
    const repo = await seedRepo({ indexingRunId: run });
    await linkIntoProject(repo.id);
    await seedRun('succeeded', { functionId: 'system.code-graph-index', repoRef: 'moooon/web' });

    expect((await readRow())?.refreshFailing).toBe(true);
  });

  it('⚠️ a failed FIRST INDEX counts as well, not only a refresh', async () => {
    // Both functions write into the same ledger and mean the same thing to a
    // reader — the graph is behind and nothing is coming. Watching only
    // `system.code-graph-refresh` would leave a repository whose very first
    // index died looking merely un-indexed.
    const run = await seedRun('failed', { functionId: 'system.code-graph-index' });
    const repo = await seedRepo({ indexingRunId: run });
    await linkIntoProject(repo.id);

    expect((await readRow())?.refreshFailing).toBe(true);
  });

  it('a RUNNING claim is not a failure — it is the one state that IS moving', async () => {
    // ⚠️ SEEDED AS AN `index` RUN, and the asymmetry is real rather than a
    // fixture convenience: the RUNNING read watches `system.code-graph-index`
    // alone, while the terminal read above watches both functions. That is
    // deliberate in both directions — `indexing` is a claim that something is
    // happening and only the index job's ledger row can carry it, whereas *the
    // graph is behind and nothing is coming* is equally true of either function
    // dying, and watching one of them would leave the other silently stale.
    const run = await seedRun('running', { functionId: 'system.code-graph-index' });
    const repo = await seedRepo({ indexingRunId: run });
    await linkIntoProject(repo.id);

    const row = await readRow();
    expect(row?.refreshFailing).toBe(false);
    expect(row?.indexState).toBe('indexing');
  });

  it('⚠️ a stale repository with a HEALTHY pipeline is not reported as failing', async () => {
    // The false positive that would make the signal worthless. Being far behind
    // is not evidence that anything broke: a pipeline that has simply not run
    // yet looks identical, and a surface that cried failure at every drift would
    // be ignored exactly as the DLQ tab was.
    const repo = await seedRepo({ indexingRunId: null });
    await linkIntoProject(repo.id);
    await seedRun('succeeded', { functionId: 'system.code-graph-index', repoRef: 'moooon/web' });

    const row = await readRow();
    expect(row?.indexState).toBe('stale');
    expect(row?.refreshFailing).toBe(false);
  });

  it('⚠️ ANOTHER workspace’s dead run does not condemn this one’s repository', async () => {
    // The ledger read is workspace-scoped. A cross-tenant leak here would report
    // a failure that is not this customer's, on a surface whose whole value is
    // that it is believed.
    const foreign = await makeWorkItemFixture({ name: 'Foreign', identifier: 'FRGN' });
    const foreignRun = await adminDb.jobRun.create({
      data: {
        workspaceId: foreign.workspaceId,
        functionId: 'system.code-graph-refresh',
        eventName: 'code-graph/index.requested',
        eventId: `evt-foreign-${Math.random().toString(36).slice(2)}`,
        lane: 'inngest',
        attempt: 1,
        status: 'failed',
      },
    });
    const repo = await seedRepo({ indexingRunId: foreignRun.id });
    await linkIntoProject(repo.id);

    expect((await readRow())?.refreshFailing).toBe(false);
  });
});

describe('⚠️ the DISPOSITION finally has its producer', () => {
  it('`refresh_failing` is reachable — it was not before this card', async () => {
    // `resolveRefreshDisposition` has been able to SAY a refresh is failing since
    // MOTIR-4604 and nothing ever told it, so the explanation sat in the
    // signature looking covered while being structurally unreachable.
    expect(
      resolveRefreshDisposition({ indexState: 'stale', canIndex: true, refreshFailing: true }),
    ).toEqual({ reason: 'refresh_failing', refreshInFlight: false, enqueue: false });
  });

  it('⚠️ and it SUPPRESSES the enqueue — an action that cannot succeed is worse than none', async () => {
    // Without the flag this repository was enqueued on every session start, into
    // a pipeline that had just failed it. `design/code-context` §6.2: where
    // nothing can be started, the honest rendering offers no action.
    const stuck = resolveRefreshDisposition({
      indexState: 'stale',
      canIndex: true,
      refreshFailing: true,
    });
    const healthy = resolveRefreshDisposition({ indexState: 'stale', canIndex: true });
    expect(stuck.enqueue).toBe(false);
    expect(healthy.enqueue).toBe(true);
    expect(healthy.reason).toBe('refresh_enqueued');
  });

  it('a healthy stale repository still enqueues — the signal narrows nothing else', async () => {
    expect(
      resolveRefreshDisposition({ indexState: 'stale', canIndex: true, refreshFailing: false })
        .enqueue,
    ).toBe(true);
  });
});

describe('⚠️ the copy PROMISES NOTHING', () => {
  const row = readFileSync('app/(authed)/code/_components/CodeRepositories.tsx', 'utf8');
  const en = JSON.parse(readFileSync('messages/en.json', 'utf8')) as {
    code: { repositories: Record<string, string> };
  };

  it('says the index is not updating, in those words', () => {
    // `design/code-context` §10.1 settles it: panel D states the drift, states
    // the consequence, and says "This index is not updating."
    expect(en.code.repositories['notUpdating']).toBe('This index is not updating.');
  });

  it('⚠️ offers NO wait-and-return language anywhere in the section', () => {
    // The rule this exists to keep: no "catching up", no "shortly", no "check
    // back", no "this will resolve". A refresh can be paused, failing, or
    // impossible for the provider, so a stale repository may sit stale for ever
    // and a promise here is a lie with a schedule attached.
    const copy = Object.values(en.code.repositories).join(' ');
    expect(copy).not.toMatch(/catching up|shortly|check back|will resolve|try again soon/i);
  });

  it('renders the line only for a graph that EXISTS and is stuck', () => {
    // `never` has its own chip and its own answer — the first index is the
    // connect path's, not a repair — and `indexing` is the one state that is
    // genuinely moving.
    expect(row).toContain("repo.indexState === 'never'");
    expect(row).toContain("repo.indexState === 'indexing'");
    expect(row).toContain('repo.refreshFailing');
  });

  it('⚠️ says nothing commercial', () => {
    // MOTIR-4541: the internal cause of a paused refresh is an exhausted index
    // allowance, and none of that may reach a customer-facing surface.
    const copy = Object.values(en.code.repositories).join(' ');
    expect(copy).not.toMatch(/credit|balance|allowance|billed|charged?|priced?|quota/i);
  });
});
