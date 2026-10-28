// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ConnectGithubFlow } from '@/app/(authed)/settings/organization/git/_components/ConnectGithubFlow';
import { DisconnectAccountDialog } from '@/app/(authed)/settings/organization/git/_components/DisconnectAccountDialog';
import { GithubConnectRoom } from '@/app/(authed)/settings/organization/git/_components/GithubConnectRoom';
import { RepositoryInventory } from '@/app/(authed)/settings/organization/git/_components/RepositoryInventory';
import type { LinkedGithubAccount } from '@/app/(authed)/settings/organization/git/_components/githubAccounts';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import type { OrgRepoInventoryRowDto } from '@/lib/dto/organizationRepos';

// ONE GITHUB ACCOUNT, MANY ORGANISATIONS — the Git room's UI (Story MOTIR-8216 ·
// MOTIR-8223), against `design/github/github--multi-org-account.mock.html`.
//
// GitHub and the room's own routes are faked at `fetch`, the one seam a client
// island has; the response shapes are the ones MOTIR-8220 / MOTIR-8222 ship.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const ORG_ID = 'org_y';
const ACCOUNT = {
  installationId: '7001',
  accountLogin: 'moooon-labs',
  accountType: 'Organization',
};
/** The other organisation's name and project — NEVER to appear in the DOM. */
const OTHER_ORG = 'Atlas Co';
const OTHER_PROJECT = 'Ledger-X';

type Route = (init?: RequestInit) => { status: number; body: unknown };
let routes: Record<string, Route> = {};
const calls: { url: string; method: string; body?: unknown }[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  calls.length = 0;
  refresh.mockReset();
  routes = {
    [`GET /api/organizations/${ORG_ID}/github/accounts`]: () => ({
      status: 200,
      body: {
        state: 'ok',
        accounts: [
          { ...ACCOUNT, avatarUrl: null, visibleRepoCount: 5, linkState: 'not_linked' },
          {
            installationId: '7002',
            accountLogin: 'zhuyue',
            accountType: 'User',
            avatarUrl: null,
            visibleRepoCount: 3,
            linkState: 'linked_here',
          },
        ],
      },
    }),
    [`GET /api/organizations/${ORG_ID}/github/accounts/7001/repositories`]: () => ({
      status: 200,
      body: REPOS_X_HAS_A_B,
    }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const route = routes[`${method} ${url}`];
      if (!route) return json(500, { code: 'unrouted' });
      const { status, body } = route(init);
      return json(status, body);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Org X connected A and B; C, D, E are free (the story's scenario). */
const REPOS_X_HAS_A_B = {
  repos: [
    { repoId: '1', fullName: 'moooon-labs/a', availability: 'connected_elsewhere' },
    { repoId: '2', fullName: 'moooon-labs/b', availability: 'connected_elsewhere' },
    { repoId: '3', fullName: 'moooon-labs/c', availability: 'available' },
    { repoId: '4', fullName: 'moooon-labs/d', availability: 'available' },
    { repoId: '5', fullName: 'moooon-labs/e', availability: 'available' },
  ],
  counts: { available: 3, connectedHere: 0, connectedElsewhere: 2 },
};

function renderFlow(over: Partial<Parameters<typeof ConnectGithubFlow>[0]> = {}) {
  const onLinked = vi.fn();
  const onOpenChange = vi.fn();
  renderWithIntl(
    <ConnectGithubFlow
      open
      onOpenChange={onOpenChange}
      organizationId={ORG_ID}
      organizationName="moooon-studio"
      initialAccount={ACCOUNT}
      initialInstallationId={null}
      onLinked={onLinked}
      {...over}
    />,
  );
  return { onLinked, onOpenChange };
}

const submitButton = () => screen.getByRole('button', { name: /^Connect (\d+ )?repositor/ });

describe('the account picker', () => {
  it('lists each account with its link state for THIS organisation, plus the install row', async () => {
    renderFlow({ initialAccount: null });
    await screen.findByText('moooon-labs');
    expect(screen.getByText('Organisation · 5 repositories visible to Motir')).toBeTruthy();
    expect(screen.getByText('Personal · 3 repositories visible to Motir')).toBeTruthy();
    expect(screen.getByText('Not linked')).toBeTruthy();
    expect(screen.getByText('Linked to this organisation')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Install on another account/ })).toBeTruthy();
  });

  it('shows the identity prompt when the admin has no GitHub identity', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts`] = () => ({
      status: 200,
      body: { state: 'identity_required' },
    });
    renderFlow({ initialAccount: null });
    await screen.findByText('Connect your GitHub account first');
    expect(screen.getByRole('link', { name: /Go to Git accounts/ }).getAttribute('href')).toBe(
      '/settings/account/git',
    );
    expect(screen.queryByRole('button', { name: /Install on another account/ })).toBeNull();
  });

  it('shows an error with a retry when GitHub cannot be reached', async () => {
    let fail = true;
    const ok = routes[`GET /api/organizations/${ORG_ID}/github/accounts`]!;
    routes[`GET /api/organizations/${ORG_ID}/github/accounts`] = (init) =>
      fail ? { status: 502, body: {} } : ok(init);
    renderFlow({ initialAccount: null });
    await screen.findByText("Couldn't reach GitHub");
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('moooon-labs');
  });

  it('opens the repo picker of the installation `?github=select_repos` named', async () => {
    renderFlow({ initialAccount: null, initialInstallationId: '7001' });
    await screen.findByText('Choose repositories from moooon-labs');
  });
});

// Bug MOTIR-8984 — GitHub refused the admin's own stored sign-in. A retry can
// never work, so all three doors land on the reconnect prompt; only a real
// transport failure or a 5xx is still "Couldn't reach GitHub".
describe('a refused GitHub sign-in (Bug MOTIR-8984)', () => {
  const RECONNECT = 'Reconnect your GitHub account';

  function expectReconnectPrompt() {
    expect(screen.getByRole('link', { name: /Go to Git accounts/ }).getAttribute('href')).toBe(
      '/settings/account/git',
    );
    expect(screen.queryByText("Couldn't reach GitHub")).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText('Connect your GitHub account first')).toBeNull();
  }

  it('the accounts read`s identity_required (refused) draws the reconnect prompt', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts`] = () => ({
      status: 200,
      body: { state: 'identity_required', reason: 'refused' },
    });
    renderFlow({ initialAccount: null });
    await screen.findByText(RECONNECT);
    expect(screen.getByText(/GitHub no longer accepts the sign-in Motir has for you/)).toBeTruthy();
    expectReconnectPrompt();
  });

  it('the repository read`s 409 github_identity_refused goes back to the reconnect prompt', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts/7001/repositories`] = () => ({
      status: 409,
      body: { code: 'github_identity_refused' },
    });
    renderFlow();
    await screen.findByText(RECONNECT);
    expect(screen.queryByText('Choose repositories from moooon-labs')).toBeNull();
    expectReconnectPrompt();
  });

  it('the link`s 409 github_identity_refused goes back to the reconnect prompt', async () => {
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status: 409,
      body: { code: 'github_identity_refused' },
    });
    const { onLinked } = renderFlow();
    await screen.findByText(/Select all available/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all available/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    await screen.findByText(RECONNECT);
    expect(onLinked).not.toHaveBeenCalled();
    expectReconnectPrompt();
  });

  it('a 5xx on the accounts read is still "Couldn`t reach GitHub" with Try again', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts`] = () => ({
      status: 500,
      body: {},
    });
    renderFlow({ initialAccount: null });
    await screen.findByText("Couldn't reach GitHub");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(RECONNECT)).toBeNull();
  });

  it('a network failure on the accounts read is still "Couldn`t reach GitHub" with Try again', async () => {
    const routed = vi.mocked(fetch);
    routed.mockImplementationOnce(async () => {
      throw new TypeError('fetch failed');
    });
    renderFlow({ initialAccount: null });
    await screen.findByText("Couldn't reach GitHub");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText(RECONNECT)).toBeNull();
  });
});

describe('the repo picker — the story`s scenario (X has A, B; Y connects)', () => {
  it('lists C, D, E available and A, B locked, naming NO other organisation or project', async () => {
    renderFlow();
    await screen.findByText(/Select all available/);
    for (const name of ['c', 'd', 'e']) {
      const box = screen.getByRole('checkbox', { name: new RegExp(`moooon-labs/${name},`) });
      expect(box.hasAttribute('disabled')).toBe(false);
    }
    for (const name of ['a', 'b']) {
      const box = screen.getByRole('checkbox', { name: new RegExp(`moooon-labs/${name},`) });
      expect(box.hasAttribute('disabled')).toBe(true);
    }
    expect(screen.getAllByText('Connected to another organisation')).toHaveLength(2);
    const dom = document.body.innerHTML;
    expect(dom).not.toContain(OTHER_ORG);
    expect(dom).not.toContain(OTHER_PROJECT);
    expect(dom).not.toContain('org_x');
  });

  it('is disabled at zero, and select-all-available never takes a locked row', async () => {
    renderFlow();
    await screen.findByText(/Select all available/);
    expect(submitButton().textContent).toBe('Connect repositories');
    expect(submitButton().hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /Select all available \(3\)/ }));
    expect(screen.getByText('3 selected')).toBeTruthy();
    expect(submitButton().textContent).toBe('Connect 3 repositories');
    for (const name of ['a', 'b']) {
      const box = screen.getByRole('checkbox', { name: new RegExp(`moooon-labs/${name},`) });
      expect(box.getAttribute('aria-checked')).toBe('false');
    }
  });

  it('calls the link action ONCE with C, D, E and reports the success', async () => {
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status: 200,
      body: { claimed: ['moooon-labs/c', 'moooon-labs/d', 'moooon-labs/e'], released: [] },
    });
    const { onLinked } = renderFlow();
    await screen.findByText(/Select all available/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all available/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ installationId: '7001', repoIds: ['3', '4', '5'] });
    expect(onLinked).toHaveBeenCalledWith({ account: ACCOUNT, count: 3 });
  });

  it('a 409 locks the raced row in place and keeps the rest submittable', async () => {
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status: 409,
      body: {
        code: 'repository_owned_by_other_organization',
        repos: [{ repoId: '4', fullName: 'moooon-labs/d' }],
      },
    });
    const { onLinked, onOpenChange } = renderFlow();
    await screen.findByText(/Select all available/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Select all available/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    expect(
      screen.getByText(
        "moooon-labs/d was just connected to another organisation and can't be added.",
      ),
    ).toBeTruthy();
    const raced = screen.getByRole('checkbox', { name: /moooon-labs\/d,/ });
    expect(raced.hasAttribute('disabled')).toBe(true);
    expect(raced.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('2 selected')).toBeTruthy();
    expect(submitButton().textContent).toBe('Connect 2 repositories');
    expect(submitButton().hasAttribute('disabled')).toBe(false);
    expect(onLinked).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it.each([
    [422, 'repo_selection_required', 'Choose at least one repository to connect.'],
    [
      422,
      'repository_not_visible',
      'One of these repositories is no longer visible to the Motir GitHub App on GitHub. Refresh the list and try again.',
    ],
    [
      403,
      'installation_not_accessible',
      "You can no longer see moooon-labs on GitHub, so it can't be linked. Choose another account.",
    ],
    [
      500,
      'something_new',
      'Something went wrong connecting these repositories. Nothing was changed — try again.',
    ],
  ])('a %i %s shows its own message', async (status, code, message) => {
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status,
      body: { code },
    });
    renderFlow();
    await screen.findByText(/Select all available/);
    fireEvent.click(screen.getByRole('checkbox', { name: /moooon-labs\/c,/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    expect(screen.getByRole('alert').textContent).toBe(message);
  });

  it('replaces an empty list with the none-left panel, its counts and both actions', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts/7001/repositories`] = () => ({
      status: 200,
      body: {
        repos: [
          { repoId: '1', fullName: 'moooon-labs/a', availability: 'connected_elsewhere' },
          { repoId: '2', fullName: 'moooon-labs/b', availability: 'connected_here' },
        ],
        counts: { available: 0, connectedHere: 1, connectedElsewhere: 1 },
      },
    });
    renderFlow();
    await screen.findByText('Nothing left to connect from moooon-labs');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Connected to this organisation')).toBeTruthy();
    expect(screen.getByText('Connected to other organisations')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Choose another account/ })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /Manage repositories on GitHub/ }).getAttribute('href'),
    ).toBe('https://github.com/organizations/moooon-labs/settings/installations/7001');
  });

  it('draws a repository connected here checked and locked', async () => {
    routes[`GET /api/organizations/${ORG_ID}/github/accounts/7001/repositories`] = () => ({
      status: 200,
      body: {
        repos: [
          { repoId: '3', fullName: 'moooon-labs/c', availability: 'available' },
          { repoId: '6', fullName: 'moooon-labs/f', availability: 'connected_here' },
        ],
        counts: { available: 1, connectedHere: 1, connectedElsewhere: 0 },
      },
    });
    renderFlow();
    const box = await screen.findByRole('checkbox', { name: /moooon-labs\/f,/ });
    expect(box.getAttribute('aria-checked')).toBe('true');
    expect(box.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Connected here')).toBeTruthy();
  });

  it('keeps the repositories already connected here in the link request', async () => {
    // The link REPLACES the organisation's set on the account, so an add that
    // left F out would release it.
    routes[`GET /api/organizations/${ORG_ID}/github/accounts/7001/repositories`] = () => ({
      status: 200,
      body: {
        repos: [
          { repoId: '3', fullName: 'moooon-labs/c', availability: 'available' },
          { repoId: '6', fullName: 'moooon-labs/f', availability: 'connected_here' },
        ],
        counts: { available: 1, connectedHere: 1, connectedElsewhere: 0 },
      },
    });
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status: 200,
      body: { claimed: ['moooon-labs/c'], released: [] },
    });
    const { onLinked } = renderFlow();
    fireEvent.click(await screen.findByRole('checkbox', { name: /moooon-labs\/c,/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ installationId: '7001', repoIds: ['6', '3'] });
    expect(onLinked).toHaveBeenCalledWith({ account: ACCOUNT, count: 1 });
  });
});

const PREVIEW = {
  accountLogin: 'moooon-labs',
  accountType: 'Organization',
  repos: [
    { githubRepoId: 'g3', repoRef: 'moooon-labs/c' },
    { githubRepoId: 'g4', repoRef: 'moooon-labs/d' },
  ],
  projects: [{ id: 'p1', name: 'Storefront', identifier: 'STO', workspaceId: 'w' }],
  retentionWindowDays: CODE_GRAPH_RETENTION_WINDOW_DAYS,
};

describe('the per-account disconnect dialog', () => {
  const PREVIEW_URL = '/api/organization/github/accounts/7001/disconnect-preview';
  const DELETE_URL = '/api/organization/github/accounts/7001';

  function renderDialog() {
    const onDone = vi.fn();
    const onClose = vi.fn();
    renderWithIntl(
      <DisconnectAccountDialog
        account={ACCOUNT}
        organizationName="moooon-studio"
        onClose={onClose}
        onDone={onDone}
      />,
    );
    return { onDone, onClose };
  }

  it('states the preview`s facts, the window interpolated from it, and who is untouched', async () => {
    routes[`GET ${PREVIEW_URL}`] = () => ({ status: 200, body: PREVIEW });
    renderDialog();
    await screen.findByText(/This removes only moooon-studio's link to moooon-labs/);
    expect(screen.getByText(/and the 2 repositories it connected here/)).toBeTruthy();
    expect(screen.getByText('c')).toBeTruthy();
    expect(screen.getByText('1 project loses these repositories:')).toBeTruthy();
    expect(screen.getByText('Storefront')).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`kept for ${CODE_GRAPH_RETENTION_WINDOW_DAYS} days`)),
    ).toBeTruthy();
    expect(
      screen.getByText(/Other organisations linked to moooon-labs are not affected/),
    ).toBeTruthy();
    expect(screen.getByText(/the Motir GitHub App stays installed on GitHub/)).toBeTruthy();
  });

  it('interpolates whatever window the preview carries — never a literal', async () => {
    routes[`GET ${PREVIEW_URL}`] = () => ({
      status: 200,
      body: { ...PREVIEW, retentionWindowDays: 41 },
    });
    renderDialog();
    await screen.findByText(/kept for 41 days/);
  });

  it('says no project uses them, and drops the chips, when none does', async () => {
    routes[`GET ${PREVIEW_URL}`] = () => ({ status: 200, body: { ...PREVIEW, projects: [] } });
    renderDialog();
    await screen.findByText('No project in moooon-studio uses these repositories yet.');
    expect(screen.queryByText(/These are the only projects affected/)).toBeNull();
  });

  it('refreshes on success', async () => {
    routes[`GET ${PREVIEW_URL}`] = () => ({ status: 200, body: PREVIEW });
    routes[`DELETE ${DELETE_URL}`] = () => ({
      status: 200,
      body: { releasedRepos: ['3', '4'], clearedLinks: 1, installationRemoved: false },
    });
    const { onDone } = renderDialog();
    await screen.findByText(/This removes only/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open with an error when the disconnect fails', async () => {
    routes[`GET ${PREVIEW_URL}`] = () => ({ status: 200, body: PREVIEW });
    routes[`DELETE ${DELETE_URL}`] = () => ({ status: 500, body: {} });
    const { onDone, onClose } = renderDialog();
    await screen.findByText(/This removes only/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    });
    expect(screen.getByRole('alert').textContent).toBe(
      "Motir couldn't disconnect moooon-labs. Nothing was changed — try again.",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});

const LINKED: LinkedGithubAccount[] = [
  {
    installationId: '7001',
    accountLogin: 'moooon-labs',
    accountType: 'Organization',
    repoCount: 3,
    manageUrl: 'https://github.com/organizations/moooon-labs/settings/installations/7001',
  },
  {
    installationId: '7002',
    accountLogin: 'zhuyue',
    accountType: 'User',
    repoCount: 1,
    manageUrl: 'https://github.com/settings/installations/7002',
  },
];

describe('the connection card — one row per linked account', () => {
  function renderRoom(accounts: LinkedGithubAccount[]) {
    renderWithIntl(
      <ToastProvider>
        <GithubConnectRoom
          organizationId={ORG_ID}
          organizationName="moooon-studio"
          accounts={accounts}
          selectReposInstallationId={null}
        >
          <p>not connected panel</p>
        </GithubConnectRoom>
      </ToastProvider>,
    );
  }

  it('renders ONE row for one account, with its own actions', () => {
    renderRoom([LINKED[0]!]);
    const rows = within(screen.getByRole('list', { name: 'GitHub accounts' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('Organisation · 3 repositories connected here')).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole('link', { name: /Manage on GitHub/ })
        .getAttribute('href'),
    ).toBe(LINKED[0]!.manageUrl);
    expect(within(rows[0]!).getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    expect(screen.queryByText('not connected panel')).toBeNull();
  });

  it('renders TWO rows for two accounts, each managing its OWN installation', () => {
    renderRoom(LINKED);
    const rows = within(screen.getByRole('list', { name: 'GitHub accounts' })).getAllByRole(
      'listitem',
    );
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) =>
        within(row)
          .getByRole('link', { name: /Manage on GitHub/ })
          .getAttribute('href'),
      ),
    ).toEqual([LINKED[0]!.manageUrl, LINKED[1]!.manageUrl]);
    expect(within(rows[1]!).getByText('Personal · 1 repository connected here')).toBeTruthy();
  });

  it('renders the not-connected panel when no account is linked', () => {
    renderRoom([]);
    expect(screen.getByText('not connected panel')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'GitHub accounts' })).toBeNull();
  });

  it('`Add or remove repositories` opens THAT account`s repo picker', async () => {
    renderRoom(LINKED);
    const rows = within(screen.getByRole('list', { name: 'GitHub accounts' })).getAllByRole(
      'listitem',
    );
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Add or remove repositories' }));
    await screen.findByText('Choose repositories from moooon-labs');
  });

  it('a successful link refreshes the room', async () => {
    routes[`POST /api/organizations/${ORG_ID}/github/installations`] = () => ({
      status: 200,
      body: { claimed: [], released: [] },
    });
    renderRoom(LINKED);
    const rows = within(screen.getByRole('list', { name: 'GitHub accounts' })).getAllByRole(
      'listitem',
    );
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Add or remove repositories' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /moooon-labs\/c,/ }));
    await act(async () => {
      fireEvent.click(submitButton());
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText('Connected 1 repository from moooon-labs')).toBeTruthy();
  });
});

describe('the inventory`s GitHub hand-off is the row`s OWN account', () => {
  it('links each repository to the installation it came through', () => {
    const row = (id: string, owner: string): OrgRepoInventoryRowDto => ({
      repo: {
        id,
        owner,
        name: 'repo',
        fullName: `${owner}/repo`,
        defaultBranch: 'main',
        provider: 'github',
        archived: false,
        connectedFromWorkspaceId: 'w',
        hostedByMotir: false,
      },
      projects: [],
      indexState: 'indexed',
    });
    renderWithIntl(
      <RepositoryInventory
        rows={[row('r1', 'moooon-labs'), row('r2', 'zhuyue')]}
        organizationName="moooon-studio"
        canDisconnect
        manageOnGithubHrefs={{ r1: LINKED[0]!.manageUrl, r2: LINKED[1]!.manageUrl }}
        onDisconnect={vi.fn()}
        retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
      />,
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[1]!);
    expect(screen.getByRole('link', { name: /Continue on GitHub/ }).getAttribute('href')).toBe(
      LINKED[1]!.manageUrl,
    );
  });
});

describe('the page', () => {
  const PAGE = readFileSync('app/(authed)/settings/organization/git/page.tsx', 'utf8');

  it('refuses a non-admin before the connection card — neither picker is reachable', () => {
    const gate = PAGE.indexOf('isOrgAdminForWorkspace(ctx.userId, ctx.workspaceId)');
    expect(gate).toBeGreaterThan(-1);
    expect(PAGE.indexOf('<GithubConnectRoom')).toBeGreaterThan(gate);
    expect(PAGE.slice(gate, PAGE.indexOf('<OrgGitBody', gate))).toContain('states.forbiddenTitle');
  });

  it('opens the repo picker only for `?github=select_repos`', () => {
    expect(PAGE).toContain("sp.github === 'select_repos' && sp.installation_id");
  });
});
