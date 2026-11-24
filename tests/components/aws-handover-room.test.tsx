// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import type { ProjectRepoDto, ProjectRepoRoomViewDto } from '@/lib/dto/projectRepos';
import type {
  TenantAccountHandoverDto,
  TenantHandoverRoomDto,
} from '@/lib/dto/tenantAccountHandover';
import { TENANT_HANDOVER_STEPS } from '@/lib/ciFleet/hostingTenantAccounts';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE AWS HOSTING HANDOVER'S ENTRY, REFUSAL AND STEP in the Repositories room
// (Story MOTIR-9800 · MOTIR-12137 — design/repository-set/takeover--aws-handover
// panels 1–10), driven through the room itself, as the person meets it.
//
// What is pinned:
//   1. The entry appears on AWS-target rows only, and only for an organisation
//      admin; anyone else gets the helper line and no entry (panels 1 and 3).
//   2. Move on the organisation's ONLY AWS repository opens the flow's own start,
//      not the target picker, and writes nothing (panel 2).
//   3. The route's TAKEOVER_SHARED_AWS_ACCOUNT refusal is the Single-repository
//      refusal naming the others — not the generic failure banner, and no
//      re-read (panel 4).
//   4. The step checks both fields BEFORE any request, by the service's own rule
//      (panels 5–7); Start posts exactly the two fields (panel 8); a refusal is
//      worded in place and nothing is followed (panel 10); a start that answers
//      replaces the entry with the checklist (panel 11 on).
//
// The ONLY fakes are `fetch` and `useRouter`, as in repositories-room.test.tsx.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const NOW = '2026-11-24T12:00:00.000Z';
const ORG_ID = 'org-1';
const ACCOUNT_ID = 'tenant-1';
const HANDOVER_URL = `/api/organizations/${ORG_ID}/hosting/aws-handover`;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

let fetchMock: ReturnType<typeof vi.fn>;
let rows: ProjectRepoDto[] = [];
let handler: Handler = () => undefined;

beforeEach(() => {
  refresh.mockClear();
  handler = () => undefined;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const answered = await handler(String(url), init);
    if (answered) return answered;
    if (String(url).includes('/api/github/organizations')) return json(200, { organizations: [] });
    return json(200, { set: { rows }, connectCandidates: [] });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the entry on the row (panels 1 and 3)', () => {
  it('offers Take over AWS hosting on each AWS row for an admin, and nothing on a serverless row', () => {
    renderRoom({
      rows: [awsRow('web'), awsRow('api'), awsRow('docs', { hostingTarget: 'serverless' })],
    });
    for (const name of ['web', 'api']) {
      const row = screen.getByTestId(`takeover-row-${name}`);
      expect(
        within(row).getByRole('button', {
          name: `Take over AWS hosting for motir-projects/acme-${name}`,
        }),
      ).toBeTruthy();
      // The shipped move stays beside it.
      expect(
        within(row).getByRole('button', { name: `Move motir-projects/acme-${name} to my GitHub` }),
      ).toBeTruthy();
    }
    const docs = screen.getByTestId('takeover-row-docs');
    expect(within(docs).queryByRole('button', { name: /Take over AWS hosting/ })).toBeNull();
  });

  it('gives a non-admin the helper line in place of the entry', () => {
    renderRoom({ rows: [awsRow('web')], awsHandover: null });
    const row = screen.getByTestId('takeover-row-web');
    expect(
      within(row).getByText(
        'Runs on moooon’s AWS account, which leaves Motir whole — an organization admin hands it over.',
      ),
    ).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Take over AWS hosting/ })).toBeNull();
  });
});

describe('Move on the only AWS repository (panel 2)', () => {
  it('opens the flow’s own start, writes nothing, and leads on to the step', async () => {
    renderRoom({ rows: [awsRow('web')], awsHandover: overview(['web']) });
    await click(screen.getByRole('button', { name: 'Move motir-projects/acme-web to my GitHub' }));

    const dialog = screen.getByRole('dialog', { name: 'Move acme-web to your GitHub' });
    expect(within(dialog).getByText('One AWS account per organization')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Every moooon repository that runs on AWS is handed over together, in one step you can follow and resume.',
      ),
    ).toBeTruthy();
    expect(posts()).toEqual([]);

    await click(within(dialog).getByRole('button', { name: 'Take over AWS hosting' }));
    expect(screen.getByRole('dialog', { name: 'Hand moooon’s AWS account over' })).toBeTruthy();
  });

  it('closes on Cancel', async () => {
    renderRoom({ rows: [awsRow('web')], awsHandover: overview(['web']) });
    await click(screen.getByRole('button', { name: 'Move motir-projects/acme-web to my GitHub' }));
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the single-repository refusal (panel 4)', () => {
  it('names the others, says nothing changed, and neither fails nor re-reads', async () => {
    handler = (url, init) =>
      url.includes('/takeover') && init?.method === 'POST'
        ? json(409, {
            code: 'TAKEOVER_SHARED_AWS_ACCOUNT',
            error: 'shared',
            repositories: ['motir-projects/acme-api', 'motir-projects/acme-intranet'],
          })
        : undefined;
    renderRoom({ rows: [awsRow('web'), awsRow('api')], awsHandover: overview(['web', 'api']) });

    await click(screen.getByRole('button', { name: 'Move motir-projects/acme-web to my GitHub' }));
    // Two AWS repositories share the account, so the shipped picker opens.
    await confirmMove();
    const reads = fetchMock.mock.calls.length;

    const dialog = await screen.findByRole('dialog', {
      name: 'acme-web moves with 2 other repositories',
    });
    const others = within(dialog).getByRole('list', {
      name: 'The other repositories on the account',
    });
    expect(
      within(others)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['motir-projects/acme-api', 'motir-projects/acme-intranet']);
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Nothing has changed. acme-web is still hosted by Motir, and so are the others.',
    );
    expect(screen.queryByText(/didn't go through/)).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(reads);

    await click(within(dialog).getByRole('button', { name: 'Take over AWS hosting' }));
    expect(screen.getByRole('dialog', { name: 'Hand moooon’s AWS account over' })).toBeTruthy();
  });

  it('gives a non-admin Close in place of the offer', async () => {
    handler = (url, init) =>
      url.includes('/takeover') && init?.method === 'POST'
        ? json(409, { code: 'TAKEOVER_SHARED_AWS_ACCOUNT', repositories: ['x/y', 42] })
        : undefined;
    renderRoom({ rows: [awsRow('web')], awsHandover: null });
    await click(screen.getByRole('button', { name: 'Move motir-projects/acme-web to my GitHub' }));
    await confirmMove();

    const dialog = await screen.findByRole('dialog', {
      name: 'acme-web moves with one other repository',
    });
    expect(
      within(dialog).getByText(
        'An organization admin can take over AWS hosting for all of them together.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Take over AWS hosting' })).toBeNull();
    await click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the handover step (panels 5–10)', () => {
  async function openStep(names = ['web', 'api']) {
    renderRoom({ rows: names.map((n) => awsRow(n)), awsHandover: overview(names) });
    await click(
      screen.getByRole('button', {
        name: `Take over AWS hosting for motir-projects/acme-${names[0]}`,
      }),
    );
    return screen.getByRole('dialog', { name: 'Hand moooon’s AWS account over' });
  }

  it('lists every AWS repository handed over together, and says what happens in AWS', async () => {
    const dialog = await openStep();
    expect(within(dialog).getByText('motir-projects/acme-web')).toBeTruthy();
    expect(within(dialog).getByText('motir-projects/acme-api')).toBeTruthy();
    expect(within(dialog).getAllByText('Acme booking · acme-web')).toHaveLength(1);
    expect(
      within(dialog).getByText(/Motir never asks for a payment detail or a root password\./),
    ).toBeTruthy();
    // Two inputs only: the owner's email and the GitHub owner.
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(2);
  });

  it('names a repository not yet realized by its row name', async () => {
    const room = overview(['web']);
    room.repositories.push({
      id: 'row-new',
      name: 'acme-new',
      repoRef: null,
      projectName: 'Acme booking',
    });
    renderRoom({ rows: [awsRow('web')], awsHandover: room });
    await click(
      screen.getByRole('button', { name: 'Take over AWS hosting for motir-projects/acme-web' }),
    );
    expect(screen.getByText('acme-new')).toBeTruthy();
  });

  it('checks both fields before any request', async () => {
    const dialog = await openStep();
    await click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText('Enter an email address, like name@example.com.')).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Enter a GitHub account or organization name: letters, digits and single hyphens.',
      ),
    ).toBeTruthy();

    enter(within(dialog).getByLabelText('Owner email'), 'dana@acme.example');
    enter(within(dialog).getByLabelText('GitHub owner'), 'acme--labs');
    await click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).queryByText(/Enter an email address/)).toBeNull();
    expect(within(dialog).getByText(/Enter a GitHub account/)).toBeTruthy();
    expect(handoverCalls()).toEqual([]);
  });

  it('confirms who receives what, and Start posts exactly the two fields', async () => {
    let answer!: (r: Response) => void;
    handler = (url, init) =>
      url === HANDOVER_URL && init?.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    const dialog = await openStep();
    enter(within(dialog).getByLabelText('Owner email'), '  dana@acme.example ');
    enter(within(dialog).getByLabelText('GitHub owner'), 'acme');
    await click(within(dialog).getByRole('button', { name: 'Continue' }));

    const confirm = screen.getByRole('alertdialog', { name: 'Start the handover?' });
    expect(within(confirm).getByText('dana@acme.example')).toBeTruthy();
    expect(within(confirm).getByText('acme')).toBeTruthy();
    expect(
      within(confirm).getByText(
        'Previews of these 2 repositories are deleted, and Motir stops deploying them.',
      ),
    ).toBeTruthy();

    await click(within(confirm).getByRole('button', { name: 'Start handover' }));
    const calls = handoverCalls();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      ownerEmail: 'dana@acme.example',
      githubOwner: 'acme',
    });
    // Busy: Back is disabled while the start is in flight.
    expect(within(confirm).getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);

    await act(async () => answer(json(200, { handover: handoverDto() })));
    // The checklist replaces the dialog and the row entry.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'moooon’s AWS account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take over AWS hosting for/ })).toBeNull();
    expect(screen.getByText('GitHub moves each repository to acme.')).toBeTruthy();
  });

  it.each([
    [
      'TENANT_ACCOUNT_NOT_READY',
      'The handover couldn’t start: moooon’s AWS account isn’t ready to hand over yet. Nothing was changed — try again in a few minutes.',
    ],
    [
      'TENANT_HANDOVER_ALREADY_STARTED',
      'The handover couldn’t start: it has already been started for moooon’s AWS account. Nothing was changed — reload the page to follow it.',
    ],
    [
      'GITHUB_IDENTITY_REQUIRED',
      'The handover couldn’t start: connect your GitHub account first, so the repositories can be transferred. Nothing was changed.',
    ],
    [
      'TENANT_HANDOVER_INPUT_INVALID',
      'The handover couldn’t start: check the owner email and the GitHub owner. Nothing was changed.',
    ],
    ['SOMETHING_ELSE', 'The handover couldn’t start. Nothing was changed — try again in a moment.'],
  ])('words the %s refusal in place and follows nothing', async (code, sentence) => {
    handler = (url, init) =>
      url === HANDOVER_URL && init?.method === 'POST' ? json(409, { code }) : undefined;
    const dialog = await openStep();
    enter(within(dialog).getByLabelText('Owner email'), 'dana@acme.example');
    enter(within(dialog).getByLabelText('GitHub owner'), 'acme');
    await click(within(dialog).getByRole('button', { name: 'Continue' }));
    const confirm = screen.getByRole('alertdialog');
    await click(within(confirm).getByRole('button', { name: 'Start handover' }));

    expect(within(confirm).getByRole('alert').textContent).toBe(sentence);
    expect(screen.queryByRole('heading', { name: 'moooon’s AWS account' })).toBeNull();

    // Back returns to step 1 with the fields kept.
    await click(within(confirm).getByRole('button', { name: 'Back' }));
    expect((screen.getByLabelText('Owner email') as HTMLInputElement).value).toBe(
      'dana@acme.example',
    );
  });

  it('reads a network failure as try again', async () => {
    handler = (url, init) => {
      if (url === HANDOVER_URL && init?.method === 'POST') throw new TypeError('Failed to fetch');
      return undefined;
    };
    const dialog = await openStep();
    enter(within(dialog).getByLabelText('Owner email'), 'dana@acme.example');
    enter(within(dialog).getByLabelText('GitHub owner'), 'acme');
    await click(within(dialog).getByRole('button', { name: 'Continue' }));
    await click(screen.getByRole('button', { name: 'Start handover' }));
    expect(screen.getByRole('alert').textContent).toMatch(/try again in a moment/);
  });

  it('closes from either step with the dialog’s own close button', async () => {
    let dialog = await openStep();
    await click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    await click(
      screen.getByRole('button', { name: 'Take over AWS hosting for motir-projects/acme-web' }),
    );
    dialog = screen.getByRole('dialog', { name: 'Hand moooon’s AWS account over' });
    enter(within(dialog).getByLabelText('Owner email'), 'dana@acme.example');
    enter(within(dialog).getByLabelText('GitHub owner'), 'acme');
    await click(within(dialog).getByRole('button', { name: 'Continue' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Start the handover?' });
    await click(within(confirm).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers nothing to hand over when the organisation has no AWS repository', async () => {
    renderRoom({ rows: [awsRow('web')], awsHandover: overview([]) });
    await click(
      screen.getByRole('button', { name: 'Take over AWS hosting for motir-projects/acme-web' }),
    );
    expect(
      screen.getByText(
        'moooon has no repositories running on AWS, so there is nothing to hand over.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
    await click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a handover already started', () => {
  it('shows the checklist on load and no entry on the rows', async () => {
    handler = (url) =>
      url.startsWith(`${HANDOVER_URL}?tenantAccountId=`)
        ? json(200, { handover: handoverDto() })
        : undefined;
    renderRoom({
      rows: [awsRow('web')],
      awsHandover: { ...overview(['web']), handoverStarted: true, accountState: 'handing_over' },
    });
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'moooon’s AWS account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take over AWS hosting/ })).toBeNull();
    // Move on the row then opens the shipped picker: the account is already leaving.
    await click(screen.getByRole('button', { name: 'Move motir-projects/acme-web to my GitHub' }));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function renderRoom(opts: { rows: ProjectRepoDto[]; awsHandover?: TenantHandoverRoomDto | null }) {
  rows = opts.rows;
  const awsHandover =
    opts.awsHandover === undefined
      ? overview(opts.rows.filter((r) => r.hostingTarget === 'aws').map((r) => r.role))
      : opts.awsHandover;
  return renderWithIntl(
    <RepositoriesRoom
      projectKey="ACME"
      view={view(opts.rows)}
      connectHref="/settings/account/git"
      canAddRepositories={false}
      organizationName="moooon"
      projectName="Acme booking"
      organizationInventoryHref="/settings/organization/git"
      nowIso={NOW}
      awsHandover={awsHandover}
    />,
  );
}

function view(rowsIn: ProjectRepoDto[]): ProjectRepoRoomViewDto {
  return {
    projectId: 'proj-1',
    hostOwner: 'motir-projects',
    githubLogin: 'yue-personal',
    githubAvatarUrl: null,
    installHref: 'https://github.com/apps/motir/installations/new',
    ciPaused: false,
    otherHostedProjects: [],
    connected: [],
    connectedInDomain: false,
    seeds: {},
    rows: rowsIn,
  } as unknown as ProjectRepoRoomViewDto;
}

function overview(names: string[]): TenantHandoverRoomDto {
  return {
    organizationId: ORG_ID,
    tenantAccountId: ACCOUNT_ID,
    accountState: 'ready',
    handoverStarted: false,
    repositories: names.map((n) => ({
      id: `row-${n}`,
      name: `acme-${n}`,
      repoRef: `motir-projects/acme-${n}`,
      projectName: 'Acme booking',
    })),
  };
}

function awsRow(role: string, overrides: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  const name = `acme-${role}`;
  return {
    id: `row-${role}`,
    projectId: 'proj-1',
    role,
    label: null,
    name,
    seedSource: 'platform-starter',
    state: 'created',
    failureReason: null,
    proposalSignal: 'default-web',
    seedMatch: null,
    realizedRepo: {
      id: `gh-${role}`,
      provider: 'github',
      owner: 'motir-projects',
      name,
      repoRef: `motir-projects/${name}`,
      defaultBranch: 'main',
      archived: false,
    },
    established: true,
    takeover: null,
    access: { state: 'accepted', login: 'yue-personal', invitationUrl: null },
    hostingTarget: 'aws',
    hostingUseCase: null,
    hostingSize: null,
    hostingShape: null,
    position: `a${role}`,
    createdAt: NOW,
    hostedDeletionStartedAt: null,
    updatedAt: NOW,
    ...overrides,
  } as ProjectRepoDto;
}

function handoverDto(): TenantAccountHandoverDto {
  return {
    tenantAccountId: ACCOUNT_ID,
    organizationId: ORG_ID,
    state: 'handing_over',
    awsAccountId: '482109375512',
    deployRoleArn: null,
    steps: TENANT_HANDOVER_STEPS.map((step) => ({
      step,
      status: 'pending',
      lastError: null,
      missing: [],
      attempts: 0,
      completedAt: null,
    })),
    applications: [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function posts() {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
  );
}

function handoverCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).startsWith(HANDOVER_URL)) as Array<
    [string, RequestInit | undefined]
  >;
}

function enter(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

async function click(target: Element): Promise<void> {
  fireEvent.click(target);
  await act(async () => {});
}

/** The shipped picker's two steps: the target (personal by default), then the costs. */
async function confirmMove(): Promise<void> {
  await click(await screen.findByRole('button', { name: 'Continue' }));
  await click(await screen.findByRole('button', { name: 'Move this repository' }));
}
