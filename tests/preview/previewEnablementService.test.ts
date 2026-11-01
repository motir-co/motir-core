import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeHostingDeployPort,
  type FakeDatabaseControls,
  type FakeHostingControls,
  type HostingDeployPort,
} from '@motir/orchestrator';
import { db } from '@/lib/db';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { getDatabasePort, resetDatabaseFakes } from '@/lib/orchestrator/database';
import {
  getHostingDeployPort,
  registerHostingAdapter,
  resetHostingFakes,
  unregisterHostingAdapter,
} from '@/lib/orchestrator/hosting';
import { PreviewDisableError } from '@/lib/preview/errors';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { previewEnablementService } from '@/lib/services/previewEnablementService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import {
  createActionsVariableFake,
  type ActionsVariableFake,
} from '../helpers/actionsVariableFake';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';

// SWITCHING PREVIEWS ON AND OFF over real Postgres (Story MOTIR-5766 ·
// MOTIR-5775). The deploy port and the database port are the orchestrator's
// fakes (`MOTIR_FLEET_ORCHESTRATOR=fake`); GitHub is `fetch`, served by the
// stateful repository Actions fake — which opens each sealed secret, so a test
// can prove the value arrived AND that no request carried it in the clear — and
// the org-variable fake.

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
// The fake deploy port's clock starts 2026-01-01 and its tokens live 90 days, so
// a token minted "now" has 76 days left at this instant: current, not due.
const NOW = new Date('2026-01-15T12:00:00.000Z');

let github: RepositoryActionsConfigFake;
let orgVariables: ActionsVariableFake;
let fetches: Array<{ url: string; method: string; rawBody: string | null }>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installGitHub(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const rawBody = typeof init?.body === 'string' ? init.body : null;
      fetches.push({ url: u, method, rawBody });
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const repoConfig = await github.handle(u, method, rawBody);
      if (repoConfig) return repoConfig;
      const orgVariable = orgVariables.handle(u, method, rawBody ? JSON.parse(rawBody) : null);
      if (orgVariable) return orgVariable;
      // `attachRealizedRepo`'s post-commit collaborator invitation (MOTIR-1900).
      if (u.endsWith(`/orgs/${MOTIR_ORG}/installation`)) {
        return json(200, { id: Number(INSTALLATION_ID) });
      }
      if (u.includes('/collaborators/')) return json(201, { id: 1, html_url: 'https://x' });
      throw new Error(`unexpected fetch: ${method} ${u}`);
    }),
  );
}

/** A Motir-created row through the real machine, realized in Motir's org. */
async function motirRow(
  fx: WorkItemFixture,
  name: string,
  options: { target?: 'fly' | 'serverless' | 'aws' | null; role?: 'web' | 'api' } = {},
): Promise<string> {
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: INSTALLATION_ID },
    create: {
      installationId: INSTALLATION_ID,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}`,
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(
    fx.projectId,
    { role: options.role ?? 'web', name },
    fx.ctx,
  );
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  const target = options.target === undefined ? 'fly' : options.target;
  if (target) {
    await projectRepoSetService.setHosting(
      row.id,
      { target, useCase: 'mvp', size: 'small' },
      fx.ctx,
    );
  }
  return row.id;
}

/** A row the organisation CONNECTED — the user's own repository. */
async function connectedRow(fx: WorkItemFixture, name: string): Promise<string> {
  const installation = await adminDb.githubInstallation.create({
    data: {
      installationId: `user-${name}`,
      workspaceId: fx.workspaceId,
      accountLogin: 'yue-personal',
      accountType: 'User',
    },
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}`,
      owner: 'yue-personal',
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
  await projectRepoSetService.setHosting(
    row.id,
    { target: 'fly', useCase: 'mvp', size: 'small' },
    fx.ctx,
  );
  return row.id;
}

const fly = () => getHostingDeployPort('fly') as HostingDeployPort & FakeHostingControls;
const neon = () => getDatabasePort('neon') as unknown as FakeDatabaseControls;
const full = (name: string) => `${MOTIR_ORG}/${name}`;
const now = () => NOW;

async function record(rowId: string) {
  return adminDb.projectRepo.findUniqueOrThrow({
    where: { id: rowId },
    select: {
      previewPushNamespace: true,
      previewEnabledAt: true,
      previewCredentialExpiresAt: true,
    },
  });
}

const actionsCalls = () => fetches.filter((f) => /\/actions\/(secrets|variables)/.test(f.url));

beforeEach(async () => {
  await truncateAuthTables();
  fetches = [];
  github = createRepositoryActionsConfigFake();
  orgVariables = createActionsVariableFake(MOTIR_ORG);
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', 'fake');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  resetHostingFakes();
  resetDatabaseFakes();
  installGitHub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('enable', () => {
  it('makes the push namespace, writes the sealed token, the variables, the org switch, the Neon preview project and the record', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');

    expect(await previewEnablementService.enable(rowId, { now })).toEqual({
      repositoryId: rowId,
      outcome: 'enabled',
    });

    const namespace = `mh-${rowId}-pv`;
    expect(fly().pushNamespaces()).toEqual([namespace]);
    expect(fly().mintedFor).toEqual([namespace]);
    expect(github.secrets(full('acme-web')).get('MOTIR_FLY_PREVIEW_PUSH_TOKEN')).toBe(
      `fake-deploy-token-${namespace}`,
    );
    expect(Object.fromEntries(github.variables(full('acme-web')))).toEqual({
      MOTIR_HOSTING_TARGET: 'fly',
      MOTIR_HOSTING_IMAGE_PREVIEW: `registry.fake.invalid/${namespace}`,
    });
    expect(orgVariables.variables.get('MOTIR_HOSTING_BUILD')).toMatchObject({ value: 'on' });
    expect(
      neon()
        .databases()
        .map((d) => d.handle.applicationRef),
    ).toEqual([`${rowId}-pv`]);
    expect(await record(rowId)).toEqual({
      previewPushNamespace: namespace,
      previewEnabledAt: NOW,
      previewCredentialExpiresAt: expect.any(Date),
    });
  });

  it('a second enable creates, mints and writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    await previewEnablementService.enable(rowId, { now });
    const writes = actionsCalls().length;

    expect(await previewEnablementService.enable(rowId, { now })).toEqual({
      repositoryId: rowId,
      outcome: 'already_enabled',
    });
    expect(fly().pushNamespaces()).toHaveLength(1);
    expect(fly().mintedFor).toHaveLength(1);
    expect(actionsCalls()).toHaveLength(writes);
    expect(github.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('re-mints a token with under 14 days left, keeping when it was first enabled', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    await previewEnablementService.enable(rowId, { now });
    await adminDb.projectRepo.update({
      where: { id: rowId },
      data: { previewCredentialExpiresAt: new Date(NOW.getTime() + 10 * 86_400_000) },
    });

    expect((await previewEnablementService.enable(rowId, { now })).outcome).toBe('renewed');
    expect(fly().mintedFor).toHaveLength(2);
    expect(github.calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
    expect((await record(rowId)).previewEnabledAt).toEqual(NOW);
  });

  it('never puts the plaintext token in a request body, a log line or a thrown error', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    const token = `fake-deploy-token-mh-${rowId}-pv`;
    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (a instanceof Error ? `${a.message}` : String(a))).join(' '));
      });
    }

    // The secret write refused: enable throws, enableQuietly logs.
    github.failNext('PUT', '/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN', 422);
    const thrown = await previewEnablementService.enable(rowId, { now }).catch((e: unknown) => e);
    expect(thrown).toMatchObject({ code: 'REPOSITORY_ACTIONS_CONFIG_FAILED', status: 422 });
    github.failNext('PUT', '/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN', 422);
    expect(await previewEnablementService.enableQuietly(rowId, { now })).toBeNull();
    // And then it goes through.
    expect((await previewEnablementService.enable(rowId, { now })).outcome).toBe('enabled');
    expect(github.secrets(full('acme-web')).get('MOTIR_FLY_PREVIEW_PUSH_TOKEN')).toBe(token);

    for (const call of fetches) expect(call.rawBody ?? '').not.toContain(token);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) expect(line).not.toContain(token);
    expect(`${String(thrown)} ${JSON.stringify(thrown)}`).not.toContain(token);
  });

  it('records the namespace before minting, so a failure after the mint leaves a row disable can clean', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    github.failNext('PUT', '/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN', 503);
    await expect(previewEnablementService.enable(rowId, { now })).rejects.toBeDefined();
    expect(await record(rowId)).toEqual({
      previewPushNamespace: `mh-${rowId}-pv`,
      previewEnabledAt: null,
      previewCredentialExpiresAt: null,
    });
    expect(fly().liveCredentials(`mh-${rowId}-pv`)).toBe(1);
  });

  it('writes a federated credential as the role variable, with no secret and no expiry, and no Neon project on AWS', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fake = createFakeHostingDeployPort({ target: 'aws' });
    registerHostingAdapter('aws', () => ({
      ...fake,
      mintDeployCredential: async ({ pushNamespace }) => ({
        kind: 'federated' as const,
        pushNamespace,
        subject: `arn:aws:iam::111122223333:role/${pushNamespace}-push`,
      }),
    }));
    try {
      const fx = await makeWorkItemFixture();
      const rowId = await motirRow(fx, 'acme-tool', { target: 'aws' });
      expect((await previewEnablementService.enable(rowId, { now })).outcome).toBe('enabled');
      expect(github.secrets(full('acme-tool')).size).toBe(0);
      expect(github.variables(full('acme-tool')).get('MOTIR_HOSTING_AWS_PREVIEW_ROLE_ARN')).toBe(
        `arn:aws:iam::111122223333:role/mh-${rowId}-pv-push`,
      );
      expect(github.variables(full('acme-tool')).get('MOTIR_HOSTING_TARGET')).toBe('aws');
      expect((await record(rowId)).previewCredentialExpiresAt).toBeNull();
      // A credential that never expires is never due.
      expect((await previewEnablementService.enable(rowId, { now })).outcome).toBe(
        'already_enabled',
      );
    } finally {
      unregisterHostingAdapter('aws');
    }
  });

  it('switches nothing on for a connected repository, a non-web seed, or a row with no target', async () => {
    const fx = await makeWorkItemFixture();
    const connected = await connectedRow(fx, 'their-web');
    const initialised = await motirRow(fx, 'acme-api', { role: 'api' });
    const untargeted = await motirRow(fx, 'acme-site', { target: null });
    // A non-web row seeds from its foundation (or is initialised): never a web starter.
    expect(
      (await adminDb.projectRepo.findUniqueOrThrow({ where: { id: initialised } })).seedSource,
    ).not.toBe(SEED_SOURCE_PLATFORM_STARTER);

    expect(await previewEnablementService.enable(connected, { now })).toMatchObject({
      outcome: 'ineligible',
      reason: 'not_motir_created',
    });
    expect(await previewEnablementService.enable(initialised, { now })).toMatchObject({
      outcome: 'ineligible',
      reason: 'not_a_web_starter',
    });
    expect(await previewEnablementService.enable(untargeted, { now })).toMatchObject({
      outcome: 'ineligible',
      reason: 'no_hosting_target',
    });
    expect(await previewEnablementService.enable('cm-no-such-row', { now })).toEqual({
      repositoryId: 'cm-no-such-row',
      outcome: 'not_found',
    });
    expect(fly().pushNamespaces()).toEqual([]);
    expect(fly().mintedFor).toEqual([]);
    expect(actionsCalls()).toEqual([]);
    expect(orgVariables.calls).toEqual([]);
  });
});

describe('disable', () => {
  it('revokes the token, deletes the secret and variables, clears the record — and leaves the org switch', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    await previewEnablementService.enable(rowId, { now });

    expect(await previewEnablementService.disable(rowId)).toBe('disabled');
    expect(fly().liveCredentials(`mh-${rowId}-pv`)).toBe(0);
    expect(github.secrets(full('acme-web')).size).toBe(0);
    expect(github.variables(full('acme-web')).size).toBe(0);
    expect(await record(rowId)).toEqual({
      previewPushNamespace: null,
      previewEnabledAt: null,
      previewCredentialExpiresAt: null,
    });
    expect(orgVariables.variables.get('MOTIR_HOSTING_BUILD')).toMatchObject({ value: 'on' });
    // Again: every step finds its end state already reached.
    expect(await previewEnablementService.disable(rowId)).toBe('disabled');
  });

  it('surfaces a failed revoke and a failed secret delete by step, and changes the record in neither', async () => {
    const fx = await makeWorkItemFixture();
    const rowId = await motirRow(fx, 'acme-web');
    await previewEnablementService.enable(rowId, { now });

    fly().failNext('revokeDeployCredentials');
    const revoke = await previewEnablementService.disable(rowId).catch((e: unknown) => e);
    expect(revoke).toBeInstanceOf(PreviewDisableError);
    expect(revoke).toMatchObject({ step: 'revoke_push_credentials' });
    expect(github.secrets(full('acme-web')).size).toBe(1);

    github.failNext('DELETE', '/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN', 403);
    await expect(previewEnablementService.disable(rowId)).rejects.toMatchObject({
      step: 'delete_push_secret',
    });
    github.failNext('DELETE', '/variables/MOTIR_HOSTING_TARGET', 403);
    await expect(previewEnablementService.disable(rowId)).rejects.toMatchObject({
      step: 'delete_variables',
    });
    expect((await record(rowId)).previewEnabledAt).toEqual(NOW);
  });

  it('makes no call for a row that could never have been enabled, or one that does not exist', async () => {
    const fx = await makeWorkItemFixture();
    const connected = await connectedRow(fx, 'their-web');
    expect(await previewEnablementService.disable(connected)).toBe('nothing_to_disable');
    expect(await previewEnablementService.disable('cm-no-such-row')).toBe('not_found');
    expect(actionsCalls()).toEqual([]);
  });
});

describe('sweep — the backfill', () => {
  it('enables every eligible repository, skips the rest, reports each, and is a no-op the second time', async () => {
    const fx = await makeWorkItemFixture();
    const a = await motirRow(fx, 'acme-web');
    const b = await motirRow(fx, 'acme-admin', { target: 'serverless' });
    const failing = await motirRow(fx, 'acme-docs');
    const skipped = [
      await motirRow(fx, 'acme-api', { role: 'api' }),
      await motirRow(fx, 'acme-site', { target: null }),
      await connectedRow(fx, 'their-web'),
    ];
    github.failNext(
      'PUT',
      '/repos/motir-projects/acme-docs/actions/secrets/MOTIR_FLY_PREVIEW_PUSH_TOKEN',
      503,
    );

    const first = await previewEnablementService.sweep({ now });
    expect(first.rows).toEqual([
      { repositoryId: a, outcome: 'enabled' },
      { repositoryId: b, outcome: 'enabled' },
      { repositoryId: failing, outcome: 'failed', errorCode: 'REPOSITORY_ACTIONS_CONFIG_FAILED' },
    ]);
    for (const id of skipped) expect((await record(id)).previewEnabledAt).toBeNull();

    // The failed one is retried; the enabled ones are not visited.
    expect((await previewEnablementService.sweep({ now })).rows).toEqual([
      { repositoryId: failing, outcome: 'enabled' },
    ]);
    expect((await previewEnablementService.sweep({ now })).rows).toEqual([]);
  });
});

describe('failures that are not typed errors', () => {
  it('reports a thrown non-error as UNKNOWN and an untyped error by its name, and disable names the step', async () => {
    vi.stubEnv('MOTIR_FLEET_ORCHESTRATOR', '');
    const fake = createFakeHostingDeployPort({ target: 'aws' });
    let throwing: unknown = 'not an error';
    registerHostingAdapter('aws', () => ({
      ...fake,
      ensurePushNamespace: async () => {
        throw throwing;
      },
      revokeDeployCredentials: async () => {
        throw throwing;
      },
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fx = await makeWorkItemFixture();
      const first = await motirRow(fx, 'acme-tool', { target: 'aws' });
      expect((await previewEnablementService.sweep()).rows).toEqual([
        { repositoryId: first, outcome: 'failed', errorCode: 'UNKNOWN' },
      ]);
      throwing = new TypeError('broken');
      expect((await previewEnablementService.sweep()).rows).toEqual([
        { repositoryId: first, outcome: 'failed', errorCode: 'TypeError' },
      ]);
      expect(await previewEnablementService.enableQuietly(first)).toBeNull();

      await adminDb.projectRepo.update({
        where: { id: first },
        data: { previewPushNamespace: `mh-${first}-pv` },
      });
      throwing = 42;
      await expect(previewEnablementService.disable(first)).rejects.toMatchObject({
        step: 'revoke_push_credentials',
        message: expect.stringContaining('unknown'),
      });
    } finally {
      unregisterHostingAdapter('aws');
    }
  });

  it('answers a missing row on the wall clock too', async () => {
    expect(await previewEnablementService.enable('cm-no-such-row')).toMatchObject({
      outcome: 'not_found',
    });
  });
});
