import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  PROJECT_REPO_PROPOSAL_SIGNALS,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import type { ProjectRepoRole, ProjectRepoState } from '@/generated/prisma/client';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { resolveAuthoredTargetRepoInProject } from '@/lib/workItems/dispatchRepo';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { organizationIdOf } from '../../helpers/organizationOf';
import { linkProjectRepo } from '../../helpers/projectRepoLink';

// MOTIR-3078 — the `retire_spurious_project_repo_rows` forward data migration.
//
// `proposeRepositorySet`'s only gate used to be its own empty table, so a project
// that ARRIVED with its code (the migrate path records the repo on the onboarding
// run and never writes `project_repository`) read as set-less forever and got a
// starter repo proposed on its first plan approval. MOTIR-3073 shipped the
// `project_has_code` gate that refuses to write such a row; this migration deletes
// the ones the ungated lane already wrote — deliberately the exact COMPLEMENT of
// that gate, so the two can be read against each other.
//
// The predicate is where all the care is, in BOTH directions, and that is what
// this suite pins. Too broad and it destroys a real human decision (a `connected`
// row somebody attached, a `skipped` row that says this project wants no repo, a
// row a person added by hand). Too narrow — keyed on a WORKSPACE-scoped signal
// like "the installation has repositories" — and it stops discriminating the
// moment a workspace holds two projects. So every shape is seeded against real
// Postgres and asserted from both sides, the blast radius is a number rather than
// an assumption, and the migration's own SQL literals are asserted against the
// vocabulary they are a copy of.

const MIGRATION_DIR = 'prisma/migrations/20260819090000_retire_spurious_project_repo_rows';

const MIGRATION_SQL = readFileSync(join(process.cwd(), MIGRATION_DIR, 'migration.sql'), 'utf8');

/**
 * Apply the migration exactly as `migrate deploy` would. The file is a single
 * `DO $$ … $$` block, so it goes to the server whole — no statement splitting (a
 * `;` inside the block body would corrupt a split, and the `$$` delimiters make
 * comment-stripping unsafe). As the OWNER (MOTIR-2753): a `DO` block is
 * DDL-adjacent and the runtime role must never be able to run one.
 */
async function runMigration(): Promise<void> {
  await adminDb.$executeRawUnsafe(MIGRATION_SQL);
}

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "project_repository", "migrate_onboarding", "github_repo", "github_installation" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A migrate-onboarding run for `projectId`, connected to `repoRef` or not. */
async function seedOnboardingRun(
  fx: WorkItemFixture,
  projectId: string,
  connectedRepoRef: string | null,
): Promise<void> {
  await adminDb.migrateOnboarding.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId,
      step: 'done',
      status: 'completed',
      connectedRepoRef,
      codeGraphReady: connectedRepoRef !== null,
    },
  });
}

/** A repository connected to the WORKSPACE through an installation — the rung
 *  `resolveDomains` falls through to once the project has no set of its own. */
async function connectWorkspaceRepo(workspaceId: string, name: string) {
  const installationId = `inst-3078-${workspaceId}`;
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId },
    create: {
      installationId,
      workspaceId,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  return adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId,
      organizationId: await organizationIdOf(workspaceId),
      repoId: `${name}-3078`,
      owner: 'moooon-B-V',
      name,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
}

let seq = 0;

/**
 * A `project_repository` row, written straight through `adminDb` rather than
 * through `projectRepoSetService`: the service can only produce a row by walking
 * its own state machine, and several of the shapes this suite has to discriminate
 * (a user-authored row with a NULL signal, a row parked in `creating`) are states
 * the migration must judge on their persisted columns alone.
 */
async function seedRepoRow(
  fx: WorkItemFixture,
  projectId: string,
  over: {
    state?: ProjectRepoState;
    proposalSignal?: string | null;
    seedSource?: string;
    role?: ProjectRepoRole;
  } = {},
): Promise<string> {
  seq += 1;
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId,
      role: over.role ?? 'web',
      name: `repo-${seq}`,
      seedSource: over.seedSource ?? SEED_SOURCE_LEGACY_PLATFORM_STARTER,
      state: over.state ?? 'proposed',
      // `?? 'default-web'` would be wrong — an EXPLICIT null is a row a PERSON
      // added, which is precisely one of the shapes under test.
      proposalSignal: 'proposalSignal' in over ? over.proposalSignal! : 'default-web',
      position: `a${seq}`,
    },
  });
  return row.id;
}

const survives = async (id: string) =>
  (await adminDb.projectRepo.findUnique({ where: { id } })) !== null;

describe('retire_spurious_project_repo_rows — deletes exactly the rows the gate would have refused', () => {
  it('(a) deletes an auto-proposed row on a project that ALREADY has code', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const spurious = await seedRepoRow(fx, fx.projectId);

    await runMigration();

    expect(await survives(spurious)).toBe(false);
  });

  it('(b) keeps the same row on a project with NO code — the project this proposer is FOR', async () => {
    const fx = await makeWorkItemFixture();
    const legitimate = await seedRepoRow(fx, fx.projectId);

    await runMigration();

    expect(await survives(legitimate)).toBe(true);
  });

  it('(c) keeps a `connected` row on a project with code — somebody attached that repository', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const connected = await seedRepoRow(fx, fx.projectId, { state: 'connected' });

    await runMigration();

    expect(await survives(connected)).toBe(true);
  });

  it('(d) keeps a `skipped` row on a project with code — a deliberate "no repo for that role"', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const skipped = await seedRepoRow(fx, fx.projectId, { state: 'skipped' });

    await runMigration();

    expect(await survives(skipped)).toBe(true);
  });

  it('(e) keeps a row whose project ran onboarding but connected NOTHING — an unfinished run is not code', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, null);
    const legitimate = await seedRepoRow(fx, fx.projectId);

    await runMigration();

    expect(await survives(legitimate)).toBe(true);
  });

  it('deletes `creating`, `created` and `failed` rows too — the same spurious proposal, later in its life', async () => {
    // The card names `proposed` and `created`; the other two resolve the same way
    // and for the same reason. A `failed` row established nothing, so there is
    // nothing to preserve; a `creating` row is a `created` row caught mid-saga,
    // and leaving it parks a spurious row in a TRANSIENT state that resolves into
    // one this migration has already run past.
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const creating = await seedRepoRow(fx, fx.projectId, { state: 'creating' });
    const created = await seedRepoRow(fx, fx.projectId, { state: 'created' });
    const failed = await seedRepoRow(fx, fx.projectId, { state: 'failed' });

    await runMigration();

    expect([await survives(creating), await survives(created), await survives(failed)]).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('keeps a row a PERSON added — a null `proposal_signal` is not one of the proposer’s rungs', async () => {
    // `NULL IN (...)` is UNKNOWN, never TRUE, so this falls out of part 1 of the
    // predicate on its own. Asserted rather than left to be re-derived: it is the
    // whole mechanism separating an inference from a decision.
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const authored = await seedRepoRow(fx, fx.projectId, { proposalSignal: null });

    await runMigration();

    expect(await survives(authored)).toBe(true);
  });

  it('keeps a row whose `seed_source` is not a starter seed', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const imported = await seedRepoRow(fx, fx.projectId, { seedSource: 'imported-from-elsewhere' });

    await runMigration();

    expect(await survives(imported)).toBe(true);
  });

  it('takes every proposer rung, not just `default-web`', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const ids = await Promise.all(
      PROJECT_REPO_PROPOSAL_SIGNALS.map((signal) =>
        seedRepoRow(fx, fx.projectId, { proposalSignal: signal }),
      ),
    );

    await runMigration();

    expect(await Promise.all(ids.map(survives))).toEqual(ids.map(() => false));
  });

  it('takes an `initialised` non-web row as well as the platform starter', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const api = await seedRepoRow(fx, fx.projectId, {
      role: 'api',
      seedSource: SEED_SOURCE_INITIALISED,
      proposalSignal: 'plan-item-role',
    });

    await runMigration();

    expect(await survives(api)).toBe(false);
  });
});

describe('retire_spurious_project_repo_rows — the has-code signal is PROJECT-scoped', () => {
  it('a SIBLING project’s connected onboarding run does not expose this project’s row', async () => {
    // The correlation `mo.project_id = pr.project_id` is what makes this a
    // project-scoped predicate. An uncorrelated read — or one keyed on the
    // workspace-scoped installation mirror / index ledger — would delete the row
    // of every project after the first in any workspace that has ever connected
    // code, and the second project in a workspace genuinely does need a repo.
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');

    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIB',
    });
    const siblingRow = await seedRepoRow(fx, sibling.id);
    const ownRow = await seedRepoRow(fx, fx.projectId);

    await runMigration();

    expect(await survives(siblingRow)).toBe(true);
    expect(await survives(ownRow)).toBe(false);
  });
});

describe('retire_spurious_project_repo_rows — blast radius, idempotence, fresh databases', () => {
  it('reports the blast radius: exactly the matching rows go, and nothing else', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    for (let i = 0; i < 3; i += 1) await seedRepoRow(fx, fx.projectId);
    await seedRepoRow(fx, fx.projectId, { state: 'connected' });
    await seedRepoRow(fx, fx.projectId, { state: 'skipped' });
    await seedRepoRow(fx, fx.projectId, { proposalSignal: null });

    const before = await adminDb.projectRepo.count();
    expect(before).toBe(6);

    // A `DO` block returns no row count of its own, so assert the effect. (The
    // block RAISEs the same number as a NOTICE, which is what a release log shows
    // the operator.)
    await runMigration();

    expect(await adminDb.projectRepo.count()).toBe(3);
  });

  it('writes ZERO on a second apply — a deleted row cannot match its own predicate', async () => {
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    await seedRepoRow(fx, fx.projectId);
    const kept = await seedRepoRow(fx, fx.projectId, { state: 'connected' });

    await runMigration();
    const afterFirst = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: kept } });

    await runMigration();
    const afterSecond = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: kept } });

    expect(await adminDb.projectRepo.count()).toBe(1);
    // Idempotent means UNWRITTEN, not merely "same count": a re-write would bump
    // `updated_at` and churn every surface that orders on it.
    expect(afterSecond.updatedAt.toISOString()).toBe(afterFirst.updatedAt.toISOString());
  });

  it('no-ops on a database that never ran the ungated proposer (fresh / CI / preview)', async () => {
    await runMigration();
    expect(await adminDb.projectRepo.count()).toBe(0);
  });

  it('leaves the workspace-scoped `github_repo` mirror alone', async () => {
    // The row's `github_repo_id` reference goes away WITH the row; the
    // installation mirror is not this migration's business (and the GitHub-side
    // repository is a person's decision, named in the PR body).
    const fx = await makeWorkItemFixture();
    await seedOnboardingRun(fx, fx.projectId, 'acme/existing-app');
    const inst = await adminDb.githubInstallation.create({
      data: {
        installationId: 'inst-3078',
        workspaceId: fx.workspaceId,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    const repo = await adminDb.githubRepo.create({
      data: {
        installationId: inst.id,
        workspaceId: fx.workspaceId,
        organizationId: fx.workspace.organizationId,
        repoId: '930001',
        owner: 'motir-projects',
        name: 'motir',
        defaultBranch: 'main',
        archived: false,
        provider: 'github',
      },
    });
    const realized = await seedRepoRow(fx, fx.projectId, { state: 'created' });
    await adminDb.projectRepo.update({
      where: { id: realized },
      data: { githubRepoId: repo.id },
    });

    await runMigration();

    expect(await survives(realized)).toBe(false);
    expect(await adminDb.githubRepo.findUnique({ where: { id: repo.id } })).not.toBeNull();
  });
});

describe('retire_spurious_project_repo_rows — the SQL literals are a copy, and this is the guard', () => {
  /** The quoted members of the `IN ( … )` list following `column` in the DELETE. */
  function inListFor(column: string): string[] {
    const match = new RegExp(String.raw`pr\."${column}" IN \(([^)]*)\)`).exec(MIGRATION_SQL);
    if (!match) throw new Error(`no IN list for "${column}" in ${MIGRATION_DIR}/migration.sql`);
    return [...match[1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  }

  it('the `proposal_signal` list IS `PROJECT_REPO_PROPOSAL_SIGNALS`', async () => {
    // SQL cannot import the constant, so the migration copies it. A rung ADDED to
    // the ADR §0.1 ladder must fail here rather than silently narrow a shipped
    // predicate — and a rung REMOVED must fail here rather than silently widen it.
    expect(inListFor('proposal_signal').sort()).toEqual([...PROJECT_REPO_PROPOSAL_SIGNALS].sort());
  });

  it('the `seed_source` list IS the ADR §2 starter-seed pair', async () => {
    expect(inListFor('seed_source').sort()).toEqual(
      // The starter's key AS IT WAS when this migration shipped: a shipped
      // migration is history, and the rename (MOTIR-706 3.7) does not edit it.
      [SEED_SOURCE_LEGACY_PLATFORM_STARTER, SEED_SOURCE_INITIALISED].sort(),
    );
  });

  it('the `state` list excludes `connected` and `skipped` — the two human decisions', async () => {
    const states = inListFor('state');
    expect(states).not.toContain('connected');
    expect(states).not.toContain('skipped');
    expect(states.sort()).toEqual(['created', 'creating', 'failed', 'proposed']);
  });
});

describe('retire_spurious_project_repo_rows — the LIVE MOTIR row, and what removing it restores', () => {
  /**
   * The exact shape recorded on the live MOTIR project on 2026-08-19 (MOTIR-3078's
   * own evidence table), seeded field-for-field. The migration is written as a
   * GENERAL predicate rather than a cuid, so the row it was written for has to be
   * asserted like any other member of the class — not assumed to be covered
   * because it is the one that prompted the card.
   */
  async function seedLiveShape(fx: WorkItemFixture): Promise<string> {
    await seedOnboardingRun(fx, fx.projectId, 'moooon-B-V/motir-ai');
    seq += 1;
    const row = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'web',
        name: 'motir',
        seedSource: 'nextjs-prisma-vercel-starter',
        state: 'created',
        proposalSignal: 'default-web',
        position: `a${seq}`,
      },
    });
    return row.id;
  }

  it('takes the live MOTIR row — the general predicate covers the row it was written for', async () => {
    const fx = await makeWorkItemFixture();
    const live = await seedLiveShape(fx);

    await runMigration();

    expect(await survives(live)).toBe(false);
    expect(await projectRepoSetService.getRepoNameDomains(fx.projectId, fx.ctx)).toMatchObject({
      hasSet: false,
    });
  });

  it('leaves the real repositories PINNABLE — before the migration and after it', async () => {
    // AC 4's second half, proved as BEHAVIOUR rather than deduced.
    //
    // ⚠️ THE PRECONDITION MOVED, and MOTIR-3086 is why. This case used to open by
    // asserting that the stray row made `motir-core` UNPINNABLE — because the
    // scope ladder chose between two registries on `hasSet`, so the first row a
    // project ever gained did not join its repo list, it BECAME the list.
    // MOTIR-4955 retired the workspace fallback. The real repository is
    // explicitly linked, while the old onboarding proposal remains the row this
    // migration removes.
    const fx = await makeWorkItemFixture();
    const repo = await connectWorkspaceRepo(fx.workspaceId, 'motir-core');
    await linkProjectRepo({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      githubRepoId: repo.id,
      name: repo.name,
    });
    const live = await seedLiveShape(fx);

    // BEFORE: pinnable already — the stray row no longer costs the project its
    // own code (MOTIR-3086).
    await expect(
      resolveAuthoredTargetRepoInProject('motir-core', fx.projectId, fx.ctx),
    ).resolves.toBe('motir-core');

    await runMigration();

    // AFTER: the row is gone — the migration's actual subject — and the
    // repository is still nameable through its surviving explicit link.
    expect(await survives(live)).toBe(false);
    await expect(
      resolveAuthoredTargetRepoInProject('motir-core', fx.projectId, fx.ctx),
    ).resolves.toBe('motir-core');
  });
});
