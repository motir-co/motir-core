import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { projectRepoRoomService } from '@/lib/services/projectRepoRoomService';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { ciAllowanceService } from '@/lib/services/ciAllowanceService';
import { projectsService } from '@/lib/services/projectsService';
import { workspaceRepository } from '@/lib/repositories/workspaceRepository';
import { userOrgsClient, GithubUserOrgsError } from '@/lib/github/userOrgs';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { GithubIdentityRefusedError } from '@/lib/github/errors';
import { decodeInstallStateResult } from '@/lib/github/installState';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { GET as getOrganizations } from '@/app/api/github/organizations/route';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE TAKE-IT-OVER ROOM's reads (Story MOTIR-1775 · MOTIR-1939) — the two things
// the surface needs that MOTIR-711's saga does not expose, over real Postgres.
//
// What is pinned here is what the SURFACE would be a lie without:
//
//   1. The org lookup is a LIVE call whose failure is a first-class answer, not a
//      500 — because the picker is REQUIRED to keep working when GitHub cannot be
//      reached, with the personal account still selectable. A route that threw
//      would make the design's degraded state unreachable.
//   2. `listOrganizations` on a member with NO identity is an EMPTY list, not a
//      throw: "not connected" is answered by MOTIR-1900's connect prompt long
//      before the picker renders.
//   3. The room's read model tells the truth about what Motir hosts, and its
//      NON-essential facts (the paused banner, the sibling projects) degrade to
//      quiet defaults rather than failing the page — a banner that appears
//      because a read failed is worse than no banner.
//
// Real Postgres; the only fake is `fetch` (the GitHub HTTP boundary — the shipped
// convention for these suites).

// The route reads its actor through `getWorkspaceContext`; the test environment
// has no cookies, so this is the one sanctioned mock (CLAUDE.md). `null` is the
// unauthenticated case the 401 arm needs.
let workspaceCtx: { userId: string; workspaceId: string } | null = null;
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: vi.fn(async () => workspaceCtx),
}));

const MOTIR_ORG = 'motir-projects';
const USER_LOGIN = 'yue-personal';

let fetchMock: ReturnType<typeof vi.fn>;
let orgsResponse: () => Response | Promise<Response>;

beforeEach(async () => {
  await truncateAuthTables();
  workspaceCtx = null;
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
  vi.stubEnv('GITHUB_APP_SLUG', 'motir');
  orgsResponse = () =>
    json(200, [{ login: 'acme-inc', avatar_url: 'https://avatars/acme' }, { login: 'acme-labs' }]);
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes('/user/orgs')) return orgsResponse();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('userOrgsClient — the GET /user/orgs boundary', () => {
  it('lists the organizations, carrying the avatar when GitHub sent one', async () => {
    const orgs = await userOrgsClient.listForToken('gho_user');
    expect(orgs).toEqual([
      { login: 'acme-inc', avatarUrl: 'https://avatars/acme' },
      { login: 'acme-labs', avatarUrl: null },
    ]);
    // The USER's token, not the provisioning credential: only their own token can
    // answer "which orgs is this person in".
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer gho_user' });
  });

  it('drops an element with no usable login rather than rendering a blank option', async () => {
    orgsResponse = () => json(200, [{ login: '  ' }, { avatar_url: 'x' }, { login: 'real-org' }]);
    expect(await userOrgsClient.listForToken('gho_user')).toEqual([
      { login: 'real-org', avatarUrl: null },
    ]);
  });

  it('reports a REFUSAL as a typed error carrying the status', async () => {
    orgsResponse = () => json(403, { message: 'Bad credentials' });
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toBeInstanceOf(
      GithubUserOrgsError,
    );
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toMatchObject({ status: 403 });
  });

  it('reports an unexpected body as a failure rather than trusting it', async () => {
    orgsResponse = () => json(200, { not: 'an array' });
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toBeInstanceOf(
      GithubUserOrgsError,
    );
  });

  it('reports a transport failure with a null status', async () => {
    orgsResponse = () => {
      throw new Error('ECONNRESET');
    };
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toMatchObject({ status: null });
  });

  it('survives a thrown non-Error without losing the failure', async () => {
    orgsResponse = () => {
      throw 'not an Error';
    };
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('network error'),
    });
  });

  it('refuses cleanly when GitHub sends no body to explain itself', async () => {
    orgsResponse = () => new Response('', { status: 503 });
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toMatchObject({ status: 503 });
  });

  it('treats an unparseable success body as a failure, not as zero organizations', async () => {
    // "GitHub answered 200 with something we cannot read" is NOT "you belong to
    // no organizations" — reporting it as the latter would silently hide every
    // org from the picker with no way for the user to tell.
    orgsResponse = () =>
      new Response('<html>maintenance</html>', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toBeInstanceOf(
      GithubUserOrgsError,
    );
  });

  it('does not let an unreadable error body mask the refusal', async () => {
    // The failure detail is best-effort — a body that cannot even be read must
    // still produce the typed refusal, not a second error on top of the first.
    orgsResponse = () =>
      ({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('stream closed')),
      }) as unknown as Response;
    await expect(userOrgsClient.listForToken('gho_user')).rejects.toMatchObject({ status: 500 });
  });
});

describe('githubIdentityService.listOrganizations', () => {
  it('answers EMPTY for a member with no connected identity — never a throw', async () => {
    const fx = await makeWorkItemFixture();
    expect(await githubIdentityService.listOrganizations(fx.ownerId)).toEqual([]);
    // Not connected is a state the connect prompt resolves, so it must not cost
    // a network call either.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('decrypts the stored token and lists the organizations for a connected member', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    const orgs = await githubIdentityService.listOrganizations(fx.ownerId);
    expect(orgs.map((o) => o.login)).toEqual(['acme-inc', 'acme-labs']);
    const [, init] = fetchMock.mock.calls[0]!;
    // The plaintext token, decrypted here — proof the column is not sent as-is.
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer gho_user' });
  });
});

describe('GET /api/github/organizations', () => {
  it('401s an unauthenticated caller', async () => {
    const res = await getOrganizations();
    expect(res.status).toBe(401);
  });

  it('answers a GitHub refusal with a TYPED 502, so the picker can degrade', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    signIn(fx);
    orgsResponse = () => json(500, { message: 'boom' });

    const res = await getOrganizations();
    // NOT a 500: the surface renders this as "couldn't reach your organizations"
    // with the personal account still selectable. An unhandled throw would make
    // that state unreachable, which is the whole degradation the design rests on.
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'GITHUB_ORGS_UNAVAILABLE' });
  });

  it('answers a dead GitHub sign-in with the reconnect code, not "couldn\'t reach" (Bug MOTIR-10021)', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    // The renewal was refused (`bad_refresh_token`): retrying cannot work, so it
    // is the same 409 the organisation connect routes answer it with.
    vi.spyOn(githubIdentityService, 'listOrganizations').mockRejectedValue(
      new GithubIdentityRefusedError(),
    );

    const res = await getOrganizations();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'github_identity_refused' });
  });

  it('does NOT swallow an unexpected failure as a degraded picker', async () => {
    const fx = await makeWorkItemFixture();
    signIn(fx);
    vi.spyOn(githubIdentityService, 'listOrganizations').mockRejectedValue(new Error('boom'));
    // Only a GitHub refusal is a 502. Anything else is a real bug, and reporting
    // it as "couldn't reach your organizations" would hide it behind a state the
    // user is told is normal.
    await expect(getOrganizations()).rejects.toThrow('boom');
  });

  it('returns the organizations for a connected member', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    signIn(fx);

    const res = await getOrganizations();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      organizations: [
        { login: 'acme-inc', avatarUrl: 'https://avatars/acme' },
        { login: 'acme-labs', avatarUrl: null },
      ],
    });
  });
});

describe('projectRepoRoomService.getRoomView', () => {
  it('reads the set, the actor’s identity and the shipped install hand-off', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx);
    await motirOwnedRow(fx, 'acme-booking-web');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    expect(view.projectId).toBe(fx.projectId);
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]!.state).toBe('created');
    expect(view.githubLogin).toBe(USER_LOGIN);
    expect(view.hostOwner).toBe(MOTIR_ORG);
    // The SHIPPED install screen, never an in-app repository picker.
    expect(view.installHref).toBe('https://github.com/apps/motir/installations/new');
  });

  // Bug MOTIR-9828 — `Connect a new one` linked out to the bare install URL, so
  // nothing on the round trip named the project and the repository was never
  // linked into it. Given the project's key, an org admin's link is SIGNED and
  // names the project, its organisation and this room.
  it('signs the install link with a state naming the project, for an org admin', async () => {
    const fx = await makeWorkItemFixture();

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx, {
      projectKey: fx.project.identifier,
    });

    const url = new URL(view.installHref!);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/apps/motir/installations/new');
    const decoded = decodeInstallStateResult(url.searchParams.get('state')!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.state).toEqual({
      workspaceId: fx.workspaceId,
      userId: fx.ctx.userId,
      organizationId: fx.workspace.organizationId,
      origin: 'projectRepositories',
      projectKey: fx.project.identifier,
    });
  });

  it('keeps the bare install link for an actor who does not administer the organisation', async () => {
    const fx = await makeWorkItemFixture();
    const user = await adminDb.user.create({
      data: { email: `m-${Date.now()}@example.com`, name: 'Member', emailVerified: true },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: fx.workspaceId, userId: user.id, workspaceRole: 'manager' },
    });
    await adminDb.organizationMembership.create({
      data: {
        organizationId: fx.workspace.organizationId,
        userId: user.id,
        role: ORGANIZATION_ROLE.member,
      },
    });

    const view = await projectRepoRoomService.getRoomView(
      fx.projectId,
      { userId: user.id, workspaceId: fx.workspaceId },
      { projectKey: fx.project.identifier },
    );

    expect(view.installHref).toBe('https://github.com/apps/motir/installations/new');
  });

  it('carries the connected account’s avatar for the identity the picker shows', async () => {
    const fx = await makeWorkItemFixture();
    await connectIdentity(fx, 'https://avatars/yue');
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    expect(view.githubAvatarUrl).toBe('https://avatars/yue');
  });

  it('shows no banner when the workspace resolves to no organization', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(workspaceRepository, 'findByIdInTx').mockResolvedValue(null);
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    // No org means no entitlement to read, and the room still renders — the
    // banner is org-wide context, never a precondition for the set.
    expect(view.ciPaused).toBe(false);
  });

  // Bug MOTIR-9828 — with no organisation there is nobody to sign the state for,
  // so the project-keyed link falls back to the bare install URL, never to none.
  it('keeps the bare install link when the workspace resolves to no organization', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(workspaceRepository, 'findByIdInTx').mockResolvedValue(null);
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx, {
      projectKey: fx.project.identifier,
    });
    expect(view.installHref).toBe('https://github.com/apps/motir/installations/new');
  });

  it('drops the install hand-off on a deployment with no App slug', async () => {
    const fx = await makeWorkItemFixture();
    vi.stubEnv('GITHUB_APP_SLUG', '');
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    // Null, so the surface omits the button instead of linking to nowhere.
    expect(view.installHref).toBeNull();
  });

  it('reports NOT paused when the org has credits — and never fails the page over it', async () => {
    const fx = await makeWorkItemFixture();
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    expect(view.ciPaused).toBe(false);
    expect(view.otherHostedProjects).toEqual([]);
  });

  it('reports PAUSED when the organization has run out of CI credits', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(ciAllowanceService, 'getEntitlementState').mockResolvedValue({
      state: 'ci_credits_exhausted',
    } as never);
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    expect(view.ciPaused).toBe(true);
  });

  it('shows NO banner when the entitlement read fails — a blip must not read as "out of credits"', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(ciAllowanceService, 'getEntitlementState').mockRejectedValue(new Error('ai down'));
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    // Fails OPEN, deliberately: a banner that appears because a read failed is
    // worse than no banner, and the rows are the surface's substance either way.
    expect(view.ciPaused).toBe(false);
    expect(view.rows).toEqual([]);
  });

  it('drops the sibling pointers rather than failing the page when that read breaks', async () => {
    const fx = await makeWorkItemFixture();
    vi.spyOn(projectsService, 'listProjects').mockRejectedValue(new Error('nope'));
    await motirOwnedRow(fx, 'acme-booking-web');
    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    expect(view.otherHostedProjects).toEqual([]);
    // The rows still render — the pointers are a courtesy, the set is the point.
    expect(view.rows).toHaveLength(1);
  });

  it('names the OTHER projects Motir hosts, and never this one', async () => {
    const fx = await makeWorkItemFixture();
    const sibling = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Acme internal tools',
        slug: 'acme-internal-tools',
        identifier: 'AIT',
      },
    });
    await motirOwnedRow(fx, 'acme-booking-web');
    await motirOwnedRow({ ...fx, projectId: sibling.id }, 'acme-tools-web');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);

    // The org→project scope gap, closed: a user arriving from the ORG-scoped
    // billing door is told, by name, whose repositories are NOT being moved.
    expect(view.otherHostedProjects.map((p) => p.identifier)).toEqual(['AIT']);
    expect(view.otherHostedProjects.some((p) => p.id === fx.projectId)).toBe(false);
  });

  it('counts a CONNECTED row as the user’s own, not as something Motir hosts', async () => {
    const fx = await makeWorkItemFixture();
    const sibling = await adminDb.project.create({
      data: {
        workspaceId: fx.workspaceId,
        name: 'Acme marketing site',
        slug: 'acme-marketing-site',
        identifier: 'AMS',
      },
    });
    // A repository the user BROUGHT IN. Motir does not host it, so the banner's
    // "Motir also hosts repositories for …" must not name its project — saying so
    // would make the reassurance false.
    await connectedRow({ ...fx, projectId: sibling.id }, 'design-tokens');

    const view = await projectRepoRoomService.getRoomView(fx.projectId, fx.ctx);
    expect(view.otherHostedProjects).toEqual([]);
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function signIn(fx: WorkItemFixture): void {
  workspaceCtx = { userId: fx.ownerId, workspaceId: fx.workspaceId };
}

async function connectIdentity(fx: WorkItemFixture, avatarUrl?: string): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId: fx.ownerId,
      githubUserId: `gh-${fx.ownerId}`,
      githubLogin: USER_LOGIN,
      accessTokenEncrypted: encryptToken('gho_user'),
      ...(avatarUrl ? { avatarUrl } : {}),
    },
  });
}

/** A Motir-CREATED row, reached through the real machine
 *  (`proposed → creating → created`) so the fixture cannot manufacture an
 *  ownership the product could not. */
async function motirOwnedRow(fx: WorkItemFixture, name: string): Promise<void> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${MOTIR_ORG}` },
    create: {
      installationId: `inst-${MOTIR_ORG}`,
      workspaceId: null,
      accountLogin: MOTIR_ORG,
      accountType: 'Organization',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}`,
      owner: MOTIR_ORG,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'web', name }, fx.ctx);
  await projectRepoSetService.markCreating(row.id, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
}

/** A row realized by CONNECTING a repository the user already owned. */
async function connectedRow(fx: WorkItemFixture, name: string): Promise<void> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-user-${fx.workspaceId}` },
    create: {
      installationId: `inst-user-${fx.workspaceId}`,
      workspaceId: fx.workspaceId,
      accountLogin: USER_LOGIN,
      accountType: 'User',
    },
    update: {},
  });
  const mirror = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      repoId: `host-${name}`,
      owner: USER_LOGIN,
      name,
      defaultBranch: 'main',
      archived: false,
    },
  });
  const row = await projectRepoSetService.addRow(fx.projectId, { role: 'shared', name }, fx.ctx);
  await projectRepoSetService.attachRealizedRepo(row.id, mirror.id, fx.ctx);
}
