import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { projectRepoRepository } from '@/lib/repositories/projectRepoRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { scipUploadCredentialService } from '@/lib/services/scipUploadCredentialService';
import { SEED_SOURCE_FLY_STARTER, SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import {
  ProjectRepoInvalidFieldError,
  ProjectRepoNotFoundError,
  ScipUploadActionsWriteError,
  ScipUploadCredentialRefusedError,
} from '@/lib/projectRepos/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  createRepositoryActionsConfigFake,
  type RepositoryActionsConfigFake,
} from '../helpers/repositoryActionsConfigFake';

// A REPOSITORY'S SCIP UPLOAD CREDENTIALS (Story MOTIR-12262 · MOTIR-12339) over real
// Postgres, through the REAL routes and service. The two outside systems are faked at
// their HTTP edges: motir-ai (a stateful copy of its three upload-credential routes)
// and GitHub (the shared repository-Actions fake, which opens every sealed secret).
// The one module mock is the session gate the routes call.
//
// What is pinned, each by running it:
//   1. the mint answers the token ONCE (201, no-store) and no row column and no
//      console line ever holds it;
//   2. on a Motir-hosted row the secret and two variables are written, the newest
//      mint wins, and the row names the installed credential; revoking it deletes all
//      three and clears the id BEFORE motir-ai's revoke; revoking another touches
//      nothing; a half-failed install still answers the token; two concurrent mints
//      leave the secret and the id naming the same credential;
//   3. on an imported row nothing at all is written to GitHub;
//   4. the three refusals keep motir-ai's codes, write nothing, and only the
//      unreachable one is retryable; a row with no repository is refused without a
//      motir-ai call;
//   5. `repository:manage` gates all three routes before any outside call.

const { requireCompliantWorkspaceContext } = vi.hoisted(() => ({
  requireCompliantWorkspaceContext: vi.fn(),
}));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantWorkspaceContext }));

const collection =
  await import('@/app/api/projects/[key]/repositories/[rowId]/scip-upload-credentials/route');
const revokeRoute =
  await import('@/app/api/projects/[key]/repositories/[rowId]/scip-upload-credentials/[credentialId]/revoke/route');

const MOTIR_ORG = 'motir-projects';
const INSTALLATION_ID = '556677';
const AI = 'http://motir-ai.test';
const UPLOAD_URL = 'https://codegraph.motir.co';

let fx: WorkItemFixture;
let repoActions: RepositoryActionsConfigFake;
/** Every outbound call, in order: `ai:<METHOD> <path>` or `github:<METHOD> <url>`. */
let outbound: string[];
let consoleLines: string[];
let tokens: string[];

// ── motir-ai, at its HTTP edge ─────────────────────────────────────────────────

interface FakeCredential {
  credentialId: string;
  name: string;
  displayPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}
/** The code graph's credentials, by `repoRef`. */
let held: Map<string, FakeCredential[]>;
/** Repositories the code graph has registered. */
let registered: Set<string>;
/** A problem the next motir-ai call answers instead. */
let nextProblem: { code: string; status: number } | null;
let issued: number;
/** Called inside a mint before it answers — a test's hook into the interleaving. */
let onMint: (() => Promise<void>) | null;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function problem(code: string, status: number): Response {
  return json(status, { type: `https://motir.co/errors/${code}`, title: code, status, code });
}

async function motirAi(url: URL, method: string, body: Record<string, unknown>) {
  outbound.push(`ai:${method} ${url.pathname}`);
  if (nextProblem) {
    const p = nextProblem;
    nextProblem = null;
    return problem(p.code, p.status);
  }
  const repoRef = String(
    method === 'GET' ? url.searchParams.get('repoRef') : (body['repoRef'] ?? ''),
  );
  if (!registered.has(repoRef)) return problem('codegraph_repository_not_registered', 409);
  const list = held.get(repoRef) ?? [];
  held.set(repoRef, list);
  if (url.pathname === '/v1/code-graph/upload-credentials' && method === 'POST') {
    if (list.filter((c) => c.revokedAt === null).length >= 5) {
      return problem('upload_credential_limit_reached', 409);
    }
    issued += 1;
    const token = `cgk_secret_token_${issued}_${'x'.repeat(30)}`;
    tokens.push(token);
    const credential: FakeCredential = {
      credentialId: `00000000-0000-4000-8000-00000000000${issued}`,
      name: String(body['name']),
      displayPrefix: token.slice(0, 12),
      createdAt: new Date(Date.UTC(2026, 10, 20 + issued)).toISOString(),
      revokedAt: null,
    };
    if (onMint) await onMint();
    list.push(credential);
    return json(
      201,
      {
        credentialId: credential.credentialId,
        name: credential.name,
        displayPrefix: credential.displayPrefix,
        token,
        repositoryId: 'cgr_repo_1',
        uploadUrl: UPLOAD_URL,
      },
      { 'cache-control': 'no-store' },
    );
  }
  if (url.pathname === '/v1/code-graph/upload-credentials' && method === 'GET') {
    return json(200, { repositoryId: 'cgr_repo_1', credentials: list });
  }
  const revoke = /^\/v1\/code-graph\/upload-credentials\/([^/]+)\/revoke$/.exec(url.pathname);
  if (revoke && method === 'POST') {
    const credential = list.find((c) => c.credentialId === decodeURIComponent(revoke[1]!));
    const revoked = credential !== undefined && credential.revokedAt === null;
    if (credential && revoked) credential.revokedAt = new Date().toISOString();
    return json(200, { credentialId: decodeURIComponent(revoke[1]!), revoked });
  }
  throw new Error(`unexpected motir-ai call: ${method} ${url.pathname}`);
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const raw = typeof init?.body === 'string' ? init.body : null;
      if (url.startsWith(AI)) {
        return motirAi(
          new URL(url),
          method,
          raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        );
      }
      outbound.push(`github:${method} ${url}`);
      if (url.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_provisioning',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      const handled = await repoActions.handle(url, method, raw);
      if (handled) return handled;
      throw new Error(`unexpected GitHub call: ${method} ${url}`);
    }),
  );
}

// ── Rows ───────────────────────────────────────────────────────────────────────

/** A row written directly, as the creation primitive or the add door leaves it. */
async function row(opts: { hosted?: boolean; realized?: boolean; name?: string } = {}) {
  const hosted = opts.hosted ?? true;
  const name = opts.name ?? (hosted ? 'acme-shop-web' : 'billing-service');
  const owner = hosted ? MOTIR_ORG : 'acme';
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: hosted ? INSTALLATION_ID : 'inst-acme' },
    create: {
      installationId: hosted ? INSTALLATION_ID : 'inst-acme',
      workspaceId: hosted ? null : fx.workspaceId,
      accountLogin: owner,
      accountType: 'Organization',
    },
    update: {},
  });
  const mirror =
    opts.realized === false
      ? null
      : await adminDb.githubRepo.create({
          data: {
            installationId: inst.id,
            workspaceId: fx.workspaceId,
            organizationId: fx.workspace.organizationId,
            repoId: `host-${name}`,
            owner,
            name,
            defaultBranch: 'main',
            archived: false,
          },
        });
  if (mirror) registered.add(`${owner}/${name}`);
  return adminDb.projectRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      role: 'web',
      name,
      seedSource: hosted ? SEED_SOURCE_FLY_STARTER : SEED_SOURCE_ORGANIZATION,
      state: hosted ? 'created' : 'connected',
      githubRepoId: mirror?.id ?? null,
      position: 'a0',
    },
  });
}

const params = (rowId: string) => ({ params: Promise.resolve({ key: 'PROD', rowId }) });
const mintReq = (body: unknown) =>
  new Request('http://localhost/api/projects/PROD/repositories/r/scip-upload-credentials', {
    method: 'POST',
    body: JSON.stringify(body),
  });

async function mint(rowId: string, name = 'GitHub Actions') {
  return collection.POST(mintReq({ name }), params(rowId));
}
async function list(rowId: string) {
  return collection.GET(new Request('http://localhost/x'), params(rowId));
}
async function revoke(rowId: string, credentialId: string) {
  return revokeRoute.POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ key: 'PROD', rowId, credentialId }),
  });
}

async function installedId(rowId: string): Promise<string | null> {
  const r = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: rowId } });
  return r.scipUploadInstalledCredentialId;
}

const HOSTED = `${MOTIR_ORG}/acme-shop-web`;

async function viewerCtx() {
  const viewer = await adminDb.user.create({
    data: { email: 'scip-viewer@example.com', name: 'Viewer', emailVerified: true },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: viewer.id, workspaceId: fx.workspaceId, workspaceRole: 'viewer' },
  });
  return { userId: viewer.id, workspaceId: fx.workspaceId };
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: fx.ctx });
  held = new Map();
  registered = new Set();
  nextProblem = null;
  issued = 0;
  onMint = null;
  outbound = [];
  tokens = [];
  consoleLines = [];
  repoActions = createRepositoryActionsConfigFake();
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('MOTIR_AI_URL', AI);
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'svc-token');
  _resetInstallationTokenCache();
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
    });
  }
  installFetch();
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

// ── 1 · The mint, and the token in no row or log ───────────────────────────────

describe('mint — the token once, and nowhere else', () => {
  it('answers 201 no-store with every field, and no column or console line holds the token', async () => {
    const r = await row();
    const res = await mint(r.id);
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      credentialId: '00000000-0000-4000-8000-000000000001',
      name: 'GitHub Actions',
      displayPrefix: tokens[0]!.slice(0, 12),
      revokedAt: null,
      token: tokens[0],
      repositoryId: 'cgr_repo_1',
      uploadUrl: UPLOAD_URL,
      installedInActions: true,
      installFailed: false,
    });
    expect(typeof body['createdAt']).toBe('string');

    const columns = await adminDb.projectRepo.findUniqueOrThrow({ where: { id: r.id } });
    expect(JSON.stringify(columns)).not.toContain(tokens[0]);
    expect(columns.scipUploadInstalledCredentialId).toBe(body['credentialId']);
    expect(consoleLines.join('\n')).not.toContain(tokens[0]);
  });

  it('refuses a blank name with 422 before any outside call', async () => {
    const r = await row();
    for (const body of [{ name: '   ' }, {}, null]) {
      const res = await collection.POST(mintReq(body), params(r.id));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        code: 'PROJECT_REPO_INVALID_FIELD',
        retryable: false,
      });
    }
    const notJson = new Request('http://localhost/x', { method: 'POST', body: '{nope' });
    expect((await collection.POST(notJson, params(r.id))).status).toBe(422);
    await expect(
      scipUploadCredentialService.mint(r.id, { name: ' ' }, fx.ctx),
    ).rejects.toBeInstanceOf(ProjectRepoInvalidFieldError);
    expect(outbound).toEqual([]);
  });

  it('answers motir-ai’s refusal of the name as 422', async () => {
    const r = await row();
    nextProblem = { code: 'validation_error', status: 400 };
    const res = await mint(r.id, 'x'.repeat(201));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'PROJECT_REPO_INVALID_FIELD' });
    expect(repoActions.calls).toEqual([]);
  });
});

// ── 2 · The hosted install ─────────────────────────────────────────────────────

describe('a Motir-hosted row — the repository’s Actions', () => {
  it('writes the sealed secret and both variables, and a second mint replaces all three', async () => {
    const r = await row();
    const first = (await (await mint(r.id)).json()) as Record<string, string>;
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokens[0]);
    expect(Object.fromEntries(repoActions.variables(HOSTED))).toEqual({
      MOTIR_CODEGRAPH_REPOSITORY_ID: 'cgr_repo_1',
      MOTIR_CODEGRAPH_UPLOAD_URL: UPLOAD_URL,
    });
    // The secret travelled only sealed.
    for (const call of repoActions.calls) expect(call.rawBody ?? '').not.toContain(tokens[0]);
    expect(await installedId(r.id)).toBe(first['credentialId']);

    const second = (await (await mint(r.id, 'Nightly')).json()) as Record<string, unknown>;
    expect(second['installedInActions']).toBe(true);
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokens[1]);
    expect(await installedId(r.id)).toBe(second['credentialId']);

    const listed = (await (await list(r.id)).json()) as {
      credentials: Array<Record<string, unknown>>;
    };
    expect(listed.credentials.map((c) => [c['name'], c['installedInActions']])).toEqual([
      ['GitHub Actions', false],
      ['Nightly', true],
    ]);
    expect(JSON.stringify(listed)).not.toContain('token');
  });

  it('revoking the installed credential deletes all three and clears the id BEFORE motir-ai revokes', async () => {
    const r = await row();
    const minted = (await (await mint(r.id)).json()) as Record<string, string>;
    outbound.length = 0;

    const res = await revoke(r.id, minted['credentialId']!);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ credentialId: minted['credentialId'], revoked: true });
    expect(repoActions.secrets(HOSTED).size).toBe(0);
    expect(repoActions.variables(HOSTED).size).toBe(0);
    expect(await installedId(r.id)).toBeNull();

    const deletes = outbound
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.startsWith('github:DELETE'));
    const aiRevoke = outbound.findIndex((e) => e.startsWith('ai:POST') && e.endsWith('/revoke'));
    expect(deletes).toHaveLength(3);
    for (const { index } of deletes) expect(index).toBeLessThan(aiRevoke);

    // A repeat answers revoked false and touches no repository.
    outbound.length = 0;
    const again = await revoke(r.id, minted['credentialId']!);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ credentialId: minted['credentialId'], revoked: false });
    expect(outbound.filter((e) => e.startsWith('github:'))).toEqual([]);
  });

  it('a mint that landed before the revoke took the lock keeps its secret', async () => {
    const r = await row();
    const minted = (await (await mint(r.id)).json()) as Record<string, string>;
    vi.spyOn(projectRepoRepository, 'findForScipUploadUpdate').mockResolvedValueOnce({
      id: r.id,
      scipUploadInstalledCredentialId: 'a-newer-credential',
    });
    outbound.length = 0;
    expect((await revoke(r.id, minted['credentialId']!)).status).toBe(200);
    expect(outbound.filter((e) => e.startsWith('github:DELETE'))).toEqual([]);
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokens[0]);
  });

  it('revoking a credential that is not installed deletes nothing', async () => {
    const r = await row();
    const old = (await (await mint(r.id, 'Old')).json()) as Record<string, string>;
    const current = (await (await mint(r.id, 'Current')).json()) as Record<string, string>;
    outbound.length = 0;

    expect((await revoke(r.id, old['credentialId']!)).status).toBe(200);
    expect(outbound.filter((e) => e.startsWith('github:'))).toEqual([]);
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokens[1]);
    expect(await installedId(r.id)).toBe(current['credentialId']);
  });

  it('a GitHub delete that fails leaves the credential unrevoked and the row naming it, and a retry finishes', async () => {
    const r = await row();
    const minted = (await (await mint(r.id)).json()) as Record<string, string>;
    repoActions.failNext('DELETE', '/variables/MOTIR_CODEGRAPH_UPLOAD_URL', 500);
    outbound.length = 0;

    const res = await revoke(r.id, minted['credentialId']!);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      code: 'SCIP_UPLOAD_ACTIONS_WRITE_FAILED',
      retryable: true,
    });
    await expect(
      scipUploadCredentialService.revoke(r.id, minted['credentialId']!, fx.ctx),
    ).resolves.toEqual({ credentialId: minted['credentialId'], revoked: true });
    expect(outbound.some((e) => e.endsWith('/revoke'))).toBe(true);
    expect(repoActions.variables(HOSTED).size).toBe(0);
    expect(await installedId(r.id)).toBeNull();
  });

  it('a refused secret write still answers the token, installFailed, and leaves the id', async () => {
    const r = await row();
    repoActions.failNext('PUT', '/secrets/MOTIR_SCIP_UPLOAD_TOKEN', 403);
    const res = await mint(r.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token: tokens[0],
      installedInActions: false,
      installFailed: true,
    });
    expect(await installedId(r.id)).toBeNull();
    // The credential was NOT revoked.
    expect(outbound.some((e) => e.endsWith('/revoke'))).toBe(false);
  });

  it('a refused variable write after the secret answers installFailed while the row names the new credential', async () => {
    const r = await row();
    repoActions.failNext('POST', '/actions/variables', 500);
    const body = (await (await mint(r.id)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ installedInActions: true, installFailed: true });
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokens[0]);
    expect(await installedId(r.id)).toBe(body['credentialId']);
  });

  it('answers installFailed, with no GitHub write, when the installation is no longer on record', async () => {
    const r = await row();
    vi.spyOn(githubInstallationRepository, 'findHostInstallationIdsByIds').mockResolvedValue(
      new Map(),
    );
    const body = (await (await mint(r.id)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      token: tokens[0],
      installedInActions: false,
      installFailed: true,
    });
    expect(repoActions.calls).toEqual([]);
  });

  it('answers installFailed when the locked transaction does not commit', async () => {
    const r = await row();
    vi.spyOn(projectRepoRepository, 'findForScipUploadUpdate').mockRejectedValueOnce(
      new Error('lock timeout'),
    );
    const body = (await (await mint(r.id)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ installedInActions: false, installFailed: true });
    expect(await installedId(r.id)).toBeNull();
  });

  it('answers installFailed when the row is gone under the lock', async () => {
    const r = await row();
    vi.spyOn(projectRepoRepository, 'findForScipUploadUpdate').mockResolvedValueOnce(null);
    const body = (await (await mint(r.id)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ installedInActions: false, installFailed: true });
    expect(repoActions.calls).toEqual([]);
  });

  it('two mints started together leave the secret and the recorded id naming the same credential', async () => {
    const r = await row();
    const [a, b] = await Promise.all([mint(r.id, 'A'), mint(r.id, 'B')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const id = await installedId(r.id);
    const credential = held.get(HOSTED)!.find((c) => c.credentialId === id)!;
    const tokenOf = tokens[Number(credential.credentialId.slice(-1)) - 1];
    expect(repoActions.secrets(HOSTED).get('MOTIR_SCIP_UPLOAD_TOKEN')).toBe(tokenOf);
  });

  it('removeFromRepository deletes all three unconditionally and clears the id', async () => {
    const r = await row();
    await mint(r.id);
    await scipUploadCredentialService.removeFromRepository(r.id);
    expect(repoActions.secrets(HOSTED).size).toBe(0);
    expect(repoActions.variables(HOSTED).size).toBe(0);
    expect(await installedId(r.id)).toBeNull();
    // Idempotent: a repeat deletes nothing that is there and does not throw.
    await expect(scipUploadCredentialService.removeFromRepository(r.id)).resolves.toBeUndefined();
    // The credential was not revoked at the code graph.
    expect(held.get(HOSTED)![0]!.revokedAt).toBeNull();
  });

  it('removeFromRepository does nothing for a missing, unrealized or imported row', async () => {
    const unrealized = await row({ realized: false, name: 'nothing-yet' });
    const imported = await row({ hosted: false });
    outbound.length = 0;
    await scipUploadCredentialService.removeFromRepository('no-such-row');
    await scipUploadCredentialService.removeFromRepository(unrealized.id);
    await scipUploadCredentialService.removeFromRepository(imported.id);
    expect(outbound).toEqual([]);
  });
});

// ── 3 · The imported row ───────────────────────────────────────────────────────

describe('an imported row — nothing written into the repository', () => {
  it('mints with no GitHub call at all, and lists every credential uninstalled', async () => {
    const r = await row({ hosted: false });
    const body = (await (await mint(r.id, 'Buildkite')).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      installedInActions: false,
      installFailed: false,
      token: tokens[0],
    });
    const listed = (await (await list(r.id)).json()) as {
      credentials: Array<Record<string, unknown>>;
    };
    expect(listed.credentials).toEqual([
      expect.objectContaining({ name: 'Buildkite', installedInActions: false }),
    ]);
    expect((await revoke(r.id, String(body['credentialId']))).status).toBe(200);
    expect(outbound.filter((e) => e.startsWith('github:'))).toEqual([]);
    expect(await installedId(r.id)).toBeNull();
  });
});

// ── 4 · The refusals ───────────────────────────────────────────────────────────

describe('the refusals — motir-ai’s codes, nothing written', () => {
  it.each([
    ['codegraph_repository_not_registered', 409, 409, false],
    ['upload_credential_limit_reached', 409, 409, false],
    ['codegraph_unavailable', 503, 503, true],
  ] as const)('%s answers %i and writes nothing', async (code, aiStatus, status, retryable) => {
    const r = await row();
    nextProblem = { code, status: aiStatus };
    const res = await mint(r.id);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code, retryable });
    expect(repoActions.calls).toEqual([]);
    expect(await installedId(r.id)).toBeNull();
  });

  it('a sixth live credential is refused with the limit code', async () => {
    const r = await row();
    for (let i = 0; i < 5; i += 1) expect((await mint(r.id, `c${i}`)).status).toBe(201);
    const res = await mint(r.id, 'c5');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'upload_credential_limit_reached' });
  });

  it('motir-ai unreachable reads codegraph_unavailable on list and revoke too', async () => {
    const r = await row();
    vi.stubEnv('MOTIR_AI_URL', 'http://127.0.0.1:1');
    for (const res of [await list(r.id), await revoke(r.id, 'c1')]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ code: 'codegraph_unavailable', retryable: true });
    }
  });

  it('a row with no realized repository is not registered, with no motir-ai call', async () => {
    const r = await row({ realized: false, name: 'not-yet' });
    for (const res of [await mint(r.id), await list(r.id), await revoke(r.id, 'c1')]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'codegraph_repository_not_registered',
        retryable: false,
      });
    }
    expect(outbound).toEqual([]);
  });

  it('a malformed motir-ai answer is the unreachable refusal, never a cast', async () => {
    const r = await row();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(200, { credentials: [{ credentialId: 'c1' }] })),
    );
    const res = await list(r.id);
    expect(res.status).toBe(503);
  });

  it('an unknown row answers 404', async () => {
    const res = await list('no-such-row');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ retryable: false });
    await expect(scipUploadCredentialService.list('no-such-row', fx.ctx)).rejects.toBeInstanceOf(
      ProjectRepoNotFoundError,
    );
  });

  it('an error with no mapping is rethrown by every route', async () => {
    const r = await row();
    const boom = new Error('unmapped');
    vi.spyOn(scipUploadCredentialService, 'mint').mockRejectedValueOnce(boom);
    vi.spyOn(scipUploadCredentialService, 'list').mockRejectedValueOnce(boom);
    vi.spyOn(scipUploadCredentialService, 'revoke').mockRejectedValueOnce(boom);
    await expect(mint(r.id)).rejects.toBe(boom);
    await expect(list(r.id)).rejects.toBe(boom);
    await expect(revoke(r.id, 'c1')).rejects.toBe(boom);
  });

  it('rethrows an error that is not a motir-ai answer', async () => {
    const r = await row();
    vi.stubEnv('MOTIR_AI_URL', '');
    await expect(list(r.id)).rejects.toThrow(/MOTIR_AI_URL/);
  });

  it('keeps the typed errors’ shape', () => {
    expect(new ScipUploadCredentialRefusedError('codegraph_unavailable')).toMatchObject({
      httpStatus: 503,
      retryable: true,
    });
    expect(new ScipUploadActionsWriteError('x').code).toBe('SCIP_UPLOAD_ACTIONS_WRITE_FAILED');
  });
});

// ── 5 · The permission ─────────────────────────────────────────────────────────

describe('repository:manage gates all three routes', () => {
  it('refuses a viewer with 403 and makes no motir-ai or GitHub call', async () => {
    const r = await row();
    requireCompliantWorkspaceContext.mockResolvedValue({ ok: true, ctx: await viewerCtx() });
    for (const res of [await mint(r.id), await list(r.id), await revoke(r.id, 'c1')]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ retryable: false });
    }
    expect(outbound).toEqual([]);
  });

  it('answers the gate’s own response with no session', async () => {
    const r = await row();
    requireCompliantWorkspaceContext.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 401 }),
    });
    expect((await mint(r.id)).status).toBe(401);
    expect((await list(r.id)).status).toBe(401);
    expect((await revoke(r.id, 'c1')).status).toBe(401);
    expect(outbound).toEqual([]);
  });
});
