// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { db } from '@/lib/db';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { GithubIdentityRefusedError } from '@/lib/github/errors';
import { githubIdentityService } from '@/lib/services/githubIdentityService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import messages from '@/messages/en.json';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';

// THE ACCOUNT GIT PANE AFTER GITHUB REJECTS A SIGN-IN (Bug MOTIR-10806), end to
// end over a real Postgres: GitHub answers a member's user-token read with 401,
// and the page they then open must say Needs re-auth with Reconnect — not
// Connected. Then the way out: reconnecting returns the page to Connected.
//
// Before this fix only a REFUSED RENEWAL marked the row. A row with no refresh
// token (every sign-in linked before MOTIR-10021) or a revoked App reached GitHub,
// got 401, showed the member the reconnect banner — and left the pane saying
// Connected. So this drives the two real user-token reads, `GET
// /user/installations` (through the organisation Git room's accounts read) and
// `GET /user/orgs` (the takeover picker's), and renders the REAL page.
//
// Faked: `fetch` (the GitHub boundary), the session (no cookies in tests — the
// sanctioned mock), and `next-intl/server` with the real `en` catalogue.

const session: { userId: string | null } = { userId: null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => null,
}));
vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages, namespace: namespace as never }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  usePathname: () => '/settings/account/git',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

const { default: AccountGitAccountsPage } =
  await import('@/app/(authed)/settings/account/git/page');

/** How GitHub answers each user-token read, by path fragment. */
let answers: Record<string, () => Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  session.userId = fx.ownerId;
  // A sign-in linked before MOTIR-10021: no refresh token, no expiry — the shape
  // both production rows had when this was found.
  await adminDb.githubIdentity.create({
    data: {
      userId: fx.ownerId,
      githubUserId: '4242',
      githubLogin: 'zhuyue',
      avatarUrl: null,
      accessTokenEncrypted: encryptToken('gho_linked_before_renewal'),
    },
  });
  answers = {
    '/user/installations': () => json(401, { message: 'Bad credentials' }),
    '/user/orgs': () => json(401, { message: 'Bad credentials' }),
    '/login/oauth/access_token': () => json(200, { access_token: 'gho_reconnected' }),
    'api.github.com/user': () => json(200, { id: 4242, login: 'zhuyue', avatar_url: null }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const key = Object.keys(answers).find((fragment) => url.includes(fragment));
      if (!key) throw new Error(`unexpected fetch in test: ${url}`);
      return answers[key]!();
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function renderPage(): Promise<void> {
  renderWithIntl(await AccountGitAccountsPage());
}

function expectNeedsReauth(): void {
  expect(screen.getByText('Needs re-auth')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Reconnect' }).getAttribute('href')).toBe(
    '/api/github/oauth/start?from=accountGit',
  );
  expect(screen.queryByText('Connected')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
}

function expectConnected(): void {
  expect(screen.getByText('Connected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
  expect(screen.queryByText('Needs re-auth')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Reconnect' })).toBeNull();
}

describe('a sign-in GitHub rejects reads Needs re-auth on the account Git pane', () => {
  it('starts Connected — the counterfactual: nothing has asked GitHub yet', async () => {
    await renderPage();
    expectConnected();
  });

  it('after a 401 from GET /user/installations (the organisation Git room)', async () => {
    const workspace = await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } });
    const accounts = await githubInstallationService.listAccountsForOrganization({
      organizationId: workspace.organizationId,
      actorUserId: fx.ownerId,
    });
    expect(accounts).toEqual({ state: 'identity_required', reason: 'refused' });

    await renderPage();
    expectNeedsReauth();
  });

  it('after a 401 from GET /user/orgs (the takeover picker)', async () => {
    await expect(githubIdentityService.listOrganizations(fx.ownerId)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );

    await renderPage();
    expectNeedsReauth();
  });

  it('a 5xx leaves the pane Connected: an unreachable GitHub is not a dead sign-in', async () => {
    answers['/user/orgs'] = () => json(503, { message: 'Service Unavailable' });
    await expect(githubIdentityService.listOrganizations(fx.ownerId)).rejects.toMatchObject({
      status: 503,
    });

    await renderPage();
    expectConnected();
  });

  it('reconnecting clears the mark and the pane returns to Connected', async () => {
    await expect(githubIdentityService.listOrganizations(fx.ownerId)).rejects.toBeInstanceOf(
      GithubIdentityRefusedError,
    );
    await renderPage();
    expectNeedsReauth();
    cleanup();

    // `Reconnect` is the ordinary OAuth round trip; its callback lands here.
    await githubIdentityService.completeOAuthCallback({ code: 'c', userId: fx.ownerId });

    await renderPage();
    expectConnected();
    // …and the new sign-in works: GitHub now answers the org list.
    answers['/user/orgs'] = () => json(200, [{ login: 'motir-co' }]);
    await expect(githubIdentityService.listOrganizations(fx.ownerId)).resolves.toEqual([
      { login: 'motir-co', avatarUrl: null },
    ]);
  });
});
