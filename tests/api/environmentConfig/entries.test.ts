// MOTIR-9964 — the environment-configuration HTTP surface against real Postgres.
// Every call runs route → service → repository → Prisma. The service's own
// semantics are covered in `tests/environmentConfig/`; these tests own the
// transport: the session gate, the `[environment]` and body validation, the one
// typed-error → status mapping, and that no response or log line carries a value.
//
// Only `getWorkspaceContext` is stubbed (no cookies in the test env); the mock is
// partial, so the real RLS-binding `withWorkspaceContext` is kept.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ENVIRONMENT_CONFIG_KEY_ENV } from '@/lib/environmentConfig/crypto';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type { WorkspaceContext } from '@/lib/workspaces';
import { createTestUser } from '../../fixtures';
import { makeWorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';

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

const SECRET = 'sk-live-route-secret-9964';
const BASE = 'http://localhost:3000/api/projects/PROD/repositories';
const savedKey = process.env[ENVIRONMENT_CONFIG_KEY_ENV];
let dispatch: ReturnType<typeof spyOnJobDispatch>;
let logged: string[];

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  process.env[ENVIRONMENT_CONFIG_KEY_ENV] = 'f'.repeat(64);
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
  return {
    repoId: row.id,
    asAdmin: () => (ctxRef.current = fx.ctx),
    asMember: () => (ctxRef.current = { userId: member.id, workspaceId: fx.workspaceId }),
  };
}

const p = (rowId: string, environment: string, name = '') => ({
  params: Promise.resolve({ key: 'PROD', rowId, environment, name }),
});

function put(rowId: string, environment: string, name: string, body: unknown) {
  return PUT(
    new Request(`${BASE}/${rowId}/environments/${environment}/entries/${name}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    p(rowId, environment, name),
  );
}
const del = (rowId: string, environment: string, name: string) =>
  DELETE(new Request(`${BASE}/${rowId}`, { method: 'DELETE' }), p(rowId, environment, name));
const list = (rowId: string, environment: string) =>
  LIST(new Request(`${BASE}/${rowId}`), p(rowId, environment));
const changes = (rowId: string, environment: string) =>
  CHANGES(new Request(`${BASE}/${rowId}`), p(rowId, environment));

async function bodyText(res: Response): Promise<string> {
  return res.status === 204 ? '' : await res.clone().text();
}

describe('environment entry routes', () => {
  it('401s with no session, before anything is read', async () => {
    const { repoId } = await setup();
    expect((await list(repoId, 'production')).status).toBe(401);
    expect((await put(repoId, 'production', 'A', { value: 'x', isSecret: false })).status).toBe(
      401,
    );
    expect((await del(repoId, 'production', 'A')).status).toBe(401);
    expect((await changes(repoId, 'production')).status).toBe(401);
  });

  it('an administrator adds, replaces, lists and deletes in every environment', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    for (const env of ['production', 'preview', 'release']) {
      const created = await put(repoId, env, 'API_URL', { value: `${env}-1`, isSecret: false });
      expect(created.status).toBe(200);
      expect(await created.json()).toMatchObject({
        outcome: 'created',
        entry: { name: 'API_URL', isSecret: false, value: `${env}-1` },
      });
      const replaced = await put(repoId, env, 'API_URL', { value: `${env}-2`, isSecret: false });
      expect(await replaced.json()).toMatchObject({ outcome: 'replaced' });

      const entries = await (await list(repoId, env)).json();
      expect(entries).toEqual([expect.objectContaining({ name: 'API_URL', value: `${env}-2` })]);
    }
    expect((await del(repoId, 'preview', 'API_URL')).status).toBe(204);
    expect(await (await list(repoId, 'preview')).json()).toEqual([]);
    expect(await (await list(repoId, 'production')).json()).toHaveLength(1);
  });

  it('a member reads but may not write', async () => {
    const { repoId, asAdmin, asMember } = await setup();
    asAdmin();
    await put(repoId, 'production', 'KEEP', { value: 'v', isSecret: false });
    asMember();
    expect((await list(repoId, 'production')).status).toBe(200);
    const refused = await put(repoId, 'production', 'NEW', { value: 'v', isSecret: false });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('environment_config_forbidden');
    expect((await del(repoId, 'production', 'KEEP')).status).toBe(403);
    expect(await adminDb.environmentConfigEntry.count()).toBe(1);
    expect((await changes(repoId, 'production')).status).toBe(200);
  });

  it('a customer repository, an unknown repository, environment or name answer 404', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    await put(repoId, 'production', 'KEEP', { value: 'v', isSecret: false });
    dispatch.mockClear();

    expect((await list(repoId, 'staging')).status).toBe(404);
    expect((await put(repoId, 'staging', 'X', { value: 'v', isSecret: false })).status).toBe(404);
    const missing = await del(repoId, 'production', 'NOPE');
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toMatchObject({
      code: 'environment_entry_not_found',
      name: 'NOPE',
    });
    expect((await list('no-such-row', 'production')).status).toBe(404);

    await adminDb.projectRepo.update({
      where: { id: repoId },
      data: { seedSource: SEED_SOURCE_ORGANIZATION },
    });
    for (const res of [
      await list(repoId, 'production'),
      await put(repoId, 'production', 'X', { value: 'v', isSecret: false }),
      await del(repoId, 'production', 'KEEP'),
      await changes(repoId, 'production'),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('repository_not_found');
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses reserved names, bad shapes and malformed bodies', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    for (const env of ['production', 'preview', 'release']) {
      for (const name of ['PORT', 'DATABASE_URL', 'MOTIR_ANYTHING']) {
        const res = await put(repoId, env, name, { value: 'v', isSecret: false });
        expect(res.status).toBe(422);
        const { error } = await res.json();
        expect(error.code).toBe('reserved_environment_name');
        expect(error.name).toBe(name);
        expect(error.message).toContain(name);
      }
    }
    const shape = await put(repoId, 'production', '1BAD-NAME', { value: 'v', isSecret: false });
    expect(shape.status).toBe(422);
    expect((await shape.json()).error.code).toBe('invalid_environment_name');

    for (const body of [
      { isSecret: false },
      { value: 42, isSecret: false },
      { value: 'v', isSecret: 'yes' },
      { value: SECRET, isSecret: true, extra: 1 },
    ]) {
      const res = await put(repoId, 'production', 'OK', body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('invalid_body');
      expect(text).not.toContain(SECRET);
    }
    expect(await adminDb.environmentConfigEntry.count()).toBe(0);
  });

  it('no response or log line carries a secret value or its ciphertext', async () => {
    const { repoId, asAdmin, asMember } = await setup();
    asAdmin();
    const responses: Response[] = [];
    responses.push(await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true }));
    const [stored] = await adminDb.environmentConfigEntry.findMany();
    const ciphertext = stored!.value;
    expect(ciphertext.startsWith('v1.')).toBe(true);

    responses.push(
      await put(repoId, 'production', 'API_KEY', { value: `${SECRET}-2`, isSecret: true }),
    );
    const listed = await list(repoId, 'production');
    responses.push(listed);
    expect(await listed.clone().json()).toEqual([
      expect.objectContaining({ name: 'API_KEY', isSecret: true, value: null }),
    ]);
    responses.push(await put(repoId, 'production', 'PORT', { value: SECRET, isSecret: true }));
    responses.push(await changes(repoId, 'production'));
    asMember();
    responses.push(await put(repoId, 'production', 'API_KEY', { value: SECRET, isSecret: true }));
    responses.push(await list(repoId, 'production'));
    asAdmin();
    responses.push(await del(repoId, 'production', 'API_KEY'));
    responses.push(await del(repoId, 'production', 'API_KEY'));

    const replacedCipher = ciphertext; // the first; the replace wrote a new one
    for (const res of responses) {
      const text = await bodyText(res);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(replacedCipher);
      expect(text).not.toContain('v1.');
    }
    for (const line of logged) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('v1.');
    }
  });

  it('lists the recent changes, newest first, with no value', async () => {
    const { repoId, asAdmin, asMember } = await setup();
    asAdmin();
    await put(repoId, 'preview', 'A', { value: 'one', isSecret: false });
    await put(repoId, 'preview', 'A', { value: 'two', isSecret: false });
    await del(repoId, 'preview', 'A');
    asMember();
    const res = await changes(repoId, 'preview');
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.action)).toEqual(['deleted', 'replaced', 'added']);
    for (const row of rows) expect(row).not.toHaveProperty('value');
  });

  it('an unmapped error is rethrown, never a success', async () => {
    const { repoId, asAdmin } = await setup();
    asAdmin();
    const { environmentConfigService } = await import('@/lib/services/environmentConfigService');
    vi.spyOn(environmentConfigService, 'list').mockRejectedValueOnce(new Error('boom'));
    await expect(list(repoId, 'production')).rejects.toThrow('boom');
  });
});
