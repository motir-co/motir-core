import { generateKeyPairSync } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { encodeInstallState, type InstallState } from '@/lib/github/installState';
import { GithubUserInstallationsError } from '@/lib/github/userInstallations';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// ONE GITHUB ACCOUNT, MANY ORGANISATIONS — the connect flow's HTTP surface
// (Story MOTIR-8216 · MOTIR-8220), against a real Postgres. GitHub is faked at
// `fetch`, the one boundary every GitHub client here goes through; the session
// gate is mocked because the test environment has no cookies.
//
// The account `acme` (installation 4242) holds repositories 1..5.
// Organisation X links 1 and 2; organisation Y is the second tenant.

const PASSWORD = 'hunter2hunter2';
const SECRET = 'test-better-auth-secret-abcdef0123456789';
const INSTALLATION = '4242';

const session: { userId: string | null } = { userId: null };
const workspace: { id: string | null } = { id: null };

vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantSession: async () =>
    session.userId
      ? { ok: true, session: { user: { id: session.userId } } }
      : { ok: false, response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) },
  resolveTwoFactorHold: async () => null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    session.userId && workspace.id ? { userId: session.userId, workspaceId: workspace.id } : null,
}));

const accountsRoute = await import('@/app/api/organizations/[orgId]/github/accounts/route');
const reposRoute =
  await import('@/app/api/organizations/[orgId]/github/accounts/[installationId]/repositories/route');
const installationsRoute =
  await import('@/app/api/organizations/[orgId]/github/installations/route');
const installUrlRoute = await import('@/app/api/organizations/[orgId]/github/install-url/route');
const setupRoute = await import('@/app/api/github/setup/route');

/** Installations each user token can see on GitHub, by token. */
let userInstallations: Record<string, { id: number; login: string }[]> = {};
/** How GitHub answers `GET /user/installations` for a token it does not serve
 *  normally (Bug MOTIR-8984): a status it answers with, or `network` for a
 *  transport failure. */
let userInstallationsFailure: Record<string, number | 'network'> = {};

function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_APP_SLUG', 'motir-test');
  const json = (o: unknown): Response =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/user/installations')) {
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        const token = auth.replace(/^Bearer /, '');
        const failure = userInstallationsFailure[token];
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure !== undefined) {
          return new Response(
            JSON.stringify({
              message: failure === 401 ? 'Bad credentials' : 'Service Unavailable',
            }),
            { status: failure, headers: { 'content-type': 'application/json' } },
          );
        }
        return json({
          installations: (userInstallations[token] ?? []).map((i) => ({
            id: i.id,
            app_id: 999,
            repository_selection: 'selected',
            account: { login: i.login, type: 'Organization', avatar_url: null },
          })),
        });
      }
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_app',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: [1, 2, 3, 4, 5].map((id) => ({
            id,
            name: `r${id}`,
            owner: { login: 'acme' },
            default_branch: 'main',
          })),
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

interface Org {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}

async function makeOrg(email: string): Promise<Org> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace: ws } = await workspacesService.createWorkspace({
    name: email,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  return { organizationId: row.organizationId, workspaceId: ws.id, ownerId: user.id };
}

async function connectIdentity(userId: string, token: string): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: `login-${userId}`,
      accessTokenEncrypted: encryptToken(token),
    },
  });
}

function signIn(org: Org, userId = org.ownerId): void {
  session.userId = userId;
  workspace.id = org.workspaceId;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function getAccounts(orgId: string): Promise<Response> {
  return accountsRoute.GET(new Request('http://localhost/x'), params({ orgId }));
}
async function getRepos(orgId: string, installationId = INSTALLATION): Promise<Response> {
  return reposRoute.GET(new Request('http://localhost/x'), params({ orgId, installationId }));
}
async function postLink(orgId: string, body: unknown): Promise<Response> {
  return installationsRoute.POST(
    new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }),
    params({ orgId }),
  );
}
async function setup(state: string, installationId = INSTALLATION): Promise<URL> {
  const res = await setupRoute.GET(
    new NextRequest(
      `http://localhost:3000/api/github/setup?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    ),
  );
  return new URL(res.headers.get('location')!);
}

async function ownedBy(organizationId: string): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

let x: Org;
let y: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  stubGithub();
  spyOnJobDispatch();
  x = await makeOrg('x@example.com');
  y = await makeOrg('y@example.com');
  await connectIdentity(x.ownerId, 'gho_x');
  await connectIdentity(y.ownerId, 'gho_y');
  userInstallations = {
    gho_x: [{ id: 4242, login: 'acme' }],
    gho_y: [{ id: 4242, login: 'acme' }],
  };
  userInstallationsFailure = {};
  await githubInstallationService.linkInstallationToOrganization({
    workspaceId: x.workspaceId,
    installationId: INSTALLATION,
    repoIds: ['1', '2'],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  session.userId = null;
  workspace.id = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the install state carries the organisation', () => {
  it('round-trips `g`, and a token without it still decodes with no organisation', async () => {
    const { decodeInstallStateResult } = await import('@/lib/github/installState');
    const withOrg = encodeInstallState({ workspaceId: 'w', userId: 'u', organizationId: 'org_1' });
    expect(decodeInstallStateResult(withOrg)).toEqual({
      ok: true,
      issuedAt: expect.any(Number),
      state: { workspaceId: 'w', userId: 'u', organizationId: 'org_1' },
    });
    const old = encodeInstallState({ workspaceId: 'w', userId: 'u' });
    expect(decodeInstallStateResult(old)).toEqual({
      ok: true,
      issuedAt: expect.any(Number),
      state: { workspaceId: 'w', userId: 'u' },
    });
    const [b64, sig] = withOrg.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(b64!, 'base64url').toString()), g: 'org_2' }),
    ).toString('base64url');
    expect(decodeInstallStateResult(`${forged}.${sig}`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const expired = encodeInstallState(
      { workspaceId: 'w', userId: 'u', organizationId: 'org_1' },
      Math.floor(Date.now() / 1000) - 1000,
    );
    expect(decodeInstallStateResult(expired)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('GET accounts', () => {
  it('marks the account linked_here for X and not_linked for Y', async () => {
    signIn(x);
    const forX = (await (await getAccounts(x.organizationId)).json()) as {
      state: string;
      accounts: { installationId: string; linkState: string; visibleRepoCount: number }[];
    };
    expect(forX.state).toBe('ok');
    expect(forX.accounts).toMatchObject([
      { installationId: INSTALLATION, linkState: 'linked_here', visibleRepoCount: 5 },
    ]);
    signIn(y);
    const forY = (await (await getAccounts(y.organizationId)).json()) as typeof forX;
    expect(forY.accounts).toMatchObject([
      { installationId: INSTALLATION, linkState: 'not_linked' },
    ]);
  });

  it('lists only what GitHub says the actor can see, and never the shared provisioning installation', async () => {
    await adminDb.githubInstallation.create({
      data: {
        installationId: '777',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
      },
    });
    userInstallations['gho_y'] = [
      { id: 4242, login: 'acme' },
      { id: 777, login: 'motir-projects' },
    ];
    signIn(y);
    const body = (await (await getAccounts(y.organizationId)).json()) as {
      accounts: { installationId: string }[];
    };
    expect(body.accounts.map((a) => a.installationId)).toEqual([INSTALLATION]);
    userInstallations['gho_y'] = [];
    const none = (await (await getAccounts(y.organizationId)).json()) as typeof body;
    expect(none.accounts).toEqual([]);
  });

  it('still lists an account whose installation row is gone, and linking re-creates it', async () => {
    await adminDb.githubInstallation.deleteMany({});
    signIn(y);
    const body = (await (await getAccounts(y.organizationId)).json()) as {
      accounts: { installationId: string; linkState: string }[];
    };
    expect(body.accounts).toMatchObject([
      { installationId: INSTALLATION, linkState: 'not_linked' },
    ]);
    const res = await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['3'] });
    expect(res.status).toBe(200);
    expect(
      await adminDb.githubInstallation.count({ where: { installationId: INSTALLATION } }),
    ).toBe(1);
  });

  it('answers identity_required when the actor has no linked GitHub identity', async () => {
    await adminDb.githubIdentity.deleteMany({ where: { userId: y.ownerId } });
    signIn(y);
    const res = await getAccounts(y.organizationId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'identity_required' });
  });
});

describe('GET repositories', () => {
  it('marks X’s repositories connected_elsewhere for Y, naming nothing of X', async () => {
    signIn(y);
    const res = await getRepos(y.organizationId);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      repos: { repoId: string; availability: string }[];
      counts: Record<string, number>;
    };
    expect(Object.fromEntries(body.repos.map((r) => [r.repoId, r.availability]))).toEqual({
      '1': 'connected_elsewhere',
      '2': 'connected_elsewhere',
      '3': 'available',
      '4': 'available',
      '5': 'available',
    });
    expect(body.counts).toEqual({ available: 3, connectedHere: 0, connectedElsewhere: 2 });
    expect(text).not.toContain(x.organizationId);
    expect(text).not.toContain(x.workspaceId);
  });
});

describe('POST installations', () => {
  it('links Y with its own subset; a set containing X’s repository is a 409 that writes nothing', async () => {
    signIn(y);
    const refused = await postLink(y.organizationId, {
      installationId: INSTALLATION,
      repoIds: ['1', '3'],
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; repos: { repoId: string }[] };
    expect(body.code).toBe('repository_owned_by_other_organization');
    expect(body.repos.map((r) => r.repoId)).toEqual(['1']);
    expect(JSON.stringify(body)).not.toContain(x.organizationId);
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);

    const ok = await postLink(y.organizationId, {
      installationId: INSTALLATION,
      repoIds: ['3', '4', '5'],
    });
    expect(ok.status).toBe(200);
    expect(await ownedBy(y.organizationId)).toEqual(['3', '4', '5']);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
  });

  it('refuses an installation the actor cannot see on GitHub with 403, writing nothing', async () => {
    userInstallations['gho_y'] = [];
    signIn(y);
    const res = await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['3'] });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'installation_not_accessible' });
    expect(await ownedBy(y.organizationId)).toEqual([]);
  });

  it('requires a non-empty repoIds', async () => {
    signIn(y);
    expect((await postLink(y.organizationId, { installationId: INSTALLATION })).status).toBe(400);
    expect(
      (await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: [] })).status,
    ).toBe(400);
  });
});

describe('authorisation', () => {
  it('refuses a plain member on every route, and a non-member as not found', async () => {
    const member = await usersService.createUser({
      email: 'member@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: y.organizationId, userId: member.id, role: 'member' },
    });
    signIn(y, member.id);
    expect((await getAccounts(y.organizationId)).status).toBe(403);
    expect((await getRepos(y.organizationId)).status).toBe(403);
    expect(
      (await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['3'] })).status,
    ).toBe(403);
    expect(
      (
        await installUrlRoute.GET(
          new Request('http://localhost/x'),
          params({ orgId: y.organizationId }),
        )
      ).status,
    ).toBe(403);
    signIn(x);
    expect((await getAccounts(y.organizationId)).status).toBe(404);
  });

  it('refuses a closing organisation', async () => {
    await adminDb.organization.update({
      where: { id: y.organizationId },
      data: { closingSince: new Date() },
    });
    signIn(y);
    expect((await getAccounts(y.organizationId)).status).toBe(409);
  });
});

describe('the setup round trip', () => {
  function orgState(org: Org): string {
    return encodeInstallState({
      workspaceId: org.workspaceId,
      userId: org.ownerId,
      organizationId: org.organizationId,
      origin: 'organizationGit',
    });
  }

  it('links in place when re-run, keeping one link row', async () => {
    signIn(x);
    expect((await setup(orgState(x))).searchParams.get('github')).toBe('installed');
    expect((await setup(orgState(x))).searchParams.get('github')).toBe('installed');
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: x.organizationId },
      }),
    ).toBe(1);
  });

  it('sends a second organisation to choose its repositories, writing nothing', async () => {
    signIn(y);
    const to = await setup(orgState(y));
    expect(to.searchParams.get('github')).toBe('select_repos');
    expect(to.searchParams.get('installation_id')).toBe(INSTALLATION);
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
  });

  it('refuses a plain member on the organisation branch', async () => {
    const member = await usersService.createUser({
      email: 'm2@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: y.organizationId, userId: member.id, role: 'member' },
    });
    signIn(y, member.id);
    const state = encodeInstallState({
      workspaceId: y.workspaceId,
      userId: member.id,
      organizationId: y.organizationId,
    });
    expect((await setup(state)).searchParams.get('github')).toBe('install_forbidden');
  });

  it('answers installation_not_accessible for an installation the actor cannot see', async () => {
    await adminDb.githubInstallation.deleteMany({});
    userInstallations['gho_y'] = [];
    signIn(y);
    expect((await setup(orgState(y))).searchParams.get('github')).toBe(
      'installation_not_accessible',
    );
  });

  it('keeps an old-shape state (no organisation) on the workspace path', async () => {
    await adminDb.githubInstallation.deleteMany({});
    signIn(y);
    const state = encodeInstallState({ workspaceId: y.workspaceId, userId: y.ownerId });
    expect((await setup(state)).searchParams.get('github')).toBe('installed');
    expect(await ownedBy(y.organizationId)).toEqual(['1', '2', '3', '4', '5']);
  });
});

// Bug MOTIR-8984 — GitHub REFUSES the actor's stored user token (401 Bad
// credentials: revoked, replaced or expired). That is a dead sign-in, so every
// door answers "reconnect", never a 500 the modal draws as "Couldn't reach
// GitHub". A network failure or a 5xx is still that, because it is true.
describe('a refused GitHub sign-in (Bug MOTIR-8984)', () => {
  function orgState(org: Org, extra: Partial<InstallState> = {}): string {
    return encodeInstallState({
      workspaceId: org.workspaceId,
      userId: org.ownerId,
      organizationId: org.organizationId,
      origin: 'organizationGit',
      ...extra,
    });
  }

  beforeEach(() => {
    userInstallationsFailure['gho_y'] = 401;
  });

  it('GET accounts answers 200 identity_required with reason refused, not a 500', async () => {
    signIn(y);
    const res = await getAccounts(y.organizationId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'identity_required', reason: 'refused' });
  });

  it.each([
    ['a 5xx', 503 as const],
    ['a network failure', 'network' as const],
  ])('GET accounts still fails as unreachable on %s', async (_label, failure) => {
    userInstallationsFailure['gho_y'] = failure;
    signIn(y);
    const err = await getAccounts(y.organizationId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GithubUserInstallationsError);
    expect((err as GithubUserInstallationsError).status).toBe(failure === 503 ? 503 : null);
  });

  it('a 403 from GitHub is not read as a dead sign-in', async () => {
    userInstallationsFailure['gho_y'] = 403;
    signIn(y);
    await expect(getAccounts(y.organizationId)).rejects.toBeInstanceOf(
      GithubUserInstallationsError,
    );
  });

  it('GET repositories answers 409 github_identity_refused', async () => {
    signIn(y);
    const res = await getRepos(y.organizationId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'github_identity_refused' });
  });

  it('POST installations answers 409 github_identity_refused and writes nothing', async () => {
    signIn(y);
    const res = await postLink(y.organizationId, { installationId: INSTALLATION, repoIds: ['3'] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'github_identity_refused' });
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
  });

  it('the install return lands on identity_refused, not install_provider_error, writing nothing', async () => {
    signIn(y);
    const to = await setup(orgState(y));
    expect(to.searchParams.get('github')).toBe('identity_refused');
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
  });

  it('so does the project Repositories room’s install return', async () => {
    signIn(y);
    const to = await setup(orgState(y, { origin: 'projectRepositories', projectKey: 'ROOM' }));
    expect(to.searchParams.get('github')).toBe('identity_refused');
  });

  it('an actor with NO identity keeps the install return’s bounded relaxation', async () => {
    await adminDb.githubInstallation.deleteMany({});
    await adminDb.githubIdentity.deleteMany({ where: { userId: y.ownerId } });
    signIn(y);
    expect((await setup(orgState(y))).searchParams.get('github')).toBe('installed');
  });
});
