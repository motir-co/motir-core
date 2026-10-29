// MOTIR-10027 — switching production on for a Motir repository, against real
// Postgres, the deploy port's fake, and GitHub stubbed at its `fetch` boundary
// (a stateful fake of the environment, environment-secret and repository-variable
// endpoints). The sealed secret is opened with the fake's own key pair, so the
// test proves it was sealed for the repository rather than sent in the clear.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sodium from 'libsodium-wrappers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeHostingControls } from '@motir/orchestrator';
import type { HostingTarget } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  CustomerRepositoryNotDeployableError,
  ProductionEnablementFailedError,
} from '@/lib/hosting/errors';
import {
  HOSTING_TARGET_VARIABLE,
  PRODUCTION_IMAGE_VARIABLE,
  PRODUCTION_PUSH_TOKEN_SECRET,
} from '@/lib/hosting/productionEnablementNames';
import { getHostingDeployPort } from '@/lib/orchestrator/hosting';
import { productionEnablementService as service } from '@/lib/services/productionEnablementService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkProjectRepo } from '../helpers/projectRepoLink';

const ORG = 'motir-projects';
const MANIFEST = readFileSync('tests/fixtures/hosting/motir.hosting.json', 'utf8');
const DAY = 86_400_000;

interface FakeRepo {
  manifest: string | null;
  environment: { custom: boolean } | null;
  policies: Array<{ id: number; name: string; type: string }>;
  secrets: Map<string, string>;
  variables: Map<string, string>;
}

let repos: Map<string, FakeRepo>;
let calls: Array<{ method: string; path: string; body: string | null }>;
let failSecretPut = false;
let keys: { publicKey: Uint8Array; privateKey: Uint8Array };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function repoFor(name: string): FakeRepo {
  let repo = repos.get(name);
  if (!repo) {
    repo = {
      manifest: MANIFEST,
      environment: null,
      policies: [],
      secrets: new Map(),
      variables: new Map(),
    };
    repos.set(name, repo);
  }
  return repo;
}

function route(method: string, path: string, body: Record<string, unknown> | null): Response {
  if (path === `/orgs/${ORG}/installation`) return json(200, { id: 556677 });
  if (path.includes('/access_tokens')) {
    return json(200, {
      token: 'ghs_test',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/[^?]*)?(\?.*)?$/.exec(path);
  if (!m || m[1] !== ORG) throw new Error(`unexpected fetch: ${method} ${path}`);
  const repo = repoFor(m[2]!);
  const rest = m[3] ?? '';
  if (method === 'GET' && rest === '/contents/motir.hosting.json') {
    expect(m[4]).toBe('?ref=main');
    return repo.manifest === null
      ? json(404, { message: 'Not Found' })
      : json(200, { type: 'file', content: Buffer.from(repo.manifest).toString('base64') });
  }
  const env = '/environments/production';
  if (method === 'PUT' && rest === env) {
    const policy = body?.['deployment_branch_policy'] as Record<string, unknown>;
    repo.environment = { custom: policy['custom_branch_policies'] === true };
    return json(200, { name: 'production' });
  }
  if (rest === `${env}/deployment-branch-policies`) {
    if (method === 'GET')
      return json(200, { total_count: repo.policies.length, branch_policies: repo.policies });
    const created = {
      id: repo.policies.length + 100,
      name: String(body?.['name']),
      type: String(body?.['type']),
    };
    repo.policies.push(created);
    return json(200, created);
  }
  if (method === 'DELETE' && rest.startsWith(`${env}/deployment-branch-policies/`)) {
    const id = Number(rest.split('/').pop());
    repo.policies = repo.policies.filter((p) => p.id !== id);
    return new Response(null, { status: 204 });
  }
  if (method === 'GET' && rest === `${env}/secrets/public-key`) {
    return json(200, {
      key_id: 'kid-1',
      key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
    });
  }
  if (method === 'PUT' && rest.startsWith(`${env}/secrets/`)) {
    if (failSecretPut) return json(500, { message: 'secret store down' });
    expect(body?.['key_id']).toBe('kid-1');
    const sealed = sodium.from_base64(
      String(body?.['encrypted_value']),
      sodium.base64_variants.ORIGINAL,
    );
    const opened = sodium.crypto_box_seal_open(sealed, keys.publicKey, keys.privateKey);
    repo.secrets.set(decodeURIComponent(rest.split('/').pop()!), sodium.to_string(opened));
    return new Response(null, { status: 201 });
  }
  if (rest.startsWith('/actions/variables')) {
    const name = rest.split('/')[3];
    if (method === 'GET') {
      return repo.variables.has(name!)
        ? json(200, { name, value: repo.variables.get(name!) })
        : json(404, { message: 'Not Found' });
    }
    repo.variables.set(String(body?.['name']), String(body?.['value']));
    return new Response(null, { status: method === 'POST' ? 201 : 204 });
  }
  throw new Error(`unexpected fetch: ${method} ${path}`);
}

beforeAll(async () => {
  await sodium.ready;
  keys = sodium.crypto_box_keypair();
});

beforeEach(async () => {
  await truncateAuthTables();
  repos = new Map();
  calls = [];
  failSecretPut = false;
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace('https://api.github.com', '');
      const method = init?.method ?? 'GET';
      const raw = typeof init?.body === 'string' ? init.body : null;
      calls.push({ method, path, body: raw });
      return route(method, path, raw ? (JSON.parse(raw) as Record<string, unknown>) : null);
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function fakePort(): FakeHostingControls {
  return getHostingDeployPort('fly') as unknown as FakeHostingControls;
}

async function workspace(identifier = 'ACME'): Promise<WorkItemFixture> {
  return makeWorkItemFixture({ name: identifier, identifier });
}

let repoSeq = 0;
async function motirRepo(
  fx: WorkItemFixture,
  opts: { name?: string; seedSource?: string; hostingTarget?: HostingTarget | null } = {},
): Promise<string> {
  repoSeq += 1;
  const name = opts.name ?? `shop-${repoSeq}`;
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${fx.workspaceId}` },
    update: {},
    create: {
      installationId: `inst-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      accountLogin: ORG,
      accountType: 'Organization',
    },
  });
  const githubRepo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}-${repoSeq}`,
      owner: ORG,
      name,
      defaultBranch: 'main',
    },
  });
  const row = await linkProjectRepo({
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    githubRepoId: githubRepo.id,
    name,
    role: 'web',
  });
  await adminDb.projectRepo.update({
    where: { id: row.id },
    data: {
      state: 'created',
      seedSource: opts.seedSource ?? 'nextjs-prisma-fly-starter',
      hostingTarget: opts.hostingTarget === undefined ? 'fly' : opts.hostingTarget,
    },
  });
  return row.id;
}

async function appRow(projectRepositoryId: string) {
  return adminDb.hostedApplication.findUnique({ where: { projectRepositoryId } });
}

function githubWrites() {
  return calls.filter((c) => c.method !== 'GET');
}

describe('enableProduction', () => {
  it('switches a Fly Motir repository on: app, environment, secret, variables, row', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: 'shop' });
    const minted = fakePort().mintedFor.length;

    const result = await service.enableProduction(id);

    expect(result).toMatchObject({ outcome: 'enabled', appName: `mh-${id}` });
    // The credential was minted for the ONE production app, nothing wider.
    expect(fakePort().mintedFor.slice(minted)).toEqual([`mh-${id}`]);
    expect(fakePort().app(`mh-${id}`)?.environment).toEqual({ kind: 'production' });

    const repo = repos.get('shop')!;
    expect(repo.environment).toEqual({ custom: true });
    expect(repo.policies.map((p) => [p.name, p.type])).toEqual([['main', 'branch']]);
    expect(repo.secrets.get(PRODUCTION_PUSH_TOKEN_SECRET)).toBe(`fake-deploy-token-mh-${id}`);
    expect(repo.variables.get(PRODUCTION_IMAGE_VARIABLE)).toBe(`registry.fly.io/mh-${id}`);
    expect(repo.variables.get(HOSTING_TARGET_VARIABLE)).toBe('fly');

    const row = await appRow(id);
    expect(row?.productionAppName).toBe(`mh-${id}`);
    expect(row?.productionEnabledAt).not.toBeNull();
    expect(row?.productionTokenMintedAt).not.toBeNull();
  });

  it('writes the target variable LAST', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx);
    await service.enableProduction(id);
    const writes = githubWrites();
    const last = writes[writes.length - 1]!;
    expect(last.method).toBe('POST');
    expect(JSON.parse(last.body!)).toEqual({ name: HOSTING_TARGET_VARIABLE, value: 'fly' });
    const secretAt = writes.findIndex((c) => c.path.includes('/secrets/'));
    const imageAt = writes.findIndex((c) => c.body?.includes(PRODUCTION_IMAGE_VARIABLE));
    const environmentAt = writes.findIndex((c) => c.path.endsWith('/environments/production'));
    expect(environmentAt).toBeGreaterThanOrEqual(0);
    expect(environmentAt).toBeLessThan(secretAt);
    expect(secretAt).toBeLessThan(imageAt);
    expect(imageAt).toBeLessThan(writes.length - 1);
  });

  it('never stores, logs or returns the token, and never sends it unsealed', async () => {
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    const fx = await workspace();
    const id = await motirRepo(fx);
    const token = `fake-deploy-token-mh-${id}`;

    const result = await service.enableProduction(id);

    expect(JSON.stringify(result)).not.toContain(token);
    for (const c of calls) expect(c.body ?? '').not.toContain(token);
    const row = await appRow(id);
    expect(JSON.stringify(row)).not.toContain(token);
    for (const spy of [warn, log]) {
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(token);
    }
  });

  it('refuses a customer repository before any call, and writes no row', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { seedSource: 'organization' });
    const minted = fakePort().mintedFor.length;
    await expect(service.enableProduction(id)).rejects.toBeInstanceOf(
      CustomerRepositoryNotDeployableError,
    );
    expect(calls).toEqual([]);
    expect(fakePort().mintedFor.length).toBe(minted);
    expect(await appRow(id)).toBeNull();
  });

  it.each([
    ['manifest_missing', null],
    ['manifest_invalid', '{"schemaVersion": 1}'],
    ['target_not_declared', MANIFEST.replace('["fly"]', '["serverless"]')],
  ])('skips a repository whose manifest is %s, calling nothing else', async (reason, text) => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: `m-${reason}` });
    repoFor(`m-${reason}`).manifest = text;
    const minted = fakePort().mintedFor.length;

    const result = await service.enableProduction(id);

    expect(result).toMatchObject({ outcome: 'skipped', reason });
    expect(githubWrites()).toEqual([]);
    expect(fakePort().mintedFor.length).toBe(minted);
    expect(await appRow(id)).toBeNull();
  });

  it('skips a target this path does not switch on', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { hostingTarget: 'serverless' });
    expect(await service.enableProduction(id)).toMatchObject({
      outcome: 'skipped',
      reason: 'target_not_supported',
    });
    expect(calls).toEqual([]);
  });

  it('refuses an unknown or unrealized repository', async () => {
    await expect(service.enableProduction('nope')).rejects.toMatchObject({ step: 'repository' });
    const fx = await workspace();
    const id = await motirRepo(fx);
    await adminDb.projectRepo.update({ where: { id }, data: { githubRepoId: null } });
    await expect(service.enableProduction(id)).rejects.toMatchObject({ step: 'repository' });
  });

  it('refuses a repository outside every org Motir holds, at the repository step', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx);
    await adminDb.githubRepo.updateMany({
      where: { workspaceId: fx.workspaceId },
      data: { owner: 'someone-else' },
    });
    await expect(service.enableProduction(id)).rejects.toMatchObject({ step: 'repository' });
  });

  it('leaves the target variable unset when the secret write fails, and a re-run completes', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: 'flaky' });
    failSecretPut = true;

    const failed = service.enableProduction(id);
    await expect(failed).rejects.toBeInstanceOf(ProductionEnablementFailedError);
    await expect(failed).rejects.toMatchObject({ step: 'secret' });
    expect(repos.get('flaky')!.variables.has(HOSTING_TARGET_VARIABLE)).toBe(false);
    expect((await appRow(id))?.productionEnabledAt).toBeNull();

    failSecretPut = false;
    expect(await service.enableProduction(id)).toMatchObject({ outcome: 'enabled' });
    expect(repos.get('flaky')!.variables.get(HOSTING_TARGET_VARIABLE)).toBe('fly');
  });

  it('is idempotent: a second run is already_enabled and mints nothing', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: 'twice' });
    await service.enableProduction(id);
    const minted = fakePort().mintedFor.length;
    const before = structuredClone([...repos.get('twice')!.variables]);
    calls = [];

    expect(await service.enableProduction(id)).toMatchObject({
      outcome: 'already_enabled',
      appName: `mh-${id}`,
    });
    expect(fakePort().mintedFor.length).toBe(minted);
    expect(githubWrites()).toEqual([]);
    expect([...repos.get('twice')!.variables]).toEqual(before);
    expect(await adminDb.hostedApplication.count()).toBe(1);
  });

  it('gives two repositories of one project different apps and variables', async () => {
    const fx = await workspace();
    const a = await motirRepo(fx, { name: 'one' });
    const b = await motirRepo(fx, { name: 'two' });
    await service.enableProduction(a);
    await service.enableProduction(b);
    expect(repos.get('one')!.variables.get(PRODUCTION_IMAGE_VARIABLE)).toBe(
      `registry.fly.io/mh-${a}`,
    );
    expect(repos.get('two')!.variables.get(PRODUCTION_IMAGE_VARIABLE)).toBe(
      `registry.fly.io/mh-${b}`,
    );
    expect((await appRow(a))?.productionAppName).not.toBe((await appRow(b))?.productionAppName);
  });

  it('re-mints a token older than 76 days, and only then', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: 'aging' });
    await service.enableProduction(id);
    const first = (await appRow(id))!;
    const firstMint = first.productionTokenMintedAt!;
    const minted = fakePort().mintedFor.length;

    const day75 = () => new Date(firstMint.getTime() + 75 * DAY);
    expect(await service.enableProduction(id, { now: day75 })).toMatchObject({
      outcome: 'already_enabled',
    });
    expect(fakePort().mintedFor.length).toBe(minted);

    calls = [];
    const day77 = new Date(firstMint.getTime() + 77 * DAY);
    expect(await service.enableProduction(id, { now: () => day77 })).toMatchObject({
      outcome: 'token_reminted',
    });
    expect(fakePort().mintedFor.slice(minted)).toEqual([`mh-${id}`]);
    expect(
      githubWrites().some((c) => c.path.includes(`/secrets/${PRODUCTION_PUSH_TOKEN_SECRET}`)),
    ).toBe(true);
    // The variables are already right, so a re-mint writes none of them.
    expect(githubWrites().some((c) => c.path.includes('/actions/variables'))).toBe(false);
    const row = (await appRow(id))!;
    expect(row.productionTokenMintedAt).toEqual(day77);
    // Still the time production was FIRST switched on.
    expect(row.productionEnabledAt).toEqual(first.productionEnabledAt);
  });

  it('converges the environment to a main-only branch rule', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx, { name: 'loose' });
    repoFor('loose').policies = [
      { id: 1, name: 'release/*', type: 'branch' },
      { id: 2, name: 'main', type: 'branch' },
    ];
    await service.enableProduction(id);
    expect(repos.get('loose')!.policies.map((p) => p.name)).toEqual(['main']);
  });
});

describe('enableQuietly — the creation path', () => {
  it('switches an eligible repository on', async () => {
    const fx = await workspace();
    const id = await motirRepo(fx);
    await service.enableQuietly(id);
    expect((await appRow(id))?.productionEnabledAt).not.toBeNull();
  });

  it('leaves a customer, a non-Fly or an unknown repository alone, silently', async () => {
    const warn = vi.spyOn(console, 'warn');
    const fx = await workspace();
    await service.enableQuietly(await motirRepo(fx, { seedSource: 'organization' }));
    await service.enableQuietly(await motirRepo(fx, { hostingTarget: null }));
    await service.enableQuietly('nope');
    expect(calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a failure with its step and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = await workspace();
    const id = await motirRepo(fx);
    failSecretPut = true;
    await expect(service.enableQuietly(id)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('production not switched on'),
      id,
      'secret',
      expect.any(String),
    );
  });
});

describe('backfillProductionEnablement', () => {
  it('walks every eligible repository, continues past a failure, and is idempotent', async () => {
    const fx = await workspace();
    const ok = await motirRepo(fx, { name: 'ok' });
    const broken = await motirRepo(fx, { name: 'broken' });
    const customer = await motirRepo(fx, { name: 'cust', seedSource: 'organization' });
    const serverless = await motirRepo(fx, { name: 'sls', hostingTarget: 'serverless' });
    const other = await workspace('OTHER');
    const elsewhere = await motirRepo(other, { name: 'elsewhere' });
    await adminDb.githubRepo.updateMany({ where: { name: 'broken' }, data: { owner: 'not-ours' } });

    const first = await service.backfillProductionEnablement();
    const byId = new Map(first.map((e) => [e.projectRepositoryId, e.result]));
    expect(byId.get(ok)).toMatchObject({ outcome: 'enabled' });
    expect(byId.get(elsewhere)).toMatchObject({ outcome: 'enabled' });
    expect(byId.get(broken)).toMatchObject({ outcome: 'failed', step: 'repository' });
    expect(byId.has(customer)).toBe(false);
    expect(byId.has(serverless)).toBe(false);
    expect(calls.some((c) => c.path.includes('/cust/'))).toBe(false);

    const second = await service.backfillProductionEnablement();
    for (const id of [ok, elsewhere]) {
      expect(second.find((e) => e.projectRepositoryId === id)?.result).toMatchObject({
        outcome: 'already_enabled',
      });
    }
  });
});
