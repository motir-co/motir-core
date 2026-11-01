// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import type {
  ProjectRepoDto,
  ProjectRepoEstablishViewDto,
  ProjectRepoStateDto,
} from '@/lib/dto/projectRepos';

// THE ESTABLISH STEP (Story MOTIR-1775 · MOTIR-1782 · design/repository-set).
//
// The card's central claim is a NEGATIVE one, so most of what is asserted here is
// what must NOT be on screen: a one-repository plan and a three-repository plan
// render the IDENTICAL default screen, and no repository name, count, role, org,
// seed source or GitHub status code reaches it. That is the `notes.html` #151 rule
// — an AI-derived artifact a non-technical user cannot judge is derived and used,
// never put behind an editor — and it is only true if a test says so, because
// every future change to this file is a chance to leak one word of it.
//
// The technical path is asserted for the opposite property: once the user has
// self-identified by connecting their own GitHub, the vocabulary IS theirs, per-row
// state is independent, and no state is a dead end.

const ROW_DEFAULTS = {
  projectId: 'proj-1',
  label: null,
  seedSource: 'nextjs-prisma-vercel-starter',
  failureReason: null,
  proposalSignal: null,
  seedMatch: null,
  realizedRepo: null,
  established: false,
  // The TAKE-IT-OVER saga (MOTIR-711) — null is the common case: no handoff has
  // ever been requested for this row.
  takeover: null,
  // The collaborator invitation (MOTIR-1900) — a sub-state OF a created row, so
  // the default is the honest "nobody has been invited to this yet".
  access: { state: 'not_invited', login: null, invitationUrl: null },
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
} as const;

function row(
  over: Partial<ProjectRepoDto> & { id: string; role: ProjectRepoDto['role']; name: string },
): ProjectRepoDto {
  return {
    ...ROW_DEFAULTS,
    state: 'proposed' as ProjectRepoStateDto,
    hostingTarget: null,
    hostingUseCase: null,
    hostingSize: null,
    position: 'a0',
    ...over,
  };
}

function view(
  rows: ProjectRepoDto[],
  over: Partial<ProjectRepoEstablishViewDto> = {},
): ProjectRepoEstablishViewDto {
  return {
    set: { projectId: 'proj-1', rows, ownership: null, targetAccount: null },
    hostOwner: 'motir-projects',
    githubLogin: null,
    githubAvatarUrl: null,
    hasInstallation: false,
    connectCandidates: [],
    ...over,
  };
}

/** The step polls + writes through `fetch`; every test drives it explicitly so
 *  nothing depends on a real network or on timing. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderStep(initial: ProjectRepoEstablishViewDto) {
  return renderWithIntl(
    <RepositorySetStep
      projectKey="MOTIR"
      initialView={initial}
      backlogHref="/items"
      connectHref="/settings/workspace/github"
    />,
  );
}

beforeEach(() => {
  stubFetch(() => view([]));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The DEFAULT path ────────────────────────────────────────────────────────

/** Serve the set read AND the acceptance refresh, which now fires on any SETTLED
 *  set rather than only inside the access step (MOTIR-5015). A stub that answers
 *  `/access` with the view puts a non-array into `rows`. */
function stubSetAndAccess(next: () => ProjectRepoEstablishViewDto) {
  return stubFetch((url) => (String(url).endsWith('/access') ? next().set.rows : next()));
}

describe('the default path', () => {
  it('is one sentence and ONE action — no branch, and nothing technical', () => {
    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    expect(screen.getByRole('heading', { name: 'Motir will host your code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    // ⚠️ THE DOOR IS GONE, and its ABSENCE is the assertion (MOTIR-5014). The
    // quiet secondary led to the technical path, which left for onboarding — a
    // user who already has code answered that question there, before any plan
    // existed. Asserting the absence is what stops it being re-added by
    // somebody reading the panel as unfinished.
    expect(screen.queryByRole('button', { name: 'I already have code' })).toBeNull();

    // The ownership promise is on the MAIN LINE, not in a footnote — it is the
    // line MOTIR-1785's acceptance video must be able to show.
    expect(container.textContent).toContain("It's yours.");

    // …and none of the model reaches the screen.
    const text = container.textContent ?? '';
    for (const leak of ['acme-booking-web', 'motir-projects', 'web', 'repositor', 'starter']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('renders the IDENTICAL screen for a one-repo plan and a three-repo plan', () => {
    // The card's central claim, answered by REMOVING the question rather than by
    // styling it two ways: cardinality is not the user's business, so nothing
    // about it can reach the DOM.
    const one = renderStep(view([row({ id: 'r1', role: 'web', name: 'solo' })]));
    const oneHtml = one.container.innerHTML;
    cleanup();

    const three = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'acme-web', position: 'a0' }),
        row({ id: 'r2', role: 'api', name: 'acme-api', position: 'a1' }),
        row({ id: 'r3', role: 'shared', name: 'acme-shared', position: 'a2' }),
      ]),
    );

    expect(three.container.innerHTML).toBe(oneHtml);
  });

  it('goes working → ready on Continue, and never names a repository on the way', async () => {
    let phase: ProjectRepoStateDto = 'proposed';
    stubFetch((url) => {
      if (url.endsWith('/establish')) {
        phase = 'created';
        return { projectId: 'proj-1', rows: [] };
      }
      const v = view([row({ id: 'r1', role: 'web', name: 'acme-booking-web', state: phase })]);
      return url.endsWith('/access') ? v.set.rows : v;
    });

    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('repo-setup-status').textContent).toContain('Your code is ready');
    });
    expect(screen.getByRole('link', { name: 'Go to my backlog' })).toBeTruthy();
    expect(container.textContent).not.toContain('acme-booking-web');
  });

  it('shows ONE status line while creating, however many repositories are behind it', () => {
    const { container } = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'a', state: 'creating' }),
        row({ id: 'r2', role: 'api', name: 'b', state: 'creating' }),
      ]),
    );

    const statuses = container.querySelectorAll('[data-testid="repo-setup-status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toContain('Setting up your code…');
    expect(statuses[0]!.getAttribute('role')).toBe('status');
  });

  it('reports a failure in plain language — no repository name, no GitHub status code', () => {
    const { container } = renderStep(
      view([
        row({
          id: 'r1',
          role: 'web',
          name: 'acme-booking-web',
          state: 'failed',
          // A REAL reason, of the shape the primitive persists. The default path
          // must render none of it.
          failureReason: 'GitHub declined the request (422) for "acme-booking-web".',
        }),
      ]),
    );

    expect(screen.getByTestId('repo-setup-status').textContent).toContain(
      "Motir couldn't finish setting up your code",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('Your plan is safe in your backlog.');
    expect(text).not.toContain('acme-booking-web');
    expect(text).not.toContain('422');
    expect(text).not.toContain('GitHub declined');
    // The failure is ANNOUNCED, not just coloured.
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('has no axe violations in any of its states', async () => {
    for (const state of ['proposed', 'creating', 'created', 'failed'] as ProjectRepoStateDto[]) {
      const { container } = renderStep(
        view([
          row({
            id: 'r1',
            role: 'web',
            name: 'acme-web',
            state,
            failureReason: state === 'failed' ? 'nope' : null,
          }),
        ]),
      );
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
      cleanup();
    }
  });
});

describe('the step’s remaining edges', () => {
  it('POLLS while a run is in flight, and stops the moment nothing is', async () => {
    vi.useFakeTimers();
    try {
      let state: ProjectRepoStateDto = 'creating';
      const spy = stubSetAndAccess(() => view([row({ id: 'r1', role: 'web', name: 'a', state })]));
      renderStep(view([row({ id: 'r1', role: 'web', name: 'a', state: 'creating' })]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3200);
      });
      const whileRunning = spy.mock.calls.length;
      expect(whileRunning).toBeGreaterThanOrEqual(2);

      // The set settles; the poll must stop rather than hammer the read forever.
      state = 'created';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      const afterSettle = spy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(spy.mock.calls.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  /* ⚠️ THREE CASES WERE REMOVED HERE, NOT SKIPPED (MOTIR-5014 · Story MOTIR-5010):
     the anonymous greeting on the set lead, "Not now" leaving the technical path,
     and the failed-`addRow` alert. All three entered through **I already have
     code**, which is gone — the technical path left for onboarding, so there is no
     surface left for them to drive. The establish-failure half of the third is
     still covered by the `failed` panel case in `the default path` above, which is
     where a user now meets it. */

  it('renders the idle default for a project whose set is empty', () => {
    // Not reachable from the plan page (which mounts the step only for a project
    // that HAS a set), but the derivation must not read an empty set as "ready".
    renderStep(view([]));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByTestId('repo-setup-status')).toBeNull();
  });
});

// ── THE ACCESS STEP (MOTIR-1900 · design/repository-set §5, panels 3 + 4) ────
//
// Repositories Motir creates live in Motir's org and are PRIVATE, so "your code
// is ready" is only half true until the user can reach it. What is asserted here
// is that the surface tells that truth: the main line continues into the access
// step, the account is SHOWN rather than typed, `Later` is a real answer, and
// each of the three invitation states carries an icon AND a word plus its one way
// forward.

const ACCESS = {
  notInvited: { state: 'not_invited', login: null, invitationUrl: null },
  invited: {
    state: 'invited',
    login: 'yuezhu',
    invitationUrl: 'https://github.com/motir-projects/acme-web/invitations',
  },
  accepted: { state: 'accepted', login: 'yuezhu', invitationUrl: null },
} as const;

/** A settled, Motir-created row — the only shape that raises an access question. */
function createdRow(access: ProjectRepoDto['access']): ProjectRepoDto {
  return row({
    id: 'r1',
    role: 'web',
    name: 'acme-web',
    state: 'created',
    established: true,
    access,
    realizedRepo: {
      id: 'gr-1',
      provider: 'github',
      owner: 'motir-projects',
      name: 'acme-web',
      repoRef: 'motir-projects/acme-web',
      defaultBranch: 'main',
      archived: false,
    },
  });
}

/**
 * Serve BOTH shapes the access step reads: the set (`GET ../repositories`, an
 * establish view) and the acceptance refresh (`GET ../repositories/access`, a
 * bare row array). Getting the second wrong is not a detail — the step folds its
 * result straight into `view.set.rows`.
 */
function stubAccessFetch(v: ProjectRepoEstablishViewDto) {
  return stubFetch((url) => (String(url).endsWith('/access') ? v.set.rows : v));
}

// ── THE ACCESS REPORT (design/repository-set v5 panel 2 `created` — MOTIR-5015) ─
//
// The invitation is SENT at establish and has been since MOTIR-1900
// (`projectRepoSetService.attachRealizedRepo` → `inviteAfterEstablish`), so what
// this panel owes is a REPORT. Until MOTIR-5015 it offered **Connect GitHub**
// instead — a navigation button wearing the connect button's name, shown to
// people whose account was in the very view that rendered it. What is asserted
// here is the report: both arms, the account SHOWN rather than typed, the rail's
// own words on arm B, and the absence of the ask.

describe('a READY set REPORTS the invitation rather than asking for one', () => {
  it('arm A — names the account it went to, and offers the journey, not a question', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    expect(await screen.findByText('Your code is ready')).toBeTruthy();
    // WHICH account — shown, never typed. A typed handle proves nothing and a
    // typo would invite a stranger to a private repository.
    expect(screen.getByText('@yuezhu')).toBeTruthy();
    expect(screen.getByText('This is the account Motir invited')).toBeTruthy();
    // The one action is the JOURNEY's.
    expect(screen.getByRole('link', { name: 'Go to my backlog' })).toBeTruthy();
    // ⚠️ AND THE ASK IS GONE — the assertion is its ABSENCE, in every form it
    // took, so a relabel cannot satisfy it.
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Connect GitHub' })).toBeNull();
  });

  it('arm A — a single pending invitation gets its door; the account stays correctable', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    const open = await screen.findByRole('link', { name: /Open the invitation/ });
    expect(open.getAttribute('href')).toContain('/invitations');
    // A report is not a silent surface: showing which account holds admin and
    // offering no way to correct it would make the guarantee worse, not better.
    expect(screen.getByRole('link', { name: 'Use a different account' })).toBeTruthy();
  });

  it('arm A — an ACCEPTED row offers no door, because there is nothing left to open', async () => {
    const v = view([createdRow(ACCESS.accepted)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    expect(await screen.findByText('@yuezhu')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open the invitation/ })).toBeNull();
  });

  it('arm B — no identity: says so in the RAIL’s words, with the door to code access', async () => {
    const v = view([createdRow(ACCESS.notInvited)]);
    stubAccessFetch(v);
    renderStep(v);

    expect(await screen.findByText('Your code is ready')).toBeTruthy();
    const report = screen.getByTestId('repo-access-report');
    expect(report.textContent).toContain("Motir doesn't know your GitHub account yet");
    // ⚠️ AND IT MUST NOT SAY ARM C's SENTENCE. There is no account here, so
    // nothing was attempted and nothing was refused.
    expect(report.textContent).not.toContain('GitHub turned the invitation down');
    // ⚠️ WORD FOR WORD WITH THE RAIL, and by construction rather than by
    // coincidence: the door reuses `repositorySet.outcomeNeedsAccess`, which is
    // what `PlanReviewRail` renders for the `needs_access` outcome
    // `PlanDetail.codeOutcomeOf` computes for exactly this state.
    const door = screen.getByRole('link', { name: 'Finish setting up access' });
    expect(door.getAttribute('href')).toBe('/settings/project/code-access');
    // It is a STATUS, not an alert — nothing failed; nobody has been invited yet.
    expect(report.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── ARM C (design v7 · MOTIR-5038 · bug MOTIR-5036) ─────────────────────────
  //
  // ⚠️ THE THREE ARMS ARE TOLD APART BY THE DTO AND BY NOTHING ELSE. Every case
  // below differs only in `view.githubLogin` and in the rows' `state` /
  // `access.state` — never in a prop, a flag or a fixture switch — because that
  // is the claim the fix makes. The shipped guard was `!login || !anyInvited`,
  // a DISJUNCTION whose copy stated only its first disjunct: a GitHub refusal
  // leaves every row `not_invited` (MOTIR-1900's graceful degradation, working
  // as designed), so the second disjunct fired with `login` a real string and
  // the panel told the reader something untrue ABOUT THEMSELVES.

  it('arm C — the account IS known and nothing was sent: names it, and blames GitHub', async () => {
    const v = view([createdRow(ACCESS.notInvited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    expect(await screen.findByText('Your code is ready')).toBeTruthy();
    const report = screen.getByTestId('repo-access-report');
    // ⚠️ THE WHOLE DEFECT, IN ONE ASSERTION: it must NOT claim Motir lacks the
    // account it just tried to use.
    expect(report.textContent).not.toContain("Motir doesn't know your GitHub account yet");
    expect(report.textContent).toContain('GitHub turned the invitation down');
    // The one identifier arm C carries is the ACCOUNT — the thing the reader can
    // act on. Never a repository name and never a GitHub status code.
    expect(report.textContent).toContain('@yuezhu');
    expect(report.textContent).not.toContain('403');
    expect(report.textContent).not.toContain('acme-web');
  });

  it('arm C — DRAWN INSIDE the severity ruling: a status, the same door, no failure', async () => {
    // An invitation failure never fails a row. The repositories are real, the
    // plan is safe, and the main line still says "Your code is ready" — so arm C
    // changes ONE SENTENCE and nothing else. A second hue here would be a
    // severity claim four inches under a success line.
    const v = view([createdRow(ACCESS.notInvited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    const report = await screen.findByTestId('repo-access-report');
    expect(report.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
    // Arm B's door, by construction rather than by coincidence — both reuse
    // `repositorySet.outcomeNeedsAccess`, the key `PlanReviewRail` renders for
    // the `needs_access` outcome that covers BOTH arms.
    const door = screen.getByRole('link', { name: 'Finish setting up access' });
    expect(door.getAttribute('href')).toBe('/settings/project/code-access');
    // No new destination, and no failure panel.
    expect(screen.queryByText("Motir couldn't finish setting up your code")).toBeNull();
    expect(screen.getByText('Your code is ready')).toBeTruthy();
  });

  it('arm C is never drawn for a set with nothing to invite — the MIXED set stays arm A', async () => {
    // ⚠️ THE CASE THAT RULES OUT `rows.every(...)`. `[].every(…)` is VACUOUSLY
    // TRUE, so quantifying arm C over every row instead of every INVITABLE one
    // would turn its condition on rows nothing will ever invite to: a
    // `connected` row is the ORGANISATION's and is `not_invited` for ever by
    // construction (design v7 amendment 2). Here the organisation's row is
    // permanently un-invited while the Motir row's invitation went out — the set
    // has been reached, and claiming GitHub refused it would be false.
    const orgRow = row({
      id: 'r-org',
      role: 'shared',
      name: 'atlas-shared',
      state: 'connected',
      seedSource: 'organization',
      established: true,
    });
    const v = view([orgRow, createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubAccessFetch(v);
    renderStep(v);

    expect(await screen.findByText('@yuezhu')).toBeTruthy();
    const report = screen.getByTestId('repo-access-report');
    expect(report.textContent).not.toContain('GitHub turned the invitation down');
    expect(report.textContent).not.toContain("Motir doesn't know your GitHub account yet");
  });

  it('never renders the report before the set is ready', () => {
    renderStep(view([row({ id: 'r1', role: 'web', name: 'a' })]));
    expect(screen.queryByTestId('repo-access-report')).toBeNull();
  });

  it('REFRESHES the pending invitations once the set is settled, and folds them in', async () => {
    // GitHub tells Motir nothing when an invitation is accepted, so the read is
    // the only way to learn it. Its trigger moved with the access step: it fires
    // when the set SETTLES, which is when the panel starts naming an account.
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    const accepted = [createdRow(ACCESS.accepted)];
    const spy = stubFetch((url) => (String(url).endsWith('/access') ? accepted : v));
    renderStep(v);

    await waitFor(() =>
      expect(spy.mock.calls.some(([u]) => String(u).endsWith('/repositories/access'))).toBe(true),
    );
    // The folded-in result is what the panel then says.
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: /Open the invitation/ })).toBeNull(),
    );
  });

  it('survives a refresh that fails — the row keeps saying what it last knew', async () => {
    const v = view([createdRow(ACCESS.invited)], {
      githubLogin: 'yuezhu',
      githubAvatarUrl: null,
    });
    stubFetch((url) => {
      if (String(url).endsWith('/repositories/access')) throw new Error('boom');
      return v;
    });
    renderStep(v);

    expect(await screen.findByText('@yuezhu')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has no axe violations on either arm', async () => {
    for (const v of [
      view([createdRow(ACCESS.invited)], { githubLogin: 'yuezhu', githubAvatarUrl: null }),
      view([createdRow(ACCESS.notInvited)]),
    ]) {
      stubAccessFetch(v);
      const { container } = renderStep(v);
      await screen.findByText('Your code is ready');
      const results = await axe.run(container, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
      });
      expect(results.violations).toEqual([]);
      cleanup();
    }
  });
});

/* ⚠️ THE `access step SENDS the invitations` BLOCK WAS REMOVED, NOT SKIPPED
   (MOTIR-5015). Its six cases drove `grantRepositoryAccess` from the access
   step's **Connect GitHub** — a POST no client makes any more, because the
   invitation is sent server-side at establish and has been since MOTIR-1900.
   The behaviours themselves are pinned where they actually live, over real
   Postgres: `tests/projectRepos/projectRepoAccessService.test.ts` asserts the
   invite per created row, the no-identity arm, the refusal that does not damage
   the repository, and the accepted-record skip. */

// ── THE MIXED SET (bug MOTIR-5049 · design §7b, v6) — what the step may CLAIM ──
//
// A project can hold a repository the ORGANISATION already owns beside one Motir
// is creating: `organizationRepoService` appends a `connected` / `organization`
// row to whatever set the project has. The step is still drawn — there IS a row
// to establish — but two of its elements are SET-WIDE sentences, and over a
// mixed set they speak for a repository that is not Motir's to speak for.
//
// ⚠️ THE TWO PREDICATES ARE DIFFERENT AND BOTH ARE PINNED HERE. `state` decides
// whether the step APPEARS (that half is `plan-detail-settled-set.test.tsx`);
// `seedSource` decides what it may CLAIM. A build that read one for the other
// would pass one of these files and fail the other.
describe('the MIXED set scopes the two set-wide sentences (MOTIR-5049)', () => {
  const orgRow = () =>
    row({
      id: 'r-org',
      role: 'shared',
      name: 'atlas-shared',
      state: 'connected',
      seedSource: 'organization',
    });
  const motirRow = () => row({ id: 'r-web', role: 'web', name: 'atlas-web' });

  it('scopes the TITLE and the PROMISE when the set also holds an organisation row', () => {
    renderStep(view([orgRow(), motirRow()]));

    expect(screen.getByText('Motir will host the new code')).toBeTruthy();
    expect(screen.queryByText('Motir will host your code')).toBeNull();
    // The promise is SHOWN, not suppressed — it is a standing guarantee about
    // the rows Motir DOES host, and dropping it would take that guarantee off
    // the half of the set it is true of.
    expect(screen.getByText(/Motir keeps the code it hosts safe and private/)).toBeTruthy();
    expect(screen.queryByText(/Motir keeps it safe and private/)).toBeNull();
  });

  it("keeps the UNSCOPED wording byte for byte when no row is the organisation's", () => {
    // The common case, and the test a scope edit has to pass: a reader with an
    // all-Motir set cannot tell that the mixed arm exists.
    renderStep(view([motirRow()]));

    expect(screen.getByText('Motir will host your code')).toBeTruthy();
    expect(screen.queryByText('Motir will host the new code')).toBeNull();
    expect(screen.getByText(/Motir keeps it safe and private/)).toBeTruthy();
  });

  it('still names NO repository, role, account or count on a mixed set', () => {
    // §7b: "Both edits are SCOPE, not information." The #151 rule is unchanged —
    // the scoped strings are narrower SUBJECTS, never a disclosure about the set.
    const { container } = renderStep(view([orgRow(), motirRow()]));
    const text = container.textContent ?? '';

    for (const leak of ['atlas-shared', 'atlas-web', 'organization', 'shared', '2', 'two']) {
      expect(text.includes(leak)).toBe(false);
    }
  });
});
