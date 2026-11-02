// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@/lib/contexts/theme-context';
import { renderWithIntl as render } from '../helpers/renderWithIntl';

// The Visitor's chrome (Story MOTIR-6170 · MOTIR-6648; design MOTIR-6641 panels
// 3–5, 8 and 9b), rendered: the rail's six rows and which one is lit, the
// rate-limited state's retry, the banner's sentence, the read-only top bar, and
// a private epic's "not public" block. Part of the story's coverage top-up
// (MOTIR-6650).

const nav = vi.hoisted(() => ({ pathname: '/p/NW/board' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn() }));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getLocale: async () => 'en',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

const { VisitorRail } = await import('@/app/(visitor)/p/[identifier]/_components/VisitorRail');
const { VisitorRateLimited } =
  await import('@/app/(visitor)/p/[identifier]/_components/VisitorRateLimited');
const { VisitorBanner } = await import('@/app/(visitor)/p/[identifier]/_components/VisitorBanner');
const { VisitorTopNav } = await import('@/app/(visitor)/p/[identifier]/_components/VisitorTopNav');
const { EpicNotPublicBlock, EpicNotPublicPill } =
  await import('@/app/(authed)/items/[key]/_components/EpicNotPublic');

afterEach(() => cleanup());

describe('VisitorRail', () => {
  it('links the seven Visitor views, and lights Work Items for the list, the tree and an item', () => {
    for (const [path, lit] of [
      ['/p/NW/items', 'Work Items'],
      ['/p/NW/tree', 'Work Items'],
      ['/p/NW/items/NW-4', 'Work Items'],
      ['/p/NW/board', 'Boards'],
      ['/p/NW/runs', 'Runs'],
      // MOTIR-6769 — the pending public requests, under the members' own label.
      ['/p/NW/requested-features', 'Requested features'],
    ] as const) {
      nav.pathname = path;
      render(<VisitorRail identifier="NW" helpMenu={<span data-testid="help" />} />);
      const links = screen.getAllByRole('link');
      expect(links.map((a) => a.getAttribute('href'))).toEqual([
        '/p/NW/items',
        '/p/NW/runs',
        '/p/NW/board',
        '/p/NW/roadmap',
        '/p/NW/requested-features',
        '/p/NW/plans',
        '/p/NW/approvals',
      ]);
      const current = links.filter((a) => a.getAttribute('aria-current') === 'page');
      expect(current).toHaveLength(1);
      expect(current[0]!.textContent, path).toContain(lit);
      expect(screen.getByTestId('help')).toBeTruthy();
      cleanup();
    }
  });

  it('as the drawer: no footer, and nothing lit on a path that is not a Visitor view', () => {
    nav.pathname = '/somewhere/else';
    render(<VisitorRail identifier="NW" variant="drawer" helpMenu={<span data-testid="help" />} />);
    expect(screen.queryByTestId('help')).toBeNull();
    expect(
      screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page'),
    ).toHaveLength(0);
  });
});

describe('VisitorRateLimited', () => {
  it('names the wait and reloads on Try again', () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    });
    try {
      render(<VisitorRateLimited retryAfterSeconds={42} />);
      const state = screen.getByTestId('visitor-rate-limited');
      expect(state.textContent).toContain('42');
      fireEvent.click(within(state).getByRole('button'));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('the server-rendered chrome', () => {
  it('the banner names the project in bold and nobody else', async () => {
    render(await VisitorBanner({ projectName: 'Northwind' }));
    const banner = screen.getByTestId('visitor-banner');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.querySelector('strong')?.textContent).toBe('Northwind');
  });

  it('the top bar: the brand to the landing, the name and key as text, the reader’s own menu', async () => {
    render(
      <ThemeProvider>
        {await VisitorTopNav({
          projectName: 'Northwind',
          projectKey: 'NW',
          landingHref: 'https://motir.co/p/NW',
          user: { name: null, email: 'riya@example.com' },
        })}
      </ThemeProvider>,
    );
    expect(
      screen.getAllByRole('link').some((a) => a.getAttribute('href') === 'https://motir.co/p/NW'),
    ).toBe(true);
    expect(screen.getByText('Northwind')).toBeTruthy();
    expect(screen.getByText('NW')).toBeTruthy();
    // No create door, no switcher, no search: the only buttons are the theme,
    // the menu toggle and the account menu.
    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
    // No photo ⇒ the account menu draws the email's initial (MOTIR-10182).
    const account = screen.getByRole('button', { name: /account menu/i });
    expect(account.querySelector('img')).toBeNull();
    expect(account.textContent).toBe('R');
  });

  it('the top bar’s account menu shows the reader’s profile photo (MOTIR-10182)', async () => {
    const photo = 'https://assets.example.com/avatars/riya.png';
    render(
      <ThemeProvider>
        {await VisitorTopNav({
          projectName: 'Northwind',
          projectKey: 'NW',
          landingHref: 'https://motir.co/p/NW',
          user: { name: 'Riya', email: 'riya@example.com', image: photo },
        })}
      </ThemeProvider>,
    );
    const account = screen.getByRole('button', { name: /account menu/i });
    expect(account.querySelector('img')?.getAttribute('src')).toBe(photo);
    expect(account.textContent).toBe('');
  });
});

describe('a private epic’s item page', () => {
  it('the children panel becomes the not-public block; the pill is the shared one', () => {
    render(
      <>
        <EpicNotPublicPill />
        <EpicNotPublicBlock />
      </>,
    );
    expect(screen.getByTestId('epic-not-public').querySelector('h2')).toBeTruthy();
    expect(screen.getByTestId('epic-not-public-pill')).toBeTruthy();
  });
});
