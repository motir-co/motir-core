// MOTIR-9962 — resolveEnvironment against real Postgres: exactly one repository's
// entries for one environment, secrets decrypted in memory only, the flag seam,
// the customer-repository refusal, and the runtime role under row-level security.
import type { DeployReleaseInput } from '@motir/orchestrator';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { AppEnvironment } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ENVIRONMENT_CONFIG_KEY_ENV,
  environmentConfigCrypto,
} from '@/lib/environmentConfig/crypto';
import {
  CustomerRepositoryEnvironmentError,
  EnvironmentRepositoryNotFoundError,
  EnvironmentSecretUndecryptableError,
} from '@/lib/environmentConfig/errors';
import type { EnvironmentFlagSource } from '@/lib/environmentConfig/flagSource';
import { resolveEnvironment } from '@/lib/environmentConfig/resolveEnvironment';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { environmentConfigEntryRepository } from '@/lib/repositories/environmentConfigEntryRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { TEST_APP_ROLE } from '../helpers/parallelDb';

const KEY = 'e'.repeat(64);
const saved = {
  own: process.env[ENVIRONMENT_CONFIG_KEY_ENV],
  github: process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  await truncateAuthTables();
  process.env[ENVIRONMENT_CONFIG_KEY_ENV] = KEY;
});

afterEach(() => {
  restore(ENVIRONMENT_CONFIG_KEY_ENV, saved.own);
  restore('GITHUB_TOKEN_ENCRYPTION_KEY', saved.github);
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;

async function addRepo(fx: Fixture, name: string) {
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  return row.id;
}

async function put(
  fx: Fixture,
  repoId: string,
  environment: AppEnvironment,
  name: string,
  value: string,
  isSecret = false,
) {
  await withWorkspaceContext(fx.ctx, (tx) =>
    environmentConfigEntryRepository.upsert(tx, {
      workspaceId: fx.workspaceId,
      projectRepositoryId: repoId,
      environment,
      name,
      isSecret,
      value: isSecret ? environmentConfigCrypto.encryptToken(value) : value,
    }),
  );
}

describe('resolveEnvironment', () => {
  it('returns exactly the requested environment, secrets decrypted, sorted by name', async () => {
    const fx = await makeWorkItemFixture();
    const repoId = await addRepo(fx, 'app');
    await put(fx, repoId, 'production', 'ZETA', 'prod-zeta');
    await put(fx, repoId, 'production', 'API_KEY', 'prod-secret', true);
    await put(fx, repoId, 'preview', 'ZETA', 'preview-zeta');
    await put(fx, repoId, 'preview', 'API_KEY', 'preview-secret', true);

    const opts = { workspaceId: fx.workspaceId };
    expect(await resolveEnvironment(repoId, 'production', opts)).toEqual([
      { name: 'API_KEY', value: 'prod-secret', secret: true },
      { name: 'ZETA', value: 'prod-zeta', secret: false },
    ]);
    expect(await resolveEnvironment(repoId, 'preview', opts)).toEqual([
      { name: 'API_KEY', value: 'preview-secret', secret: true },
      { name: 'ZETA', value: 'preview-zeta', secret: false },
    ]);
    expect(await resolveEnvironment(repoId, 'release', opts)).toEqual([]);
  });

  it('never returns another repository’s values; a repository with no entries is []', async () => {
    const fx = await makeWorkItemFixture();
    const a = await addRepo(fx, 'a');
    const b = await addRepo(fx, 'b');
    const empty = await addRepo(fx, 'c');
    await put(fx, a, 'production', 'SHARED', 'from-a');
    await put(fx, a, 'production', 'TOKEN', 'secret-a', true);
    await put(fx, b, 'production', 'SHARED', 'from-b');
    await put(fx, b, 'production', 'TOKEN', 'secret-b', true);

    const opts = { workspaceId: fx.workspaceId };
    expect(await resolveEnvironment(a, 'production', opts)).toEqual([
      { name: 'SHARED', value: 'from-a', secret: false },
      { name: 'TOKEN', value: 'secret-a', secret: true },
    ]);
    expect(await resolveEnvironment(b, 'production', opts)).toEqual([
      { name: 'SHARED', value: 'from-b', secret: false },
      { name: 'TOKEN', value: 'secret-b', secret: true },
    ]);
    expect(await resolveEnvironment(empty, 'production', opts)).toEqual([]);
  });

  it('refuses a customer repository before reading any entry, and an unknown id', async () => {
    const fx = await makeWorkItemFixture();
    const repoId = await addRepo(fx, 'customer');
    await put(fx, repoId, 'production', 'PLAIN', 'x');
    await adminDb.projectRepo.update({
      where: { id: repoId },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });
    const list = vi.spyOn(environmentConfigEntryRepository, 'listByRepositoryAndEnvironment');

    await expect(
      resolveEnvironment(repoId, 'production', { workspaceId: fx.workspaceId }),
    ).rejects.toBeInstanceOf(CustomerRepositoryEnvironmentError);
    expect(list).not.toHaveBeenCalled();

    await expect(
      resolveEnvironment('no-such-repository', 'production', { workspaceId: fx.workspaceId }),
    ).rejects.toBeInstanceOf(EnvironmentRepositoryNotFoundError);
  });

  it('merges non-secret flag values; a stored entry wins over a flag of the same name', async () => {
    const fx = await makeWorkItemFixture();
    const repoId = await addRepo(fx, 'app');
    await put(fx, repoId, 'production', 'MODE', 'stored');
    const flagSource: EnvironmentFlagSource = {
      async listFlagValues() {
        return [
          { name: 'FLAG_X', value: 'on' },
          { name: 'MODE', value: 'from-flag' },
        ];
      },
    };

    expect(
      await resolveEnvironment(repoId, 'production', { workspaceId: fx.workspaceId, flagSource }),
    ).toEqual([
      { name: 'FLAG_X', value: 'on', secret: false },
      { name: 'MODE', value: 'stored', secret: false },
    ]);
    expect(await resolveEnvironment(repoId, 'production', { workspaceId: fx.workspaceId })).toEqual(
      [{ name: 'MODE', value: 'stored', secret: false }],
    );
  });

  it('decrypts only in memory, and names a corrupt secret without leaking it', async () => {
    const fx = await makeWorkItemFixture();
    const repoId = await addRepo(fx, 'app');
    await put(fx, repoId, 'production', 'API_KEY', 'plain-secret-value', true);
    const before = await adminDb.environmentConfigEntry.findMany({ orderBy: { name: 'asc' } });

    await resolveEnvironment(repoId, 'production', { workspaceId: fx.workspaceId });
    const after = await adminDb.environmentConfigEntry.findMany({ orderBy: { name: 'asc' } });
    expect(after).toEqual(before);
    expect(after[0]!.value.startsWith('v1.')).toBe(true);

    // Corrupt the ciphertext: flip its auth tag.
    const [v, iv, , ct] = after[0]!.value.split('.');
    const corrupt = [v, iv, Buffer.alloc(16).toString('base64url'), ct].join('.');
    await adminDb.environmentConfigEntry.update({
      where: { id: after[0]!.id },
      data: { value: corrupt },
    });
    const err = await resolveEnvironment(repoId, 'production', {
      workspaceId: fx.workspaceId,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentSecretUndecryptableError);
    const e = err as EnvironmentSecretUndecryptableError;
    expect(e.entryName).toBe('API_KEY');
    expect(e.message).toContain('API_KEY');
    for (const text of [e.message, e.name, String(e), JSON.stringify(e)]) {
      expect(text).not.toContain(corrupt);
      expect(text).not.toContain(ct!);
      expect(text).not.toContain('plain-secret-value');
    }
  });

  it('with only the GitHub key set, a secret raises the key error and plain entries resolve', async () => {
    const fx = await makeWorkItemFixture();
    const withSecret = await addRepo(fx, 'secret');
    await put(fx, withSecret, 'production', 'API_KEY', 'value', true);
    await put(fx, withSecret, 'preview', 'PLAIN', 'ok');
    delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = KEY;

    await expect(
      resolveEnvironment(withSecret, 'production', { workspaceId: fx.workspaceId }),
    ).rejects.toThrow(/ENVIRONMENT_CONFIG_ENCRYPTION_KEY/);
    expect(
      await resolveEnvironment(withSecret, 'preview', { workspaceId: fx.workspaceId }),
    ).toEqual([{ name: 'PLAIN', value: 'ok', secret: false }]);
  });

  it('as motir_app, binds to the given workspace and refuses another workspace’s repository', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const repoId = await addRepo(fx, 'app');
    await put(fx, repoId, 'production', 'PLAIN', 'mine');

    // `@/lib/db` connects as the runtime role here; an unbound read would see zero
    // rows, so a hit proves the bind, and every read is handed the bound tx.
    const [who] = await db.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    expect(who?.role).toBe(TEST_APP_ROLE);
    const findById = vi.spyOn(projectRepoRepository, 'findById');
    const list = vi.spyOn(environmentConfigEntryRepository, 'listByRepositoryAndEnvironment');
    expect(await resolveEnvironment(repoId, 'production', { workspaceId: fx.workspaceId })).toEqual(
      [{ name: 'PLAIN', value: 'mine', secret: false }],
    );
    expect(findById.mock.calls[0]![2]).toBeDefined();
    expect(list.mock.calls[0]![2]).toBeDefined();
    await expect(
      resolveEnvironment(repoId, 'production', { workspaceId: other.workspaceId }),
    ).rejects.toBeInstanceOf(EnvironmentRepositoryNotFoundError);
  });

  it('returns the deploy port’s env shape', () => {
    expectTypeOf<Awaited<ReturnType<typeof resolveEnvironment>>>().toMatchTypeOf<
      DeployReleaseInput['env']
    >();
  });
});
