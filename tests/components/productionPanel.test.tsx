// @vitest-environment happy-dom
// MOTIR-10037 — the Production panel (design MOTIR-10024), rendered with the real
// `en` catalogue and the routes stubbed at `fetch`: every state the design draws,
// the administrator / member split, Show more, and the rollback with its busy,
// error and success states. The page-level gate (not found, 404) is
// `tests/settings/productionPage.test.tsx`'s.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { HostedReleaseDto } from '@/lib/dto/hostedApplications';
import type { ProductionPanelDto } from '@/lib/dto/productionPanel';
import { ProductionPanel } from '@/components/hosting/ProductionPanel';
import { ProductionError } from '@/components/hosting/ProductionError';
import { ProductionSkeleton } from '@/components/hosting/ProductionSkeleton';
import { ProductionRepositoryPicker } from '@/components/hosting/ProductionRepositoryPicker';
import { COPIED_MS } from '@/components/hosting/CurrentReleaseCard';
import { productionRefusalKey } from '@/lib/hosting/productionPanelClient';

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, prefetch: vi.fn() }),
  usePathname: () => '/settings/project/production',
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = new Date('2026-10-29T18:00:00Z');
const BASE = '/api/projects/ACME/repositories/row-1/production';

let n = 0;
function release(overrides: Partial<HostedReleaseDto> = {}): HostedReleaseDto {
  n += 1;
  const sha = `${String(n).padStart(2, '0')}c41e2a${'0'.repeat(32)}`;
  return {
    id: `rel-${n}`,
    applicationId: 'app-1',
    commitSha: sha,
    ref: null,
    commitSubject: null,
    pullRequestNumber: null,
    requestedBy: null,
    cause: 'merge',
    state: 'replaced',
    artifactRef: null,
    providerReleaseId: null,
    failureReason: null,
    usageSeconds: null,
    restoredBy: null,
    restoredAt: null,
    createdAt: new Date(NOW.getTime() - n * 3_600_000).toISOString(),
    liveAt: null,
    endedAt: null,
    ...overrides,
  };
}

function panel(overrides: Partial<ProductionPanelDto> = {}): ProductionPanelDto {
  const live = release({ state: 'live' });
  const previous = release({ state: 'replaced' });
  return {
    application: { id: 'app-1', target: 'fly', productionAddress: 'shop--acme.motir.site' },
    currentRelease: live,
    previousRelease: previous,
    releases: [live, previous],
    nextCursor: null,
    isAdministrator: true,
    canRollback: true,
    ...overrides,
  };
}

function short(r: HostedReleaseDto): string {
  return r.commitSha.slice(0, 7);
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A fetch answer the test resolves when it chooses. */
function deferred() {
  let resolve!: (res: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

function render(initial: ProductionPanelDto) {
  return renderWithIntl(
    <ProductionPanel
      projectKey="ACME"
      repositoryId="row-1"
      repositoryName="shop"
      initial={initial}
    />,
    { now: NOW },
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  n = 0;
  push.mockReset();
  refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the current release card', () => {
  it('shows the live release: commit, relative time with the absolute on hover, pill, trigger and address', () => {
    const initial = panel();
    render(initial);
    const card = screen.getByTestId('production-current-release');
    expect(within(card).getByText('Serving production')).toBeTruthy();
    expect(within(card).getByText(short(initial.currentRelease!))).toBeTruthy();
    const pill = within(card).getByTestId('production-state-pill');
    expect(pill.getAttribute('data-release-state')).toBe('live');
    expect(pill.textContent).toBe('Live');
    const time = card.querySelector('time')!;
    expect(time.getAttribute('dateTime')).toBe(initial.currentRelease!.createdAt);
    expect(time.getAttribute('title')).toBeTruthy();
    expect(time.textContent).toBe('1 hour ago');
    expect(within(card).getByTestId('production-trigger').textContent).toBe(
      'Merge into the default branch',
    );
    const link = within(card).getByTestId('production-address');
    expect(link.getAttribute('href')).toBe('https://shop--acme.motir.site');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('(opens in a new tab)');
    expect(screen.queryByTestId('production-no-address-note')).toBeNull();
  });

  it('shows the commit subject and the pull request a merge came from (MOTIR-10103)', async () => {
    const live = release({
      state: 'live',
      commitSubject: 'Show the delivery estimate on the basket',
      pullRequestNumber: 48,
    });
    const previous = release({
      state: 'replaced',
      commitSubject: 'Add a column for the gift note',
      pullRequestNumber: 47,
    });
    const ref = release({
      state: 'replaced',
      cause: 'ref',
      ref: 'v1.4.0',
      requestedBy: { id: 'u2', name: 'Sam Lee' },
    });
    render(
      panel({ currentRelease: live, previousRelease: previous, releases: [live, previous, ref] }),
    );
    const card = screen.getByTestId('production-current-release');
    const subject = within(card).getByTestId('production-commit-subject');
    expect(subject.textContent).toBe('Show the delivery estimate on the basket');
    expect(subject.getAttribute('title')).toBe('Show the delivery estimate on the basket');
    expect(within(card).getByTestId('production-trigger').textContent).toBe('Merge of #48');

    const rows = screen.getAllByTestId('production-release-row');
    expect(within(rows[1]!).getByTestId('production-commit-subject').textContent).toBe(
      'Add a column for the gift note',
    );
    expect(within(rows[1]!).getByTestId('production-trigger').textContent).toBe('Merge of #47');
    // A release that does not know its subject shows the commit alone.
    expect(within(rows[2]!).queryByTestId('production-commit-subject')).toBeNull();
    expect(within(rows[2]!).getByTestId('production-trigger').textContent).toBe(
      'Deploy of v1.4.0 · Sam Lee',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await flush();
    const terms = within(screen.getByRole('alertdialog')).getAllByRole('definition');
    expect(terms[0]!.textContent).toContain('Show the delivery estimate on the basket');
    expect(terms[1]!.textContent).toContain('Add a column for the gift note');
  });

  it('copies the address and reads Copied for two seconds, announced politely', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(panel());
    const copy = screen.getByRole('button', { name: 'Copy shop--acme.motir.site' });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(writeText).toHaveBeenCalledWith('shop--acme.motir.site');
    expect(copy.textContent).toBe('Copied');
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe('Copied');
    // A second copy restarts the two seconds.
    await act(async () => {
      fireEvent.click(copy);
    });
    await act(async () => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(copy.textContent).toBe('Copy');
  });

  it('stays on Copy when the browser refuses the clipboard', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
    });
    render(panel());
    const copy = screen.getByRole('button', { name: 'Copy shop--acme.motir.site' });
    await act(async () => {
      fireEvent.click(copy);
    });
    expect(copy.textContent).toBe('Copy');
  });

  it('shows the no-address note linking to Public address when no label is claimed', () => {
    render(panel({ application: { id: 'app-1', target: 'fly', productionAddress: null } }));
    const note = screen.getByTestId('production-no-address-note');
    expect(note.textContent).toBe(
      'No address yet — claim a motir.site address for the workspace in Public address.',
    );
    expect(within(note).getByRole('link', { name: 'Public address' }).getAttribute('href')).toBe(
      '/settings/project/public-address',
    );
    expect(screen.queryByTestId('production-address')).toBeNull();
  });
});

describe('the Roll back control', () => {
  it('an administrator with a previous release sees it enabled, with its helper', () => {
    render(panel());
    const button = screen.getByRole('button', { name: 'Roll back' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('production-rollback-helper').textContent).toBe(
      'Returns production to the release before this one.',
    );
    expect(screen.queryByTestId('production-read-only-note')).toBeNull();
  });

  it('an administrator with one release sees it disabled with its reason inline', () => {
    const only = release({ state: 'live' });
    render(
      panel({ currentRelease: only, previousRelease: null, releases: [only], canRollback: false }),
    );
    expect(screen.getByRole('button', { name: 'Roll back' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('production-rollback-helper').textContent).toBe(
      'There is no earlier release to return to yet.',
    );
  });

  it('a member sees the whole panel, no control in the DOM, and the note saying who can', () => {
    render(panel({ isAdministrator: false, canRollback: false }));
    expect(screen.getByTestId('production-current-release')).toBeTruthy();
    expect(screen.getAllByTestId('production-release-row')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
    expect(screen.queryByTestId('production-rollback-helper')).toBeNull();
    expect(screen.getByRole('note').textContent).toBe(
      'You can see every release. Only project administrators can roll back.',
    );
  });
});

describe('the release history', () => {
  it('draws each state with its own pill, the address on the live row only, and a failed row’s reason', () => {
    const building = release({ state: 'building', cause: 'config_change' });
    const failed = release({ state: 'failed', failureReason: 'migrate: exit 1' });
    const live = release({
      state: 'live',
      restoredBy: { id: 'u1', name: 'Dana Ito' },
      restoredAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    const rolledBack = release({ state: 'rolled_back' });
    const replaced = release({ state: 'replaced', cause: 'ref', ref: 'v1.4.0' });
    render(
      panel({
        currentRelease: live,
        previousRelease: rolledBack,
        releases: [building, failed, live, rolledBack, replaced],
      }),
    );
    const rows = screen.getAllByTestId('production-release-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual([
      'building',
      'failed',
      'live',
      'rolledBack',
      'replaced',
    ]);
    expect(rows.map((r) => within(r).getByTestId('production-state-pill').textContent)).toEqual([
      'Building',
      'Failed',
      'Live',
      'Rolled back',
      'Replaced',
    ]);
    expect(within(rows[0]!).getByTestId('production-trigger').textContent).toBe(
      'Redeploy · production settings changed',
    );
    expect(within(rows[1]!).getByTestId('production-failure-reason').textContent).toBe(
      'The migration failed with exit code 1.',
    );
    expect(within(rows[2]!).getByTestId('production-trigger').textContent).toBe(
      'Restored by rollback · Dana Ito',
    );
    // Restored a minute ago: the restore is the time the row shows.
    expect(rows[2]!.querySelector('time')!.textContent).toBe('1 minute ago');
    expect(within(rows[4]!).getByTestId('production-trigger').textContent).toBe('Deploy of v1.4.0');
    const withAddress = rows.filter((r) => r.textContent!.includes('shop--acme.motir.site'));
    expect(withAddress).toEqual([rows[2]]);
    expect(screen.queryByTestId('production-failure-reason', {})).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more releases' })).toBeNull();
  });

  it('notes a failed newer release above the card, the older release still live', () => {
    const failed = release({ state: 'failed', failureReason: 'build failure' });
    const live = release({ state: 'live' });
    render(panel({ currentRelease: live, releases: [failed, live] }));
    expect(screen.getByRole('status').textContent).toBe(
      `The newest release failed, so nothing that is serving changed. ${short(live)} is still live.`,
    );
    expect(
      within(screen.getByTestId('production-current-release')).getByTestId('production-state-pill')
        .textContent,
    ).toBe('Live');
  });

  it('pages through Show more without repeating a row, and hides it on the last page', async () => {
    const initial = panel({ nextCursor: 'c1' });
    const [first, second] = initial.releases;
    const third = release();
    const page = deferred();
    const fetchMock = vi.fn(() => page.promise);
    vi.stubGlobal('fetch', fetchMock);
    render(initial);

    fireEvent.click(screen.getByRole('button', { name: 'Show more releases' }));
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}?cursor=c1`, expect.anything());
    await act(async () => {
      // `second` again — a release that arrived meanwhile shifted it across.
      page.resolve(respond(200, { ...initial, releases: [second, third], nextCursor: null }));
    });
    await flush();

    const rows = screen.getAllByTestId('production-release-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector('code')!.textContent)).toEqual([
      short(first!),
      short(second!),
      short(third),
    ]);
    expect(screen.queryByRole('button', { name: 'Show more releases' })).toBeNull();
  });

  it('says so when the next page cannot be read, and keeps Show more', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(500, {})),
    );
    render(panel({ nextCursor: 'c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more releases' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe('Couldn’t load more releases. Try again.');
    expect(screen.getAllByTestId('production-release-row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show more releases' })).toBeTruthy();
  });
});

describe('the empty state', () => {
  it('a Motir repository that never released shows only the empty state', () => {
    render(
      panel({
        application: null,
        currentRelease: null,
        previousRelease: null,
        releases: [],
        canRollback: false,
      }),
    );
    expect(screen.getByTestId('production-empty-state').textContent).toContain(
      'Nothing in production yet',
    );
    expect(screen.queryByTestId('production-release-history')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Roll back' })).toBeNull();
  });

  it('a first release still building shows the empty state and its Building row, nothing as live', () => {
    const building = release({ state: 'building' });
    render(
      panel({
        currentRelease: null,
        previousRelease: null,
        releases: [building],
        canRollback: false,
        isAdministrator: false,
      }),
    );
    expect(screen.getByTestId('production-empty-state')).toBeTruthy();
    expect(screen.getByTestId('production-release-row').getAttribute('data-state')).toBe(
      'building',
    );
    expect(screen.queryByTestId('production-current-release')).toBeNull();
  });
});

describe('rolling back', () => {
  async function openDialog() {
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    await flush();
    return screen.getByRole('alertdialog');
  }

  it('names the release left and the one returned to, and says the schema is not reverted', async () => {
    const initial = panel();
    render(initial);
    const dialog = await openDialog();
    expect(within(dialog).getByText('Roll back shop?')).toBeTruthy();
    const terms = within(dialog).getAllByRole('definition');
    expect(terms[0]!.textContent).toContain(short(initial.currentRelease!));
    expect(terms[1]!.textContent).toContain(short(initial.previousRelease!));
    expect(dialog.textContent).toContain(
      'Production goes back to that release’s code and environment values at shop--acme.motir.site. The database schema is not reverted',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape closes it while nothing is in flight', async () => {
    render(panel());
    const dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says the schema rule without an address when there is none', async () => {
    render(panel({ application: { id: 'app-1', target: 'fly', productionAddress: null } }));
    const dialog = await openDialog();
    expect(dialog.textContent).toContain(
      'Production goes back to that release’s code and environment values. The database schema is not reverted',
    );
  });

  it('is busy and not dismissible while in flight, then shows the restored release from the response', async () => {
    const initial = panel();
    const left = initial.currentRelease!;
    const restored = initial.previousRelease!;
    const answer = deferred();
    const fetchMock = vi.fn(() => answer.promise);
    vi.stubGlobal('fetch', fetchMock);
    render(initial);
    const dialog = await openDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/rollback`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(screen.getByTestId('production-rollback-dialog').getAttribute('aria-busy')).toBe('true');
    const confirm = screen.getByTestId('production-rollback-confirm');
    expect(confirm.textContent).toContain('Rolling back…');
    expect(confirm.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('production-rollback-cancel').hasAttribute('disabled')).toBe(true);
    // No optimistic Live pill: the card still shows the release being left.
    expect(
      within(screen.getByTestId('production-current-release')).getByText(short(left)),
    ).toBeTruthy();
    // Escape does not dismiss it while the rollback is in flight.
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await flush();
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    const restoredLive: HostedReleaseDto = {
      ...restored,
      state: 'live',
      restoredBy: { id: 'u1', name: 'Dana Ito' },
      restoredAt: NOW.toISOString(),
    };
    const leftRolledBack: HostedReleaseDto = { ...left, state: 'rolled_back' };
    await act(async () => {
      answer.resolve(
        respond(200, {
          ...initial,
          currentRelease: restoredLive,
          previousRelease: leftRolledBack,
          releases: [leftRolledBack, restoredLive],
        }),
      );
    });
    await flush();

    expect(screen.queryByRole('alertdialog')).toBeNull();
    const card = screen.getByTestId('production-current-release');
    expect(within(card).getByText(short(restored))).toBeTruthy();
    expect(within(card).getByTestId('production-trigger').textContent).toBe(
      'Restored by rollback · Dana Ito',
    );
    const rows = screen.getAllByTestId('production-release-row');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['rolledBack', 'live']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, 'no_previous_release', 'There is no earlier release to return to.'],
    [409, 'release_in_progress', 'A release is in progress. Roll back once it has finished.'],
    [
      409,
      'rollback_conflict',
      'Production changed while rolling back. Close this and check what is live now.',
    ],
    [403, 'rollback_not_permitted', 'Only project administrators can roll back.'],
    [404, 'repository_not_found', 'This repository is no longer available to you.'],
  ])('a %i %s refusal shows its own message', async (status, code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(status, { error: { code, message: 'provider said postgres://u:p@h/db' } }),
      ),
    );
    const initial = panel();
    render(initial);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await flush();
    const error = screen.getByTestId('production-rollback-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toBe(message);
    expect(document.body.textContent).not.toContain('postgres://');
    expect(document.body.textContent).not.toContain('provider said');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a 502 shows the design’s error, the newer release still serving, with Try again that retries', async () => {
    const initial = panel();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond(502, { error: { code: 'rollback_failed', message: 'fly: 500 internal' } }),
      )
      .mockRejectedValueOnce(new TypeError('network'));
    vi.stubGlobal('fetch', fetchMock);
    render(initial);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await flush();
    expect(screen.getByTestId('production-rollback-error').textContent).toBe(
      `The rollback didn’t complete. ${short(initial.currentRelease!)} is still serving production. Try again.`,
    );
    expect(document.body.textContent).not.toContain('fly: 500');
    expect(
      within(screen.getByTestId('production-current-release')).getByTestId('production-state-pill')
        .textContent,
    ).toBe('Live');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('production-rollback-error').textContent).toContain(
      'is still serving production',
    );
  });

  it('drops a Show more answer that lands after the rollback replaced the panel', async () => {
    const initial = panel({ nextCursor: 'c1' });
    const more = deferred();
    const rollback = deferred();
    const fetchMock = vi.fn((url: string) =>
      url.endsWith('/rollback') ? rollback.promise : more.promise,
    );
    vi.stubGlobal('fetch', fetchMock);
    render(initial);

    fireEvent.click(screen.getByRole('button', { name: 'Show more releases' }));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await flush();
    // While the rollback is in flight, Show more starts nothing.
    const fresh = release({ state: 'live' });
    await act(async () => {
      rollback.resolve(
        respond(200, { ...initial, currentRelease: fresh, releases: [fresh], nextCursor: null }),
      );
    });
    await flush();
    await act(async () => {
      more.resolve(respond(200, { ...initial, releases: [release()], nextCursor: null }));
    });
    await flush();
    expect(screen.getAllByTestId('production-release-row')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('productionRefusalKey', () => {
  it('falls back on the status for an untyped body, and never trusts an inherited key', async () => {
    expect(await productionRefusalKey(new Response('nope', { status: 403 }))).toBe(
      'refusal.forbidden',
    );
    expect(await productionRefusalKey(new Response('nope', { status: 404 }))).toBe(
      'refusal.notFound',
    );
    expect(await productionRefusalKey(respond(500, { error: { code: 'toString' } }))).toBe(
      'dialog.error',
    );
    expect(await productionRefusalKey(respond(400, { error: { code: 7 } }))).toBe('dialog.error');
  });

  it('answers the design’s error when a 200 carries no JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200 })),
    );
    const { productionPanelClient } = await import('@/lib/hosting/productionPanelClient');
    expect(await productionPanelClient.read('ACME', 'row-1')).toEqual({
      ok: false,
      refusalKey: 'dialog.error',
    });
  });
});

describe('the room’s other parts', () => {
  it('the loading skeleton is busy and says what it loads', () => {
    renderWithIntl(<ProductionSkeleton />);
    const loading = screen.getByTestId('production-loading');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.textContent).toContain('Loading releases…');
  });

  it('the error state shows nothing as live, and Try again re-reads the server section', async () => {
    renderWithIntl(<ProductionError />);
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t load the releases');
    expect(screen.queryByTestId('production-state-pill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('the picker lists the repositories it is handed and navigates to the one chosen', async () => {
    renderWithIntl(
      <ProductionRepositoryPicker
        repositories={[
          { id: 'row-1', name: 'shop', role: 'web', label: null },
          { id: 'row-2', name: 'shop-api', role: 'api', label: 'Orders API' },
        ]}
        selectedId="row-1"
      />,
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository' }));
    await flush();
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['shopWeb app', 'shop-apiOrders API']);
    fireEvent.click(options[0]!);
    await flush();
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository' }));
    await flush();
    fireEvent.click(screen.getAllByRole('option')[1]!);
    await flush();
    expect(push).toHaveBeenCalledWith('/settings/project/production?repository=row-2');
  });
});
