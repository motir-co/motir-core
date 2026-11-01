// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type {
  HostedRunRepoAccessMapDto,
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
} from '@/lib/dto/projectRepos';

// WHERE MOTIR'S APP CAN WRITE (MOTIR-1895 · `design/repository-set/design-notes.md`
// §18.1 / §18.4 / §18.5). The room draws, under each organisation repository, the
// line `hostedRunRepoAccessService` answered for it — the three states, their
// copy verbatim, their GitHub hand-off — and re-reads itself when shown again
// while a warning is on screen (§18.2: the row, not a banner, is the record).

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const ORG_ROW = (id: string, owner: string, name: string): ProjectRepoDto =>
  ({
    id,
    projectId: 'proj-1',
    role: 'api',
    label: null,
    name,
    seedSource: SEED_SOURCE_ORGANIZATION,
    state: 'connected',
    failureReason: null,
    proposalSignal: null,
    realizedRepo: {
      id: `gr-${id}`,
      provider: 'github',
      owner,
      name,
      repoRef: `${owner}/${name}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: null,
    access: null,
    position: 'a0',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }) as unknown as ProjectRepoDto;

const ROWS = [
  ORG_ROW('r-ready', 'acme-inc', 'acme-booking-web'),
  ORG_ROW('r-perms', 'acme-labs', 'acme-infra'),
  ORG_ROW('r-gone', 'acme-inc', 'design-tokens'),
];

const REVIEW = 'https://github.com/organizations/acme-labs/settings/installations/42';
const INSTALL = 'https://github.com/apps/motir-integration/installations/new';

const ACCESS: HostedRunRepoAccessMapDto = {
  'r-ready': { state: 'ready' },
  'r-perms': { state: 'needs_permissions', account: 'acme-labs', reviewHref: REVIEW },
  'r-gone': { state: 'unreachable', repository: 'acme-inc/design-tokens', reconnectHref: INSTALL },
};

function view(rows: ProjectRepoDto[]): ProjectRepoRoomViewDto {
  return {
    projectId: 'proj-1',
    rows,
    hostOwner: 'motir-projects',
    githubLogin: null,
    githubAvatarUrl: null,
    installHref: INSTALL,
    ciPaused: false,
    otherHostedProjects: [],
    connected: [],
    connectedInDomain: false,
    seeds: {},
  } as unknown as ProjectRepoRoomViewDto;
}

function room(access?: HostedRunRepoAccessMapDto, rows: ProjectRepoDto[] = ROWS) {
  return renderWithIntl(
    <RepositoriesRoom
      projectKey="ACME"
      view={view(rows)}
      connectHref="/settings/account/git"
      canAddRepositories
      organizationName="moooon"
      projectName="Motir"
      organizationInventoryHref="/settings/organization/git"
      nowIso="2026-09-06T12:00:00.000Z"
      hostedRunAccess={access}
    />,
  );
}

/** The row `<li>` for a repository — each row carries its own id. */
function rowOf(id: string): HTMLElement {
  const li = document.getElementById(`repo-${id}`);
  if (!li) throw new Error(`no row repo-${id}`);
  return li;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  refresh.mockClear();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('the Repositories room says whether Motir’s app can write each repository (AC1, AC4)', () => {
  it('ready is a quiet line with the design’s copy and no control', () => {
    room(ACCESS);
    const row = within(rowOf('r-ready'));
    expect(
      row.getByText(
        'Hosted runs can write here — Motir’s app pushes their branches and opens their pull requests.',
      ),
    ).toBeTruthy();
    expect(row.queryByRole('status')).toBeNull();
    expect(row.queryByRole('link')).toBeNull();
  });

  it('needs updated permissions names the account and hands off to its installation page', () => {
    room(ACCESS);
    const row = within(rowOf('r-perms'));
    const line = row.getByRole('status');
    expect(line.textContent).toBe(
      'Needs updated permissions. Motir Integration on acme-labs can’t write yet — an owner of acme-labs accepts its updated permissions on GitHub. Until then a hosted run that touches this repository is refused before anything starts.Review permissions on GitHub',
    );
    const link = row.getByRole('link', { name: 'Review permissions on GitHub' });
    expect(link.getAttribute('href')).toBe(REVIEW);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('can no longer reach names the repository and hands off to the install screen', () => {
    room(ACCESS);
    const row = within(rowOf('r-gone'));
    expect(row.getByRole('status').textContent).toBe(
      'Motir Integration can no longer reach acme-inc/design-tokens. Its installation was removed or suspended, or no longer includes this repository. Reconnect it on GitHub; until then a hosted run that touches it is refused.Reconnect',
    );
    expect(row.getByRole('link', { name: 'Reconnect' }).getAttribute('href')).toBe(INSTALL);
  });

  it('draws no control when the deployment has nowhere to send the reader', () => {
    room({ 'r-perms': { state: 'needs_permissions', account: 'acme-labs', reviewHref: null } });
    expect(within(rowOf('r-perms')).queryByRole('link')).toBeNull();
    expect(within(rowOf('r-perms')).getByRole('status')).toBeTruthy();
  });
});

describe('no hosted-runs state where there is nothing to say (AC3)', () => {
  it('a room handed no answers — an unconfigured deployment — draws no line on any row', () => {
    room({});
    for (const id of ['r-ready', 'r-perms', 'r-gone']) {
      expect(within(rowOf(id)).queryByRole('status')).toBeNull();
      expect(within(rowOf(id)).queryByText(/Hosted runs can write here/)).toBeNull();
    }
  });

  it('the prop is optional: omitting it draws nothing', () => {
    room(undefined);
    expect(screen.queryByText(/Motir Integration/)).toBeNull();
  });
});

describe('back from GitHub, the room re-reads itself (AC2 · the page-state contract)', () => {
  it('when shown again while a line warns, it re-runs the server render', () => {
    room(ACCESS);
    act(() => setVisibility('hidden'));
    expect(refresh).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('with every line ready there is nothing to re-ask', () => {
    room({ 'r-ready': { state: 'ready' } });
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('the refreshed answers REPLACE the lines — a prop, never seeded into state', () => {
    const { rerender } = room(ACCESS);
    expect(within(rowOf('r-perms')).getByRole('status')).toBeTruthy();
    // What `router.refresh()` delivers: the same island, re-rendered with the
    // server's new answer — the installation has now accepted.
    rerender(
      <RepositoriesRoom
        projectKey="ACME"
        view={view(ROWS)}
        connectHref="/settings/account/git"
        canAddRepositories
        organizationName="moooon"
        projectName="Motir"
        organizationInventoryHref="/settings/organization/git"
        nowIso="2026-09-06T12:00:00.000Z"
        hostedRunAccess={{ ...ACCESS, 'r-perms': { state: 'ready' } }}
      />,
    );
    const row = within(rowOf('r-perms'));
    expect(row.queryByRole('status')).toBeNull();
    expect(row.getByText(/Hosted runs can write here/)).toBeTruthy();
  });
});
