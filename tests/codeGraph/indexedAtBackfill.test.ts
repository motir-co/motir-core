import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';

// Bug MOTIR-10171 — the `github_repo.indexed_at` BACKFILL.
//
// Every index state now reads whether a graph exists off the row's `indexed_at`
// (`hasBuiltGraph`) instead of off the succeeded-index ledger. A row the old
// settle never stamped — an index that succeeded before any push recorded a head
// — has a real graph and a null `indexed_at`, and would read `never` after the
// switch. The migration stamps it from the ledger.
//
// ⚠️ The UPDATE is READ FROM THE MIGRATION and executed verbatim. A test that
// retyped it would pass while the shipped SQL drifted away.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261101010000_backfill_github_repo_indexed_at/migration.sql',
);

function backfillStatement(): string {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  expect(statements, 'the migration is one UPDATE').toHaveLength(1);
  expect(statements[0]).toMatch(/^UPDATE "github_repo"/);
  return statements[0]!;
}

const runBackfill = () => adminDb.$executeRawUnsafe(backfillStatement());

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedRepo(
  owner: WorkItemFixture,
  name: string,
  opts: { indexedAt?: Date | null } = {},
): Promise<string> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${name}-${Math.random().toString(36).slice(2)}`,
      workspaceId: owner.workspaceId,
      organizationId: owner.workspace.organizationId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: owner.workspaceId,
      organizationId: owner.workspace.organizationId,
      repoId: `r-${name}-${Math.random().toString(36).slice(2)}`,
      owner: 'moooon',
      name,
      defaultBranch: 'main',
      provider: 'github',
      archived: false,
      indexedAt: opts.indexedAt ?? null,
    },
  });
  return repo.id;
}

function seedRun(
  workspaceId: string,
  opts: {
    status?: 'succeeded' | 'failed';
    functionId?: string;
    output?: Prisma.InputJsonObject;
    finishedAt?: Date | null;
  },
) {
  return adminDb.jobRun.create({
    data: {
      workspaceId,
      functionId: opts.functionId ?? 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      lane: 'engine',
      attempt: 0,
      status: opts.status ?? 'succeeded',
      finishedAt: opts.finishedAt ?? null,
      ...(opts.output ? { output: opts.output } : {}),
    },
  });
}

const indexedAtOf = async (id: string) =>
  (await adminDb.githubRepo.findUniqueOrThrow({ where: { id } })).indexedAt;

describe('the indexed_at backfill', () => {
  it('stamps an unstamped row with the finish time of its NEWEST succeeded index run', async () => {
    const id = await seedRepo(fx, 'web');
    await seedRun(fx.workspaceId, {
      output: { indexed: true, repoRef: 'moooon/web' },
      finishedAt: new Date('2026-10-20T08:00:00Z'),
    });
    await seedRun(fx.workspaceId, {
      output: { indexed: true, repoRef: 'moooon/web' },
      finishedAt: new Date('2026-10-27T08:00:00Z'),
    });

    await runBackfill();
    expect(await indexedAtOf(id)).toEqual(new Date('2026-10-27T08:00:00Z'));
  });

  it('leaves an already stamped row alone, and a re-run changes nothing', async () => {
    const stamped = new Date('2026-10-31T09:11:00Z');
    const id = await seedRepo(fx, 'web', { indexedAt: stamped });
    await seedRun(fx.workspaceId, {
      output: { indexed: true, repoRef: 'moooon/web' },
      finishedAt: new Date('2026-10-01T00:00:00Z'),
    });

    expect(await runBackfill()).toBe(0);
    expect(await indexedAtOf(id)).toEqual(stamped);
  });

  it('stamps nothing from a run that did not index it', async () => {
    const id = await seedRepo(fx, 'web');
    // A failed run, a refresh, a success that indexed NOTHING, and another repo's run.
    await seedRun(fx.workspaceId, { status: 'failed', output: { repoRef: 'moooon/web' } });
    await seedRun(fx.workspaceId, {
      functionId: 'system.code-graph-refresh',
      output: { repoRef: 'moooon/web' },
      finishedAt: new Date(),
    });
    await seedRun(fx.workspaceId, { output: { indexed: false, reason: 'no projects' } });
    await seedRun(fx.workspaceId, { output: { indexed: true, repoRef: 'moooon/other' } });

    await runBackfill();
    expect(await indexedAtOf(id)).toBeNull();
  });

  it("⚠️ matches on the ORGANISATION — another tenant's run for the same ref stamps nothing (MOTIR-9177)", async () => {
    const other = await makeWorkItemFixture();
    const mine = await seedRepo(fx, 'web');
    const theirs = await seedRepo(other, 'web');
    await seedRun(other.workspaceId, {
      output: { indexed: true, repoRef: 'moooon/web' },
      finishedAt: new Date('2026-10-27T08:00:00Z'),
    });

    await runBackfill();
    expect(await indexedAtOf(mine)).toBeNull();
    expect(await indexedAtOf(theirs)).toEqual(new Date('2026-10-27T08:00:00Z'));
  });

  it('falls back to the start time for a succeeded run with no finish time', async () => {
    const id = await seedRepo(fx, 'web');
    const run = await seedRun(fx.workspaceId, {
      output: { indexed: true, repoRef: 'moooon/web' },
      finishedAt: null,
    });

    await runBackfill();
    expect(await indexedAtOf(id)).toEqual(run.startedAt);
  });
});
