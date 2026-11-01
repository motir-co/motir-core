// MOTIR-9961 — the environment-configuration service against real Postgres: who
// may write, the customer-repository refusal, secrets that never leave, the
// reserved names, one change record and one event per change, and the race.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppEnvironment } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ENVIRONMENT_CONFIG_KEY_ENV,
  environmentConfigCrypto,
} from '@/lib/environmentConfig/crypto';
import {
  CustomerRepositoryError,
  EnvironmentConfigForbiddenError,
  EnvironmentEntryNotFoundError,
  InvalidEnvironmentNameError,
  ReservedEnvironmentNameError,
} from '@/lib/environmentConfig/errors';
import { ENVIRONMENTS } from '@/lib/environmentConfig/vocabulary';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import { environmentConfigService } from '@/lib/services/environmentConfigService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';

const SECRET = 'sk-live-very-secret-4242';
const savedKey = process.env[ENVIRONMENT_CONFIG_KEY_ENV];
let dispatch: ReturnType<typeof spyOnJobDispatch>;

beforeEach(async () => {
  await truncateAuthTables();
  process.env[ENVIRONMENT_CONFIG_KEY_ENV] = 'd'.repeat(64);
  dispatch = spyOnJobDispatch();
});

afterEach(() => {
  dispatch.mockRestore();
  if (savedKey === undefined) delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
  else process.env[ENVIRONMENT_CONFIG_KEY_ENV] = savedKey;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function setup() {
  const fx = await makeWorkItemFixture();
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'app' },
    fx.ctx,
  );
  const member = await createTestUser();
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  const memberCtx = { userId: member.id, workspaceId: fx.workspaceId };
  return { admin: fx.ctx, memberCtx, repoId: row.id, workspaceId: fx.workspaceId };
}

function configEvents() {
  return dispatchedEvents(dispatch).filter((e) => e.name === 'environment.config.changed');
}

const storedRows = () => adminDb.environmentConfigEntry.findMany({ orderBy: { name: 'asc' } });
const changeRows = () =>
  adminDb.environmentConfigChange.findMany({ orderBy: { createdAt: 'asc' } });

describe('set, replace, delete and list as an administrator', () => {
  it.each(ENVIRONMENTS)('adds, replaces and deletes in %s', async (environment) => {
    const { admin, repoId } = await setup();
    const added = await environmentConfigService.set(
      repoId,
      environment,
      { name: 'GREETING', value: 'hello', isSecret: false },
      admin,
    );
    expect(added.outcome).toBe('created');
    expect(added.entry).toMatchObject({ name: 'GREETING', isSecret: false, value: 'hello' });

    const replaced = await environmentConfigService.set(
      repoId,
      environment,
      { name: 'GREETING', value: 'hello-again', isSecret: false },
      admin,
    );
    expect(replaced.outcome).toBe('replaced');
    expect(await storedRows()).toHaveLength(1);
    expect((await storedRows())[0]!.value).toBe('hello-again');

    await environmentConfigService.delete(repoId, environment, 'GREETING', admin);
    expect(await storedRows()).toEqual([]);
    await expect(
      environmentConfigService.delete(repoId, environment, 'GREETING', admin),
    ).rejects.toBeInstanceOf(EnvironmentEntryNotFoundError);
  });

  it('lists exactly that repository and environment', async () => {
    const { admin, repoId } = await setup();
    await environmentConfigService.set(
      repoId,
      'production',
      { name: 'A', value: '1', isSecret: false },
      admin,
    );
    await environmentConfigService.set(
      repoId,
      'preview',
      { name: 'B', value: '2', isSecret: false },
      admin,
    );
    const production = await environmentConfigService.list(repoId, 'production', admin);
    expect(production.map((e) => e.name)).toEqual(['A']);
    expect(
      (await environmentConfigService.list(repoId, 'preview', admin)).map((e) => e.name),
    ).toEqual(['B']);
    expect(await environmentConfigService.list(repoId, 'release', admin)).toEqual([]);
  });
});

describe('who may write', () => {
  it('refuses a member set and delete, stores nothing, and lets them list', async () => {
    const { admin, memberCtx, repoId } = await setup();
    await environmentConfigService.set(
      repoId,
      'production',
      { name: 'A', value: '1', isSecret: false },
      admin,
    );
    dispatch.mockClear();
    const before = await changeRows();

    await expect(
      environmentConfigService.set(
        repoId,
        'production',
        { name: 'B', value: '2', isSecret: false },
        memberCtx,
      ),
    ).rejects.toBeInstanceOf(EnvironmentConfigForbiddenError);
    await expect(
      environmentConfigService.delete(repoId, 'production', 'A', memberCtx),
    ).rejects.toBeInstanceOf(EnvironmentConfigForbiddenError);

    expect((await storedRows()).map((r) => r.name)).toEqual(['A']);
    expect(await changeRows()).toHaveLength(before.length);
    expect(configEvents()).toEqual([]);
    expect(
      (await environmentConfigService.list(repoId, 'production', memberCtx)).map((e) => e.name),
    ).toEqual(['A']);
    expect(
      await environmentConfigService.listChanges(repoId, 'production', memberCtx),
    ).toHaveLength(1);
  });
});

describe('a customer repository', () => {
  it('refuses set, delete, list and listChanges and records nothing', async () => {
    const { admin, repoId } = await setup();
    await adminDb.projectRepo.update({
      where: { id: repoId },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });

    await expect(
      environmentConfigService.set(
        repoId,
        'production',
        { name: 'A', value: '1', isSecret: false },
        admin,
      ),
    ).rejects.toBeInstanceOf(CustomerRepositoryError);
    await expect(
      environmentConfigService.delete(repoId, 'production', 'A', admin),
    ).rejects.toBeInstanceOf(CustomerRepositoryError);
    await expect(environmentConfigService.list(repoId, 'production', admin)).rejects.toBeInstanceOf(
      CustomerRepositoryError,
    );
    await expect(
      environmentConfigService.listChanges(repoId, 'production', admin),
    ).rejects.toBeInstanceOf(CustomerRepositoryError);
    expect(await storedRows()).toEqual([]);
    expect(await changeRows()).toEqual([]);
    expect(configEvents()).toEqual([]);
  });
});

describe('a secret never leaves', () => {
  it('stores ciphertext and no output carries the value', async () => {
    const { admin, repoId } = await setup();
    const outputs: unknown[] = [];
    outputs.push(
      await environmentConfigService.set(
        repoId,
        'production',
        { name: 'API_KEY', value: SECRET, isSecret: true },
        admin,
      ),
    );
    const [first] = await storedRows();
    expect(first!.value.startsWith('v1.')).toBe(true);
    expect(first!.value).not.toContain(SECRET);
    expect(environmentConfigCrypto.decryptToken(first!.value)).toBe(SECRET);

    outputs.push(
      await environmentConfigService.set(
        repoId,
        'production',
        { name: 'API_KEY', value: `${SECRET}-2`, isSecret: true },
        admin,
      ),
    );
    const [second] = await storedRows();
    expect(second!.value).not.toBe(first!.value);
    expect(second!.value.startsWith('v1.')).toBe(true);

    outputs.push(await environmentConfigService.list(repoId, 'production', admin));
    outputs.push(await environmentConfigService.listChanges(repoId, 'production', admin));
    outputs.push(await changeRows());
    outputs.push(dispatchedEvents(dispatch));
    for (const out of outputs) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(second!.value);
      expect(text).not.toContain(first!.value);
    }
    const [listed] = (await environmentConfigService.list(repoId, 'production', admin)) as {
      value: string | null;
      isSecret: boolean;
    }[];
    expect(listed).toMatchObject({ isSecret: true, value: null });
  });

  it('a refused secret write puts the value in no error message', async () => {
    const { memberCtx, repoId } = await setup();
    const err = await environmentConfigService
      .set(repoId, 'production', { name: 'API_KEY', value: SECRET, isSecret: true }, memberCtx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvironmentConfigForbiddenError);
    expect(String((err as Error).message)).not.toContain(SECRET);
  });
});

describe('names', () => {
  it('refuses PORT, DATABASE_URL and MOTIR_* in every environment before any write', async () => {
    const { admin, repoId } = await setup();
    for (const environment of ENVIRONMENTS) {
      for (const name of ['PORT', 'DATABASE_URL', 'MOTIR_ANYTHING']) {
        const err = await environmentConfigService
          .set(repoId, environment, { name, value: SECRET, isSecret: true }, admin)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReservedEnvironmentNameError);
        expect((err as Error).message).toContain(name);
        expect((err as Error).message).not.toContain(SECRET);
      }
    }
    expect(await storedRows()).toEqual([]);
    expect(await changeRows()).toEqual([]);
    expect(configEvents()).toEqual([]);
  });

  it.each(['', '1ABC', 'HAS-DASH', 'HAS SPACE', 'É'])('refuses the shape %j', async (name) => {
    const { admin, repoId } = await setup();
    await expect(
      environmentConfigService.set(
        repoId,
        'production',
        { name, value: 'x', isSecret: false },
        admin,
      ),
    ).rejects.toBeInstanceOf(InvalidEnvironmentNameError);
    expect(await storedRows()).toEqual([]);
  });
});

describe('one change record and one event per change', () => {
  it('records added, replaced and deleted, and sends one value-free event each', async () => {
    const { admin, repoId, workspaceId } = await setup();
    const env: AppEnvironment = 'preview';
    await environmentConfigService.set(
      repoId,
      env,
      { name: 'API_KEY', value: SECRET, isSecret: true },
      admin,
    );
    await environmentConfigService.set(
      repoId,
      env,
      { name: 'API_KEY', value: 'other', isSecret: true },
      admin,
    );
    await environmentConfigService.delete(repoId, env, 'API_KEY', admin);

    const changes = await changeRows();
    expect(changes.map((c) => [c.action, c.name, c.environment, c.isSecret, c.actorId])).toEqual([
      ['added', 'API_KEY', env, true, admin.userId],
      ['replaced', 'API_KEY', env, true, admin.userId],
      ['deleted', 'API_KEY', env, true, admin.userId],
    ]);
    expect(configEvents().map((e) => e.data)).toEqual(
      ['added', 'replaced', 'deleted'].map((action) => ({
        workspaceId,
        projectRepositoryId: repoId,
        environment: env,
        name: 'API_KEY',
        action,
        actorId: admin.userId,
      })),
    );
    const listed = await environmentConfigService.listChanges(repoId, env, admin);
    expect(listed.map((c) => c.action)).toEqual(['deleted', 'replaced', 'added']);
    // The actor is named when read, from the account that made the change.
    const actor = await adminDb.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect(listed.map((c) => c.actorName)).toEqual([actor.name, actor.name, actor.name]);
    for (const c of listed) expect(c).not.toHaveProperty('value');
  });

  it('a failed transaction sends nothing', async () => {
    const { admin, repoId } = await setup();
    delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
    await expect(
      environmentConfigService.set(
        repoId,
        'production',
        { name: 'API_KEY', value: SECRET, isSecret: true },
        admin,
      ),
    ).rejects.toThrow(/ENVIRONMENT_CONFIG_ENCRYPTION_KEY/);
    expect(await storedRows()).toEqual([]);
    expect(await changeRows()).toEqual([]);
    expect(configEvents()).toEqual([]);
  });
});

describe('a concurrent create of one name', () => {
  it('both calls succeed and one row remains', async () => {
    const { admin, repoId } = await setup();
    const results = await Promise.all(
      ['first', 'second'].map((value) =>
        environmentConfigService.set(
          repoId,
          'production',
          { name: 'RACE', value, isSecret: false },
          admin,
        ),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'replaced']);
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(['first', 'second']).toContain(rows[0]!.value);
    expect((await changeRows()).map((c) => c.action).sort()).toEqual(['added', 'replaced']);
  });
});
