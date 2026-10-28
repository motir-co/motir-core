// MOTIR-9960 — the stored shape of a Motir repository's environment
// configuration, against real Postgres: the unique key, the cascade, the
// database's own refusals, row-level security and the secret-at-rest invariant.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Prisma, type AppEnvironment } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ENVIRONMENT_CONFIG_KEY_ENV,
  environmentConfigCrypto,
} from '@/lib/environmentConfig/crypto';
import { ENVIRONMENTS } from '@/lib/environmentConfig/vocabulary';
import { environmentConfigChangeRepository } from '@/lib/repositories/environmentConfigChangeRepository';
import { environmentConfigEntryRepository } from '@/lib/repositories/environmentConfigEntryRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { RLS_DENIAL, isRlsDenial, isSqlState } from '../helpers/sqlstate';

const isCheckViolation = isSqlState('23514');
const isUniqueViolation = isSqlState('23505');
const savedKey = process.env[ENVIRONMENT_CONFIG_KEY_ENV];

beforeEach(async () => {
  await truncateAuthTables();
  process.env[ENVIRONMENT_CONFIG_KEY_ENV] = 'c'.repeat(64);
});

afterEach(() => {
  if (savedKey === undefined) delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
  else process.env[ENVIRONMENT_CONFIG_KEY_ENV] = savedKey;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function repoRow(identifier = 'ACME') {
  const fx = await makeWorkItemFixture({ name: identifier, identifier });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'app' },
    fx.ctx,
  );
  return {
    workspaceId: fx.workspaceId,
    projectRepositoryId: row.id,
    userId: fx.ownerId,
    ctx: fx.ctx,
  };
}

/** A transaction bound to the repository's workspace, as every caller holds one. */
function inWorkspace<T>(
  r: { ctx: WorkspaceContext },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return withWorkspaceContext(r.ctx, fn);
}

function entry(
  r: { workspaceId: string; projectRepositoryId: string },
  over: Partial<{
    environment: AppEnvironment;
    name: string;
    isSecret: boolean;
    value: string;
  }> = {},
) {
  return {
    workspaceId: r.workspaceId,
    projectRepositoryId: r.projectRepositoryId,
    environment: 'production' as AppEnvironment,
    name: 'GREETING',
    isSecret: false,
    value: 'hello-prod',
    ...over,
  };
}

/** Run as the runtime role, which row-level security binds — the test
 *  connection is a superuser and bypasses it. */
async function asAppRole<T>(
  workspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('environmentConfigEntryRepository', () => {
  it('creates, lists, finds, replaces and deletes an entry', async () => {
    const r = await repoRow();
    await inWorkspace(r, (tx) => environmentConfigEntryRepository.upsert(tx, entry(r)));
    await inWorkspace(r, (tx) =>
      environmentConfigEntryRepository.upsert(tx, entry(r, { name: 'API_KEY', value: 'k' })),
    );

    const listed = await inWorkspace(r, (tx) =>
      environmentConfigEntryRepository.listByRepositoryAndEnvironment(
        r.projectRepositoryId,
        'production',
        tx,
      ),
    );
    expect(listed.map((e) => e.name)).toEqual(['API_KEY', 'GREETING']);
    expect(
      await inWorkspace(r, (tx) =>
        environmentConfigEntryRepository.listByRepositoryAndEnvironment(
          r.projectRepositoryId,
          'preview',
          tx,
        ),
      ),
    ).toEqual([]);

    const replaced = await inWorkspace(r, (tx) =>
      environmentConfigEntryRepository.upsert(tx, entry(r, { value: 'hi-again' })),
    );
    const found = await inWorkspace(r, (tx) =>
      environmentConfigEntryRepository.findByName(
        { projectRepositoryId: r.projectRepositoryId, environment: 'production', name: 'GREETING' },
        tx,
      ),
    );
    expect(found?.id).toBe(replaced.id);
    expect(found?.value).toBe('hi-again');

    const key = { projectRepositoryId: r.projectRepositoryId, environment: 'production' as const };
    expect(
      await inWorkspace(r, (tx) =>
        environmentConfigEntryRepository.deleteByName(tx, { ...key, name: 'GREETING' }),
      ),
    ).toBe(1);
    expect(
      await inWorkspace(r, (tx) =>
        environmentConfigEntryRepository.deleteByName(tx, { ...key, name: 'GREETING' }),
      ),
    ).toBe(0);
  });

  it('holds one row per (repository, environment, name) and the same name per environment', async () => {
    const r = await repoRow();
    for (const environment of ENVIRONMENTS) {
      await adminDb.environmentConfigEntry.create({ data: entry(r, { environment }) });
    }
    await expect(adminDb.environmentConfigEntry.create({ data: entry(r) })).rejects.toSatisfy(
      isUniqueViolation,
    );
    expect(await adminDb.environmentConfigEntry.count()).toBe(3);
  });

  it('deletes a repository’s entries and changes with the repository', async () => {
    const r = await repoRow();
    await adminDb.environmentConfigEntry.create({ data: entry(r) });
    await inWorkspace(r, (tx) =>
      environmentConfigChangeRepository.create(tx, {
        workspaceId: r.workspaceId,
        projectRepositoryId: r.projectRepositoryId,
        environment: 'production',
        name: 'GREETING',
        action: 'added',
        isSecret: false,
        actorId: r.userId,
      }),
    );
    await adminDb.projectRepo.delete({ where: { id: r.projectRepositoryId } });
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
    expect(await adminDb.environmentConfigChange.count()).toBe(0);
  });

  it('refuses PORT, DATABASE_URL and MOTIR_* in every environment', async () => {
    const r = await repoRow();
    for (const environment of ENVIRONMENTS) {
      for (const name of ['PORT', 'DATABASE_URL', 'MOTIR_TOKEN']) {
        await expect(
          adminDb.environmentConfigEntry.create({ data: entry(r, { environment, name }) }),
        ).rejects.toSatisfy(isCheckViolation, `${environment}/${name} must be refused`);
      }
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
  });

  it('stores a secret only as ciphertext, and refuses a secret that is not', async () => {
    const r = await repoRow();
    const sealed = environmentConfigCrypto.encryptToken('sk-live-123');
    await inWorkspace(r, (tx) =>
      environmentConfigEntryRepository.upsert(
        tx,
        entry(r, { name: 'API_KEY', isSecret: true, value: sealed }),
      ),
    );
    const [raw] = await adminDb.$queryRaw<{ value: string }[]>`
      SELECT "value" FROM "environment_config_entry" WHERE "name" = 'API_KEY'`;
    expect(raw!.value.startsWith('v1.')).toBe(true);
    expect(raw!.value).not.toContain('sk-live-123');
    expect(environmentConfigCrypto.decryptToken(raw!.value)).toBe('sk-live-123');

    await expect(
      adminDb.environmentConfigEntry.create({
        data: entry(r, { name: 'OTHER', isSecret: true, value: 'sk-live-123' }),
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });
});

describe('environmentConfigChangeRepository', () => {
  it('lists the newest changes first, per environment, and has no update or delete', async () => {
    const r = await repoRow();
    for (const [name, action] of [
      ['GREETING', 'added'],
      ['GREETING', 'replaced'],
      ['API_KEY', 'added'],
    ] as const) {
      await inWorkspace(r, (tx) =>
        environmentConfigChangeRepository.create(tx, {
          workspaceId: r.workspaceId,
          projectRepositoryId: r.projectRepositoryId,
          environment: 'production',
          name,
          action,
          isSecret: name === 'API_KEY',
          actorId: r.userId,
        }),
      );
    }
    const recent = await inWorkspace(r, (tx) =>
      environmentConfigChangeRepository.listRecent(r.projectRepositoryId, 'production', 2, tx),
    );
    expect(recent.map((c) => [c.name, c.action])).toEqual([
      ['API_KEY', 'added'],
      ['GREETING', 'replaced'],
    ]);
    expect(
      await inWorkspace(r, (tx) =>
        environmentConfigChangeRepository.listRecent(r.projectRepositoryId, 'preview', 10, tx),
      ),
    ).toEqual([]);
    expect(Object.keys(environmentConfigChangeRepository).sort()).toEqual(['create', 'listRecent']);
  });

  it('has no value column', async () => {
    const columns = await adminDb.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'environment_config_change'`;
    expect(columns.map((c) => c.column_name)).not.toContain('value');
  });
});

describe('row-level security on both tables', () => {
  it('another workspace reads no row and cannot insert one', async () => {
    const mine = await repoRow('ACME');
    const other = await repoRow('OTHR');
    await adminDb.environmentConfigEntry.create({ data: entry(mine) });
    const change = {
      workspaceId: mine.workspaceId,
      projectRepositoryId: mine.projectRepositoryId,
      environment: 'production' as const,
      name: 'GREETING',
      action: 'added' as const,
      isSecret: false,
      actorId: mine.userId,
    };
    await adminDb.environmentConfigChange.create({ data: change });

    const seen = await asAppRole(other.workspaceId, async (tx) => ({
      entries: await tx.environmentConfigEntry.findMany(),
      changes: await tx.environmentConfigChange.findMany(),
    }));
    expect(seen).toEqual({ entries: [], changes: [] });

    await expect(
      asAppRole(other.workspaceId, (tx) =>
        tx.environmentConfigEntry.create({ data: entry(mine, { name: 'SNEAKY' }) }),
      ),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);
    await expect(
      asAppRole(other.workspaceId, (tx) => tx.environmentConfigChange.create({ data: change })),
    ).rejects.toSatisfy(isRlsDenial, RLS_DENIAL);

    // …while the owning workspace sees its own rows.
    const own = await asAppRole(mine.workspaceId, (tx) => tx.environmentConfigEntry.findMany());
    expect(own).toHaveLength(1);
  });

  it('both tables enable and force row-level security', async () => {
    const rows = await adminDb.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('environment_config_entry', 'environment_config_change')
       ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'environment_config_change', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'environment_config_entry', relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });
});
