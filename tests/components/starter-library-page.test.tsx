// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/Toast';
import type { SeedRegistryConsolePageDto, SeedRegistryConsoleRowDto } from '@/lib/dto/seedRegistry';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { SHIPPED_ENTRIES, seedEntry } from '../fixtures/seedRegistryFixtures';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE STARTERS PAGE (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §2, §3.4–3.5)
// — the real page module rendered, with the staff gate and the library READ
// stubbed at their module boundaries (the read has its own DB suite). What is
// proved here is what the page does with the read: the URL's filters reach it;
// the table spells out each entry's role, what it serves, where it deploys, its
// status and where it came from; a default offers no Retire; the promoted entry
// is tinted; the empty and paged states read as drawn; and Retire asks for a
// reason, posts it and re-reads the library.

const { listLibrary, push, refresh } = vi.hoisted(() => ({
  listLibrary: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/lib/platform/pageGate', () => ({
  requirePlatformStaffPage: vi.fn(async () => ({
    userId: 'u-op',
    email: 'op@moooon.net',
    role: 'operator',
  })),
}));
vi.mock('@/lib/services/seedRegistryConsoleService', () => ({
  seedRegistryConsoleService: { listLibrary },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
  usePathname: () => '/admin/starters',
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

const DEFAULTS: SeedRegistryConsoleRowDto[] = SHIPPED_ENTRIES.map((entry) => ({
  entry,
  isDefault: true,
  promotedByEmail: null,
  promotedFromRepo: null,
  retirement: null,
}));

const PROMOTED: SeedRegistryConsoleRowDto = {
  entry: seedEntry('nextjs-booking-starter', {
    label: 'Next.js · booking',
    hostingTargets: ['serverless'],
    useCases: ['mvp'],
    sizes: ['small', 'medium'],
    legacyKeys: ['booking-v0'],
    promotedFrom: 'row-1',
    promotedRef: 'c0ffee0000000000000000000000000000000001',
    promotedBy: 'u-sam',
    promotedAt: '2026-10-26T10:00:00.000Z',
  }),
  isDefault: false,
  promotedByEmail: 'sam@moooon.net',
  promotedFromRepo: 'motir-projects/acme-booking-web',
  retirement: null,
};

const RETIRED: SeedRegistryConsoleRowDto = {
  entry: seedEntry('nextjs-old-fly', { label: 'Next.js · old Fly', status: 'retired' }),
  isDefault: false,
  promotedByEmail: null,
  promotedFromRepo: null,
  retirement: { byEmail: 'yue@moooon.net', at: '2026-10-27T10:00:00.000Z', reason: 'Replaced' },
};

function page(rows: SeedRegistryConsoleRowDto[], over: Partial<SeedRegistryConsolePageDto> = {}) {
  return { rows, total: rows.length, page: 1, pageSize: 25, ...over };
}

async function renderPage(searchParams: Record<string, string> = {}) {
  const mod = await import('@/app/(admin)/admin/starters/page');
  const tree = (await mod.default({ searchParams: Promise.resolve(searchParams) })) as ReactElement;
  return renderWithIntl(<ToastProvider>{tree}</ToastProvider>);
}

beforeEach(() => {
  listLibrary.mockReset();
  push.mockClear();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the library (§2.2–2.4)', () => {
  it('spells out each starter, its status and where it came from', async () => {
    listLibrary.mockResolvedValue(page([PROMOTED, ...DEFAULTS, RETIRED]));
    await renderPage({ status: 'all' });

    expect(screen.getByText('Newest first · 4 starters')).toBeTruthy();
    expect(screen.getByTestId('starters-promote').getAttribute('href')).toBe(
      '/admin/starters/promote',
    );

    const promoted = screen.getByTestId('starter-row-nextjs-booking-starter');
    expect(within(promoted).getByText('Next.js · booking')).toBeTruthy();
    expect(within(promoted).getByText('Also answers to booking-v0')).toBeTruthy();
    expect(within(promoted).getByText('web · nextjs')).toBeTruthy();
    expect(within(promoted).getByText('Serverless')).toBeTruthy();
    expect(within(promoted).getByText('Active')).toBeTruthy();
    expect(promoted.textContent).toContain('Promoted by sam@moooon.net on');
    expect(promoted.textContent).toContain('from motir-projects/acme-booking-web at c0ffee0');
    expect(within(promoted).getByRole('button', { name: 'Retire' })).toBeTruthy();

    const web = screen.getByTestId(`starter-row-${SEED_SOURCE_PLATFORM_STARTER}`);
    expect(within(web).getByText('Default')).toBeTruthy();
    expect(within(web).getByText('Default for web')).toBeTruthy();
    expect(within(web).getByText('Shipped with Motir')).toBeTruthy();
    expect(within(web).queryByRole('button', { name: 'Retire' })).toBeNull();

    const initialised = screen.getByTestId(`starter-row-${SEED_SOURCE_INITIALISED}`);
    expect(within(initialised).getByText('any role · any stack')).toBeTruthy();
    expect(within(initialised).getByText('Every use')).toBeTruthy();
    expect(within(initialised).getByText('Every size')).toBeTruthy();
    expect(within(initialised).getByText('Not deployed by Motir hosting')).toBeTruthy();
    expect(within(initialised).getByText('Default for every role')).toBeTruthy();

    const retired = screen.getByTestId('starter-row-nextjs-old-fly');
    expect(within(retired).getByText('Retired')).toBeTruthy();
    expect(retired.textContent).toContain('Retired by yue@moooon.net on');
    expect(retired.textContent).toContain('“Replaced”');
    expect(within(retired).queryByRole('button', { name: 'Retire' })).toBeNull();
  });

  it('hands the URL’s filters and page to the read, and tints the entry promoted just now', async () => {
    listLibrary.mockResolvedValue(page([PROMOTED], { total: 26, page: 2 }));
    await renderPage({
      role: 'web',
      target: 'serverless',
      page: '2',
      promoted: 'nextjs-booking-starter',
      bogus: 'x',
    });
    expect(listLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-op' }),
      { status: 'active', role: 'web', target: 'serverless' },
      2,
    );
    expect(
      screen.getByTestId('starter-row-nextjs-booking-starter').getAttribute('data-fresh'),
    ).toBe('true');
  });

  it('drops a filter value the library does not know', async () => {
    listLibrary.mockResolvedValue(page(DEFAULTS));
    await renderPage({ role: 'robot', target: 'mars', status: 'gone', page: '-3' });
    expect(listLibrary).toHaveBeenCalledWith(expect.anything(), { status: 'active' }, 1);
  });

  it('changes a filter through the URL, starting the pager over', async () => {
    listLibrary.mockResolvedValue(page(DEFAULTS, { page: 2, total: 40 }));
    await renderPage({ page: '2', target: 'fly' });
    fireEvent.click(screen.getByRole('button', { name: 'Retired' }));
    expect(push).toHaveBeenCalledWith('/admin/starters?status=retired&target=fly');
  });
});

describe('the states (§2.5)', () => {
  it('names the role and target when nothing matches both, with Clear filters', async () => {
    listLibrary.mockResolvedValue(page([]));
    await renderPage({ role: 'api', target: 'fly' });
    const empty = screen.getByTestId('starters-empty');
    expect(within(empty).getByText('No starters match these filters')).toBeTruthy();
    expect(empty.textContent).toContain('No active starter for api repositories deploys to Fly.');
    expect(within(empty).getByRole('link', { name: 'Clear filters' }).getAttribute('href')).toBe(
      '/admin/starters',
    );
  });

  it('reads the generic sentence for any other empty filter', async () => {
    listLibrary.mockResolvedValue(page([]));
    await renderPage({ status: 'retired' });
    expect(screen.getByTestId('starters-empty').textContent).toContain(
      'No starter matches these filters.',
    );
  });

  it('pages with Showing from–to of total, the ends disabled', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...PROMOTED,
      entry: { ...PROMOTED.entry, key: `k-${i}` },
    }));
    listLibrary.mockResolvedValue(page(rows, { total: 30 }));
    await renderPage({ target: 'serverless' });
    const pager = screen.getByTestId('starters-pager');
    expect(pager.textContent).toContain('Showing 1–25 of 30');
    expect(
      (within(pager).getByRole('button', { name: 'Previous page' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(pager).getByRole('link', { name: 'Next page' }).getAttribute('href')).toBe(
      '/admin/starters?target=serverless&page=2',
    );
  });
});

describe('retire (§3.4–3.5)', () => {
  function json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('asks for a reason, posts it, confirms with a toast and re-reads the library', async () => {
    const fetchMock = vi.fn(async () => json(200, { ...PROMOTED.entry, status: 'retired' }));
    vi.stubGlobal('fetch', fetchMock);
    listLibrary.mockResolvedValue(page([PROMOTED]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Retire Next.js · booking?')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Retire starter' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: '  Superseded by v2  ' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/platform/seed-registry/nextjs-booking-starter/retire',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'Superseded by v2' }),
      }),
    );
    expect(
      await screen.findByText(
        'Retired. Next.js · booking is no longer offered to new repositories.',
      ),
    ).toBeTruthy();
  });

  it('says a default cannot be retired, with a single Close', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(409, { code: 'SEED_ENTRY_IS_DEFAULT', error: 'default' })),
    );
    listLibrary.mockResolvedValue(page([PROMOTED]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'why not' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire starter' }));

    const alert = await within(dialog).findByTestId('retire-refusal');
    expect(alert.textContent).toContain("This starter can't be retired.");
    expect(alert.textContent).toContain(
      '“nextjs-booking-starter” is the default starter for web repositories.',
    );
    // The footer's Close, beside the dialog's own close control.
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(1);
    expect(within(dialog).queryByRole('button', { name: 'Retire starter' })).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the server’s sentence on any other failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(502, { code: 'X', error: 'GitHub is down.' })),
    );
    listLibrary.mockResolvedValue(page([PROMOTED]));
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'r' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire starter' }));
    expect((await within(dialog).findByTestId('retire-refusal')).textContent).toContain(
      'GitHub is down.',
    );
  });
});
