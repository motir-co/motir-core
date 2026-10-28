// SET A REPOSITORY'S ENVIRONMENT — Story MOTIR-9795's integration gate (MOTIR-9967).
// The story end to end against real Postgres: an administrator writes through the
// HTTP doors, and the deploying code reads back through `resolveEnvironment`, the
// one system-internal read. Nothing between the two is stubbed — route → service →
// repository → Prisma on the way in, `withWorkspaceServiceContext` → repository on
// the way out — so a test here passes only when the two halves agree.
//
// Only `getWorkspaceContext` is stubbed (no cookies in the test env), the same
// partial mock the route suite uses, so the session gate itself still runs: a
// null context is the signed-out request. The job dispatcher is spied so the
// `environment.config.changed` events can be read and the enqueue swallowed.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { ENVIRONMENT_CONFIG_KEY_ENV } from '@/lib/environmentConfig/crypto';
import {
  CustomerRepositoryEnvironmentError,
  EnvironmentRepositoryNotFoundError,
} from '@/lib/environmentConfig/errors';
import { resolveEnvironment } from '@/lib/environmentConfig/resolveEnvironment';
import { ENVIRONMENTS, type EnvironmentName } from '@/lib/environmentConfig/vocabulary';
import { toEnvironmentChangeDto } from '@/lib/mappers/environmentConfigMappers';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type { WorkspaceContext } from '@/lib/workspaces';
import { createTestUser } from '../fixtures';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';
import { PRISMA_UNIQUE_VIOLATION } from '@/lib/prisma/uniqueViolation';
import { environmentConfigEntryRepository } from '@/lib/repositories/environmentConfigEntryRepository';

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET: LIST } =
  await import('@/app/api/projects/[key]/repositories/[rowId]/environments/[environment]/entries/route');
const { PUT, DELETE } =
  await import('@/app/api/projects/[key]/repositories/[rowId]/environments/[environment]/entries/[name]/route');
const { GET: CHANGES } =
  await import('@/app/api/projects/[key]/repositories/[rowId]/environments/[environment]/changes/route');
const { projectRepoSetService } = await import('@/lib/services/projectRepoSetService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { environmentConfigService } = await import('@/lib/services/environmentConfigService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');

const SECRET = 'sk-live-story-secret-9795';
const KEY = 'a'.repeat(64);
const saved = {
  own: process.env[ENVIRONMENT_CONFIG_KEY_ENV],
  github: process.env.GITHUB_TOKEN_ENCRYPTION_KEY,
};
let dispatch: ReturnType<typeof spyOnJobDispatch>;
let logged: string[];

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  process.env[ENVIRONMENT_CONFIG_KEY_ENV] = KEY;
  dispatch = spyOnJobDispatch();
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
});

afterEach(() => {
  dispatch.mockRestore();
  vi.restoreAllMocks();
  restore(ENVIRONMENT_CONFIG_KEY_ENV, saved.own);
  restore('GITHUB_TOKEN_ENCRYPTION_KEY', saved.github);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Fixture = Awaited<ReturnType<typeof makeWorkItemFixture>>;

async function setup() {
  const fx = await makeWorkItemFixture();
  const web = await projectRepoSetService.addRow(
    fx.projectId,
    { role: 'web', name: 'acme-web' },
    fx.ctx,
  );
  const member = await createTestUser();
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return {
    fx,
    repoId: web.id,
    asAdmin: () => (ctxRef.current = fx.ctx),
    asMember: () => (ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId }),
  };
}

async function addRepo(fx: Fixture, name: string) {
  return (await projectRepoSetService.addRow(fx.projectId, { role: 'api', name }, fx.ctx)).id;
}

const BASE = 'http://localhost:3000/api/projects/PROD/repositories';
const p = (rowId: string, environment: string, name = '') => ({
  params: Promise.resolve({ key: 'PROD', rowId, environment, name }),
});
const put = (rowId: string, environment: string, name: string, body: unknown) =>
  PUT(
    new Request(`${BASE}/${rowId}/environments/${environment}/entries/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    p(rowId, environment, name),
  );
const del = (rowId: string, environment: string, name: string) =>
  DELETE(new Request(`${BASE}/${rowId}`, { method: 'DELETE' }), p(rowId, environment, name));
const list = (rowId: string, environment: string) =>
  LIST(new Request(`${BASE}/${rowId}`), p(rowId, environment));
const changes = (rowId: string, environment: string) =>
  CHANGES(new Request(`${BASE}/${rowId}`), p(rowId, environment));

const resolve = (fx: Fixture, repoId: string, environment: EnvironmentName) =>
  resolveEnvironment(repoId, environment, { workspaceId: fx.workspaceId });

/** Every channel a value could leak through, as text. */
async function channelText(res: Response): Promise<string> {
  return res.status === 204 ? '' : await res.clone().text();
}

/** Fail if the secret, or its stored ciphertext, appears in any channel. */
function assertNoLeak(secret: string, ciphertext: string, ...channels: string[]) {
  for (const text of channels) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(ciphertext);
    expect(text).not.toContain('v1.');
  }
}

describe('Story MOTIR-9795 — set a repository’s environment', () => {
  it('an administrator stores a plain value and a secret, and the deploy reads both back', async () => {
    const { fx, repoId, asAdmin } = await setup();
    asAdmin();
    expect(
      (await put(repoId, 'production', 'API_URL', { value: 'https://a', isSecret: false })).status,
    ).toBe(200);
    expect(
      (await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true })).status,
    ).toBe(200);

    const stored = await adminDb.environmentConfigEntry.findMany({ orderBy: { name: 'asc' } });
    expect(stored.map((e) => [e.name, e.isSecret])).toEqual([
      ['API_KEY', true],
      ['API_URL', false],
    ]);
    expect(stored[0]!.value.startsWith('v1.')).toBe(true);
    expect(stored[0]!.value).not.toContain(SECRET);
    expect(stored[1]!.value).toBe('https://a');

    expect(await resolve(fx, repoId, 'production')).toEqual([
      { name: 'API_KEY', value: SECRET, secret: true },
      { name: 'API_URL', value: 'https://a', secret: false },
    ]);
  });

  it('a replace and a delete reach the deploy’s read', async () => {
    const { fx, repoId, asAdmin } = await setup();
    asAdmin();
    await put(repoId, 'preview', 'API_KEY', { value: SECRET, isSecret: true });
    await put(repoId, 'preview', 'API_URL', { value: 'one', isSecret: false });
    const replaced = await put(repoId, 'preview', 'API_KEY', {
      value: `${SECRET}-2`,
      isSecret: true,
    });
    expect(await replaced.json()).toMatchObject({ outcome: 'replaced' });
    expect((await del(repoId, 'preview', 'API_URL')).status).toBe(204);

    expect(await resolve(fx, repoId, 'preview')).toEqual([
      { name: 'API_KEY', value: `${SECRET}-2`, secret: true },
    ]);
  });

  it('keeps two repositories and three environments apart — six scopes, six answers', async () => {
    const { fx, repoId, asAdmin } = await setup();
    const second = await addRepo(fx, 'acme-api');
    asAdmin();
    const pairs = [repoId, second].flatMap((repo) =>
      ENVIRONMENTS.map((env) => [repo, env] as const),
    );
    expect(pairs).toHaveLength(6);
    for (const [repo, env] of pairs) {
      expect(
        (await put(repo, env, 'WHERE', { value: `${repo}:${env}`, isSecret: false })).status,
      ).toBe(200);
    }
    for (const [repo, env] of pairs) {
      expect(await resolve(fx, repo, env)).toEqual([
        { name: 'WHERE', value: `${repo}:${env}`, secret: false },
      ]);
      const listed = (await (await list(repo, env)).json()) as Array<{ value: string }>;
      expect(listed.map((e) => e.value)).toEqual([`${repo}:${env}`]);
    }
  });

  it('the deploy’s read runs as motir_app bound to the workspace, and refuses another workspace’s repository', async () => {
    const { fx, repoId, asAdmin } = await setup();
    const other = await makeWorkItemFixture();
    asAdmin();
    await put(repoId, 'production', 'PLAIN', { value: 'mine', isSecret: false });

    // `@/lib/db` connects as the runtime role here; an unbound read would see zero
    // rows, so a hit proves the bind.
    expect(await resolve(fx, repoId, 'production')).toEqual([
      { name: 'PLAIN', value: 'mine', secret: false },
    ]);
    await expect(
      resolveEnvironment(repoId, 'production', { workspaceId: other.workspaceId }),
    ).rejects.toBeInstanceOf(EnvironmentRepositoryNotFoundError);
  });

  it('a customer repository is refused by the read and by every door, and nothing is stored', async () => {
    const { fx, repoId, asAdmin } = await setup();
    await adminDb.projectRepo.update({
      where: { id: repoId },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });
    asAdmin();
    await expect(resolve(fx, repoId, 'production')).rejects.toBeInstanceOf(
      CustomerRepositoryEnvironmentError,
    );
    for (const res of [
      await list(repoId, 'production'),
      await put(repoId, 'production', 'X', { value: SECRET, isSecret: true }),
      await del(repoId, 'production', 'X'),
      await changes(repoId, 'production'),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('repository_not_found');
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
    expect(await adminDb.environmentConfigChange.count()).toBe(0);
    expect(dispatchedEvents(dispatch)).toEqual([]);
  });

  it('refuses the reserved names in every environment, and writes nothing', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    for (const env of ENVIRONMENTS) {
      for (const name of ['PORT', 'DATABASE_URL', 'MOTIR_ANYTHING']) {
        const res = await put(repoId, env, name, { value: 'v', isSecret: false });
        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatchObject({
          code: 'reserved_environment_name',
          name,
        });
      }
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
    expect(await adminDb.environmentConfigChange.count()).toBe(0);
    expect(dispatchedEvents(dispatch)).toEqual([]);
  });

  it('no response, change record, event or log line carries the secret or its ciphertext', async () => {
    const { fx, repoId, asAdmin, asMember } = await setup();
    asAdmin();
    const texts: string[] = [];
    const created = await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true });
    texts.push(await channelText(created));
    const [stored] = await adminDb.environmentConfigEntry.findMany();
    const ciphertext = stored!.value;

    texts.push(await channelText(await list(repoId, 'production')));
    texts.push(await channelText(await changes(repoId, 'production')));
    texts.push(
      await channelText(await put(repoId, 'production', 'PORT', { value: SECRET, isSecret: true })),
    );
    asMember();
    texts.push(await channelText(await list(repoId, 'production')));
    texts.push(
      await channelText(
        await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true }),
      ),
    );
    asAdmin();
    // The deploy's read holds the plaintext — and only in the array it returns.
    expect(await resolve(fx, repoId, 'production')).toEqual([
      { name: 'API_KEY', value: SECRET, secret: true },
    ]);
    texts.push(await channelText(await del(repoId, 'production', 'API_KEY')));

    const trail = await adminDb.environmentConfigChange.findMany();
    assertNoLeak(
      SECRET,
      ciphertext,
      ...texts,
      JSON.stringify(trail),
      JSON.stringify(dispatchedEvents(dispatch)),
      ...logged,
    );
  });

  it('a member reads but may not write; a signed-out request is refused first', async () => {
    const { repoId, asAdmin, asMember } = await setup();
    asAdmin();
    await put(repoId, 'production', 'KEEP', { value: 'v', isSecret: false });
    asMember();
    expect((await list(repoId, 'production')).status).toBe(200);
    expect((await changes(repoId, 'production')).status).toBe(200);
    expect((await put(repoId, 'production', 'NEW', { value: 'v', isSecret: false })).status).toBe(
      403,
    );
    expect((await del(repoId, 'production', 'KEEP')).status).toBe(403);
    ctxRef.current = null;
    expect((await list(repoId, 'production')).status).toBe(401);
    expect((await put(repoId, 'production', 'NEW', { value: 'v', isSecret: false })).status).toBe(
      401,
    );
    expect((await del(repoId, 'production', 'KEEP')).status).toBe(401);
    expect((await changes(repoId, 'production')).status).toBe(401);
    expect(await adminDb.environmentConfigEntry.count()).toBe(1);
  });

  it('three changes leave three records and three events, each naming the workspace and no value', async () => {
    const { fx, repoId, asAdmin } = await setup();
    asAdmin();
    dispatch.mockClear();
    await put(repoId, 'release', 'API_KEY', { value: SECRET, isSecret: true });
    await put(repoId, 'release', 'API_KEY', { value: `${SECRET}-2`, isSecret: true });
    await del(repoId, 'release', 'API_KEY');

    const trail = await adminDb.environmentConfigChange.findMany({ orderBy: { createdAt: 'asc' } });
    expect(trail.map((c) => [c.action, c.name, c.isSecret, c.actorId, c.workspaceId])).toEqual([
      ['added', 'API_KEY', true, fx.ownerId, fx.workspaceId],
      ['replaced', 'API_KEY', true, fx.ownerId, fx.workspaceId],
      ['deleted', 'API_KEY', true, fx.ownerId, fx.workspaceId],
    ]);
    const events = dispatchedEvents(dispatch).filter(
      (e) => e.name === 'environment.config.changed',
    );
    expect(events.map((e) => e.data)).toEqual(
      ['added', 'replaced', 'deleted'].map((action) => ({
        workspaceId: fx.workspaceId,
        projectRepositoryId: repoId,
        environment: 'release',
        name: 'API_KEY',
        action,
        actorId: fx.ownerId,
      })),
    );
    const listed = (await (await changes(repoId, 'release')).json()) as Array<
      Record<string, unknown>
    >;
    expect(listed.map((r) => r.action)).toEqual(['deleted', 'replaced', 'added']);
    for (const row of listed) expect(row).not.toHaveProperty('value');
  });

  it('with only the GitHub key set, a secret names ENVIRONMENT_CONFIG_ENCRYPTION_KEY and plain scopes still resolve', async () => {
    const { fx, repoId, asAdmin } = await setup();
    asAdmin();
    await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true });
    await put(repoId, 'preview', 'PLAIN', { value: 'ok', isSecret: false });
    delete process.env[ENVIRONMENT_CONFIG_KEY_ENV];
    process.env.GITHUB_TOKEN_ENCRYPTION_KEY = KEY;

    const err = await resolve(fx, repoId, 'production').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(ENVIRONMENT_CONFIG_KEY_ENV);
    expect((err as Error).message).not.toContain(SECRET);
    expect(await resolve(fx, repoId, 'preview')).toEqual([
      { name: 'PLAIN', value: 'ok', secret: false },
    ]);
  });
});

// The branches the story's happy and refused paths do not reach on their own, so
// the floor measures behaviour rather than luck: the race a concurrent first write
// loses, a failure the doors must not turn into a success, and a removed actor.
describe('Story MOTIR-9795 — the edges', () => {
  it('a first write that loses the unique race is retried once, as a replace', async () => {
    const { fx, repoId, asAdmin } = await setup();
    asAdmin();
    const upsert = environmentConfigEntryRepository.upsert.bind(environmentConfigEntryRepository);
    vi.spyOn(environmentConfigEntryRepository, 'upsert').mockImplementationOnce(
      async (tx, input) => {
        await upsert(tx, input);
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: PRISMA_UNIQUE_VIOLATION,
          clientVersion: 'test',
        });
      },
    );
    const res = await put(repoId, 'production', 'RACED', { value: 'v', isSecret: false });
    expect(res.status).toBe(200);
    expect(await resolve(fx, repoId, 'production')).toEqual([
      { name: 'RACED', value: 'v', secret: false },
    ]);
  });

  it('an unmapped failure in any door is rethrown, never answered as a success', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    vi.spyOn(environmentConfigService, 'set').mockRejectedValueOnce(new Error('set boom'));
    vi.spyOn(environmentConfigService, 'delete').mockRejectedValueOnce(new Error('delete boom'));
    vi.spyOn(environmentConfigService, 'listChanges').mockRejectedValueOnce(
      new Error('changes boom'),
    );
    await expect(put(repoId, 'production', 'A', { value: 'v', isSecret: false })).rejects.toThrow(
      'set boom',
    );
    await expect(del(repoId, 'production', 'A')).rejects.toThrow('delete boom');
    await expect(changes(repoId, 'production')).rejects.toThrow('changes boom');
  });

  it('a permission failure that is not a refusal is rethrown, not read as forbidden', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    vi.spyOn(projectAccessService, 'assertPermission').mockRejectedValueOnce(new Error('acl down'));
    await expect(put(repoId, 'production', 'A', { value: 'v', isSecret: false })).rejects.toThrow(
      'acl down',
    );
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
  });

  it('a body that is not JSON, or a missing environment, writes nothing', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    const garbled = await PUT(
      new Request(`${BASE}/${repoId}/environments/production/entries/A`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
      p(repoId, 'production', 'A'),
    );
    expect(garbled.status).toBe(400);
    expect((await del(repoId, 'staging', 'A')).status).toBe(404);
    expect((await changes(repoId, 'staging')).status).toBe(404);
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
  });

  it('a change whose actor is gone reads with no actor name', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    await put(repoId, 'preview', 'A', { value: 'v', isSecret: false });
    await adminDb.environmentConfigChange.updateMany({ data: { actorId: null } });
    const [row] = (await (await changes(repoId, 'preview')).json()) as Array<
      Record<string, unknown>
    >;
    expect(row).toMatchObject({ name: 'A', actorId: null, actorName: null });
    // An actor id the name lookup did not return reads the same way.
    const [stored] = await adminDb.environmentConfigChange.findMany();
    expect(toEnvironmentChangeDto({ ...stored!, actorId: 'gone' }).actorName).toBeNull();
  });
});
