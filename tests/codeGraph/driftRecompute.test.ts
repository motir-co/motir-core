import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveCodeContextState } from '@/lib/services/codeContextService';
import { codeGraphDriftService, DRIFT_RECOMPUTE_BATCH } from '@/lib/services/codeGraphDriftService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';

// THE DRIFT RECOMPUTE (Story MOTIR-1754 · MOTIR-4644) — the sweep that fills the
// count, and the read that serves it.
//
// ⚠️ THE ACCEPTANCE CRITERION THIS FILE EXISTS FOR IS A NEGATIVE ONE: a
// code-context READ makes no provider call. MOTIR-1766 chose a push webhook over
// a HEAD fetch precisely to keep provider latency and rate limits off the two
// surfaces that read staleness, and counting commits is strictly more expensive
// than fetching a head. So the provider double below FAILS THE TEST if it is
// invoked on a read path — an assertion that a call did not happen is worthless
// unless the double would notice one.
//
// Real Postgres. Only the provider registry is doubled.

const compareCommits = vi.fn();

vi.mock('@/lib/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/git')>();
  return {
    ...actual,
    getGitProvider: () => ({ id: 'github', compareCommits }),
  };
});

let fx: WorkItemFixture;
let orgId: string;
let installationRowId: string;

beforeEach(async () => {
  compareCommits.mockReset();
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

function seedRepo(
  name: string,
  opts: {
    defaultBranchHeadSha?: string | null;
    indexedHeadSha?: string | null;
    commitsBehind?: number | null;
    commitsBehindBaseSha?: string | null;
    commitsBehindHeadSha?: string | null;
    archived?: boolean;
  } = {},
) {
  return adminDb.githubRepo.create({
    data: {
      installationId: installationRowId,
      workspaceId: fx.workspaceId,
      organizationId: orgId,
      repoId: `host-${name}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: opts.archived ?? false,
      defaultBranchHeadSha: opts.defaultBranchHeadSha ?? null,
      indexedHeadSha: opts.indexedHeadSha ?? null,
      commitsBehind: opts.commitsBehind ?? null,
      commitsBehindBaseSha: opts.commitsBehindBaseSha ?? null,
      commitsBehindHeadSha: opts.commitsBehindHeadSha ?? null,
    },
  });
}

/**
 * A succeeded index in the LEDGER — the other half of `stale`.
 *
 * `deriveCodeGraphIndexState` reaches the sha comparison only when a graph
 * provably exists, and "exists" is the row's `indexedAt`, which the settle of a
 * succeeded `system.code-graph-index` run stamps (MOTIR-10171) — so this seeds
 * both. Differing shas alone report `never`, which is correct and is not the case
 * this file is about.
 */
async function seedSucceededIndex(repoRef: string) {
  await adminDb.jobRun.create({
    data: {
      workspaceId: fx.workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'code-graph/index.requested',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'inngest',
      attempt: 1,
      status: 'succeeded',
      output: { repoRef },
    },
  });
  // …and the settle's stamp on the repository row, which is what every index
  // state reads (`hasBuiltGraph`, Bug MOTIR-10171): a real success writes both.
  const [owner, name] = repoRef.split('/');
  await adminDb.githubRepo.updateMany({
    where: { owner, name, indexedAt: null },
    data: { indexedAt: new Date() },
  });
}

async function linkIntoProject(githubRepoId: string, name: string) {
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await adminDb.projectRepo.update({ where: { id: row.id }, data: { githubRepoId } });
}

describe('⚠️ the READ makes no provider call', () => {
  it('serves the stored count from a column, and never asks the host', async () => {
    // The double throws rather than returning: a read that reached it would fail
    // here loudly instead of quietly costing a round-trip in production.
    compareCommits.mockImplementation(() => {
      throw new Error('the read path called the provider — MOTIR-1766’s constraint is broken');
    });

    const repo = await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    await linkIntoProject(repo.id, 'web');

    const ctx = { userId: fx.ownerId, workspaceId: fx.workspaceId };
    const state = await resolveCodeContextState(fx.projectId, ctx);

    expect(state.repos[0]?.commitsBehind).toBe(312);
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('returns null — not a stale number — when the pair has MOVED since it was counted', async () => {
    compareCommits.mockImplementation(() => {
      throw new Error('the read path called the provider');
    });

    // A push landed: the count was true of `head9`, the branch is at `head10`.
    const repo = await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head10',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    await linkIntoProject(repo.id, 'web');
    await seedSucceededIndex('moooon/web');

    const state = await resolveCodeContextState(fx.projectId, {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
    });

    expect(state.repos[0]?.commitsBehind).toBeNull();
    // …and the repository still reports `stale`, because the SHAS differ. The
    // count being unknown does not make the drift unknown — the two are separate
    // facts and the surfaces draw both. `stale` needs a succeeded index in the
    // LEDGER as well as differing shas, which `seedSucceededIndex` supplies.
    expect(state.repos[0]?.indexState).toBe('stale');
    expect(compareCommits).not.toHaveBeenCalled();
  });
});

describe('the SWEEP — what it selects, and what it writes', () => {
  it('counts a differing pair and stores the count WITH the pair', async () => {
    const repo = await seedRepo('web', { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });
    compareCommits.mockResolvedValue({ behindBy: 312 });

    const summary = await codeGraphDriftService.recomputeDrift();

    expect(summary).toMatchObject({ scanned: 1, counted: 1, indeterminate: 0, skipped: 0 });
    // ⚠️ THE HOST'S ID, NOT OUR FK. Passing `github_repo.installation_id` mints
    // no token and the compare 404s — which looks exactly like a repository with
    // no common ancestor, so nothing downstream would ever report the mistake.
    expect(compareCommits).toHaveBeenCalledWith(
      `inst-${fx.workspaceId}`,
      'moooon',
      'web',
      'base1',
      'head9',
    );
    const after = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(after.commitsBehind).toBe(312);
    expect(after.commitsBehindBaseSha).toBe('base1');
    expect(after.commitsBehindHeadSha).toBe('head9');
  });

  it('does NOT select a repository whose shas MATCH — there is nothing to count', async () => {
    await seedRepo('web', { indexedHeadSha: 'same', defaultBranchHeadSha: 'same' });
    const summary = await codeGraphDriftService.recomputeDrift();
    expect(summary.scanned).toBe(0);
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('does NOT select a repository already counted for its CURRENT pair', async () => {
    await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    const summary = await codeGraphDriftService.recomputeDrift();
    expect(summary.scanned).toBe(0);
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('RE-selects it the moment the pair moves', async () => {
    await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head10',
      commitsBehind: 312,
      commitsBehindBaseSha: 'base1',
      commitsBehindHeadSha: 'head9',
    });
    compareCommits.mockResolvedValue({ behindBy: 313 });
    const summary = await codeGraphDriftService.recomputeDrift();
    expect(summary.counted).toBe(1);
  });

  it('does not select an ARCHIVED repository', async () => {
    await seedRepo('web', {
      indexedHeadSha: 'base1',
      defaultBranchHeadSha: 'head9',
      archived: true,
    });
    expect((await codeGraphDriftService.recomputeDrift()).scanned).toBe(0);
  });

  it('⚠️ records a NO-COMMON-ANCESTOR pair as null, and stops re-selecting it', async () => {
    // A force-push. The count is undefined for this pair — not zero — and
    // recording that is what keeps the sweep from retrying the same repository on
    // every tick for ever.
    const repo = await seedRepo('web', { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });
    compareCommits.mockResolvedValue({ behindBy: null, reason: 'no_common_ancestor' });

    const first = await codeGraphDriftService.recomputeDrift();
    expect(first).toMatchObject({ scanned: 1, counted: 0, indeterminate: 1 });

    const after = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(after.commitsBehind).toBeNull();
    expect(after.commitsBehind).not.toBe(0);
    expect(after.commitsBehindBaseSha).toBe('base1');

    // The second tick finds nothing: the pair has been tried.
    compareCommits.mockClear();
    expect((await codeGraphDriftService.recomputeDrift()).scanned).toBe(0);
    expect(compareCommits).not.toHaveBeenCalled();
  });

  it('a provider THROW is recorded as null and does NOT abort the sweep', async () => {
    // One tenant's broken host must not stop every other tenant's count being
    // taken — the isolation the auto-plan cadence sweep applies, for the reason.
    await seedRepo('a', { indexedHeadSha: 'b1', defaultBranchHeadSha: 'h1' });
    await seedRepo('b', { indexedHeadSha: 'b2', defaultBranchHeadSha: 'h2' });
    compareCommits
      .mockRejectedValueOnce(new Error('host down'))
      .mockResolvedValueOnce({ behindBy: 5 });

    const summary = await codeGraphDriftService.recomputeDrift();

    expect(summary.scanned).toBe(2);
    expect(summary.counted).toBe(1);
    expect(summary.indeterminate).toBe(1);
  });

  it('⚠️ LOSES the race rather than stamping a count on the wrong pair', async () => {
    // A push lands while the compare is in flight. Writing then would stamp a
    // number computed for the OLD pair with the NEW pair's shas — plausible,
    // wrong, and undetectable by any later read. The write is conditional, so it
    // simply does not happen.
    const repo = await seedRepo('web', { indexedHeadSha: 'base1', defaultBranchHeadSha: 'head9' });
    compareCommits.mockImplementation(async () => {
      await adminDb.githubRepo.update({
        where: { id: repo.id },
        data: { defaultBranchHeadSha: 'head10' },
      });
      return { behindBy: 312 };
    });

    const summary = await codeGraphDriftService.recomputeDrift();

    expect(summary).toMatchObject({ scanned: 1, counted: 0, skipped: 1 });
    const after = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(after.commitsBehind).toBeNull();
    expect(after.commitsBehindHeadSha).toBeNull();
  });

  it('is BOUNDED per tick — the rate limit is the reason, so the bound is asserted', async () => {
    for (let i = 0; i < DRIFT_RECOMPUTE_BATCH + 3; i++) {
      await seedRepo(`repo-${i}`, { indexedHeadSha: `b${i}`, defaultBranchHeadSha: `h${i}` });
    }
    compareCommits.mockResolvedValue({ behindBy: 1 });

    const summary = await codeGraphDriftService.recomputeDrift();

    expect(summary.scanned).toBe(DRIFT_RECOMPUTE_BATCH);
    expect(compareCommits).toHaveBeenCalledTimes(DRIFT_RECOMPUTE_BATCH);
  });

  it('the repository read applies the same bound', async () => {
    for (let i = 0; i < 5; i++) {
      await seedRepo(`repo-${i}`, { indexedHeadSha: `b${i}`, defaultBranchHeadSha: `h${i}` });
    }
    const rows = await withSystemContext((tx) =>
      githubRepoRepository.listNeedingDriftRecompute(2, tx),
    );
    expect(rows).toHaveLength(2);
  });
});
