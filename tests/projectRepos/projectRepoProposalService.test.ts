import type { GithubRepo } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client (the `server-only` 7.1.5 primitive the
// pre-plan signals arrive over) — the project, the set and every write stay on the
// real Postgres path, per the repo's no-mocks convention. This is the same seam
// `conventionEstablishService.test.ts` mocks for the same reason.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { projectRepoProposalService } from '@/lib/services/projectRepoProposalService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { ProjectRepoNameTakenError } from '@/lib/projectRepos/errors';
import {
  PROJECT_REPO_PROPOSAL_SIGNALS,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { organizationIdOf } from '../helpers/organizationOf';

// PROPOSING the repository set over real Postgres (Story MOTIR-1775 · MOTIR-1881).
// The derivation itself is proved in `projectRepoProposal.test.ts` (pure); what is
// proved HERE is everything that only exists once a database is involved:
//
//   1. The proposal is PERSISTED as `proposed` rows through the set service — in
//      set order, with the derived name + seed source, creating nothing on GitHub.
//   2. The pre-plan signals reach the derivation, and every way that read can be
//      absent (no session, a transport failure) still yields the honest default
//      rather than a failure.
//   3. IDEMPOTENCE, which is the property that makes it safe to fire this on every
//      approve — asserted against each state a row can be sitting in, because a
//      proposer that overwrote a `created` row would destroy the association
//      between a project and a repository that really exists.
//
// Tests connect as the superuser, so RLS is inert here by design; tenancy for this
// table is proved in `project-repo-rls.test.ts`.

/** A pre-plan wire body carrying the two signals §0.1 reads (the rest is irrelevant). */
function preplanWith(
  session: { platform?: string | null; designStarter?: string | null } | null,
): RawPreplanStateResponse {
  return {
    session: session === null ? null : (session as RawPreplanStateResponse['session']),
    docs: [],
    catalog: null,
  };
}

/** Connect one repo to the fixture's workspace — what an established row realizes
 *  against (the 7.10.3 installation mirror). */
async function connectRepo(workspaceId: string, name: string): Promise<GithubRepo> {
  const installationId = `inst-${workspaceId}-github`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-${randomToken(8)}`,
      owner: 'acme',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

/** The project's set as it stands, for a before/after comparison. */
function readSet(fx: WorkItemFixture): Promise<ProjectRepoDto[]> {
  return projectRepoSetService.listByProject(fx.projectId, fx.ctx);
}

beforeEach(async () => {
  await truncateAuthTables();
  // The default: a project with a pre-plan session that recorded no platform.
  vi.mocked(getPreplanState).mockResolvedValue(preplanWith({ platform: null }));
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('projectRepoProposalService.proposeRepositorySet — deriving + persisting', () => {
  it('writes ONE `proposed` web row for a project with thin signals, named for the project', async () => {
    const fx = await makeWorkItemFixture();

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result.proposed).toBe(true);
    const rows = await readSet(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'web',
      name: fx.project.slug,
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      // Nothing is created until the user confirms (ADR §0.2) — so the row exists
      // and the repository does not.
      state: 'proposed',
      realizedRepo: null,
      established: false,
    });
  });

  it('carries WHY each row is there back to the caller (a row with no nameable signal must not exist)', async () => {
    const fx = await makeWorkItemFixture();

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toMatchObject({ proposed: true });
    if (!result.proposed) throw new Error('unreachable');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.signal).toBe('default-web');
    expect(result.rows[0]!.reason.length).toBeGreaterThan(0);
    // The persisted rows come back too, so a caller need not re-read the set.
    expect(result.created.map((r) => r.id)).toEqual((await readSet(fx)).map((r) => r.id));
  });

  it('PERSISTS why each row is there, so a LATER page load can still show it (MOTIR-1892)', async () => {
    // The proposer runs exactly once — it refuses to touch a set that already has
    // rows — so a signal that lived only in the result above would be gone by the
    // time the establish step renders the set. Read it back from the DATABASE.
    const fx = await makeWorkItemFixture();

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);
    if (!result.proposed) throw new Error('unreachable');

    const rows = await readSet(fx);
    expect(rows.map((r) => r.proposalSignal)).toEqual(['default-web']);
    // The row the caller was handed and the row on a later read say the SAME
    // thing — a divergence here would mean the write dropped it.
    expect(result.created.map((r) => r.proposalSignal)).toEqual(rows.map((r) => r.proposalSignal));
    // Every persisted signal is one the ADR names, and it matches the rung the
    // derivation reported.
    for (const [i, row] of rows.entries()) {
      expect(PROJECT_REPO_PROPOSAL_SIGNALS).toContain(row.proposalSignal!);
      expect(row.proposalSignal).toBe(result.rows[i]!.signal);
    }
    // Only the machine-readable signal is stored: the English gloss is a log /
    // PR-output fallback, not a localized string, so it must not reach a column a
    // UI renders.
    expect(JSON.stringify(rows)).not.toContain(result.rows[0]!.reason);
  });

  it('persists the PLATFORM rung when the pre-plan session names one', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith({ platform: 'mobile' }));

    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    const rows = await readSet(fx);
    expect(rows.map((r) => [r.role, r.proposalSignal])).toEqual([['mobile', 'preplan-platform']]);
  });

  it('persists the PLAN-ROLE rung on every row of a multi-repo set', async () => {
    // The primary signal (§0.1.1), and the case that makes the column earn its
    // keep: a two-row set the user did not ask for needs to say what split it.
    const fx = await makeWorkItemFixture();

    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
      itemRoles: ['web', 'api'],
    });

    const rows = await readSet(fx);
    expect(rows.map((r) => [r.role, r.proposalSignal])).toEqual([
      ['web', 'plan-item-role'],
      ['api', 'plan-item-role'],
    ]);
  });

  it('reads the PLATFORM signal from the pre-plan session (§0.1.2)', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(getPreplanState).mockResolvedValue(
      preplanWith({ platform: 'mobile', designStarter: 'bare' }),
    );

    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    const rows = await readSet(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'mobile',
      name: fx.project.slug,
      // §2: no starter fits a mobile app — the row starts near-empty and says so.
      seedSource: SEED_SOURCE_INITIALISED,
    });
    expect(getPreplanState).toHaveBeenCalledWith({
      coreWorkspaceId: fx.workspaceId,
      coreProjectId: fx.projectId,
    });
  });

  it('degrades to the default when the project never ran a pre-plan (`session: null`)', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(getPreplanState).mockResolvedValue(preplanWith(null));

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toMatchObject({ proposed: true });
    expect((await readSet(fx))[0]).toMatchObject({ role: 'web' });
  });

  it('degrades to the default when the motir-ai boundary FAILS — a transport error is not a blocker', async () => {
    const fx = await makeWorkItemFixture();
    vi.mocked(getPreplanState).mockRejectedValue(new Error('motir-ai unreachable'));

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toMatchObject({ proposed: true });
    const rows = await readSet(fx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'web', name: fx.project.slug });
  });

  it('writes TWO rows, in order, when the plan pins a separated frontend and backend', async () => {
    const fx = await makeWorkItemFixture();

    // Supplied explicitly through the seam MOTIR-1885 / MOTIR-1884 fill — a
    // proposal carries no repo role on `origin/main` yet, and this module does not
    // invent one from prose.
    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
      itemRoles: ['web', 'api'],
    });

    expect(result).toMatchObject({ proposed: true });
    const rows = await readSet(fx);
    expect(rows.map((r) => [r.role, r.name, r.seedSource, r.seedMatch])).toEqual([
      // MOTIR-709: each seed comes from the matching, with HOW it was chosen — a
      // web row with no target yet takes the role default, an api row with no
      // registered foundation falls back to `initialised`.
      ['web', `${fx.project.slug}-web`, SEED_SOURCE_PLATFORM_STARTER, 'no_target'],
      ['api', `${fx.project.slug}-api`, SEED_SOURCE_INITIALISED, 'no_match'],
    ]);
    expect(rows.every((r) => r.state === 'proposed')).toBe(true);
  });

  it('seeds a role from its registered foundation once the registry holds one (MOTIR-709)', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.seedRegistryEntry.create({
      data: {
        key: 'hono-api-starter',
        role: 'api',
        stack: 'hono',
        label: 'Hono API',
        templateOwner: 'motir-co',
        templateRepo: 'hono-api-starter',
        useCases: ['mvp'],
        sizes: ['small'],
        hostingTargets: [],
      },
    });
    try {
      await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
        itemRoles: ['web', 'api'],
      });
      expect((await readSet(fx)).map((r) => [r.seedSource, r.seedMatch])).toEqual([
        [SEED_SOURCE_PLATFORM_STARTER, 'no_target'],
        // No signal names a stack, so the result says so rather than `matched`.
        ['hono-api-starter', 'no_stack_signal'],
      ]);
    } finally {
      await adminDb.seedRegistryEntry.delete({ where: { key: 'hono-api-starter' } });
    }
  });
});

describe('projectRepoProposalService.proposeRepositorySet — IDEMPOTENCE', () => {
  it('running it TWICE produces ONE set', async () => {
    const fx = await makeWorkItemFixture();

    const first = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);
    const second = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(first).toMatchObject({ proposed: true });
    expect(second).toEqual({ proposed: false, reason: 'set_exists' });
    expect(await readSet(fx)).toHaveLength(1);
  });

  it('a row the user REMOVED stays removed', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
      itemRoles: ['web', 'api'],
    });
    const [, api] = await readSet(fx);
    await projectRepoSetService.removeRow(api!.id, fx.ctx);

    const again = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx, {
      itemRoles: ['web', 'api'],
    });

    // The user dropping a repository is a DECISION; re-deriving would overrule it.
    expect(again).toEqual({ proposed: false, reason: 'set_exists' });
    expect((await readSet(fx)).map((r) => r.role)).toEqual(['web']);
  });

  it('never touches a `created` row — a created repo is shipped reality', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'already-built' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    const repo = await connectRepo(fx.workspaceId, 'already-built');
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    const before = await readSet(fx);
    expect(before[0]!.state).toBe('created');

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'set_exists' });
    // Byte-identical: no rename, no re-seed, no extra row, and the association to
    // the real repository survives.
    expect(await readSet(fx)).toEqual(before);
  });

  it('never touches a `connected` row', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'brought-my-own' },
      fx.ctx,
    );
    const repo = await connectRepo(fx.workspaceId, 'brought-my-own');
    await projectRepoSetService.attachRealizedRepo(row.id, repo.id, fx.ctx);
    const before = await readSet(fx);
    expect(before[0]!.state).toBe('connected');

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'set_exists' });
    expect(await readSet(fx)).toEqual(before);
  });

  it('never touches a `skipped` row — the project is explicitly code-less for that role', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'api', name: 'no-thanks' },
      fx.ctx,
    );
    await projectRepoSetService.skipRow(row.id, fx.ctx);
    const before = await readSet(fx);
    expect(before[0]!.state).toBe('skipped');

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    // ADR §4.3: a skipped row is a settled decision, not a hole to re-fill — and
    // it is still a row, so the set is not empty and nothing is re-proposed.
    expect(result).toEqual({ proposed: false, reason: 'set_exists' });
    expect(await readSet(fx)).toEqual(before);
  });

  it('never touches a `failed` row — including its recorded failure reason', async () => {
    const fx = await makeWorkItemFixture();
    const row = await projectRepoSetService.addRow(
      fx.projectId,
      { role: 'web', name: 'name-was-taken' },
      fx.ctx,
    );
    await projectRepoSetService.markCreating(row.id, fx.ctx);
    await projectRepoSetService.markFailed(row.id, 'name already exists on the host', fx.ctx);
    const before = await readSet(fx);
    expect(before[0]).toMatchObject({
      state: 'failed',
      failureReason: 'name already exists on the host',
    });

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    // A failed row is RESUMABLE, not terminal (§4.1) — the user retries, connects
    // or skips it. Re-proposing over it would erase why it failed.
    expect(result).toEqual({ proposed: false, reason: 'set_exists' });
    expect(await readSet(fx)).toEqual(before);
  });

  it('does not call the motir-ai boundary at all when the set already exists', async () => {
    const fx = await makeWorkItemFixture();
    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);
    vi.mocked(getPreplanState).mockClear();

    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    // The emptiness guard runs FIRST, which is what keeps firing this on every
    // re-plan approve cheap.
    expect(getPreplanState).not.toHaveBeenCalled();
  });
});

describe('projectRepoProposalService.proposeRepositorySet — a project that ALREADY has code (MOTIR-3073)', () => {
  // The gate above this one answers "has this project's own set been proposed
  // before?". These prove the SECOND question the proposer has to ask — "does this
  // project have a codebase at all?" — which is the one that decides whether
  // proposing a repository makes any sense. They read identically for a project
  // born in Motir and diverge completely for one that ARRIVED with its code: the
  // migrate path records the connected repo on the onboarding run and never writes
  // the repo-set table, so before this gate such a project proposed a starter repo
  // on its first plan approval, took the canvas the approved plan's items belong
  // on, and made every real repo unpinnable (MOTIR-3073's three consequences).

  /** An onboarding run for the fixture's project, connected to `repoRef` or not. */
  async function seedOnboardingRun(
    fx: WorkItemFixture,
    connectedRepoRef: string | null,
  ): Promise<void> {
    await adminDb.migrateOnboarding.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        step: 'done',
        status: 'completed',
        connectedRepoRef,
        codeGraphReady: connectedRepoRef !== null,
      },
    });
  }

  it('proposes NOTHING for a migrated project — the question is already answered', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, 'acme/existing-app');

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'project_has_code' });
    // And the set stays EMPTY — the visible half of the defect was a row that
    // should never have existed, not merely a screen that should not have shown.
    expect(await readSet(fx)).toHaveLength(0);
  });

  it('does not call the motir-ai boundary for a project that already has code', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, 'acme/existing-app');
    vi.mocked(getPreplanState).mockClear();

    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    // Same reason the emptiness guard is cheap: this fires on every approve.
    expect(getPreplanState).not.toHaveBeenCalled();
  });

  it('STILL proposes when the onboarding run connected nothing — an unfinished run is not code', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, null);

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result.proposed).toBe(true);
    expect(await readSet(fx)).toHaveLength(1);
  });

  it('STILL proposes for a project with no onboarding run at all — the project this proposer is FOR', async () => {
    const fx = await makeWorkItemFixture();

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result.proposed).toBe(true);
  });

  it('STILL proposes for a SECOND project in a workspace whose code is already connected', async () => {
    // The false-negative this gate must not introduce, and the reason it reads the
    // ONBOARDING RUN rather than the installation mirror or the index ledger: both
    // of those are WORKSPACE-scoped, so gating on either would silence the proposer
    // for every project after the first in any workspace that has ever connected a
    // repo — and the second project in a workspace genuinely does need one.
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, 'acme/existing-app');
    await connectRepo(fx.workspaceId, 'existing-app');

    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIB',
    });
    const result = await projectRepoProposalService.proposeRepositorySet(sibling.id, fx.ctx);

    expect(result.proposed).toBe(true);
    expect(await projectRepoSetService.listByProject(sibling.id, fx.ctx)).toHaveLength(1);
  });

  it('leaves an EXISTING set alone even when the project also has code — set_exists still wins', async () => {
    // Ordering matters: `set_exists` is the access-gated guard and must answer
    // first, so a project that has code AND a deliberate set is reported as the
    // untouchable set it is, not as a project that was skipped for having code.
    const fx = await makeWorkItemFixture();
    await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);
    await seedOnboardingRun(fx, 'acme/existing-app');

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'set_exists' });
    expect(await readSet(fx)).toHaveLength(1);
  });
});

describe('projectRepoProposalService.proposeRepositorySet — races and failures', () => {
  it('stops without duplicating when a concurrent run wins the name', async () => {
    const fx = await makeWorkItemFixture();
    // The emptiness check is not in the same transaction as the writes — the
    // `(project_id, name)` unique index is the real arbiter, and its typed error
    // is a signal that someone else proposed first, not a failure to report.
    vi.spyOn(projectRepoSetService, 'addRow').mockRejectedValueOnce(
      new ProjectRepoNameTakenError(fx.project.slug, fx.projectId),
    );

    const result = await projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'raced' });
  });

  it('propagates any OTHER write failure — the caller decides what is best-effort', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(projectRepoSetService, 'addRow').mockRejectedValueOnce(
      new Error('database is on fire'),
    );

    await expect(
      projectRepoProposalService.proposeRepositorySet(fx.projectId, fx.ctx),
    ).rejects.toThrow('database is on fire');
  });

  it('proposes nothing when the project vanished under the read', async () => {
    const fx = await makeWorkItemFixture();
    // An empty set for a project that is no longer there: there is nothing to name
    // a repository after, so it must not fall back to a guessed stem.
    vi.spyOn(projectRepoSetService, 'listByProject').mockResolvedValueOnce([]);

    const result = await projectRepoProposalService.proposeRepositorySet('pj_gone', fx.ctx);

    expect(result).toEqual({ proposed: false, reason: 'no_project' });
  });
});
