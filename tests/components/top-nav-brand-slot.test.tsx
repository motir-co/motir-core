// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WAVE_BAND_PATH } from '@/components/brand/waveBand';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

// MOTIR-4799 — the selector every assertion below reaches the mark through.
//
// It was the LITERAL `a[href="/dashboard"]` until this card, and that is exactly
// how the defect stayed green: the mark had pointed at the retired home since
// MOTIR-2654 moved the landing, and six assertions here agreed with it, because
// a test that pins a literal without saying why that literal is the answer goes
// stale the same way a comment does (`tests/components/OnboardingExit.test.tsx`
// is the same failure, one repair earlier). Composed from the owner constant, it
// cannot: MOTIR-4782 moves `AUTHED_LANDING_PATH` to `/workbench`, and this file
// follows it without an edit.
const BRAND_HREF = `a[href="${AUTHED_LANDING_PATH}"]`;

// MOTIR-1150 — the app shell's brand slot (design/brand/design-notes.md §7a).
//
// This is the ONE slot in the product where the mark stands alone, and that
// makes it the one slot where §8 files it as INFORMATIVE: with no wordmark
// beside it, the link's `aria-label` is the brand's only accessible name. Get
// that wrong and the shell's first focusable element announces as "link" — a
// defect nothing else on this card can catch, because every other surface has
// visible text to fall back on.
//
// TopNav's right cluster is a stack of client islands that each need their own
// provider (`useCreateIssue`, the notification poller, the command palette), so
// they are stubbed: this test is about the slot that was ADDED, its position and
// its name, not about re-testing the eight components beside it.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock('@/app/(authed)/_components/ShellTierNav', () => ({
  ShellTierNav: () => <nav data-testid="tier-nav">org / workspace</nav>,
}));
vi.mock('@/components/ui/SidebarToggle', () => ({
  SidebarToggle: () => <button data-testid="hamburger">menu</button>,
}));
vi.mock('@/app/(authed)/_components/UserMenu', () => ({ UserMenu: () => <div /> }));
vi.mock('@/app/(authed)/_components/ThemeToggle', () => ({ ThemeToggle: () => <div /> }));
vi.mock('@/app/(authed)/_components/NotificationBell', () => ({ NotificationBell: () => <div /> }));
vi.mock('@/app/(authed)/_components/CommandPaletteTrigger', () => ({
  CommandPaletteTrigger: () => <div />,
}));
vi.mock('@/app/(authed)/_components/CreateIssueButton', () => ({
  CreateIssueButton: () => <div data-testid="create-issue" />,
}));
vi.mock('@/app/(authed)/_components/ReportButton', () => ({ ReportButton: () => <div /> }));
vi.mock('@/components/planning/PlanWithAILauncher', () => ({ PlanWithAILauncher: () => <div /> }));
vi.mock('@/app/(authed)/_components/build-in-public/BuildInPublicButton', () => ({
  BuildInPublicButton: () => <div />,
}));
vi.mock('@/app/(authed)/_components/build-in-public/BuildingInPublicHeaderLink', () => ({
  BuildingInPublicHeaderLink: () => <div />,
}));

import { TopNav } from '@/app/(authed)/_components/TopNav';

const props = {
  activeOrg: null,
  orgs: [],
  workspaces: [],
  activeWorkspaceId: null,
  // The project half of the context path (MOTIR-2556). Null here: this file is
  // about the BRAND slot, and the tier nav is stubbed.
  activeProject: null,
  projects: [],
  aiConfigured: false,
  user: { name: 'Zhu Yue', email: 'yue@example.com' },
  initialUnreadCount: null,
  buildInPublicProjectKey: null,
  buildingInPublic: false,
  cloudBilling: false,
  showPlanWithAi: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the shell brand slot (§7a)', () => {
  it('fills the slot this file’s docstring reserved, with the real mark', async () => {
    const { container } = render(await TopNav(props));
    const brand = container.querySelector(BRAND_HREF)!;
    expect(brand.querySelector('path')!.getAttribute('d')).toBe(WAVE_BAND_PATH);
  });

  it('is MARK ONLY — a wordmark would read as a fourth level of context', async () => {
    // The left cluster already carries org › workspace as text. The brand sits
    // OUTSIDE that hierarchy, which its own tile now says.
    const { container } = render(await TopNav(props));
    const brand = container.querySelector(BRAND_HREF)!;
    expect(brand.textContent).toBe('');
    expect(container.querySelector('.brand-lockup')).toBeNull();
  });

  it('draws motir.co’s logo tile — the primary-colour mark on its wash (MOTIR-8932)', async () => {
    // The same artwork motir.co's header draws (`motir-marketing`
    // `BrandTile.tsx`) and `app/icon.svg` carries: a 32-unit square, corner
    // radius 7, the wave inset to 0.8067. The colours are the two logo tokens
    // and nothing else, so the tile follows the theme and every palette.
    const { container } = render(await TopNav(props));
    const svg = container.querySelector(BRAND_HREF)!.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32');
    // it fills the Link's 32px box rather than pinning a second size
    expect(svg.getAttribute('class')).toContain('h-full');
    expect(svg.getAttribute('class')).toContain('w-full');

    const tile = svg.querySelector('rect')!;
    expect(tile.getAttribute('width')).toBe('32');
    expect(tile.getAttribute('height')).toBe('32');
    expect(tile.getAttribute('rx')).toBe('7');
    expect(tile.getAttribute('class')).toBe('fill-(--el-logo-tile)');

    const wave = svg.querySelector('g')!;
    expect(wave.getAttribute('transform')).toBe('translate(6.32 6.32) scale(0.8067)');
    const path = wave.querySelector('path')!;
    expect(path.getAttribute('d')).toBe(WAVE_BAND_PATH);
    expect(path.getAttribute('class')).toBe('fill-(--el-logo-mark)');

    // NOT the shared `.brand-glyph` mark: that rule paints it in
    // `--el-accent-on-surface`, which would override the tile's own ink.
    expect(svg.classList.contains('brand-glyph')).toBe(false);
  });

  it('carries the accessible name, because nothing else here can (§8)', async () => {
    const { container } = render(await TopNav(props));
    const brand = container.querySelector(BRAND_HREF)!;
    expect(brand.getAttribute('aria-label')).toBe('topNav.brandHome');
    // The glyph stays hidden even though it is the only content: the LINK is
    // what carries the name, so exposing the svg as well would double it.
    expect(brand.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('link', { name: 'topNav.brandHome' })).toBeTruthy();
  });

  it('sits at the extreme left — before the mobile hamburger, not after it', async () => {
    // A NEW slot, not a substitution: `SidebarHeader` is project context and the
    // 8.3.1 renders established it has no room. Order is the whole point of §7a,
    // so it is asserted rather than eyeballed.
    const { container } = render(await TopNav(props));
    const cluster = container.querySelector(BRAND_HREF)!.parentElement!;
    const order = Array.from(cluster.children);
    expect(order[0]!.tagName).toBe('A');
    // The hairline divider that used to sit here is GONE (MOTIR-2557): the
    // tile's own edge says what it said, and the 9px went back to a row that
    // measured 69px of slack. So the hamburger follows the mark directly.
    expect(order[1]!.querySelector('[data-testid="hamburger"]')).not.toBeNull();
    expect(order[2]!.getAttribute('data-testid')).toBe('tier-nav');
  });

  it('YIELDS to the hamburger below md — the slot is desktop-only', async () => {
    // Measured, not preferred — and STILL measured after MOTIR-2373 closed the
    // overflow this guard was originally written against. The bar's below-`md`
    // budget is four right-cluster slots against a 320px floor:
    // 320 − 32 gutters − 36 hamburger − 8 − 8 gaps − 68 tier-nav = 168px, with
    // no brand in the sum (design/shell design-notes.md § *The budget*). So the
    // left cluster below `md` is hamburger + tier nav, and the brand is a `md`+
    // slot by design rather than by deferral: deleting these two `md:` variants
    // spends 57px the budget has not allocated, pushing the hamburger from
    // x=16–52 to x=73–109 and re-breaking `shell-flows` and `settings-area` at
    // narrow width. Pinned here, not left as styling.
    //
    // The budget itself — the four slots, the `hidden md:inline-flex` gates on
    // the displaced controls, the `lg` label breakpoint — is
    // `top-nav-control-budget.test.tsx`; the hit-test is
    // `tests/e2e/cloud-top-bar-budget.spec.ts`.
    const { container } = render(await TopNav(props));
    const brand = container.querySelector(BRAND_HREF)!;
    expect(brand.className).toContain('hidden');
    expect(brand.className).toContain('md:flex');
    // …and the tile is drawn INSIDE the Link (MOTIR-8932), so it inherits the
    // same `md` gate for free — there is no second element left to gate. The
    // neutral field and hairline MOTIR-2557 put on the Link itself are gone.
    expect(brand.className).not.toContain('bg-(--el-surface)');
    expect(brand.className).not.toContain('border-(--el-border)');
    expect(brand.querySelector('rect')).not.toBeNull();
    // The hamburger keeps its own mirror-image breakpoint, so exactly one of the
    // two leads the cluster at any width.
    const hamburgerWrapper = container.querySelector('[data-testid="hamburger"]')!.parentElement!;
    expect(hamburgerWrapper.className).toContain('md:hidden');
  });
});

describe('the mark goes to the LANDING, not to the dashboard (MOTIR-4799)', () => {
  // The seventh member of the family `lib/navigation/landing.ts` was built to
  // end (MOTIR-2921 · MOTIR-3171 · MOTIR-3173 · MOTIR-3367 · MOTIR-3372 ·
  // MOTIR-4403). It survived all six repairs AND the owner-guard, because every
  // one of them looks for a literal under a COMMENT and this link declared its
  // intent in its ACCESSIBLE NAME: `aria-label={t('topNav.brandHome')}` on an
  // anchor pointing at `/dashboard`. MOTIR-3173 read this exact line, called it
  // a product question rather than a stale constant, and left it deliberately;
  // this is that question answered.
  //
  // Asserted off the RENDERED anchor rather than off the constant, because the
  // constant is what the fix imports — reading it back would assert the fix
  // against itself.

  it('points at the signed-in landing', async () => {
    const { container } = render(await TopNav(props));
    const brand = container.querySelector<HTMLAnchorElement>(`a[aria-label="topNav.brandHome"]`)!;
    expect(brand).not.toBeNull();
    expect(brand.getAttribute('href')).toBe(AUTHED_LANDING_PATH);
  });

  it('does NOT point at /dashboard — the destination its own label denied', async () => {
    // The negative is asserted separately and on purpose. `AUTHED_LANDING_PATH`
    // is about to become `/workbench` (MOTIR-4782), so the positive above will
    // keep passing through that rename; this one states the thing that must stay
    // false whatever the landing is called.
    const { container } = render(await TopNav(props));
    const brand = container.querySelector<HTMLAnchorElement>(`a[aria-label="topNav.brandHome"]`)!;
    expect(brand.getAttribute('href')).not.toBe('/dashboard');
  });
});

describe('the work-item Create follows the active project (MOTIR-6548 · no-project shell S1)', () => {
  it('is not rendered with no active project — there is nothing to create into', async () => {
    const { container } = render(await TopNav(props));
    expect(container.querySelector('[data-testid="create-issue"]')).toBeNull();
  });

  it('is rendered once there is one', async () => {
    const project = { id: 'p1', name: 'Motir', identifier: 'MOTIR' } as never;
    const { container } = render(await TopNav({ ...props, activeProject: project }));
    expect(container.querySelector('[data-testid="create-issue"]')).not.toBeNull();
  });
});
