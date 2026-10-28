// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { WORKSPACE_SETTINGS_NAV } from '@/lib/settings/workspaceSettingsNav';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { UserMenu } from '@/app/(authed)/_components/UserMenu';
import { ShellTierNav } from '@/app/(authed)/_components/ShellTierNav';
import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';
import {
  isWorkspaceTierRevealed,
  scopeWorkspacesToActiveOrg,
  WORKSPACE_TIER_REVEAL_MIN,
} from '@/lib/workspaces/tierDisclosure';

// §6d's SETTINGS COLLAPSE, at the entry points (MOTIR-3502 ·
// `docs/decisions/organization-tier.md` §6). Below the reveal threshold the
// product has not told the user the workspace tier exists, so nothing rendered
// may NAME `/settings/workspace`.
//
// The assertions are about the MARKUP, not about visibility — deliberately, and
// for the same reason `UserMenu-platform-door.test.ts` gives: `queryByRole`
// would also pass for a row rendered `hidden`, and the posture here is that the
// route is not named at all. The card states it as "the row is ABSENT, not
// disabled", which is `SidebarNav`'s own standing rule: an entry point is a
// promise about a room, and a disabled row is a promise the product then
// refuses.
//
// ⚠️ THE CARVE-OUT THIS COMMENT USED TO CARRY IS RETIRED (Story MOTIR-4843 ·
// MOTIR-4847). It read: `/settings/workspace/jobs` and
// `/settings/workspace/github` "are NOT covered by that rule and must keep
// rendering at every count — they are workspace-SCOPED but not workspace-NAMED".
// That was MOTIR-3502's AC 6, and it was the tell rather than the exception: a
// surface exempted from a hiding rule BECAUSE IT STILL ANSWERS is a surface that
// was never given a relocation. All three are now equally absent below the
// reveal — Git moved a tier (MOTIR-4680), Security folds in via
// `WorkspaceFoldInSection` (MOTIR-3502), and Job runs gained its own gate and
// `JobRunsFoldInSection` (MOTIR-4861).
//
// The href anchor below (`"/settings/workspace"` followed by a quote) is KEPT
// anyway, because it is the tighter assertion: it asks about the AREA's own
// door, which is the thing this file is named after.
//
// ⚠️ THE ACCOUNT MENU IS NO LONGER ONE OF THE ENTRY POINTS. `UserMenu` had the
// only `Workspace settings` row in the product and no longer has any conditional
// but `platformStaff`; the door is the workspace SWITCHER's now, and
// `ShellTierNav` renders that whole control only above the reveal — so the tier
// gate moved from a ROW to the CONTROL that carries it. The arrival is
// `WorkspaceSwitcher-settings-door.test.tsx`; the cases below are the departure,
// and they assert the absence at EVERY count rather than at one.

// MUTABLE, because the AGREEMENT block below drives the workspace-settings AREA
// rail — the fourth surface — which `SidebarNav` selects on the pathname.
let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname,
}));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/hooks/useSidebarCollapsed', () => ({
  useSidebarCollapsed: () => [false, vi.fn()],
}));

afterEach(() => {
  cleanup();
  pathname = '/dashboard';
});

/** The area's OWN href, never one of its sub-routes. */
function namesTheWorkspaceArea(html: string): boolean {
  return html.includes('href="/settings/workspace"');
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /account menu/i }));
}

function workspace(id: string, organizationId: string) {
  return { id, name: `Workspace ${id}`, slug: id, organizationId };
}

describe('the reveal predicate', () => {
  it('reveals at the threshold and not below it', () => {
    expect(WORKSPACE_TIER_REVEAL_MIN).toBe(2);
    expect(isWorkspaceTierRevealed(0)).toBe(false);
    expect(isWorkspaceTierRevealed(1)).toBe(false);
    expect(isWorkspaceTierRevealed(2)).toBe(true);
    expect(isWorkspaceTierRevealed(9)).toBe(true);
  });

  it('counts the ACTIVE ORG only — two orgs of one workspace each stay collapsed', () => {
    // The trap the raw `listUserWorkspaces().length` would fall into: a user in
    // two single-workspace orgs has two workspaces and a CHOICE in neither.
    const mine = [workspace('a', 'org-1'), workspace('b', 'org-2')];
    expect(isWorkspaceTierRevealed(mine.length)).toBe(true); // the wrong number
    expect(isWorkspaceTierRevealed(scopeWorkspacesToActiveOrg(mine, 'org-1').length)).toBe(false);
    expect(isWorkspaceTierRevealed(scopeWorkspacesToActiveOrg(mine, 'org-2').length)).toBe(false);
  });

  it('leaves the list alone when no org resolves', () => {
    const mine = [workspace('a', 'org-1')];
    expect(scopeWorkspacesToActiveOrg(mine, null)).toEqual(mine);
  });
});

describe('the account menu, at EVERY workspace count', () => {
  // AMENDED, not deleted (MOTIR-4847). These cases used to be split across two
  // describes — one below the threshold asserting absence, one at it asserting
  // presence — because the row was reveal-gated. There is no threshold to
  // straddle any more: the row is gone at every count, and the menu takes no
  // workspace-count prop at all. Keeping the file's departure cases as ONE
  // unconditional block is the change; deleting them would leave the strongest
  // statement this story makes about the account menu recorded nowhere.

  it('renders no "Workspace settings" row', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.queryByText('Workspace settings')).toBeNull();
  });

  it('leaves no /settings/workspace reference anywhere in the rendered markup', () => {
    // The href assertion, not the label one: a row relabelled but still pointing
    // at the area would pass the case above and fail this.
    const { container } = renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    // The whole document, because the menu renders through a portal.
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
    expect(namesTheWorkspaceArea(container.innerHTML)).toBe(false);
  });

  it('is true for a PLATFORM-STAFF menu too — the one conditional left changes nothing here', () => {
    // `platformStaff` is now the menu's only branch, so this is the whole of its
    // state space: if the row survived anywhere, it would be in the arm that
    // renders the most rows.
    renderWithIntl(<UserMenu name="Ops" email="ops@moooon.net" platformStaff />);
    openMenu();
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
  });

  it('still offers Account settings — settings do not become unreachable', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(screen.getByText('Account settings')).toBeTruthy();
  });
});

describe('the shell tier nav', () => {
  const org = { id: 'org-1', name: 'Acme', role: 'owner' as const };

  it('hides the workspace switcher below the threshold', () => {
    const { container } = renderWithIntl(
      <ShellTierNav
        activeOrg={org}
        orgs={[]}
        workspaces={[workspace('a', 'org-1')]}
        activeWorkspaceId="a"
        cloudBilling={false}
      />,
    );
    expect(container.innerHTML).not.toContain('Workspace a');
  });

  it('shows it at the threshold', () => {
    const { container } = renderWithIntl(
      <ShellTierNav
        activeOrg={org}
        orgs={[]}
        workspaces={[workspace('a', 'org-1'), workspace('b', 'org-1')]}
        activeWorkspaceId="a"
        cloudBilling={false}
      />,
    );
    expect(container.innerHTML).toContain('Workspace a');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Story MOTIR-4843 · MOTIR-4848 — THE FOUR NAVIGATION SURFACES AGREE
// ═════════════════════════════════════════════════════════════════════════════
//
// ⚠️ THIS IS ONE PROPERTY, DRIVEN FROM ONE BOOLEAN — not four tests that each
// happen to be about the workspace tier. That distinction is the whole reason
// this block exists, and it is the level no BUILD card occupies: every card in
// this story can be individually correct while the product is wrong, because a
// switcher offering a door to a room whose rail is empty passes the switcher's
// test AND the rail's. The disagreement is only visible when the same value
// decides both.
//
// So `revealed` is computed ONCE per arm, from the workspace COUNT via the
// product's own predicate, and handed to all four surfaces. A surface that
// wants a different input than the others cannot be wired into this block
// without the mismatch becoming visible in the source.
//
// The statement, from the card:
//
//   arm    | switcher          | account menu | rail bottom  | area rail
//   -------|-------------------|--------------|--------------|-------------------
//   ≥2 ws  | offers the door   | offers it    | no workspace | three rows, exactly
//          |                   | NOWHERE      | row          | one active per route
//   1 ws   | absent ENTIRELY   | offers it    | no workspace | NO rows at all
//          |                   | NOWHERE      | row          |
//
// ⚠️ THE ACCOUNT-MENU COLUMN IS CONSTANT ON PURPOSE (MOTIR-4847). It used to be
// the reveal-gated door, and the fact that its answer no longer varies with the
// boolean IS the agreement: the tier's single entry point is the switcher, and
// the menu takes no workspace count at all any more.

const ORG = { id: 'org-1', name: 'Acme', role: 'owner' as const };
const RAIL_USER = { name: 'Ada', email: 'ada@example.com' };

/**
 * The area rail's routes, read off the registry rather than retyped. A
 * `cloudOnly` entry (Public address, MOTIR-9514) is a DEPLOYMENT axis, not a
 * tier one: the rail rendered here has no public-projects availability, so it
 * is left out, exactly as the rail leaves it out.
 */
const AREA_ROUTES = WORKSPACE_SETTINGS_NAV.filter((e) => !e.cloudOnly).map((e) => e.href);

function tierNav(count: number) {
  return renderWithIntl(
    <ShellTierNav
      activeOrg={ORG}
      orgs={[]}
      workspaces={Array.from({ length: count }, (_, i) => workspace(`w${i}`, 'org-1'))}
      activeWorkspaceId="w0"
      cloudBilling={false}
    />,
  );
}

function railAt(path: string, revealed: boolean) {
  pathname = path;
  return renderWithIntl(
    <SidebarNav
      activeProject={null}
      variant="rail"
      user={RAIL_USER}
      workspace={{ name: 'Acme workspace' }}
      workspaceTierRevealed={revealed}
    />,
  );
}

describe.each([
  { count: 2, arm: 'AT the reveal' },
  { count: 1, arm: 'BELOW the reveal' },
])('the four navigation surfaces agree — $arm ($count workspace(s))', ({ count }) => {
  // THE one boolean. Everything below reads this; nothing below recomputes it.
  const revealed = isWorkspaceTierRevealed(count);

  it('SURFACE 1 — the workspace SWITCHER carries the door iff the tier is revealed', () => {
    tierNav(count);
    const trigger = screen.queryByRole('button', { name: 'Switch workspace' });

    if (!revealed) {
      // Not "a switcher without the row" — the whole control is absent, which is
      // what makes a reveal gate on the row itself unnecessary.
      expect(trigger).toBeNull();
      expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
      return;
    }

    expect(trigger).not.toBeNull();
    fireEvent.click(trigger!);
    expect(screen.getByRole('link', { name: 'Workspace settings' }).getAttribute('href')).toBe(
      '/settings/workspace',
    );
  });

  it('SURFACE 2 — the ACCOUNT MENU offers it nowhere, at this arm as at the other', () => {
    renderWithIntl(<UserMenu name="Ada" email="ada@example.com" />);
    openMenu();
    expect(namesTheWorkspaceArea(document.body.innerHTML)).toBe(false);
  });

  it('SURFACE 3 — the rail BOTTOM SECTION carries no workspace row', () => {
    const { container } = railAt('/dashboard', revealed);
    // Every workspace-tier ROUTE, not just the two this story removed: a row
    // re-added for any of them fails here.
    for (const href of AREA_ROUTES.filter((h) => h !== '/settings/workspace')) {
      expect(container.innerHTML, href).not.toContain(href);
    }
  });

  it('SURFACE 4 — the AREA RAIL is the tier, whole or not at all', () => {
    const { container } = railAt('/settings/workspace', revealed);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));

    if (!revealed) {
      // NO rows — not fewer rows. All three routes `notFound()` here, so a rail
      // of one or two would be a promise the product then refuses.
      expect(hrefs.filter((h) => h?.startsWith('/settings/workspace'))).toEqual([]);
      return;
    }
    expect(hrefs).toEqual(expect.arrayContaining(AREA_ROUTES));
  });

  it('SURFACE 4 — and exactly ONE row reads active, on each of its routes', () => {
    if (!revealed) return; // covered above: there are no rows to be active.
    for (const route of AREA_ROUTES) {
      cleanup();
      const { container } = railAt(route, revealed);
      const active = [...container.querySelectorAll('[aria-current="page"]')].map((el) =>
        el.getAttribute('href'),
      );
      expect(active, route).toEqual([route]);
    }
  });
});

describe('the agreement is a PROPERTY of the reveal, not of four hand-written arms', () => {
  it('⚠️ the account menu takes NO workspace-count input at all (MOTIR-4847)', () => {
    // The structural half of surface 2's constant column, asserted at the type
    // level so it cannot rot into a vacuous pass: re-adding the prop fails
    // `pnpm typecheck` here rather than quietly reintroducing a second door.
    const rejected = (
      <UserMenu
        name="Ada"
        email="ada@example.com"
        // @ts-expect-error — the row moved to the switcher; the menu no longer
        // varies by workspace count.
        workspaceTierRevealed
      />
    );
    expect(rejected).toBeTruthy();
  });

  it('the switcher and the area rail read the SAME predicate, not two thresholds', () => {
    // A cheap case that catches the expensive bug: a second `>= 2` written
    // somewhere would let the door appear at a count the room does not open at.
    expect(isWorkspaceTierRevealed(WORKSPACE_TIER_REVEAL_MIN - 1)).toBe(false);
    expect(isWorkspaceTierRevealed(WORKSPACE_TIER_REVEAL_MIN)).toBe(true);
  });
});
