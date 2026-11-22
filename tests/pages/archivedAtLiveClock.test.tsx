// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  observeRelativeTimePin,
  resetRelativeTimeClockForTests,
} from '@/lib/hooks/useRelativeTime';
import type { PageArchivedListDto, PageArchivedListItemDto } from '@/lib/dto/pages';

// MOTIR-11993 — "archived N ago" on the Archived pages list and the archived
// page's banner. `useArchivedAtLabel` measured against `useNow()`, which with no
// `updateInterval` is the provider's pinned request instant (finding #89): the
// list fetches its rows in the browser, so a page archived after load read
// "in 3 minutes", and no row aged while the list stayed open. Each case pins the
// provider `now`, lets the clock run, and asserts no future-tense label.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const { ArchivedPagesList } =
  await import('@/app/(authed)/pages/archived/_components/ArchivedPagesList');
const { PageArchivedBanner } = await import('@/components/pages/archive/PageArchivedBanner');

const PIN = new Date('2026-11-22T09:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(PIN.getTime() + ms).toISOString();
const FUTURE = /\bin \d+ (second|minute|hour)s?\b/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(PIN);
  resetRelativeTimeClockForTests();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRelativeTimeClockForTests();
  vi.useRealTimers();
});

async function letTheClockRun(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function item(id: string, archivedAt: string): PageArchivedListItemDto {
  return {
    id,
    title: `Page ${id}`,
    archivedAt,
    archivedBy: { id: 'u1', name: 'Grace Hopper' },
    subPageCount: 0,
    parent: { kind: 'root' },
    ancestorPageIds: [],
    cameFrom: { folders: [], pages: [] },
    archivedAncestorIds: [],
  };
}

describe('the Archived pages list — rows fetched in the browser', () => {
  it('a page archived after load reads as just made, and every row ages without a reload', async () => {
    // The page hydrated at the pin, but its server read failed (no `initial`);
    // Try again five minutes and twenty seconds later reads the first page in the
    // browser, carrying a page a teammate archived since.
    observeRelativeTimePin(PIN.getTime());
    const fetchedAt = 5 * MIN + 20_000;
    vi.setSystemTime(new Date(PIN.getTime() + fetchedAt));
    const page: PageArchivedListDto = {
      items: [item('fresh', at(fetchedAt)), item('older', at(-MIN))],
      nextCursor: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })),
    );
    const { container } = renderWithIntl(
      <ToastProvider>
        <ArchivedPagesList initial={null} projectKey="MOTIR" canRestore canDelete />
      </ToastProvider>,
      { now: PIN },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    const fresh = await screen.findByTestId('archived-page-fresh');
    const older = screen.getByTestId('archived-page-older');
    expect(fresh.textContent).toContain('now');
    expect(older.textContent).toContain('6 minutes ago');
    expect(container.textContent).not.toMatch(FUTURE);

    await letTheClockRun(3 * MIN);
    expect(fresh.textContent).toContain('3 minutes ago');
    expect(older.textContent).toContain('9 minutes ago');
    expect(container.textContent).not.toMatch(FUTURE);
  });

  it('a row past the day line still reads as an absolute date', () => {
    observeRelativeTimePin(PIN.getTime());
    renderWithIntl(
      <ToastProvider>
        <ArchivedPagesList
          initial={{ items: [item('old', '2026-09-01T09:30:00.000Z')], nextCursor: null }}
          projectKey="MOTIR"
          canRestore
          canDelete
        />
      </ToastProvider>,
      { now: PIN },
    );
    expect(screen.getByTestId('archived-page-old').textContent).toContain('Sep 1, 2026');
  });
});

describe('the archived banner', () => {
  const banner = (archivedAt: string) => (
    <ToastProvider>
      <PageArchivedBanner
        page={{
          id: 'p1',
          title: 'Billing',
          archivedAt,
          archivedBy: { name: 'Grace Hopper' },
          archiveRoot: null,
          canRestore: false,
          canDelete: false,
        }}
        subPageCount={0}
      />
    </ToastProvider>
  );

  it('ages while the page stays open', async () => {
    observeRelativeTimePin(PIN.getTime());
    const { container } = renderWithIntl(banner(at(-2 * MIN)), { now: PIN });
    expect(container.textContent).toContain('2 minutes ago');
    await letTheClockRun(4 * MIN);
    expect(container.textContent).toContain('6 minutes ago');
    expect(container.textContent).not.toMatch(FUTURE);
  });

  it('the server render and hydration agree on first paint', async () => {
    const tree = (
      <NextIntlClientProvider locale="en" messages={enMessages} now={PIN} timeZone="UTC">
        {banner(at(-2 * MIN))}
      </NextIntlClientProvider>
    );
    const html = renderToString(tree);
    expect(html).toContain('2 minutes ago');

    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    observeRelativeTimePin(PIN.getTime());
    const onRecoverableError = vi.fn();
    const root = await act(async () => hydrateRoot(host, tree, { onRecoverableError }));
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(host.textContent).toContain('2 minutes ago');
    await act(async () => root.unmount());
    host.remove();
  });
});
