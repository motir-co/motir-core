// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4843 · MOTIR-4846 — the FOURTH settings area's rail branch.
//
// This is the SMOKE the first card that renders the surface owes: the
// instrument that OPENS it. Without it every later card in the story has a
// green suite against a page nobody loaded.
//
// Two properties, and the second is the one the re-plan turned on:
//
//   1. ABOVE the reveal — three rows, and EXACTLY ONE reads active on each of
//      the three routes. The area root is `exact`, which is what stops it
//      reading as current on all three at once.
//   2. BELOW the reveal — NO rows at all. Not fewer rows: none. All three
//      routes `notFound()` there and their capabilities are hosted on
//      `/settings/organization`, gated per SECTION (§6d), so an empty rail is
//      the honest rendering. Nothing marks the gap — no empty heading, no
//      disabled row.

let pathname = '/settings/workspace';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';
import { WorkspaceSidebarHeader } from '@/app/(authed)/_components/WorkspaceSidebarHeader';
import { AUTHED_LANDING_PATH } from '@/lib/navigation/landing';

const USER = { name: 'Yue', email: 'yue@example.com' };
const WORKSPACE = { name: 'Engineering' };

function renderRail(workspaceTierRevealed: boolean) {
  return renderWithIntl(
    <SidebarNav
      activeProject={null}
      user={USER}
      workspace={WORKSPACE}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

const ROWS = [
  { label: 'Workspace', href: '/settings/workspace' },
  { label: 'Security', href: '/settings/workspace/security' },
];

afterEach(() => {
  cleanup();
  pathname = '/settings/workspace';
});

describe('the workspace-settings AREA rail — above the reveal', () => {
  it.each(ROWS)('renders every row at $href', ({ href }) => {
    pathname = href;
    renderRail(true);
    for (const row of ROWS) {
      expect(
        screen.getByRole('link', { name: row.label }).getAttribute('href'),
        `${row.label} at ${href}`,
      ).toBe(row.href);
    }
  });

  it.each(ROWS)('marks EXACTLY ONE row current at $href — and no other', ({ href, label }) => {
    pathname = href;
    renderRail(true);
    const current = ROWS.filter(
      (row) =>
        screen.getByRole('link', { name: row.label }).getAttribute('aria-current') === 'page',
    );
    expect(current.map((r) => r.label)).toEqual([label]);
  });

  it('names the WORKSPACE in the rail head, with the area eyebrow', () => {
    renderRail(true);
    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Workspace settings')).toBeTruthy();
  });

  it('groups the rows under General · Access, in that order — no Operations group', () => {
    renderRail(true);
    const headings = screen
      .getAllByText(/^(General|Access|Operations)$/)
      .map((el) => el.textContent);
    expect(headings).toEqual(['General', 'Access']);
  });
});

describe('the workspace-settings AREA rail — BELOW the reveal', () => {
  it.each(ROWS)('renders NO workspace rows at $href', ({ href }) => {
    pathname = href;
    renderRail(false);
    for (const row of ROWS) {
      expect(screen.queryByRole('link', { name: row.label }), row.label).toBeNull();
    }
  });

  it('renders no group heading either — the groups are ABSENT, not empty', () => {
    renderRail(false);
    for (const heading of ['General', 'Access', 'Operations']) {
      expect(screen.queryByText(heading), heading).toBeNull();
    }
  });

  it.each([[true], [false]])(
    '⚠️ `Job runs` is absent at revealed=%s — the row was RETIRED (MOTIR-9982)',
    (revealed) => {
      // The tenant Job runs surface is gone (decision MOTIR-4896): the ledger is
      // staff-only at `/admin/jobs`, the tenant route has no page, and
      // the registry has no row for it on either side of the reveal.
      renderRail(revealed);
      expect(screen.queryByRole('link', { name: 'Job runs' })).toBeNull();
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// Story MOTIR-4843 · MOTIR-4848 — the rail HEAD's remaining arms
// ═════════════════════════════════════════════════════════════════════════════
//
// The head is rendered DIRECTLY here rather than through `SidebarNav`, because
// the arm that was uncovered is the COLLAPSED one and the rail resolves that
// from `useSidebarCollapsed` — a hook backed by localStorage plus a `storage`
// event. Driving a prop is the honest instrument for a prop.
//
// ⚠️ THIS IS A COVERAGE-FLOOR CASE AND SAYS SO. Measured before this block, the
// head was 90 / **60** / 100 / 90 — under the repo's 90 branch floor on the one
// axis, which is why `vitest.config.ts` could not pin all four. The rule the
// config states for exactly this situation is to CLOSE the gap by writing the
// missing specs rather than to pin the axis below 90, which would be lowering a
// bar to make a build pass (MOTIR-4368's precedent, on `SidebarNav` itself).
describe('the workspace rail HEAD — both widths, and the nameless workspace', () => {
  it('renders the name, the eyebrow and the back link when EXPANDED', () => {
    renderWithIntl(<WorkspaceSidebarHeader workspace={{ name: 'Engineering' }} />);
    expect(screen.getByText('Engineering')).toBeTruthy();
    expect(screen.getByText('Workspace settings')).toBeTruthy();
    expect(screen.getByRole('link', { name: /back to motir/i }).getAttribute('href')).toBe(
      AUTHED_LANDING_PATH,
    );
  });

  it('COLLAPSED, it is the back arrow and the tile — the name and eyebrow are gone', () => {
    // The 56px rail. The label survives as the link's accessible name rather
    // than as text, which is what keeps the affordance reachable when the rail
    // has no room to say what it is.
    renderWithIntl(<WorkspaceSidebarHeader workspace={{ name: 'Engineering' }} collapsed />);
    expect(screen.getByRole('link', { name: /back to motir/i }).getAttribute('href')).toBe(
      AUTHED_LANDING_PATH,
    );
    expect(screen.queryByText('Workspace settings')).toBeNull();
    expect(screen.queryByText('Engineering')).toBeNull();
  });

  it('⚠️ the back href is the IMPORTED constant at BOTH widths, never a retyped path', () => {
    // The four rail heads go stale as a SET — `/dashboard` survived in two of
    // them after MOTIR-2654 moved the signed-in landing, because they are
    // written from one pattern and nobody re-read the rest (MOTIR-3373). The
    // collapsed arm is the one a reader is least likely to open.
    for (const collapsed of [false, true]) {
      cleanup();
      const { container } = renderWithIntl(
        <WorkspaceSidebarHeader workspace={{ name: 'Engineering' }} collapsed={collapsed} />,
      );
      expect(container.innerHTML, `collapsed=${collapsed}`).not.toContain('/dashboard');
    }
  });

  it('falls back to `?` for a whitespace-only name, rather than an empty tile', () => {
    // `charAt(0)` of a trimmed empty string is `''`, which would render a tile
    // with nothing in it — indistinguishable from a failed load.
    const { container } = renderWithIntl(<WorkspaceSidebarHeader workspace={{ name: '   ' }} />);
    expect(container.textContent).toContain('?');
  });
});
