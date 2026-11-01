// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ProjectDTO } from '@/lib/dto/projects';
import { renderWithIntl } from '../helpers/renderWithIntl';

// Story MOTIR-4669 · MOTIR-4710 — the rail SWAPS to the organisation-settings nav.
//
// The third of three area branches, and the one that closes a gap rather than
// adding a feature. `SidebarNav` swapped on exactly two predicates —
// `isAccountSettingsPath` and `isProjectSettingsPath` — so `/settings/organization*`
// rendered the ORDINARY rail with the bottom `Settings` row lit, and the four org
// sub-routes were reachable only from the `OrgControl` pop-over. People arrived
// (the bottom row points here whenever no project is active) at a page naming none
// of them.
//
// The registry's own unit tests (`tests/settings/organizationSettingsNav.test.ts`)
// prove the filtering. THIS file proves the RAIL — that the branch is reached, that
// the header names the organisation rather than the project or the user, and that
// what the registry decided is what actually renders.

let pathname = '/settings/organization';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  key: 'MOTIR',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };
const ADMIN_ORG = { name: 'moooon', isOrgAdmin: true };
const MEMBER_ORG = { name: 'moooon', isOrgAdmin: false };

function renderRail(
  organization: { name: string; isOrgAdmin: boolean } | null,
  billingAvailable = true,
  workspaceTierRevealed = false,
) {
  return renderWithIntl(
    <SidebarNav
      activeProject={PROJECT}
      user={USER}
      organization={organization}
      billingAvailable={billingAvailable}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

const rowNames = () =>
  screen
    .getAllByRole('link')
    .map((a) => a.textContent?.trim() ?? '')
    .filter(Boolean);

afterEach(() => {
  pathname = '/settings/organization';
  cleanup();
});

describe('the rail SWAPS on an organisation-settings route', () => {
  it('renders the organisation nav, in registry order', () => {
    renderRail(ADMIN_ORG);
    // `Git` joined in MOTIR-4680, in the SAME commit as its route — the move
    // every row in these registries makes.
    expect(rowNames()).toEqual([
      'Back to Motir',
      'Organisation',
      'Git',
      'Members',
      'Security',
      'Usage & cost',
      'Billing & plans',
    ]);
  });

  it('⚠️ the PRODUCT rail is gone while in the area — this is a swap, not an addition', () => {
    // The property that makes it an AREA. If the branch were reached but returned
    // the ordinary sections plus a group, a person inside organisation settings
    // would see Board, Roadmap and the rest — which is what "the same setting nav
    // as the project setting" rules out.
    renderRail(ADMIN_ORG);
    expect(screen.queryByRole('link', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Job runs' })).toBeNull();
  });

  it('the HEAD names the ORGANISATION — not the project, not the user', () => {
    // Each area's head names the tenant that area configures. The project area
    // shows the ProjectSwitcher, the account area the signed-in user; getting this
    // one wrong would be invisible to a type checker and obvious to a reader.
    renderRail(ADMIN_ORG);
    expect(screen.getByText('moooon')).toBeTruthy();
    expect(screen.getByText('Organisation settings')).toBeTruthy();
    expect(screen.queryByText('yue@example.com')).toBeNull();
  });

  it('every group heading renders, in order', () => {
    renderRail(ADMIN_ORG);
    const headings = screen.getAllByText(/^(General|Access|Billing)$/).map((n) => n.textContent);
    expect(headings).toEqual(['General', 'Access', 'Billing']);
  });

  it('the ACTIVE row is the route, and it is the only one', () => {
    pathname = '/settings/organization/members';
    renderRail(ADMIN_ORG);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current'));
    expect(current.map((a) => a.textContent?.trim())).toEqual(['Members']);
  });

  it('⚠️ the ROOT row is active on the root ALONE', () => {
    // Every other href sits beneath this one, so without the registry's `exact`
    // flag `Organisation` would read current on all five routes at once.
    pathname = '/settings/organization';
    renderRail(ADMIN_ORG);
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current'));
    expect(current.map((a) => a.textContent?.trim())).toEqual(['Organisation']);
  });
});

describe('the two filtered arms, as they RENDER', () => {
  it('a plain org member sees `Organisation` alone — the rest absent, not disabled', () => {
    // `Organisation` survives because §6d's folded-in workspace sections (and
    // Leave workspace) are reached only through it. `Git` joined the Admin-gated
    // set with the role model (MOTIR-6312 · panel 3d, the Git-row flag).
    renderRail(MEMBER_ORG);
    expect(rowNames()).toEqual(['Back to Motir', 'Organisation']);
    // Nothing marks the gap: an entry point is a promise about a room, and a
    // disabled row is a promise the product then refuses (MOTIR-2468).
    expect(screen.queryByText('Access')).toBeNull();
    expect(rowNames()).not.toContain('Billing & plans');
  });

  it('off cloud, `Billing & plans` is gone and its group keeps `Usage & cost`', () => {
    renderRail(ADMIN_ORG, false);
    expect(rowNames()).not.toContain('Billing & plans');
    expect(rowNames()).toContain('Usage & cost');
    expect(screen.getByText('Billing')).toBeTruthy(); // the group heading survives
  });

  it('a plain org member ABOVE the reveal sees no org row at all — the page 404s for them', () => {
    // MOTIR-6312 · panel 3d: at 2+ workspaces nothing on the org page is theirs.
    renderRail(MEMBER_ORG, true, true);
    expect(rowNames()).toEqual(['Back to Motir']);
  });

  it('⚠️ with NO organisation threaded the rail defaults CLOSED', () => {
    // A caller that forgets the prop must lose rows, never gain them. The head is
    // omitted too rather than rendering an empty identity.
    renderRail(null);
    expect(rowNames()).toEqual(['Organisation']);
    expect(screen.queryByText('Organisation settings')).toBeNull();
  });
});

describe('the branch does not fire outside the area', () => {
  // ⚠️ AMENDED TWICE OVER BY Story MOTIR-4843, and the case is SPLIT because its
  // three paths stopped being one situation.
  //
  //   · `Job runs` is no longer a row in the ordinary rail at all (MOTIR-4847),
  //     so it can no longer be the proof of anything. `Git` is what survives
  //     that section, and it is the cheapest proof now.
  //   · `/settings/workspace*` no longer renders the ORDINARY rail either
  //     (MOTIR-4846): the workspace tier has an AREA, so those two paths hit a
  //     branch of their own — which happens to be the strongest possible
  //     evidence that the ORGANISATION branch was not taken, and is what this
  //     describe is actually about.
  it('renders the ordinary rail at /dashboard', () => {
    // ⚠️ `Codebase`, NOT `Git` (MOTIR-4643). `Git` left the bottom section with
    // that card, so it can no longer be the cheapest proof that the ORGANISATION
    // branch was not taken — this is the third witness this case has had, after
    // `Job runs` (gone with MOTIR-4847) and `Git`. `Codebase` is a PRIMARY row
    // and is browse-reachable, which makes it a steadier one than either.
    pathname = '/dashboard';
    renderRail(ADMIN_ORG);
    expect(screen.queryByRole('link', { name: 'Codebase' })).toBeTruthy();
    expect(screen.queryByText('Organisation settings')).toBeNull();
  });

  it.each([['/settings/workspace'], ['/settings/workspace/roles']])(
    'renders NEITHER rail at %s — the workspace branch answers first',
    (path) => {
      pathname = path;
      renderRail(ADMIN_ORG);
      // ⚠️ THE ASSERTION IS AN ABSENCE ON BOTH SIDES, and that is the honest
      // reading of this fixture rather than a weakened one.
      //
      // `renderRail` here passes neither `workspace` nor `workspaceTierRevealed`
      // — it is the ORG area's fixture — so the workspace branch renders its
      // head only when given a workspace, and `visibleWorkspaceSettingsNav`
      // returns NO rows below the reveal. An empty rail is therefore the correct
      // output, and asserting the area's eyebrow here would be asserting a prop
      // this file never threads.
      //
      // What the case is FOR is unchanged and is fully carried by the two
      // absences: the ORGANISATION branch did not fire (no org head), and
      // neither did the ordinary one (no bottom section). The workspace area's
      // own rows are `SidebarNav-workspace-area.test.tsx`'s subject, where the
      // props that render them are threaded.
      expect(screen.queryByText('Organisation settings')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Git' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    },
  );
});
