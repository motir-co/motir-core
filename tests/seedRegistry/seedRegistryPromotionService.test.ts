import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformRole, ProjectRepoTakeoverState } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { ORIGINAL_SEED_KEYS, withOnlyOriginalSeeds } from '../helpers/seedRegistryShipped';
import { truncateAuthTables } from '../helpers/db';
import { organizationIdOf } from '../helpers/organizationOf';

// PROMOTE-TO-STARTER and RETIRE (Story MOTIR-704 · MOTIR-710; decision MOTIR-706
// v2 §3.6) over the real test database, with GitHub stubbed at the HTTP boundary
// (`fetch`) exactly as the establish suite stubs it. What is proved here is the
// curation line: an operator promotes a repository Motir created and still holds,
// at a ref, only with hosting targets its manifest at that ref declares; every
// refusal leaves nothing written in Motir or on GitHub; a re-promotion updates;
// a retired entry is kept but never matched or offered; and nobody below
// `operator` can do either.

let currentSession: { user: { id: string; email: string; name: string } } | null = null;
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));

const MOTIR_ORG = 'motir-projects';
const SOURCE = 'acme-web';
const KEY = 'acme-internal-tool-starter';
const COMMIT = 'c0ffee0000000000000000000000000000000001';
const TREE = 'tree000000000000000000000000000000000001';
const MANIFEST = JSON.parse(
  readFileSync('tests/fixtures/hosting/motir.hosting.json', 'utf8'),
) as Record<string, unknown>;

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
/** The source's manifest text at COMMIT; null serves a 404. */
let manifest: string | null;
/** Repositories that exist in Motir's org, by name, with their description. */
let repos: Map<string, string>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SOURCE_TREE = [
  { path: 'README.md', mode: '100644', type: 'blob', sha: 'blob-readme' },
  { path: 'src', mode: '040000', type: 'tree', sha: 'tree-src' },
  { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'blob-index' },
  { path: 'src/copy.ts', mode: '100644', type: 'blob', sha: 'blob-index' },
  { path: 'run.sh', mode: '100755', type: 'blob', sha: 'blob-run' },
];

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      calls.push({ url: u, method, body });
      const path = u.replace('https://api.github.com', '');

      if (path === `/orgs/${MOTIR_ORG}/installation`) return json(200, { id: 556677 });
      if (path.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const src = `/repos/${MOTIR_ORG}/${SOURCE}`;
      if (method === 'GET' && path.startsWith(`${src}/commits/`)) {
        const ref = decodeURIComponent(path.slice(`${src}/commits/`.length));
        return ref === 'v1' || ref === COMMIT
          ? json(200, { sha: COMMIT, commit: { tree: { sha: TREE } } })
          : json(404, { message: 'No commit found for SHA: ' + ref });
      }
      if (method === 'GET' && path.startsWith(`${src}/contents/motir.hosting.json`)) {
        expect(path).toContain(`ref=${COMMIT}`);
        return manifest === null
          ? json(404, { message: 'Not Found' })
          : json(200, {
              type: 'file',
              encoding: 'base64',
              content: Buffer.from(manifest).toString('base64'),
            });
      }
      if (method === 'GET' && path === `${src}/git/trees/${TREE}?recursive=1`) {
        return json(200, { sha: TREE, tree: SOURCE_TREE, truncated: false });
      }
      if (method === 'GET' && path.startsWith(`${src}/git/blobs/`)) {
        const sha = path.slice(`${src}/git/blobs/`.length);
        return json(200, {
          sha,
          encoding: 'base64',
          content: `${Buffer.from(sha).toString('base64')}\n`,
        });
      }
      if (method === 'POST' && path === `/orgs/${MOTIR_ORG}/repos`) {
        const name = String(body?.['name']);
        if (repos.has(name)) {
          return json(422, {
            message: 'Repository creation failed.',
            errors: [
              {
                resource: 'Repository',
                field: 'name',
                message: 'name already exists on this account',
              },
            ],
          });
        }
        repos.set(name, String(body?.['description']));
        return json(201, { id: 1, name });
      }
      const copy = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
      if (copy && copy[1] === MOTIR_ORG && copy[2] !== SOURCE) {
        const [, , name, rest = ''] = copy;
        if (method === 'GET' && rest === '') {
          return repos.has(name!)
            ? json(200, {
                id: 77,
                name,
                owner: { login: MOTIR_ORG },
                default_branch: 'main',
                description: repos.get(name!),
              })
            : json(404, { message: 'Not Found' });
        }
        if (method === 'POST' && rest === '/git/blobs') return json(201, { sha: 'x' });
        if (method === 'POST' && rest === '/git/trees') return json(201, { sha: 'tree-copy' });
        if (method === 'POST' && rest === '/git/commits') return json(201, { sha: 'commit-copy' });
        if (method === 'PATCH' && rest === '/git/refs/heads/main') return json(200, {});
        if (method === 'PATCH' && rest === '') return json(200, {});
      }
      throw new Error(`unexpected GitHub call: ${method} ${u}`);
    }),
  );
}

/** Every call that would CHANGE something on GitHub (token mints excluded). */
const githubWrites = () =>
  calls.filter((c) => c.method !== 'GET' && !c.url.includes('/access_tokens'));

let seq = 0;
async function signInAs(role: PlatformRole | null) {
  const user = await createTestUser({ email: `seed-curation-${++seq}@example.com` });
  if (role) await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return { userId: user.id, email: user.email, role: role ?? ('support' as const) };
}

/** A fresh module graph per case: `requirePlatformStaff` is React-`cache()`d. */
async function fresh() {
  const { seedRegistryPromotionService } =
    await import('@/lib/services/seedRegistryPromotionService');
  const { seedRegistryService } = await import('@/lib/services/seedRegistryService');
  const { _resetInstallationTokenCache } = await import('@/lib/github/appAuth');
  const { _resetProvisioningInstallationCache, _setReadinessPollForTests } =
    await import('@/lib/github/repoProvisioning');
  _resetInstallationTokenCache();
  _resetProvisioningInstallationCache();
  _setReadinessPollForTests({ attempts: 2, delayMs: 0 });
  return { service: seedRegistryPromotionService, registry: seedRegistryService };
}

/** A web row Motir created, realised as `MOTIR_ORG/acme-web`. */
async function createdRow(
  over: {
    state?: 'created' | 'connected' | 'failed';
    seedSource?: string;
    takeoverState?: ProjectRepoTakeoverState | null;
    owner?: string;
  } = {},
) {
  const fx = await makeWorkItemFixture();
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: await organizationIdOf(fx.workspaceId),
      repoId: `repo-${fx.workspaceId}`,
      owner: over.owner ?? MOTIR_ORG,
      name: SOURCE,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  const row = await adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name: SOURCE,
      seedSource: over.seedSource ?? SEED_SOURCE_PLATFORM_STARTER,
      state: over.state ?? 'created',
      githubRepoId: repo.id,
      takeoverState: over.takeoverState ?? null,
      position: 'a0',
    },
  });
  return row;
}

function promotion(sourceRowId: string, over: Record<string, unknown> = {}) {
  return {
    sourceRowId,
    ref: 'v1',
    key: KEY,
    role: 'web',
    stack: 'nextjs',
    label: 'Next.js · internal tool on Fly',
    useCases: ['internal_tool'],
    sizes: ['small', 'medium'],
    hostingTargets: ['fly'],
    ...over,
  };
}

const entryCount = () => adminDb.seedRegistryEntry.count();
const auditRows = (action: string) => adminDb.platformAuditLog.findMany({ where: { action } });

beforeEach(async () => {
  vi.resetModules();
  calls = [];
  manifest = JSON.stringify(MANIFEST);
  repos = new Map();
  currentSession = null;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  installGitHub();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

// Promotion and retirement are proved from the two original seeds (they promote
// and retire under the starter keys), so MOTIR-9813's four shipped starter
// entries are set aside for this file.
withOnlyOriginalSeeds();

afterEach(async () => {
  await adminDb.seedRegistryEntry.deleteMany({
    where: { key: { notIn: ORIGINAL_SEED_KEYS } },
  });
  await adminDb.seedRegistryEntry.updateMany({ data: { status: 'active' } });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('promote', () => {
  it('copies the repository AT the ref into a template and writes an active entry with its provenance', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service } = await fresh();

    const entry = await service.promote(principal, promotion(row.id), 'a solid internal-tool base');

    expect(entry).toMatchObject({
      key: KEY,
      role: 'web',
      stack: 'nextjs',
      source: { owner: MOTIR_ORG, repo: KEY },
      useCases: ['internal_tool'],
      sizes: ['small', 'medium'],
      hostingTargets: ['fly'],
      status: 'active',
      promotedFrom: row.id,
      promotedRef: COMMIT,
      promotedBy: principal.userId,
    });
    expect(entry.promotedAt).not.toBeNull();

    // The copy: a new repository, every DISTINCT blob, one tree of the files
    // (directories are implied), a ROOT commit, the branch forced, a template.
    const writes = githubWrites();
    expect(writes[0]).toMatchObject({ method: 'POST', body: { name: KEY, private: true } });
    expect(writes.filter((c) => c.url.endsWith('/git/blobs'))).toHaveLength(3);
    const tree = writes.find((c) => c.url.endsWith('/git/trees'))!;
    expect((tree.body!['tree'] as { path: string }[]).map((e) => e.path)).toEqual([
      'README.md',
      'src/index.ts',
      'src/copy.ts',
      'run.sh',
    ]);
    expect(writes.find((c) => c.url.endsWith('/git/commits'))!.body).toMatchObject({
      tree: 'tree-copy',
      parents: [],
    });
    expect(writes.find((c) => c.url.endsWith('/git/refs/heads/main'))!.body).toEqual({
      sha: 'commit-copy',
      force: true,
    });
    expect(writes.at(-1)).toMatchObject({ method: 'PATCH', body: { is_template: true } });

    const [audit] = await auditRows('seed_registry.promote');
    expect(audit).toMatchObject({
      actorUserId: principal.userId,
      targetId: KEY,
      reason: 'a solid internal-tool base',
    });
    expect(await auditRows('seed_registry.promote_source_read')).toHaveLength(1);
  });

  it('promotes a foundation with NO targets without reading any manifest', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    manifest = null;
    const { service } = await fresh();

    const entry = await service.promote(
      principal,
      promotion(row.id, { hostingTargets: [] }),
      'a foundation',
    );
    expect(entry.hostingTargets).toEqual([]);
    expect(calls.some((c) => c.url.includes('/contents/'))).toBe(false);
  });

  it('re-promoting the same source at the same ref UPDATES the entry and copies nothing again', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service } = await fresh();
    await service.promote(principal, promotion(row.id), 'first');
    const count = await entryCount();
    calls = [];

    const again = await service.promote(
      principal,
      promotion(row.id, { ref: COMMIT, label: 'Renamed', useCases: ['internal_tool', 'mvp'] }),
      'second',
    );
    expect(again).toMatchObject({ key: KEY, label: 'Renamed', useCases: ['internal_tool', 'mvp'] });
    expect(await entryCount()).toBe(count);
    expect(githubWrites()).toEqual([]);
    expect((await auditRows('seed_registry.promote')).map((r) => r.metadata)).toEqual([
      expect.objectContaining({ repromoted: false }),
      expect.objectContaining({ repromoted: true }),
    ]);
  });

  it('adopts its OWN earlier copy after a crash, and refuses a repository that is not its copy', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service } = await fresh();

    repos.set(KEY, `Motir starter "${KEY}", promoted from ${MOTIR_ORG}/${SOURCE} at c0ffee000000.`);
    await expect(service.promote(principal, promotion(row.id), 'retry')).resolves.toMatchObject({
      key: KEY,
    });

    await adminDb.seedRegistryEntry.deleteMany({ where: { key: KEY } });
    repos.set(KEY, 'Somebody else’s repository');
    calls = [];
    await expect(service.promote(principal, promotion(row.id), 'clash')).rejects.toMatchObject({
      code: 'SEED_PROMOTION_TEMPLATE_NAME_TAKEN',
    });
    expect(await adminDb.seedRegistryEntry.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it.each([
    ['a take-over requested', { takeoverState: 'requested' }, 'taken_over'],
    ['a take-over pending its transfer', { takeoverState: 'transfer_pending' }, 'taken_over'],
    ['a take-over awaiting the reinstall', { takeoverState: 'awaiting_reinstall' }, 'taken_over'],
    ['a finished take-over', { takeoverState: 'done' }, 'taken_over'],
    ['a connected row', { state: 'connected' }, 'not_created'],
    ['a failed row', { state: 'failed' }, 'not_created'],
    ['a customer’s repository', { seedSource: 'organization' }, 'organization_row'],
    ['a repository Motir no longer holds', { owner: 'someone-else' }, 'not_motir_held'],
  ] as const)('refuses %s, writing nothing in Motir or on GitHub', async (_, over, refusal) => {
    const principal = await signInAs('operator');
    const row = await createdRow(over);
    const { service } = await fresh();
    const before = await entryCount();

    await expect(service.promote(principal, promotion(row.id), 'no')).rejects.toMatchObject({
      code: 'SEED_PROMOTION_SOURCE_REFUSED',
      refusal,
    });
    expect(await entryCount()).toBe(before);
    expect(githubWrites()).toEqual([]);
    expect(await auditRows('seed_registry.promote')).toEqual([]);
  });

  it('admits a row whose take-over FAILED — the repository is still Motir’s', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow({ takeoverState: 'failed' });
    const { service } = await fresh();
    await expect(service.promote(principal, promotion(row.id), 'ok')).resolves.toMatchObject({
      key: KEY,
    });
  });

  it.each([
    [
      'no manifest at the ref',
      (): string | null => null,
      { refusal: 'missing', file: 'motir.hosting.json' },
    ],
    [
      'an invalid manifest',
      (): string | null => JSON.stringify({ ...MANIFEST, port: 0 }),
      // The parser's reason travels on the error (MOTIR-712), so the console
      // names it without parsing the English message.
      {
        refusal: 'invalid',
        file: 'motir.hosting.json',
        field: 'port',
        reason: expect.stringMatching(/\S/) as unknown as string,
      },
    ],
    [
      'a claimed target the manifest does not declare',
      (): string | null => JSON.stringify(MANIFEST),
      { refusal: 'target_not_declared', field: 'targets', target: 'aws', declared: ['fly'] },
    ],
  ] as const)('refuses %s, copying nothing and writing no entry', async (_, text, expected) => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    manifest = text();
    const { service } = await fresh();
    const before = await entryCount();

    await expect(
      service.promote(principal, promotion(row.id, { hostingTargets: ['fly', 'aws'] }), 'no'),
    ).rejects.toMatchObject({ code: 'SEED_PROMOTION_MANIFEST_REFUSED', ...expected });
    expect(githubWrites()).toEqual([]);
    expect(await entryCount()).toBe(before);
  });

  it.each([
    ['useCase', { useCases: ['prototype'] }],
    ['size', { sizes: ['xl'] }],
    ['hostingTarget', { hostingTargets: ['heroku'] }],
    ['role', { role: 'backend' }],
  ])('refuses an unknown %s before touching GitHub', async (field, over) => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service } = await fresh();

    await expect(service.promote(principal, promotion(row.id, over), 'no')).rejects.toMatchObject({
      code: 'SEED_REGISTRY_INVALID_FIELD',
      field,
    });
    expect(calls).toEqual([]);
  });

  it('refuses a ref the repository does not have, and a key another entry holds', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service } = await fresh();

    await expect(
      service.promote(principal, promotion(row.id, { ref: 'nope' }), 'no'),
    ).rejects.toMatchObject({ code: 'SEED_PROMOTION_REF_NOT_FOUND' });
    await expect(
      service.promote(principal, promotion(row.id, { key: 'nextjs-prisma-vercel-starter' }), 'no'),
    ).rejects.toMatchObject({ code: 'SEED_REGISTRY_KEY_TAKEN' });
    expect(githubWrites()).toEqual([]);
  });
});

describe('retire', () => {
  it('retires an entry: kept and readable, never matched or offered again', async () => {
    const principal = await signInAs('operator');
    const row = await createdRow();
    const { service, registry } = await fresh();
    await service.promote(principal, promotion(row.id), 'promote');
    expect((await registry.matchSeedEntry({ role: 'web', hostingTarget: 'fly' })).key).toBe(KEY);

    const retired = await service.retire(principal, KEY, 'superseded');
    expect(retired).toMatchObject({
      status: 'retired',
      hostingTargets: ['fly'],
      promotedFrom: row.id,
      promotedRef: COMMIT,
    });
    expect(await registry.getByKey(KEY)).toMatchObject({ status: 'retired', promotedFrom: row.id });
    expect((await registry.matchSeedEntry({ role: 'web', hostingTarget: 'fly' })).key).toBe(
      SEED_SOURCE_INITIALISED,
    );
    const offered = await registry.listCompatible({ role: 'web', hostingTarget: 'fly' });
    expect(offered.items.map((e) => e.key)).not.toContain(KEY);
    expect(await auditRows('seed_registry.retire')).toEqual([
      expect.objectContaining({ targetId: KEY, reason: 'superseded' }),
    ]);

    // Again: nothing to change, no second audit row.
    await service.retire(principal, KEY, 'again');
    expect(await auditRows('seed_registry.retire')).toHaveLength(1);
  });

  it.each([SEED_SOURCE_INITIALISED, SEED_SOURCE_PLATFORM_STARTER, 'nextjs-prisma-vercel-starter'])(
    'refuses to retire a role default (%s)',
    async (key) => {
      const principal = await signInAs('operator');
      const { service } = await fresh();
      await expect(service.retire(principal, key, 'no')).rejects.toMatchObject({
        code: 'SEED_ENTRY_IS_DEFAULT',
      });
      expect(await adminDb.seedRegistryEntry.count({ where: { status: 'retired' } })).toBe(0);
    },
  );

  it('refuses an unknown key', async () => {
    const principal = await signInAs('operator');
    const { service } = await fresh();
    await expect(service.retire(principal, 'nothing-here', 'no')).rejects.toMatchObject({
      code: 'SEED_REGISTRY_ENTRY_NOT_FOUND',
    });
  });
});

describe('the operator gate', () => {
  it.each([['support' as const], [null]])(
    'refuses %s at the service, before anything is read',
    async (role) => {
      const principal = await signInAs(role);
      const row = await createdRow();
      const { service } = await fresh();
      await expect(service.promote(principal, promotion(row.id), 'no')).rejects.toMatchObject({
        code: 'NOT_PLATFORM_STAFF',
      });
      await expect(
        service.retire(principal, SEED_SOURCE_PLATFORM_STARTER, 'no'),
      ).rejects.toMatchObject({
        code: 'NOT_PLATFORM_STAFF',
      });
      expect(calls).toEqual([]);
    },
  );

  it('answers both routes with the console’s not-found below operator', async () => {
    await signInAs('support');
    const row = await createdRow();
    const { POST: PROMOTE } = await import('@/app/api/platform/seed-registry/promote/route');
    const { POST: RETIRE } = await import('@/app/api/platform/seed-registry/[key]/retire/route');
    const body = (payload: unknown) =>
      new Request('http://localhost/api/platform/seed-registry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const promoted = await PROMOTE(body({ ...promotion(row.id), reason: 'x' }));
    expect(promoted.status).toBe(404);
    const retired = await RETIRE(body({ reason: 'x' }), {
      params: Promise.resolve({ key: SEED_SOURCE_PLATFORM_STARTER }),
    });
    expect(retired.status).toBe(404);
    expect(await entryCount()).toBe(2);
  });

  it('answers an operator through the routes, with typed refusals', async () => {
    await signInAs('operator');
    const row = await createdRow();
    const { POST: PROMOTE } = await import('@/app/api/platform/seed-registry/promote/route');
    const { POST: RETIRE } = await import('@/app/api/platform/seed-registry/[key]/retire/route');
    const body = (payload: unknown) =>
      new Request('http://localhost/api/platform/seed-registry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const promoted = await PROMOTE(body({ ...promotion(row.id), reason: 'base' }));
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({
      key: KEY,
      useCases: ['internal_tool'],
      sizes: ['small', 'medium'],
      hostingTargets: ['fly'],
    });

    expect((await PROMOTE(body({ ...promotion(row.id) }))).status).toBe(400);
    const refused = await RETIRE(body({ reason: 'x' }), {
      params: Promise.resolve({ key: SEED_SOURCE_INITIALISED }),
    });
    expect(refused.status).toBe(409);
    const ok = await RETIRE(body({ reason: 'done with it' }), {
      params: Promise.resolve({ key: KEY }),
    });
    expect(await ok.json()).toMatchObject({ key: KEY, status: 'retired' });
  });
});
