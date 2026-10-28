// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { RepositoriesRoom } from '@/app/(authed)/settings/project/repositories/_components/RepositoriesRoom';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { SEED_SOURCE_ORGANIZATION } from '@/lib/projectRepos/vocabulary';
import type {
  ProjectRepoConnectCandidateDto,
  ProjectRepoConnectedDto,
  ProjectRepoDto,
  ProjectRepoRoomViewDto,
  ProjectRepoTakeoverDto,
} from '@/lib/dto/projectRepos';

// THE TAKE-IT-OVER SURFACE (Story MOTIR-1775 · MOTIR-1939 —
// design/repository-set §14), at the altitude where its claims are actually
// falsifiable.
//
// What is pinned here is every property the card would be WRONG without, and
// each is asserted as a behaviour rather than as a class name:
//
//   1. The per-row action appears ONLY on a Motir-owned row; a connect-existing
//      row is the already-yours no-op with NO action. Asserted per row, because
//      the bug is a control leaking onto the wrong one.
//   2. `transfer_pending` / `awaiting_reinstall` are DURABLE, RE-PROMPTABLE
//      states — a place with something to go do, never a spinner. Asserted by
//      the presence of the re-prompt and the ABSENCE of any progressbar.
//   3. Taking over one row of three leaves the others rendering AND pressable
//      (MOTIR-711's per-row rule — the property most easily lost).
//   4. The page-state contract: the mutation's returned row is applied LOCALLY
//      (never re-read — a refresh there causes the visible revert) AND
//      `router.refresh()` is called for the server-rendered header. Both, or the
//      surface is half-updated.
//   5. The picker degrades: its loading and unavailable states are real, and the
//      PERSONAL account is selectable through both.
//   6. No identity → MOTIR-1900's connect prompt, not a failure and not a second
//      prompt of this flow's own.
//   7. The costs are stated before the commit, and nothing says "one click".
//
// The ONLY fakes are `fetch` (the wire) and `useRouter` (the framework boundary)
// — the same line every component suite in this repo fakes at.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const NOW = '2026-07-31T12:00:00.000Z';
/** Comfortably past the 3-day staleness threshold, so the "days later" copy is
 *  exercised by a date rather than by reaching into the component. */
const LONG_AGO = '2026-07-20T12:00:00.000Z';

let fetchMock: ReturnType<typeof vi.fn>;
/** What the SET read answers with — the rows currently rendered, so a re-read
 *  reflects reality instead of emptying the room out from under the test. */
let currentRows: ProjectRepoDto[] = [];
/** The other half of the same payload — the installation's repositories, which the
 *  island maps into the connected section on every refetch (MOTIR-3126). */
let currentCandidates: ProjectRepoConnectCandidateDto[] = [];

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async (url: string) => jsonOk(defaultFetch(String(url))));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the room — which rows offer a move (design §14, panel 1)', () => {
  it('offers the move on a Motir-owned row and NOTHING on an already-yours row', async () => {
    renderRoom({ rows: [hostedRow(), connectedRow()] });

    const hosted = screen.getByTestId('takeover-row-web');
    const yours = screen.getByTestId('takeover-row-shared');

    expect(within(hosted).getByText('Created')).toBeTruthy();
    expect(
      within(hosted).getByRole('button', {
        name: 'Move motir-projects/acme-booking-web to my GitHub',
      }),
    ).toBeTruthy();

    // The already-yours no-op: the state word, the reassurance, and no control.
    expect(within(yours).getByText('Yours')).toBeTruthy();
    expect(
      within(yours).getByText(
        'You already own this one — nothing to move, and Motir never bills its CI.',
      ),
    ).toBeTruthy();
    expect(within(yours).queryByRole('button')).toBeNull();
  });

  it('renders the empty room rather than an empty list when the project has NEITHER registry', () => {
    renderRoom({ rows: [], connected: [], connectedInDomain: false });
    // ⚠️ RE-POINTED BY MOTIR-4954 (design §18.5). The old sentence said "No
    // repositories are CONNECTED to this project yet" and offered to connect code
    // from GitHub or approve a plan. Both halves were about the wrong tier by
    // then: a repository is connected at the ORGANISATION and LINKED to a project,
    // and the first act available here is to add one the organisation already
    // has. The replacement names both paths in the order a reader will need them.
    expect(
      screen.getByText(
        'No repositories in this project yet. Add one moooon already has, or connect a new repository.',
      ),
    ).toBeTruthy();
    // The empty state has a way out — and after MOTIR-4669 it is the ACCOUNT's
    // Git pane, not the deleted workspace one: connecting a personal identity is
    // the member's own act, at the tier that owns it.
    expect(screen.getByRole('link', { name: 'Connect a repository' }).getAttribute('href')).toBe(
      '/settings/account/git',
    );
  });
});

// THE TWO REGISTRIES (MOTIR-3126 · design §16) — a project's repositories live in
// `project_repository` OR in the workspace's connected set OR in both, and the room
// used to read only the first. What is pinned here is one case per project shape,
// asserted as what the reader SEES rather than as which branch ran:
//
//   1. Arrived with code, EMPTY set — the defect. Five repositories, and the page
//      said the project had none. The empty state must NOT appear.
//   2. Arrived with code, non-empty set — both sections, each named, and the
//      takeover offered on the hosted rows only.
//   3. Born in Motir — the set alone, and the organisation heading ABSENT rather
//      than present-and-empty.
//
// ⚠️ MOTIR-4820 RE-SOURCED AND RENAMED THE SECOND SECTION. It was `Your own
// repositories`, fed by the connected list; it is now `From your organisation`,
// fed by the LADDER — the picked links plus whatever `connectedInDomain` layers.
// The cases below are unchanged in substance because the ROWS are the same rows;
// what changed is the name they are asked for by, which is the whole defect: the
// old heading named the WORKSPACE tier, and a separate, EMPTY `From your
// organisation` sat above it claiming the project had none.
//   4. Neither — the one shape the empty state is true of (above).
//
// Plus the property the sections exist FOR: nothing in the connected list is
// pressable, because there is nothing to move.

// ⚠️ THE TWO REGISTRIES (MOTIR-3126) — RE-POINTED TO ONE BY MOTIR-4954.
//
// MOTIR-3126's finding was real and is not being un-fixed: a room reading
// `project_repository` alone told Motir's own project it had no repositories
// beside five that were indexed and pinnable right now. The answer it chose was
// to draw the LADDER's whole domain, and that is the half this card reverses —
// the ladder answers *what can this project REACH*, and a page headed
// Repositories on a project is asking *what does this project WORK ON*.
//
// So the fix moved rather than went away. The organisation's repositories are
// reachable from this page at the two moments a person is choosing from them —
// the `Add repository` picker and the `See every repository in {org}` navigation
// block — and the ROWS are the project's links. Every case below keeps its
// original fixture, including a server view that still carries `connected` and
// still says `connectedInDomain: true`, and asserts the inverse of what it used
// to. Keeping the fixture is the point: `projectRepoRoomService` on `main` still
// ships both fields, so these cases prove the page is correct WITHOUT the service
// change MOTIR-4955 has open — and they keep passing after it lands.
describe('the ONE registry — the project`s links (MOTIR-3126 → MOTIR-4954)', () => {
  it('⚠️ draws NO row for a layered repository, however loudly the server view offers one', () => {
    renderRoom({
      rows: [],
      connected: [
        connectedRepo('motir-core', 'moooon-B-V'),
        connectedRepo('motir-ai', 'moooon-B-V'),
      ],
      connectedInDomain: true,
      // Panel 9 rather than the signpost: this is a reader who CAN add, so the
      // room draws its sections and its add door. The signpost case — nothing to
      // show and no way to add — is asserted in the describe above.
      canAdd: true,
    });

    const section = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(section).queryByText('motir-core')).toBeNull();
    expect(within(section).queryByText('motir-ai')).toBeNull();
    expect(within(section).queryAllByRole('listitem')).toHaveLength(0);
    // Panel 9: it says the PROJECT is empty, while the organisation is not.
    expect(screen.getByText(/No repositories in this project yet/)).toBeTruthy();
    // And no hosted section at all — an absence, never an empty-stated one.
    expect(screen.queryByRole('region', { name: 'Hosted by Motir' })).toBeNull();
  });

  it('renders BOTH sections, with the move offered only on the hosted one', () => {
    // Unchanged in intent, re-fixtured: the org section's member is a LINK now
    // rather than a layered entry. The reason the two are drawn apart is the same
    // — a repository the organisation already owns has no takeover to offer.
    renderRoom({
      rows: [hostedRow(), orgRow('design-tokens')],
      connected: [],
      connectedInDomain: false,
    });

    const hosted = screen.getByRole('region', { name: 'Hosted by Motir' });
    const yours = screen.getByRole('region', { name: 'From your organisation' });

    expect(
      within(hosted).getByRole('button', {
        name: 'Move motir-projects/acme-booking-web to my GitHub',
      }),
    ).toBeTruthy();
    expect(within(yours).getByText('design-tokens')).toBeTruthy();
    expect(within(yours).queryByRole('button', { name: /to my GitHub/ })).toBeNull();
  });

  it('⚠️ NOW HOLDS FOR EVERY PROJECT: `connectedInDomain` does not add a section', () => {
    // This case used to be the counterfactual — "omits the connected section
    // entirely for a project answered by its set alone" — and it was the only
    // arm in which the page was right. It is now the whole behaviour, so the
    // ladder's boolean is varied across its range and the answer does not move.
    for (const connectedInDomain of [true, false]) {
      renderRoom({ rows: [hostedRow()], connected: [connectedRepo('x')], connectedInDomain });
      expect(screen.getByRole('region', { name: 'Hosted by Motir' })).toBeTruthy();
      expect(screen.queryByText('x')).toBeNull();
      cleanup();
    }
  });

  it('renders a link Motir has not realized yet — no guessed branch, no stray slash', () => {
    // Two honest degradations rather than states to hide. A row that names a
    // repository not yet created on the host has no branch to print and no owner
    // to prefix, so both are ABSENT — never a guessed "main", never a bare "/".
    renderRoom({ rows: [orgRow('not-yet', false)], connected: [], connectedInDomain: false });

    const yours = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(yours).getByText('not-yet')).toBeTruthy();
    expect(within(yours).queryByText('main')).toBeNull();
    expect(within(yours).queryByText('moooon-B-V/')).toBeNull();
  });

  it('⚠️ AC 2 — a REFETCH cannot grow an organisation row, whatever the payload carries', () => {
    // RE-POINTED, and it is the case that mattered most. It used to assert the
    // opposite — that the establish view's `connectCandidates` MUST reach this
    // island, because a section fed by the server render alone went stale on an
    // island `router.refresh()` cannot reach. That re-read is exactly where the
    // surviving duplicate came from: it deduped against a `rowsRef` that did not
    // yet hold the row just added. The island no longer reads that half of the
    // payload at all, so the staleness and the duplicate are both gone, and
    // neither can come back through a dedup that is subtly wrong.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 'PROJECT_REPO_TAKEOVER_STATE' }), {
          status: 409,
        });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({
      rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })],
      connected: [connectedRepo('design-tokens')],
      connectedInDomain: true,
    });

    // The workspace gains a repository between the render and the re-read. Under
    // the old contract this island was required to show it; under this one it is
    // required not to.
    currentCandidates = [...currentCandidates, toCandidate(connectedRepo('acme-infra'))];

    return click(screen.getByRole('button', { name: /Check .* again/ })).then(async () => {
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(screen.queryByText('acme-infra')).toBeNull();
      expect(screen.queryByText('design-tokens')).toBeNull();
    });
  });

  it('⚠️ AC 2 — after an ADD, exactly one row appears and it is the one that was added', () => {
    // The post-mutation island state, which is where the duplicate actually
    // lived: `onPick` inserts optimistically into a list the server render also
    // seeded, and the old recompute deduped the layered half against a `rowsRef`
    // that had not caught up. One list cannot disagree with itself.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/repositories/available')) {
        return jsonOk([
          {
            id: 'gh-added',
            owner: 'moooon-B-V',
            name: 'motir-core',
            fullName: 'moooon-B-V/motir-core',
            defaultBranch: 'main',
            provider: 'github',
            archived: false,
            connectedFromWorkspaceId: null,
            hostedByMotir: false,
          },
        ]);
      }
      if (String(url).includes('/repositories/add') && init?.method === 'POST') {
        return jsonOk(orgRow('motir-core'));
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({
      rows: [],
      connected: [connectedRepo('motir-core', 'moooon-B-V')],
      connectedInDomain: true,
      canAdd: true,
    });

    return click(screen.getByRole('button', { name: /Add repository/i })).then(async () => {
      const option = await screen.findByRole('button', { name: /moooon-B-V\/motir-core/ });
      await click(option);
      const section = await screen.findByRole('region', { name: 'From your organisation' });
      await waitFor(() => expect(within(section).getAllByRole('listitem')).toHaveLength(1));
      // The name appears ONCE. It appeared twice on the shipped page.
      expect(within(section).getAllByText('motir-core')).toHaveLength(1);
    });
  });

  it('⚠️ AC 2 — after a REMOVE, the row goes and nothing layers back in behind it', () => {
    // The mirror case, and the one the layered half made impossible: removing the
    // LINK used to leave the same repository rendered as a domain entry, so the
    // act appeared to do nothing.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return jsonOk({});
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({
      rows: [orgRow('motir-core')],
      connected: [connectedRepo('motir-core', 'moooon-B-V')],
      connectedInDomain: true,
      canAdd: true,
    });

    return click(screen.getByRole('button', { name: 'Remove from this project' })).then(
      async () => {
        await click(await screen.findByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(screen.queryByText('motir-core')).toBeNull());
        expect(screen.getByText(/No repositories in this project yet/)).toBeTruthy();
      },
    );
  });

  it('⚠️ AC 8 — the inventory route is NAVIGATION, and not inside the section', () => {
    // AMENDED (MOTIR-4820 → MOTIR-4954). It read `Choose which repositories Motir
    // can see` and pointed at the pane that owned CONNECTING, because this section
    // could not act on its own rows; §17.2 made it a VIEW instead. §18.6 then
    // moved it OUT: it is the only route from a project context to the
    // organisation's inventory, so it is navigation with its own landmark rather
    // than a footnote under rows it is not about.
    renderRoom({ rows: [orgRow('design-tokens')], connected: [], connectedInDomain: false });

    const nav = screen.getByRole('navigation', { name: 'Organisation repository inventory' });
    expect(
      within(nav)
        .getByRole('link', { name: 'See every repository in moooon' })
        .getAttribute('href'),
    ).toBe('/settings/organization/git');
    const yours = screen.getByRole('region', { name: 'From your organisation' });
    expect(within(yours).queryByRole('link', { name: /See every repository/ })).toBeNull();
    expect(screen.queryByText('Choose which repositories Motir can see')).toBeNull();
  });
});

describe('the waiting states are places, not spinners (panels 4, 5, 7)', () => {
  it('renders transfer_pending as a durable, re-promptable row with somewhere to go', () => {
    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })] });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Waiting for you to accept on GitHub')).toBeTruthy();
    expect(within(row).getByRole('status')).toBeTruthy();
    // The re-prompt AND the way out — the two things that make an abandoned
    // hand-off recoverable rather than wedged.
    expect(
      within(row).getByRole('link', {
        name: 'Accept motir-projects/acme-booking-web on GitHub',
      }),
    ).toBeTruthy();
    expect(
      within(row).getByRole('button', { name: 'Check motir-projects/acme-booking-web again' }),
    ).toBeTruthy();
    // NOT a spinner: an unbounded wait on a human must never be drawn as progress.
    expect(within(row).queryByRole('progressbar')).toBeNull();
  });

  it('renders awaiting_reinstall with the install hand-off AND the dispatch consequence', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'awaiting_reinstall', transferredAt: NOW }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Install Motir on yue-personal')).toBeTruthy();
    // The CONSEQUENCE, not just the chore — and as an alert, because dispatch
    // being off is the thing the user did not ask for.
    expect(within(row).getByRole('alert').textContent).toContain(
      "Motir can't dispatch work to this repository",
    );
    const install = within(row).getByRole('link', {
      name: 'Install Motir for motir-projects/acme-booking-web on GitHub',
    });
    // The SHIPPED install screen — never a faked in-app repository picker.
    expect(install.getAttribute('href')).toBe('https://github.com/apps/motir/installations/new');
  });

  it('says so when a wait has been sitting for days, and still does not call it an error', () => {
    renderRoom({
      rows: [
        hostedRow({ takeover: takeover({ state: 'transfer_pending', requestedAt: LONG_AGO }) }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Still waiting for you to accept on GitHub')).toBeTruthy();
    expect(within(row).getByText(/Nothing is wrong and nothing was lost/)).toBeTruthy();
    // An unaccepted transfer is NOT a failure and is never tinted as one.
    expect(within(row).queryByText("Couldn't move it")).toBeNull();
  });

  it('drops the install button rather than linking nowhere when no App slug is configured', () => {
    renderRoom({
      rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })],
      installHref: null,
    });
    expect(screen.queryByRole('link', { name: /Install Motir for/ })).toBeNull();
    // The re-prompt survives — the row still is not a dead end.
    expect(screen.getByRole('button', { name: /Check .* again/ })).toBeTruthy();
  });
});

describe('done and failed (panels 6, 7)', () => {
  it('settles into the same shape a brought-in repository has, plus who pays now', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'done', transferredAt: NOW, completedAt: NOW }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');
    expect(within(row).getByText('Yours')).toBeTruthy();
    expect(within(row).getByText(/GitHub bills you for Actions on it from now on/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: /Move .* to my GitHub/ })).toBeNull();
  });

  it('explains an ORG refusal in the user’s own language AND keeps GitHub’s real reason', async () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({
            state: 'failed',
            targetOwner: 'acme-inc',
            failureReason: 'GitHub refused the transfer (HTTP 403).',
          }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText("Couldn't move it")).toBeTruthy();
    expect(within(row).getByRole('alert').textContent).toContain(
      'you need permission to create repositories in that organization',
    );
    expect(within(row).getByText('GitHub refused the transfer (HTTP 403).')).toBeTruthy();
    // Both recoveries — no state is a dead end.
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Pick a different account' })).toBeTruthy();
  });

  it('shows only the recorded reason when the target was the user’s own account', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'failed', failureReason: 'GitHub was unreachable.' }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');
    expect(within(row).getByText('GitHub was unreachable.')).toBeTruthy();
    expect(within(row).queryByText(/permission to create repositories/)).toBeNull();
  });
});

describe('the decision modal (panels 2–3)', () => {
  it('offers the personal account first, then the organizations, with the choice checked', async () => {
    renderRoom({ rows: [hostedRow()] });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    const personal = await screen.findByRole('option', { name: /yue-personal/ });
    expect(personal.getAttribute('aria-selected')).toBe('true');

    const org = await screen.findByRole('option', { name: /acme-inc/ });
    expect(org.getAttribute('aria-selected')).toBe('false');

    // The org price, stated ONCE under the list — never used to hide the option.
    expect(screen.getByText(/needs permission to create repositories there/)).toBeTruthy();

    await click(org);
    expect(
      (await screen.findByRole('option', { name: /acme-inc/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('renders the org lookup as a real loading state, with the personal account already usable', async () => {
    // A lookup that never resolves — the loading state is a STATE, not a frame
    // between two renders, so it has to hold on its own.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/github/organizations')
        ? new Promise(() => {})
        : jsonOk(defaultFetch(String(url))),
    );
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(await screen.findByText('Looking up your organizations…')).toBeTruthy();
    expect(
      screen.getByText(
        'You can go ahead with your personal account — the lookup only adds organizations.',
      ),
    ).toBeTruthy();
    // The whole point of the degradation: the personal option is present from
    // first paint, so focus is never trapped in an empty listbox.
    expect(screen.getByRole('option', { name: /yue-personal/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false);
  });

  it('degrades — not blocks — when the org lookup fails, and can be retried', async () => {
    let attempts = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/api/github/organizations')) {
        attempts += 1;
        if (attempts === 1) return new Response('', { status: 502 });
        return jsonOk({ organizations: [{ login: 'acme-inc', avatarUrl: null }] });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(
      await screen.findByText(
        "Motir couldn't reach your GitHub organizations just now, so only your personal account is listed.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('option', { name: /yue-personal/ })).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('option', { name: /acme-inc/ })).toBeTruthy();
  });

  it('states the three real costs before the commit — and never says "one click"', async () => {
    renderRoom({ rows: [hostedRow()] });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    await click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('What this takes')).toBeTruthy();
    expect(screen.getByText('A GitHub account you own.')).toBeTruthy();
    // The asynchrony is stated in the AFFIRMATIVE — the ADR's honesty rule is
    // the point of the panel, not a caveat beneath it.
    expect(screen.getByText("A transfer you accept on GitHub. It isn't instant.")).toBeTruthy();
    expect(screen.getByText('Re-installing the Motir app on the new owner.')).toBeTruthy();
    expect(
      screen.getByText(
        'GitHub bills you for Actions directly from then on, and Motir stops charging CI credits.',
      ),
    ).toBeTruthy();

    const body = document.body.textContent ?? '';
    for (const banned of ['one click', 'One click', 'instantly', 'simply']) {
      expect(body).not.toContain(banned);
    }
  });

  it('reuses MOTIR-1900’s connect prompt when there is no GitHub identity — not a failure', async () => {
    renderRoom({ rows: [hostedRow()], githubLogin: null });

    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    expect(await screen.findByRole('dialog', { name: 'Connect GitHub first' })).toBeTruthy();
    // MOTIR-1900's own copy and its two actions, verbatim — no second prompt.
    expect(screen.getByText(enMessages.repositorySet.accessLead)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect GitHub' }).getAttribute('href')).toBe(
      '/settings/account/git',
    );
    expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
    // No picker, and nothing to confirm.
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the page-state contract after a takeover (§14.10)', () => {
  it('applies the returned row LOCALLY and refreshes the server-rendered header — both', async () => {
    const moved: ProjectRepoDto = hostedRow({
      takeover: takeover({ state: 'transfer_pending' }),
    });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return jsonOk({ row: moved, state: 'transfer_pending', transferAccepted: false });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    await click(await screen.findByRole('button', { name: 'Continue' }));
    await click(await screen.findByRole('button', { name: 'Move this repository' }));

    // Surface 1 — the row shows what the mutation RETURNED.
    expect(await screen.findByText('Waiting for you to accept on GitHub')).toBeTruthy();

    // Surface 2 — the server-rendered summary + paused banner. `router.refresh()`
    // is the ONLY thing that reaches them, so its absence is a real half-update.
    await waitFor(() => expect(refresh).toHaveBeenCalled());

    // …and surface 1 was NOT re-read: a refresh of the acted-on row is what
    // causes the visible revert this contract exists to prevent.
    const rereads = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith('/repositories') &&
        (init as RequestInit | undefined)?.method !== 'POST',
    );
    expect(rereads).toHaveLength(0);
  });

  it('sends the chosen owner, and posts NO body for a Check again re-probe', async () => {
    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });

    await click(screen.getByRole('button', { name: /Check .* again/ }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      // No `newOwner` → the completion probe, which is a no-op on a row that is
      // not awaiting a re-install and therefore always safe to press.
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({});
    });
  });

  it('surfaces a refused mutation and re-reads, rather than asserting a state the server denied', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 'PROJECT_REPO_TAKEOVER_STATE' }), {
          status: 409,
        });
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });
    await click(screen.getByRole('button', { name: /Check .* again/ }));

    const alert = await screen.findByText(
      "That didn't go through. Nothing was changed — try again.",
    );
    expect(alert).toBeTruthy();
    await waitFor(() => {
      const reread = fetchMock.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/repositories') &&
          (init as RequestInit | undefined)?.method !== 'POST',
      );
      expect(reread).toBe(true);
    });
  });
});

describe('rows are independent (MOTIR-711, panel 8)', () => {
  it('leaves the other two rows rendering and pressable while one is mid-move', async () => {
    // A takeover that never resolves, so the busy window is a state to assert in
    // rather than a race to catch.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Promise(() => {}) as unknown as Response;
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({
      rows: [
        hostedRow(),
        hostedRow({ id: 'row-api', role: 'api', name: 'acme-booking-api' }),
        connectedRow(),
      ],
    });

    await click(
      screen.getByRole('button', { name: 'Move motir-projects/acme-booking-web to my GitHub' }),
    );
    await click(await screen.findByRole('button', { name: 'Continue' }));
    await click(await screen.findByRole('button', { name: 'Move this repository' }));

    // The sibling is untouched: still Motir-hosted, still offering its own move,
    // and still ENABLED — a set-level busy flag would fail exactly here.
    const sibling = screen.getByTestId('takeover-row-api');
    expect(within(sibling).getByText('Created')).toBeTruthy();
    const siblingAction = within(sibling).getByRole('button', {
      name: 'Move motir-projects/acme-booking-api to my GitHub',
    });
    expect(siblingAction).toHaveProperty('disabled', false);

    // …and the row that was never Motir's is unaffected by any of it.
    expect(within(screen.getByTestId('takeover-row-shared')).getByText('Yours')).toBeTruthy();
  });

  it('counts three ownerships at once without implying the project is "moving"', () => {
    // The header summary is the PAGE's (server-rendered); what the island must
    // not do is collapse three legal states into one. Proven by all three
    // rendering their own state word side by side.
    renderRoom({
      rows: [
        hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) }),
        hostedRow({ id: 'row-api', role: 'api', name: 'acme-booking-api' }),
        connectedRow(),
      ],
    });
    expect(screen.getByText('Install Motir on yue-personal')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Yours')).toBeTruthy();
  });
});

describe('the polled async job (§14.10)', () => {
  it('re-reads the set while a hand-off is in flight, and stops once nothing is', async () => {
    vi.useFakeTimers();
    const { unmount } = renderRoom({
      rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/repositories'))).toBe(true);

    unmount();
    const after = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    // The interval is cleaned up on unmount — a settings page left open must not
    // keep polling a surface nobody is looking at.
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('does not poll a set where every row has settled', async () => {
    vi.useFakeTimers();
    renderRoom({ rows: [hostedRow(), connectedRow()] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/repositories')),
    ).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The states below were shipped UNTESTED, and invisibly so: all three of this
// room's components were entered in the coverage gate as literal
// `app/(authed)/…` paths, which the coverage matcher resolves to no file — so
// they never appeared in a report and their ≥90% thresholds gated nothing
// (MOTIR-2449). What follows is what that gate would have asked for.
// ─────────────────────────────────────────────────────────────────────────────

describe('a row whose repository was never realized (§14.7)', () => {
  it('degrades the reference to text and drops the hand-off rather than linking nowhere', () => {
    renderRoom({
      rows: [hostedRow({ realizedRepo: null, takeover: takeover({ state: 'transfer_pending' }) })],
    });
    const row = screen.getByTestId('takeover-row-web');

    // A dead control is worse than an absent one — the same call the missing
    // install-slug case makes one panel up.
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('acme-booking-web')).toBeTruthy();
    // The row is still not a dead end: the re-probe survives, named by the
    // fallback reference rather than by a repoRef that does not exist.
    expect(within(row).getByRole('button', { name: 'Check acme-booking-web again' })).toBeTruthy();
  });
});

describe('the waits that have been sitting for days say so (panel 5)', () => {
  it('renders a long-outstanding re-install as still-yours, never as an error', () => {
    renderRoom({
      rows: [
        hostedRow({
          takeover: takeover({ state: 'awaiting_reinstall', transferredAt: LONG_AGO }),
        }),
      ],
    });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText('Install Motir on yue-personal to finish')).toBeTruthy();
    expect(within(row).getByText(/It's yours and it stays yours/)).toBeTruthy();
    expect(within(row).queryByText("Couldn't move it")).toBeNull();
  });
});

describe('the failed row’s two recoveries actually go somewhere (panel 7)', () => {
  const failedRow = (over: Partial<ProjectRepoTakeoverDto> = {}) =>
    hostedRow({ takeover: takeover({ state: 'failed', ...over }) });

  it('opens the picker from BOTH Try again and Pick a different account', async () => {
    renderRoom({ rows: [failedRow({ failureReason: 'GitHub was unreachable.' })] });

    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Close' }));

    await click(screen.getByRole('button', { name: 'Pick a different account' }));
    // Both land in the SAME decision, which is the point: a refusal sends you
    // back to the choice, never to a dead end or to a silent re-attempt.
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('option', { name: /yue-personal/ })).toBeTruthy();
  });

  it('renders a refusal GitHub gave no reason for without an empty line where it would go', () => {
    renderRoom({ rows: [failedRow()] });
    const row = screen.getByTestId('takeover-row-web');

    expect(within(row).getByText("Couldn't move it")).toBeTruthy();
    // The target was the user's own account and GitHub said nothing, so the
    // alert carries neither the org explanation nor a blank reason paragraph.
    expect(within(row).queryByRole('alert')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('the picker’s remaining paths (panels 2–3)', () => {
  it('selects the personal account by pointer and by keyboard', async () => {
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    const org = await screen.findByRole('option', { name: /acme-inc/ });
    await click(org);
    expect(
      (await screen.findByRole('option', { name: /yue-personal/ })).getAttribute('aria-selected'),
    ).toBe('false');

    // An option is a div with `role="option"`, so Enter/Space are handled by
    // hand — the keyboard path is a different code path from the click, and
    // both have to select.
    const personal = screen.getByRole('option', { name: /yue-personal/ });
    fireEvent.keyDown(personal, { key: 'Enter' });
    await act(async () => {});
    expect(
      (await screen.findByRole('option', { name: /yue-personal/ })).getAttribute('aria-selected'),
    ).toBe('true');

    await click(await screen.findByRole('option', { name: /acme-inc/ }));
    fireEvent.keyDown(screen.getByRole('option', { name: /yue-personal/ }), { key: ' ' });
    await act(async () => {});
    expect(
      (await screen.findByRole('option', { name: /yue-personal/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('ignores a key that is neither Enter nor Space', async () => {
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));

    const org = await screen.findByRole('option', { name: /acme-inc/ });
    fireEvent.keyDown(org, { key: 'a' });
    await act(async () => {});
    expect(org.getAttribute('aria-selected')).toBe('false');
  });

  it('goes BACK from the costs to the choice, with the choice intact', async () => {
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    await click(await screen.findByRole('option', { name: /acme-inc/ }));
    await click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('What this takes')).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Back' }));

    // Step 2 is a REVIEW, so leaving it must not discard what was chosen.
    expect(
      (await screen.findByRole('option', { name: /acme-inc/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('closes the picker without moving anything', async () => {
    renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();

    await click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('drops an org lookup that lands after the identity it was made for changed', async () => {
    const pending = pendingOrgLookups();
    const { rerender } = renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    expect(await screen.findByText('Looking up your organizations…')).toBeTruthy();
    expect(pending).toHaveLength(1);

    // The connected identity changes under an open picker — a `router.refresh()`
    // re-render with a new view — so the lookup is re-issued for the new login
    // while the first is still in flight.
    rerender(room(roomView({ rows: [hostedRow()], githubLogin: 'yue-work' })));
    await act(async () => {});
    expect(pending).toHaveLength(2);

    // The FIRST lookup now answers, for an account nobody is looking at any
    // more. Applying it would list the wrong organizations under the right
    // heading, which is the whole reason the call is sequence-guarded.
    pending[0]!.resolve(jsonOk({ organizations: [{ login: 'stale-org', avatarUrl: null }] }));
    await act(async () => {});
    expect(screen.queryByRole('option', { name: /stale-org/ })).toBeNull();
    expect(screen.getByText('Looking up your organizations…')).toBeTruthy();

    pending[1]!.resolve(jsonOk({ organizations: [{ login: 'fresh-org', avatarUrl: null }] }));
    expect(await screen.findByRole('option', { name: /fresh-org/ })).toBeTruthy();
  });

  it('does not let a stale lookup’s FAILURE mark the current one failed', async () => {
    const pending = pendingOrgLookups();
    const { rerender } = renderRoom({ rows: [hostedRow()] });
    await click(screen.getByRole('button', { name: /Move .* to my GitHub/ }));
    expect(await screen.findByText('Looking up your organizations…')).toBeTruthy();

    rerender(room(roomView({ rows: [hostedRow()], githubLogin: 'yue-work' })));
    await act(async () => {});

    pending[0]!.reject(new Error('network'));
    await act(async () => {});

    // The superseded attempt's failure says nothing about the current one, so
    // the picker stays in its loading state rather than announcing a failure
    // the live lookup has not had.
    expect(screen.queryByText(/couldn’t reach your GitHub organizations/)).toBeNull();
    expect(screen.getByText('Looking up your organizations…')).toBeTruthy();
  });

  it('titles the picker from the row name when no repository was realized', async () => {
    renderRoom({ rows: [hostedRow({ realizedRepo: null })] });
    await click(screen.getByRole('button', { name: 'Move acme-booking-web to my GitHub' }));

    expect(await screen.findByRole('dialog', { name: /acme-booking-web/ })).toBeTruthy();
  });
});

describe('the island survives what the network does to it (§14.10)', () => {
  it('shows the error banner when the mutation never reaches the server', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        throw new TypeError('Failed to fetch');
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });
    await click(screen.getByRole('button', { name: /Check .* again/ }));

    expect(
      await screen.findByText("That didn't go through. Nothing was changed — try again."),
    ).toBeTruthy();
    // …and the row is left pressable rather than stuck busy.
    expect(screen.getByRole('button', { name: /Check .* again/ })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('leaves the rendered rows alone when a background re-read fails or answers nothing', async () => {
    vi.useFakeTimers();
    let setReads = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/repositories')) {
        setReads += 1;
        // First tick: a refused read. Second: a 200 with no set in it at all.
        return setReads === 1 ? new Response('', { status: 502 }) : jsonOk({});
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(setReads).toBeGreaterThanOrEqual(2);
    // The last thing the server actually said still stands — a failed or empty
    // background read must not blank the room out.
    expect(screen.getByText('Waiting for you to accept on GitHub')).toBeTruthy();
  });

  it('skips the tick while the user’s own request is in flight', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/takeover') && init?.method === 'POST') {
        return new Promise(() => {}) as unknown as Response;
      }
      return jsonOk(defaultFetch(String(url)));
    });

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'awaiting_reinstall' }) })] });
    fireEvent.click(screen.getByRole('button', { name: /Check .* again/ }));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    // A click and a tick racing for the same row is exactly what `busyRef`
    // exists to prevent.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/repositories')),
    ).toHaveLength(0);
  });

  it('skips the tick while the tab is hidden', async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden' as DocumentVisibilityState);

    renderRoom({ rows: [hostedRow({ takeover: takeover({ state: 'transfer_pending' }) })] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/repositories')),
    ).toHaveLength(0);
    visibility.mockRestore();
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function roomView(
  overrides: Partial<ProjectRepoRoomViewDto> & { rows: ProjectRepoDto[] },
): ProjectRepoRoomViewDto {
  return {
    projectId: 'proj-1',
    hostOwner: 'motir-projects',
    githubLogin: 'yue-personal',
    githubAvatarUrl: null,
    installHref: 'https://github.com/apps/motir/installations/new',
    ciPaused: false,
    otherHostedProjects: [],
    // The DEFAULT is a project answered by its set alone (born in Motir), which is
    // what every pre-MOTIR-3126 case in this file describes. A shape that owns the
    // connected section says so explicitly.
    connected: [],
    connectedInDomain: false,
    ...overrides,
  };
}

function room(view: ProjectRepoRoomViewDto, canAdd = false) {
  return (
    <RepositoriesRoom
      projectKey="ACME"
      view={view}
      connectHref="/settings/account/git"
      // Story MOTIR-4669 · MOTIR-4681 — most of this file's cases predate the org
      // section, so the room is rendered here as a NON-admin sees it by default:
      // the add door is drawn by `tests/projectRepos/addRepositoryPicker.tsx`,
      // which owns that axis. MOTIR-4954's mutation cases opt IN, because an add
      // and a remove are the two moments the post-mutation island state — the
      // thing AC 2 is about — can be observed at all.
      canAddRepositories={canAdd}
      organizationName="moooon"
      projectName="Motir"
      organizationInventoryHref="/settings/organization/git"
      nowIso={NOW}
    />
  );
}

function renderRoom(
  overrides: Partial<ProjectRepoRoomViewDto> & { rows: ProjectRepoDto[]; canAdd?: boolean },
) {
  const { canAdd = false, ...viewOverrides } = overrides;
  const view = roomView(viewOverrides);
  currentRows = view.rows;
  currentCandidates = view.connected.map(toCandidate);
  return renderWithIntl(room(view, canAdd));
}

/** A connected repository as the ESTABLISH view carries it — the shape the island
 *  maps back on refetch, so the round trip is exercised rather than assumed. */
function toCandidate(repo: ProjectRepoConnectedDto): ProjectRepoConnectCandidateDto {
  const [owner = '', name = repo.name] = repo.repoRef.split('/');
  return {
    id: `gh-${name}`,
    owner,
    name,
    repoRef: repo.repoRef,
    defaultBranch: repo.defaultBranch ?? 'main',
    claimed: false,
  };
}

function connectedRepo(name: string, owner = 'acme-inc'): ProjectRepoConnectedDto {
  return { name, repoRef: `${owner}/${name}`, defaultBranch: 'main' };
}

/** A set row that arrived through the PICKER — a LINK to an organisation
 *  repository. `seedSource` is what records that, and it is the only thing the
 *  section split consults (MOTIR-4954). */
function orgRow(name: string, realized = true): ProjectRepoDto {
  const row = hostedRow({ name });
  return {
    ...row,
    id: `row-${name}`,
    seedSource: SEED_SOURCE_ORGANIZATION,
    state: 'connected',
    takeover: null,
    // ⚠️ `realizedRepo: null` IS THE "no branch yet" FIXTURE, and the only honest
    // one: `RealizedProjectRepoDto.defaultBranch` is a `string`, so a repository
    // that EXISTS on the host always has one. A row Motir knows no branch for is a
    // row that has not been realized — which is also the only row with no owner to
    // print.
    realizedRepo:
      realized && row.realizedRepo
        ? { ...row.realizedRepo, id: `gh-${name}`, owner: 'moooon-B-V' }
        : null,
  };
}

function hostedRow(overrides: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  const name = overrides.name ?? 'acme-booking-web';
  return {
    id: 'row-web',
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name,
    seedSource: 'platform-starter',
    state: 'created',
    failureReason: null,
    proposalSignal: 'default-web',
    seedMatch: null,
    realizedRepo: {
      id: 'gh-1',
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
    hostingTarget: null,
    hostingUseCase: null,
    hostingSize: null,
    position: 'a0',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** A repository the user brought in — the already-yours no-op. */
function connectedRow(): ProjectRepoDto {
  return {
    ...hostedRow({ id: 'row-shared', role: 'shared', name: 'design-tokens' }),
    state: 'connected',
    realizedRepo: {
      id: 'gh-2',
      provider: 'github',
      owner: 'acme-inc',
      name: 'design-tokens',
      repoRef: 'acme-inc/design-tokens',
      defaultBranch: 'main',
      archived: false,
    },
  };
}

function takeover(overrides: Partial<ProjectRepoTakeoverDto> = {}): ProjectRepoTakeoverDto {
  return {
    state: 'transfer_pending',
    targetOwner: 'yue-personal',
    requestedAt: NOW,
    transferredAt: null,
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

function defaultFetch(url: string): unknown {
  if (url.includes('/api/github/organizations')) {
    return { organizations: [{ login: 'acme-inc', avatarUrl: null }] };
  }
  // The ESTABLISH view, which is what this endpoint actually returns: the set AND
  // the installation's repositories. The room used to read only the first half.
  return { set: { rows: currentRows }, connectCandidates: currentCandidates };
}

/**
 * Makes every org lookup hang until the test settles it by hand, and hands back
 * the live list of outstanding ones — so "the answer arrives after the question
 * stopped mattering" is a state to assert in rather than a race to catch.
 */
function pendingOrgLookups(): Array<{
  resolve: (value: Response) => void;
  reject: (reason: unknown) => void;
}> {
  const pending: Array<{ resolve: (value: Response) => void; reject: (reason: unknown) => void }> =
    [];
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/api/github/organizations')) {
      return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
    }
    return jsonOk(defaultFetch(String(url)));
  });
  return pending;
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A click that also drains the effect pass it triggers.
 *
 * `fireEvent` dispatches synchronously, but the handlers here start async work
 * whose `setState` lands in a later microtask + passive-effect flush. Awaiting an
 * empty `act` after the dispatch is what makes the assertion that follows read
 * settled state instead of racing it — the component-test half of the repo's
 * authoritative-signal rule.
 */
async function click(target: Element): Promise<void> {
  fireEvent.click(target);
  await act(async () => {});
}
