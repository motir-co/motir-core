// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import type { ProjectRepoDto, ProjectRepoRoomViewDto } from '@/lib/dto/projectRepos';
import { roomSeedsFor } from '@/lib/projectRepos/roomSeeds';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';
import { SHIPPED_ENTRIES, seedEntry, seedRow } from '../fixtures/seedRegistryFixtures';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE SEED ON A ROOM ROW (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §1). A
// Motir-created row shows its starter and hosting target; a row not created yet
// also says why that starter and offers the picker that re-points it; a refused
// re-point says why in the person's words; a created row's detail names the
// starter it came from. The only fakes are `fetch` and `useRouter`.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const NOW = '2026-10-28T12:00:00.000Z';
const FLY = seedEntry('nextjs-prisma-fly-starter', {
  label: 'Next.js · Fly',
  hostingTargets: ['fly'],
  useCases: ['mvp', 'planned_product'],
  sizes: ['small', 'medium', 'large'],
});
const ENTRIES = [...SHIPPED_ENTRIES, FLY];

let fetchMock: ReturnType<typeof vi.fn>;
let patchAnswer: { status: number; body: unknown };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  refresh.mockClear();
  patchAnswer = { status: 200, body: null };
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PATCH'
      ? json(patchAnswer.status, patchAnswer.body)
      : json(200, { rows: [], candidates: [] }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderRoom(rows: ProjectRepoDto[]) {
  const view: ProjectRepoRoomViewDto = {
    projectId: 'proj-1',
    rows,
    hostOwner: 'motir-projects',
    githubLogin: null,
    githubAvatarUrl: null,
    installHref: null,
    ciPaused: false,
    otherHostedProjects: [],
    connected: [],
    connectedInDomain: false,
    seeds: roomSeedsFor(rows, ENTRIES),
  };
  return renderWithIntl(
    <RepositoriesRoom
      projectKey="ACME"
      view={view}
      connectHref="/settings/account/git"
      canAddRepositories={false}
      organizationName="moooon"
      projectName="Motir"
      organizationInventoryHref="/settings/organization/git"
      nowIso={NOW}
    />,
  );
}

describe('a row not created yet (§1.1–1.3)', () => {
  it('shows its state, its starter and target pills, and why that starter', () => {
    renderRoom([seedRow()]);
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Not created yet')).toBeTruthy();
    expect(within(row).getByLabelText('Starts from Next.js · serverless')).toBeTruthy();
    expect(within(row).getByLabelText('Hosted on Serverless')).toBeTruthy();
    // A match is never labelled a default.
    expect(within(row).queryByText('Default')).toBeNull();

    const why = within(row).getByTestId('seed-why-row-web');
    expect(why.getAttribute('data-why')).toBe('matched');
    expect(why.textContent).toContain(
      'Why this starter: it deploys to Serverless and is made for an MVP of this size.',
    );
    expect(why.querySelector('[data-fact="stack"]')?.textContent).toContain('nextjs');
  });

  it('labels a default as a default, and a web row with no target says so', () => {
    renderRoom([seedRow({ seedMatch: 'no_target', hostingTarget: null })]);
    const row = screen.getByTestId('takeover-row-web');
    expect(within(row).getByText('Default')).toBeTruthy();
    expect(within(row).getByText('No hosting target')).toBeTruthy();
    expect(within(row).getByTestId('seed-why-row-web').textContent).toContain(
      'this repository has no hosting target yet',
    );
  });

  it('offers only the starters that fit, grouped, initialised last', () => {
    renderRoom([seedRow({ hostingTarget: 'fly', seedSource: FLY.key })]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Starter' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options[0]).toContain('Next.js · Fly');
    expect(options[1]).toContain('Initialised repository');
    expect(screen.getByText('Web starters on Fly')).toBeTruthy();
    expect(screen.getByText('Any repository')).toBeTruthy();
    expect(screen.getByText('Only starters for web repositories that deploy to Fly.')).toBeTruthy();
  });
});

describe('re-pointing (§1.3–1.4)', () => {
  it('PATCHes the picked starter and refreshes the room', async () => {
    const row = seedRow({ hostingTarget: 'fly', seedSource: FLY.key });
    patchAnswer = {
      status: 200,
      body: { ...row, seedSource: SEED_SOURCE_INITIALISED, seedMatch: null },
    };
    renderRoom([row]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Starter' }));
    fireEvent.click(screen.getByRole('option', { name: /Initialised repository/ }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch?.[0]).toBe('/api/projects/ACME/repositories/row-web');
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ seedSource: SEED_SOURCE_INITIALISED });
    // The row the route answered is applied at once: a by-hand pick says so.
    expect(screen.getByTestId('seed-why-row-web').getAttribute('data-why')).toBe('by_hand');
  });

  it('says why a re-point was refused, in the person’s words, and keeps the starter', async () => {
    const row = seedRow({ hostingTarget: 'fly', seedSource: FLY.key });
    patchAnswer = {
      status: 422,
      body: {
        code: 'PROJECT_REPO_SEED_REFUSED',
        refusal: 'target_mismatch',
        error: 'The starter does not deploy to fly.',
      },
    };
    renderRoom([row]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Starter' }));
    fireEvent.click(screen.getByRole('option', { name: /Initialised repository/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.getAttribute('data-refusal')).toBe('target_mismatch');
    expect(alert.textContent).toContain("Initialised repository can't be used here.");
    expect(alert.textContent).toContain('this repository runs on Fly');
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByLabelText('Starts from Next.js · Fly')).toBeTruthy();
  });

  it('falls back to the server’s sentence for a refusal it has no copy for', async () => {
    patchAnswer = {
      status: 422,
      body: { code: 'PROJECT_REPO_SEED_REFUSED', refusal: null, error: 'Something new.' },
    };
    renderRoom([seedRow({ hostingTarget: 'fly', seedSource: FLY.key })]);
    fireEvent.click(screen.getByRole('combobox', { name: 'Starter' }));
    fireEvent.click(screen.getByRole('option', { name: /Initialised repository/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('Something new.');
  });
});

describe('a created row (§1.5)', () => {
  it('names the starter it came from, and offers no picker', () => {
    renderRoom([
      seedRow({
        state: 'created',
        realizedRepo: {
          id: 'gh-1',
          provider: 'github',
          owner: 'motir-projects',
          name: 'acme-web',
          repoRef: 'motir-projects/acme-web',
          defaultBranch: 'main',
          archived: false,
        },
        established: true,
      }),
    ]);
    expect(screen.getByText('Hosted by Motir · started from Next.js · serverless.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Starter' })).toBeNull();
    expect(screen.queryByTestId('seed-why-row-web')).toBeNull();
  });

  it('reads an initialised row as started as an initialised repository', () => {
    renderRoom([
      seedRow({
        state: 'created',
        seedSource: SEED_SOURCE_INITIALISED,
        hostingTarget: null,
        seedMatch: 'no_target',
        realizedRepo: {
          id: 'gh-1',
          provider: 'github',
          owner: 'motir-projects',
          name: 'acme-web',
          repoRef: 'motir-projects/acme-web',
          defaultBranch: 'main',
          archived: false,
        },
        established: true,
      }),
    ]);
    expect(
      screen.getByText('Hosted by Motir · started as an initialised repository.'),
    ).toBeTruthy();
  });
});
