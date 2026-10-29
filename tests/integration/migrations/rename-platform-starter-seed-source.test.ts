import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_LEGACY_PLATFORM_STARTER,
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-708 — the platform starter's RENAME, as data (decision MOTIR-706 v2, 3.7
// step 2): every stored `nextjs-prisma-vercel-starter` becomes
// `nextjs-prisma-serverless-starter`, and nothing else moves. Re-applied here as
// the owner, exactly as `migrate deploy` runs it, against rows of every shape.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261028200100_rename_platform_starter_seed_source/migration.sql',
  ),
  'utf8',
);

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function row(seedSource: string) {
  seq += 1;
  return adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: `repo-${seq}`,
      seedSource,
      state: 'created',
      position: `a${seq}`,
    },
  });
}

const stored = (id: string) => adminDb.projectRepo.findUniqueOrThrow({ where: { id } });

describe('rename_platform_starter_seed_source', () => {
  it('rewrites the old key and touches no other column', async () => {
    const before = await row(SEED_SOURCE_LEGACY_PLATFORM_STARTER);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    const after = await stored(before.id);
    expect(after).toEqual({ ...before, seedSource: SEED_SOURCE_PLATFORM_STARTER });
  });

  it('leaves every other seed source alone', async () => {
    const rows = await Promise.all(
      [SEED_SOURCE_INITIALISED, SEED_SOURCE_ORGANIZATION, SEED_SOURCE_PLATFORM_STARTER].map(row),
    );
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    for (const r of rows) expect(await stored(r.id)).toEqual(r);
  });

  it('is idempotent — a second run finds nothing to change', async () => {
    const r = await row(SEED_SOURCE_LEGACY_PLATFORM_STARTER);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    const once = await stored(r.id);
    await adminDb.$executeRawUnsafe(MIGRATION_SQL);
    expect(await stored(r.id)).toEqual(once);
    expect(
      await adminDb.projectRepo.count({
        where: { seedSource: SEED_SOURCE_LEGACY_PLATFORM_STARTER },
      }),
    ).toBe(0);
  });
});
